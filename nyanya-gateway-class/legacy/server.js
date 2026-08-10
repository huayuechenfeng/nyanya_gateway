'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const protocol = require('./protocol');
const symbian = require('./symbian-protocol');
const { AccountStore } = require('./store');
const { CAPABILITIES } = require('./capabilities');
const mediaProtocol = require('./media-service');

function jsonLogger(event) {
  process.stdout.write(JSON.stringify(Object.assign({
    time: new Date().toISOString(),
  }, event)) + '\n');
}

// 解析 0x008C 订阅清单（TLV 结构，从 MobileQQ 12.0.16 的 ik 组包逻辑还原）：
// 每块 = type(1) + len(2) + data；type=4 的 data 为
// [1][count u16][count × 4 字节群号]。解析失败返回空数组。
function parseGroupReceiveFilter(payload) {
  const groups = [];
  if (!Buffer.isBuffer(payload) || payload.length < 3) return groups;
  let offset = 0;
  while (offset + 3 <= payload.length) {
    const type = payload[offset];
    const length = payload.readUInt16BE(offset + 1);
    const dataStart = offset + 3;
    if (length === 0 || dataStart + length > payload.length) break;
    if (type === 4 && length >= 3) {
      const count = payload.readUInt16BE(dataStart + 1);
      for (let index = 0; index < count; index += 1) {
        const groupOffset = dataStart + 3 + index * 4;
        if (groupOffset + 4 <= dataStart + length) {
          groups.push(payload.readUInt32BE(groupOffset));
        }
      }
    }
    offset = dataStart + length;
  }
  return groups;
}

// J2ME 0x0070: [count u16][count x (receiveFlag u8 + groupId u32)].
// receiveFlag=1 means receive; 0 means blocked. Some initialization packets
// reserve entries with groupId=0, so callers must ignore those placeholders.
function parseGroupReceiveState(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 2) {
    return { declaredCount: 0, entries: [], complete: false };
  }
  const declaredCount = payload.readUInt16BE(0);
  const availableCount = Math.floor((payload.length - 2) / 5);
  const parsedCount = Math.min(declaredCount, availableCount);
  const entries = [];
  for (let index = 0; index < parsedCount; index += 1) {
    const offset = 2 + index * 5;
    entries.push({
      receive: payload[offset] === 1,
      flag: payload[offset],
      groupId: payload.readUInt32BE(offset + 1),
    });
  }
  return {
    declaredCount,
    entries,
    complete: parsedCount === declaredCount,
  };
}

function isSymbianLogin(login) {
  if (!login || !Buffer.isBuffer(login.clientConstant)) return false;
  // QQ2013/S60 observed on the real device. Key-marker detection alone is not
  // sufficient: when the random server key already contains the marker bits,
  // the normal and Symbian effective keys are identical.
  if (login.clientConstant.toString('hex') === '32344239353731373534454345453236') {
    return true;
  }
  const extensionTypes = new Set(
    (login.extensions || []).map((extension) => Number(extension.type)));
  return extensionTypes.has(5) && extensionTypes.has(11);
}

