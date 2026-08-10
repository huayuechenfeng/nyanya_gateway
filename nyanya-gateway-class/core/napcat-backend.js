'use strict';

const { OneBotClient } = require('../../packages/onebot-adapter');
const {
  FixedWindowRateLimiter,
  OfflineDeliveryQueue,
  OneBotMessageRouter,
  normalizeFriend,
  normalizeGroup,
  normalizeGroupMember,
  normalizeOneBotMessage,
  normalizeOneBotNotice,
  segmentText,
} = require('../../packages/gateway-core');
const { EMPTY_DIGEST, defaultProfile, digestPassword } = require('../legacy/store');

// NapCat 后端：联系人镜像、事件翻译、发送路由
class NapCatBackend {
  constructor(options) {
    this.config = options.config;
    this.store = options.store;
    this.sessions = options.sessions;
    this.server = options.server; // legacy QQ server（提供 deliverText / pushSystemNotice / deliverGroup）
    this.logger = options.logger || console;
    this.onebot = options.onebot || null;
    this.selfId = 0;
    this.nickname = '';
    this.connected = false;
    this.refreshPromise = null;
    this.sentCount = 0;
    this.sendLimiter = options.sendLimiter || new FixedWindowRateLimiter({
      maxPerWindow: this.config.sendMaxPerMinute === undefined
        ? Number.MAX_SAFE_INTEGER : this.config.sendMaxPerMinute,
      windowMs: 60000,
      // Preserve the current compatibility-bridge behavior. Its historical
      // limiter was global and only enforced the per-minute ceiling.
      minIntervalMs: 0,
    });
    this.messageRouter = null;
    this.offlineQueue = options.offlineQueue || new OfflineDeliveryQueue({
      capacity: this.config.offlineCap,
      storage: {
        enqueue: (target, item) => {
          this.store.enqueueOutbox(item.from, item.to, item.text);
          return true;
        },
        take: (target) => this.store.takeOutbox(Number(target)),
      },
    });
  }

  start() {
    if (!this.onebot) {
      this.onebot = new OneBotClient({
        url: this.config.onebotUrl,
        token: this.config.onebotToken,
        log: this.logger,
      });
    }
    this.messageRouter = new OneBotMessageRouter({
      onebot: this.onebot,
      rateLimiter: this.sendLimiter,
    });
    this.onebot.onEvent((event) => this.onEvent(event));
    this.onebot.onStatusChange((up) => {
      this.connected = up;
      if (up) {
        this.logger.log('[napcat] 已连接 ' + this.config.onebotUrl);
        this.refreshMirror().catch((err) => {
          this.logger.error('[napcat] 联系人镜像刷新失败: ' + err.message);
        });
      } else {
        this.logger.log('[napcat] NapCat 连接断开，等待重连');
      }
    });
    this.onebot.start();
  }

  stop() {
    if (this.onebot && this.onebot.stop) this.onebot.stop();
  }

  // ---------- 发送路由：老客户端 -> NapCat ----------

  async sendPrivate(fromUin, toUin, text) {
    const result = await this.messageRouter.sendText({
      chatType: 'private',
      peerId: toUin,
      text: String(text),
      rateKey: 'global',
    });
    if (result.code === 'rate_limited') {
      this.logger.error('[send] 私聊发送被限频: ' + toUin);
      return false;
    }
    if (result.ok) {
      this.sentCount += 1;
      this.logger.log(`[send] 私聊 ${fromUin} -> ${toUin}: ${text}`);
    } else {
      this.logger.error('[send] 私聊失败 ' + toUin + ': ' + (result.error || 'unknown'));
    }
    return result.ok;
  }

  async sendGroup(fromUin, groupId, text) {
    const result = await this.messageRouter.sendText({
      chatType: 'group',
      peerId: groupId,
      text: String(text),
      rateKey: 'global',
    });
    if (result.code === 'rate_limited') {
      this.logger.error('[send] 群发送被限频: ' + groupId);
      return false;
    }
    if (result.ok) {
      this.sentCount += 1;
      this.logger.log(`[send] 群 ${fromUin} -> ${groupId}: ${text}`);
    } else {
      this.logger.error('[send] 群发送失败 ' + groupId + ': ' + (result.error || 'unknown'));
    }
    return result.ok;
  }

  enqueueOffline(from, to, text) {
    return this.offlineQueue.enqueue(to, {
      from: Number(from),
      to: Number(to),
      text: String(text),
    });
  }

