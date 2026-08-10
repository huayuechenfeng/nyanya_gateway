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

function parseConstantPool(input) {
  if (input.length < 10 || input.readUInt32BE(0) !== 0xCAFEBABE) {
    throw new Error('not a Java class file');
  }

  const count = input.readUInt16BE(8);
  const entries = new Array(count);
  let position = 10;
  for (let index = 1; index < count; index += 1) {
    if (position >= input.length) throw new Error('truncated constant pool');
    const offset = position;
    const tag = input[position];
    position += 1;
    const entry = { index, offset, tag };

    if (tag === 1) {
      if (position + 2 > input.length) throw new Error('truncated UTF-8 constant');
      const length = input.readUInt16BE(position);
      position += 2;
      if (position + length > input.length) throw new Error('truncated UTF-8 value');
      entry.value = input.subarray(position, position + length).toString('utf8');
      position += length;
    }
    else {
      const size = constantSize(tag);
      if (position + size > input.length) throw new Error('truncated constant-pool entry');
      if (tag === 7) entry.nameIndex = input.readUInt16BE(position);
      if (tag === 10) {
        entry.classIndex = input.readUInt16BE(position);
        entry.nameAndTypeIndex = input.readUInt16BE(position + 2);
      }
      if (tag === 12) {
        entry.nameIndex = input.readUInt16BE(position);
        entry.descriptorIndex = input.readUInt16BE(position + 2);
      }
      position += size;
      if (tag === 5 || tag === 6) index += 1;
    }
    entries[entry.index] = entry;
  }
  return { count, endPosition: position, entries };
}

function patchMethodReference(input, owner, fromName, toName, descriptor) {
  const constantPool = parseConstantPool(input);
  const { entries } = constantPool;
  const entryAt = (index, tag) => {
    const entry = entries[index];
    if (!entry || entry.tag !== tag) throw new Error(`invalid constant-pool reference #${index}`);
    return entry;
  };
  const utf8 = (index) => entryAt(index, 1).value;
  const className = (index) => utf8(entryAt(index, 7).nameIndex);
  const nameAndType = (index) => {
    const entry = entryAt(index, 12);
    return { name: utf8(entry.nameIndex), descriptor: utf8(entry.descriptorIndex) };
  };

  const replacements = entries.filter((entry) => {
    if (!entry || entry.tag !== 12) return false;
    const value = nameAndType(entry.index);
    return value.name === toName && value.descriptor === descriptor;
  });
  const targets = entries.filter((entry) => {
    if (!entry || entry.tag !== 10) return false;
    const value = nameAndType(entry.nameAndTypeIndex);
    return className(entry.classIndex) === owner
      && value.name === fromName
      && value.descriptor === descriptor;
  });
  if (targets.length !== 1) {
    throw new Error(`expected one ${owner}.${fromName}${descriptor} reference, found ${targets.length}`);
  }

  let output;
  let replacementIndex;
  let addedConstantPoolEntry = false;
  if (replacements.length > 0) {
    output = Buffer.from(input);
    replacementIndex = replacements[0].index;
  }
  else {
    if (constantPool.count >= 65535) throw new Error('constant pool is full');
    const targetNameEntries = entries.filter((entry) => entry && entry.tag === 1 && entry.value === toName);
    if (targetNameEntries.length === 0) {
      throw new Error(`replacement UTF-8 constant not found: ${toName}`);
    }
    const targetNameAndType = entryAt(targets[0].nameAndTypeIndex, 12);
    replacementIndex = constantPool.count;
    const newNameAndType = Buffer.allocUnsafe(5);
    newNameAndType[0] = 12;
    newNameAndType.writeUInt16BE(targetNameEntries[0].index, 1);
    newNameAndType.writeUInt16BE(targetNameAndType.descriptorIndex, 3);
    output = Buffer.concat([
      input.subarray(0, constantPool.endPosition),
      newNameAndType,
      input.subarray(constantPool.endPosition),
    ]);
    output.writeUInt16BE(constantPool.count + 1, 8);
    addedConstantPoolEntry = true;
  }
  output.writeUInt16BE(replacementIndex, targets[0].offset + 3);
  return {
    output,
    constantPoolIndex: targets[0].index,
    addedConstantPoolEntry,
    from: `${owner}.${fromName}${descriptor}`,
    to: `${owner}.${toName}${descriptor}`,
  };
}

function main(args) {
  if (args.length !== 5) {
    throw new Error('usage: class-methodref-patcher.js CLASS OWNER FROM_NAME TO_NAME DESCRIPTOR');
  }
  const [fileArgument, owner, fromName, toName, descriptor] = args;
  const file = path.resolve(fileArgument);
  const result = patchMethodReference(fs.readFileSync(file), owner, fromName, toName, descriptor);
  fs.writeFileSync(file, result.output);
  process.stdout.write(JSON.stringify({
    file: path.basename(file),
    constantPoolIndex: result.constantPoolIndex,
    addedConstantPoolEntry: result.addedConstantPoolEntry,
    from: result.from,
    to: result.to,
  }) + '\n');
}

try {
  main(process.argv.slice(2));
}
catch (error) {
  process.stderr.write('Class method-reference patch failed: ' + error.message + '\n');
  process.exitCode = 1;
}

module.exports = { patchMethodReference };
