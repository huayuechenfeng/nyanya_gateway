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
    const offset = position;
    const tag = input[position];
    position += 1;
    const entry = { index, offset, tag };
    if (tag === 1) {
      const length = input.readUInt16BE(position);
      position += 2;
      entry.value = input.subarray(position, position + length).toString('utf8');
      position += length;
    } else {
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
  return { entries, endPosition: position };
}

function readAttribute(input, position) {
  const length = input.readUInt32BE(position + 2);
  const end = position + 6 + length;
  if (end > input.length) throw new Error('truncated class attribute');
  return { nameIndex: input.readUInt16BE(position), length, start: position, end };
}

function skipMembers(input, position, count) {
  for (let index = 0; index < count; index += 1) {
    const attributeCount = input.readUInt16BE(position + 6);
    position += 8;
    for (let attributeIndex = 0; attributeIndex < attributeCount; attributeIndex += 1) {
      position = readAttribute(input, position).end;
    }
  }
  return position;
}

function patchDirectHttpOpen(input) {
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

  const connectorDescriptor = '(Ljava/lang/String;)Ljavax/microedition/io/Connection;';
  const connectorReferences = entries.filter((entry) => {
    if (!entry || entry.tag !== 10) return false;
    const member = nameAndType(entry.nameAndTypeIndex);
    return className(entry.classIndex) === 'javax/microedition/io/Connector'
      && member.name === 'open' && member.descriptor === connectorDescriptor;
  });
  const httpConnectionClasses = entries.filter((entry) => entry && entry.tag === 7
    && className(entry.index) === 'javax/microedition/io/HttpConnection');
  if (connectorReferences.length !== 1 || httpConnectionClasses.length !== 1) {
    throw new Error(`expected one Connector.open and HttpConnection constant, found `
      + `${connectorReferences.length} and ${httpConnectionClasses.length}`);
  }

  let position = constantPool.endPosition + 6;
  const interfaceCount = input.readUInt16BE(position);
  position += 2 + interfaceCount * 2;
  const fieldCount = input.readUInt16BE(position);
  position = skipMembers(input, position + 2, fieldCount);
  const methodCount = input.readUInt16BE(position);
  position += 2;

  const targetDescriptor = '(Ljava/lang/String;)Ljavax/microedition/io/HttpConnection;';
  let target;
  for (let methodIndex = 0; methodIndex < methodCount; methodIndex += 1) {
    const methodStart = position;
    const accessFlags = input.readUInt16BE(position);
    const name = utf8(input.readUInt16BE(position + 2));
    const descriptor = utf8(input.readUInt16BE(position + 4));
    const attributeCount = input.readUInt16BE(position + 6);
    position += 8;
    for (let attributeIndex = 0; attributeIndex < attributeCount; attributeIndex += 1) {
      const attribute = readAttribute(input, position);
      if (name === 'open' && descriptor === targetDescriptor && utf8(attribute.nameIndex) === 'Code') {
        if (target) throw new Error('multiple matching http.open Code attributes');
        target = { accessFlags, methodStart, attribute };
      }
      position = attribute.end;
    }
  }
  if (!target) throw new Error('http.open(String) Code attribute not found');
  if ((target.accessFlags & 0x0008) === 0) throw new Error('http.open(String) is not static');

  const code = Buffer.alloc(8);
  code[0] = 0x2A; // aload_0
  code[1] = 0xB8; // invokestatic javax.microedition.io.Connector.open
  code.writeUInt16BE(connectorReferences[0].index, 2);
  code[4] = 0xC0; // checkcast javax.microedition.io.HttpConnection
  code.writeUInt16BE(httpConnectionClasses[0].index, 5);
  code[7] = 0xB0; // areturn

  const replacement = Buffer.alloc(26);
  replacement.writeUInt16BE(target.attribute.nameIndex, 0);
  replacement.writeUInt32BE(20, 2);
  replacement.writeUInt16BE(1, 6); // max_stack
  replacement.writeUInt16BE(1, 8); // max_locals
  replacement.writeUInt32BE(code.length, 10);
  code.copy(replacement, 14);
  replacement.writeUInt16BE(0, 22); // exception_table_length
  replacement.writeUInt16BE(0, 24); // attributes_count

  return {
    output: Buffer.concat([
      input.subarray(0, target.attribute.start), replacement, input.subarray(target.attribute.end),
    ]),
    connectorReference: connectorReferences[0].index,
    httpConnectionClass: httpConnectionClasses[0].index,
    oldCodeAttributeLength: target.attribute.length,
    newCodeAttributeLength: 20,
  };
}