  takeOffline(to) {
    return this.offlineQueue.take(to);
  }

  // ---------- 联系人/群镜像 ----------

  async refreshMirror() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this._refreshMirror().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async _refreshMirror() {
    if (!this.onebot || !this.connected) throw new Error('NapCat 未连接');
    const login = await this.onebot.sendAction('get_login_info', {});
    if (!login.ok || !login.data) {
      throw new Error('get_login_info 失败: ' + (login.error || 'unknown'));
    }
    this.selfId = Number(login.data.user_id);
    this.nickname = String(login.data.nickname || this.selfId);
    if (this.config.deviceUin && this.config.deviceUin !== this.selfId) {
      this.logger.error(`[napcat] deviceUin=${this.config.deviceUin} 与 NapCat self_id=${this.selfId} 不一致，老客户端将无法登录`);
    }
    this._ensureDeviceAccount();
    const previousGroupIds = new Set(this.store.groupsOf(this.selfId)
      .map((group) => Number(group.id)));

    const friendResult = await this.onebot.sendAction('get_friend_list', {});
    const friends = friendResult.ok && Array.isArray(friendResult.data)
      ? friendResult.data.map(normalizeFriend) : [];
    for (const item of friends) {
      this._upsertFriend(Number(item.id), item.nickname, item.remark);
    }

    const groupResult = await this.onebot.sendAction('get_group_list', {});
    const groupList = groupResult.ok && Array.isArray(groupResult.data)
      ? groupResult.data.map(normalizeGroup).filter((item) => Number.isInteger(Number(item.id))
        && Number(item.id) > 0) : [];
    // 群列表必须完整保留，否则第 61 个以后的群永远无法在老客户端出现。
    // 成员列表很重，仍只为前 N 个群拉取；其余群先保存设备本人作为成员，
    // 收到实时事件时再按需补齐发送者占位，不阻塞群发现。
    const memberMirrorLimit = Math.max(0, Math.min(groupList.length,
      Number(this.config.groupMemberMirrorLimit === undefined
        ? 60 : this.config.groupMemberMirrorLimit)));
    const groups = [];
    for (let groupIndex = 0; groupIndex < groupList.length; groupIndex += 1) {
      const item = groupList[groupIndex];
      const groupId = Number(item.id);
      const title = item.title;
      let members = [this.selfId];
      if (groupIndex < memberMirrorLimit) {
        try {
          const memberResult = await this.onebot.sendAction('get_group_member_list', {
            group_id: groupId,
          });
          if (memberResult.ok && Array.isArray(memberResult.data)) {
            const normalizedMembers = memberResult.data.map(
              (member) => normalizeGroupMember(member, groupId));
            members = normalizedMembers.map((member) => Number(member.id));
            for (const member of normalizedMembers) {
              this._upsertFriend(Number(member.id), member.nickname, member.groupCard);
            }
          }
        } catch (err) {
          this.logger.error(`[napcat] 群成员拉取失败 ${groupId}: ${err.message}`);
        }
      }
      groups.push({
        id: groupId,
        publicId: groupId,
        type: 'group',
        ownerUin: this.selfId,
        title,
        members: Array.from(new Set(members.filter(Boolean))),
      });
    }

    const device = this.store.get(this.selfId);
    if (device) {
      // 过滤自身：个别账号的 get_friend_list 会包含自己，QQ2013 的
      // HandleGetNewList 在好友列表里遇到自己会中止同步，导致列表空白。
      device.friends = friends.map((item) => Number(item.id))
        .filter((uin) => Number.isInteger(uin) && uin > 0 && uin !== this.selfId);
    }
    this.store.data.groups = groups.map((group) => ({
      id: group.id,
      publicId: group.publicId,
      type: group.type,
      ownerUin: group.ownerUin,
      title: group.title,
      createdAt: new Date().toISOString(),
      members: group.members.map((uin) => ({
        uin,
        role: uin === this.selfId ? 'owner' : 'member',
        joinedAt: new Date().toISOString(),
        replyPolicy: '',
        replyProbability: null,
      })),
    }));
    this.store.save();
    const newGroups = groups.filter((group) => !previousGroupIds.has(Number(group.id)))
      .map((group) => this.store.getGroup(group.id)).filter(Boolean);
    if (newGroups.length > 0 && this.server.pushGroupDiscovery) {
      this.server.pushGroupDiscovery(this.selfId, newGroups, 'napcat_mirror_refresh');
    }
    this.logger.log(`[napcat] 镜像已刷新：self=${this.selfId}(${this.nickname}) 好友=${friends.length} 群=${groups.length}`);
    return {
      selfId: this.selfId,
      nickname: this.nickname,
      friends: friends.length,
      groups: groups.length,
    };
  }