function createQQServer(options) {
  const settings = Object.assign({
    // Old J2ME builds may stay completely silent between user actions and do
    // not necessarily emit a heartbeat the gateway understands. An
    // application-level idle timeout therefore creates a half-dead UI: the
    // phone still looks online after the server has closed its socket.
    idleTimeoutMs: 0,
    keepAliveInitialDelayMs: 60000,
    traceProtocol: false,
    symbianGroupProbeLimit: 1,
    symbianGroupProbeId: 0,
    symbianGroupProbeSendMapping: false,
    symbianGroupInfoProfile: 's60_qq2013',
    autoAcceptFriends: true,
    friendPushDelayMs: 150,
    sessionKeyFactory: () => crypto.randomBytes(16),
    logger: jsonLogger,
  }, options || {});
  const dataFile = Object.prototype.hasOwnProperty.call(settings, 'dataFile')
    ? settings.dataFile : path.join(__dirname, 'data', 'private-qq.sqlite');
  const store = settings.store || new AccountStore(dataFile, settings.initialData);
  const sessions = settings.sessions || new Map();

  function visiblePresence(uin) {
    const account = store.get(uin);
    if (account && account.type === 'virtual' && account.enabled) return 10;
    if (settings.remoteSender) {
      // nyanya 模式：不区分好友在线状态，统一显示配置值
      return settings.friendPresence === undefined ? 10 : Number(settings.friendPresence);
    }
    const session = sessions.get(Number(uin));
    if (!session || !session.loggedIn) return 20;
    return session.presence === 40 ? 20 : session.presence;
  }

  function writeEncrypted(session, command, sequence, plain, status) {
    if (!session || !session.sessionKey || session.socket.destroyed) return false;
    session.socket.write(protocol.createFrame({
      command,
      sequence,
      uin: session.uin,
      status: status || 0,
      payload: plain === undefined ? Buffer.alloc(0)
        : protocol.encryptPayload(plain, session.sessionKey),
    }));
    return true;
  }

  function pushGroupNotifyConfig(session, reason) {
    if (!settings.remoteSender || !session || !session.loggedIn
        || session.clientFamily === 'symbian_s60') return false;
    const notifySeconds = Math.max(5, Math.min(86400,
      Number(settings.notifyIntervalSeconds || 60)));
    const notifyPayload = Buffer.alloc(5);
    notifyPayload[0] = 0;
    notifyPayload.writeUInt32BE(notifySeconds, 1);
    session.pushSequence = (session.pushSequence + 1) & 0xFFFF;
    if (!writeEncrypted(session, protocol.COMMAND_GROUP_NOTIFY_CONFIG,
      session.pushSequence, notifyPayload)) return false;
    settings.logger({
      event: 'group_notify_config_pushed', peer: session.peer, uin: session.uin,
      intervalSeconds: notifySeconds, reason,
    });
    return true;
  }

  function normalizeGroupReceiveFilter(groupIds) {
    const filter = new Set();
    for (const value of groupIds || []) {
      const groupId = Number(value);
      if (!Number.isInteger(groupId) || groupId <= 0 || groupId > 0xFFFFFFFF) continue;
      filter.add(groupId);
      const group = store.getGroup(groupId);
      if (group) {
        filter.add(Number(group.id));
        filter.add(Number(group.publicId));
      }
    }
    return filter;
  }

  function pushPresenceChange(changedUin, reason) {
    const presence = visiblePresence(changedUin);
    for (const friend of store.friendsOf(changedUin)) {
      const target = sessions.get(friend.uin);
      if (!target || !target.loggedIn || target.socket.destroyed) continue;
      target.pushSequence = (target.pushSequence + 1) & 0xFFFF;
      writeEncrypted(target, protocol.COMMAND_BUDDY_DETAILS, target.pushSequence,
        protocol.buildBuddyDetailsPayload([{ uin: changedUin, presence }], true));
      settings.logger({
        event: 'presence_pushed', uin: friend.uin, friendUin: Number(changedUin),
        presence, reason,
      });
    }
  }

  function pushFriendRequestNotification(receiverUin, requesterUin, message, reason) {
    const target = sessions.get(Number(receiverUin));
    if (!target || !target.loggedIn || target.socket.destroyed) return false;
    target.pushSequence = (target.pushSequence + 1) & 0xFFFF;
    writeEncrypted(target, protocol.COMMAND_FRIEND_NOTIFICATION, target.pushSequence,
      protocol.buildFriendRequestNotificationPayload(requesterUin, message));
    settings.logger({
      event: 'friend_request_pushed', uin: target.uin,
      requesterUin: Number(requesterUin), command: '0x0095', reason,
    });
    return true;
  }

  function pushFriendAccepted(leftUin, rightUin, action, reason) {
    const pairs = [
      { session: sessions.get(Number(leftUin)), account: store.get(rightUin) },
      { session: sessions.get(Number(rightUin)), account: store.get(leftUin) },
    ];
    for (const pair of pairs) {
      if (!pair.session || !pair.account || pair.session.socket.destroyed) continue;
      pair.session.pushSequence = (pair.session.pushSequence + 1) & 0xFFFF;
      writeEncrypted(pair.session, protocol.COMMAND_FRIEND_RESULT,
        pair.session.pushSequence, protocol.buildFriendResultPayload(
          action === undefined ? 0 : action, pair.account.uin, 0));
      pair.session.pushSequence = (pair.session.pushSequence + 1) & 0xFFFF;
      writeEncrypted(pair.session, protocol.COMMAND_USER_PROFILE,
        pair.session.pushSequence, protocol.buildUserProfilePayload(pair.account, 2));
      settings.logger({
        event: 'friend_accepted_pushed', uin: pair.session.uin,
        friendUin: pair.account.uin, reason,
      });
    }
  }

  function pushGroupMappings(session, groups, reason) {
    const values = groups || store.groupsOf(session.uin);
    if (!session.loggedIn || session.socket.destroyed || values.length === 0) return false;
    const mappedValues = values.slice(0, 127);
    session.pushSequence = (session.pushSequence + 1) & 0xFFFF;
    const plain = protocol.buildGroupMappingPayload(mappedValues);
    writeEncrypted(session, protocol.COMMAND_GROUP_MAPPING, session.pushSequence, plain);
    for (const group of mappedValues) {
      session.advertisedGroupIds.add(Number(group.id));
      session.advertisedGroupIds.add(Number(group.publicId || group.id));
      session.announcedGroupIds.add(Number(group.id));
      session.announcedGroupIds.add(Number(group.publicId || group.id));
    }
    settings.logger({
      event: 'group_mapping_pushed', uin: session.uin,
      groupIds: mappedValues.map((group) => group.id), reason,
      plainHex: settings.traceProtocol ? plain.toString('hex') : undefined,
    });
    return true;
  }

  function pushGroupRelations(session, groups, reason) {
    const values = groups || store.groupsOf(session.uin);
    if (!session.loggedIn || session.socket.destroyed || values.length === 0) return false;
    session.pushSequence = (session.pushSequence + 1) & 0xFFFF;
    const plain = protocol.buildBuddyListPayload(values.map((group) => ({
      uin: group.id, relationType: 4, groupIndex: 0,
    })));
    writeEncrypted(session, protocol.COMMAND_BUDDY_LIST, session.pushSequence, plain);
    for (const group of values) {
      session.announcedGroupIds.add(Number(group.id));
      session.announcedGroupIds.add(Number(group.publicId || group.id));
    }
    settings.logger({
      event: 'group_relation_pushed', uin: session.uin,
      groupIds: values.map((group) => group.id), reason,
      plainHex: settings.traceProtocol ? plain.toString('hex') : undefined,
    });
    return true;
  }

  function pushGroupDiscovery(session, groups, reason) {
    // A live J2ME client needs both pieces: 0x0054 creates hp objects and
    // 0x00A4 records their public-number mapping. This makes newly created or
    // newly invited groups visible without requiring a relogin.
    const relationPushed = pushGroupRelations(session, groups, reason);
    const mappingPushed = pushGroupMappings(session, groups, reason);
    return relationPushed || mappingPushed;
  }

  function selectSymbianProbeGroups(session, values, reason) {
    const limit = Math.max(0, Math.min(25, Number(settings.symbianGroupProbeLimit || 0)));
    session.symbianGroupProbeActive = limit > 0;
    if (limit === 0) return values;

    if (session.symbianGroupProbeIds.size > 0) {
      return values.filter((group) => session.symbianGroupProbeIds.has(Number(group.id))
        || session.symbianGroupProbeIds.has(Number(group.publicId || group.id)));
    }

    const configuredId = Number(settings.symbianGroupProbeId || 0);
    const candidates = configuredId > 0
      ? values.filter((group) => Number(group.id) === configuredId
        || Number(group.publicId || group.id) === configuredId)
      : values;
    if (candidates.length === 0) {
      settings.logger({
        event: 'symbian_group_probe_not_found', peer: session.peer, uin: session.uin,
        configuredId, availableCount: values.length, reason: reason || 'symbian_queue',
      });
      return [];
    }
    const selected = candidates.slice(0, limit);
    for (const group of selected) {
      session.symbianGroupProbeIds.add(Number(group.id));
      session.symbianGroupProbeIds.add(Number(group.publicId || group.id));
    }
    settings.logger({
      event: 'symbian_group_probe_selected', peer: session.peer, uin: session.uin,
      configuredId: configuredId || undefined,
      groups: selected.map((group) => ({
        id: Number(group.id), publicId: Number(group.publicId || group.id),
        title: group.title,
      })),
      sendMapping: settings.symbianGroupProbeSendMapping === true,
      infoProfile: settings.symbianGroupInfoProfile,
      reason: reason || 'symbian_queue',
    });
    return selected;
  }

  function pushSymbianGroupDiscovery(session, groups, reason) {
    const relationPushed = pushGroupRelations(session, groups, reason);
    const mappingEnabled = !session.symbianGroupProbeActive
      || settings.symbianGroupProbeSendMapping === true;
    const mappingPushed = mappingEnabled ? pushGroupMappings(session, groups, reason) : false;
    settings.logger({
      event: 'symbian_group_discovery_batch', peer: session.peer, uin: session.uin,
      groupIds: groups.map((group) => Number(group.id)), mappingEnabled,
      reason: reason || 'symbian_queue',
    });
    return relationPushed || mappingPushed;
  }

  function queueSymbianGroupDiscovery(session, groups, reason, initialDelayMs) {
    if (!session || !session.loggedIn || session.socket.destroyed
        || session.clientFamily !== 'symbian_s60'
        || !session.friendRosterSyncComplete) return false;
    const allValues = groups || store.groupsOf(session.uin);
    if (!Array.isArray(allValues) || allValues.length === 0) return false;
    // Only the acknowledgement-gated queue expands past the initial probe.
    // Client-initiated 0x00AF/0x0054 list requests continue returning the
    // stable probe subset, otherwise a later refresh could still dump the
    // complete group list into QQ2013 in a single response.
    const values = session.symbianGroupProbeActive && session.symbianGroupProbeValidated
      ? allValues : selectSymbianProbeGroups(session, allValues, reason);
    if (values.length === 0) return false;
    for (const group of values) {
      const groupId = Number(group && group.id);
      const publicId = Number(group && (group.publicId || group.id));
      if (!Number.isInteger(groupId) || groupId <= 0
          || session.advertisedGroupIds.has(groupId)
          || session.advertisedGroupIds.has(publicId)
          || session.announcedGroupIds.has(groupId)
          || session.announcedGroupIds.has(publicId)) continue;
      session.pendingGroupDiscoveries.set(groupId, group);
    }
    if (session.pendingGroupDiscoveries.size === 0) return false;
    if (session.groupDiscoveryTimer) return true;

    const acknowledgementGated = session.symbianGroupProbeActive
      && session.symbianGroupProbeValidated;
    if (acknowledgementGated && session.symbianGroupAwaitingId) return true;

    const batchSize = acknowledgementGated ? 1 : Math.max(1, Math.min(25,
      Number(settings.symbianGroupDiscoveryBatchSize || 10)));
    const intervalMs = Math.max(50, Math.min(5000,
      Number(settings.symbianGroupDiscoveryIntervalMs || 250)));
    const runBatch = () => {
      session.groupDiscoveryTimer = null;
      if (!session.loggedIn || session.socket.destroyed
          || session.clientFamily !== 'symbian_s60') {
        session.pendingGroupDiscoveries.clear();
        return;
      }
      const batch = Array.from(session.pendingGroupDiscoveries.values()).slice(0, batchSize);
      for (const group of batch) session.pendingGroupDiscoveries.delete(Number(group.id));
      if (batch.length > 0) {
        pushSymbianGroupDiscovery(session, batch, reason || 'symbian_queue');
        if (acknowledgementGated) {
          session.symbianGroupAwaitingId = Number(batch[0].id);
          settings.logger({
            event: 'symbian_group_discovery_waiting', peer: session.peer,
            uin: session.uin, groupId: session.symbianGroupAwaitingId,
            remainingCount: session.pendingGroupDiscoveries.size,
            reason: reason || 'symbian_queue',
          });
          return;
        }
      }
      if (session.pendingGroupDiscoveries.size > 0) {
        session.groupDiscoveryTimer = setTimeout(runBatch, intervalMs);
        if (session.groupDiscoveryTimer.unref) session.groupDiscoveryTimer.unref();
      } else {
        settings.logger({
          event: 'symbian_group_discovery_complete', peer: session.peer,
          uin: session.uin, advertisedCount: session.advertisedGroupIds.size,
          announcedCount: session.announcedGroupIds.size,
          reason: reason || 'symbian_queue',
        });
      }
    };
    const delayMs = Math.max(0, Math.min(10000,
      Number(initialDelayMs === undefined
        ? settings.symbianGroupDiscoveryDelayMs || 750 : initialDelayMs)));
    session.groupDiscoveryTimer = setTimeout(runBatch, delayMs);
    if (session.groupDiscoveryTimer.unref) session.groupDiscoveryTimer.unref();
    settings.logger({
      event: 'symbian_group_discovery_queued', peer: session.peer,
      uin: session.uin, pendingCount: session.pendingGroupDiscoveries.size,
      batchSize, delayMs, reason: reason || 'symbian_queue',
    });
    return true;
  }

  function setSessionPresence(uin, value, reason) {
    const session = sessions.get(Number(uin));
    if (!session || !session.loggedIn) return false;
    const presence = protocol.normalizePresence(value);
    const changed = session.presence !== presence;
    session.presence = presence;
    if (changed) pushPresenceChange(session.uin, reason || 'changed');
    return true;
  }

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const peer = (socket.remoteAddress || 'unknown') + ':' + (socket.remotePort || 0);
    const state = {
      buffer: Buffer.alloc(0),
      sessionKey: null,
      sessionKeyCandidates: [],
      sessionKeyVariant: null,
      auxiliaryKey: null,
      uin: 0,
      account: null,
      loggedIn: false,
      clientFamily: 'legacy',
      groupReceiveFilter: null,
      groupReceiveStateReady: false,
      advertisedGroupIds: new Set(),
      announcedGroupIds: new Set(),
      symbianGroupProbeIds: new Set(),
      symbianGroupProbeActive: false,
      symbianGroupProbeValidated: false,
      symbianGroupAwaitingId: 0,
      symbianGroupInfoServedIds: new Set(),
      symbianBuddyStatusDiscoveryActive: false,
      buddyDetailsSyncComplete: false,
      friendRosterSyncComplete: false,
      pendingGroupDiscoveries: new Map(),
      groupDiscoveryTimer: null,
      presence: 20,
      auxiliaryPresenceSubscriptions: new Set(),
      peer,
      socket,
      pushSequence: crypto.randomBytes(2).readUInt16BE(0),
    };
    settings.logger({ event: 'connection', peer });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, settings.keepAliveInitialDelayMs);
    if (settings.idleTimeoutMs > 0) socket.setTimeout(settings.idleTimeoutMs);

    socket.on('timeout', () => {
      settings.logger({ event: 'timeout', peer });
      socket.destroy();
    });

    socket.on('data', (chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      const consumed = protocol.consumeFrames(state.buffer);
      state.buffer = consumed.remainder;
      for (const frame of consumed.frames) {
        settings.logger({
          event: 'packet', peer, command: '0x' + frame.command.toString(16).padStart(4, '0'),
          sequence: frame.sequence, uin: frame.uin, bytes: frame.length,
        });

        if (frame.command === protocol.COMMAND_GET_KEY) {
          state.uin = frame.uin;
          state.sessionKey = settings.sessionKeyFactory();
          // MobileQQ builds disagree on key placement, and QQ2013 for Symbian
          // merges one byte of its GET_KEY marker into the effective key. Try
          // the compatible forms and keep the one whose QQ-TEA padding is valid.
          state.sessionKeyCandidates = [
            { name: 'payload_first_16', key: state.sessionKey },
            ...(frame.payload.length >= 7 ? [{
              name: 'symbian_client_marker_or_byte_6',
              key: protocol.deriveSymbianSessionKey(state.sessionKey, frame.payload),
            }] : []),
            {
              name: 'envelope_status_then_payload_15',
              key: Buffer.concat([Buffer.from([0]), state.sessionKey.subarray(0, 15)]),
            },
            {
              name: 'payload_skip_first_then_trailing_status',
              key: Buffer.concat([state.sessionKey.subarray(1), Buffer.from([0])]),
            },
          ];
          state.sessionKeyVariant = 'payload_first_16';
          socket.write(protocol.createFrame({
            command: frame.command,
            sequence: frame.sequence,
            uin: frame.uin,
            status: 0,
            payload: protocol.buildGetKeyResponsePayload(state.sessionKey),
          }));
          settings.logger({
            event: 'get_key_ok', peer, uin: frame.uin,
            keyHex: settings.traceProtocol ? state.sessionKey.toString('hex') : undefined,
          });
          continue;
        }

        if (frame.command === protocol.COMMAND_LOGIN) {
          let login = null;
          let loginPlain = null;
          let loginParseError = null;
          if (state.sessionKey) {
            const candidates = state.sessionKeyCandidates.length
              ? state.sessionKeyCandidates : [{ name: 'payload_first_16', key: state.sessionKey }];
            for (const candidate of candidates) {
              loginPlain = protocol.decryptPayload(frame.payload, candidate.key);
              if (loginPlain) {
                state.sessionKey = candidate.key;
                state.sessionKeyVariant = candidate.name;
                if (candidate.name === 'symbian_client_marker_or_byte_6') {
                  state.clientFamily = 'symbian_s60';
                }
                break;
              }
            }
            if (loginPlain) {
              settings.logger({
                event: 'session_key_variant_selected', peer, uin: frame.uin,
                variant: state.sessionKeyVariant,
              });
              try {
                login = protocol.parseLoginRequestPayload(loginPlain);
                if (isSymbianLogin(login)) state.clientFamily = 'symbian_s60';
              } catch (error) {
                loginParseError = error.message;
              }
            }
          }
          const account = login && frame.uin === state.uin
            && login.service === 9 && login.revision === 1
            ? store.authenticate(frame.uin, login.passwordDigest) : null;
          const accepted = account !== null;
          if (!accepted) {
            socket.write(protocol.createFrame({
              command: frame.command,
              sequence: frame.sequence,
              uin: frame.uin,
              status: 10,
            }));
            let reason = 'bad_credentials';
            if (!state.sessionKey) reason = 'missing_session_key';
            else if (!loginPlain) reason = 'decrypt_failed';
            else if (!login) reason = 'unsupported_login_payload';
            else if (frame.uin !== state.uin) reason = 'uin_mismatch';
            else if (login.service !== 9 || login.revision !== 1) {
              reason = 'unsupported_service_revision';
            }
            settings.logger({
              event: 'login_rejected', peer, uin: frame.uin, reason,
              parseError: loginParseError || undefined,
              plainBytes: loginPlain ? loginPlain.length : null,
              plainHex: settings.traceProtocol && loginPlain
                ? loginPlain.toString('hex') : undefined,
              encryptedHex: settings.traceProtocol ? frame.payload.toString('hex') : undefined,
            });
            continue;
          }

          state.loggedIn = true;
          state.account = account;
          state.presence = protocol.normalizePresence(login.presence);
          state.advertisedGroupIds.clear();
          state.announcedGroupIds.clear();
          state.symbianGroupProbeIds.clear();
          state.symbianGroupProbeActive = false;
          state.symbianGroupProbeValidated = false;
          state.symbianGroupAwaitingId = 0;
          state.symbianGroupInfoServedIds.clear();
          state.symbianBuddyStatusDiscoveryActive = false;
          state.buddyDetailsSyncComplete = false;
          state.friendRosterSyncComplete = false;
          if (state.groupDiscoveryTimer) clearTimeout(state.groupDiscoveryTimer);
          state.groupDiscoveryTimer = null;
          state.pendingGroupDiscoveries.clear();
          state.buddyDetailsInProgress = false;
          state.buddyDetailsCursor = 0;
          sessions.set(state.uin, state);
          const success = protocol.buildLoginSuccessPayload({
            port: settings.port || 14000,
            loginIp: settings.loginIp,
          });
          socket.write(protocol.createFrame({
            command: frame.command,
            sequence: frame.sequence,
            uin: frame.uin,
            status: 0,
            payload: protocol.encryptPayload(success, state.sessionKey),
          }));
          settings.logger({
            event: 'login_ok', peer, uin: frame.uin, presence: state.presence,
            clientFamily: state.clientFamily,
            clientConstant: login.clientConstant.toString('hex'),
            extensionTypes: login.extensions.map((extension) => extension.type),
          });
          pushPresenceChange(state.uin, 'login');
          // QQ2013 从它主动请求的 0x00AF GetNewList 中读取 kind=4 群关系；
          // 不能在登录初始化期间主动推送 0x00A4。若客户端没有走 0x00AF，
          // 0x0069 名册完成后仍会启用小批 0x0054 + 0x00A4 兼容回退。
          if (state.clientFamily !== 'symbian_s60') pushGroupMappings(state, null, 'login');
          if (settings.remoteSender && state.clientFamily !== 'symbian_s60') {
            // 推送 0x008A：激活客户端的群消息订阅流程（腾讯服务器登录后也会发）。
            // 载荷 = [byte 0][u32 间隔秒数]，J2ME 客户端收到后周期性上报
            // 0x008C 接收清单。QQ2013/Symbian 不兼容该推送，不能向其发送。
            pushGroupNotifyConfig(state, 'login');
          }
          setTimeout(() => {
            if (!state.loggedIn || state.socket.destroyed || !state.account) return;
            for (const request of state.account.incomingRequests) {
              pushFriendRequestNotification(state.uin, request.from, request.message, 'login');
            }
          }, settings.friendPushDelayMs);
          if (settings.deliverOutbox) settings.deliverOutbox(state.uin);
          continue;
        }

        if (frame.command === protocol.COMMAND_LOGOUT && state.loggedIn) {
          state.loggedIn = false;
          if (sessions.get(state.uin) === state) sessions.delete(state.uin);
          pushPresenceChange(state.uin, 'logout');
          state.account = null;
          state.presence = 20;
          state.auxiliaryKey = null;
          socket.write(protocol.createFrame({
            command: frame.command,
            sequence: frame.sequence,
            uin: frame.uin,
            status: 0,
          }));
          settings.logger({ event: 'logout_ok', peer, uin: state.uin });
          // QQ2013 may retain the connection while it tears down and later
          // reinitialises its login engine. Let the client close or reuse the
          // socket instead of sending a server-side FIN immediately after ACK.
          continue;
        }

        if (frame.command === protocol.COMMAND_CHANGE_PRESENCE && state.loggedIn) {
          try {
            const plain = protocol.decryptPayload(frame.payload, state.sessionKey);
            const presence = protocol.parsePresenceChangePayload(plain);
            setSessionPresence(state.uin, presence, 'client_change');
            writeEncrypted(state, frame.command, frame.sequence, Buffer.alloc(0));
            settings.logger({ event: 'presence_changed', peer, uin: state.uin, presence });
          } catch (error) {
            socket.write(protocol.createFrame({
              command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 1,
            }));
            settings.logger({
              event: 'presence_change_rejected', peer, uin: state.uin, message: error.message,
            });
          }
          continue;
        }

        if (frame.command === protocol.COMMAND_AUXILIARY_KEY && state.loggedIn) {
          state.auxiliaryKey = crypto.randomBytes(16);
          const plain = protocol.buildAuxiliaryKeyPayload(state.auxiliaryKey);
          socket.write(protocol.createFrame({
            command: frame.command,
            sequence: frame.sequence,
            uin: frame.uin,
            status: 0,
            payload: protocol.encryptPayload(plain, state.sessionKey),
          }));
          settings.logger({ event: 'auxiliary_key_ok', peer, uin: frame.uin });
          continue;
        }

        // 0x0054 creates the ks.buddy entries. 0x0069 then pages nickname and
        // other metadata onto those existing contacts; it cannot create a
        // missing buddy when the response lookup is made with an empty name.
        if (frame.command === protocol.COMMAND_FRIEND_ROSTER && state.loggedIn) {
          let request;
          try {
            request = protocol.parseFriendRosterRequest(
              protocol.decryptPayload(frame.payload, state.sessionKey));
          } catch (error) {
            settings.logger({
              event: 'friend_roster_rejected', peer, uin: state.uin, message: error.message,
            });
            socket.write(protocol.createFrame({
              command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 1,
            }));
            continue;
          }
          const friends = store.friendsOf(state.uin);
          // 大好友列表必须分页：0x0069 的请求带两字节游标，响应 nextCursor=-1 表示最后一页。
          // QQ2013/Symbian 的名册记录还包含昵称，实机无法稳定解析一页 100 条，
          // 因此使用比普通 J2ME 更小的独立页大小。
          const configuredPageSize = Number(settings.friendRosterPageSize || 100);
          const pageSize = state.clientFamily === 'symbian_s60'
            ? Math.max(1, Math.min(200,
              Number(settings.symbianFriendRosterPageSize || 25), configuredPageSize))
            : Math.max(1, Math.min(200, configuredPageSize));
          // QQ2013 在正常分页结束后可能再发 cursor=-1 作为收尾确认。普通 J2ME
          // 保留历史的全量响应；Symbian 只回受限大小的第一页并保持 next=-1，
          // 避免把数百个带昵称的好友重新塞进一个大包导致客户端崩溃。
          const parsedCursor = Number(request.cursor);
          const rawCursor = Number.isFinite(parsedCursor) ? parsedCursor : 0;
          const terminalReplay = state.clientFamily === 'symbian_s60' && rawCursor < 0;
          const fullPage = state.clientFamily !== 'symbian_s60' && rawCursor < 0;
          const start = rawCursor < 0 ? 0 : rawCursor;
          const page = fullPage ? friends : friends.slice(start, start + pageSize);
          const nextCursor = rawCursor < 0 || start + page.length >= friends.length
            ? -1 : start + page.length;
          const rosterBecameComplete = state.clientFamily === 'symbian_s60'
            && !state.friendRosterSyncComplete && rawCursor >= 0 && nextCursor < 0;
          if (rosterBecameComplete) {
            state.friendRosterSyncComplete = true;
          }
          const plain = protocol.buildFriendRosterPayload(page.map((friend) => ({
            uin: friend.uin,
            nickname: friend.nickname,
            group: 0,
            presence: visiblePresence(friend.uin),
            attributes: 0,
          })), nextCursor);
          socket.write(protocol.createFrame({
            command: frame.command,
            sequence: frame.sequence,
            uin: frame.uin,
            status: 0,
            payload: protocol.encryptPayload(plain, state.sessionKey),
          }));
          settings.logger({
            event: 'friend_roster_ok', peer, uin: state.uin,
            requestCursor: request.cursor, requestReserved: request.reserved,
            count: page.length, nextCursor, fullPage, terminalReplay,
            syncComplete: state.friendRosterSyncComplete,
          });
          if (rosterBecameComplete) {
            queueSymbianGroupDiscovery(state, null, 'symbian_roster_complete');
          }
          continue;
        }

        if (frame.command === protocol.COMMAND_BUDDY_LIST && state.loggedIn) {
          const request = protocol.decryptPayload(frame.payload, state.sessionKey);
          const firstCursor = request && request.length >= 8 ? request.readUInt32BE(0) : null;
          const secondCursor = request && request.length >= 8 ? request.readUInt32BE(4) : null;
          const friends = store.friendsOf(state.uin);
          // MobileQQ's np handler creates group placeholders from the same
          // 0x0054 relation stream when relationType is 4.  0x00A4 only
          // persists the internal/public number mapping; it does not add a
          // group to the in-memory list by itself.
          const relations = friends.map((friend) => ({
            uin: friend.uin,
            relationType: 1,
            groupIndex: 0,
          }));
          const allGroups = store.groupsOf(state.uin);
          const relationGroups = state.clientFamily === 'symbian_s60'
            ? selectSymbianProbeGroups(state, allGroups, 'symbian_buddy_list')
            : allGroups;
          for (const group of relationGroups) {
            relations.push({
              uin: group.id,
              relationType: 4,
              groupIndex: 0,
            });
          }
          if (state.symbianGroupProbeActive) {
            for (const group of relationGroups) {
              state.announcedGroupIds.add(Number(group.id));
              state.announcedGroupIds.add(Number(group.publicId || group.id));
            }
          }
          const plain = protocol.buildBuddyListPayload(relations);
          socket.write(protocol.createFrame({
            command: frame.command,
            sequence: frame.sequence,
            uin: frame.uin,
            status: 0,
            payload: protocol.encryptPayload(plain, state.sessionKey),
          }));
          settings.logger({
            event: 'buddy_list_ok', peer, uin: frame.uin,
            requestCursors: [firstCursor, secondCursor], count: friends.length,
            groupCount: relationGroups.length,
            groupIds: relationGroups.map((group) => Number(group.id)),
            relationType: 1, groupIndex: 0, nextCursor: 0,
            plainHex: settings.traceProtocol ? plain.toString('hex') : undefined,
          });
          continue;
        }

        if (frame.command === protocol.COMMAND_BUDDY_DETAILS && state.loggedIn) {
          const request = protocol.decryptPayload(frame.payload, state.sessionKey);
          const subtype = request && request.length >= 1 ? request[0] : null;
          const friends = store.friendsOf(state.uin);
          // 大好友列表必须分页：0x0071 载荷首字节 0 表示"请再发一页"，
          // 1 表示完成。一页塞几百条会把 QQ2013 的解析器卡死。
          const configuredPageSize = Number(settings.buddyDetailsPageSize || 100);
          const pageSize = state.clientFamily === 'symbian_s60'
            ? Math.max(1, Math.min(200,
              Number(settings.symbianBuddyDetailsPageSize || 25), configuredPageSize))
            : Math.max(1, Math.min(200, configuredPageSize));
          // 客户端翻页游标不可靠（续页请求会带 0xFFFFFFF1 这类值），
          // 按会话状态续页：登录后第一请求从 0 开始，之后依次下推，
          // 返回最终页后复位，供客户端周期轮询重新同步。
          let start;
          if (!state.buddyDetailsInProgress) {
            start = 0;
            state.buddyDetailsInProgress = true;
          } else {
            start = state.buddyDetailsCursor || 0;
          }
          const page = friends.slice(start, start + pageSize);
          const finalPage = start + page.length >= friends.length;
          state.buddyDetailsCursor = start + page.length;
          if (finalPage) {
            state.buddyDetailsInProgress = false;
            state.buddyDetailsCursor = 0;
            state.buddyDetailsSyncComplete = true;
          }
          const detailEntries = page.length > 0 ? page.map((friend) => ({
            uin: friend.uin,
            presence: visiblePresence(friend.uin),
          })) : [{ uin: state.uin, presence: state.presence }];
          const plain = protocol.buildBuddyDetailsPayload(detailEntries, finalPage);
          socket.write(protocol.createFrame({
            command: frame.command,
            sequence: frame.sequence,
            uin: frame.uin,
            status: 0,
            payload: protocol.encryptPayload(plain, state.sessionKey),
          }));
          settings.logger({
            event: 'buddy_details_ok', peer, uin: frame.uin,
            subtype, cursor: start, count: page.length, finalPage, morePages: !finalPage,
            presence: detailEntries.map((entry) => ({ uin: entry.uin, value: entry.presence })),
          });
          continue;
        }

        if (frame.command === protocol.COMMAND_BUDDY_TOKENS && state.loggedIn) {
          let request;
          try {
            request = protocol.parseBuddyTokensRequest(
              protocol.decryptPayload(frame.payload, state.sessionKey));
          } catch (error) {
            settings.logger({
              event: 'buddy_tokens_rejected', peer, uin: state.uin, message: error.message,
            });
            socket.write(protocol.createFrame({
              command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 1,
            }));
            continue;
          }
          const plain = protocol.buildBuddyTokensPayload(request);
          socket.write(protocol.createFrame({
            command: frame.command,
            sequence: frame.sequence,
            uin: frame.uin,
            status: 0,
            payload: protocol.encryptPayload(plain, state.sessionKey),
          }));
          settings.logger({
            event: 'buddy_tokens_ok', peer, uin: state.uin,
            subtype: request.subtype, cursor: request.cursor, targetUin: request.targetUin,
          });
          continue;
        }

        if (frame.command === protocol.COMMAND_FRIEND_METADATA && state.loggedIn) {
          try {
            const request = protocol.parseFriendMetadataRequest(
              protocol.decryptPayload(frame.payload, state.sessionKey));
            const accounts = request.uins.map((uin) => store.get(uin)).filter(Boolean);
            const plain = protocol.buildFriendMetadataPayload(request, accounts);
            writeEncrypted(state, frame.command, frame.sequence, plain);
            settings.logger({
              event: 'friend_metadata_ok', peer, uin: state.uin,
              subtype: request.subtype, requested: request.uins, returned: accounts.length,
            });
          } catch (error) {
            socket.write(protocol.createFrame({
              command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 1,
            }));
            settings.logger({
              event: 'friend_metadata_rejected', peer, uin: state.uin, message: error.message,
            });
          }
          continue;
        }

        if (frame.command === protocol.COMMAND_FRIEND_ACTIVITY && state.loggedIn) {
          try {
            const request = protocol.parseFriendActivityRequest(
              protocol.decryptPayload(frame.payload, state.sessionKey));
            writeEncrypted(state, frame.command, frame.sequence,
              protocol.buildFriendActivityPayload(request.subtype));
            settings.logger({
              event: 'friend_activity_ok', peer, uin: state.uin,
              subtype: request.subtype, requested: request.uins,
            });
          } catch (error) {
            socket.write(protocol.createFrame({
              command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 1,
            }));
            settings.logger({
              event: 'friend_activity_rejected', peer, uin: state.uin, message: error.message,
            });
          }
          continue;
        }

        if (frame.command === protocol.COMMAND_AUXILIARY_FEATURES && state.loggedIn) {
          const request = protocol.decryptPayload(frame.payload, state.sessionKey);
          writeEncrypted(state, frame.command, frame.sequence,
            protocol.buildAuxiliaryFeaturesPayload());
          settings.logger({
            event: 'auxiliary_features_ok', peer, uin: state.uin,
            requestHex: settings.traceProtocol && request ? request.toString('hex') : undefined,
          });
          continue;
        }

        if (frame.command === protocol.COMMAND_SEARCH_USER && state.loggedIn) {
          let search;
          try {
            search = protocol.parseSearchUserPayload(
              protocol.decryptPayload(frame.payload, state.sessionKey));
          } catch (error) {
            settings.logger({ event: 'search_rejected', peer, uin: state.uin, message: error.message });
            continue;
          }
          const results = store.search(search.query, state.uin);
          socket.write(protocol.createFrame({
            command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 0,
            payload: protocol.encryptPayload(protocol.buildSearchUserPayload(results), state.sessionKey),
          }));
          settings.logger({
            event: 'search_ok', peer, uin: state.uin, query: search.query,
            results: results.map((account) => account.uin),
          });
          continue;
        }

        if (frame.command === protocol.COMMAND_USER_PROFILE && state.loggedIn) {
          let request;
          try {
            request = protocol.parseUserProfilePayload(
              protocol.decryptPayload(frame.payload, state.sessionKey));
          } catch (error) {
            settings.logger({ event: 'profile_rejected', peer, uin: state.uin, message: error.message });
            socket.write(protocol.createFrame({
              command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 1,
            }));
            continue;
          }
          const account = store.get(request.targetUin);
          if (!account || ![1, 2, 3].includes(request.subtype)) {
            socket.write(protocol.createFrame({
              command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 1,
            }));
          } else {
            socket.write(protocol.createFrame({
              command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 0,
              payload: protocol.encryptPayload(
                protocol.buildUserProfilePayload(account, request.subtype), state.sessionKey),
            }));
          }
          settings.logger({
            event: 'profile_ok', peer, uin: state.uin, targetUin: request.targetUin,
            found: Boolean(account), subtype: request.subtype,
          });
          continue;
        }

        // The W995 search-results screen first asks whether the selected UIN
        // can be added. Its decoder expects: echoed UIN, result byte, decision
        // byte. Decision 0 makes the same callback send 0x0093/action 0.
        if (frame.command === protocol.COMMAND_FRIEND_PREFLIGHT && state.loggedIn) {
          let request;
          try {
            request = protocol.parseFriendPreflightPayload(
              protocol.decryptPayload(frame.payload, state.sessionKey));
          } catch (error) {
            settings.logger({ event: 'friend_preflight_rejected', peer,
              uin: state.uin, message: error.message });
            continue;
          }
          const requestedAccount = store.get(request.targetUin);
          const result = requestedAccount ? 0 : 153;
          const plain = protocol.buildFriendPreflightPayload(request.targetUin, result, 0);
          socket.write(protocol.createFrame({
            command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 0,
            payload: protocol.encryptPayload(plain, state.sessionKey),
          }));
          settings.logger({
            event: 'friend_preflight_ok', peer, uin: state.uin,
            command: '0x0091', sequence: frame.sequence, targetUin: request.targetUin,
            found: Boolean(requestedAccount), result, decision: 0,
          });
          continue;
        }

        // The search-results UI on the Sony Ericsson build adds a contact via
        // command 0x0093/action 0 after the 0x0091 preflight. Some builds use
        // action 3 directly. It keeps its modal progress form open until
        // a response with the same command and sequence reaches its callback.
        if (frame.command === protocol.COMMAND_FRIEND_RESULT && state.loggedIn) {
          let request;
          try {
            request = protocol.parseFriendResultActionPayload(
              protocol.decryptPayload(frame.payload, state.sessionKey));
          } catch (error) {
            settings.logger({ event: 'friend_result_action_rejected', peer,
              uin: state.uin, message: error.message });
            socket.write(protocol.createFrame({
              command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 0,
              payload: protocol.encryptPayload(
                protocol.buildFriendResultPayload(3, 0, 1, 'Invalid request'), state.sessionKey),
            }));
            continue;
          }
          settings.logger({
            event: 'friend_result_action_received', peer, uin: state.uin,
            command: '0x0093', sequence: frame.sequence,
            action: request.action, targetUin: request.targetUin, value: request.value,
          });
          const requestedAccount = store.get(request.targetUin);
          const inversePending = [0, 3].includes(request.action)
            && state.account.incomingRequests.some(
              (pending) => pending.from === Number(request.targetUin));
          let inverseAccepted = false;
          let requestResult;
          if (inversePending) {
            const result = store.acceptFriend(state.uin, request.targetUin);
            inverseAccepted = result.ok;
            requestResult = result.ok
              ? { ok: true, alreadyFriends: true, acceptedRequest: true } : result;
          } else {
            requestResult = [0, 3].includes(request.action)
              ? store.requestFriend(state.uin, request.targetUin, '')
              : { ok: false, reason: 'unsupported_action' };
          }
          const virtualPolicy = requestedAccount && requestedAccount.type === 'virtual'
            ? requestedAccount.virtual.friendPolicy : null;
          const policyAccepted = requestResult.ok && virtualPolicy
            && ['auto', 'delayed'].includes(virtualPolicy);
          const accepted = requestResult.ok
            && (inverseAccepted || policyAccepted || requestResult.alreadyFriends);
          // Result zero means that the operation was accepted by the server;
          // it does not mean a human recipient has approved the relationship.
          const responseResult = requestResult.ok && virtualPolicy !== 'deny' ? 0 : 1;
          if (requestResult.ok && virtualPolicy === 'deny' && !requestResult.alreadyFriends) {
            store.rejectFriend(request.targetUin, state.uin);
          }
          const completionDelay = policyAccepted && virtualPolicy === 'delayed'
            ? Math.max(1500, Math.min(30000, requestedAccount.virtual.replyDelayMinMs || 5000))
            : settings.friendPushDelayMs;
          setTimeout(() => {
            if (policyAccepted && !requestResult.alreadyFriends) {
              store.acceptFriend(request.targetUin, state.uin);
            }
            if (!socket.destroyed) {
              socket.write(protocol.createFrame({
                command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 0,
                payload: protocol.encryptPayload(protocol.buildFriendResultPayload(
                  request.action, request.targetUin, responseResult,
                  responseResult ? 'Request was not accepted' : ''), state.sessionKey),
              }));
              if (accepted && requestedAccount) {
                state.pushSequence = (state.pushSequence + 1) & 0xFFFF;
                socket.write(protocol.createFrame({
                  command: protocol.COMMAND_USER_PROFILE,
                  sequence: state.pushSequence,
                  uin: state.uin,
                  status: 0,
                  payload: protocol.encryptPayload(
                    protocol.buildUserProfilePayload(requestedAccount, 2), state.sessionKey),
                }));
              }
            }
            const targetSession = sessions.get(request.targetUin);
            if (accepted && targetSession && targetSession.loggedIn
                && !targetSession.socket.destroyed) {
              targetSession.pushSequence = (targetSession.pushSequence + 1) & 0xFFFF;
              targetSession.socket.write(protocol.createFrame({
                command: protocol.COMMAND_FRIEND_RESULT,
                sequence: targetSession.pushSequence,
                uin: targetSession.uin,
                status: 0,
                payload: protocol.encryptPayload(protocol.buildFriendResultPayload(
                  request.action, state.uin, 0), targetSession.sessionKey),
              }));
              targetSession.pushSequence = (targetSession.pushSequence + 1) & 0xFFFF;
              targetSession.socket.write(protocol.createFrame({
                command: protocol.COMMAND_USER_PROFILE,
                sequence: targetSession.pushSequence,
                uin: targetSession.uin,
                status: 0,
                payload: protocol.encryptPayload(
                  protocol.buildUserProfilePayload(state.account, 2), targetSession.sessionKey),
                }));
            }
            if (responseResult === 0 && !accepted && requestedAccount) {
              pushFriendRequestNotification(
                request.targetUin, state.uin, '', 'live_request');
            }
            settings.logger({
              event: 'friend_result_action_ok', peer, uin: state.uin,
              targetUin: request.targetUin, action: request.action,
              accepted, pending: responseResult === 0 && !accepted,
              inverseAccepted, policy: virtualPolicy || 'human-approval',
              command: '0x0093', sequence: frame.sequence, result: responseResult,
            });
          }, completionDelay);
          continue;
        }

        if (frame.command === protocol.COMMAND_FRIEND_ACTION && state.loggedIn) {
          let friendPlain;
          try {
            friendPlain = protocol.decryptPayload(frame.payload, state.sessionKey);
          } catch (error) {
            settings.logger({
              event: 'friend_action_rejected', peer, uin: state.uin,
              message: error.message, stage: 'decrypt',
            });
            socket.write(protocol.createFrame({
              command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 1,
            }));
            continue;
          }

          // Command 0x006B is multiplexed. Only subtype 1 packets long enough
          // to contain a target UIN are friend-add requests; the client also
          // sends short status/housekeeping forms. Treating those forms as a
          // failed add request creates a bogus friend-validation notification.
          if (friendPlain.length < 9 || friendPlain[0] !== 1) {
            const subtype = friendPlain.length > 0 ? friendPlain[0] : 0;
            socket.write(protocol.createFrame({
              command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 0,
              payload: protocol.encryptPayload(
                protocol.buildFriendServiceAck(subtype), state.sessionKey),
            }));
            settings.logger({
              event: 'friend_service_ok', peer, uin: state.uin,
              subtype, requestHex: friendPlain.toString('hex'),
            });
            continue;
          }

          let request;
          try {
            request = protocol.parseFriendActionPayload(friendPlain);
          } catch (error) {
            settings.logger({
              event: 'friend_action_rejected', peer, uin: state.uin,
              message: error.message, requestHex: friendPlain.toString('hex'),
            });
            socket.write(protocol.createFrame({
              command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 0,
              payload: protocol.encryptPayload(protocol.buildFriendActionAck(1, 1), state.sessionKey),
            }));
            continue;
          }
          const requestedAccount = store.get(request.targetUin);
          const inversePending = state.account.incomingRequests.some(
            (pending) => pending.from === Number(request.targetUin));
          let inverseAccepted = false;
          let result;
          if (inversePending) {
            const acceptedRequest = store.acceptFriend(state.uin, request.targetUin);
            inverseAccepted = acceptedRequest.ok;
            result = acceptedRequest.ok
              ? { ok: true, alreadyFriends: true, acceptedRequest: true } : acceptedRequest;
          } else {
            result = store.requestFriend(state.uin, request.targetUin, request.message);
          }
          const virtualPolicy = requestedAccount && requestedAccount.type === 'virtual'
            ? requestedAccount.virtual.friendPolicy : null;
          const autoAccepted = result.ok && virtualPolicy === 'auto';
          const delayedAccepted = result.ok && !result.alreadyFriends && virtualPolicy === 'delayed';
          const accepted = result.ok
            && (inverseAccepted || autoAccepted || result.alreadyFriends);
          let acknowledgementResult = result.ok ? 0 : 1;
          if (result.ok && virtualPolicy === 'deny' && !result.alreadyFriends) {
            store.rejectFriend(request.targetUin, state.uin);
            acknowledgementResult = 1;
          }
          if (autoAccepted && !result.alreadyFriends) {
            store.acceptFriend(request.targetUin, state.uin);
          }
          socket.write(protocol.createFrame({
            command: frame.command, sequence: frame.sequence, uin: frame.uin,
            status: 0,
            payload: protocol.encryptPayload(
              protocol.buildFriendActionAck(acknowledgementResult, request.subtype), state.sessionKey),
          }));
          settings.logger({
            event: 'friend_action_ok', peer, uin: state.uin,
            targetUin: request.targetUin, accepted,
            pending: result.ok && !accepted && !delayedAccepted,
            inverseAccepted, delayed: delayedAccepted,
            policy: virtualPolicy || 'human-approval',
            subtype: request.subtype, action: request.action,
          });
          if (accepted || delayedAccepted) {
            const acceptanceDelay = delayedAccepted
              ? Math.max(1500, Math.min(30000, requestedAccount.virtual.replyDelayMinMs || 5000))
              : settings.friendPushDelayMs;
            setTimeout(() => {
              if (delayedAccepted) store.acceptFriend(request.targetUin, state.uin);
              const pairs = [
                { session: state, account: store.get(request.targetUin) },
                { session: sessions.get(request.targetUin), account: state.account },
              ];
              for (const pair of pairs) {
                if (!pair.session || !pair.account || pair.session.socket.destroyed) continue;
                pair.session.pushSequence = (pair.session.pushSequence + 1) & 0xFFFF;
                pair.session.socket.write(protocol.createFrame({
                  command: protocol.COMMAND_FRIEND_RESULT,
                  sequence: pair.session.pushSequence,
                  uin: pair.session.uin,
                  status: 0,
                  payload: protocol.encryptPayload(
                    protocol.buildFriendResultPayload(request.action, pair.account.uin, 0),
                    pair.session.sessionKey),
                }));
                settings.logger({
                  event: 'friend_result_pushed', uin: pair.session.uin,
                  friendUin: pair.account.uin, action: request.action,
                });
                pair.session.pushSequence = (pair.session.pushSequence + 1) & 0xFFFF;
                pair.session.socket.write(protocol.createFrame({
                  command: protocol.COMMAND_USER_PROFILE,
                  sequence: pair.session.pushSequence,
                  uin: pair.session.uin,
                  status: 0,
                  payload: protocol.encryptPayload(
                    protocol.buildUserProfilePayload(pair.account, 2), pair.session.sessionKey),
                }));
                settings.logger({
                  event: 'friend_profile_pushed', uin: pair.session.uin, friendUin: pair.account.uin,
                });
              }
            }, acceptanceDelay);
          } else if (result.ok && virtualPolicy !== 'deny') {
            pushFriendRequestNotification(
              request.targetUin, state.uin, request.message, 'live_request');
          }
          continue;
        }

        if (frame.command === protocol.COMMAND_GROUP_SYNC && state.loggedIn) {
          const request = protocol.decryptPayload(frame.payload, state.sessionKey);
          let receiveState = null;
          let receiveStateApplied = false;
          if (state.clientFamily !== 'symbian_s60') {
            receiveState = parseGroupReceiveState(request);
            const validEntries = receiveState.entries.filter((entry) => entry.groupId !== 0);
            if (validEntries.length > 0) {
              state.groupReceiveFilter = normalizeGroupReceiveFilter(
                validEntries.filter((entry) => entry.receive).map((entry) => entry.groupId));
              state.groupReceiveStateReady = true;
              receiveStateApplied = true;
              settings.logger({
                event: 'group_receive_state_ok', peer, uin: state.uin,
                declaredCount: receiveState.declaredCount,
                validCount: validEntries.length,
                enabledCount: validEntries.filter((entry) => entry.receive).length,
                complete: receiveState.complete,
                enabledGroupIds: validEntries.filter((entry) => entry.receive)
                  .map((entry) => entry.groupId),
              });
            }
          }
          writeEncrypted(state, frame.command, frame.sequence, Buffer.alloc(0));
          settings.logger({
            event: 'group_sync_ok', peer, uin: state.uin,
            groups: store.groupsOf(state.uin).map((group) => group.id),
            receiveStateApplied,
            requestHex: settings.traceProtocol && request ? request.toString('hex') : undefined,
          });
          continue;
        }

        // J2ME 与 QQ2013 在收到 0x0054 的 relationType=4 群占位后，都会主动
        // 请求 0x00A4 群映射（内部 ID -> 公开群号）。复活计划只实现了服务端
        // 推送、没有处理客户端请求，导致客户端卡在"刷新好友列表"。
        // 这里按推送同款格式回复全部群的映射。
        if (frame.command === protocol.COMMAND_GROUP_MAPPING && state.loggedIn) {
          const groups = store.groupsOf(state.uin);
          const requestPlain = protocol.decryptPayload(frame.payload, state.sessionKey);
          // QQ2013(Symbian) 的 0x00A4 解码器吃不下大映射，实机会直接崩溃；
          // 它本来也不靠 0x00A4 显示群（走 WUP 讨论组），所以只回空映射。
          const mappingGroups = state.clientFamily === 'symbian_s60' ? [] : groups;
          writeEncrypted(state, frame.command, frame.sequence,
            protocol.buildGroupMappingPayload(mappingGroups));
          settings.logger({
            event: 'group_mapping_request_ok', peer, uin: frame.uin,
            count: mappingGroups.length, totalGroups: groups.length,
            clientFamily: state.clientFamily,
            requestHex: settings.traceProtocol && requestPlain
              ? requestPlain.toString('hex') : undefined,
          });
          continue;
        }

        // 客户端 0x008C：上报"接收中的群"订阅清单（腾讯服务器据此只推清单内
        // 的群，屏蔽群 = 清单里去掉该群）。解析后按会话过滤 0x0094 推送。
        if (frame.command === protocol.COMMAND_GROUP_RECEIVE_FILTER && state.loggedIn) {
          const requestPlain = protocol.decryptPayload(frame.payload, state.sessionKey);
          const groups = requestPlain ? parseGroupReceiveFilter(requestPlain) : [];
          state.groupReceiveFilter = normalizeGroupReceiveFilter(groups);
          state.groupReceiveStateReady = true;
          // 0x008C 响应：[结果 0][条数 0]
          writeEncrypted(state, frame.command, frame.sequence, Buffer.from([0, 0]));
          settings.logger({
            event: 'group_receive_filter_ok', peer, uin: frame.uin,
            count: groups.length, groupIds: groups,
            plainHex: settings.traceProtocol && requestPlain
              ? requestPlain.toString('hex') : undefined,
          });
          continue;
        }

        if (frame.command === protocol.COMMAND_GROUP_SERVICE && state.loggedIn) {
          let request;
          const requestPlain = protocol.decryptPayload(frame.payload, state.sessionKey);
          try {
            request = protocol.parseGroupServiceRequest(requestPlain);
          } catch (error) {
            socket.write(protocol.createFrame({
              command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 1,
            }));
            settings.logger({
              event: 'group_service_rejected', peer, uin: state.uin, message: error.message,
              requestHex: settings.traceProtocol && requestPlain
                ? requestPlain.toString('hex') : undefined,
            });
            continue;
          }
          const group = request.groupId == null ? null : store.getGroup(request.groupId);
          const isMember = group && group.members.some((member) => member.uin === state.uin);
          let result = isMember ? 0 : 1;
          let plain;
          let responseProfile = 'ack';
          let probeMatched = false;
          const nativeSymbian = state.clientFamily === 'symbian_s60'
            && settings.symbianGroupInfoProfile !== 'legacy';
          const symbianBootstrap = request.subtype === 0x72
            && state.clientFamily === 'symbian_s60';
          if ((request.subtype === 4 || symbianBootstrap) && isMember) {
            if (symbianBootstrap) {
              plain = protocol.buildSymbianGroupMemberPayload(group);
              responseProfile = 's60_qq2013_0x72_profile';
            } else {
              plain = nativeSymbian
                ? protocol.buildSymbianGroupInfoPayload(group)
                : protocol.buildGroupInfoPayload(group);
              responseProfile = nativeSymbian ? 's60_qq2013' : 'legacy';
            }
            probeMatched = state.symbianGroupProbeActive
              && (state.symbianGroupProbeIds.has(Number(group.id))
                || state.symbianGroupProbeIds.has(Number(group.publicId || group.id)));
            const firstResponse = !state.symbianGroupInfoServedIds.has(Number(group.id));
            state.symbianGroupInfoServedIds.add(Number(group.id));
            state.symbianGroupInfoServedIds.add(Number(group.publicId || group.id));
            state.advertisedGroupIds.add(Number(group.id));
            state.advertisedGroupIds.add(Number(group.publicId || group.id));
            if (symbianBootstrap) {
              state.symbianGroupProbeValidated = true;
              const awaitingId = Number(state.symbianGroupAwaitingId || 0);
              if (awaitingId === Number(group.id)
                  || awaitingId === Number(group.publicId || group.id)) {
                state.symbianGroupAwaitingId = 0;
              }
            }
            state.announcedGroupIds.add(Number(group.id));
            state.announcedGroupIds.add(Number(group.publicId || group.id));
            if (state.clientFamily === 'symbian_s60' && firstResponse) {
              settings.logger({
                event: probeMatched
                  ? 'symbian_group_probe_hit' : 'symbian_group_info_requested',
                peer, uin: state.uin,
                groupId: Number(group.id), publicId: Number(group.publicId || group.id),
                title: group.title, probeMatched, responseProfile,
                messageDeliveryEnabled: true,
                requestHex: settings.traceProtocol && requestPlain
                  ? requestPlain.toString('hex') : undefined,
                responseBytes: plain.length,
                responseHex: settings.traceProtocol ? plain.toString('hex') : undefined,
              });
            }
            if (state.clientFamily === 'symbian_s60'
                && state.friendRosterSyncComplete
                && (symbianBootstrap || request.subtype === 4)) {
              queueSymbianGroupDiscovery(state, null,
                symbianBootstrap ? 'symbian_group_0x72_ack' : 'symbian_group_info_ack',
                settings.symbianGroupDiscoveryIntervalMs || 250);
            }
          } else if (request.subtype === 26 && isMember && request.text) {
            const saved = store.saveGroupMessage(group.id, state.uin, request.text);
            plain = protocol.buildGroupServiceAck(request.subtype, 0);
            let delivery = { delivered: 0 };
            if (settings.remoteSender && settings.remoteSender.sendGroup) {
              settings.remoteSender.sendGroup(state.uin, group.id, request.text)
                .catch((error) => {
                  settings.logger({ event: 'remote_send_error', peer, from: state.uin,
                    groupId: group.id, message: error.message });
                });
              delivery = { delivered: 1, transport: 'napcat' };
            } else if (settings.deliverGroup) {
              delivery = settings.deliverGroup(group.id, state.uin, request.text);
            }
            settings.logger({
              event: 'group_message_sent', peer, messageId: saved.id,
              groupId: group.id, from: state.uin, text: request.text,
              authorized: true, transport: '0x006d/26', delivery,
            });
          } else if (request.subtype === 2 && isMember && request.action === 2) {
            for (const memberUin of request.memberUins) {
              const invited = store.inviteGroupMember(group.id, state.uin, memberUin);
              if (!invited.ok) result = 1;
              if (invited.ok && !invited.alreadyMember) {
                const invitedSession = sessions.get(Number(memberUin));
                if (invitedSession) pushGroupDiscovery(invitedSession, [group], 'invited');
              }
            }
            plain = protocol.buildGroupServiceAck(request.subtype, result);
          } else {
            // Other maintenance subtypes are acknowledged so their modal UI
            // does not stall, without mutating group membership speculatively.
            plain = protocol.buildGroupServiceAck(request.subtype, result);
          }
          writeEncrypted(state, frame.command, frame.sequence, plain);
          settings.logger({
            event: 'group_service_ok', peer, uin: state.uin,
            subtype: request.subtype, groupId: request.groupId,
            cursor: request.cursor, action: request.action,
            memberUins: request.memberUins, result,
            responseProfile, probeMatched,
            requestHex: settings.traceProtocol && requestPlain
              ? requestPlain.toString('hex') : undefined,
            responseBytes: plain ? plain.length : 0,
            responseHex: settings.traceProtocol && plain
              ? plain.toString('hex') : undefined,
          });
          continue;
        }

        if (frame.command === protocol.COMMAND_GROUP_SEND && state.loggedIn
            && settings.mediaService) {
          const requestPlain = protocol.decryptPayload(frame.payload, state.sessionKey);
          if (requestPlain && settings.mediaService.isNegotiation(state.uin, requestPlain)) {
            try {
              const request = mediaProtocol.parseNegotiation(requestPlain);
              const plain = request.subtype === 6
                ? settings.mediaService.issueTicket(state.uin, request).payload
                : settings.mediaService.register(state.uin, request, socket.localAddress);
              writeEncrypted(state, frame.command, frame.sequence, plain);
              settings.logger({
                event: request.subtype === 6 ? 'media_ticket_issued' : 'media_upload_registered',
                peer, uin: state.uin, targetUin: request.targetUin,
                filename: request.filename, bytes: request.size,
              });
            } catch (error) {
              socket.write(protocol.createFrame({
                command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 1,
              }));
              settings.logger({ event: 'media_negotiation_rejected', peer, uin: state.uin,
                message: error.message });
            }
            continue;
          }
        }

        if (frame.command === protocol.COMMAND_GROUP_SEND && state.loggedIn) {
          let message;
          let rejectedPlain = null;
          try {
            rejectedPlain = protocol.decryptPayload(frame.payload, state.sessionKey);
            // 客户端登录时会通过 0x0090 subtype=3 上报群消息接收设置
            // （典型载荷 0305000000000004）。以前被当成普通群消息拒绝，
            // 导致"不接受群消息"设置从未生效。这里正确应答并记录设置。
            if (rejectedPlain && rejectedPlain.length >= 1 && rejectedPlain[0] === 0x03) {
              state.groupMessageSettings = {
                subtype: rejectedPlain[0],
                mode: rejectedPlain.length >= 2 ? rejectedPlain[1] : null,
                tail: rejectedPlain.length >= 8 ? rejectedPlain[7] : null,
              };
              writeEncrypted(state, frame.command, frame.sequence, Buffer.alloc(0));
              settings.logger({
                event: 'group_message_settings_ok', peer, uin: frame.uin,
                settings: state.groupMessageSettings,
                plainHex: settings.traceProtocol ? rejectedPlain.toString('hex') : undefined,
              });
              continue;
            }
            message = protocol.parseGroupSendPayload(rejectedPlain);
          } catch (error) {
            socket.write(protocol.createFrame({
              command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 1,
            }));
            settings.logger({
              event: 'group_message_rejected', peer, uin: state.uin, message: error.message,
              plainBytes: rejectedPlain ? rejectedPlain.length : null,
              plainHex: settings.traceProtocol && rejectedPlain
                ? rejectedPlain.toString('hex') : undefined,
            });
            continue;
          }
          const group = store.getGroup(message.groupId);
          const authorized = Boolean(group
            && group.members.some((member) => member.uin === state.uin));
          let saved = null;
          if (authorized) saved = store.saveGroupMessage(group.id, state.uin, message.text);
          writeEncrypted(state, frame.command, frame.sequence, Buffer.alloc(0), authorized ? 0 : 1);
          let delivery = { delivered: 0, virtualQueued: 0 };
          if (authorized && settings.remoteSender && settings.remoteSender.sendGroup) {
            settings.remoteSender.sendGroup(state.uin, group ? group.id : message.groupId, message.text)
              .catch((error) => {
                settings.logger({ event: 'remote_send_error', peer, from: state.uin,
                  groupId: group ? group.id : message.groupId, message: error.message });
              });
            delivery = { delivered: 1, virtualQueued: 0, transport: 'napcat' };
          } else if (authorized && settings.deliverGroup) {
            delivery = settings.deliverGroup(group.id, state.uin, message.text) || delivery;
          }
          settings.logger({
            event: 'group_message_sent', peer, messageId: saved && saved.id,
            groupId: group ? group.id : message.groupId, from: state.uin,
            text: message.text, authorized, delivery,
          });
          continue;
        }

        if (frame.command === protocol.COMMAND_SEND_TEXT && state.loggedIn) {
          let message;
          try {
            message = protocol.parseSendTextPayload(
              protocol.decryptPayload(frame.payload, state.sessionKey));
          } catch (error) {
            settings.logger({ event: 'message_rejected', peer, uin: state.uin, message: error.message });
            continue;
          }
          const friendUins = store.friendsOf(state.uin).map((friend) => friend.uin);
          const authorized = friendUins.includes(message.targetUin);
          const targetAccount = store.get(message.targetUin);
          const target = sessions.get(message.targetUin);
          if (authorized) store.saveMessage(state.uin, message.targetUin, message.text);
          socket.write(protocol.createFrame({
            command: frame.command, sequence: frame.sequence, uin: frame.uin,
            status: authorized ? 0 : 1,
            payload: authorized ? protocol.encryptPayload(Buffer.alloc(0), state.sessionKey) : Buffer.alloc(0),
          }));
          if (settings.remoteSender && settings.remoteSender.sendPrivate) {
            if (authorized) {
              settings.remoteSender.sendPrivate(state.uin, message.targetUin, message.text)
                .catch((error) => {
                  settings.logger({ event: 'remote_send_error', peer, from: state.uin,
                    to: message.targetUin, message: error.message });
                });
            }
            settings.logger({
              event: 'message_sent', peer, from: state.uin, to: message.targetUin,
              text: message.text, authorized, delivered: authorized, queuedOffline: false,
              transport: 'napcat',
            });
            continue;
          }
          let delivered = false;
          if (authorized && targetAccount && targetAccount.type === 'virtual' && settings.virtualRuntime) {
            delivered = settings.virtualRuntime.receive(message.targetUin, state.uin);
          } else if (authorized && target && target.loggedIn && !target.socket.destroyed) {
            target.pushSequence = (target.pushSequence + 1) & 0xFFFF;
            target.socket.write(protocol.createFrame({
              command: protocol.COMMAND_INCOMING_TEXT,
              sequence: target.pushSequence,
              uin: target.uin,
              status: 0,
              payload: protocol.encryptPayload(
                protocol.buildIncomingTextPayload(state.uin, message.text), target.sessionKey),
            }));
            delivered = true;
          }
          const queuedOffline = authorized && targetAccount
            && targetAccount.type !== 'virtual' && !delivered;
          if (queuedOffline) {
            store.enqueueOutbox(state.uin, message.targetUin, message.text);
          }
          settings.logger({
            event: 'message_sent', peer, from: state.uin, to: message.targetUin,
            text: message.text, authorized, delivered, queuedOffline,
          });
          continue;
        }

        if (frame.command === protocol.COMMAND_EXTENDED_SERVICE && state.loggedIn) {
          const request = protocol.decryptPayload(frame.payload, state.sessionKey);
          const subtype = request && request.length >= 1 ? request[0] : 0;
          const plain = protocol.buildExtendedServicePayload(subtype, state.uin);
          socket.write(protocol.createFrame({
            command: frame.command,
            sequence: frame.sequence,
            uin: frame.uin,
            status: 0,
            payload: protocol.encryptPayload(plain, state.sessionKey),
          }));
          settings.logger({
            event: 'extended_service_ok', peer, uin: frame.uin, subtype,
            requestHex: settings.traceProtocol && request ? request.toString('hex') : undefined,
            responseBytes: plain.length,
          });
          continue;
        }

        if (frame.command === protocol.COMMAND_MEDIA_NOTIFY && state.loggedIn
            && settings.mediaService) {
          try {
            const requestPlain = protocol.decryptPayload(frame.payload, state.sessionKey);
            if (!requestPlain) throw new Error('QQ-TEA decryption failed');
            const request = mediaProtocol.parseServiceEnvelope(requestPlain);
            if (request.subtype === 1) {
              settings.mediaService.announce(state.uin, request, () => {
                writeEncrypted(state, protocol.COMMAND_MEDIA_TRANSFER, frame.sequence,
                  mediaProtocol.buildServiceResult(request.targetUin, 3, request.hash));
              });
              writeEncrypted(state, protocol.COMMAND_MEDIA_TRANSFER, frame.sequence,
                mediaProtocol.buildServiceResult(request.targetUin, 2, request.hash, 1));
            } else {
              writeEncrypted(state, protocol.COMMAND_MEDIA_TRANSFER, frame.sequence,
                mediaProtocol.buildServiceResult(request.targetUin, 2,
                  request.hash || Buffer.alloc(0), 1));
            }
            settings.logger({ event: 'media_announcement_received', peer, uin: state.uin,
              targetUin: request.targetUin, subtype: request.subtype,
              mediaType: request.mediaType, filename: request.filename });
          } catch (error) {
            socket.write(protocol.createFrame({
              command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 1,
            }));
            settings.logger({ event: 'media_announcement_rejected', peer, uin: state.uin,
              message: error.message });
          }
          continue;
        }

        if (frame.command === protocol.COMMAND_MEDIA_COMPLETION && state.loggedIn
            && settings.mediaService) {
          // Upload completion is finalized by the HTTP Range response and the
          // deferred 0x00B5 acknowledgement. This auxiliary packet is safe to
          // acknowledge even though its legacy wrapper carries no new bytes.
          writeEncrypted(state, frame.command, frame.sequence, Buffer.alloc(0));
          settings.logger({ event: 'media_completion_aux_ack', peer, uin: state.uin });
          continue;
        }

        if (frame.command === protocol.COMMAND_MEDIA_TRANSFER && state.loggedIn) {
          const requestPlain = protocol.decryptPayload(frame.payload, state.sessionKey);
          if (!requestPlain) {
            socket.write(protocol.createFrame({
              command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 1,
            }));
            settings.logger({ event: 'media_announcement_rejected', peer, uin: state.uin,
              command: '0x0065', message: 'QQ-TEA decryption failed' });
            continue;
          }
          try {
            const request = mediaProtocol.parseServiceEnvelope(requestPlain);
            if (!settings.mediaService) throw new Error('media service is unavailable');
            if (request.subtype === 1) {
              settings.mediaService.announce(state.uin, request, () => {
                writeEncrypted(state, protocol.COMMAND_MEDIA_TRANSFER, frame.sequence,
                  mediaProtocol.buildServiceResult(request.targetUin, 3, request.hash));
              });
              // The phone waits for this acceptance before it starts or keeps
              // the HTTP uploader alive. Completion is sent separately above.
              writeEncrypted(state, protocol.COMMAND_MEDIA_TRANSFER, frame.sequence,
                mediaProtocol.buildServiceResult(request.targetUin, 2, request.hash, 1));
            } else {
              writeEncrypted(state, protocol.COMMAND_MEDIA_TRANSFER, frame.sequence,
                mediaProtocol.buildServiceResult(request.targetUin, 2,
                  request.hash || Buffer.alloc(0), 1));
            }
            settings.logger({ event: 'media_announcement_received', peer, uin: state.uin,
              command: '0x0065', targetUin: request.targetUin, subtype: request.subtype,
              layout: request.layout, mediaType: request.mediaType, filename: request.filename });
          } catch (error) {
            // 0x0065 also carries unrelated online-picture maintenance
            // packets. Preserve their old non-blocking acknowledgement.
            const peerUin = requestPlain.length >= 16 ? requestPlain.readUInt32BE(12)
              : requestPlain.length >= 10 ? requestPlain.readUInt32BE(6) : 0;
            writeEncrypted(state, frame.command, frame.sequence,
              mediaProtocol.buildOnlinePictureAck(peerUin));
            settings.logger({
              event: 'media_signaling_acknowledged', peer, uin: state.uin,
              command: '0x0065', plainBytes: requestPlain.length,
              fallbackReason: error.message,
              requestHex: settings.traceProtocol ? requestPlain.toString('hex') : undefined,
            });
          }
          continue;
        }

        if (frame.command === symbian.COMMAND_MESSAGE_ACCOST && state.loggedIn) {
          state.clientFamily = 'symbian_s60';
          try {
            const requestPlain = protocol.decryptPayload(frame.payload, state.sessionKey);
            if (!requestPlain) throw new Error('QQ-TEA decryption failed');
            const envelope = symbian.parseAccostEnvelope(requestPlain);
            const response = symbian.createAccostResponse(envelope);
            socket.write(protocol.createFrame({
              command: frame.command,
              sequence: frame.sequence,
              uin: frame.uin,
              status: 0,
              payload: protocol.encryptPayload(response.payload, state.sessionKey),
            }));
            settings.logger({
              event: 'symbian_accost_ok', peer, uin: state.uin,
              servant: envelope.request.servant,
              functionName: envelope.request.functionName,
              requestId: envelope.request.requestId,
              responseKind: response.kind,
              parameterNames: response.parameterNames,
            });
          } catch (error) {
            socket.write(protocol.createFrame({
              command: frame.command,
              sequence: frame.sequence,
              uin: frame.uin,
              status: 1,
            }));
            settings.logger({
              event: 'symbian_accost_rejected', peer, uin: state.uin,
              message: error.message,
            });
          }
          continue;
        }

        if (frame.command === symbian.COMMAND_WUP && state.loggedIn) {
          state.clientFamily = 'symbian_s60';
          try {
            const requestPlain = protocol.decryptPayload(frame.payload, state.sessionKey);
            if (!requestPlain) throw new Error('QQ-TEA decryption failed');
            const envelope = symbian.parseWupEnvelope(requestPlain);
            const response = symbian.createWupResponse(envelope, {
              // QQServiceDiscussSvc is a real discussion-session API, not the
              // permanent-Qun list.  Mirroring NapCat Quns through it creates
              // the wrong native object type; permanent groups arrive through
              // relationType=4 followed by the 0x006D/0x72 member/profile stage.
              getDiscussions: () => store.groupsOf(state.uin)
                .filter((group) => group.type === 'discussion')
                .slice(0, Math.max(0, Math.min(100,
                  Number(settings.symbianDiscussionListLimit || 60)))),
              getDiscussion: (groupId) => {
                const group = store.getGroup(groupId);
                return group && group.type === 'discussion'
                  && group.members.some((member) => member.uin === state.uin) ? group : null;
              },
              createDiscussion: (details) => {
                const memberUins = details.memberUins.filter((uin) => uin !== state.uin
                  && Boolean(store.get(uin)));
                return store.createGroup({
                  ownerUin: state.uin,
                  memberUins,
                  type: 'discussion',
                  title: details.title || `${state.account.nickname}的讨论组`,
                });
              },
            });
            socket.write(protocol.createFrame({
              command: frame.command,
              sequence: frame.sequence,
              uin: frame.uin,
              status: 0,
              payload: protocol.encryptPayload(response.payload, state.sessionKey),
            }));
            settings.logger({
              event: 'symbian_wup_ok', peer, uin: state.uin,
              route: envelope.route,
              servant: envelope.request.servant,
              functionName: envelope.request.functionName,
              requestId: envelope.request.requestId,
              responseKind: response.kind,
              groupId: response.group ? response.group.id : undefined,
              requestParameterNames: [...envelope.request.parameters.keys()],
              parameterNames: response.parameterNames,
              requestHex: settings.traceProtocol ? requestPlain.toString('hex') : undefined,
              responseHex: settings.traceProtocol ? response.payload.toString('hex') : undefined,
              suffixHex: settings.traceProtocol && envelope.suffix.length
                ? envelope.suffix.toString('hex') : undefined,
            });
          } catch (error) {
            socket.write(protocol.createFrame({
              command: frame.command,
              sequence: frame.sequence,
              uin: frame.uin,
              status: 1,
            }));
            settings.logger({
              event: 'symbian_wup_rejected', peer, uin: state.uin,
              message: error.message,
            });
          }
          continue;
        }

        if (frame.command === symbian.COMMAND_AUXILIARY_PRESENCE && state.loggedIn) {
          state.clientFamily = 'symbian_s60';
          try {
            const plain = protocol.decryptPayload(frame.payload, state.sessionKey);
            const request = symbian.parseAuxiliaryPresenceRequest(plain);
            if (request.action === 'subscribe') {
              state.auxiliaryPresenceSubscriptions.add(request.targetUin);
            } else {
              state.auxiliaryPresenceSubscriptions.delete(request.targetUin);
            }
            // Captures show this command as a one-way subscription update. A
            // fabricated response payload is riskier than consuming it and
            // delivering actual presence changes through the established
            // buddy-detail push command.
            settings.logger({
              event: 'symbian_auxiliary_presence_ok', peer, uin: state.uin,
              action: request.action, targetUin: request.targetUin, flag: request.flag,
            });
          } catch (error) {
            settings.logger({
              event: 'symbian_auxiliary_presence_rejected', peer, uin: state.uin,
              message: error.message,
            });
          }
          continue;
        }

        if (frame.command === symbian.COMMAND_BUDDY_STATUS && state.loggedIn) {
          state.clientFamily = 'symbian_s60';
          state.symbianBuddyStatusDiscoveryActive = true;
          const requestPlain = protocol.decryptPayload(frame.payload, state.sessionKey);
          let request;
          try {
            request = symbian.parseBuddyStatusRequest(requestPlain);
          } catch (error) {
            socket.write(protocol.createFrame({
              command: frame.command, sequence: frame.sequence, uin: frame.uin, status: 1,
            }));
            settings.logger({
              event: 'symbian_buddy_status_rejected', peer, uin: state.uin,
              message: error.message,
            });
            continue;
          }
          const friends = store.friendsOf(state.uin);
          const allGroups = store.groupsOf(state.uin);
          // Real-device verification showed that an unsolicited 0x0054
          // relation can update an existing group but cannot create another
          // CQQGroup object. Every permanent group must therefore appear in
          // the client-requested 0x00AF GetNewList stream during login.
          // Keep the configured probe first so the known-good group remains
          // the first one initialized, then append the rest without duplicates.
          const probeGroups = selectSymbianProbeGroups(
            state, allGroups, 'symbian_buddy_status');
          const leadingIds = new Set(probeGroups.map((group) => Number(group.id)));
          const relationGroups = probeGroups.concat(allGroups.filter(
            (group) => !leadingIds.has(Number(group.id))));
          const relations = friends.map((friend) => ({
            uin: friend.uin,
            kind: 1,
            groups: [0],
          }));
          for (const group of relationGroups) {
            relations.push({
              uin: group.id,
              kind: 4,
              groups: [],
              group,
            });
          }
          const requestedPageSize = Math.max(1, Math.min(request.pageSize || 200, 200));
          // Do not mix the final friend records with a large group burst. Once
          // the friend portion ends, cap every group-only page to the same
          // conservative batch setting used by discovery (10 by default).
          // QQ2013 advances its 0x00AF cursor by the returned record count.
          const groupPageSize = Math.max(1, Math.min(25,
            Number(settings.symbianGroupDiscoveryBatchSize || 10)));
          const pageSize = request.cursor < friends.length
            ? Math.min(requestedPageSize, friends.length - request.cursor)
            : Math.min(requestedPageSize, groupPageSize);
          const page = relations.slice(request.cursor, request.cursor + pageSize);
          const finalPage = request.cursor + page.length >= relations.length;
          const pageGroups = page.filter((entry) => entry.kind === 4).map((entry) => entry.group);
          for (const group of pageGroups) {
            state.announcedGroupIds.add(Number(group.id));
            state.announcedGroupIds.add(Number(group.publicId || group.id));
          }
          const plain = symbian.buildBuddyStatusResponse(page, {
            cursor: request.cursor,
            finalPage,
          });
          socket.write(protocol.createFrame({
            command: frame.command,
            sequence: frame.sequence,
            uin: frame.uin,
            status: 0,
            payload: protocol.encryptPayload(plain, state.sessionKey),
          }));
          settings.logger({
            event: 'symbian_buddy_status_ok', peer, uin: state.uin,
            result: plain[0], terminal: finalPage, count: page.length,
            cursor: request.cursor, nextCursor: request.cursor + page.length,
            totalRelations: relations.length,
            pagePhase: request.cursor < friends.length ? 'friends' : 'groups',
            pageLimit: pageSize,
            friendCount: page.length - pageGroups.length,
            groupCount: pageGroups.length,
            friendUins: page.filter((entry) => entry.kind === 1).map((entry) => entry.uin),
            groupIds: pageGroups.map((group) => Number(group.id)),
            requestHex: settings.traceProtocol ? requestPlain.toString('hex') : undefined,
          });
          continue;
        }

        const unimplementedPlain = state.sessionKey
          ? protocol.decryptPayload(frame.payload, state.sessionKey) : null;
        settings.logger({
          event: 'unimplemented_command', peer, uin: frame.uin,
          command: '0x' + frame.command.toString(16).padStart(4, '0'),
          encryptedBytes: frame.payload.length, loggedIn: state.loggedIn,
          plainBytes: unimplementedPlain ? unimplementedPlain.length : null,
          plainHex: settings.traceProtocol && unimplementedPlain
            ? unimplementedPlain.toString('hex') : undefined,
        });
      }
    });

    socket.on('error', (error) => {
      settings.logger({ event: 'socket_error', peer, message: error.message });
    });
    socket.on('close', () => {
      sockets.delete(socket);
      if (state.groupDiscoveryTimer) clearTimeout(state.groupDiscoveryTimer);
      state.groupDiscoveryTimer = null;
      state.pendingGroupDiscoveries.clear();
      const wasOnline = state.loggedIn && sessions.get(state.uin) === state;
      if (sessions.get(state.uin) === state) sessions.delete(state.uin);
      state.loggedIn = false;
      state.presence = 20;
      if (wasOnline) pushPresenceChange(state.uin, 'disconnect');
      settings.logger({ event: 'disconnect', peer, uin: state.uin || undefined });
    });
  });
  server.qqStore = store;
  server.qqSessions = sessions;
  server.closeAllConnections = () => {
    for (const socket of sockets) socket.destroy();
  };
  server.setPresence = setSessionPresence;
  server.pushGroupMappings = (uin, groups, reason) => {
    const session = sessions.get(Number(uin));
    return session ? pushGroupMappings(session, groups, reason || 'server') : false;
  };
  server.pushGroupDiscovery = (uin, groups, reason) => {
    const session = sessions.get(Number(uin));
    if (!session) return false;
    if (session.clientFamily === 'symbian_s60') {
      return queueSymbianGroupDiscovery(session, groups, reason || 'server',
        settings.symbianGroupDiscoveryIntervalMs || 250);
    }
    return pushGroupDiscovery(session, groups, reason || 'server');
  };
  server.pushFriendAccepted = (leftUin, rightUin, reason) => {
    pushFriendAccepted(leftUin, rightUin, 0, reason || 'server');
  };
  server.pushFriendRequest = (receiverUin, requesterUin, message, reason) =>
    pushFriendRequestNotification(
      receiverUin, requesterUin, message, reason || 'server');
  server.deliverText = (fromUin, toUin, text, subtype, reason) => {
    const session = sessions.get(Number(toUin));
    if (!session || !session.loggedIn || session.socket.destroyed) return false;
    session.pushSequence = (session.pushSequence + 1) & 0xFFFF;
    writeEncrypted(session, protocol.COMMAND_INCOMING_TEXT, session.pushSequence,
      protocol.buildIncomingTextPayload(Number(fromUin), text,
        Math.floor(Date.now() / 1000), subtype === undefined ? 9 : subtype));
    settings.logger({
      event: 'text_pushed', command: '0x0056', sequence: session.pushSequence,
      from: Number(fromUin), to: Number(toUin),
      subtype: subtype === undefined ? 9 : subtype, reason,
    });
    return true;
  };
  server.pushSystemNotice = (uin, text, reason) => {
    const session = sessions.get(Number(uin));
    if (!session || !session.loggedIn || session.socket.destroyed) return false;
    session.pushSequence = (session.pushSequence + 1) & 0xFFFF;
    writeEncrypted(session, protocol.COMMAND_INCOMING_TEXT, session.pushSequence,
      protocol.buildIncomingTextPayload(0, text, Math.floor(Date.now() / 1000), 3));
    settings.logger({ event: 'system_notice_pushed', uin: session.uin, text, reason });
    return true;
  };
  return server;
}

