'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('./config');
const protocol = require('./legacy/protocol');
const { AccountStore, defaultData } = require('./legacy/store');
const { createQQServer } = require('./legacy/server');
const { createMobileGroupServer } = require('./legacy/mobile-group-server');
const { MediaTransferService } = require('./legacy/media-service');
const { NapCatBackend, resolveMediaTarget } = require('./core/napcat-backend');
const { createQzoneBridge } = require('./core/qzone-bridge');
const { replayGroupHistory } = require('./core/group-history');
const { replayPrivateHistory } = require('./core/private-history');
const { createReplayCursors } = require('./core/replay-cursor');
const { createAdminServer } = require('./admin/admin-server');
const { OfflineDeliveryQueue } = require('../packages/gateway-core');

function lanIpv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

function main() {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });

  // 日志：控制台 + nyanya-data/gateway.jsonl + 环形缓冲（管理页用）
  const logBuffer = [];
  const logStream = fs.createWriteStream(
    path.join(config.dataDir, 'gateway.jsonl'), { flags: 'a' });
  function appendLog(kind, text) {
    const line = `${new Date().toISOString()} [${kind}] ${text}`;
    logBuffer.push(line);
    if (logBuffer.length > 1000) logBuffer.splice(0, logBuffer.length - 1000);
    logStream.write(line + '\n');
    return line;
  }
  const uiLogger = {
    log: (...args) => { const text = args.join(' '); appendLog('info', text); console.log(text); },
    error: (...args) => { const text = args.join(' '); appendLog('error', text); console.error(text); },
  };
  const logger = (event) => {
    const line = JSON.stringify(Object.assign({ time: new Date().toISOString() }, event));
    logBuffer.push(line);
    if (logBuffer.length > 1000) logBuffer.splice(0, logBuffer.length - 1000);
    logStream.write(line + '\n');
    process.stdout.write(line + '\n');
  };

  const store = new AccountStore(
    path.join(config.dataDir, 'nyanya.sqlite'),
    Object.assign(defaultData(), { accounts: [] }),
    { logger: uiLogger });
  const outboxQueue = new OfflineDeliveryQueue({
    capacity: config.offlineCap,
    storage: {
      enqueue: (target, item) => {
        store.enqueueOutbox(item.from, item.to, item.text);
        return true;
      },
      take: (target) => store.takeOutbox(Number(target)),
    },
  });
  const sessions = new Map();
  const lanAddress = lanIpv4();
  // 登录响应报文里的网关 IP 字段固定 4 字节（legacy/protocol.js 偏移 +0 / +46），
  // 所以只接受 IPv4 点分字面量：config.loginPublicHost 写了合法值就用它，否则
  // 回退到自动探测的局域网 IP。服务器/多网卡机器上自动探测可能挑到 docker0 的
  // 172.x，这时必须靠 config 写死；填了域名之类的非法值会告警并回退。
  const loginOverrideIp = protocol.ipv4ToBuffer(config.loginPublicHost);
  const loginAddress = loginOverrideIp ? config.loginPublicHost.trim() : lanAddress;
  const loginIp = loginOverrideIp || Buffer.from(lanAddress.split('.').map(Number));
  if (config.loginPublicHost && !loginOverrideIp) {
    uiLogger.error(`config.loginPublicHost「${config.loginPublicHost}」不是合法 IPv4`
      + `（该报文字段只有 4 字节，不支持域名），已回退到自动探测的 ${lanAddress}`);
  }
  // 收到 NapCat 图片时推给老客户端的 WAP 链接基址。IP 是给手机用的，
  // 多网卡可能挑错、换网会失效——可以用 config 的 mediaPublicHost 写死，
  // 启动日志里也会打出来便于核对。
  const mediaAddress = config.mediaPublicHost || lanAddress;
  const mediaBaseUrl = `http://${mediaAddress}:${config.mobilePort}`;

  // 群消息推送：把 NapCat 群事件翻译成老协议 0x0094，投给设备会话
  const deliverGroup = (groupId, fromUin, text, context) => {
    const group = store.getGroup(groupId);
    if (!group) return { delivered: 0, virtualQueued: 0 };
    const sender = store.get(fromUin);
    const eventDisplayName = context && typeof context.displayName === 'string'
      ? context.displayName.trim() : '';
    let delivered = 0;
    let blockedBySync = 0;
    let blockedByFilter = 0;
    let blockedUnmapped = 0;
    for (const member of group.members) {
      if (member.uin === Number(fromUin)) continue;
      const target = sessions.get(member.uin);
      if (!target || !target.loggedIn || target.socket.destroyed) continue;
      // J2ME 完成群初始化前尚未上报 0x0070/0x008C 接收状态。
      // 未知状态必须默认拦截，否则加载群列表期间会短暂放行全部群消息。
      if (target.clientFamily !== 'symbian_s60' && !target.groupReceiveStateReady) {
        blockedBySync += 1;
        logger({
          event: 'group_message_skipped', peer: target.peer, uin: target.uin,
          groupId: Number(groupId), reason: 'j2me_group_receive_state_pending',
        });
        continue;
      }
      // 客户端 0x0070/0x008C 接收清单：不在"接收中"清单里的群不推。
      if (target.groupReceiveFilter
          && !target.groupReceiveFilter.has(Number(groupId))) {
        blockedByFilter += 1;
        logger({
          event: 'group_message_skipped', peer: target.peer, uin: target.uin,
          groupId: Number(groupId), reason: 'j2me_group_receive_filter',
        });
        continue;
      }
      if (target.clientFamily === 'symbian_s60') {
        if (!target.buddyDetailsSyncComplete || !target.friendRosterSyncComplete) {
          blockedBySync += 1;
          const reason = !target.buddyDetailsSyncComplete
            ? 'symbian_buddy_sync_incomplete' : 'symbian_roster_sync_incomplete';
          logger({
            event: 'group_message_skipped', peer: target.peer, uin: target.uin,
            groupId: Number(groupId), reason,
          });
          continue;
        }
        const advertised = target.advertisedGroupIds;
        if (!advertised || (!advertised.has(Number(group.id))
            && !advertised.has(Number(group.publicId)))) {
          blockedUnmapped += 1;
          logger({
            event: 'group_message_skipped', peer: target.peer, uin: target.uin,
            groupId: Number(groupId), reason: 'symbian_group_not_advertised',
          });
          continue;
        }
      }
      target.pushSequence = (target.pushSequence + 1) & 0xFFFF;
      // context.images（群图片的媒体 id 列表）存在时，正文改走旧客户端的「图片块」，
      // imageText 是带 [图片] 占位符的原始文本，由 protocol 按顺序替换成图片块。
      const imageIds = (context && context.images) || [];
      const frame = protocol.createFrame({
        command: protocol.COMMAND_GROUP_MESSAGE,
        sequence: target.pushSequence,
        uin: target.uin,
        status: 0,
        payload: protocol.encryptPayload(
          protocol.buildGroupMessagePayload({
            groupId: group.publicId,
            senderUin: Number(fromUin),
            displayName: eventDisplayName
              || (sender ? sender.nickname : String(fromUin)),
            text,
            images: imageIds,
            imageText: context && context.imageText !== undefined
              ? context.imageText : text,
            // 回放群聊历史时用原始发送时间，客户端显示的时间才是当时的。
            timestamp: context && context.timestamp,
          }), target.sessionKey),
      });
      target.socket.write(frame);
      delivered += 1;
    }
    return {
      delivered, virtualQueued: 0, blockedBySync, blockedByFilter, blockedUnmapped,
    };
  };

  let backend = null;
  const remoteSender = {
    sendPrivate: (fromUin, toUin, text) =>
      backend ? backend.sendPrivate(fromUin, toUin, text) : Promise.resolve(false),
    sendGroup: (fromUin, groupId, text) =>
      backend ? backend.sendGroup(fromUin, groupId, text) : Promise.resolve(false),
  };

  const mediaService = new MediaTransferService({
    store,
    logger,
    httpPort: config.mobilePort,
    onComplete: (media) => {
      // 上行图片：老客户端上传的图片落库后**真正转发给真实 QQ**。
      // 旧客户端只在群聊里提供「发送图片」入口，群图片的收件人是群号、私聊才是好友 uin，
      // 这里统一分流。语音（mediaType 3）仍旧只落库——OneBot 对 amr 支持不稳，暂不转发。
      const kind = media.mediaType === 3 ? '语音' : '图片';
      const finish = (text, event, extra) => {
        try {
          store.saveMessage(media.from, media.to, text);
        } catch (err) {
          logger({ event: 'media_local_echo_error', mediaId: media.id, message: err.message });
        }
        logger(Object.assign({
          event, mediaId: media.id, from: media.from, to: media.to,
          mediaType: media.mediaType, bytes: media.size,
        }, extra || {}));
      };
      if (media.mediaType !== 2) {
        finish(`【${kind}】已上传（语音转发暂未开通）`, 'media_degraded',
          { reason: 'voice_not_forwarded' });
        return Promise.resolve(false);
      }
      if (!backend) {
        finish(`【${kind}】已上传（网关尚未连接 NapCat，未转发）`, 'media_degraded',
          { reason: 'backend_not_ready' });
        return Promise.resolve(false);
      }
      // 群里发图：收件人是群号，得换回 NapCat 认的真实群号。
      const { chatType, peerId } = resolveMediaTarget(store, media.to);
      return backend.sendImage({
        chatType, peerId, fromUin: media.from, content: media.content, rateKey: 'global',
      }).then((result) => {
        if (result && result.ok) {
          finish(`【${kind}】已发送`, 'media_forwarded', { chatType, peerId });
          return true;
        }
        finish(`【${kind}】发送失败（图已存在网关，可稍后重试）`, 'media_forward_failed',
          { chatType, peerId, error: result && result.error });
        return false;
      });
    },
  });

  const deliverOutbox = (uin) => setTimeout(() => {
    const entries = outboxQueue.take(uin);
    for (const entry of entries) {
      const delivered = qqServer.deliverText(entry.from, entry.to, entry.text, 9, 'outbox');
      if (delivered) {
        logger({ event: 'outbox_delivered', id: entry.id, from: entry.from, to: entry.to });
      } else {
        outboxQueue.enqueue(entry.to, entry);
      }
    }
  }, 800);

  // 回放水位：客户端掉线会自己重连，重连等于重新登录一遍，回放就会把看过的
  // 消息再推一次（2026-09-20：加好友那句系统文案被反复重推）。水位记住每个会话
  // 推到哪条消息 id，之后只推增量。存在内存里、带过期时间，理由见 core/replay-cursor.js。
  //
  // 群/私聊分开水位（2026-09-21 复发根因）：两者对「重启」的容忍度相反。
  //   - 群窗口只放内存、退出即空，客户端重启后必须重新全量补历史，所以群水位用
  //     短 TTL（replayCursorTtlMs），隔久了就视为「重启过」全量重推；
  //   - 私聊写本机 RMS、不怕重启，重连只需要增量；若共用短 TTL，客户端周期性
  //     重连（网络 NAT 老问题）时私聊水位频繁过期，把加好友那句系统文案反复重推，
  //     看着像「好友通过通知周期性弹」。所以私聊水位设为永不过期（ttlMs=0），
  //     只随网关进程结束而清空。
  const groupReplayCursors = createReplayCursors({ ttlMs: config.replayCursorTtlMs });
  const privateReplayCursors = createReplayCursors({ ttlMs: 0 });

  // 群聊历史回放：老客户端的群窗口只在内存里存消息、退出即空（见 core/group-history.js）。
  // 客户端群接收状态就绪时，把网关记录的最近若干条当普通群消息补推一遍。
  // 关闭开关时不传这个回调，legacy 层就不会做任何多余动作。
  const onGroupReceiveReady = config.replayGroupHistoryOnLogin
    ? (state, reason) => {
      const report = replayGroupHistory({
        store,
        uin: state.uin,
        limit: config.replayGroupHistoryLimit,
        groupReceiveFilter: state.groupReceiveFilter,
        cursors: groupReplayCursors,
        deliverGroup,
        reason,
      });
      if (report.messages > 0) {
        logger(Object.assign({
          event: 'group_history_replayed', uin: state.uin, reason,
        }, report));
      }
    }
    : undefined;

  // 私聊历史回放：私聊窗口读的是本机 RMS，且没有「拉服务器历史」的菜单
  // （见 core/private-history.js）。客户端登录就绪后，把网关记录的私聊历史
  // 当普通私聊消息补推一遍。关闭开关时不传这个回调，legacy 层就不做任何多余动作。
  const onClientReady = config.replayPrivateHistoryOnLogin
    ? (state, reason) => {
      const report = replayPrivateHistory({
        store,
        uin: state.uin,
        limit: config.replayPrivateHistoryLimit,
        cursors: privateReplayCursors,
        deliverText: (fromUin, toUin, text, subtype, why) =>
          qqServer.deliverText(fromUin, toUin, text, subtype, why),
        reason,
      });
      if (report.messages > 0) {
        logger(Object.assign({
          event: 'private_history_replayed', uin: state.uin, reason,
        }, report));
      }
    }
    : undefined;

  const qqServer = createQQServer({
    host: config.host,
    port: config.port,
    loginIp,
    store,
    sessions,
    logger,
    traceProtocol: config.traceProtocol,
    friendPresence: config.friendPresence,
    notifyIntervalSeconds: config.notifyIntervalSeconds,
    buddyDetailsPageSize: config.buddyDetailsPageSize,
    symbianBuddyDetailsPageSize: config.symbianBuddyDetailsPageSize,
    friendRosterPageSize: config.friendRosterPageSize,
    symbianFriendRosterPageSize: config.symbianFriendRosterPageSize,
    symbianGroupDiscoveryBatchSize: config.symbianGroupDiscoveryBatchSize,
    symbianGroupDiscoveryDelayMs: config.symbianGroupDiscoveryDelayMs,
    symbianGroupDiscoveryIntervalMs: config.symbianGroupDiscoveryIntervalMs,
    symbianGroupProbeLimit: config.symbianGroupProbeLimit,
    symbianGroupProbeId: config.symbianGroupProbeId,
    symbianGroupProbeSendMapping: config.symbianGroupProbeSendMapping,
    symbianGroupInfoProfile: config.symbianGroupInfoProfile,
    symbianDiscussionListLimit: config.symbianDiscussionListLimit,
    remoteSender,
    mediaService,
    deliverOutbox,
    onGroupReceiveReady,
    replayGroupHistoryDelayMs: config.replayGroupHistoryDelayMs,
    onClientReady,
    replayPrivateHistoryDelayMs: config.replayPrivateHistoryDelayMs,
    sessionKeyFactory: () => crypto.randomBytes(16),
  });
  qqServer.deliverGroup = deliverGroup;

  backend = new NapCatBackend({
    config,
    store,
    sessions: qqServer.qqSessions,
    server: qqServer,
    logger: uiLogger,
    offlineQueue: outboxQueue,
    mediaBaseUrl,
  });

  const adminServer = createAdminServer({ config, store, backend, logger: uiLogger, logBuffer });

  // qzone-bridge 客户端：看说说列表用（发说说仍走 backend.sendQzoneMsg）。
  const qzoneBridge = createQzoneBridge({ baseUrl: config.qzoneBridgeUrl, logger });

  const mobileServer = createMobileGroupServer({
    store,
    logger,
    mediaService,
    requestEvent: 'mobile_http_request',
    pushGroupDiscovery: () => {},
    sendQzoneMsg: (content) => backend
      ? backend.sendQzoneMsg(content)
      : Promise.resolve({ ok: false, code: 'not_available', error: 'NapCat 未连接' }),
    getQzoneList: () => qzoneBridge.getMyPosts(),
    getQzoneFriends: () => qzoneBridge.getFriendFeedList(),
    getQzoneComments: (tid) => qzoneBridge.getComments(tid),
    sendQzoneLike: (tid) => qzoneBridge.sendLike(tid),
    sendQzoneComment: (tid, content) => qzoneBridge.sendComment(tid, content),
  });

  // ---------- 启动 ----------
  qqServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      uiLogger.error(`端口 ${config.port} 已被占用，可能网关已在运行。请先停止旧进程再启动。`);
      process.exit(1);
    }
    uiLogger.error('网关错误: ' + err.message);
  });
  qqServer.listen(config.port, config.host, () => {
    uiLogger.log(`老客户端 TCP 网关已监听 ${config.host}:${config.port}`);
    uiLogger.log(`管理页: http://${config.adminHost}:${config.adminPort}`);
    uiLogger.log(`媒体/WAP: ${config.mobileHost}:${config.mobilePort}`);
    uiLogger.log(`收图链接基址: ${mediaBaseUrl}（多网卡可能挑错，手机打不开就核对这个 IP）`);
    uiLogger.log(`登录响应 IP: ${loginAddress}`
      + `${loginOverrideIp ? '（来自 config.loginPublicHost）' : '（自动探测，多网卡可能挑错）'}`);
    uiLogger.log(`NapCat: ${config.onebotUrl}（设备 QQ 号=${backend.selfId || '连接后自动获取'}）`);
  });
  mobileServer.listen(config.mobilePort, config.mobileHost, () => {
    uiLogger.log(`媒体/WAP 服务已监听 ${config.mobileHost}:${config.mobilePort}`);
  });
  mobileServer.on('error', (err) => {
    uiLogger.error(`媒体/WAP 端口 ${config.mobilePort} 启动失败: ${err.message}`);
  });
  adminServer.listen(config.adminPort, config.adminHost, () => {
    uiLogger.log(`管理页已监听 ${config.adminHost}:${config.adminPort}`);
  });
  adminServer.on('error', (err) => {
    uiLogger.error(`管理页端口 ${config.adminPort} 启动失败: ${err.message}`);
  });

  fs.writeFileSync(path.join(config.dataDir, 'gateway.pid'), String(process.pid));
  backend.start();

  let closing = false;
  function shutdown(signal) {
    if (closing) return;
    closing = true;
    uiLogger.log(`收到 ${signal}，正在关闭...`);
    try { fs.unlinkSync(path.join(config.dataDir, 'gateway.pid')); } catch (err) {}
    try { qqServer.closeAllConnections(); } catch (err) {}
    try { qqServer.close(); } catch (err) {}
    try { mobileServer.close(); } catch (err) {}
    try { adminServer.close(); } catch (err) {}
    try { backend.stop(); } catch (err) {}
    try { store.close(); } catch (err) {}
    setTimeout(() => process.exit(0), 300);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
