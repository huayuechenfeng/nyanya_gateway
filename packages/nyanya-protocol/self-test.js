'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CAPABILITY,
  FrameReader,
  MAGIC,
  PROTOCOL_VERSION,
  SERVER_CAPABILITIES,
  TYPE,
  VERSION,
  encode,
  negotiateAuth,
  normalizeCapabilities,
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

function loadVectors() {
  const filename = path.join(__dirname, 'vectors', 'v1.tsv');
  return fs.readFileSync(filename, 'utf8').split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const fields = line.split('\t');
      return {
        name: fields[0],
        type: Number(fields[1]),
        seq: Number(fields[2]),
        payload: Buffer.from(fields[3], 'hex'),
        frameHex: fields[4],
      };
    });
}

function testFrames() {
  equal(MAGIC, 0x4a51, 'v1 magic remains stable');
  equal(VERSION, 1, 'frame version remains v1');
  equal(PROTOCOL_VERSION, VERSION, 'semantic and frame versions should agree');
  const vectors = loadVectors();
  equal(vectors.length, 2, 'two cross-language vectors should be present');
  for (const vector of vectors) {
    equal(encode(vector.type, vector.seq, vector.payload).toString('hex'), vector.frameHex,
      vector.name + ' should match the golden bytes');
    const frame = Buffer.from(vector.frameHex, 'hex');
    const reader = new FrameReader();
    deepEqual(reader.feed(frame.subarray(0, 5)), [], vector.name + ' should buffer a partial header');
    const decoded = reader.feed(frame.subarray(5));
    equal(decoded.length, 1, vector.name + ' should decode exactly once');
    equal(decoded[0].type, vector.type, vector.name + ' type');
    equal(decoded[0].seq, vector.seq, vector.name + ' sequence');
    equal(decoded[0].body.toString('hex'), vector.payload.toString('hex'), vector.name + ' payload');
  }

  const bad = encode(TYPE.PING, 1, {}).subarray();
  bad[2] = 99;
  assert.throws(() => new FrameReader().feed(bad), /bad frame header/);
  assertions += 1;
}

function testHandshake() {
  const legacy = negotiateAuth({ device: 'old-j2me', token: 'x' });
  equal(legacy.ok, true, 'missing version should remain compatible with v1');
  equal(legacy.protocolVersion, 1);
  equal(legacy.legacyClient, true);
  deepEqual(legacy.capabilities, SERVER_CAPABILITIES,
    'legacy clients retain the complete historical v1 behavior');

  const modern = negotiateAuth({
    protocolVersion: 1,
    capabilities: [CAPABILITY.TEXT, CAPABILITY.CONTACTS, 'future-feature', CAPABILITY.TEXT],
  });
  equal(modern.ok, true);
  equal(modern.legacyClient, false);
  deepEqual(modern.capabilities, [CAPABILITY.TEXT, CAPABILITY.CONTACTS]);

  const rejected = negotiateAuth({ protocolVersion: 99, capabilities: [] });
  equal(rejected.ok, false);
  equal(rejected.code, 'unsupported_protocol_version');
  deepEqual(rejected.supportedVersions, [1]);
  deepEqual(normalizeCapabilities([' text ', '', 'text', 1, 'notice']), ['text', 'notice']);
}

function main() {
  testFrames();
  testHandshake();
  console.log(`[nyanya-protocol self-test] ${assertions} assertions passed`);
}

main();
