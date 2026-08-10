'use strict';

const fs = require('node:fs');
const path = require('node:path');

function constantSize(tag) {
  if (tag === 3 || tag === 4) return 4;
  if (tag === 5 || tag === 6) return 8;
  if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) return 2;
  if (tag === 9 || tag === 10 || tag === 11 || tag === 12
      || tag === 17 || tag === 18) return 4;
  if (tag === 15) return 3;
  throw new Error('unsupported constant-pool tag: ' + tag);
}

function patchClass(input, replacement) {
  if (input.length < 10 || input.readUInt32BE(0) !== 0xCAFEBABE) {
    throw new Error('not a Java class file');
  }
  const parts = [input.subarray(0, 10)];
  const originals = [];
  const constantCount = input.readUInt16BE(8);
  let position = 10;
  for (let index = 1; index < constantCount; index += 1) {
    if (position >= input.length) throw new Error('truncated constant pool');
    const start = position;
    const tag = input[position];
    position += 1;
    if (tag === 1) {
      if (position + 2 > input.length) throw new Error('truncated UTF-8 constant');
      const length = input.readUInt16BE(position);
      position += 2;
      if (position + length > input.length) throw new Error('truncated UTF-8 value');
      const valueBytes = input.subarray(position, position + length);
      const value = valueBytes.toString('utf8');
      if (/^socket:\/\/[^/:]+:14000$/.test(value)) {
        const encoded = Buffer.from(replacement, 'ascii');
        if (encoded.length > 65535) throw new Error('replacement URI is too long');
        const header = Buffer.allocUnsafe(3);
        header[0] = 1;
        header.writeUInt16BE(encoded.length, 1);
        parts.push(header, encoded);
        originals.push(value);
      } else {
        position += length;
        parts.push(input.subarray(start, position));
        continue;
      }
      position += length;
      continue;
    }
    const size = constantSize(tag);
    position += size;
    if (position > input.length) throw new Error('truncated constant-pool entry');
    parts.push(input.subarray(start, position));
    if (tag === 5 || tag === 6) index += 1;
  }
  parts.push(input.subarray(position));
  return { output: Buffer.concat(parts), originals };
}

function classFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.class')) files.push(fullPath);
    }
  }
  return files.sort();
}

function main(args) {
  if (args.length !== 2) throw new Error('usage: class-endpoint-patcher.js ROOT REPLACEMENT_URI');
  const root = path.resolve(args[0]);
  const replacement = args[1];
  if (!/^socket:\/\/[A-Za-z0-9.-]+:\d{1,5}$/.test(replacement)) {
    throw new Error('replacement must be an ASCII socket URI');
  }
  const modified = [];
  const originals = new Set();
  let replacements = 0;
  for (const file of classFiles(root)) {
    const result = patchClass(fs.readFileSync(file), replacement);
    if (result.originals.length === 0) continue;
    fs.writeFileSync(file, result.output);
    const relative = path.relative(root, file).split(path.sep).join('/');
    modified.push(relative);
    replacements += result.originals.length;
    for (const value of result.originals) originals.add(value);
  }
  if (replacements === 0) throw new Error('no socket://...:14000 constants were found');
  process.stdout.write(JSON.stringify({
    replacement,
    replacements,
    modifiedFiles: modified,
    originalEndpoints: Array.from(originals).sort(),
  }) + '\n');
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write('Class endpoint patch failed: ' + error.message + '\n');
  process.exitCode = 1;
}

module.exports = { patchClass };
