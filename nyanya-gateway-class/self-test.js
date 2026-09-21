'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const protocol = require('./legacy/protocol');
const { AccountStore, defaultData } = require('./legacy/store');
const { createQQServer } = require('./legacy/server');
const { createMobileGroupServer } = require('./legacy/mobile-group-server');
const { NapCatBackend, resolveMediaTarget } = require('./core/napcat-backend');
const { parseHistoricalMedia, replayGroupHistory } = require('./core/group-history');
const { replayPrivateHistory } = require('./core/private-history');
const { createReplayCursors } = require('./core/replay-cursor');
const { loadConfig } = require('./config');
const { OfflineDeliveryQueue } = require('../packages/gateway-core');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepReject(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

function deterministicRandom(size) {
  const output = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index += 1) output[index] = (index * 37 + 11) & 0xFF;
  return output;
}

class FrameReader {
  constructor(socket) {
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.frames = [];
    socket.on('data', (chunk) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.flush();
    });
  }

  flush() {
    const consumed = protocol.consumeFrames(this.buffer);
    this.buffer = consumed.remainder;
    for (const frame of consumed.frames) {
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(frame);
      else this.frames.push(frame);
    }
  }

  next() {
    if (this.frames.length > 0) return Promise.resolve(this.frames.shift());
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.flush();
    });
  }

  async nextOf(command, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 3000);
    while (Date.now() < deadline) {
      // 先消费已经排队的帧（可能早于本次调用到达）
      if (this.frames.length > 0) {
        const queued = this.frames.shift();
        if (queued.command === command) return queued;
        continue;
      }
      const waiter = { resolve: null, reject: null };
      const promise = new Promise((resolve, reject) => {
        waiter.resolve = resolve;
        waiter.reject = reject;
      });
      this.waiters.push(waiter);
      this.flush();
      const timer = setTimeout(
        () => waiter.reject(new Error('timeout')), deadline - Date.now());
      let frame;
      try {
        frame = await promise;
      } catch (err) {
        clearTimeout(timer);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        throw err;
      }
      clearTimeout(timer);
      if (frame.command === command) return frame;
    }
    throw new Error('timeout waiting for command 0x' + command.toString(16));
  }
}

function getKeyRequest(uin, sequence) {
  const first = Buffer.alloc(16, 0x41);
  const second = Buffer.from('nyanya', 'ascii');
  const payload = Buffer.alloc(first.length + 4 + second.length);
  first.copy(payload, 0);
  payload[first.length] = 1;
  payload[first.length + 1] = 1;
  payload.writeUInt16BE(second.length, first.length + 2);
  second.copy(payload, first.length + 4);
  return protocol.createFrame({ command: protocol.COMMAND_GET_KEY, sequence, uin, payload });
}

function loginRequest(uin, sequence, key, password) {
  const digest = protocol.passwordDigest(password);
  const payload = Buffer.alloc(64);
  payload.writeUInt16BE(9, 0);
  payload.writeUInt16BE(1, 2);
  payload.writeUInt16BE(0, 4);
  payload.writeUInt16BE(0, 6);
  Buffer.alloc(16, 0x42).copy(payload, 8);
  payload[24] = digest.length;
  digest.copy(payload, 25);
  payload[41] = 2;
  payload[42] = 4;
  payload.writeUInt16BE(15, 43);
  Buffer.alloc(15, 0x43).copy(payload, 45);
  payload[60] = 7;
  payload.writeUInt16BE(1, 61);
  payload[63] = 8;
  return protocol.createFrame({
    command: protocol.COMMAND_LOGIN,
    sequence,
    uin,
    payload: protocol.encryptPayload(payload, key, deterministicRandom),
  });
}

function symbianLoginRequest(uin, sequence, key, password) {
  const digest = protocol.passwordDigest(password);
  const header = Buffer.alloc(8);
  header.writeUInt16BE(9, 0);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(10, 6);
  const extensions = [
    [4, Buffer.from('358647047946385', 'ascii')],
    [5, Buffer.from([1])],
    [7, Buffer.from([0x34])],
    [11, Buffer.from([0x20, 0x02, 0x84, 0x4D])],
  ].map(([type, data]) => Buffer.concat([Buffer.from([type]), uint16(data.length), data]));
  const payload = Buffer.concat([
    header,
    Buffer.from('24B9571754ECEE26', 'ascii'),
    Buffer.from([digest.length]),
    digest,
    Buffer.from([extensions.length]),
    ...extensions,
  ]);
  return protocol.createFrame({
    command: protocol.COMMAND_LOGIN,
    sequence,
    uin,
    payload: protocol.encryptPayload(payload, key, deterministicRandom),
  });
}

function sendTextRequest(uin, sequence, key, targetUin, text) {
  const textBytes = protocol.encodeLegacyText(text);
  const payload = Buffer.alloc(6 + textBytes.length + 16);
  payload.writeUInt32BE(targetUin, 0);
  payload.writeUInt16BE(16 + textBytes.length, 4);
  textBytes.copy(payload, 6);
  return protocol.createFrame({
    command: protocol.COMMAND_SEND_TEXT,
    sequence,
    uin,
    payload: protocol.encryptPayload(payload, key, deterministicRandom),
  });
}

function buddyDetailsRequest(uin, sequence, key, subtype, cursor) {
  const payload = Buffer.alloc(5);
  payload[0] = subtype;
  payload.writeUInt32BE(cursor >>> 0, 1);
  return protocol.createFrame({
    command: protocol.COMMAND_BUDDY_DETAILS,
    sequence,
    uin,
    payload: protocol.encryptPayload(payload, key, deterministicRandom),
  });
}

function friendRosterRequest(uin, sequence, key, cursor) {
  const payload = Buffer.alloc(3);
  payload.writeInt16BE(cursor, 0);
  payload[2] = 0;
  return protocol.createFrame({
    command: protocol.COMMAND_FRIEND_ROSTER,
    sequence,
    uin,
    payload: protocol.encryptPayload(payload, key, deterministicRandom),
  });
}

function uint16(value) {
  const output = Buffer.alloc(2);
  output.writeUInt16BE(value, 0);
  return output;
}

// 按 MobileQQ 12.0.16 的 ik 组包逻辑构造 0x008C 订阅载荷（TLV：type1 + type4 群列表）
function groupReceiveFilterPayload(groups) {
  const chunks = [];
  chunks.push(Buffer.concat([
    Buffer.from([0x01]), uint16(1), Buffer.from([0x42]),
  ]));
  const data4 = Buffer.alloc(3 + groups.length * 4);
  data4[0] = 1;
  data4.writeUInt16BE(groups.length, 1);
  groups.forEach((group, index) => data4.writeUInt32BE(group, 3 + index * 4));
  chunks.push(Buffer.concat([
    Buffer.from([0x04]), uint16(3 + groups.length * 4), data4,
  ]));
  return Buffer.concat(chunks);
}

function groupReceiveStatePayload(entries) {
  const payload = Buffer.alloc(2 + entries.length * 5);
  payload.writeUInt16BE(entries.length, 0);
  entries.forEach((entry, index) => {
    const offset = 2 + index * 5;
    payload[offset] = entry.receive ? 1 : 0;
    payload.writeUInt32BE(entry.groupId, offset + 1);
  });
  return payload;
}

class MockOneBot {
  constructor() {
    this.handlers = [];
    this.statusHandlers = [];
    this.actions = [];
    this.sent = [];
    this.selfId = 10001;
    this.nickname = 'Nyanya';
    this.friends = [{ user_id: 20002, nickname: 'Alice', remark: '小艾' }];
    this.groups = [{ group_id: 30003, group_name: '测试群' }];
    this.members = [
      // 本人的群名片不能覆盖 get_login_info 返回的全局昵称。
      { user_id: 10001, nickname: 'Nyanya', card: 'Wrong group card' },
      { user_id: 20002, nickname: 'Alice' },
    ];
    this.started = false;
    // 让指定 action 返回 not-ok，用来验证"失败的 RPC 不得当成空列表"
    this.failActions = new Set();
    // 收图用例用：get_image 返回的本地文件路径；null 表示取不到图
    this.imageFile = null;
  }

  onEvent(handler) {
    this.handlers.push(handler);
  }

  onStatusChange(handler) {
    this.statusHandlers.push(handler);
  }

  start() {
    this.started = true;
    for (const handler of this.statusHandlers) handler(true);
  }

  stop() {
    this.started = false;
    for (const handler of this.statusHandlers) handler(false);
  }

  emit(event) {
    for (const handler of this.handlers) handler(event);
  }

  sendAction(action, params) {
    this.actions.push({ action, params });
    if (this.failActions.has(action)) {
      return Promise.resolve({ ok: false, error: 'mock failure for ' + action });
    }
    if (action === 'get_login_info') {
      return Promise.resolve({ ok: true, data: { user_id: this.selfId, nickname: this.nickname } });
    }
    if (action === 'get_friend_list') {
      return Promise.resolve({ ok: true, data: this.friends });
    }
    if (action === 'get_group_list') {
      return Promise.resolve({ ok: true, data: this.groups });
    }
    if (action === 'get_group_member_list') {
      return Promise.resolve({ ok: true, data: this.members });
    }
    if (action === 'get_image') {
      return Promise.resolve(this.imageFile
        ? { ok: true, data: { file: this.imageFile } }
        : { ok: false, error: 'mock has no image to hand out' });
    }
    if (action === 'send_private_msg' || action === 'send_group_msg') {
      this.sent.push({ action, params });
      return Promise.resolve({ ok: true, data: { message_id: 90000 + this.sent.length } });
    }
    return Promise.resolve({ ok: false, error: 'unknown action ' + action });
  }
}

function parseBuddyEntries(plain) {
  const entries = [];
  for (let offset = 9; offset + 6 <= plain.length; offset += 6) {
    entries.push({
      uin: plain.readUInt32BE(offset),
      relationType: plain[offset + 4],
      groupIndex: (plain[offset + 5] >> 2) & 0x0F,
    });
  }
  return entries;
}

function parseIncomingText(plain) {
  const subtype = plain.readUInt16BE(0);
  const senderUin = plain.readUInt32BE(6);
  const length = plain.readUInt16BE(10);
  const text = protocol.decodeLegacyText(plain.subarray(12, 12 + length));
  return { subtype, senderUin, text };
}

function parseGroupMessage(plain) {
  const displayNameLength = plain[1];
  const groupId = plain.readUInt32BE(4 + displayNameLength);
  const senderUin = plain.readUInt32BE(9 + displayNameLength);
  return { groupId, senderUin };
}

function parseGroupRelations(plain) {
  const groups = [];
  for (let offset = 9; offset + 6 <= plain.length; offset += 6) {
    if (plain[offset + 4] === 4) groups.push(plain.readUInt32BE(offset));
  }
  return groups;
}

function parseGroupMappings(plain) {
  const groups = [];
  let offset = 11;
  const count = plain.length > 10 ? plain[10] : 0;
  for (let index = 0; index < count && offset + 6 <= plain.length; index += 1) {
    const groupId = plain.readUInt32BE(offset); offset += 5;
    const publicIdLength = plain[offset]; offset += 1;
    if (offset + publicIdLength > plain.length) break;
    groups.push(groupId);
    offset += publicIdLength;
  }
  return groups;
}

