'use strict';

const assert = require('node:assert/strict');
const { classifyInventory, parseManifest } = require('../tools/client-jar-analyzer');
const { replacementFor } = require('../tools/class-group-web-patcher');
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
equal(generic.patches.groupWeb, false, 'generic profile skips version-specific group URLs');

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

process.stdout.write(`Client patcher self-test passed: ${assertions} assertions.\n`);