function parseArguments(args, environment) {
  const values = {
    host: environment.QQ_LISTEN_ADDRESS || '127.0.0.1',
    port: Number(environment.QQ_PORT || 14000),
    testUin: Number(environment.QQ_TEST_UIN || 10001),
    testPassword: environment.QQ_TEST_PASSWORD || 'qqtest123',
    traceProtocol: environment.QQ_TRACE_PROTOCOL === '1',
    dataFile: environment.QQ_DATA_FILE || path.join(__dirname, 'data', 'private-qq.sqlite'),
    autoAcceptFriends: environment.QQ_AUTO_ACCEPT_FRIENDS !== '0',
  };
  const mappings = {
    '--host': 'host', '--port': 'port', '--uin': 'testUin', '--password': 'testPassword',
    '--trace-protocol': 'traceProtocol',
    '--data': 'dataFile', '--auto-accept-friends': 'autoAcceptFriends',
  };
  for (let index = 0; index < args.length; index += 2) {
    const key = mappings[args[index]];
    if (!key || args[index + 1] === undefined) throw new Error('invalid command-line arguments');
    values[key] = key === 'port' || key === 'testUin' ? Number(args[index + 1])
      : key === 'traceProtocol' || key === 'autoAcceptFriends'
        ? args[index + 1] === 'true' || args[index + 1] === '1'
        : args[index + 1];
  }
  if (!Number.isInteger(values.port) || values.port < 0 || values.port > 65535) {
    throw new Error('port must be between 0 and 65535');
  }
  if (!Number.isInteger(values.testUin) || values.testUin <= 0 || values.testUin > 0xFFFFFFFF) {
    throw new Error('test UIN must fit in an unsigned 32-bit integer');
  }
  if (!/^[\x20-\x7E]+$/.test(values.testPassword)) {
    throw new Error('test password must use printable ASCII characters');
  }
  return values;
}

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2), process.env);
    const server = createQQServer(options);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      jsonLogger({
        event: 'listening', host: address.address, port: address.port,
        accounts: [10001, 10002], autoAcceptFriends: options.autoAcceptFriends,
        capabilities: CAPABILITIES,
        warning: 'Use only the documented fake test password; never enter a real QQ password.',
      });
    });
  } catch (error) {
    process.stderr.write('QQ private server failed: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { createQQServer, parseArguments };
