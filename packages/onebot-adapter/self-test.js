'use strict';

const assert = require('node:assert/strict');
const { OneBotClient, WsClient } = require('./index');

let assertions = 0;

function check(value, message) {
  assert.ok(value, message);
  assertions += 1;
}

function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertions += 1;
}

function deepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function makeServerFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  assert.ok(body.length < 126, 'test helper only supports short frames');
  return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
}

function decodeClientFrame(frame) {
  const opcode = frame[0] & 0x0f;
  const masked = (frame[1] & 0x80) !== 0;
  const length = frame[1] & 0x7f;
  assert.ok(masked, 'client websocket frames must be masked');
  assert.ok(length < 126, 'test decoder only supports short frames');
  const mask = frame.subarray(2, 6);
  const body = frame.subarray(6, 6 + length);
  const payload = Buffer.alloc(length);
  for (let i = 0; i < length; i++) payload[i] = body[i] ^ mask[i & 3];
  return { opcode, payload };
}

async function testOneBotClient() {
  const errors = [];
  const client = new OneBotClient({
    url: 'ws://127.0.0.1:3001',
    log: { error: (message) => errors.push(message) }
  });

  let event = null;
  client.onEvent((value) => { event = value; });
  client._handleMessage({ post_type: 'message', message_type: 'private', raw_message: 'nya' });
  equal(event.raw_message, 'nya', 'OneBot events should reach the registered handler');

  const sent = [];
  client.connected = true;
  client.ws = { sendText: (text) => sent.push(JSON.parse(text)) };
  const action = client.sendAction('get_login_info', {});
  equal(sent.length, 1, 'connected actions should be sent immediately');
  equal(sent[0].action, 'get_login_info', 'action name should be preserved');
  client._handleMessage({ status: 'ok', retcode: 0, echo: sent[0].echo, data: { user_id: 10001 } });
  deepEqual(await action, { ok: true, data: { user_id: 10001 } }, 'successful action response should resolve');

  const failed = client.sendAction('unknown_action', {});
  client._handleMessage({ status: 'failed', retcode: 1404, echo: sent[1].echo, msg: 'not found' });
  deepEqual(await failed, { ok: false, error: 'not found (retcode 1404)' }, 'failed action response should resolve in adapter format');

  client.onEvent(() => { throw new Error('handler failed'); });
  client._handleMessage({ post_type: 'notice' });
  check(errors.some((message) => message.indexOf('handler failed') >= 0), 'event handler errors should be isolated and logged');

  const queued = new OneBotClient({
    url: 'ws://127.0.0.1:3001',
    actionQueueCap: 1,
    log: { error: () => {} }
  });
  const first = queued.sendAction('first', {});
  equal(queued.actionQueue.length, 1, 'disconnected actions should be queued');
  await assert.rejects(queued.sendAction('second', {}), /queue is full/);
  assertions += 1;
  const firstEcho = JSON.parse(queued.actionQueue[0]).echo;
  queued._handleMessage({ status: 'ok', retcode: 0, echo: firstEcho, data: null });
  deepEqual(await first, { ok: true, data: null }, 'queued action response should keep the public result shape');
}

function testWebSocketFrames() {
  const writes = [];
  let destroyed = false;
  const ws = new WsClient('ws://127.0.0.1:3001');
  ws.socket = {
    write: (frame) => writes.push(Buffer.from(frame)),
    destroy: () => { destroyed = true; }
  };

  equal(ws.sendText('喵'), true, 'sendText should write while a socket is attached');
  const textFrame = decodeClientFrame(writes[0]);
  equal(textFrame.opcode, 0x1, 'sendText should use the text opcode');
  equal(textFrame.payload.toString('utf8'), '喵', 'outgoing UTF-8 text should survive masking');

  const messages = [];
  ws.onMessage = (message) => messages.push(message);
  const incoming = makeServerFrame(0x1, 'hello');
  ws._onData(incoming.subarray(0, 3));
  equal(messages.length, 0, 'partial frames should remain buffered');
  ws._onData(incoming.subarray(3));
  deepEqual(messages, ['hello'], 'a complete server text frame should be delivered once');

  ws._onData(makeServerFrame(0x9, 'ping'));
  const pong = decodeClientFrame(writes[1]);
  equal(pong.opcode, 0x0a, 'ping frames should receive pong frames');
  equal(pong.payload.toString('utf8'), 'ping', 'pong should preserve the ping payload');

  ws.close();
  check(destroyed, 'close should destroy the attached socket after sending a close frame');
}

async function main() {
  await testOneBotClient();
  testWebSocketFrames();
  console.log(`[onebot-adapter self-test] ${assertions} assertions passed`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
