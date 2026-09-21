'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const net = require('node:net');
const jce = require('./jce');
const protocol = require('./protocol');
const qqtea = require('./qqtea');
const symbian = require('./symbian-protocol');
const { createQQServer } = require('./server');
const { AccountStore, defaultData } = require('./store');

function deterministicRandom(size) {
  const output = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index += 1) output[index] = (index * 37 + 11) & 0xFF;
  return output;
}

function javaTea(operation, input, key) {
  const classPath = process.env.QQ_TEA_HARNESS_CP;
  if (!classPath) throw new Error('QQ_TEA_HARNESS_CP is not set');
  const codecClass = process.env.QQ_TEA_CODEC_CLASS || 'co';
  return childProcess.execFileSync('java', [
    '-cp', classPath, 'ClientTeaHarness', codecClass, operation,
    input.toString('hex'), key.toString('hex'),
  ], { encoding: 'utf8' }).trim();
}

class FrameReader {
  constructor(socket) {
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.frames = [];
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
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
}

function getKeyRequest(uin, sequence) {
  const first = Buffer.alloc(16, 0x41);
  const second = Buffer.from('test', 'ascii');
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
  // MobileQQ 12.0.16 always follows the digest with a TLV count. With no
  // redirect data it emits type 4 (15 bytes) and type 7 (one byte, value 8).
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

async function integrationTest() {
  const events = [];
  const fixedSessionKey = Buffer.from('10203040506000108090a0b0c0d0e0f0', 'hex');
  const store = new AccountStore(null, defaultData());
  const server = createQQServer({
    store,
    logger: (event) => events.push(event),
    sessionKeyFactory: () => Buffer.from(fixedSessionKey),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const socket = net.createConnection({ host: '127.0.0.1', port: address.port });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const reader = new FrameReader(socket);
  const first = getKeyRequest(10001, 7);
  socket.write(first.subarray(0, 5));
  socket.write(first.subarray(5));
  const keyResponse = await reader.next();
  assert.equal(keyResponse.command, protocol.COMMAND_GET_KEY);
  assert.equal(keyResponse.status, 0);
  assert.equal(keyResponse.payload.length, 17);
  const sessionKey = keyResponse.payload.subarray(0, 16);

  const second = loginRequest(10001, 8, sessionKey, 'qqtest123');
  socket.write(second.subarray(0, 2));
  socket.write(second.subarray(2, 19));
  socket.write(second.subarray(19));
  const loginResponse = await reader.next();
  assert.equal(loginResponse.command, protocol.COMMAND_LOGIN);
  assert.equal(loginResponse.status, 0);
  const success = protocol.decryptPayload(loginResponse.payload, sessionKey);
  assert.ok(success);
  assert.equal(success.length, 58);
  assert.equal(success[50], 1);
  assert.equal(success[51], 1);
  assert.equal(success.readUInt16BE(52), 4);

  socket.write(protocol.createFrame({
    command: protocol.COMMAND_AUXILIARY_KEY,
    sequence: 9,
    uin: 10001,
    payload: protocol.encryptPayload(Buffer.from([4]), sessionKey, deterministicRandom),
  }));
  const auxiliaryResponse = await reader.next();
  const auxiliary = protocol.decryptPayload(auxiliaryResponse.payload, sessionKey);
  assert.equal(auxiliaryResponse.command, protocol.COMMAND_AUXILIARY_KEY);
  assert.equal(auxiliaryResponse.status, 0);
  assert.equal(auxiliary.length, 19);
  assert.equal(auxiliary[18], 0);

  const cursors = Buffer.alloc(8);
  socket.write(protocol.createFrame({
    command: protocol.COMMAND_BUDDY_LIST,
    sequence: 10,
    uin: 10001,
    payload: protocol.encryptPayload(cursors, sessionKey, deterministicRandom),
  }));
  const buddyResponse = await reader.next();
  const buddyList = protocol.decryptPayload(buddyResponse.payload, sessionKey);
  assert.equal(buddyResponse.command, protocol.COMMAND_BUDDY_LIST);
  assert.equal(buddyResponse.status, 0);
  assert.deepEqual(buddyList, Buffer.alloc(9));

  socket.write(protocol.createFrame({
    command: protocol.COMMAND_BUDDY_DETAILS,
    sequence: 11,
    uin: 10001,
    payload: protocol.encryptPayload(Buffer.from([2, 0, 0, 0, 0]), sessionKey, deterministicRandom),
  }));
  const detailsResponse = await reader.next();
  const details = protocol.decryptPayload(detailsResponse.payload, sessionKey);
  assert.equal(detailsResponse.command, protocol.COMMAND_BUDDY_DETAILS);
  assert.equal(details[0], 1);
  assert.equal(details.readUInt16BE(1), 1);
  assert.equal(details.readUInt32BE(3), 10001);
  assert.equal(details.readUInt16BE(14), 10);
  assert.equal(details.length, 41);

  socket.write(protocol.createFrame({
    command: protocol.COMMAND_BUDDY_TOKENS,
    sequence: 111,
    uin: 10001,
    payload: protocol.encryptPayload(Buffer.from([1, 0, 0]), sessionKey, deterministicRandom),
  }));
  const tokenResponse = await reader.next();
  const tokenPayload = protocol.decryptPayload(tokenResponse.payload, sessionKey);
  assert.equal(tokenResponse.command, protocol.COMMAND_BUDDY_TOKENS);
  assert.equal(tokenResponse.sequence, 111);
  assert.equal(tokenResponse.status, 0);
  assert.deepEqual(tokenPayload, Buffer.from([1, 0xFF, 0xFF, 0]));

  socket.write(protocol.createFrame({
    command: protocol.COMMAND_EXTENDED_SERVICE,
    sequence: 12,
    uin: 10001,
    payload: protocol.encryptPayload(Buffer.from([0x1F, 2, 0, 0, 0, 0]), sessionKey, deterministicRandom),
  }));
  const extendedResponse = await reader.next();
  const extended = protocol.decryptPayload(extendedResponse.payload, sessionKey);
  assert.equal(extendedResponse.command, protocol.COMMAND_EXTENDED_SERVICE);
  assert.equal(extended[0], 0x1F);
  assert.equal(extended[1], 0);
  assert.equal(extended.length, 8);

  const query = protocol.encodeLegacyText('10002');
  const searchRequest = Buffer.alloc(13 + query.length);
  searchRequest.writeUInt16BE(query.length, 5);
  query.copy(searchRequest, 7);
  socket.write(protocol.createFrame({
    command: protocol.COMMAND_SEARCH_USER,
    sequence: 13,
    uin: 10001,
    payload: protocol.encryptPayload(searchRequest, sessionKey, deterministicRandom),
  }));
  const searchResponse = await reader.next();
  const search = protocol.decryptPayload(searchResponse.payload, sessionKey);
  assert.equal(search.readUInt16BE(0), 1);
  assert.equal(search.readUInt32BE(2), 10002);

  const profileRequest = Buffer.alloc(6);
  profileRequest.writeUInt16BE(2, 0);
  profileRequest.writeUInt32BE(10002, 2);
  socket.write(protocol.createFrame({
    command: protocol.COMMAND_USER_PROFILE,
    sequence: 14,
    uin: 10001,
    payload: protocol.encryptPayload(profileRequest, sessionKey, deterministicRandom),
  }));
  const profileResponse = await reader.next();
  const profile = protocol.decryptPayload(profileResponse.payload, sessionKey);
  assert.equal(profile.readUInt16BE(0), 2);
  assert.equal(profile.readUInt32BE(2), 10002);

  profileRequest.writeUInt16BE(3, 0);
  socket.write(protocol.createFrame({
    command: protocol.COMMAND_USER_PROFILE,
    sequence: 141,
    uin: 10001,
    payload: protocol.encryptPayload(profileRequest, sessionKey, deterministicRandom),
  }));
  const detailedProfileResponse = await reader.next();
  const detailedProfile = protocol.decryptPayload(detailedProfileResponse.payload, sessionKey);
  assert.equal(detailedProfile.readUInt16BE(0), 3);
  assert.equal(detailedProfile.readUInt32BE(2), 10002);
  assert.ok(detailedProfile.length >= 67, 'subtype 3 must include every field consumed by the client');

  // The W995 search-results screen first emits exactly four bytes containing
  // the target UIN. Result/decision 0 tells its callback to continue with the
  // 0x0093 request below.
  const preflightRequest = Buffer.alloc(4);
  preflightRequest.writeUInt32BE(10002, 0);
  socket.write(protocol.createFrame({
    command: protocol.COMMAND_FRIEND_PREFLIGHT,
    sequence: 142,
    uin: 10001,
    payload: protocol.encryptPayload(preflightRequest, sessionKey, deterministicRandom),
  }));
  const preflightResponse = await reader.next();
  const preflight = protocol.decryptPayload(preflightResponse.payload, sessionKey);
  assert.equal(preflightResponse.command, protocol.COMMAND_FRIEND_PREFLIGHT);
  assert.equal(preflightResponse.sequence, 142);
  assert.deepEqual(preflight, Buffer.from([0, 0, 0x27, 0x12, 0, 0]));

  // Its next request is action 0, target UIN, and the two-byte [1, 0] option.
  // The UI only leaves its progress screen when command and sequence both
  // match this second request.
  const directFriendRequest = Buffer.alloc(7);
  directFriendRequest[0] = 0;
  directFriendRequest.writeUInt32BE(10002, 1);
  directFriendRequest[5] = 1;
  socket.write(protocol.createFrame({
    command: protocol.COMMAND_FRIEND_RESULT,
    sequence: 143,
    uin: 10001,
    payload: protocol.encryptPayload(directFriendRequest, sessionKey, deterministicRandom),
  }));
  const directFriendResponse = await reader.next();
  const directFriendResult = protocol.decryptPayload(directFriendResponse.payload, sessionKey);
  assert.equal(directFriendResponse.command, protocol.COMMAND_FRIEND_RESULT);
  assert.equal(directFriendResponse.sequence, 143);
  assert.equal(directFriendResult[0], 0);
  assert.equal(directFriendResult.readUInt32BE(1), 10002);
  assert.equal(directFriendResult[5], 0);
  assert.equal(store.get(10001).friends.includes(10002), false);
  assert.equal(store.get(10002).incomingRequests.some(
    (request) => request.from === 10001), true);
  assert.equal(store.acceptFriend(10002, 10001).ok, true);
  server.pushFriendAccepted(10002, 10001, 'self_test_accepted');
  const directFriendAcceptance = await reader.next();
  assert.equal(directFriendAcceptance.command, protocol.COMMAND_FRIEND_RESULT);
  const directFriendUpdate = await reader.next();
  assert.equal(directFriendUpdate.command, protocol.COMMAND_USER_PROFILE);
  const directFriendProfile = protocol.decryptPayload(directFriendUpdate.payload, sessionKey);
  assert.equal(directFriendProfile.readUInt16BE(0), 2);
  assert.equal(directFriendProfile.readUInt32BE(2), 10002);

  socket.write(protocol.createFrame({
    command: protocol.COMMAND_FRIEND_ROSTER,
    sequence: 144,
    uin: 10001,
    payload: protocol.encryptPayload(Buffer.from([0, 0, 0]), sessionKey, deterministicRandom),
  }));
  const rosterResponse = await reader.next();
  const roster = protocol.decryptPayload(rosterResponse.payload, sessionKey);
  assert.equal(rosterResponse.command, protocol.COMMAND_FRIEND_ROSTER);
  assert.equal(rosterResponse.sequence, 144);
  assert.equal(roster.readInt16BE(0), -1);
  assert.equal(roster.readUInt16BE(2), 1);
  assert.equal(roster.readUInt32BE(4), 10002);
  assert.equal(protocol.decodeLegacyText(roster.subarray(17, 17 + roster[16])), 'J2ME-B');

  socket.write(protocol.createFrame({
    command: protocol.COMMAND_FRIEND_ACTION,
    sequence: 145,
    uin: 10001,
    payload: protocol.encryptPayload(Buffer.from([2, 0, 0]), sessionKey, deterministicRandom),
  }));
  const friendServiceResponse = await reader.next();
  const friendServiceAck = protocol.decryptPayload(friendServiceResponse.payload, sessionKey);
  assert.equal(friendServiceResponse.command, protocol.COMMAND_FRIEND_ACTION);
  assert.equal(friendServiceResponse.sequence, 145);
  assert.equal(friendServiceResponse.status, 0);
  assert.deepEqual(friendServiceAck, Buffer.from([2]));

  const friendMessage = protocol.encodeLegacyText('LAN test');
  const friendRequest = Buffer.alloc(21 + friendMessage.length);
  friendRequest[0] = 1;
  friendRequest.writeUInt32BE(10002, 2);
  friendRequest.writeUInt16BE(friendMessage.length, 7);
  friendMessage.copy(friendRequest, 9);
  socket.write(protocol.createFrame({
    command: protocol.COMMAND_FRIEND_ACTION,
    sequence: 15,
    uin: 10001,
    payload: protocol.encryptPayload(friendRequest, sessionKey, deterministicRandom),
  }));
  const friendResponse = await reader.next();
  const friendAck = protocol.decryptPayload(friendResponse.payload, sessionKey);
  assert.deepEqual(friendAck, Buffer.from([1, 0]));
  const friendResult = await reader.next();
  assert.equal(friendResult.command, protocol.COMMAND_FRIEND_RESULT);
  const friendResultPayload = protocol.decryptPayload(friendResult.payload, sessionKey);
  assert.equal(friendResultPayload[0], 0);
  assert.equal(friendResultPayload.readUInt32BE(1), 10002);
  assert.equal(friendResultPayload[5], 0);
  const friendUpdate = await reader.next();
  assert.equal(friendUpdate.command, protocol.COMMAND_USER_PROFILE);
  const added = protocol.decryptPayload(friendUpdate.payload, sessionKey);
  assert.equal(added.readUInt16BE(0), 2);
  assert.equal(added.readUInt32BE(2), 10002);

  const socketB = net.createConnection({ host: '127.0.0.1', port: address.port });
  await new Promise((resolve, reject) => {
    socketB.once('connect', resolve);
    socketB.once('error', reject);
  });
  const readerB = new FrameReader(socketB);
  socketB.write(getKeyRequest(10002, 20));
  const keyResponseB = await readerB.next();
  const sessionKeyB = keyResponseB.payload.subarray(0, 16);
  socketB.write(loginRequest(10002, 21, sessionKeyB, 'qqtest456'));
  const loginResponseB = await readerB.next();
  assert.equal(loginResponseB.status, 0);
  const onlinePushForA = await reader.next();
  assert.equal(onlinePushForA.command, protocol.COMMAND_BUDDY_DETAILS);
  const onlinePresenceForA = protocol.decryptPayload(onlinePushForA.payload, sessionKey);
  assert.equal(onlinePresenceForA.readUInt32BE(3), 10002);
  assert.equal(onlinePresenceForA.readUInt16BE(14), 10);

  socketB.write(protocol.createFrame({
    command: protocol.COMMAND_BUDDY_LIST,
    sequence: 22,
    uin: 10002,
    payload: protocol.encryptPayload(Buffer.alloc(8), sessionKeyB, deterministicRandom),
  }));
  const buddyResponseB = await readerB.next();
  const buddyListB = protocol.decryptPayload(buddyResponseB.payload, sessionKeyB);
  assert.equal(buddyListB.length, 15);
  assert.equal(buddyListB.readUInt32BE(9), 10001);
  assert.equal(buddyListB[13], 1);
  assert.equal(buddyListB[14] >> 2 & 0x0F, 0);

  const text = protocol.encodeLegacyText('hello B');
  const sendText = Buffer.alloc(6 + text.length + 16);
  sendText.writeUInt32BE(10002, 0);
  sendText.writeUInt16BE(text.length + 16, 4);
  text.copy(sendText, 6);
  socket.write(protocol.createFrame({
    command: protocol.COMMAND_SEND_TEXT,
    sequence: 16,
    uin: 10001,
    payload: protocol.encryptPayload(sendText, sessionKey, deterministicRandom),
  }));
  const sendAck = await reader.next();
  assert.equal(sendAck.command, protocol.COMMAND_SEND_TEXT);
  assert.equal(sendAck.status, 0);
  const incomingFrame = await readerB.next();
  assert.equal(incomingFrame.command, protocol.COMMAND_INCOMING_TEXT);
  const incoming = protocol.decryptPayload(incomingFrame.payload, sessionKeyB);
  assert.equal(incoming.readUInt16BE(0), 9);
  assert.ok(incoming.readUInt32BE(2) > 0);
  assert.equal(incoming.readUInt32BE(6), 10001);
  assert.equal(incoming.readUInt16BE(10), protocol.encodeLegacyText('hello B').length);
  assert.equal(protocol.decodeLegacyText(incoming.subarray(12)), 'hello B');

  socket.write(protocol.createFrame({
    command: protocol.COMMAND_MEDIA_TRANSFER,
    sequence: 17,
    uin: 10001,
    payload: protocol.encryptPayload(Buffer.from([1, 2, 3, 4]), sessionKey,
      deterministicRandom),
  }));
  const mediaAcknowledgement = await reader.next();
  assert.equal(mediaAcknowledgement.command, protocol.COMMAND_MEDIA_TRANSFER);
  assert.equal(mediaAcknowledgement.sequence, 17);
  assert.equal(mediaAcknowledgement.status, 0);
  const mediaPlain = protocol.decryptPayload(mediaAcknowledgement.payload, sessionKey);
  assert.equal(mediaPlain.readUInt16BE(32), 11);
  assert.equal(mediaPlain[50], 2);

  socket.end();
  socketB.end();
  await new Promise((resolve) => server.close(resolve));
  assert.ok(events.some((event) => event.event === 'get_key_ok'));
  assert.ok(events.some((event) => event.event === 'login_ok'));
  assert.ok(events.some((event) => event.event === 'auxiliary_key_ok'));
  assert.ok(events.some((event) => event.event === 'buddy_list_ok'));
  assert.ok(events.some((event) => event.event === 'friend_roster_ok'
    && event.requestCursor === 0 && event.count === 1));
  assert.ok(events.some((event) => event.event === 'buddy_details_ok'));
  assert.ok(events.some((event) => event.event === 'buddy_tokens_ok'
    && event.subtype === 1 && event.cursor === 0));
  assert.ok(events.some((event) => event.event === 'extended_service_ok'));
  assert.ok(events.some((event) => event.event === 'search_ok'));
  assert.ok(events.some((event) => event.event === 'friend_preflight_ok'
    && event.sequence === 142 && event.targetUin === 10002));
  assert.ok(events.some((event) => event.event === 'friend_result_action_ok'
    && event.action === 0 && event.sequence === 143));
  assert.ok(events.some((event) => event.event === 'friend_action_ok'));
  assert.ok(events.some((event) => event.event === 'friend_service_ok'
    && event.subtype === 2 && event.requestHex === '020000'));
  assert.ok(events.some((event) => event.event === 'message_sent' && event.delivered));
  assert.ok(events.some((event) => event.event === 'media_signaling_acknowledged'));
}

async function symbianSessionKeyTest() {
  const events = [];
  const wireKey = Buffer.from('10203040506000108090a0b0c0d0e0f0', 'hex');
  const symbianStore = new AccountStore(null, defaultData());
  symbianStore.requestFriend(10001, 10002, 'Symbian roster test');
  symbianStore.acceptFriend(10002, 10001);
  const symbianGroup = symbianStore.createGroup({
    ownerUin: 10001,
    memberUins: [10002],
    title: 'Symbian group relation test',
  });
  const symbianGroupTwo = symbianStore.createGroup({
    ownerUin: 10001,
    memberUins: [10002],
    title: 'Second Symbian group',
  });
  const symbianGroupThree = symbianStore.createGroup({
    ownerUin: 10001,
    memberUins: [10002],
    title: 'Third Symbian group',
  });
  const server = createQQServer({
    store: symbianStore,
    logger: (event) => events.push(event),
    sessionKeyFactory: () => Buffer.from(wireKey),
    symbianGroupDiscoveryDelayMs: 10,
    symbianGroupDiscoveryIntervalMs: 10,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port });
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const reader = new FrameReader(socket);
    const request = getKeyRequest(10001, 90);
    socket.write(request);
    const keyResponse = await reader.next();
    assert.deepEqual(keyResponse.payload.subarray(0, 16), wireKey);
    const effectiveKey = protocol.deriveSymbianSessionKey(wireKey, request.subarray(14, -1));
    assert.equal(effectiveKey[6], 0x41);
    socket.write(loginRequest(10001, 91, effectiveKey, 'qqtest123'));
    const loginResponse = await reader.next();
    assert.equal(loginResponse.status, 0);
    assert.ok(protocol.decryptPayload(loginResponse.payload, effectiveKey));

    const discussRequest = Buffer.from(
      '0021515153657276696365446973637573735376632e52657147657444697363757373'
      + '0000a8000000a810022c3c4001561351515365727669636544697363757373537663'
      + '660d526571476574446973637573737d000071080002061044697363757373526571'
      + '486561646572180001061a5151536572766963652e44697363757373526571486561'
      + '6465721d0000050a0104c00b060d5265714765744469736375737318000106175151'
      + '536572766963652e526571476574446973637573731d0000050a0127110b8c980ca8'
      + '0c00',
      'hex',
    );
    socket.write(protocol.createFrame({
      command: symbian.COMMAND_WUP,
      sequence: 92,
      uin: 10001,
      payload: protocol.encryptPayload(discussRequest, effectiveKey, deterministicRandom),
    }));
    const discussFrame = await reader.next();
    assert.equal(discussFrame.command, symbian.COMMAND_WUP);
    assert.equal(discussFrame.status, 0);
    const discussEnvelope = symbian.parseWupResponseEnvelope(
      protocol.decryptPayload(discussFrame.payload, effectiveKey));
    assert.equal(discussEnvelope.route, symbian.ROUTE_GET_DISCUSS);
    assert.equal(discussEnvelope.response.requestId, 1);
    assert.equal(discussEnvelope.response.result, 0);
    assert.equal(
      discussEnvelope.response.parameters
        .get('DiscussRespHeader').get('QQService.DiscussRespHeader').toString('hex'),
      '0a0c16000b',
    );
    assert.equal(
      discussEnvelope.response.parameters
        .get('RespGetDiscuss').get('QQService.RespGetDiscuss').toString('hex'),
      '0a090c0b',
    );

    const accostRequest = Buffer.from(
      '01006e0000006e10022c3c400156094163636f7374537672660b434d445f474554'
      + '5f4d73677d00004308000106095265714765744d7367180001061a4d6573736167'
      + '655376634163636f73742e5265714765744d73671d0000120a012711322002844d'
      + '4c500362070e08140b8c980ca80c00',
      'hex',
    );
    const parsedAccostRequest = symbian.parseAccostEnvelope(accostRequest);
    assert.equal(parsedAccostRequest.protocolVersion, 1);
    assert.equal(parsedAccostRequest.request.servant, symbian.ACCOST_SERVANT);
    assert.equal(parsedAccostRequest.request.functionName, symbian.ACCOST_GET_MESSAGE);
    assert.equal(parsedAccostRequest.request.requestId, 1);
    socket.write(protocol.createFrame({
      command: symbian.COMMAND_MESSAGE_ACCOST,
      sequence: 921,
      uin: 10001,
      payload: protocol.encryptPayload(accostRequest, effectiveKey, deterministicRandom),
    }));
    const accostFrame = await reader.next();
    assert.equal(accostFrame.command, symbian.COMMAND_MESSAGE_ACCOST);
    assert.equal(accostFrame.sequence, 921);
    assert.equal(accostFrame.status, 0);
    const accostEnvelope = symbian.parseAccostResponseEnvelope(
      protocol.decryptPayload(accostFrame.payload, effectiveKey));
    assert.equal(accostEnvelope.protocolVersion, 1);
    assert.equal(accostEnvelope.response.requestId, 1);
    assert.equal(accostEnvelope.response.result, 0);
    assert.equal(accostEnvelope.suffix.toString('hex'), '00');
    assert.equal(
      accostEnvelope.response.parameters
        .get('RespGetMsg').get('MessageSvcAccost.RespGetMsg').toString('hex'),
      '0a0c1c2600390c0b',
    );

    socket.write(protocol.createFrame({
      command: symbian.COMMAND_BUDDY_STATUS,
      sequence: 93,
      uin: 10001,
      payload: protocol.encryptPayload(
        Buffer.from('0000000000000000000000c80000', 'hex'),
        effectiveKey,
        deterministicRandom,
      ),
    }));
    const buddyStatusFrame = await reader.next();
    assert.equal(buddyStatusFrame.command, symbian.COMMAND_BUDDY_STATUS);
    assert.equal(buddyStatusFrame.status, 0);
    const buddyStatus = protocol.decryptPayload(buddyStatusFrame.payload, effectiveKey);
    assert.equal(buddyStatus.length, 35);
    assert.equal(buddyStatus[0], 0);
    assert.equal(buddyStatus[15], 0);
    assert.equal(buddyStatus.readUInt16BE(16), 0);
    assert.equal(buddyStatus.readUInt16BE(18), 1);
    assert.equal(buddyStatus.readUInt32BE(20), 10002);
    assert.equal(buddyStatus[24], 1);
    assert.equal(buddyStatus.readUInt16BE(29), 1);
    assert.equal(buddyStatus.readUInt16BE(31), 0);

    const groupListRequest = Buffer.from('0000000000000000000000c80000', 'hex');
    groupListRequest.writeUInt16BE(1, 8);
    socket.write(protocol.createFrame({
      command: symbian.COMMAND_BUDDY_STATUS,
      sequence: 930,
      uin: 10001,
      payload: protocol.encryptPayload(
        groupListRequest, effectiveKey, deterministicRandom),
    }));
    const groupListFrame = await reader.next();
    assert.equal(groupListFrame.command, symbian.COMMAND_BUDDY_STATUS);
    const groupList = protocol.decryptPayload(groupListFrame.payload, effectiveKey);
    assert.equal(groupList.length, 55);
    assert.equal(groupList[15], 1);
    assert.equal(groupList.readUInt16BE(16), 1);
    assert.equal(groupList.readUInt16BE(18), 3);
    assert.equal(groupList.readUInt32BE(20), symbianGroup.id);
    assert.equal(groupList[24], 4);
    assert.equal(groupList.readUInt32BE(31), symbianGroupTwo.id);
    assert.equal(groupList[35], 4);
    assert.equal(groupList.readUInt32BE(42), symbianGroupThree.id);
    assert.equal(groupList[46], 4);
    assert.equal(groupList.readUInt16BE(53), 0);
    assert.ok(events.some((event) => event.event === 'session_key_variant_selected'
      && event.variant === 'symbian_client_marker_or_byte_6'));
    assert.ok(events.some((event) => event.event === 'symbian_wup_ok'
      && event.responseKind === 'empty_discuss_list'));
    assert.ok(events.some((event) => event.event === 'symbian_accost_ok'
      && event.responseKind === 'empty_message_list'));
    assert.ok(events.some((event) => event.event === 'symbian_buddy_status_ok'
      && event.count === 1 && event.friendCount === 1 && event.groupCount === 0
      && event.friendUins[0] === 10002 && event.pagePhase === 'friends'));
    assert.ok(events.some((event) => event.event === 'symbian_buddy_status_ok'
      && event.count === 3 && event.friendCount === 0 && event.groupCount === 3
      && event.groupIds[0] === symbianGroup.id
      && event.groupIds[1] === symbianGroupTwo.id
      && event.groupIds[2] === symbianGroupThree.id
      && event.pagePhase === 'groups'));

    // Once kind=4 reaches CQQGroupEngine, QQ2013 requests the group-member
    // stage with 0x006D/0x72 rather than the J2ME subtype-4 shape. The fixed
    // three-u32 body prevents an out-of-bounds read; profile bit 0 and its
    // bounded title field replace the numeric placeholder with the group name.
    const symbianGroupInfoRequest = Buffer.alloc(9);
    symbianGroupInfoRequest[0] = 0x72;
    symbianGroupInfoRequest.writeUInt32BE(symbianGroup.id, 1);
    symbianGroupInfoRequest.writeUInt32BE(0, 5);
    socket.write(protocol.createFrame({
      command: protocol.COMMAND_GROUP_SERVICE,
      sequence: 933,
      uin: 10001,
      payload: protocol.encryptPayload(
        symbianGroupInfoRequest, effectiveKey, deterministicRandom),
    }));
    const symbianGroupInfoFrame = await reader.next();
    assert.equal(symbianGroupInfoFrame.command, protocol.COMMAND_GROUP_SERVICE);
    assert.equal(symbianGroupInfoFrame.sequence, 933);
    assert.equal(symbianGroupInfoFrame.status, 0);
    const symbianGroupInfo = protocol.decryptPayload(
      symbianGroupInfoFrame.payload, effectiveKey);
    assert.equal(symbianGroupInfo.length,
      59 + Math.min(48, protocol.encodeLegacyText(symbianGroup.title).length));
    assert.equal(symbianGroupInfo[0], 0x72);
    assert.equal(symbianGroupInfo[1], 0);
    assert.equal(symbianGroupInfo.readUInt32BE(2), symbianGroup.id);
    assert.equal(symbianGroupInfo.readUInt32BE(6), symbianGroup.publicId || symbianGroup.id);
    assert.equal(symbianGroupInfo.readUInt32BE(10), 1);
    const symbianTitleLength = symbianGroupInfo.readUInt16BE(49);
    assert.ok(symbianTitleLength <= 48);
    assert.equal(protocol.decodeLegacyText(
      symbianGroupInfo.subarray(51, 51 + symbianTitleLength)),
    symbianGroup.title.slice(0, symbianTitleLength / 2));
    assert.ok(events.some((event) => event.event === 'symbian_group_probe_hit'
      && event.groupId === symbianGroup.id
      && event.responseProfile === 's60_qq2013_0x72_profile'
      && event.messageDeliveryEnabled === true));
    assert.ok(events.some((event) => event.event === 'group_service_ok'
      && event.subtype === 0x72 && event.groupId === symbianGroup.id
      && event.cursor === 0 && event.responseProfile === 's60_qq2013_0x72_profile'));

    // All groups were created by the requested 0x00AF pages. Finishing the
    // separate friend roster must not emit ineffective unsolicited 0x0054
    // placeholders for groups the client already knows about.
    socket.write(protocol.createFrame({
      command: protocol.COMMAND_FRIEND_ROSTER,
      sequence: 935,
      uin: 10001,
      payload: protocol.encryptPayload(
        Buffer.from([0, 0, 0]), effectiveKey, deterministicRandom),
    }));
    const symbianRosterFrame = await reader.next();
    assert.equal(symbianRosterFrame.command, protocol.COMMAND_FRIEND_ROSTER);
    const symbianRoster = protocol.decryptPayload(symbianRosterFrame.payload, effectiveKey);
    assert.equal(symbianRoster.readInt16BE(0), -1);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(events.filter((event) => event.event === 'group_relation_pushed').length, 0);

    const secondInfoRequest = Buffer.from(symbianGroupInfoRequest);
    secondInfoRequest.writeUInt32BE(symbianGroupTwo.id, 1);
    socket.write(protocol.createFrame({
      command: protocol.COMMAND_GROUP_SERVICE,
      sequence: 936,
      uin: 10001,
      payload: protocol.encryptPayload(secondInfoRequest, effectiveKey, deterministicRandom),
    }));
    const secondInfoFrame = await reader.next();
    assert.equal(secondInfoFrame.command, protocol.COMMAND_GROUP_SERVICE);
    const secondInfo = protocol.decryptPayload(secondInfoFrame.payload, effectiveKey);
    assert.equal(secondInfo.readUInt32BE(2), symbianGroupTwo.id);

    const thirdInfoRequest = Buffer.from(symbianGroupInfoRequest);
    thirdInfoRequest.writeUInt32BE(symbianGroupThree.id, 1);
    socket.write(protocol.createFrame({
      command: protocol.COMMAND_GROUP_SERVICE,
      sequence: 937,
      uin: 10001,
      payload: protocol.encryptPayload(thirdInfoRequest, effectiveKey, deterministicRandom),
    }));
    const thirdInfoFrame = await reader.next();
    assert.equal(thirdInfoFrame.command, protocol.COMMAND_GROUP_SERVICE);
    const thirdInfo = protocol.decryptPayload(thirdInfoFrame.payload, effectiveKey);
    assert.equal(thirdInfo.readUInt32BE(2), symbianGroupThree.id);
    assert.equal(events.filter((event) => event.event === 'group_mapping_pushed').length, 0);
    const symbianSession = server.qqSessions.get(10001);
    assert.ok(symbianSession.advertisedGroupIds.has(symbianGroup.id));
    assert.ok(symbianSession.advertisedGroupIds.has(symbianGroupTwo.id));
    assert.ok(symbianSession.advertisedGroupIds.has(symbianGroupThree.id));

    // QQ2013's normal outbound group-message command is 0x0090/subtype 1.
    // Exercise the tokenless legacy-compatible form used by the gateway and
    // make sure the message reaches the authorized group-send path.
    const outboundText = protocol.encodeLegacyText('hello from S60');
    const outboundGroupMessage = Buffer.alloc(17 + outboundText.length);
    outboundGroupMessage[0] = 1;
    outboundGroupMessage.writeUInt32BE(symbianGroup.id, 1);
    outboundGroupMessage.writeUInt16BE(0, 5);
    outboundGroupMessage.writeUInt16BE(0, 7);
    outboundGroupMessage.writeUInt16BE(12, 9);
    outboundGroupMessage.writeUInt32BE(123456, 11);
    outboundGroupMessage.writeUInt16BE(outboundText.length, 15);
    outboundText.copy(outboundGroupMessage, 17);
    socket.write(protocol.createFrame({
      command: protocol.COMMAND_GROUP_SEND,
      sequence: 938,
      uin: 10001,
      payload: protocol.encryptPayload(
        outboundGroupMessage, effectiveKey, deterministicRandom),
    }));
    const outboundAck = await reader.next();
    assert.equal(outboundAck.command, protocol.COMMAND_GROUP_SEND);
    assert.equal(outboundAck.status, 0);
    assert.ok(events.some((event) => event.event === 'group_message_sent'
      && event.groupId === symbianGroup.id && event.text === 'hello from S60'
      && event.authorized === true));

    // QQ2013/S60 also uses 0x006D/subtype 0x1A. Its body-length field excludes
    // the ten-byte fixed header and counts only UTF-16BE text plus the trailer.
    const serviceText = protocol.encodeLegacyText('S60 service send');
    const serviceTrailer = Buffer.from(
      '00200000090000000086028b5b534f0d', 'hex');
    const serviceGroupMessage = Buffer.alloc(
      17 + serviceText.length + serviceTrailer.length);
    serviceGroupMessage[0] = 0x1A;
    serviceGroupMessage.writeUInt32BE(symbianGroup.id, 1);
    serviceGroupMessage.writeUInt16BE(serviceText.length + serviceTrailer.length, 5);
    serviceGroupMessage.writeUInt16BE(1, 7);
    serviceText.copy(serviceGroupMessage, 17);
    serviceTrailer.copy(serviceGroupMessage, 17 + serviceText.length);
    socket.write(protocol.createFrame({
      command: protocol.COMMAND_GROUP_SERVICE,
      sequence: 939,
      uin: 10001,
      payload: protocol.encryptPayload(
        serviceGroupMessage, effectiveKey, deterministicRandom),
    }));
    const serviceAckFrame = await reader.next();
    assert.equal(serviceAckFrame.command, protocol.COMMAND_GROUP_SERVICE);
    assert.equal(serviceAckFrame.status, 0);
    assert.deepEqual(protocol.decryptPayload(serviceAckFrame.payload, effectiveKey),
      Buffer.from([0x1A, 0]));
    assert.ok(events.some((event) => event.event === 'group_message_sent'
      && event.groupId === symbianGroup.id && event.text === 'S60 service send'
      && event.authorized === true && event.transport === '0x006d/26'));

    // QQ2013 sends 0x00AE as a one-way presence subscription. It must be
    // consumed with the Symbian-derived session key without inserting an
    // unexpected response ahead of the next command.
    socket.write(protocol.createFrame({
      command: symbian.COMMAND_AUXILIARY_PRESENCE,
      sequence: 934,
      uin: 10001,
      payload: protocol.encryptPayload(
        Buffer.from('880000271200', 'hex'), effectiveKey, deterministicRandom),
    }));

    socket.write(protocol.createFrame({
      command: protocol.COMMAND_LOGOUT,
      sequence: 94,
      uin: 10001,
    }));
    const logoutFrame = await reader.next();
    assert.equal(logoutFrame.command, protocol.COMMAND_LOGOUT);
    assert.equal(logoutFrame.status, 0);
    assert.ok(events.some((event) => event.event === 'logout_ok'));
    assert.ok(events.some((event) => event.event === 'symbian_auxiliary_presence_ok'
      && event.action === 'subscribe' && event.targetUin === 10002));

    // QQ2013 can reuse the transport after logging out. Exercise that path
    // directly; forcing the server side to close here previously left the
    // native client waiting on a dead login engine without reconnecting.
    const reloginReader = reader;
    const reloginKeyRequest = getKeyRequest(10001, 95);
    socket.write(reloginKeyRequest);
    const reloginKeyResponse = await reloginReader.next();
    assert.deepEqual(reloginKeyResponse.payload.subarray(0, 16), wireKey);
    const reloginKey = protocol.deriveSymbianSessionKey(
      wireKey, reloginKeyRequest.subarray(14, -1));
    socket.write(loginRequest(10001, 96, reloginKey, 'qqtest123'));
    const reloginResponse = await reloginReader.next();
    assert.equal(reloginResponse.status, 0);
    assert.ok(protocol.decryptPayload(reloginResponse.payload, reloginKey));
    assert.equal(events.filter((event) => event.event === 'login_ok').length, 2);
  } finally {
    socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const plain = Buffer.from('00090001000000004242424242424242424242424242424210'
    + '25f9e794323b453885f5181f1b624d0b00', 'hex');
  const encrypted = qqtea.encrypt(plain, key, deterministicRandom);
  assert.deepEqual(qqtea.decrypt(encrypted, key), plain);
  assert.equal(javaTea('decrypt', encrypted, key), plain.toString('hex'));
  const javaEncrypted = Buffer.from(javaTea('encrypt', plain, key), 'hex');
  assert.deepEqual(qqtea.decrypt(javaEncrypted, key), plain);
  assert.deepEqual(protocol.buildEmptyBuddyListPayload(), Buffer.alloc(9));
  const buddyListFixture = protocol.buildBuddyListPayload([
    { uin: 10002, relationType: 1, groupIndex: 3 },
  ]);
  assert.equal(buddyListFixture.length, 15);
  assert.equal(buddyListFixture.readUInt32BE(9), 10002);
  assert.equal(buddyListFixture[13], 1);
  assert.equal(buddyListFixture[14], 12);
  assert.equal(protocol.buildAuxiliaryKeyPayload(Buffer.alloc(16, 7)).length, 19);
  const buddyDetailsFixture = protocol.buildBuddyDetailsPayload([10001], true);
  assert.equal(buddyDetailsFixture.length, 41);
  assert.equal(buddyDetailsFixture[0], 1);
  assert.equal(buddyDetailsFixture.readUInt16BE(14), 10);
  assert.deepEqual(protocol.parseBuddyTokensRequest(Buffer.from([1, 0, 0])), {
    subtype: 1, cursor: 0, targetUin: null,
  });
  assert.deepEqual(protocol.buildBuddyTokensPayload({ subtype: 1 }),
    Buffer.from([1, 0xFF, 0xFF, 0]));
  assert.deepEqual(protocol.buildFriendServiceAck(2), Buffer.from([2]));
  assert.deepEqual(protocol.buildFriendServiceAck(0), Buffer.from([0, 1]));
  assert.equal(protocol.buildExtendedServicePayload(0x1F, 10001).length, 8);
  assert.deepEqual(protocol.buildExtendedServicePayload(0x20, 10001),
    Buffer.from('20000000000001000000000001000000', 'hex'));
  assert.deepEqual(protocol.parseFriendRosterRequest(Buffer.from([0, 0, 0])), {
    cursor: 0,
    reserved: 0,
  });
  const rosterFixture = protocol.buildFriendRosterPayload([
    { uin: 10002, nickname: 'Friend-B', presence: 0 },
  ], -1);
  assert.equal(rosterFixture.readInt16BE(0), -1);
  assert.equal(rosterFixture.readUInt16BE(2), 1);
  assert.equal(rosterFixture.readUInt32BE(4), 10002);
  assert.equal(protocol.decodeLegacyText(
    rosterFixture.subarray(17, 17 + rosterFixture[16])), 'Friend-B');
  assert.equal(protocol.decodeLegacyText(protocol.encodeLegacyText('测试-A')), '测试-A');
  assert.equal(protocol.buildSearchUserPayload([{ uin: 10002, nickname: 'B' }]).readUInt16BE(0), 1);
  const incomingFixture = protocol.buildIncomingTextPayload(10001, 'hi', 1234567890);
  assert.equal(incomingFixture.readUInt16BE(0), 9);
  assert.equal(incomingFixture.readUInt32BE(2), 1234567890);
  assert.equal(incomingFixture.readUInt32BE(6), 10001);
  assert.equal(incomingFixture.readUInt16BE(10), 4);
  assert.equal(protocol.decodeLegacyText(incomingFixture.subarray(12)), 'hi');
  // Sanitized from a QQ2013/S60 capture: subtype 0x1A, synthetic group 20002,
  // text U+725B U+7684. The real account and group identifiers are not retained.
  // Its 0x0014 encoded-body length covers only text plus the 16-byte trailer,
  // not the ten-byte fixed header preceding the text.
  const capturedSymbianGroupSend = Buffer.from(
    '1a00004e22001400010000000000000000725b7684'
    + '00200000090000000086028b5b534f0d',
    'hex',
  );
  assert.deepEqual(protocol.parseGroupServiceRequest(capturedSymbianGroupSend), {
    subtype: 26,
    groupId: 20002,
    memberUins: [],
    text: '\u725B\u7684',
    lengthProfile: 'text',
  });
  // QQ2011 J2ME 11.00.12 用同一个命令、同样的正文起点（offset 17）和同样的
  // 16 字节尾，但把正文前那十个固定头字节也算进 encoded-body length。真实抓包
  // （发给群 1126386035 的 "abc"）：0x0020 = 10 头 + 6 正文 + 16 尾，而
  // payload.length - 17 只有 22。两者必须都接受。
  const capturedQq2011GroupSend = Buffer.from(
    '1a4323497300200001000000000000000000610062006300200000'
    + '090000000086028b5b534f0d',
    'hex',
  );
  assert.deepEqual(protocol.parseGroupServiceRequest(capturedQq2011GroupSend), {
    subtype: 26,
    groupId: 1126386035,
    memberUins: [],
    text: 'abc',
    lengthProfile: 'fixed-header',
  });
  const malformedSymbianGroupSend = Buffer.from(capturedSymbianGroupSend);
  malformedSymbianGroupSend.writeUInt16BE(0x0015, 5);
  assert.throws(() => protocol.parseGroupServiceRequest(malformedSymbianGroupSend),
    /length\/header is invalid/);
  // 两种长度语义都对不上时必须仍然拒绝（0x0021 = 33，既不等于 37-17 也不等于 37-7）。
  const malformedQq2011GroupSend = Buffer.from(capturedQq2011GroupSend);
  malformedQq2011GroupSend.writeUInt16BE(0x0021, 5);
  assert.throws(() => protocol.parseGroupServiceRequest(malformedQq2011GroupSend),
    /length\/header is invalid/);
  assert.equal(protocol.buildFriendAddedPayload({ uin: 10002, nickname: 'B' }).readUInt32BE(2), 10002);
  assert.deepEqual(protocol.parseFriendPreflightPayload(Buffer.from([0, 0, 0x27, 0x12])), {
    targetUin: 10002,
  });
  assert.deepEqual(protocol.buildFriendPreflightPayload(10002, 0, 0),
    Buffer.from([0, 0, 0x27, 0x12, 0, 0]));
  assert.deepEqual(protocol.parseFriendResultActionPayload(
    Buffer.from([0, 0, 0, 0x27, 0x12, 1, 0])), {
    action: 0,
    targetUin: 10002,
    value: 1,
    extra: Buffer.from([0]),
  });
  const validationNotice = protocol.buildFriendRequestNotificationPayload(10002, 'hi');
  assert.equal(validationNotice.readUInt32BE(0), 10002);
  assert.equal(validationNotice.readUInt16BE(4), 40);
  assert.equal(validationNotice[6], 4);

  const capturedDiscuss = Buffer.from(
    '0021515153657276696365446973637573735376632e52657147657444697363757373'
    + '0000a8000000a810022c3c4001561351515365727669636544697363757373537663'
    + '660d526571476574446973637573737d000071080002061044697363757373526571'
    + '486561646572180001061a5151536572766963652e44697363757373526571486561'
    + '6465721d0000050a0104c00b060d5265714765744469736375737318000106175151'
    + '536572766963652e526571476574446973637573731d0000050a0127110b8c980ca8'
    + '0c00',
    'hex',
  );
  const capturedEnvelope = symbian.parseWupEnvelope(capturedDiscuss);
  assert.equal(capturedEnvelope.route, symbian.ROUTE_GET_DISCUSS);
  assert.equal(capturedEnvelope.request.servant, 'QQServiceDiscussSvc');
  assert.equal(capturedEnvelope.request.functionName, 'ReqGetDiscuss');
  assert.equal(capturedEnvelope.request.requestId, 1);
  assert.deepEqual([...capturedEnvelope.request.parameters.keys()], [
    'DiscussReqHeader', 'ReqGetDiscuss',
  ]);
  const createdGroup = {
    id: 200123,
    title: 'Created discussion',
    members: [{ uin: 20003 }, { uin: 20004 }],
  };
  const capturedCreate = symbian.parseWupEnvelope(Buffer.from(
    '0024515153657276696365446973637573735376632e52657143726561746544697363757373'
    + '0000bd000000bd10022c3c400256135151536572766963654469736375737353766366105265'
    + '71437265617465446973637573737d0001008208000106105265714372656174654469736375'
    + '7373180002061a5151536572766963652e446973637573735265714865616465721d0000050a'
    + '0104c00b061a5151536572766963652e526571437265617465446973637573731d0000250a06'
    + '16e6b58be8af95e7bb842ce7a4bae4be8be68890e591981900010a020dfb38d21c0b0b8c'
    + '980ca80c00',
    'hex',
  ));
  assert.deepEqual(symbian.parseCreateDiscussRequest(capturedCreate), {
    title: '测试组,示例成员', memberUins: [234567890],
  });
  let deliveredCreateDetails;
  const createResponse = symbian.createWupResponse(capturedCreate, {
    createDiscussion: (details) => {
      deliveredCreateDetails = details;
      return createdGroup;
    },
  });
  assert.deepEqual(deliveredCreateDetails, symbian.parseCreateDiscussRequest(capturedCreate));
  assert.equal(createResponse.kind, 'discussion_created');
  assert.equal(createResponse.group, createdGroup);
  const parsedCreateResponse = symbian.parseWupResponseEnvelope(createResponse.payload);
  assert.deepEqual([...parsedCreateResponse.response.parameters.keys()], [
    'DiscussRespHeader', 'RespCreateDiscuss',
  ]);
  const createdFields = new jce.Reader(parsedCreateResponse.response.parameters
    .get('RespCreateDiscuss').get('QQService.RespCreateDiscuss')).field().value;
  assert.equal(createdFields.get(0), 200123n);
  assert.deepEqual(createdFields.get(1), new Map([
    [20003n, 0], [20004n, 0],
  ]));
  const responsePacket = jce.responsePacket(capturedEnvelope.request, [], 0);
  const parsedResponse = jce.parseResponsePacket(responsePacket);
  assert.equal(parsedResponse.requestId, 1);
  assert.equal(parsedResponse.result, 0);

  const combined = Buffer.concat([
    Buffer.from([0x55, 0x66]),
    getKeyRequest(10001, 1),
    getKeyRequest(10001, 2),
  ]);
  const consumed = protocol.consumeFrames(combined);
  assert.equal(consumed.frames.length, 2);
  assert.equal(consumed.remainder.length, 0);

  await integrationTest();
  await symbianSessionKeyTest();
  process.stdout.write('QQ private server self-test passed.\n');
}

main().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
