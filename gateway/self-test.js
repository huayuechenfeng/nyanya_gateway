'use strict';

const net = require('node:net');
const { createGateway } = require('./server');
const { TYPE, FrameReader, encode } = require('../packages/nyanya-protocol');

class MockOneBot {
  constructor() {
    this.handlers = [];
  }

  onEvent(handler) {
    this.handlers.push(handler);
  }

  emit(event) {
    for (const handler of this.handlers) handler(event);
  }

  sendAction(action) {
    if (action === 'send_group_msg' || action === 'send_private_msg') {
      return Promise.resolve({ ok: true, data: { message_id: 12345 } });
    }
    if (action === 'get_friend_list') {
      return Promise.resolve({
        ok: true,
        data: [{ user_id: 10001, nickname: 'Alice', remark: '小艾' }]
      });
    }
    if (action === 'get_group_list') {
      return Promise.resolve({
        ok: true,
        data: [{ group_id: 20002, group_name: '测试群' }]
      });
    }
    return Promise.resolve({ ok: true, data: {} });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectClient(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const client = { socket, reader: new FrameReader(), frames: [] };
    socket.on('data', (chunk) => {
      try {
        for (const frame of client.reader.feed(chunk)) client.frames.push(frame);
      } catch (err) {
        reject(err);
      }
    });
    socket.on('error', reject);
    socket.on('connect', () => resolve(client));
  });
}

function send(client, type, seq, obj) {
  client.socket.write(encode(type, seq, obj));
}

async function waitFrame(client, type, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 3000);
  while (Date.now() < deadline) {
    for (let i = 0; i < client.frames.length; i++) {
      if (client.frames[i].type === type) {
        const frame = client.frames.splice(i, 1)[0];
        return frame;
      }
    }
    await sleep(25);
  }
  throw new Error('timeout waiting for frame type ' + type);
}

function assert(condition, message) {
  if (!condition) throw new Error('assertion failed: ' + message);
}

function payloadOf(frame) {
  return JSON.parse(frame.body.toString('utf8'));
}