  _ensureDeviceAccount() {
    const store = this.store;
    const token = this.config.deviceToken;
    let account = store.get(this.selfId);
    if (account) {
      account.enabled = true;
      // 同步昵称：设备账号可能由旧的好友镜像升级而来（昵称是旧的），
      // 0x005A 资料响应直接取 account.nickname，必须每次刷新都更新。
      if (this.nickname) account.nickname = this.nickname;
      account.profile = Object.assign({}, account.profile || {}, {
        nyanyaDevice: true,
        realName: this.nickname || String(this.selfId),
      });
      // config 里的 token 是权威：每次刷新都同步设备账号密码，
      // 避免"改了 config 但老手机仍用旧 token"导致的 bad_credentials。
      if (token) {
        const expected = digestPassword(token);
        if (account.passwordDigest !== expected) {
          try {
            store.resetPassword(this.selfId, token);
            this.logger.log(`[napcat] 设备账号密码已同步为 config 中的 token`);
          } catch (err) {
            this.logger.error('[napcat] 同步设备密码失败: ' + err.message);
          }
        }
      }
      store.save();
      return account;
    }
    const created = store.addAccount({
      uin: this.selfId,
      nickname: this.nickname || String(this.selfId),
      password: token,
      type: 'human',
    });
    created.profile = Object.assign({}, created.profile, { nyanyaDevice: true });
    store.save();
    this.logger.log(`[napcat] 已创建设备账号 ${this.selfId}（老客户端用它 + token 登录）`);
    return created;
  }

  _upsertFriend(uin, nickname, remark) {
    const store = this.store;
    const u = Number(uin);
    if (!u || u <= 0) return null;
    // NapCat 的群成员列表里也包含当前登录账号；member.card 是群名片，
    // 不能用它覆盖设备账号的全局 QQ 昵称，否则 0x005A 本人资料会显示成
    // 某一个群里的群名片。本人资料始终以 get_login_info 为准。
    if (u === this.selfId) {
      const device = store.get(u);
      if (!device) return this._ensureDeviceAccount();
      device.enabled = true;
      device.nickname = String(this.nickname || device.nickname || u).slice(0, 80);
      device.profile = Object.assign({}, device.profile || {}, {
        nyanyaDevice: true,
        realName: String(this.nickname || device.profile?.realName || u).slice(0, 80),
      });
      return device;
    }
    const displayName = String(remark || nickname || u);
    const existing = store.get(u);
    if (existing) {
      existing.enabled = true;
      existing.nickname = displayName;
      existing.profile = Object.assign({}, existing.profile || {}, {
        realName: String(nickname || u).slice(0, 80),
      });
      return existing;
    }
    const stub = {
      uin: u,
      type: 'human',
      enabled: true,
      nickname: displayName,
      passwordDigest: EMPTY_DIGEST,
      profile: defaultProfile({ realName: String(nickname || u).slice(0, 80) }),
      friends: [],
      incomingRequests: [],
    };
    store.data.accounts.push(stub);
    return stub;
  }

  _ensureGroupStub(groupId, title) {
    const groupIdNumber = Number(groupId);
    const existing = this.store.getGroup(groupIdNumber);
    if (existing) return existing;
    try {
      this.store.data.groups.push({
        id: groupIdNumber,
        publicId: groupIdNumber,
        type: 'group',
        ownerUin: this.selfId,
        title: String(title || groupIdNumber),
        createdAt: new Date().toISOString(),
        members: [{
          uin: this.selfId,
          role: 'owner',
          joinedAt: new Date().toISOString(),
          replyPolicy: '',
          replyProbability: null,
        }],
      });
      this.store.save();
      return this.store.getGroup(groupIdNumber);
    } catch (err) {
      this.logger.error('[napcat] 创建群占位失败 ' + groupIdNumber + ': ' + err.message);
      return null;
    }
  }

  // ---------- 事件翻译：NapCat -> 老协议推送 ----------

