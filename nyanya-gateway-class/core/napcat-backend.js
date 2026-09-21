'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
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
const { MAX_MEDIA_BYTES } = require('../legacy/media-service');

// segmentText() 把图片压成这个占位符，收图时用它定位要换成链接的位置。
const IMAGE_PLACEHOLDER = '[图片]';
const IMAGE_DOWNLOAD_TIMEOUT_MS = 15000;

// OneBot v11 的图片段是 type='image'，data 里带 file（本地路径 / base64:// / data: URI）
// 或 url。语音（record）结构一样，但网关侧没有可用的 AMR 通道，先不处理。
function pickImageSegments(message) {
  if (!Array.isArray(message)) return [];
  return message.filter((segment) => segment && segment.type === 'image' && segment.data);
}

function readLocalFile(file) {
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
  } catch (err) {
    return null;
  }
}

function base64Payload(value) {
  if (value.startsWith('base64://')) return value.slice('base64://'.length);
  const comma = value.indexOf(',');
  return comma > 0 ? value.slice(comma + 1) : '';
}

// NapCat 给的 mime 字段经常是空的，按魔数兜底——错了老客户端就打不开。
function sniffImageMime(bytes, fallback) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return fallback || 'image/jpeg';
}

function extensionForMime(mimeType) {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/gif') return '.gif';
  return '.jpg';
}

function mediaFilename(rawName, mimeType) {
  const leaf = String(rawName || '').split(/[\\/]/).pop() || '';
  const stem = leaf.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[\u0000-\u001F<>:"|?*]/g, '_');
  return (stem || 'napcat-image').slice(0, 200) + extensionForMime(mimeType);
}

function downloadBytes(url, limit) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new Error('图片地址无效: ' + url));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('不支持的图片地址协议: ' + parsed.protocol));
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.get(url, { timeout: IMAGE_DOWNLOAD_TIMEOUT_MS }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('图片下载失败 HTTP ' + response.statusCode));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > limit) {
          request.destroy();
          reject(new Error('图片超过网关媒体上限'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks, total)));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('图片下载超时')));
    request.on('error', reject);
  });
}

// 按顺序把每个成功的图片占位符换成 WAP 链接；没有占位符就直接追加。
function applyMediaLinks(text, links) {
  if (links.length === 0) return text;
  let output = String(text || '');
  for (const link of links) {
    const index = output.indexOf(IMAGE_PLACEHOLDER);
    output = index < 0
      ? (output ? output + ' ' + link : link)
      : output.slice(0, index) + '【图片】' + link + output.slice(index + IMAGE_PLACEHOLDER.length);
  }
  return output;
}

// NapCat 后端：联系人镜像、事件翻译、发送路由
class NapCatBackend {
  constructor(options) {
    this.config = options.config;
    this.store = options.store;
    this.sessions = options.sessions;
    this.server = options.server; // legacy QQ server（提供 deliverText / pushSystemNotice / deliverGroup）
    this.logger = options.logger || console;
    this.onebot = options.onebot || null;
    // 收图时推给老客户端的 WAP 基址（形如 http://192.168.x.x:13981）。
    // 留空则退化成只推 media id，便于自检里不依赖真实网络。
    this.mediaBaseUrl = String(options.mediaBaseUrl || '').replace(/\/+$/, '');
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
    // 去重「同号多端」回显：记录最近经网关发出的群消息（messageId -> 详情），
    // 当 NapCat 回推「自己发的」消息时据此判断是否刚由网关发出，避免旧客户端
    // 自己发一条又收到一条重复的。
    this._recentSentGroup = new Map();
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

  // 记下刚经网关发出的群消息，供回推时去重回显。
  _rememberSentGroup(messageId, groupId, text) {
    const now = Date.now();
    if (messageId) {
      this._recentSentGroup.set(String(messageId), {
        groupId: String(groupId),
        text: String(text),
        expiresAt: now + 60000,
      });
    }
    // 惰性清理过期条目，避免长期运行无限增长。
    for (const [key, rec] of this._recentSentGroup) {
      if (rec.expiresAt <= now) this._recentSentGroup.delete(key);
    }
  }

  // 判断 NapCat 回推的这条 self 消息是否就是网关刚发出的（用于去重回显）。
  _isEchoOfRecentSend(groupId, text, messageId) {
    const now = Date.now();
    const gid = String(groupId);
    const txt = String(text);
    // 1) messageId 精确匹配（NapCat 的 send_group_msg 返回的 id 通常等于回推 id）。
    if (messageId) {
      const rec = this._recentSentGroup.get(String(messageId));
      if (rec && rec.groupId === gid && rec.expiresAt > now) return true;
    }
    // 2) 内容 + 时间窗口兜底（messageId 不一致时）。
    for (const rec of this._recentSentGroup.values()) {
      if (rec.expiresAt <= now) continue;
      if (rec.groupId === gid && rec.text === txt) return true;
    }
    return false;
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
      this._rememberSentGroup(result.messageId, groupId, text);
      this.logger.log(`[send] 群 ${fromUin} -> ${groupId}: ${text}`);
    } else {
      this.logger.error('[send] 群发送失败 ' + groupId + ': ' + (result.error || 'unknown'));
    }
    return result.ok;
  }

