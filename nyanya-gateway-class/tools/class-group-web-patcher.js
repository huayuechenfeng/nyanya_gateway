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

function replacementFor(value, mobileBase) {
  let parsed;
  try { parsed = new URL(String(value)); } catch (_) { return value; }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.searchParams.has('bid')) return value;
  return `${mobileBase}/forward.jsp${parsed.search}`;
}

function patchClass(input, mobileBase) {
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
      const replacement = replacementFor(value, mobileBase);
      if (replacement === value) {
        parts.push(input.subarray(start, position));
      } else {
        const encoded = Buffer.from(replacement, 'ascii');
        const header = Buffer.alloc(3);
        header[0] = 1;
        header.writeUInt16BE(encoded.length, 1);
        parts.push(header, encoded);
        changes.push({ from: value, to: replacement });
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
  if (fs.statSync(root).isFile()) return [root];
  const files = [];
  const pending = [root];
  while (pending.length) {
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
  if (args.length !== 2) throw new Error('usage: class-group-web-patcher.js CLASS_OR_ROOT MOBILE_BASE');
  const root = path.resolve(args[0]);
  const mobileBase = args[1].replace(/\/$/, '');
  if (!/^http:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(mobileBase)) {
    throw new Error('mobile base must be an ASCII HTTP URL with an optional port');
  }
  const modifiedFiles = [];
  const changes = [];
  for (const file of classFiles(root)) {
    const result = patchClass(fs.readFileSync(file), mobileBase);
    if (!result.changes.length) continue;
    fs.writeFileSync(file, result.output);
    modifiedFiles.push(path.relative(fs.statSync(root).isDirectory() ? root : path.dirname(root), file)
      .split(path.sep).join('/'));
    changes.push(...result.changes);
  }
  const bids = new Set(changes.map((change) => new URL(change.from).searchParams.get('bid')));
  if (!bids.has('205') || !bids.has('342')) {
    throw new Error('J2ME create/search group WAP entries were not both found');
  }
  process.stdout.write(JSON.stringify({
    modifiedFiles, replacements: changes.length, bids: Array.from(bids).sort((a, b) => Number(a) - Number(b)),
  }) + '\n');
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`Group web patch failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { classFiles, patchClass, replacementFor };