  onEvent(event) {
    try {
      const message = normalizeOneBotMessage(event, { selfId: this.selfId });
      if (message) {
        this._onMessage(message);
        return;
      }
      const notice = normalizeOneBotNotice(event, {
        labels: { friend_add: '新好友已添加' },
      });
      if (notice) {
        this._onNotice(notice);
        return;
      }
      if (event.post_type === 'request') {
        this.logger.log('[napcat] 收到请求事件（v1 不处理）: ' + event.request_type);
      }
    } catch (err) {
      this.logger.error('[napcat] 事件处理出错: ' + err.message);
    }
  }

  _onMessage(message) {
    if (message.chatType === 'private') {
      const from = Number(message.sender.id);
      const text = message.text;
      this.store.saveMessage(from, this.selfId, text);
      const delivered = this.server.deliverText(from, this.selfId, text, 9, 'napcat_private');
      if (delivered) {
        this.logger.log(`[napcat] 私聊推送 from=${from}: ${text}`);
      } else {
        this.enqueueOffline(from, this.selfId, text);
        this.logger.log(`[napcat] 私聊离线入队 from=${from}: ${text}`);
      }
      return;
    }
    if (message.chatType === 'group') {
      const groupId = Number(message.peerId);
      const from = Number(message.sender.id);
      const senderNickname = message.sender.nickname;
      const senderCard = message.sender.groupCard;
      const text = message.text;
      if (this.config.pushGroupMessages === false) {
        this.logger.log(`[napcat] 群消息已按配置屏蔽（pushGroupMessages=false） group=${groupId}`);
        return;
      }
      if (Array.isArray(this.config.mutedGroupIds)
          && this.config.mutedGroupIds.includes(groupId)) {
        this.logger.log(`[napcat] 群消息已按 mutedGroupIds 屏蔽 group=${groupId}`);
        return;
      }
      if (!this.store.getGroup(groupId)) {
        const discovered = this._ensureGroupStub(groupId, message.groupName || String(groupId));
        if (discovered && this.server.pushGroupDiscovery) {
          this.server.pushGroupDiscovery(this.selfId, [discovered], 'napcat_group_event');
        }
      }
      // Group cards are scoped to one group and must not overwrite the global
      // QQ nickname. Keep the event nickname as a cache fallback, while the
      // per-message display name prefers the group card supplied by NapCat.
      if (senderNickname) this._upsertFriend(from, senderNickname, '');
      try {
        this.store.saveGroupMessage(groupId, from, text);
      } catch (err) {
        // 发送者不在镜像成员里（成员列表未拉到），不阻塞推送
      }
      const delivery = this.server.deliverGroup
        ? this.server.deliverGroup(groupId, from, text, {
          triggerVirtual: false,
          displayName: message.sender.displayName,
        })
        : { delivered: 0 };
      if (delivery.delivered > 0) {
        this.logger.log(`[napcat] 群消息推送 group=${groupId} from=${from}: ${text}`);
      } else if (delivery.blockedBySync > 0 || delivery.blockedUnmapped > 0) {
        const reason = delivery.blockedBySync > 0
          ? '塞班好友同步未完成' : '塞班未映射该群';
        this.logger.log(`[napcat] 群消息未推送（${reason}） group=${groupId} from=${from}: ${text}`);
      } else {
        this.logger.log(`[napcat] 群消息未投递（设备离线） group=${groupId} from=${from}: ${text}`);
      }
    }
  }

  _onNotice(notice) {
    if (notice.refreshContacts) this.refreshMirror().catch(() => {});
    if (this.server.pushSystemNotice) {
      this.server.pushSystemNotice(this.selfId, notice.text, 'napcat_' + notice.noticeType);
    }
  }

  status() {
    const device = this.selfId ? this.store.get(this.selfId) : null;
    const session = this.selfId ? this.sessions.get(this.selfId) : null;
    return {
      connected: this.connected,
      selfId: this.selfId || null,
      nickname: this.nickname || null,
      deviceConfigured: Boolean(device),
      deviceUin: this.config.deviceUin || null,
      deviceTokenSet: Boolean(this.config.deviceToken),
      deviceOnline: Boolean(session && session.loggedIn),
      friendCount: device ? (device.friends || []).length : 0,
      groupCount: this.selfId ? this.store.groupsOf(this.selfId).length : 0,
      sentCount: this.sentCount,
      onebotUrl: this.config.onebotUrl,
    };
  }
}

module.exports = { NapCatBackend, segmentText };