function inspectAoDirectMode(input) {
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
  let position = constantPool.endPosition + 6;
  const interfaceCount = input.readUInt16BE(position);
  position += 2 + interfaceCount * 2;
  const fieldCount = input.readUInt16BE(position);
  position = skipMembers(input, position + 2, fieldCount);
  const methodCount = input.readUInt16BE(position);
  position += 2;
  let codeAttribute;
  for (let methodIndex = 0; methodIndex < methodCount; methodIndex += 1) {
    const name = utf8(input.readUInt16BE(position + 2));
    const descriptor = utf8(input.readUInt16BE(position + 4));
    const attributeCount = input.readUInt16BE(position + 6);
    position += 8;
    for (let attributeIndex = 0; attributeIndex < attributeCount; attributeIndex += 1) {
      const attribute = readAttribute(input, position);
      if (name === 'a' && descriptor === '(Ljs;Z)Ljavax/microedition/io/HttpConnection;'
          && utf8(attribute.nameIndex) === 'Code') {
        if (codeAttribute) throw new Error('multiple ao HTTP connection methods found');
        codeAttribute = attribute;
      }
      position = attribute.end;
    }
  }
  if (!codeAttribute) throw new Error('ao.a(js, boolean) Code attribute not found');
  const codeLength = input.readUInt32BE(codeAttribute.start + 10);
  const codeStart = codeAttribute.start + 14;
  const codeEnd = codeStart + codeLength;
  if (codeEnd > codeAttribute.end) throw new Error('truncated ao HTTP method code');
  const code = input.subarray(codeStart, codeEnd);

  const candidates = [];
  for (let index = 0; index + 3 < code.length; index += 1) {
    if (code[index] !== 0x1C || code[index + 1] !== 0x99) continue; // iload_2; ifeq
    const directBlock = index + 1 + code.readInt16BE(index + 2);
    if (directBlock < 0 || directBlock >= code.length) continue;

    let callOffset;
    if (code[directBlock] >= 0x2A && code[directBlock] <= 0x2D) {
      callOffset = directBlock + 1; // aload_0 .. aload_3; invokestatic
    }
    else if (code[directBlock] === 0x19 && directBlock + 1 < code.length) {
      callOffset = directBlock + 2; // aload index; invokestatic
    }
    else {
      continue;
    }
    if (callOffset + 2 >= code.length || code[callOffset] !== 0xB8) continue;
    const reference = entries[code.readUInt16BE(callOffset + 1)];
    if (!reference || reference.tag !== 10) continue;
    const owner = className(reference.classIndex);
    const member = nameAndType(reference.nameAndTypeIndex);
    const helperDescriptor = '(Ljava/lang/String;)Ljavax/microedition/io/HttpConnection;';
    const connectorDescriptor = '(Ljava/lang/String;)Ljavax/microedition/io/Connection;';
    let routeKind;
    if (owner === 'http' && member.name === 'jl' && member.descriptor === helperDescriptor) {
      routeKind = 'http-jl-helper';
    }
    else if (owner === 'http' && member.name === 'open' && member.descriptor === helperDescriptor) {
      routeKind = 'http-open-helper';
    }
    else if (owner === 'javax/microedition/io/Connector' && member.name === 'open'
        && member.descriptor === connectorDescriptor) {
      routeKind = 'connector-direct';
    }
    else {
      continue;
    }
    candidates.push({
      branchOffset: index,
      directBlockOffset: directBlock,
      callOffset,
      referenceIndex: reference.index,
      owner,
      name: member.name,
      descriptor: member.descriptor,
      routeKind,
    });
  }
  if (candidates.length !== 1) {
    throw new Error(`expected one recognized proxy-mode branch to a direct HTTP block, found ${candidates.length}`);
  }

  return { ...candidates[0], codeStart };
}

function patchAoDirectMode(input) {
  const inspection = inspectAoDirectMode(input);
  if (inspection.routeKind === 'http-jl-helper') {
    throw new Error('ao.class still calls http.jl(String); repair the method reference before forcing direct mode');
  }

  const output = Buffer.from(input);
  // Keep the original iload_2/ifeq control-flow graph and every bytecode
  // offset intact for CLDC's precomputed StackMap attribute. Replacing only
  // iload_2 with iconst_0 makes the existing ifeq always take the direct path
  // without turning the proxy block into verifier-visible unreachable code.
  output[inspection.codeStart + inspection.branchOffset] = 0x03; // iconst_0
  return {
    output,
    routeKind: inspection.routeKind,
    branchOffset: inspection.branchOffset,
    directBlockOffset: inspection.directBlockOffset,
  };
}

function main(args) {
  if (args.length === 2 && args[0] === '--ao-only') {
    const aoFile = path.resolve(args[1]);
    const aoResult = patchAoDirectMode(fs.readFileSync(aoFile));
    fs.writeFileSync(aoFile, aoResult.output);
    process.stdout.write(JSON.stringify({
      file: path.basename(aoFile),
      aoFile: path.basename(aoFile),
      mode: 'ao-only',
      routeKind: aoResult.routeKind,
      proxyFlagOffset: aoResult.branchOffset,
      directBlockOffset: aoResult.directBlockOffset,
    }) + '\n');
    return;
  }
  if (args.length !== 2) {
    throw new Error('usage: class-direct-http-patcher.js HTTP_CLASS AO_CLASS | --ao-only AO_CLASS');
  }
  const file = path.resolve(args[0]);
  const aoFile = path.resolve(args[1]);
  const result = patchDirectHttpOpen(fs.readFileSync(file));
  fs.writeFileSync(file, result.output);
  const aoResult = patchAoDirectMode(fs.readFileSync(aoFile));
  fs.writeFileSync(aoFile, aoResult.output);
  process.stdout.write(JSON.stringify({
    file: path.basename(file),
    aoFile: path.basename(aoFile),
    mode: 'helper-and-ao',
    routeKind: aoResult.routeKind,
    connectorReference: result.connectorReference,
    httpConnectionClass: result.httpConnectionClass,
    oldCodeAttributeLength: result.oldCodeAttributeLength,
    newCodeAttributeLength: result.newCodeAttributeLength,
    proxyFlagOffset: aoResult.branchOffset,
    directBlockOffset: aoResult.directBlockOffset,
  }) + '\n');
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write('Direct HTTP patch failed: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { inspectAoDirectMode, patchAoDirectMode, patchDirectHttpOpen };
