'use strict';

const assert = require('node:assert/strict');
const { classifyInventory, parseManifest } = require('../tools/client-jar-analyzer');
const { replacementFor } = require('../tools/class-group-web-patcher');
const { patchClass: patchBubbleLabel, BUBBLE_LABEL } = require('../tools/class-bubble-label-patcher');
const { makeNetworkRestricted } = require('../tools/local-network-guard');

let assertions = 0;
function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertions += 1;
}

const manifest = parseManifest('MIDlet-Name: Test\r\nMIDlet-Permissions: one,\r\n two\r\n');
equal(manifest['MIDlet-Name'], 'Test', 'manifest name');
equal(manifest['MIDlet-Permissions'], 'one,two', 'folded manifest line');

const base = {
  manifest: { 'MIDlet-Version': '12.0.16' },
  hasHttpClass: true,
  socketEndpointCount: 1,
  groupBids: ['205', '342'],
  signedEntries: [],
};
const helper = classifyInventory({
  ...base,
  aoHttpRoute: { routeKind: 'http-jl-helper' },
});
equal(helper.profileId, 'mobileqq-12.0.16-http-helper', 'helper profile');
equal(helper.supportLevel, 'full', 'helper support level');
equal(helper.patches.methodReference, true, 'helper method-reference patch');
equal(helper.patches.httpHelper, true, 'helper class patch');
equal(helper.patches.groupWeb, true, 'helper group web patch');

const direct = classifyInventory({
  ...base,
  hasHttpClass: false,
  aoHttpRoute: { routeKind: 'connector-direct' },
});
equal(direct.profileId, 'mobileqq-12.0.16-connector-direct', 'direct profile');
equal(direct.patches.methodReference, false, 'direct profile skips method-reference patch');
equal(direct.patches.forceAoDirect, true, 'direct profile forces direct branch');

const generic = classifyInventory({
  ...base,
  manifest: { 'MIDlet-Version': '10.0.40' },
  hasHttpClass: false,
  aoHttpRoute: null,
});
equal(generic.profileId, 'generic-tcp-core', 'generic profile');
equal(generic.supportLevel, 'experimental-tcp', 'generic support level');
equal(generic.patches.forceAoDirect, false, 'generic profile does not modify unknown control flow');
equal(generic.patches.groupWeb, true,
  'WAP ?bid= entries are redirected on every profile, full or experimental');

// 真机在用的 QQ2011 11.00.12：没有 http.class、落在 experimental，但 WAP 入口同样必须重写。
// 旧行为（要求 full profile 且同时命中 205/342）会把它的 forward.jsp?bid=331 留给 guard
// 打成 127.0.0.1:1 —— 手机上没人监听，图片气泡点进去必然失败。
const qq2011 = classifyInventory({
  ...base,
  manifest: { 'MIDlet-Version': '11.00.12', 'MIDlet-Name': 'QQ2011' },
  hasHttpClass: false,
  aoHttpRoute: null,
  groupBids: ['1', '205', '331', '342'],
});
equal(qq2011.profileId, 'generic-tcp-core', 'QQ2011 stays on the generic profile');
equal(qq2011.supportLevel, 'experimental-tcp', 'QQ2011 stays experimental');
equal(qq2011.patches.groupWeb, true, 'QQ2011 gets its WAP entries redirected');

const noWapEntries = classifyInventory({
  ...base,
  manifest: { 'MIDlet-Version': '11.00.12', 'MIDlet-Name': 'QQ2011' },
  hasHttpClass: false,
  aoHttpRoute: null,
  groupBids: [],
});
equal(noWapEntries.patches.groupWeb, false, 'no ?bid= entry means there is nothing to redirect');
equal(noWapEntries.warnings.some((warning) => warning.includes('?bid=')), true,
  'a missing WAP entry set is reported instead of failing silently');

const qq2008 = classifyInventory({
  ...base,
  manifest: { 'MIDlet-Version': '12.05.2', 'MIDlet-Name': '手机QQ2008' },
  hasHttpClass: false,
  aoHttpRoute: null,
});
equal(qq2008.warnings.some((warning) => warning.includes('ID 31')), true, 'QQ2008 compatibility warning');

const unsignedRequired = classifyInventory({
  ...base,
  aoHttpRoute: { routeKind: 'http-jl-helper' },
  signedEntries: ['META-INF/CLIENT.RSA'],
});
equal(unsignedRequired.warnings.some((warning) => warning.includes('签名')), true, 'signed warning');

equal(
  replacementFor('http://fwd.3g.qq.com:8080/forward.jsp?bid=342&x=1', 'http://192.168.1.5:13981'),
  'http://192.168.1.5:13981/forward.jsp?bid=342&x=1',
  'group URL replacement',
);
equal(
  makeNetworkRestricted('socket://192.168.1.5:14000 http://3g.qq.com/', '192.168.1.5'),
  'socket://192.168.1.5:14000 http://127.0.0.1:1/',
  'local network restriction',
);

// 群图片气泡字幕：网关只发图片块、正文一个字都没有，「[图片]」纯粹是客户端
// 常量池里的字面量（hb.class / hb.java:1995）。用最小 class 骨架验证：
// 只清空命中的那一项常量，其余常量一个都不动。
function utf8Entry(text) {
  const bytes = Buffer.from(text, 'utf8');
  const head = Buffer.alloc(3);
  head[0] = 1;
  head.writeUInt16BE(bytes.length, 1);
  return Buffer.concat([head, bytes]);
}
const samplePool = Buffer.concat([utf8Entry('[图片]'), utf8Entry('keep me')]);
const sampleHeader = Buffer.alloc(10);
sampleHeader.writeUInt32BE(0xCAFEBABE, 0);
sampleHeader.writeUInt16BE(0, 4);
sampleHeader.writeUInt16BE(0x32, 6);
sampleHeader.writeUInt16BE(3, 8);
const sampleClass = Buffer.concat([sampleHeader, samplePool]);
const bubblePatched = patchBubbleLabel(sampleClass, BUBBLE_LABEL, '');
equal(bubblePatched.changes.length, 1, 'exactly one bubble-label constant is rewritten');
equal(bubblePatched.output.length, sampleClass.length - 8,
  'clearing the literal shrinks the class by exactly its byte length');
equal(bubblePatched.output.readUInt32BE(0), 0xCAFEBABE, 'the class header survives the rewrite');
equal(bubblePatched.output.indexOf(Buffer.from('[图片]', 'utf8')), -1,
  'the legacy "[图片]" caption is gone from the patched class');
equal(bubblePatched.output.indexOf(Buffer.from('keep me', 'utf8')) >= 0, true,
  'unrelated constants are left untouched');
equal(patchBubbleLabel(sampleClass, '不存在的字面量', '').changes.length, 0,
  'a literal that is not present is a no-op, not a crash');

process.stdout.write(`Client patcher self-test passed: ${assertions} assertions.\n`);
