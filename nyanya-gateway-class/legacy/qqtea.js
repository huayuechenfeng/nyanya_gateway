'use strict';

const crypto = require('node:crypto');

const BLOCK_SIZE = 8;
const KEY_SIZE = 16;
const DELTA = 0x9E3779B9;

function requireBuffer(value, name, length) {
  if (!Buffer.isBuffer(value)) throw new TypeError(name + ' must be a Buffer');
  if (length !== undefined && value.length !== length) {
    throw new RangeError(name + ' must contain exactly ' + length + ' bytes');
  }
}

function teaEncryptBlock(block, key) {
  requireBuffer(block, 'block', BLOCK_SIZE);
  requireBuffer(key, 'key', KEY_SIZE);
  let left = block.readUInt32BE(0);
  let right = block.readUInt32BE(4);
  const k0 = key.readUInt32BE(0);
  const k1 = key.readUInt32BE(4);
  const k2 = key.readUInt32BE(8);
  const k3 = key.readUInt32BE(12);
  let sum = 0;
  for (let round = 0; round < 16; round += 1) {
    sum = (sum + DELTA) >>> 0;
    left = (left + ((((right << 4) >>> 0) + k0) ^ ((right + sum) >>> 0)
      ^ ((right >>> 5) + k1))) >>> 0;
    right = (right + ((((left << 4) >>> 0) + k2) ^ ((left + sum) >>> 0)
      ^ ((left >>> 5) + k3))) >>> 0;
  }
  const output = Buffer.allocUnsafe(BLOCK_SIZE);
  output.writeUInt32BE(left, 0);
  output.writeUInt32BE(right, 4);
  return output;
}

function teaDecryptBlock(block, key) {
  requireBuffer(block, 'block', BLOCK_SIZE);
  requireBuffer(key, 'key', KEY_SIZE);
  let left = block.readUInt32BE(0);
  let right = block.readUInt32BE(4);
  const k0 = key.readUInt32BE(0);
  const k1 = key.readUInt32BE(4);
  const k2 = key.readUInt32BE(8);
  const k3 = key.readUInt32BE(12);
  let sum = 0xE3779B90;
  for (let round = 0; round < 16; round += 1) {
    right = (right - ((((left << 4) >>> 0) + k2) ^ ((left + sum) >>> 0)
      ^ ((left >>> 5) + k3))) >>> 0;
    left = (left - ((((right << 4) >>> 0) + k0) ^ ((right + sum) >>> 0)
      ^ ((right >>> 5) + k1))) >>> 0;
    sum = (sum - DELTA) >>> 0;
  }
  const output = Buffer.allocUnsafe(BLOCK_SIZE);
  output.writeUInt32BE(left, 0);
  output.writeUInt32BE(right, 4);
  return output;
}

function xorBlock(left, right) {
  const output = Buffer.allocUnsafe(BLOCK_SIZE);
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    output[index] = left[index] ^ right[index];
  }
  return output;
}

function randomSource(size) {
  return crypto.randomBytes(size);
}

function encrypt(plainText, key, randomBytes) {
  requireBuffer(plainText, 'plainText');
  requireBuffer(key, 'key', KEY_SIZE);
  const getRandom = randomBytes || randomSource;
  let padding = (plainText.length + 10) % BLOCK_SIZE;
  if (padding !== 0) padding = BLOCK_SIZE - padding;
  const padded = Buffer.alloc(plainText.length + padding + 10);
  let position = 0;
  padded[position] = (getRandom(1)[0] & 0xF8) | padding;
  position += 1;
  if (padding > 0) {
    getRandom(padding).copy(padded, position);
    position += padding;
  }
  getRandom(2).copy(padded, position);
  position += 2;
  plainText.copy(padded, position);
  position += plainText.length;
  padded.fill(0, position, position + 7);

  const encrypted = Buffer.allocUnsafe(padded.length);
  let previousCipher = Buffer.alloc(BLOCK_SIZE);
  let previousPlain = Buffer.alloc(BLOCK_SIZE);
  for (let offset = 0; offset < padded.length; offset += BLOCK_SIZE) {
    const chainedPlain = xorBlock(padded.subarray(offset, offset + BLOCK_SIZE), previousCipher);
    const cipher = xorBlock(teaEncryptBlock(chainedPlain, key), previousPlain);
    cipher.copy(encrypted, offset);
    previousPlain = chainedPlain;
    previousCipher = cipher;
  }
  return encrypted;
}

function decrypt(cipherText, key) {
  requireBuffer(cipherText, 'cipherText');
  requireBuffer(key, 'key', KEY_SIZE);
  if (cipherText.length < 16 || cipherText.length % BLOCK_SIZE !== 0) return null;

  const padded = Buffer.allocUnsafe(cipherText.length);
  let previousCipher = Buffer.alloc(BLOCK_SIZE);
  let previousPlain = Buffer.alloc(BLOCK_SIZE);
  for (let offset = 0; offset < cipherText.length; offset += BLOCK_SIZE) {
    const cipher = cipherText.subarray(offset, offset + BLOCK_SIZE);
    const chainedPlain = teaDecryptBlock(xorBlock(cipher, previousPlain), key);
    xorBlock(chainedPlain, previousCipher).copy(padded, offset);
    previousPlain = chainedPlain;
    previousCipher = Buffer.from(cipher);
  }

  const padding = padded[0] & 0x07;
  const start = padding + 3;
  const end = padded.length - 7;
  if (start > end) return null;
  for (let index = end; index < padded.length; index += 1) {
    if (padded[index] !== 0) return null;
  }
  return Buffer.from(padded.subarray(start, end));
}

module.exports = {
  decrypt,
  encrypt,
  teaDecryptBlock,
  teaEncryptBlock,
};
