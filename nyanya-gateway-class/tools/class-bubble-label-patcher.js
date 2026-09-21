'use strict';

// 群图片气泡字幕补丁。
//
// 背景：老客户端收到群图片（0x0094 富媒体块）时，会**自己** new 一个可点击元素，
// 字幕写死成 "[图片]" —— 例如 QQ2011 11.00.12 里是常量池的字符串常量，
// 对应反编译的 `hb.java:1995  new gg("[图片]", C, this.N.c - 12 - ok.e, string)`
// （同族还有 `im.java:10` 的 UTF-16BE 字节数组常量，那个藏在字节码指令里，本工具不碰）。
//
// 网关发过去的正文里只有图片块、一个文字都没有，所以这几个字只能在客户端抹掉。
// 本工具把常量池里**正好等于** "[图片]" 的 Utf8 项替换成空串，
// 于是气泡里那行字就不见了（元素宽度由 gg 的构造参数决定，不依赖文本长度）。
//
// 只做字节级字符串替换，不重新编译、不动字节码；class 文件因此变短 8 字节，
// 但常量池索引与各方法体内的相对偏移都不受影响，结构保持合法。

const fs = require('node:fs');
const path = require('node:path');
const { classFiles } = require('./class-group-web-patcher');

// 用转义写法，避免源码里出现中文带来的编码歧义。
// Java class 常量池用的是 modified UTF-8；对 BMP 字符它与标准 UTF-8 完全一致。
const BUBBLE_LABEL = '\u005b\u56fe\u7247\u005d'; // "[图片]"
const BUBBLE_LABEL_EMPTY = '';                    // 清空

function constantSize(tag) {
  if (tag === 3 || tag === 4) return 4;
  if (tag === 5 || tag === 6) return 8;
  if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) return 2;
  if (tag === 9 || tag === 10 || tag === 11 || tag === 12
      || tag === 17 || tag === 18) return 4;
  if (tag === 15) return 3;
  throw new Error(`unsupported constant-pool tag ${tag}`);
}

// 把常量池里每个等于 from 的 CONSTANT_Utf8 项换成 to。
// 用字节比较而不是解码成字符串：既精确，也不怕老客户端里混着非法 UTF-8 常量。
function patchClass(input, from, to) {
  if (input.length < 10 || input.readUInt32BE(0) !== 0xCAFEBABE) {
    throw new Error('not a Java class file');
  }
  const fromBytes = Buffer.from(from, 'utf8');
  const toBytes = Buffer.from(to, 'utf8');
  if (fromBytes.length === 0) throw new Error('the source literal must not be empty');
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
      const bytes = input.subarray(position, position + length);
      position += length;
      if (bytes.length === fromBytes.length && bytes.equals(fromBytes)) {
        const header = Buffer.alloc(3);
        header[0] = 1;
        header.writeUInt16BE(toBytes.length, 1);
        parts.push(header, toBytes);
        changes.push({ from, to });
      } else {
        parts.push(input.subarray(start, position));
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

function main(args) {
  const allowEmpty = args.includes('--allow-empty');
  const positional = args.filter((argument) => !argument.startsWith('--'));
  if (positional.length !== 1) {
    throw new Error('usage: class-bubble-label-patcher.js CLASS_OR_ROOT [--allow-empty]');
  }
  const root = path.resolve(positional[0]);
  const isDirectory = fs.statSync(root).isDirectory();
  const relativeRoot = isDirectory ? root : path.dirname(root);
  const modifiedFiles = [];
  let replacements = 0;
  for (const file of classFiles(root)) {
    const result = patchClass(fs.readFileSync(file), BUBBLE_LABEL, BUBBLE_LABEL_EMPTY);
    if (!result.changes.length) continue;
    fs.writeFileSync(file, result.output);
    replacements += result.changes.length;
    modifiedFiles.push(path.relative(relativeRoot, file).split(path.sep).join('/'));
  }
  // 没有这个字面量的客户端（例如不带群图片块的版本）走 allow-empty，不当成失败；
  // 摘要里的 replacements=0 就是"没打上"的信号。
  if (replacements === 0 && !allowEmpty) {
    throw new Error('no group-image bubble label literal was found to clear');
  }
  process.stdout.write(JSON.stringify({
    modifiedFiles, replacements, from: BUBBLE_LABEL, to: BUBBLE_LABEL_EMPTY,
  }) + '\n');
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`Bubble label patch failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { BUBBLE_LABEL, BUBBLE_LABEL_EMPTY, patchClass };
