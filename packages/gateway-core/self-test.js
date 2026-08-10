'use strict';

const assert = require('node:assert/strict');
const {
  BoundedHistory,
  FixedWindowRateLimiter,
  GatewayError,
  MemoryQueueStorage,
  OfflineDeliveryQueue,
  OneBotMessageRouter,
  SessionRegistry,
  errorPayload,
  normalizeFriend,
  normalizeGroup,
  normalizeGroupMember,
  normalizeOneBotMessage,
  normalizeOneBotNotice,
  segmentText,
} = require('./index');

let assertions = 0;

function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertions += 1;
}

function deepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function check(value, message) {
  assert.ok(value, message);
  assertions += 1;
}

async function testDomain() {
  deepEqual(normalizeFriend({ user_id: 10001, nickname: 'Alice', remark: '小艾' }), {
    id: '10001', nickname: 'Alice', remark: '小艾', displayName: '小艾',
  });
  deepEqual(normalizeGroup({ group_id: 20002, group_name: '测试群' }), {
    id: '20002', title: '测试群',
  });
  deepEqual(normalizeGroupMember({ user_id: 10001, nickname: 'Alice', card: '群名片' }, 20002), {
    groupId: '20002', id: '10001', nickname: 'Alice', groupCard: '群名片', displayName: '群名片',
  });
  equal(segmentText([
    { type: 'text', data: { text: '你好' } },
    { type: 'face', data: {} },
    { type: 'image', data: {} },
  ]), '你好[表情][图片]');

  const message = normalizeOneBotMessage({
    post_type: 'message', message_type: 'group', group_id: 20002,
    user_id: 10001, self_id: 99999,
    sender: { nickname: 'Alice', card: '群名片' },
    message: [{ type: 'text', data: { text: '喵' } }],
    message_id: 123, time: 456,
  });
  equal(message.peerId, '20002');
  equal(message.sender.displayName, '群名片');
  equal(message.sender.nickname, 'Alice');
  equal(message.text, '喵');
  equal(message.messageId, '123');
  equal(normalizeOneBotMessage({
    post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10001,
  }), null, 'self messages should be filtered');
  const fallback = normalizeOneBotMessage({
    post_type: 'message', message_type: 'group', group_id: 20002, user_id: 10001,
    sender: {}, message: [],
  });
  equal(fallback.sender.displayName, '10001', 'sender ID is the final display fallback');

  deepEqual(normalizeOneBotNotice({
    post_type: 'notice', notice_type: 'friend_add', time: 10,
  }, { labels: { friend_add: '新好友已添加' } }), {
    kind: 'notice', noticeType: 'friend_add', text: '新好友已添加',
    refreshContacts: true, time: 10,
  });
  equal(normalizeOneBotNotice({ post_type: 'notice', notice_type: 'unknown' }), null);

  const domainError = new GatewayError('bad_params', '参数错误', { field: 'peer' });
  deepEqual(errorPayload(domainError), {
    code: 'bad_params', message: '参数错误', details: { field: 'peer' },
  });
}

async function testRateAndRouting() {
  let now = 1000;
  const limiter = new FixedWindowRateLimiter({
    maxPerWindow: 2, windowMs: 1000, minIntervalMs: 100, now: () => now,
  });
  equal(limiter.allow('a'), true);
  now += 50;
  equal(limiter.allow('a'), false, 'minimum interval should be enforced per key');
  equal(limiter.allow('b'), true, 'rate entries should be independent');
  now += 50;
  equal(limiter.allow('a'), true);
  now += 100;
  equal(limiter.allow('a'), false, 'window maximum should be enforced');
  now = 2000;
  equal(limiter.allow('a'), true, 'a new fixed window should reset the count');

  const sent = [];
  const onebot = {
    sendAction: (action, params) => {
      sent.push({ action, params });
      return Promise.resolve({ ok: true, data: { message_id: 42 } });
    },
  };
  const router = new OneBotMessageRouter({ onebot });
  deepEqual(await router.sendText({ chatType: 'group', peerId: '20002', text: 'hello' }), {
    ok: true, action: 'send_group_msg', messageId: 42,
  });
  deepEqual(sent[0], {
    action: 'send_group_msg', params: { group_id: 20002, message: 'hello' },
  });
  deepEqual(await router.sendText({ chatType: 'private', peerId: '', text: 'hello' }), {
    ok: false, code: 'bad_params', error: 'peer/text required',
  });
}

function testStateServices() {
  const storage = new MemoryQueueStorage();
  const queue = new OfflineDeliveryQueue({ capacity: 2, storage });
  equal(queue.enqueue('device', { id: 1 }), true);
  equal(queue.enqueue('device', { id: 2 }), true);
  equal(queue.enqueue('device', { id: 3 }), false, 'offline queue should be bounded');
  equal(queue.size('device'), 2);
  deepEqual(queue.take('device'), [{ id: 1 }, { id: 2 }]);
  equal(queue.size('device'), 0);

  const history = new BoundedHistory({ capacity: 2 });
  history.append('peer', { id: 1 });
  history.append('peer', { id: 2 });
  history.append('peer', { id: 3 });
  deepEqual(history.get('peer', 20), [{ id: 2 }, { id: 3 }]);

  const registry = new SessionRegistry();
  const first = { id: 1 };
  const second = { id: 2 };
  registry.add(first);
  equal(registry.activate('device', first), null);
  equal(registry.activate('device', second), first, 'activation should return the replaced session');
  deepEqual(registry.knownKeys(), ['device']);
  equal(registry.get('device'), second);
  registry.remove(second);
  equal(registry.get('device'), null);
  check(registry.all().includes(first));
}

async function main() {
  await testDomain();
  await testRateAndRouting();
  testStateServices();
  console.log(`[gateway-core self-test] ${assertions} assertions passed`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
