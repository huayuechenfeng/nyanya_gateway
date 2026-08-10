'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const protocol = require('./legacy/protocol');
const { AccountStore, defaultData } = require('./legacy/store');
const { createQQServer } = require('./legacy/server');
const { NapCatBackend } = require('./core/napcat-backend');
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

async function main() {
  assertSymbianGroupInfoLayout();
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

    const client2 = await openClient(port, 10001, 'nyanya-token');
    assert.equal(client2.loginResponse.status, 0);
    const outboxPush = await client2.reader.nextOf(protocol.COMMAND_INCOMING_TEXT, 3000);
    const outboxPlain = protocol.decryptPayload(outboxPush.payload, client2.key);
    assert.deepEqual(parseIncomingText(outboxPlain), { subtype: 9, senderUin: 20002, text: 'offline msg' });
    await sleep(200);
    assert.equal(store.data.outbox.length, 0);

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