async function openClient(port, uin, password) {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const reader = new FrameReader(socket);
  const keyFrame = getKeyRequest(uin, 1);
  socket.write(keyFrame);
  const keyResponse = await reader.nextOf(protocol.COMMAND_GET_KEY, 3000);
  const key = Buffer.from(keyResponse.payload.subarray(0, 16));
  socket.write(loginRequest(uin, 2, key, password));
  const loginResponse = await reader.nextOf(protocol.COMMAND_LOGIN, 3000);
  const decrypted = loginResponse.status === 0
    ? protocol.decryptPayload(loginResponse.payload, key) : null;
  return { socket, reader, key, loginResponse, decrypted };
}

async function openSymbianClient(port, uin, password) {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const reader = new FrameReader(socket);
  const keyFrame = getKeyRequest(uin, 1);
  socket.write(keyFrame);
  const keyResponse = await reader.nextOf(protocol.COMMAND_GET_KEY, 3000);
  const wireKey = Buffer.from(keyResponse.payload.subarray(0, 16));
  const key = protocol.deriveSymbianSessionKey(wireKey, keyFrame.subarray(14, -1));
  socket.write(symbianLoginRequest(uin, 2, key, password));
  const loginResponse = await reader.nextOf(protocol.COMMAND_LOGIN, 3000);
  const decrypted = loginResponse.status === 0
    ? protocol.decryptPayload(loginResponse.payload, key) : null;
  return { socket, reader, key, loginResponse, decrypted };
}

function assertSymbianGroupInfoLayout() {
  const group = {
    id: 30003,
    publicId: 40004,
    type: 'group',
    ownerUin: 10001,
    title: 'S60 test',
    members: [
      { uin: 10001, role: 'owner' },
      { uin: 20002, role: 'member' },
    ],
  };
  const payload = protocol.buildSymbianGroupInfoPayload(group);
  const titleBytes = Buffer.from(group.title, 'utf16le').swap16();
  assert.equal(payload.length, 45 + titleBytes.length + 12,
    'S60 group info uses the classic fixed header and six-byte members');
  assert.equal(payload[0], 4);
  assert.equal(payload[1], 0);
  assert.equal(payload.readUInt32BE(2), group.id);
  assert.equal(payload.readUInt32BE(6), group.publicId);
  assert.equal(payload.readUInt32BE(15), group.ownerUin,
    'owner UIN follows the four-byte version/flags field');
  assert.equal(payload.readUInt32BE(26), 1);
  assert.equal(payload.readUInt16BE(30), 200);
  assert.deepEqual(payload.subarray(33, 40),
    Buffer.from([0, 0, 1, 0, 0, 0, 0xFC]),
    'QQ2007+ native capability bytes are present');
  assert.equal(payload[40], titleBytes.length);
  assert.deepEqual(payload.subarray(41, 41 + titleBytes.length), titleBytes);
  const membersOffset = 45 + titleBytes.length;
  assert.equal(payload.readUInt32BE(membersOffset), 10001);
  assert.equal(payload[membersOffset + 5], 1);
  assert.equal(payload.readUInt32BE(membersOffset + 6), 20002);
}

// 登录响应报文里只有 4 字节的 IP 字段：config.loginPublicHost 只认合法 IPv4
// 点分字面量，域名 / IPv6 / 越界 / 前导零 / 0.0.0.0 一律拒绝，由 server.js
// 回退到自动探测出来的局域网 IP。
function assertLoginAddressOverride() {
  assert.equal(protocol.ipv4ToBuffer('192.168.1.3').toString('hex'), 'c0a80103');
  assert.equal(protocol.ipv4ToBuffer(' 10.0.0.255 ').toString('hex'), '0a0000ff',
    '首尾空白应被容忍');
  assert.equal(protocol.ipv4ToBuffer('127.0.0.1').toString('hex'), '7f000001',
    '本机地址合法（模拟器同机场景要用它）');
  const rejected = [
    'gateway.example.com', '::1', '1.2.3.256', '1.2.3', '1.2.3.4.5',
    '1.2.3.04', '0.0.0.0', '', '   ', 'a.b.c.d', '1.2.-3.4',
  ];
  for (const value of rejected) {
    assert.equal(protocol.ipv4ToBuffer(value), null, `应拒绝 ${JSON.stringify(value)}`);
  }
  for (const value of [null, undefined, 42, Buffer.from([1, 2, 3, 4])]) {
    assert.equal(protocol.ipv4ToBuffer(value), null, '非字符串一律拒绝');
  }
}