  // ---------- 上行图片转发：老客户端上传的图片 -> 真实 QQ ----------
  // 旧客户端只在群聊里给出「发送图片」入口（hb.java:680 的动作码 237），
  // 所以实际只有群聊会走到这里；私聊保留同一条通道以免以后再补。
  // 图片字节来自本地 media_items 的 BLOB，用 OneBot 的 base64:// 传给 NapCat，
  // 不依赖临时文件，也不要求 NapCat 能回连网关。
  async sendImage(options) {
    const opts = options || {};
    const chatType = opts.chatType === 'group' ? 'group' : 'private';
    const peerId = opts.peerId;
    const content = opts.content;
    if (!this.onebot || !Buffer.isBuffer(content) || content.length === 0 || !peerId) {
      this.logger.error('[send] 图片转发参数不合法');
      return { ok: false, code: 'bad_params', error: 'peer/content required' };
    }
    const limiter = this.messageRouter && this.messageRouter.rateLimiter;
    if (limiter && !limiter.allow(opts.rateKey || 'global')) {
      this.logger.error(`[send] ${chatType === 'group' ? '群' : '私聊'}图片被限频: ${peerId}`);
      return { ok: false, code: 'rate_limited', error: 'rate limited' };
    }
    const message = [];
    if (opts.text) message.push({ type: 'text', data: { text: String(opts.text) } });
    message.push({ type: 'image', data: { file: `base64://${content.toString('base64')}` } });
    const action = chatType === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params = chatType === 'group'
      ? { group_id: Number(peerId), message }
      : { user_id: Number(peerId), message };
    let result;
    try {
      result = await this.onebot.sendAction(action, params);
    } catch (err) {
      this.logger.error(`[send] 图片转发 ${action} 抛异常: ${err.message}`);
      return { ok: false, code: 'onebot', error: err.message };
    }
    if (!result || !result.ok) {
      const reason = result && result.error ? result.error : 'send failed';
      this.logger.error(`[send] ${chatType === 'group' ? '群' : '私聊'}图片失败 ${peerId}: ${reason}`);
      return { ok: false, code: 'onebot', error: reason };
    }
    this.sentCount += 1;
    this.logger.log(`[send] ${chatType === 'group' ? '群' : '私聊'}图片 `
      + `${opts.fromUin || ''} -> ${peerId} bytes=${content.length}`);
    return { ok: true, action, messageId: result.data && result.data.message_id };
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
    // 取数 + 校验：全部通过之后才动 store。
    // 失败的 RPC 绝不能当成"空列表"——下面的写入是整体覆盖式的，把 not-ok
    // 当成空列表会清空好友/群，并把历史群消息变成孤儿；group_messages.group_id
    // 外键失败会让 store.save() 的整个事务回滚，镜像从此再也刷不上
    // （2026-09-20 的故障：NapCat 换号 + 库里还留着上个号的群消息）。
    const { friends, groupList } = await this._fetchMirrorSource();
    this._ensureDeviceAccount();
    const previousGroupIds = new Set(this.store.groupsOf(this.selfId)
      .map((group) => Number(group.id)));
    for (const item of friends) {
      this._upsertFriend(Number(item.id), item.nickname, item.remark);
    }

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

  // 取数 + 校验：任何一项不通过都抛错，调用方据此中止整个镜像刷新。
  async _fetchMirrorSource() {
    const friendResult = await this.onebot.sendAction('get_friend_list', {});
    if (!friendResult.ok || !Array.isArray(friendResult.data)) {
      throw new Error('get_friend_list 失败，已中止镜像刷新以避免清空好友: '
        + (friendResult.error || 'unknown'));
    }
    const groupResult = await this.onebot.sendAction('get_group_list', {});
    if (!groupResult.ok || !Array.isArray(groupResult.data)) {
      throw new Error('get_group_list 失败，已中止镜像刷新以避免清空群列表: '
        + (groupResult.error || 'unknown'));
    }
    const friends = friendResult.data.map(normalizeFriend);
    const groupList = groupResult.data.map(normalizeGroup)
      .filter((item) => Number.isInteger(Number(item.id)) && Number(item.id) > 0);
    // 收缩保护：本地已有群，却收到空群列表——几乎总是同步异常或换了 NapCat
    // 账号。这种响应不落库：宁可保留旧镜像，也不要静默清空群和群里所有人的
    // 历史消息（真换号时按错误提示处理）。
    const localGroups = this.store.listGroups().length;
    if (groupList.length === 0 && localGroups > 0) {
      throw new Error(`get_group_list 返回空列表（本地已有 ${localGroups} 个群），`
        + '已中止刷新以避免清空群列表；若确实换了 NapCat 账号，停网关后清空 nyanya-data 再启动');
    }
    return { friends, groupList };
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
      const message = normalizeOneBotMessage(event, { selfId: this.selfId, allowSelf: true });
      if (message) {
        // 收图是异步的（要取字节、落库），所以这里自己接住 rejection，
        // 不能靠外层同步 try/catch。
        this._onMessage(message, pickImageSegments(event.message)).catch((err) => {
          this.logger.error('[napcat] 消息处理出错: ' + err.message);
        });
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

  async _onMessage(message, imageSegments) {
    const segments = Array.isArray(imageSegments) ? imageSegments : [];
    // 自己发的消息：私聊继续过滤（否则会变成「自己给自己发」）；群聊放行以支持
    // 同号多端同步，但会在群聊分支里做去重，避免旧客户端自己发完又收到回显。
    if (message.isSelf && message.chatType === 'private') {
      return;
    }
    if (message.chatType === 'private') {
      const from = Number(message.sender.id);
      // 好友通过时 QQ 自动发的系统文案，老客户端会把它当普通私聊写进本地 RMS，
      // 登录/重连时反复重放弹「好友通过」通知。这里从源头过滤，不落库不推送。
      if (message.text && message.text.startsWith('我们已成功添加为好友')) {
        this.logger.log(`[napcat] 已过滤好友通过文案 from=${from}: ${message.text}`);
        return;
      }
      const images = await this._ingestImages({
        chatType: 'private', segments, fromUin: from, toUin: this.selfId,
      });
      // 私聊的图片块在客户端里不绑定 URL（见 im.g()），只能继续推链接。
      const text = applyMediaLinks(message.text, images.map((image) => image.link));
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
      if (this.config.pushGroupMessages === false) {
        this.logger.log(`[napcat] 群消息已按配置屏蔽（pushGroupMessages=false） group=${groupId}`);
        return;
      }
      if (Array.isArray(this.config.mutedGroupIds)
          && this.config.mutedGroupIds.includes(groupId)) {
        this.logger.log(`[napcat] 群消息已按 mutedGroupIds 屏蔽 group=${groupId}`);
        return;
      }
      // 自己发的消息：先判断是不是网关刚发出的回显，是则跳过（避免旧客户端自己
      // 发一条又收到重复的）；否则视为「同号其他端」（如新版 QQ）发的，正常推给旧客户端。
      if (message.isSelf) {
        if (this._isEchoOfRecentSend(groupId, message.text, message.messageId)) {
          this.logger.log(`[napcat] 群消息回显已去重 group=${groupId}: ${message.text}`);
          return;
        }
        this.logger.log(`[napcat] 群消息自同步推送 group=${groupId}: ${message.text}`);
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
      // 发送者必须落到 accounts 里：saveGroupMessage 要校验群成员，
      // saveMedia 要校验收发双方账号都存在。
      if (senderNickname || !this.store.get(from)) this._upsertFriend(from, senderNickname, '');
      const images = await this._ingestImages({
        chatType: 'group', segments, fromUin: from, toUin: this.selfId,
      });
      const links = images.map((image) => image.link);
      const text = applyMediaLinks(message.text, links);
      try {
        this.store.saveGroupMessage(groupId, from, text);
      } catch (err) {
        // 发送者不在镜像成员里（成员列表未拉到），不阻塞推送
      }
      const delivery = this.server.deliverGroup
        ? this.server.deliverGroup(groupId, from, text, {
          triggerVirtual: false,
          displayName: message.sender.displayName,
          // 群图片改走旧客户端的「图片块」：正文用带 [图片] 占位符的原文，
          // 网关按占位符顺序插入图片块，客户端会渲染成可点击的 [图片] 气泡。
          images: images.map((image) => image.id),
          imageText: message.text,
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

  // ---------- 收图：NapCat -> 老客户端 ----------

  _mediaLink(mediaId, chatType) {
    // 没配基址时退化成纯 id，方便自检不依赖真实网络。
    if (!this.mediaBaseUrl) return String(mediaId);
    const id = encodeURIComponent(mediaId);
    // 群聊沿用旧客户端认识的群图片入口，私聊走通用媒体页。
    return chatType === 'group'
      ? `${this.mediaBaseUrl}/forward.jsp?bid=331&fileid=${id}`
      : `${this.mediaBaseUrl}/mobile/media/${id}`;
  }

  // NapCat 与网关同机时 file 就是本地路径，直接读最快；否则让 NapCat 用
  // get_image 落盘，最后才退回 url 下载。任一步失败都只影响这一张图。
  async _loadImageBytes(data) {
    const file = String(data.file || '');
    if (file.startsWith('base64://') || file.startsWith('data:')) {
      const payload = base64Payload(file);
      if (payload) return Buffer.from(payload, 'base64');
    }
    if (file && !/^[a-z][a-z0-9+.-]*:\/\//i.test(file)) {
      const local = readLocalFile(file);
      if (local) return local;
    }
    if (this.onebot) {
      try {
        const result = await this.onebot.sendAction('get_image', {
          file: file || String(data.url || ''),
        });
        if (result.ok && result.data) {
          const resolved = typeof result.data === 'string'
            ? result.data : String(result.data.file || '');
          if (resolved.startsWith('base64://') || resolved.startsWith('data:')) {
            const payload = base64Payload(resolved);
            if (payload) return Buffer.from(payload, 'base64');
          }
          const local = resolved ? readLocalFile(resolved) : null;
          if (local) return local;
        }
      } catch (err) {
        this.logger.error('[napcat] get_image 调用失败: ' + err.message);
      }
    }
    const url = String(data.url || '');
    if (/^https?:\/\//i.test(url)) return downloadBytes(url, MAX_MEDIA_BYTES);
    return null;
  }

  // 把消息里的图片段落落进本地媒体表，返回按顺序的 { id, link } 列表
  // （id 是媒体 id，群聊用它构造旧客户端的图片块；link 是方案 A 的 WAP 链接）。
  // 成功落库的图片会在推送文本里替换掉 [图片] 占位符；失败的保留占位符并写日志，
  // 绝不因为一张图取不到就丢掉整条消息，也绝不让事件处理抛出去。
  async _ingestImages(context) {
    const images = [];
    for (const segment of context.segments) {
      const data = segment.data || {};
      try {
        if (!this.store.get(context.fromUin) || !this.store.get(context.toUin)) {
          throw new Error(`账号不在镜像里（from=${context.fromUin}），无从归属这张图片`);
        }
        const bytes = await this._loadImageBytes(data);
        if (!bytes || bytes.length === 0) throw new Error('图片内容为空');
        if (bytes.length > MAX_MEDIA_BYTES) throw new Error('图片超过网关媒体上限');
        const mimeType = sniffImageMime(bytes, String(data.mime || ''));
        const media = this.store.saveMedia({
          from: context.fromUin,
          to: context.toUin,
          filename: mediaFilename(data.file, mimeType),
          mimeType,
          // mediaType 2 = 旧客户端约定的图片类型（media-service.mimeFor 把 1/2 都当 JPEG）。
          mediaType: 2,
          size: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          legacyHash: Buffer.alloc(0),
          content: bytes,
        });
        const link = this._mediaLink(media.id, context.chatType);
        images.push({ id: media.id, link });
        this.logger.log(`[napcat] 已保存${context.chatType === 'group' ? '群' : '私聊'}图片 `
          + `id=${media.id} from=${context.fromUin} bytes=${media.size} link=${link}`);
      } catch (err) {
        this.logger.error(`[napcat] 图片保存失败（保留 ${IMAGE_PLACEHOLDER} 占位）: ${err.message}`);
      }
    }
    return images;
  }

  _onNotice(notice) {
    if (notice.refreshContacts) this.refreshMirror().catch(() => {});
    // 好友通过系统通知（「新好友已添加」）不推给老客户端：客户端会在登录/重连时
    // 重放本地 RMS 里的「好友通过」记录反复弹通知，这里从源头掐掉新的推送。
    if (notice.noticeType === 'friend_add') {
      this.logger.log(`[napcat] 已过滤好友通过系统通知: ${notice.text}`);
      return;
    }
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

// 上行媒体的收件人可能是好友 uin，也可能是群号（旧客户端只在群聊里给发图入口）。
// 统一解析成 { chatType, peerId }；群号要换回 NapCat 认的真实群号。
function resolveMediaTarget(store, toUin) {
  const target = Number(toUin);
  const group = store && typeof store.getGroup === 'function' ? store.getGroup(target) : null;
  if (group) return { chatType: 'group', peerId: Number(group.publicId || group.id) };
  return { chatType: 'private', peerId: target };
}

module.exports = { NapCatBackend, segmentText, resolveMediaTarget };