async function main() {
  let assertions = 0;
  const quiet = { log: () => {}, error: () => {} };
  const config = {
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    onebotUrl: 'ws://127.0.0.1:3001',
    onebotToken: '',
    heartbeatMs: 30000,
    sendMinIntervalMs: 0,
    sendMaxPerMinute: 1000,
    offlineCap: 200,
    historyCap: 100,
    log: quiet
  };
  const mock = new MockOneBot();
  const server = createGateway(config, mock);
  await new Promise((resolve) => server.start(resolve));
  const port = server.address().port;

  try {
    // 1. 错误 token -> AUTH_FAIL（服务端会断开连接）
    const badClient = await connectClient(port);
    send(badClient, TYPE.AUTH, 1, { device: 'dev-1', token: 'wrong' });
    const authFail = await waitFrame(badClient, TYPE.AUTH_FAIL);
    assert(authFail.seq === 1, 'auth fail seq echo');
    badClient.socket.destroy();
    assertions++;

    // 2. 正确 token -> AUTH_OK
    const mainClient = await connectClient(port);
    send(mainClient, TYPE.AUTH, 2, { device: 'dev-1', token: 'test-token' });
    const authOk = await waitFrame(mainClient, TYPE.AUTH_OK);
    const authPayload = payloadOf(authOk);
    assert(authPayload.heartbeatMs === 30000, 'heartbeat interval');
    assert(authPayload.offlineCount === 0, 'no offline messages');
    assert(authPayload.protocolVersion === 1, 'legacy AUTH negotiates protocol v1');
    assert(authPayload.legacyProtocol === true, 'missing version is marked as legacy v1');
    assertions++;

    // 2b. 显式 v1 + 能力协商，只返回服务端支持的能力
    const modernClient = await connectClient(port);
    send(modernClient, TYPE.AUTH, 1, {
      device: 'dev-modern', token: 'test-token', protocolVersion: 1,
      capabilities: ['text', 'contacts', 'future-feature'],
    });
    const modernAuth = payloadOf(await waitFrame(modernClient, TYPE.AUTH_OK));
    assert(modernAuth.protocolVersion === 1 && modernAuth.legacyProtocol === false,
      'explicit v1 negotiation');
    assert(JSON.stringify(modernAuth.capabilities) === JSON.stringify(['text', 'contacts']),
      'capability intersection');
    modernClient.socket.destroy();
    assertions++;

    // 2c. 不支持的协议版本必须明确拒绝
    const futureClient = await connectClient(port);
    send(futureClient, TYPE.AUTH, 1, {
      device: 'dev-future', token: 'test-token', protocolVersion: 99, capabilities: [],
    });
    const futureAuth = payloadOf(await waitFrame(futureClient, TYPE.AUTH_FAIL));
    assert(futureAuth.code === 'unsupported_protocol_version', 'unsupported version rejection');
    futureClient.socket.destroy();
    assertions++;

    // 3. ping -> pong
    send(mainClient, TYPE.PING, 3, {});
    const pong = await waitFrame(mainClient, TYPE.PONG);
    assert(pong.seq === 3, 'pong seq echo');
    assertions++;

    // 4. 发群消息 -> SEND_RESULT
    send(mainClient, TYPE.SEND_TEXT, 4, { chatType: 'group', peer: '20002', text: '大家好' });
    const sendResult = await waitFrame(mainClient, TYPE.SEND_RESULT);
    const sendPayload = payloadOf(sendResult);
    assert(sendPayload.ok === true && sendPayload.messageId === 12345, 'send result');
    assertions++;

    // 5. OneBot 群消息事件 -> MSG_PUSH
    mock.emit({
      post_type: 'message',
      message_type: 'group',
      group_id: 20002,
      user_id: 10001,
      sender: { nickname: 'Alice', card: '' },
      message: [
        { type: 'text', data: { text: '你好' } },
        { type: 'face', data: { id: '1' } }
      ],
      message_id: 1,
      time: 1750000000
    });
    const push = await waitFrame(mainClient, TYPE.MSG_PUSH);
    const pushPayload = payloadOf(push);
    assert(pushPayload.chatType === 'group', 'push chat type');
    assert(pushPayload.peer === '20002', 'push peer');
    assert(pushPayload.text === '你好[表情]', 'push text mapping');
    assertions++;

    // 5b. 自己账号发的消息（user_id == self_id）必须被过滤
    const frameCountBefore = mainClient.frames.length;
    mock.emit({
      post_type: 'message',
      message_type: 'group',
      group_id: 20002,
      user_id: 10001,
      self_id: 10001,
      sender: { nickname: 'Alice', card: '' },
      message: [{ type: 'text', data: { text: '自己发的' } }],
      message_id: 2,
      time: 1750000000
    });
    await sleep(200);
    assert(mainClient.frames.length === frameCountBefore, 'self message filtered');
    assertions++;

    // 6. 拉取联系人 -> CONTACTS_SYNC
    send(mainClient, TYPE.FETCH_CONTACTS, 5, {});
    const contacts = await waitFrame(mainClient, TYPE.CONTACTS_SYNC);
    const contactsPayload = payloadOf(contacts);
    assert(contactsPayload.friends.length === 1 && contactsPayload.friends[0].name === 'Alice', 'friends');
    assert(contactsPayload.friends[0].id === '10001', 'numeric friend id to string');
    assert(contactsPayload.groups[0].id === '20002', 'numeric group id to string');
    assert(contactsPayload.groups.length === 1 && contactsPayload.groups[0].name === '测试群', 'groups');
    assertions++;

    // 7. 离线消息缓冲：断开后事件进队列，重连后补发
    mainClient.socket.destroy();
    await sleep(100);
    mock.emit({
      post_type: 'message',
      message_type: 'private',
      user_id: 30003,
      message: [{ type: 'text', data: { text: '离线消息' } }],
      message_id: 3,
      time: 1750000001
    });
    const offlineClient = await connectClient(port);
    send(offlineClient, TYPE.AUTH, 1, { device: 'dev-1', token: 'test-token' });
    const authOk2 = await waitFrame(offlineClient, TYPE.AUTH_OK);
    const authPayload2 = payloadOf(authOk2);
    assert(authPayload2.offlineCount === 1, 'offline count');
    const offlinePush = await waitFrame(offlineClient, TYPE.MSG_PUSH);
    const offlinePayload = payloadOf(offlinePush);
    assert(offlinePayload.text === '离线消息', 'offline message delivery');
    assertions++;

    offlineClient.socket.destroy();
    console.log('gateway self-test OK (' + assertions + ' assertions)');
  } finally {
    server.stop();
  }
}

main().catch((err) => {
  console.error('gateway self-test FAILED: ' + err.message);
  process.exit(1);
});