async function main() {
  assertSymbianGroupInfoLayout();
  assertLoginAddressOverride();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyanya-test-'));
  const config = loadConfig({
    host: '127.0.0.1',
    port: 0,
    onebotUrl: 'ws://mock.invalid',
    deviceUin: 0,
    deviceToken: 'nyanya-token',
    dataDir: tmpDir,
    adminHost: '127.0.0.1',
    adminPort: 0,
    mobileHost: '127.0.0.1',
    mobilePort: 0,
    traceProtocol: false,
    groupMemberMirrorLimit: 2,
    log: console,
  });
  const store = new AccountStore(
    path.join(tmpDir, 'nyanya.sqlite'),
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
  const logger = { log: () => {}, error: () => {} };
  const events = [];
  const eventLogger = (event) => events.push(event);
  // 群接收状态就绪的通知（回放挂点）：这里只记下来，不真的推消息，
  // 免得回放帧混进后面那些"不该推送"的断言。回放本身在下面单独测。
  const receiveReadyCalls = [];
  // 登录就绪的通知（私聊回放挂点）：同样只记下来，回放本身在下面单独测。
  const clientReadyCalls = [];

  const mock = new MockOneBot();
  let backend = null;
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
      if (target.clientFamily !== 'symbian_s60' && !target.groupReceiveStateReady) {
        blockedBySync += 1;
        eventLogger({
          event: 'group_message_skipped', peer: target.peer, uin: target.uin,
          groupId: Number(groupId), reason: 'j2me_group_receive_state_pending',
        });
        continue;
      }
      if (target.groupReceiveFilter
          && !target.groupReceiveFilter.has(Number(groupId))) {
        blockedByFilter += 1;
        eventLogger({
          event: 'group_message_skipped', peer: target.peer, uin: target.uin,
          groupId: Number(groupId), reason: 'j2me_group_receive_filter',
        });
        continue;
      }
      if (target.clientFamily === 'symbian_s60') {
        if (!target.buddyDetailsSyncComplete || !target.friendRosterSyncComplete) {
          blockedBySync += 1;
          continue;
        }
        const advertised = target.advertisedGroupIds;
        if (!advertised || (!advertised.has(Number(group.id))
            && !advertised.has(Number(group.publicId)))) {
          blockedUnmapped += 1;
          continue;
        }
      }
      target.pushSequence = (target.pushSequence + 1) & 0xFFFF;
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
  const remoteSender = {
    sendPrivate: (from, to, text) => backend.sendPrivate(from, to, text),
    sendGroup: (from, groupId, text) => backend.sendGroup(from, groupId, text),
  };
  const qqServer = createQQServer({
    host: '127.0.0.1',
    port: 14000,
    loginIp: Buffer.from([127, 0, 0, 1]),
    store,
    sessions,
    logger: eventLogger,
    friendPresence: 10,
    remoteSender,
    mediaService: null,
    symbianGroupDiscoveryBatchSize: 2,
    symbianGroupDiscoveryDelayMs: 20,
    symbianGroupDiscoveryIntervalMs: 20,
    symbianGroupProbeLimit: 0,
    symbianGroupInfoProfile: 's60_qq2013',
    onGroupReceiveReady: (state, reason) => {
      receiveReadyCalls.push({
        uin: state.uin,
        reason,
        filter: state.groupReceiveFilter ? Array.from(state.groupReceiveFilter) : null,
      });
    },
    replayGroupHistoryDelayMs: 20,
    onClientReady: (state, reason) => {
      clientReadyCalls.push({ uin: state.uin, reason });
    },
    replayPrivateHistoryDelayMs: 20,
    deliverOutbox: (uin) => setTimeout(() => {
      const entries = outboxQueue.take(uin);
      for (const entry of entries) {
        const delivered = qqServer.deliverText(entry.from, entry.to, entry.text, 9, 'outbox');
        if (!delivered) outboxQueue.enqueue(entry.to, entry);
      }
    }, 800),
    // Deliberate marker collision: the Symbian-derived key is byte-for-byte
    // identical to the normal key, so detection must use the login fingerprint.
    sessionKeyFactory: () => Buffer.alloc(16, 0x55),
  });
  qqServer.deliverGroup = deliverGroup;
  backend = new NapCatBackend({
    config,
    store,
    sessions: qqServer.qqSessions,
    server: qqServer,
    logger,
    onebot: mock,
    offlineQueue: outboxQueue,
    mediaBaseUrl: 'http://192.0.2.10:13981',
  });
  backend.start();
  await backend.refreshMirror();
  // 设备账号昵称应同步自 NapCat（账号可能由旧镜像升级而来，昵称是旧的）
  store.get(10001).nickname = 'stale-nickname';
  await backend.refreshMirror();
  assert.equal(store.get(10001).nickname, 'Nyanya', 'device nickname synced from NapCat');
  assert.equal(store.get(10001).profile.realName, 'Nyanya',
    'device real name ignores the self group card');
  // config 里的 token 是权威：账号密码被改掉后，刷新应自动同步回 config token
  store.resetPassword(10001, 'stale-token');
  await backend.refreshMirror();
  assert.equal(
    store.get(10001).passwordDigest,
    require('node:crypto').createHash('md5').update(Buffer.from('nyanya-token', 'latin1')).digest('hex'),
    'device token should be re-synced from config on refresh');

  // 群列表不再截断到 60；只有配置数量的群会拉取昂贵的成员列表。
  const originalGroups = mock.groups.slice();
  mock.groups = Array.from({ length: 65 }, (_, index) => ({
    group_id: index === 0 ? 30003 : 50000000 + index,
    group_name: '群' + index,
  }));
  const memberCallsBefore = mock.actions.filter(
    (action) => action.action === 'get_group_member_list').length;
  await backend.refreshMirror();
  assert.equal(store.groupsOf(10001).length, 65, 'NapCat group mirror is not capped at 60');
  const memberCallsAfter = mock.actions.filter(
    (action) => action.action === 'get_group_member_list').length;
  assert.equal(memberCallsAfter - memberCallsBefore, 2,
    'only groupMemberMirrorLimit groups fetch member lists');
  mock.groups = originalGroups;
  await backend.refreshMirror();

  // ---------- 回归：孤儿群消息不再让 save() 整体回滚 ----------
  // 复现 2026-09-20 的故障：群消息留在库里，群却从镜像里消失。
  // 旧实现会让 save() 撞 group_messages.group_id 外键并整体回滚，
  // 库被冻结、联系人镜像永远刷不上。
  {
    const group = store.getGroup(30003);
    assert.ok(group, 'group 30003 exists before the orphan regression test');
    store.data.groupMessages.push({
      id: store.data.nextGroupMessageId++, groupId: group.id, from: 20002,
      text: 'orphan', sentAt: new Date().toISOString(), source: 'client',
    });
    // 把群从镜像里摘掉，上面那条群消息就成了孤儿
    store.data.groups = store.data.groups.filter((value) => value.id !== group.id);
    const report = store.save();
    assert.ok(report.removed >= 1, 'orphan references are reconciled before save');
    assert.ok(report.groupMessages >= 1, 'the orphan group message is reported');
    assert.equal(store.data.groupMessages.some((item) => item.groupId === group.id), false,
      'orphan group message is dropped from memory as well');
    const reloaded = new AccountStore(path.join(tmpDir, 'nyanya.sqlite'));
    assert.equal(reloaded.data.groupMessages.some((item) => item.groupId === group.id), false,
      'orphan group message never reaches disk');
    reloaded.close();
    // 复原镜像，避免影响后续用例
    await backend.refreshMirror();
    assert.ok(store.getGroup(30003), 'group mirror restored after the orphan test');
  }

  // ---------- 回归：get_group_list 失效/返空时不得清空群列表 ----------
  {
    const groupsBefore = store.listGroups().length;
    assert.ok(groupsBefore > 0, 'mirror has groups before the collapse test');
    const goodGroups = mock.groups;
    mock.groups = [];
    let error = null;
    try {
      await backend.refreshMirror();
    } catch (err) {
      error = err;
    }
    assert.ok(error, 'empty get_group_list aborts the mirror refresh');
    assert.match(error.message, /空列表/, 'the collapse error explains itself');
    assert.equal(store.listGroups().length, groupsBefore,
      'groups survive an empty get_group_list');
    mock.failActions.add('get_group_list');
    error = null;
    try {
      await backend.refreshMirror();
    } catch (err) {
      error = err;
    }
    mock.failActions.delete('get_group_list');
    assert.ok(error && /get_group_list/.test(error.message),
      'failed get_group_list aborts the mirror refresh');
    assert.equal(store.listGroups().length, groupsBefore,
      'groups survive a failed get_group_list');
    mock.groups = goodGroups;
    await backend.refreshMirror();
  }

  // ---------- 回归：get_friend_list 失败时不得清空好友 ----------
  {
    const friendsBefore = store.get(10001).friends.slice();
    assert.ok(friendsBefore.length > 0, 'device has friends before the friend test');
    mock.failActions.add('get_friend_list');
    let error = null;
    try {
      await backend.refreshMirror();
    } catch (err) {
      error = err;
    }
    mock.failActions.delete('get_friend_list');
    assert.ok(error && /get_friend_list/.test(error.message),
      'failed get_friend_list aborts the mirror refresh');
    assert.deepEqual(store.get(10001).friends, friendsBefore,
      'friends survive a failed get_friend_list');
  }

  // ---------- 回归：NapCat 发来的图片落库，并把 [图片] 换成 WAP 链接 ----------
  // 修复前收图方向等于零实现：段落到 fallback 成 [图片] 就结束了，
  // 详见 .workbuddy/memory/2026-09-20.md 的收图诊断。
  {
    // 1x1 PNG 的文件头，够让 sniffImageMime 认出 png
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
    const imageFile = path.join(tmpDir, 'napcat-image.png');
    fs.writeFileSync(imageFile, pngBytes);
    mock.imageFile = imageFile;

    const pushed = [];
    const originalDeliverText = qqServer.deliverText;
    qqServer.deliverText = (from, to, text) => {
      pushed.push({ from, to, text });
      return true;
    };
    try {
      mock.emit({
        post_type: 'message',
        message_type: 'private',
        self_id: 10001,
        user_id: 20002,
        message_id: 70001,
        time: 1700000000,
        sender: { nickname: 'Alice' },
        message: [{ type: 'image', data: { file: imageFile } }],
      });
      for (let wait = 0; wait < 200 && pushed.length === 0; wait += 1) await sleep(10);
    } finally {
      qqServer.deliverText = originalDeliverText;
    }

    assert.equal(pushed.length, 1, 'image message is pushed exactly once');
    assert.match(pushed[0].text, /^【图片】http:\/\/192\.0\.2\.10:13981\/mobile\/media\//,
      'the pushed text carries the WAP media link');
    assert.equal(pushed[0].text.includes('[图片]'), false,
      'the [图片] placeholder is replaced by the link');

    const storedList = store.listMediaFor(20002, 10);
    assert.equal(storedList.length, 1, 'the image reaches the local media table');
    assert.equal(storedList[0].mediaType, 2, 'images are stored as the legacy picture type');
    assert.equal(storedList[0].mimeType, 'image/png', 'mime type is sniffed from the bytes');
    const stored = store.getMedia(storedList[0].id);
    assert.ok(stored.content.equals(pngBytes), 'image bytes round-trip through sqlite');
    assert.ok(pushed[0].text.includes(encodeURIComponent(storedList[0].id)),
      'the link points at the stored media id');

    // 群聊走旧客户端认识的群图片入口
    assert.equal(backend._mediaLink('abc def', 'group'),
      'http://192.0.2.10:13981/forward.jsp?bid=331&fileid=abc%20def',
      'group images use the legacy group picture entry');
    mock.imageFile = null;
  }

  // ---------- 回归：群消息里的图片块能被旧客户端解析出图片 ----------
  // 本地复刻客户端 im.G() + im.f()：正文里出现 0x15 且 +2 是 '6'，客户端就把它当
  // 一张图片，读出 uuid 与 fileid，渲染成可点击的 [图片] 气泡。
  // 偏移含义见 legacy/protocol.js 里 buildGroupImageBlock 的注释，
  // 逆向依据见 .workbuddy/memory/2026-09-20.md。
  {
    const mediaId = '11111111-2222-3333-4444-555555555555';
    // 复刻 buildGroupMessagePayload 的头部，找到正文字段：
    // subtype(1) 名字长(1) 名字(名长) 保留(2) 群号(4) 保留(1) 发送者(4) 保留(4)
    // 时间(4) 保留(4) 正文字节长(2) 正文
    const readBody = (payload) => {
      let offset = 2 + payload[1];
      offset += 2 + 4 + 1 + 4 + 4 + 4 + 4;
      const length = payload.readUInt16BE(offset);
      offset += 2;
      return payload.subarray(offset, offset + length);
    };
    // 复刻 im.f() 的块解析：只读 +3 +7 +9 +10 +18 +98 这几个点
    const readBlock = (body) => {
      // im.f() 找的是 UTF-16BE 的 \u0015（字节 0x00 0x15），im.G() 的粗筛是多看一个 +2
      let marker = -1;
      for (let index = 0; index + 3 < body.length; index += 1) {
        if (body[index] === 0x00 && body[index + 1] === 0x15
            && body[index + 3] === 0x36) { marker = index; break; }
      }
      if (marker < 0) return null;
      const chars = (body[marker + 7] - 48) * 10 + (body[marker + 9] - 48);
      const uuidLength = body.readUInt16BE(marker + 10) - 65;
      const readChars = (start, count) => {
        const values = [];
        for (let index = 0; index < count; index += 1) {
          values.push(body.readUInt16BE(start + index * 2));
        }
        return String.fromCharCode(...values);
      };
      return {
        marker,
        chars,
        uuidLength,
        uuid: readChars(marker + 98, uuidLength),
        fileIdHex: readChars(marker + 18, 8),
        // 客户端 Long.parseLong(hex,16) → 十进制，再拼进 ?fileid=
        fileId: BigInt('0x' + readChars(marker + 18, 8)).toString(),
      };
    };

    const body = readBody(protocol.buildGroupMessagePayload({
      groupId: 689546479,
      senderUin: 2679375266,
      displayName: 'Alice',
      text: '[图片]',
      images: [mediaId],
      imageText: '[图片]',
    }));
    const block = readBlock(body);
    assert.ok(block, 'the group body carries an image marker (0x15 + "6")');
    assert.equal(block.uuid, mediaId, 'the block carries the media id as the picture uuid');
    assert.equal(block.uuidLength, mediaId.length, 'the uuid character count is encoded at +10');
    assert.equal(block.chars, 49 + mediaId.length, 'the block length covers header + uuid');
    assert.equal(body.length, 10 + block.chars * 2,
      'the body is the 10-byte header plus one whole block (the placeholder is consumed)');
    assert.equal(block.marker, 10, 'the block starts right after the 10-byte message header');
    assert.match(block.fileIdHex, /^[0-9a-f]{8}$/, 'the file id is 8 lowercase hex digits');
    assert.ok(BigInt('0x' + block.fileIdHex) <= 0xFFFFFFFFn,
      'the file id stays inside 32 bits so Long.parseLong cannot overflow');
    // 曾经把散列写在了 8 个字符之外，客户端读到的恒为 00000000 —— 这条防回归
    assert.notEqual(block.fileIdHex, '00000000', 'the file id is a real hash, not padding');
    const otherId = 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz';
    const otherBlock = protocol.buildGroupImageBlock(otherId);
    const otherHex = [];
    for (let index = 0; index < 8; index += 1) otherHex.push(otherBlock.readUInt16BE(18 + index * 2));
    assert.notEqual(String.fromCharCode(...otherHex), block.fileIdHex,
      'the file id is derived from the uuid');
    assert.equal(otherBlock.readUInt16BE(10) - 65, otherId.length,
      'the uuid character count is relative to the block, not the group body');

    // 混合文本：占位符被原地替换，前后文字都保留
    const mixedBody = readBody(protocol.buildGroupMessagePayload({
      groupId: 1, senderUin: 2, displayName: 'A',
      text: '看图[图片]好', images: [mediaId], imageText: '看图[图片]好',
    }));
    assert.ok(mixedBody.subarray(0, 10).equals(Buffer.alloc(10)),
      'the 10-byte message header stays zeroed');
    assert.ok(mixedBody.subarray(10, 14).equals(protocol.encodeLegacyText('看图')),
      'text before the placeholder survives');
    assert.ok(mixedBody.subarray(mixedBody.length - 2).equals(protocol.encodeLegacyText('好')),
      'text after the placeholder survives');
    assert.ok(mixedBody.subarray(14, mixedBody.length - 2).equals(
      protocol.buildGroupImageBlock(mediaId)), 'the placeholder is replaced by the image block');

    // 没有图片时纯文本路径完全不变
    const plainBody = readBody(protocol.buildGroupMessagePayload({
      groupId: 1, senderUin: 2, displayName: 'A', text: 'hi',
    }));
    assert.equal(plainBody.length, 14, 'plain group text keeps the 10-byte header + 2 chars');
    assert.equal(readBlock(plainBody), null, 'plain text carries no image marker');

    // uuid 过长（块长要两位十进制）必须被拒，而不是生成坏块
    assert.throws(() => protocol.buildGroupImageBlock('x'.repeat(51)),
      /too long/, 'an over-long uuid is rejected instead of emitting a corrupt block');
  }

  // ---------- 回归：取不到图片时不丢消息、不抛错 ----------
  {
    const pushed = [];
    const originalDeliverText = qqServer.deliverText;
    qqServer.deliverText = (from, to, text) => {
      pushed.push(text);
      return true;
    };
    try {
      mock.emit({
        post_type: 'message',
        message_type: 'private',
        self_id: 10001,
        user_id: 20002,
        message_id: 70002,
        time: 1700000001,
        sender: { nickname: 'Alice' },
        message: [{ type: 'image', data: { file: 'base64://', url: '' } }],
      });
      for (let wait = 0; wait < 200 && pushed.length === 0; wait += 1) await sleep(10);
    } finally {
      qqServer.deliverText = originalDeliverText;
    }
    assert.equal(pushed.length, 1, 'text still goes through when the image cannot be fetched');
    assert.equal(pushed[0], '[图片]', 'the placeholder is preserved when the image fails');
  }

  const port = await new Promise((resolve, reject) => {
    qqServer.on('error', reject);
    qqServer.listen(0, '127.0.0.1', () => resolve(qqServer.address().port));
  });

  try {
    // ---------- 登录 + 联系人/群占位 ----------
    const client = await openClient(port, 10001, 'nyanya-token');
    assert.equal(client.loginResponse.status, 0);
    assert.ok(client.decrypted && client.decrypted.length === 58, 'login success payload');
    assert.ok(events.some((event) => event.event === 'login_ok' && event.uin === 10001));
    // 登录后服务器应推送 0x008A 激活群消息订阅（腾讯服务器行为）
    const notifyPush = await client.reader.nextOf(protocol.COMMAND_GROUP_NOTIFY_CONFIG, 3000);
    const notifyPlain = protocol.decryptPayload(notifyPush.payload, client.key);
    assert.equal(notifyPlain[0], 0, '0x008A byte flag is 0');
    assert.ok(notifyPlain.readUInt32BE(1) >= 5, '0x008A interval seconds present');

    client.socket.write(protocol.createFrame({
      command: protocol.COMMAND_BUDDY_LIST,
      sequence: 3,
      uin: 10001,
      payload: protocol.encryptPayload(Buffer.alloc(8), client.key, deterministicRandom),
    }));
    const roster = await client.reader.nextOf(protocol.COMMAND_BUDDY_LIST, 3000);
    assert.equal(roster.status, 0);
    const entries = parseBuddyEntries(protocol.decryptPayload(roster.payload, client.key));
    assert.deepEqual(entries, [
      { uin: 20002, relationType: 1, groupIndex: 0 },
      { uin: 30003, relationType: 4, groupIndex: 0 },
    ]);

    // ---------- 发送私聊 -> NapCat ----------
    client.socket.write(sendTextRequest(10001, 4, client.key, 20002, 'hello'));
    const sendAck = await client.reader.nextOf(protocol.COMMAND_SEND_TEXT, 3000);
    assert.equal(sendAck.status, 0);
    await sleep(50);
    assert.deepEqual(mock.sent, [
      { action: 'send_private_msg', params: { user_id: 20002, message: 'hello' } },
    ]);

    // ---------- NapCat 私聊事件 -> 0x0056 推送 ----------
    mock.emit({
      post_type: 'message',
      message_type: 'private',
      user_id: 20002,
      self_id: 10001,
      sender: { nickname: 'Alice' },
      message: [{ type: 'text', data: { text: 'hi' } }],
      time: 12345,
    });
    const incoming = await client.reader.nextOf(protocol.COMMAND_INCOMING_TEXT, 3000);
    const incomingPlain = protocol.decryptPayload(incoming.payload, client.key);
    assert.deepEqual(parseIncomingText(incomingPlain), { subtype: 9, senderUin: 20002, text: 'hi' });

    // ---------- J2ME 接收状态尚未上报时，群消息必须暂停 ----------
    mock.emit({
      post_type: 'message',
      message_type: 'group',
      group_id: 30003,
      user_id: 20002,
      self_id: 10001,
      sender: { nickname: 'Alice Updated', card: 'Group Alice Card' },
      message: [{ type: 'text', data: { text: 'hello group' } }],
      time: 12346,
    });
    await assert.rejects(
      () => client.reader.nextOf(protocol.COMMAND_GROUP_MESSAGE, 400),
      /timeout/,
      'group push waits for the first J2ME receive-state table');
    assert.ok(events.some((event) => event.event === 'group_message_skipped'
      && event.reason === 'j2me_group_receive_state_pending'),
    'pending J2ME receive state is logged');

    client.socket.write(protocol.createFrame({
      command: protocol.COMMAND_GROUP_SYNC,
      sequence: 5,
      uin: 10001,
      payload: protocol.encryptPayload(groupReceiveStatePayload([
        { receive: true, groupId: 30003 },
      ]), client.key, deterministicRandom),
    }));
    await client.reader.nextOf(protocol.COMMAND_GROUP_SYNC, 3000);

    // ---------- NapCat 群消息事件 -> 0x0094 推送 ----------
    mock.emit({
      post_type: 'message',
      message_type: 'group',
      group_id: 30003,
      user_id: 20002,
      self_id: 10001,
      sender: { nickname: 'Alice Updated', card: 'Group Alice Card' },
      message: [{ type: 'text', data: { text: 'hello group' } }],
      time: 12347,
    });
    const groupPush = await client.reader.nextOf(protocol.COMMAND_GROUP_MESSAGE, 3000);
    const groupPlain = protocol.decryptPayload(groupPush.payload, client.key);
    assert.deepEqual(parseGroupMessage(groupPlain), { groupId: 30003, senderUin: 20002 });
    assert.equal(protocol.decodeLegacyText(groupPlain.subarray(2, 2 + groupPlain[1])),
      'Group Alice Card', 'group card is preferred for the pushed message');
    assert.equal(store.get(20002).nickname, 'Alice Updated',
      'group card does not overwrite the global QQ nickname');

    // ---------- NapCat 群图片事件 -> 0x0094 携带图片块（方案 B） ----------
    // 群图片不再只推链接：正文里带上客户端 im.f() 认识的 0x15 + '6' 富媒体块，
    // 老客户端会渲染成可点击的 [图片] 气泡。
    {
      const png = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
      const groupImageFile = path.join(tmpDir, 'napcat-group-image.png');
      fs.writeFileSync(groupImageFile, png);
      mock.imageFile = groupImageFile;
      try {
        mock.emit({
          post_type: 'message',
          message_type: 'group',
          group_id: 30003,
          user_id: 20002,
          self_id: 10001,
          sender: { nickname: 'Alice Updated', card: 'Group Alice Card' },
          message: [{ type: 'image', data: { file: groupImageFile } }],
          time: 12348,
        });
        const imagePush = await client.reader.nextOf(protocol.COMMAND_GROUP_MESSAGE, 3000);
        const imagePlain = protocol.decryptPayload(imagePush.payload, client.key);
        // 正文字段：subtype(1) 名字长(1) 名字 保留(2) 群号(4) 保留(1) 发送者(4)
        // 保留(4) 时间(4) 保留(4) 正文字节长(2) 正文
        let offset = 2 + imagePlain[1] + 2 + 4 + 1 + 4 + 4 + 4 + 4;
        const bodyLength = imagePlain.readUInt16BE(offset); offset += 2;
        const body = imagePlain.subarray(offset, offset + bodyLength);
        let marker = -1;
        for (let index = 0; index + 3 < body.length; index += 1) {
          if (body[index] === 0x00 && body[index + 1] === 0x15
              && body[index + 3] === 0x36) { marker = index; break; }
        }
        assert.equal(marker, 10, 'the group image push carries a 0x15 + "6" block');
        assert.equal((body[marker + 7] - 48) * 10 + (body[marker + 9] - 48),
          49 + body.readUInt16BE(marker + 10) - 65, 'the block length matches its uuid');
        const uuidLength = body.readUInt16BE(marker + 10) - 65;
        let uuid = '';
        for (let index = 0; index < uuidLength; index += 1) {
          uuid += String.fromCharCode(body.readUInt16BE(marker + 98 + index * 2));
        }
        const stored = store.getMedia(uuid);
        assert.ok(stored, 'the block uuid resolves to the media stored for this group image');
        assert.equal(stored.mediaType, 2, 'the group image is stored as the legacy picture type');
        assert.ok(stored.content.equals(png), 'the stored group image keeps the NapCat bytes');
        assert.ok(backend._mediaLink(uuid, 'group').includes('bid=331'),
          'the group picture entry stays the legacy forward.jsp one');
      } finally {
        mock.imageFile = null;
      }
    }

    // ---------- 上行发图：老客户端上传的图片真正转发到真实 QQ ----------
    // 旧客户端只在群聊里给「发送图片」入口（hb.java:680 动作码 237），
    // 群图片的收件人是**群号而不是账号**，以前会被 saveMedia 的账号校验挡掉，
    // 就算过了也止步于 server.js 的 onComplete（只落库不转发）。这里锁死修复后的行为。
    {
      const png = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
      const groupMedia = store.saveMedia({
        from: 20002, to: 30003, filename: 'up.jpg', mimeType: 'image/jpeg',
        mediaType: 2, size: png.length, sha256: 'a'.repeat(64), content: png,
      });
      assert.ok(groupMedia && groupMedia.id, 'a group number is accepted as the recipient');
      assert.ok(groupMedia.content.equals(png), 'the uploaded bytes are stored untouched');
      assert.throws(() => store.saveMedia({
        from: 20002, to: 99999999, filename: 'bad.jpg', mimeType: 'image/jpeg',
        mediaType: 2, size: png.length, content: png,
      }), /media recipient/, 'an unknown recipient is still rejected');
      assert.throws(() => store.saveMedia({
        from: 99999999, to: 20002, filename: 'bad.jpg', mimeType: 'image/jpeg',
        mediaType: 2, size: png.length, content: png,
      }), /media sender/, 'an unknown sender is still rejected');

      // 收件人解析：群号 -> 群，好友 uin -> 私聊
      assert.deepEqual(resolveMediaTarget(store, 30003),
        { chatType: 'group', peerId: 30003 }, 'a group number routes to the group');
      assert.deepEqual(resolveMediaTarget(store, 20002),
        { chatType: 'private', peerId: 20002 }, 'a friend uin routes to the private chat');
      assert.deepEqual(resolveMediaTarget(store, 99999999),
        { chatType: 'private', peerId: 99999999 }, 'an unknown id falls back to private');

      // OneBot 转发：send_group_msg + base64 图片段
      const sentBefore = mock.sent.length;
      const forwarded = await backend.sendImage({
        chatType: 'group', peerId: 30003, fromUin: 20002, content: png, rateKey: 'global',
      });
      assert.equal(forwarded.ok, true, 'the mock NapCat accepts the group image');
      assert.equal(forwarded.action, 'send_group_msg', 'group images use send_group_msg');
      assert.equal(mock.sent.length, sentBefore + 1, 'exactly one image push is made');
      const imageCall = mock.sent[mock.sent.length - 1];
      assert.equal(imageCall.params.group_id, 30003, 'the real group number is group_id');
      assert.equal(imageCall.params.message.length, 1, 'a bare image is a single segment');
      assert.equal(imageCall.params.message[0].type, 'image', 'the payload is an image segment');
      assert.equal(imageCall.params.message[0].data.file,
        'base64://' + png.toString('base64'), 'the bytes travel as a base64 URI');

      // 带说明文字时，文本段在前
      await backend.sendImage({
        chatType: 'group', peerId: 30003, content: png, text: '看这个',
      });
      const captioned = mock.sent[mock.sent.length - 1];
      assert.equal(captioned.params.message[0].type, 'text', 'the caption precedes the image');
      assert.equal(captioned.params.message[1].type, 'image', 'the image follows the caption');

      // NapCat 报错时返回失败，不抛
      mock.failActions.add('send_group_msg');
      const failed = await backend.sendImage({ chatType: 'group', peerId: 30003, content: png });
      mock.failActions.delete('send_group_msg');
      assert.equal(failed.ok, false, 'a NapCat failure is reported instead of thrown');
      assert.equal(failed.code, 'onebot', 'the failure carries the onebot code');

      // 参数不合法同样不抛
      const emptyContent = await backend.sendImage({ chatType: 'group', peerId: 30003, content: null });
      assert.equal(emptyContent.ok, false, 'missing bytes are rejected without throwing');
      const noPeer = await backend.sendImage({ chatType: 'group', content: png });
      assert.equal(noPeer.ok, false, 'a missing peer is rejected without throwing');
      assert.equal(mock.sent.length, sentBefore + 2, 'rejected calls never reach NapCat');
    }

    // ---------- 离线消息进 outbox，重登后补发 ----------
    client.socket.destroy();
    await sleep(100);
    mock.emit({
      post_type: 'message',
      message_type: 'private',
      user_id: 20002,
      self_id: 10001,
      message: [{ type: 'text', data: { text: 'offline msg' } }],
      time: 12347,
    });
    await sleep(50);
    assert.equal(store.data.outbox.length, 1);
    assert.equal(store.data.outbox[0].text, 'offline msg');

    const privateReplayBeforeLogin = clientReadyCalls
      .filter((call) => call.uin === 10001).length;
    const client2 = await openClient(port, 10001, 'nyanya-token');
    assert.equal(client2.loginResponse.status, 0);
    const outboxPush = await client2.reader.nextOf(protocol.COMMAND_INCOMING_TEXT, 3000);
    const outboxPlain = protocol.decryptPayload(outboxPush.payload, client2.key);
    assert.deepEqual(parseIncomingText(outboxPlain), { subtype: 9, senderUin: 20002, text: 'offline msg' });
    await sleep(200);
    assert.equal(store.data.outbox.length, 0);
    // 登录就绪即触发私聊历史回放（延迟 20ms 生效），这次登录恰好一次。
    assert.equal(clientReadyCalls.filter((call) => call.uin === 10001).length,
      privateReplayBeforeLogin + 1,
      'a fresh login replays the private history exactly once');

    // ---------- 大好友列表分页（一页 100，避免卡死 QQ2013） ----------
    mock.friends = Array.from({ length: 250 }, (_, index) => ({
      user_id: 21000 + index,
      nickname: 'F' + index,
    }));
    mock.friends.push({ user_id: 10001, nickname: 'self' }); // 个别账号 friend list 会含自己
    await backend.refreshMirror();
    assert.equal(store.get(10001).friends.length, 250, 'self filtered from device friends');
    assert.ok(!store.get(10001).friends.includes(10001), 'device friends must not contain self');

    // 0x0071 状态续页：首请求 cursor=0；续页请求游标不可靠（如 0xFFFFFFF1），
    // 网关按会话状态依次下推，最后一页 final=1 后复位。
    client2.socket.write(buddyDetailsRequest(10001, 30, client2.key, 2, 0));
    let pagePlain = protocol.decryptPayload(
      (await client2.reader.nextOf(protocol.COMMAND_BUDDY_DETAILS, 3000)).payload, client2.key);
    assert.equal(pagePlain.readUInt16BE(1), 100, 'buddy details page 1 size');
    assert.equal(pagePlain[0], 0, 'buddy details page 1 not final');
    client2.socket.write(buddyDetailsRequest(10001, 31, client2.key, 2, 0xFFFFFFF1));
    pagePlain = protocol.decryptPayload(
      (await client2.reader.nextOf(protocol.COMMAND_BUDDY_DETAILS, 3000)).payload, client2.key);
    assert.equal(pagePlain.readUInt16BE(1), 100, 'buddy details page 2 size');
    assert.equal(pagePlain[0], 0, 'buddy details page 2 not final');
    client2.socket.write(buddyDetailsRequest(10001, 32, client2.key, 2, 0xFFFFFFF1));
    pagePlain = protocol.decryptPayload(
      (await client2.reader.nextOf(protocol.COMMAND_BUDDY_DETAILS, 3000)).payload, client2.key);
    assert.equal(pagePlain.readUInt16BE(1), 50, 'buddy details page 3 size');
    assert.equal(pagePlain[0], 1, 'buddy details page 3 final');

    // 0x0069 名册分页：请求带游标，响应 nextCursor=-1 表示结束
    let rosterCursor = 0;
    for (const expected of [100, 100, 50]) {
      client2.socket.write(friendRosterRequest(10001, 40 + rosterCursor, client2.key, rosterCursor));
      const rosterFrame = await client2.reader.nextOf(protocol.COMMAND_FRIEND_ROSTER, 3000);
      const rosterPlain = protocol.decryptPayload(rosterFrame.payload, client2.key);
      const count = rosterPlain.readUInt16BE(2);
      const nextCursor = rosterPlain.readInt16BE(0);
      assert.equal(count, expected, 'roster page size');
      assert.equal(nextCursor, rosterCursor + expected >= 250 ? -1 : rosterCursor + expected,
        'roster next cursor');
      rosterCursor += expected;
    }
    // 塞班在最后一页后会发 cursor=-1，期望全量单页收尾
    client2.socket.write(friendRosterRequest(10001, 46, client2.key, -1));
    const fullRoster = await client2.reader.nextOf(protocol.COMMAND_FRIEND_ROSTER, 3000);
    const fullRosterPlain = protocol.decryptPayload(fullRoster.payload, client2.key);
    assert.equal(fullRosterPlain.readUInt16BE(2), 250, 'cursor=-1 returns full roster');
    assert.equal(fullRosterPlain.readInt16BE(0), -1, 'cursor=-1 full roster final');

    // ---------- 0x00A4 群映射请求：客户端请求时必须回复映射 ----------
    client2.socket.write(protocol.createFrame({
      command: protocol.COMMAND_GROUP_MAPPING,
      sequence: 60,
      uin: 10001,
      payload: protocol.encryptPayload(Buffer.alloc(62), client2.key, deterministicRandom),
    }));
    const mappingFrame = await client2.reader.nextOf(protocol.COMMAND_GROUP_MAPPING, 3000);
    const mappingPlain = protocol.decryptPayload(mappingFrame.payload, client2.key);
    assert.equal(mappingPlain[10], 1, 'group mapping count');
    assert.equal(mappingPlain.readUInt32BE(11), 30003, 'group mapping internal id');

    // QQ2013(Symbian) 的 0x00A4 解码器吃不下大映射：必须回空映射，否则实机崩溃
    qqServer.qqSessions.get(10001).clientFamily = 'symbian_s60';
    client2.socket.write(protocol.createFrame({
      command: protocol.COMMAND_GROUP_MAPPING,
      sequence: 61,
      uin: 10001,
      payload: protocol.encryptPayload(Buffer.alloc(62), client2.key, deterministicRandom),
    }));
    const symbianMapping = await client2.reader.nextOf(protocol.COMMAND_GROUP_MAPPING, 3000);
    const symbianMappingPlain = protocol.decryptPayload(symbianMapping.payload, client2.key);
    assert.equal(symbianMappingPlain[10], 0, 'symbian group mapping must be empty');
    qqServer.qqSessions.get(10001).clientFamily = 'legacy';

    // ---------- 0x0090 群消息设置包（0305000000000004）应应答而非拒绝 ----------
    client2.socket.write(protocol.createFrame({
      command: protocol.COMMAND_GROUP_SEND,
      sequence: 62,
      uin: 10001,
      payload: protocol.encryptPayload(
        Buffer.from([0x03, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04]),
        client2.key, deterministicRandom),
    }));
    const settingsFrame = await client2.reader.nextOf(protocol.COMMAND_GROUP_SEND, 3000);
    assert.equal(settingsFrame.status, 0, 'group message settings packet is acknowledged');
    const settingsState = qqServer.qqSessions.get(10001).groupMessageSettings;
    assert.equal(settingsState.subtype, 3, 'settings subtype recorded');
    assert.equal(settingsState.mode, 5, 'settings mode recorded');

    // ---------- mutedGroupIds 按群屏蔽：被屏蔽群的 0x0094 不推送 ----------
    config.mutedGroupIds = [77777777];
    mock.emit({
      post_type: 'message',
      message_type: 'group',
      group_id: 77777777,
      user_id: 20002,
      self_id: 10001,
      message: [{ type: 'text', data: { text: 'muted' } }],
      time: 888,
    });
    await assert.rejects(
      () => client2.reader.nextOf(protocol.COMMAND_GROUP_MESSAGE, 400),
      /timeout/,
      'muted group must not push 0x0094');
    assert.equal(store.getGroup(77777777), null, 'muted group must not be stubbed');
    config.mutedGroupIds = [];

    // ---------- 群聊历史回放：老客户端群窗口只存内存，靠补推 ----------
    // 客户端上报群接收状态前 0x0094 一律被拦，所以回放只能挂在"首次就绪"之后。
    assert.deepEqual(
      parseHistoricalMedia('看这个【图片】http://10.0.0.2:13981/forward.jsp?bid=331&fileid=abc-123'),
      { images: ['abc-123'], imageText: '看这个[图片]' },
      'a historical image link is turned back into an image block');
    assert.deepEqual(parseHistoricalMedia('纯文本'), { images: [], imageText: '纯文本' },
      'plain history text is left untouched');
    assert.deepEqual(
      parseHistoricalMedia('【图片】http://h/x?fileid=u1 后面【图片】http://h/x?fileid=u2'),
      { images: ['u1', 'u2'], imageText: '[图片] 后面[图片]' },
      'multiple historical images keep their order');
    assert.deepEqual(
      parseHistoricalMedia('【图片】http://h/forward.jsp?bid=331'),
      { images: [], imageText: '【图片】http://h/forward.jsp?bid=331' },
      'a link without a fileid is not treated as an image');

    // 回放本身：按原发送者/原时间逐条补推，图片还原成图片块参数。
    store.saveGroupMessage(30003, 20002, '历史文本一');
    store.saveGroupMessage(30003, 20002,
      '【图片】http://10.0.0.2:13981/forward.jsp?bid=331&fileid=hist-1');
    const replayed = [];
    const historyReport = replayGroupHistory({
      store,
      uin: 10001,
      limit: 5,
      reason: 'self_test',
      groupReceiveFilter: new Set([30003]),
      deliverGroup: (groupId, fromUin, text, context) => {
        replayed.push({ groupId, fromUin, text, context });
        return { delivered: 1 };
      },
    });
    assert.ok(historyReport.messages >= 2, 'recorded messages are replayed');
    assert.equal(historyReport.delivered, historyReport.messages,
      'delivery counts are summed from deliverGroup');
    // 群 30003 里还有本用例早前推送留下的记录，这里只钉住新加的两条排在最后。
    assert.deepEqual(replayed.slice(-2).map((item) => item.text),
      ['历史文本一', '【图片】http://10.0.0.2:13981/forward.jsp?bid=331&fileid=hist-1'],
      'the newest recorded messages are replayed last, in order');
    assert.deepEqual(replayed.slice(-2).map((item) => item.fromUin), [20002, 20002],
      'replayed messages keep the original sender');
    const replayedImage = replayed.slice(-2).find((item) => item.context.images.length > 0);
    assert.deepEqual(replayedImage.context.images, ['hist-1'],
      'a replayed image keeps its media id');
    assert.equal(replayedImage.context.imageText, '[图片]',
      'a replayed image uses the placeholder body so the client rebuilds the block');
    assert.ok(replayedImage.context.timestamp > 0,
      'replayed messages carry their original timestamp');
    // 不在接收清单里的群不回放（推了也会被拦，省一次遍历）。
    const skippedHistory = replayGroupHistory({
      store,
      uin: 10001,
      limit: 5,
      groupReceiveFilter: new Set([999999]),
      deliverGroup: () => {
        throw new Error('groups outside the receive filter must not be replayed');
      },
    });
    assert.equal(skippedHistory.messages, 0, 'groups outside the receive filter are not replayed');
    assert.ok(skippedHistory.skippedGroups >= 1, 'skipped groups are reported');

    // ---------- 私聊历史回放：只补推「对方发的」 ----------
    // 用独立 uin，免得跟别的用例写进 store 的私聊记录互相干扰。
    store.saveMessage(60002, 60001, '私聊历史一');
    store.saveMessage(60001, 60002, '我自己发的不回放');
    store.saveMessage(60002, 60001, '私聊历史二');
    assert.deepEqual(store.privateConversations(60001), [60002],
      'private conversations enumerate the peer, not the account itself');
    assert.deepEqual(
      store.incomingPrivateMessages(60001, 60002, 10).map((message) => message.text),
      ['私聊历史一', '私聊历史二'],
      'only messages sent by the peer are exposed for replay');
    assert.deepEqual(
      store.incomingPrivateMessages(60001, 60002, 1).map((message) => message.text),
      ['私聊历史二'],
      'the private history limit keeps the newest messages');
    const privateReplayed = [];
    const privateReport = replayPrivateHistory({
      store,
      uin: 60001,
      limit: 10,
      reason: 'self_test',
      deliverText: (fromUin, toUin, text, subtype, why) => {
        privateReplayed.push({ fromUin, toUin, text, subtype, why });
        return true;
      },
    });
    assert.equal(privateReport.peers, 1, 'one private conversation is replayed');
    assert.equal(privateReport.messages, 2, 'both incoming private messages are replayed');
    assert.equal(privateReport.delivered, 2, 'every private delivery is counted');
    assert.deepEqual(privateReplayed.map((item) => item.text),
      ['私聊历史一', '私聊历史二'],
      'private history replays peer messages in order');
    assert.ok(privateReplayed.every((item) => item.fromUin === 60002 && item.toUin === 60001),
      'a replayed private message keeps the peer as sender and the account as recipient');
    assert.ok(privateReplayed.every((item) => item.subtype === 9),
      'replayed private messages use the default text subtype');
    assert.ok(privateReplayed.every((item) => item.why === 'self_test'),
      'replayed private messages carry the replay reason');
    // 对方没发过话的账号：没有会话可回放，一次推送都不该发生。
    const emptyPrivateReport = replayPrivateHistory({
      store,
      uin: 70007,
      limit: 10,
      deliverText: () => {
        throw new Error('an account without private history must not push anything');
      },
    });
    assert.equal(emptyPrivateReport.messages, 0,
      'an account without private history replays nothing');
    // 投递失败（设备离线）仍算尝试过，但不计入 delivered。
    const offlinePrivateReport = replayPrivateHistory({
      store,
      uin: 60001,
      limit: 10,
      deliverText: () => false,
    });
    assert.equal(offlinePrivateReport.messages, 2,
      'offline private deliveries are still attempted');
    assert.equal(offlinePrivateReport.delivered, 0,
      'failed private deliveries are not counted as delivered');

    // ---------- 回放水位：掉线重连不再把看过的历史重推一遍 ----------
    // 背景：客户端掉线会自己重连，重连等于重新登录，回放就会重推——
    // 2026-09-20 现场就是加好友那句系统文案被反复当成新消息推。
    // 水位本身（core/replay-cursor.js）：带 TTL，过期即作废。
    let cursorClock = 1000;
    const ttlCursors = createReplayCursors({ ttlMs: 50, now: () => cursorClock });
    ttlCursors.set('probe', 7);
    assert.equal(ttlCursors.get('probe').afterId, 7, 'a fresh cursor is returned');
    assert.equal(ttlCursors.size(), 1, 'setting a cursor stores exactly one entry');
    cursorClock += 49;
    assert.equal(ttlCursors.get('probe').afterId, 7, 'a cursor inside its ttl survives');
    cursorClock += 1;
    assert.equal(ttlCursors.get('probe'), null, 'a cursor past its ttl is dropped');
    assert.equal(ttlCursors.size(), 0, 'expired cursors are dropped from the store');
    // ttl<=0 表示永不过期：水位只随网关进程结束而清空。
    const foreverCursors = createReplayCursors({ ttlMs: 0, now: () => cursorClock });
    foreverCursors.set('probe', 3);
    cursorClock += 365 * 24 * 3600 * 1000;
    assert.equal(foreverCursors.get('probe').afterId, 3, 'ttl<=0 keeps cursors forever');

    // 群回放接上水位：第一轮全量、第二轮空转、第三轮只推增量。
    const groupCursors = createReplayCursors({ ttlMs: 0 });
    const runGroupReplay = () => {
      const seen = [];
      const report = replayGroupHistory({
        store,
        uin: 10001,
        limit: 50,
        reason: 'self_test',
        groupReceiveFilter: new Set([30003]),
        cursors: groupCursors,
        deliverGroup: (groupId, fromUin, text) => {
          seen.push(text);
          return { delivered: 1 };
        },
      });
      return { seen, report };
    };
    const firstGroupPass = runGroupReplay();
    assert.ok(firstGroupPass.report.fresh >= 1 && firstGroupPass.report.resumed === 0,
      'the first replay starts without a cursor');
    assert.ok(firstGroupPass.seen.length > 0, 'the first replay delivers history');
    const secondGroupPass = runGroupReplay();
    assert.equal(secondGroupPass.report.resumed, 1,
      'the second replay resumes from the stored cursor');
    assert.equal(secondGroupPass.report.messages, 0,
      'a reconnect without new group messages replays nothing');
    assert.deepEqual(secondGroupPass.seen, [],
      'no group message is pushed twice after the cursor is stored');
    store.saveGroupMessage(30003, 20002, '水位之后的新群消息');
    const thirdGroupPass = runGroupReplay();
    assert.deepEqual(thirdGroupPass.seen, ['水位之后的新群消息'],
      'only group messages newer than the cursor are replayed');
    assert.equal(thirdGroupPass.report.delivered, 1, 'the incremental group push is counted');

    // 私聊回放接上水位：同一套语义。
    const privateCursors = createReplayCursors({ ttlMs: 0 });
    const runPrivateReplay = () => {
      const seen = [];
      const report = replayPrivateHistory({
        store,
        uin: 60001,
        limit: 50,
        reason: 'self_test',
        cursors: privateCursors,
        deliverText: (fromUin, toUin, text) => {
          seen.push(text);
          return true;
        },
      });
      return { seen, report };
    };
    const firstPrivatePass = runPrivateReplay();
    assert.deepEqual(firstPrivatePass.seen, ['私聊历史一', '私聊历史二'],
      'the first private replay delivers the recorded history');
    assert.equal(firstPrivatePass.report.fresh, 1, 'the first private replay has no cursor');
    const secondPrivatePass = runPrivateReplay();
    assert.equal(secondPrivatePass.report.messages, 0,
      'a reconnect without new private messages replays nothing');
    assert.equal(secondPrivatePass.report.resumed, 1,
      'the second private replay resumes from the stored cursor');
    store.saveMessage(60002, 60001, '水位之后的新私聊');
    const thirdPrivatePass = runPrivateReplay();
    assert.deepEqual(thirdPrivatePass.seen, ['水位之后的新私聊'],
      'only private messages newer than the cursor are replayed');
    // 加好友那句系统文案就是普通私聊消息，水位之后不会再来第二次。
    assert.deepEqual(
      store.incomingPrivateMessages(60001, 60002, 10).map((message) => message.text),
      ['私聊历史一', '私聊历史二', '水位之后的新私聊'],
      'store queries without a cursor still return the full history');

    // ---------- 0x0070 J2ME 群接收状态：1=接收，0=屏蔽 ----------
    mock.groups.push({ group_id: 44444444, group_name: '群2' });
    await backend.refreshMirror();
    client2.socket.write(protocol.createFrame({
      command: protocol.COMMAND_GROUP_SYNC,
      sequence: 63,
      uin: 10001,
      payload: protocol.encryptPayload(groupReceiveStatePayload([
        { receive: false, groupId: 30003 },
        { receive: true, groupId: 44444444 },
        { receive: false, groupId: 0 },
      ]), client2.key, deterministicRandom),
    }));
    const groupStateFrame = await client2.reader.nextOf(protocol.COMMAND_GROUP_SYNC, 3000);
    assert.equal(groupStateFrame.status, 0, '0x0070 group receive state is acknowledged');
    let receiveFilter = qqServer.qqSessions.get(10001).groupReceiveFilter;
    assert.ok(receiveFilter && receiveFilter.has(44444444),
      '0x0070 receive flag enables the selected group');
    assert.ok(!receiveFilter.has(30003), '0x0070 blocked group is excluded');
    assert.ok(events.some((event) => event.event === 'group_receive_state_ok'
      && event.enabledCount === 1 && event.validCount === 2),
    '0x0070 state table ignores zero-ID placeholders and is logged');

    mock.emit({
      post_type: 'message', message_type: 'group',
      group_id: 30003, user_id: 20002, self_id: 10001,
      message: [{ type: 'text', data: { text: 'blocked by 0x0070' } }], time: 775,
    });
    await assert.rejects(
      () => client2.reader.nextOf(protocol.COMMAND_GROUP_MESSAGE, 400),
      /timeout/,
      '0x0070 blocked group must not push 0x0094');
    mock.emit({
      post_type: 'message', message_type: 'group',
      group_id: 44444444, user_id: 20002, self_id: 10001,
      message: [{ type: 'text', data: { text: 'enabled by 0x0070' } }], time: 776,
    });
    const enabledByState = await client2.reader.nextOf(
      protocol.COMMAND_GROUP_MESSAGE, 3000);
    assert.equal(parseGroupMessage(
      protocol.decryptPayload(enabledByState.payload, client2.key)).groupId,
    44444444, '0x0070 enabled group is pushed');

    // ---------- 0x008C 订阅清单仍可覆盖 0x0070 状态 ----------
    client2.socket.write(protocol.createFrame({
      command: protocol.COMMAND_GROUP_RECEIVE_FILTER,
      sequence: 64,
      uin: 10001,
      payload: protocol.encryptPayload(
        groupReceiveFilterPayload([30003]), client2.key, deterministicRandom),
    }));
    const filterFrame = await client2.reader.nextOf(protocol.COMMAND_GROUP_RECEIVE_FILTER, 3000);
    assert.equal(filterFrame.status, 0, '0x008C is acknowledged');
    assert.deepEqual(
      protocol.decryptPayload(filterFrame.payload, client2.key), Buffer.from([0, 0]),
      '0x008C response is result=0 count=0');
    receiveFilter = qqServer.qqSessions.get(10001).groupReceiveFilter;
    assert.ok(receiveFilter && receiveFilter.has(30003), 'filter records group 30003');
    assert.ok(!receiveFilter.has(44444444), 'filter excludes group 44444444');

    // 已经就绪过的会话再上报订阅清单，不会把历史回放第二遍。
    await sleep(80);
    assert.equal(receiveReadyCalls.filter((call) => call.uin === 10001).length, 1,
      'a later 0x008C does not replay the group history a second time');
    // 私聊回放挂在登录就绪上（不依赖群订阅状态），且每次触发都来自登录。
    assert.ok(clientReadyCalls.every((call) => call.reason === 'login'),
      'the private history replay is triggered by login');
    assert.ok(clientReadyCalls.some((call) => call.uin === 10001),
      'client ready triggers the private history replay for the account');

    mock.emit({
      post_type: 'message', message_type: 'group',
      group_id: 30003, user_id: 20002, self_id: 10001,
      message: [{ type: 'text', data: { text: 'in filter' } }], time: 777,
    });
    const inFilter = await client2.reader.nextOf(protocol.COMMAND_GROUP_MESSAGE, 3000);
    assert.equal(parseGroupMessage(protocol.decryptPayload(inFilter.payload, client2.key)).groupId,
      30003, 'group in receive filter is pushed');

    mock.emit({
      post_type: 'message', message_type: 'group',
      group_id: 44444444, user_id: 20002, self_id: 10001,
      message: [{ type: 'text', data: { text: 'not in filter' } }], time: 778,
    });
    await assert.rejects(
      () => client2.reader.nextOf(protocol.COMMAND_GROUP_MESSAGE, 400),
      /timeout/,
      'group outside receive filter must not be pushed');

    // 空清单 = 全部屏蔽
    client2.socket.write(protocol.createFrame({
      command: protocol.COMMAND_GROUP_RECEIVE_FILTER,
      sequence: 65,
      uin: 10001,
      payload: protocol.encryptPayload(
        groupReceiveFilterPayload([]), client2.key, deterministicRandom),
    }));
    await client2.reader.nextOf(protocol.COMMAND_GROUP_RECEIVE_FILTER, 3000);
    mock.emit({
      post_type: 'message', message_type: 'group',
      group_id: 30003, user_id: 20002, self_id: 10001,
      message: [{ type: 'text', data: { text: 'muted all' } }], time: 779,
    });
    await assert.rejects(
      () => client2.reader.nextOf(protocol.COMMAND_GROUP_MESSAGE, 400),
      /timeout/,
      'empty receive filter must block all group pushes');
    qqServer.qqSessions.get(10001).groupReceiveFilter = null;

    // ---------- 未知群事件：占位群必须带全字段写库，且能推送 ----------
    mock.emit({
      post_type: 'message',
      message_type: 'group',
      group_id: 99999999,
      user_id: 20002,
      self_id: 10001,
      message: [{ type: 'text', data: { text: 'stub group' } }],
      time: 999,
    });
    const stub = store.getGroup(99999999);
    assert.ok(stub && stub.createdAt, 'unknown group stub saved with createdAt');
    const stubPush = await client2.reader.nextOf(protocol.COMMAND_GROUP_MESSAGE, 3000);
    const stubPlain = protocol.decryptPayload(stubPush.payload, client2.key);
    assert.equal(parseGroupMessage(stubPlain).groupId, 99999999);

    // ---------- 错误 token 被拒 ----------
    const bad = await openClient(port, 10001, 'wrong-password');
    assert.equal(bad.loginResponse.status, 10);
    assert.equal(events.filter((event) => event.event === 'login_rejected').length, 1);
    bad.socket.destroy();

    // ---------- QQ2013/Symbian 不得收到 J2ME 专用的 0x008A ----------
    const notifyEventsBeforeSymbian = events.filter(
      (event) => event.event === 'group_notify_config_pushed').length;
    const symbianClient = await openSymbianClient(port, 10001, 'nyanya-token');
    assert.equal(symbianClient.loginResponse.status, 0, 'Symbian login succeeds');
    assert.ok(symbianClient.decrypted, 'Symbian login response decrypts');
    const symbianSession = qqServer.qqSessions.get(10001);
    assert.equal(symbianSession.sessionKeyVariant, 'payload_first_16',
      'fixture exercises a Symbian key-marker collision');
    assert.equal(symbianSession.clientFamily, 'symbian_s60',
      'Symbian login fingerprint overrides the ambiguous key variant');
    await assert.rejects(
      () => symbianClient.reader.nextOf(protocol.COMMAND_GROUP_MAPPING, 250),
      /timeout/,
      'Symbian login must not receive an early mapping without group relations');
    await assert.rejects(
      () => symbianClient.reader.nextOf(protocol.COMMAND_GROUP_NOTIFY_CONFIG, 400),
      /timeout/,
      'Symbian session must not receive J2ME group-notify config');
    assert.equal(
      events.filter((event) => event.event === 'group_notify_config_pushed').length,
      notifyEventsBeforeSymbian,
      'Symbian login must not emit group_notify_config_pushed');

    symbianClient.socket.write(protocol.createFrame({
      command: protocol.COMMAND_GROUP_SYNC,
      sequence: 68,
      uin: 10001,
      payload: protocol.encryptPayload(
        Buffer.alloc(0), symbianClient.key, deterministicRandom),
    }));
    const symbianGroupSync = await symbianClient.reader.nextOf(
      protocol.COMMAND_GROUP_SYNC, 3000);
    assert.equal(symbianGroupSync.status, 0, 'Symbian 0x0070 group sync is acknowledged');
    await assert.rejects(
      () => symbianClient.reader.nextOf(protocol.COMMAND_GROUP_NOTIFY_CONFIG, 400),
      /timeout/,
      'Symbian group sync must not trigger J2ME group-notify config');
    assert.equal(
      events.filter((event) => event.event === 'group_notify_config_pushed').length,
      notifyEventsBeforeSymbian,
      'Symbian group sync must not emit group_notify_config_pushed');

    // 群消息在好友详情同步完成前丢弃，避免 QQ2013 在启动解析阶段被异步 0x0094 打断。
    mock.emit({
      post_type: 'message', message_type: 'group',
      group_id: 30003, user_id: 20002, self_id: 10001,
      message: [{ type: 'text', data: { text: 'before buddy sync' } }], time: 1001,
    });
    await assert.rejects(
      () => symbianClient.reader.nextOf(protocol.COMMAND_GROUP_MESSAGE, 400),
      /timeout/,
      'Symbian group push must wait for buddy details sync');

    // 塞班专用 0x0071 分页为 25；最终页完成后才开放群推送。
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      symbianClient.socket.write(buddyDetailsRequest(
        10001, 70 + pageIndex, symbianClient.key, 2,
        pageIndex === 0 ? 0 : 0xFFFFFFF1));
      const details = protocol.decryptPayload(
        (await symbianClient.reader.nextOf(protocol.COMMAND_BUDDY_DETAILS, 3000)).payload,
        symbianClient.key);
      assert.equal(details.readUInt16BE(1), 25, 'Symbian buddy details page size');
      assert.equal(details[0], pageIndex === 9 ? 1 : 0,
        'only the final Symbian buddy page is terminal');
    }
    assert.equal(symbianSession.buddyDetailsSyncComplete, true,
      'Symbian buddy sync is marked complete after the final page');

    // 好友详情完成后仍不能推群消息；QQ2013 还在解析 0x0069 名册。
    mock.emit({
      post_type: 'message', message_type: 'group',
      group_id: 30003, user_id: 20002, self_id: 10001,
      message: [{ type: 'text', data: { text: 'before roster sync' } }], time: 1002,
    });
    await assert.rejects(
      () => symbianClient.reader.nextOf(protocol.COMMAND_GROUP_MESSAGE, 400),
      /timeout/,
      'Symbian group push must also wait for friend roster sync');

    // 塞班专用 0x0069 分页为 25；最后一页完成后才开放群推送。
    let symbianRosterCursor = 0;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      symbianClient.socket.write(friendRosterRequest(
        10001, 90 + pageIndex, symbianClient.key, symbianRosterCursor));
      const roster = protocol.decryptPayload(
        (await symbianClient.reader.nextOf(protocol.COMMAND_FRIEND_ROSTER, 3000)).payload,
        symbianClient.key);
      assert.equal(roster.readUInt16BE(2), 25, 'Symbian friend roster page size');
      const nextCursor = roster.readInt16BE(0);
      assert.equal(nextCursor, pageIndex === 9 ? -1 : symbianRosterCursor + 25,
        'Symbian friend roster next cursor');
      symbianRosterCursor += 25;
    }
    assert.equal(symbianSession.friendRosterSyncComplete, true,
      'Symbian roster sync is marked complete after the final page');

    // 名册完成后先用 0x0054 创建群对象，再用 0x00A4 绑定公开群号。
    const relationFrame = await symbianClient.reader.nextOf(
      protocol.COMMAND_BUDDY_LIST, 3000);
    const relationGroups = parseGroupRelations(protocol.decryptPayload(
      relationFrame.payload, symbianClient.key));
    assert.ok(relationGroups.includes(30003),
      'Symbian group discovery includes a relationType=4 placeholder');
    const mappingPush = await symbianClient.reader.nextOf(
      protocol.COMMAND_GROUP_MAPPING, 3000);
    const mappedGroups = parseGroupMappings(protocol.decryptPayload(
      mappingPush.payload, symbianClient.key));
    assert.ok(mappedGroups.includes(30003),
      'Symbian group discovery maps the placeholder after creating it');
    assert.ok(symbianSession.advertisedGroupIds.has(30003),
      'Symbian mapped group is recorded as advertised');

    const groupInfoRequest = Buffer.alloc(5);
    groupInfoRequest[0] = 4;
    groupInfoRequest.writeUInt32BE(30003, 1);
    symbianClient.socket.write(protocol.createFrame({
      command: protocol.COMMAND_GROUP_SERVICE,
      sequence: 99,
      uin: 10001,
      payload: protocol.encryptPayload(groupInfoRequest, symbianClient.key,
        deterministicRandom),
    }));
    const groupInfoResponse = protocol.decryptPayload(
      (await symbianClient.reader.nextOf(protocol.COMMAND_GROUP_SERVICE, 3000)).payload,
      symbianClient.key);
    assert.equal(groupInfoResponse.readUInt32BE(2), 30003,
      'S60 0x006D/4 response returns the requested internal group ID');
    assert.equal(groupInfoResponse.readUInt32BE(15), 10001,
      'S60 0x006D/4 response keeps the owner at the native field offset');
    const groupInfoEvent = events.find((event) => event.event === 'group_service_ok'
      && event.subtype === 4 && event.groupId === 30003);
    assert.equal(groupInfoEvent.responseProfile, 's60_qq2013');
    assert.equal(groupInfoEvent.responseBytes, groupInfoResponse.length);

    // cursor=-1 是收尾确认，不得再次把全部好友装进一个响应。
    symbianClient.socket.write(friendRosterRequest(10001, 100, symbianClient.key, -1));
    const terminalRoster = protocol.decryptPayload(
      (await symbianClient.reader.nextOf(protocol.COMMAND_FRIEND_ROSTER, 3000)).payload,
      symbianClient.key);
    assert.equal(terminalRoster.readUInt16BE(2), 25,
      'Symbian cursor=-1 roster replay stays capped');
    assert.equal(terminalRoster.readInt16BE(0), -1,
      'Symbian cursor=-1 roster replay remains terminal');

    mock.emit({
      post_type: 'message', message_type: 'group',
      group_id: 30003, user_id: 20002, self_id: 10001,
      message: [{ type: 'text', data: { text: 'after roster sync' } }], time: 1003,
    });
    const symbianGroupPush = await symbianClient.reader.nextOf(
      protocol.COMMAND_GROUP_MESSAGE, 3000);
    assert.equal(parseGroupMessage(protocol.decryptPayload(
      symbianGroupPush.payload, symbianClient.key)).groupId, 30003,
      'mapped group is pushed after Symbian buddy sync');

    mock.emit({
      post_type: 'message', message_type: 'group',
      group_id: 88888888, user_id: 20002, self_id: 10001,
      message: [{ type: 'text', data: { text: 'unmapped Symbian group' } }], time: 1004,
    });
    const dynamicRelation = await symbianClient.reader.nextOf(
      protocol.COMMAND_BUDDY_LIST, 3000);
    assert.ok(parseGroupRelations(protocol.decryptPayload(
      dynamicRelation.payload, symbianClient.key)).includes(88888888),
    'a newly observed group gets a dynamic relation placeholder');
    const dynamicMapping = await symbianClient.reader.nextOf(
      protocol.COMMAND_GROUP_MAPPING, 3000);
    assert.ok(parseGroupMappings(protocol.decryptPayload(
      dynamicMapping.payload, symbianClient.key)).includes(88888888),
    'a newly observed group gets a dynamic mapping');
    await assert.rejects(
      () => symbianClient.reader.nextOf(protocol.COMMAND_GROUP_MESSAGE, 400),
      /timeout/,
      'the first message waits while a newly observed group is being mapped');
    mock.emit({
      post_type: 'message', message_type: 'group',
      group_id: 88888888, user_id: 20002, self_id: 10001,
      message: [{ type: 'text', data: { text: 'mapped Symbian group' } }], time: 1005,
    });
    const dynamicGroupPush = await symbianClient.reader.nextOf(
      protocol.COMMAND_GROUP_MESSAGE, 3000);
    assert.equal(parseGroupMessage(protocol.decryptPayload(
      dynamicGroupPush.payload, symbianClient.key)).groupId, 88888888,
    'later messages from the dynamically mapped group are delivered');
    symbianClient.socket.destroy();

    // ---------- WAP 看图页：bid=331 用 pic（图片块的 uuid）取图 ----------
    // 群图片块里客户端拼的是 &pic=<uuid>&fileid=<十进制>，两个参数都要能取到图。
    {
      const wap = createMobileGroupServer({ store, logger: () => {} });
      const wapPort = await new Promise((resolve, reject) => {
        wap.on('error', reject);
        wap.listen(0, '127.0.0.1', () => resolve(wap.address().port));
      });
      try {
        const png = Buffer.from(
          '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
        const media = store.saveMedia({
          from: 20002, to: 10001, filename: 'view.png', mimeType: 'image/png',
          mediaType: 2, size: png.length,
          sha256: require('node:crypto').createHash('sha256').update(png).digest('hex'),
          legacyHash: Buffer.alloc(0), content: png,
        });
        // 这份 QQ2011 的内置浏览器（iw.class）只认 text/vnd.wap.wml：
        // 收到 text/html 会弹自己的「错误代码 005 页面类型暂不支持」。所以手机必须拿 WML。
        const legacyAccept = 'text/vnd.wap.wml,image/*,audio/*,'
          + 'text/vnd.sun.j2me.app-descriptor,application/*';
        const request = async (query, accept) => {
          const response = await fetch(
            `http://127.0.0.1:${wapPort}/forward.jsp?bid=331&${query}`,
            accept ? { headers: { accept } } : undefined);
          return {
            status: response.status,
            type: response.headers.get('content-type'),
            bytes: Buffer.from(await response.arrayBuffer()),
          };
        };
        const byPic = await request(`pic=${encodeURIComponent(media.id)}`, legacyAccept);
        assert.equal(byPic.status, 200, 'bid=331 resolves the picture from pic (the block uuid)');
        assert.match(byPic.type, /^text\/vnd\.wap\.wml/,
          'the legacy client must get WML — it answers text/html with error 005');
        const wmlBody = byPic.bytes.toString('utf8');
        assert.ok(wmlBody.includes('<wml>') && wmlBody.includes('<img '),
          'the deck embeds the picture so the built-in browser fetches the raw image');
        assert.ok(wmlBody.includes(`/mobile/media/${encodeURIComponent(media.id)}/raw`),
          'the img src points at the raw media endpoint');
        // 老客户端会把 <img alt="…"> 的 alt 当正文渲染，图片上方会多出一行“图片”。
        // WML 1.1 又要求 alt 属性存在，所以留空串；这里锁死这个约定防回退。
        assert.ok(wmlBody.includes('alt=""') && !wmlBody.includes('alt="图片"'),
          'the WML img keeps an empty alt so the legacy browser shows no stray caption');
        const byFileId = await request(`fileid=${encodeURIComponent(media.id)}`, legacyAccept);
        assert.equal(byFileId.status, 200, 'older fileid-only links still resolve');
        const byPage = await request(`pic=${encodeURIComponent(media.id)}&page=1`);
        assert.equal(byPage.status, 200, '&page=1 still serves the HTML wrapper for desktop');
        assert.ok(byPage.bytes.toString('utf8').includes(encodeURIComponent(media.id)),
          'the wrapper page points back at the media id with an absolute URL');
        const desktop = await request(`pic=${encodeURIComponent(media.id)}`);
        assert.match(desktop.type, /^text\/html/,
          'a normal browser (no WML in Accept) still gets the HTML wrapper');
        const missing = await request('pic=does-not-exist', legacyAccept);
        assert.equal(missing.status, 404, 'an unknown pic returns 404 instead of crashing');
        // /mobile/media/<id> 也要跟着协商，否则私聊消息里的图片链接照样是 005。
        const mediaPageResponse = await fetch(
          `http://127.0.0.1:${wapPort}/mobile/media/${encodeURIComponent(media.id)}`,
          { headers: { accept: legacyAccept } });
        assert.match(mediaPageResponse.headers.get('content-type'), /^text\/vnd\.wap\.wml/,
          'the plain media page also speaks WML to the legacy browser');
        assert.ok((await mediaPageResponse.text()).includes('<img '),
          'the media card embeds the picture too');
        const rawResponse = await fetch(
          `http://127.0.0.1:${wapPort}/mobile/media/${encodeURIComponent(media.id)}/raw`);
        assert.ok(Buffer.from(await rawResponse.arrayBuffer()).equals(png),
          'the raw endpoint still round-trips the original bytes');

        // ---------- WAP 群聊天记录页：手机菜单「群聊天记录」走 bid=202 ----------
        // 客户端 ee.java:1106（菜单 action 10）拼的是
        // forward.jsp?bid=202&groupID=<群id>&fqq=<自己QQ号>，标题写死「群聊天记录」。
        // 这一页以前回的是 text/html，手机的内置浏览器直接判 005 —— 用户看到的就是
        // 「没有聊天记录」。所以：内容必须是记录，类型必须是 WML。
        const wapGet = async (path, accept) => {
          const response = await fetch(`http://127.0.0.1:${wapPort}${path}`,
            accept ? { headers: { accept } } : undefined);
          return {
            status: response.status,
            type: response.headers.get('content-type'),
            body: await response.text(),
          };
        };
        const historyGroup = store.getGroup(30003);
        assert.ok(historyGroup, 'group 30003 is still available for the history page');
        const historyRows = store.recentGroupMessages(historyGroup.id, 50);
        assert.ok(historyRows.length > 0,
          'the pushed group message was stored, so the history page has something to show');
        const historyPath = `/forward.jsp?bid=202&groupID=${historyGroup.id}&fqq=10001`;
        const wmlHistory = await wapGet(historyPath, legacyAccept);
        assert.equal(wmlHistory.status, 200, 'bid=202 (phone menu 群聊天记录) answers');
        assert.match(wmlHistory.type, /^text\/vnd\.wap\.wml/,
          'the group history page must speak WML — the phone answers text/html with error 005');
        assert.ok(wmlHistory.body.includes('<wml>') && !wmlHistory.body.includes('<ul>'),
          'the WML history deck uses WML-only markup (no ul/li/b)');
        assert.ok(wmlHistory.body.includes(historyRows[historyRows.length - 1].text),
          'the WML history deck lists the most recent group message');
        // WML 的 `$` 是变量引用，正文里的 `$` 必须转义，否则消息会被吃掉一段。
        store.saveGroupMessage(historyGroup.id, 20002, 'total is $5');
        const dollarHistory = await wapGet(historyPath, legacyAccept);
        assert.ok(dollarHistory.body.includes('$$5'),
          'a literal $ in a message is escaped as $$ for WML variable syntax');
        // 图片消息里嵌的是网关自己拼的链接，WML 里要变成可点的 <a>，不能糊一串 URL。
        store.saveGroupMessage(historyGroup.id, 20002,
          '看图 【图片】http://192.168.1.3:13981/forward.jsp?bid=331&fileid=abc');
        const imageHistory = await wapGet(historyPath, legacyAccept);
        assert.ok(imageHistory.body.includes('<a href="http://192.168.1.3:13981/forward.jsp?bid=331&amp;fileid=abc">【图片】</a>'),
          'a media link inside a message becomes a tappable WML anchor');
        const htmlHistory = await wapGet(historyPath);
        assert.match(htmlHistory.type, /^text\/html/,
          'a desktop browser still gets the HTML history page');
        assert.ok(htmlHistory.body.includes('<ul>'),
          'the HTML history page keeps its list markup');
        const wmlRoster = await wapGet(
          `/forward.jsp?bid=203&groupID=${historyGroup.id}`, legacyAccept);
        assert.match(wmlRoster.type, /^text\/vnd\.wap\.wml/,
          'bid=203 (group roster) also speaks WML now');
        assert.ok(wmlRoster.body.includes(historyGroup.title),
          'the WML roster carries the group title');
        // 挑一个确定不存在的群号：getGroup 会同时匹配 id 和 publicId，别撞上测试里的群。
        let freeGroupId = 2147483647;
        while (store.getGroup(freeGroupId)) freeGroupId -= 1;
        const missingGroup = await wapGet(
          `/forward.jsp?bid=202&groupID=${freeGroupId}`, legacyAccept);
        assert.equal(missingGroup.status, 404, 'an unknown group still returns 404');
        assert.match(missingGroup.type, /^text\/vnd\.wap\.wml/,
          'the missing-group 404 is WML too, not an HTML error page the phone cannot read');
      } finally {
        wap.close();
      }
    }

    process.stdout.write('nyanya gateway self-test passed.\n');
  } finally {
    try { qqServer.closeAllConnections(); } catch (err) {}
    try { qqServer.close(); } catch (err) {}
    try { backend.stop(); } catch (err) {}
    try { store.close(); } catch (err) {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
