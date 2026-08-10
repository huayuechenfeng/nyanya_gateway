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
const { NapCatBackend } = require('./core/napcat-backend');
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
    Object.assign(defaultData(), { accounts: [] }));
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
  const loginIp = Buffer.from(lanIpv4().split('.').map(Number));

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
      // 媒体降级：老客户端上传的图片/语音只存本地，不转发真实 QQ
      const kind = media.mediaType === 3 ? '语音' : '图片';
      const text = `【${kind}】已上传（v1 媒体降级，不发送到真实 QQ）`;
      try {
        store.saveMessage(media.from, media.to, text);
      } catch (err) {
        logger({ event: 'media_degraded_error', message: err.message });
      }
      logger({
        event: 'media_degraded', mediaId: media.id, from: media.from,
        to: media.to, mediaType: media.mediaType, bytes: media.size,
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
  });

  const adminServer = createAdminServer({ config, store, backend, logger: uiLogger, logBuffer });

  const mobileServer = createMobileGroupServer({
    store,
    logger,
    mediaService,
    requestEvent: 'mobile_http_request',
    pushGroupDiscovery: () => {},
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
