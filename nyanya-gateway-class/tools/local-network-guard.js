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
  throw new Error(`unsupported constant-pool tag ${tag}`);
}

function makeNetworkRestricted(value, allowedHost) {
  const allowed = new Set(['127.0.0.1', 'localhost', String(allowedHost || '').toLowerCase()]);
  let output = value.replace(/\b(https?|socket):\/\/([A-Za-z0-9.-]+)(?::\d+)?/gi,
    (match, scheme, host) => {
      if (allowed.has(host.toLowerCase())) return match;
      return `${scheme}://127.0.0.1:1`;
    });
  output = output.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    (address) => allowed.has(address.toLowerCase()) ? address : '127.0.0.1');
  output = output.replace(/\b(?:[A-Za-z0-9-]+\.)+(?:qq\.com|qq\.cn)\b/gi,
    (hostname) => allowed.has(hostname.toLowerCase()) ? hostname : '127.0.0.1');
  return output;
}

function patchClass(input, allowedHost) {
  if (input.length < 10 || input.readUInt32BE(0) !== 0xCAFEBABE) {
    throw new Error('not a Java class file');
  }
  const parts = [input.subarray(0, 10)];
  const changes = [];
  const count = input.readUInt16BE(8);
  let position = 10;
  for (let index = 1; index < count; index += 1) {
    const start = position;
    const tag = input[position++];
    if (tag === 1) {
      const length = input.readUInt16BE(position);
      position += 2;
      const value = input.subarray(position, position + length).toString('utf8');
      position += length;
      const guarded = makeNetworkRestricted(value, allowedHost);
      if (guarded === value) {
        parts.push(input.subarray(start, position));
      } else {
        const encoded = Buffer.from(guarded, 'utf8');
        if (encoded.length > 65535) throw new Error('rewritten UTF-8 constant is too long');
        const header = Buffer.alloc(3);
        header[0] = 1;
        header.writeUInt16BE(encoded.length, 1);
        parts.push(header, encoded);
        changes.push({ from: value, to: guarded });
      }
      continue;
    }
    position += constantSize(tag);
    if (position > input.length) throw new Error('truncated constant pool');
    parts.push(input.subarray(start, position));
    if (tag === 5 || tag === 6) index += 1;
  }
  parts.push(input.subarray(position));
  return { output: Buffer.concat(parts), changes };
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
  const allowEmpty = args[0] === '--allow-empty';
  const values = allowEmpty ? args.slice(1) : args;
  if (values.length !== 2) {
    throw new Error('usage: local-network-guard.js [--allow-empty] STAGING_ROOT ALLOWED_HOST');
  }
  const root = path.resolve(values[0]);
  const allowedHost = values[1];
  const modifiedFiles = [];
  let replacements = 0;
  for (const file of classFiles(root)) {
    const result = patchClass(fs.readFileSync(file), allowedHost);
    if (result.changes.length === 0) continue;
    fs.writeFileSync(file, result.output);
    modifiedFiles.push(path.relative(root, file).split(path.sep).join('/'));
    replacements += result.changes.length;
  }
  const manifest = path.join(root, 'META-INF', 'MANIFEST.MF');
  if (fs.existsSync(manifest)) {
    const original = fs.readFileSync(manifest, 'utf8');
    const guarded = makeNetworkRestricted(original, allowedHost);
    if (guarded !== original) {
      fs.writeFileSync(manifest, guarded, 'utf8');
      modifiedFiles.push('META-INF/MANIFEST.MF');
      replacements += 1;
    }
  }
  if (replacements === 0 && !allowEmpty) throw new Error('no external network literals were found');
  process.stdout.write(JSON.stringify({ modifiedFiles, replacements }) + '\n');
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`Local network guard failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { makeNetworkRestricted, patchClass };
