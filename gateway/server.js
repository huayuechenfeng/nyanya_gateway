'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const { TYPE, FrameReader, encode, negotiateAuth } = require('../packages/nyanya-protocol');
const { loadConfig } = require('./config');
const { OneBotClient } = require('../packages/onebot-adapter');
const {
  BoundedHistory,
  FixedWindowRateLimiter,
  OfflineDeliveryQueue,
  OneBotMessageRouter,
  SessionRegistry,
  normalizeFriend,
  normalizeGroup,
  normalizeOneBotMessage,
  normalizeOneBotNotice,
  safeText,
  segmentText,
} = require('../packages/gateway-core');

function equalToken(actual, expected) {
  const a = Buffer.from(actual || '', 'utf8');
  const b = Buffer.from(expected || '', 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createGateway(config, onebot) {
  const sessionRegistry = new SessionRegistry();
  const offline = new OfflineDeliveryQueue({ capacity: config.offlineCap });
  const history = new BoundedHistory({ capacity: config.historyCap });
  const sendLimiter = new FixedWindowRateLimiter({
    maxPerWindow: config.sendMaxPerMinute,
    windowMs: 60000,
    minIntervalMs: config.sendMinIntervalMs,
  });
  const messageRouter = new OneBotMessageRouter({ onebot, rateLimiter: sendLimiter });

  function writeFrame(socket, type, seq, payload) {
    try {
      socket.write(encode(type, seq, payload));
    } catch (err) {
      socket.destroy();
    }
  }

  function pushToDevice(device, type, seq, payload) {
    const state = sessionRegistry.get(device);
    if (state && state.socket && !state.socket.destroyed) {
      writeFrame(state.socket, type, seq, payload);
      return true;
    }
    offline.enqueue(device, { type, seq, payload });
    return false;
  }

  function onOneBotEvent(event) {
    const message = normalizeOneBotMessage(event);
    if (message) {
      const payload = {
        chatType: message.chatType,
        peer: message.peerId,
        senderName: message.sender.displayName,
        text: message.text,
        time: message.time,
        messageId: message.messageId,
      };
      history.append(message.peerId, {
        chatType: message.chatType,
        peer: message.peerId,
        senderName: message.sender.displayName,
        text: message.text,
        time: message.time,
      });
      for (const device of sessionRegistry.knownKeys()) {
        pushToDevice(device, TYPE.MSG_PUSH, 0, payload);
      }
      return;
    }
    const notice = normalizeOneBotNotice(event);
    if (notice) {
      const payload = { text: notice.text, time: notice.time };
      for (const device of sessionRegistry.knownKeys()) {
        pushToDevice(device, TYPE.NOTICE, 0, payload);
      }
    }
  }

  if (onebot) onebot.onEvent(onOneBotEvent);

  function handleFrame(socket, state, frame) {
    const { type, seq, body } = frame;
    let obj = {};
    if (body.length > 0) {
      try {
        obj = JSON.parse(body.toString('utf8'));
      } catch (err) {
        writeFrame(socket, TYPE.ERROR, seq, { code: 'bad_json', message: 'bad json payload' });
        return;
      }
    }
    if (!state.authed && type !== TYPE.AUTH) {
      writeFrame(socket, TYPE.AUTH_FAIL, seq, { message: 'auth required' });
      socket.destroy();
      return;
    }
    switch (type) {
      case TYPE.AUTH: {
        const device = safeText(obj.device);
        const token = safeText(obj.token);
        if (!device || !equalToken(token, config.token)) {
          writeFrame(socket, TYPE.AUTH_FAIL, seq, { message: 'invalid token' });
          socket.destroy();
          return;
        }
        const negotiation = negotiateAuth(obj);
        if (!negotiation.ok) {
          writeFrame(socket, TYPE.AUTH_FAIL, seq, {
            code: negotiation.code,
            message: negotiation.message,
            supportedVersions: negotiation.supportedVersions,
          });
          socket.destroy();
          return;
        }
        state.authed = true;
        state.device = device;
        state.protocolVersion = negotiation.protocolVersion;
        state.capabilities = negotiation.capabilities;
        state.legacyProtocol = negotiation.legacyClient;
        const old = sessionRegistry.activate(device, state);
        if (old && old.socket !== socket) {
          try {
            old.socket.destroy();
          } catch (err) {
            // ignore
          }
        }
        const queued = offline.take(device);
        writeFrame(socket, TYPE.AUTH_OK, seq, {
          serverTime: Math.floor(Date.now() / 1000),
          heartbeatMs: config.heartbeatMs,
          offlineCount: queued.length,
          protocolVersion: negotiation.protocolVersion,
          capabilities: negotiation.capabilities,
          legacyProtocol: negotiation.legacyClient,
        });
        for (const item of queued) {
          writeFrame(socket, item.type, item.seq, item.payload);
        }
        break;
      }
      case TYPE.PING:
        writeFrame(socket, TYPE.PONG, seq, { serverTime: Math.floor(Date.now() / 1000) });
        break;
      case TYPE.SEND_TEXT: {
        const chatType = safeText(obj.chatType);
        const peer = safeText(obj.peer);
        const text = safeText(obj.text);
        if (!peer || text.length === 0) {
          writeFrame(socket, TYPE.ERROR, seq, { code: 'bad_params', message: 'peer/text required' });
          return;
        }
        messageRouter.sendText({ chatType, peerId: peer, text, rateKey: socket }).then((result) => {
          if (result.ok) {
            writeFrame(socket, TYPE.SEND_RESULT, seq, {
              ok: true,
              messageId: result.messageId,
            });
          } else if (result.code === 'rate_limited') {
            writeFrame(socket, TYPE.ERROR, seq, { code: 'rate_limited', message: '发送太频繁' });
          } else {
            config.log.error('[send] ' + chatType + ' -> ' + peer + ' 失败: ' + (result.error || 'unknown'));
            writeFrame(socket, TYPE.ERROR, seq, { code: 'onebot', message: result.error || 'send failed' });
          }
        }).catch((err) => {
          config.log.error('[send] ' + chatType + ' -> ' + peer + ' 异常: ' + err.message);
          writeFrame(socket, TYPE.ERROR, seq, { code: 'onebot', message: err.message });
        });
        break;
      }
      case TYPE.FETCH_CONTACTS: {
        Promise.all([
          onebot.sendAction('get_friend_list', {}),
          onebot.sendAction('get_group_list', {})
        ]).then((results) => {
          const friends = [];
          const groups = [];
          const friendResult = results[0];
          const groupResult = results[1];
          if (friendResult.ok && Array.isArray(friendResult.data)) {
            for (const item of friendResult.data) {
              const friend = normalizeFriend(item);
              friends.push({
                id: friend.id,
                name: friend.nickname,
                remark: friend.remark,
              });
            }
          }
          if (groupResult.ok && Array.isArray(groupResult.data)) {
            for (const item of groupResult.data) {
              const group = normalizeGroup(item);
              groups.push({
                id: group.id,
                name: group.title,
              });
            }
          }
          writeFrame(socket, TYPE.CONTACTS_SYNC, seq, { friends, groups });
        }).catch((err) => {
          writeFrame(socket, TYPE.ERROR, seq, { code: 'onebot', message: err.message });
        });
        break;
      }
      case TYPE.FETCH_HISTORY: {
        const peer = safeText(obj.peer);
        const list = history.get(peer, 20);
        writeFrame(socket, TYPE.HISTORY_PAGE, seq, { peer, messages: list });
        break;
      }
      case TYPE.READ_ACK:
        break;
      default:
        writeFrame(socket, TYPE.ERROR, seq, { code: 'unknown', message: 'unknown type ' + type });
    }
  }

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    const state = {
      authed: false,
      device: null,
      protocolVersion: null,
      capabilities: [],
      legacyProtocol: true,
      socket,
      reader: new FrameReader()
    };
    sessionRegistry.add(state);
    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = state.reader.feed(chunk);
      } catch (err) {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        handleFrame(socket, state, frame);
      }
    });
    socket.on('error', () => {
      // ignore
    });
    socket.on('close', () => {
      sessionRegistry.remove(state);
      sendLimiter.delete(socket);
    });
  });

  server.start = function start(done) {
    server.listen(config.port, config.host, () => {
      const address = server.address();
      config.log.log('[gateway] listening on ' + address.address + ':' + address.port);
      if (done) done(null, address);
    });
  };

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      config.log.error('[gateway] 端口 ' + config.port + ' 已被占用，网关可能已经在运行。');
      config.log.error('[gateway] 请先运行 停止网关.bat，或关闭旧网关窗口后再启动。');
      process.exit(1);
    } else {
      config.log.error('[gateway] ' + err.message);
    }
  });

  server.stop = function stop() {
    for (const state of sessionRegistry.all()) {
      try {
        state.socket.destroy();
      } catch (err) {
        // ignore
      }
    }
    sessionRegistry.clear();
    sendLimiter.clear();
    offline.clear();
    history.clear();
    server.close();
  };

  return server;
}

function main() {
  const config = loadConfig();
  const onebot = new OneBotClient({
    url: config.onebotUrl,
    token: config.onebotToken,
    log: config.log
  });
  onebot.onStatusChange((up) => {
    config.log.log('[onebot] ' + (up ? 'connected' : 'disconnected'));
  });
  onebot.start();
  const server = createGateway(config, onebot);
  server.start();
  const shutdown = () => {
    server.stop();
    onebot.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createGateway, segmentText, safeText };
