'use strict';

// Minimal JCE/Tars codec for the WUP calls used by MobileQQ 2013 for Symbian.
// It intentionally implements the wire primitives rather than generated
// service classes, so the account/friend/message domain remains shared with
// the legacy J2ME protocol adapter.

const TYPE_BYTE = 0;
const TYPE_SHORT = 1;
const TYPE_INT = 2;
const TYPE_LONG = 3;
const TYPE_FLOAT = 4;
const TYPE_DOUBLE = 5;
const TYPE_STRING1 = 6;
const TYPE_STRING4 = 7;
const TYPE_MAP = 8;
const TYPE_LIST = 9;
const TYPE_STRUCT_BEGIN = 10;
const TYPE_STRUCT_END = 11;
const TYPE_ZERO = 12;
const TYPE_SIMPLE_LIST = 13;

class Reader {
  constructor(buffer, start, end) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('JCE input must be a Buffer');
    this.buffer = buffer;
    this.offset = start || 0;
    this.end = end === undefined ? buffer.length : end;
    if (this.offset < 0 || this.end < this.offset || this.end > buffer.length) {
      throw new RangeError('invalid JCE reader bounds');
    }
  }

  require(length) {
    if (length < 0 || this.offset + length > this.end) throw new Error('truncated JCE value');
  }

  head() {
    this.require(1);
    const first = this.buffer[this.offset++];
    const type = first & 0x0F;
    let tag = first >>> 4;
    if (tag === 15) {
      this.require(1);
      tag = this.buffer[this.offset++];
    }
    return { tag, type };
  }

  field() {
    const head = this.head();
    return { tag: head.tag, type: head.type, value: this.value(head.type) };
  }

  integer() {
    const field = this.field();
    if (![TYPE_BYTE, TYPE_SHORT, TYPE_INT, TYPE_LONG, TYPE_ZERO].includes(field.type)) {
      throw new Error('JCE collection length is not an integer');
    }
    return Number(field.value);
  }

  value(type) {
    switch (type) {
      case TYPE_ZERO:
        return 0;
      case TYPE_BYTE:
        this.require(1);
        return this.buffer.readInt8(this.offset++);
      case TYPE_SHORT: {
        this.require(2);
        const value = this.buffer.readInt16BE(this.offset);
        this.offset += 2;
        return value;
      }
      case TYPE_INT: {
        this.require(4);
        const value = this.buffer.readInt32BE(this.offset);
        this.offset += 4;
        return value;
      }
      case TYPE_LONG: {
        this.require(8);
        const value = this.buffer.readBigInt64BE(this.offset);
        this.offset += 8;
        return value;
      }
      case TYPE_FLOAT: {
        this.require(4);
        const value = this.buffer.readFloatBE(this.offset);
        this.offset += 4;
        return value;
      }
      case TYPE_DOUBLE: {
        this.require(8);
        const value = this.buffer.readDoubleBE(this.offset);
        this.offset += 8;
        return value;
      }
      case TYPE_STRING1: {
        this.require(1);
        const length = this.buffer[this.offset++];
        this.require(length);
        const value = this.buffer.subarray(this.offset, this.offset + length).toString('utf8');
        this.offset += length;
        return value;
      }
      case TYPE_STRING4: {
        this.require(4);
        const length = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        this.require(length);
        const value = this.buffer.subarray(this.offset, this.offset + length).toString('utf8');
        this.offset += length;
        return value;
      }
      case TYPE_MAP: {
        const count = this.integer();
        if (count < 0 || count > 100000) throw new Error('invalid JCE map size');
        const value = new Map();
        for (let index = 0; index < count; index += 1) {
          value.set(this.field().value, this.field().value);
        }
        return value;
      }
      case TYPE_LIST: {
        const count = this.integer();
        if (count < 0 || count > 100000) throw new Error('invalid JCE list size');
        const value = [];
        for (let index = 0; index < count; index += 1) value.push(this.field().value);
        return value;
      }
      case TYPE_SIMPLE_LIST: {
        const element = this.head();
        if (element.type !== TYPE_BYTE) throw new Error('unsupported JCE simple-list element type');
        const length = this.integer();
        if (length < 0) throw new Error('invalid JCE byte-vector size');
        this.require(length);
        const value = Buffer.from(this.buffer.subarray(this.offset, this.offset + length));
        this.offset += length;
        return value;
      }
      case TYPE_STRUCT_BEGIN: {
        const fields = new Map();
        while (this.offset < this.end) {
          const field = this.field();
          if (field.type === TYPE_STRUCT_END) return fields;
          fields.set(field.tag, field.value);
        }
        throw new Error('unterminated JCE struct');
      }
      case TYPE_STRUCT_END:
        return null;
      default:
        throw new Error('unsupported JCE type ' + type);
    }
  }

  fields() {
    const fields = new Map();
    while (this.offset < this.end) {
      const field = this.field();
      if (field.type === TYPE_STRUCT_END) break;
      fields.set(field.tag, field.value);
    }
    return fields;
  }
}

function head(tag, type) {
  if (!Number.isInteger(tag) || tag < 0 || tag > 255) throw new RangeError('invalid JCE tag');
  if (tag < 15) return Buffer.from([(tag << 4) | type]);
  return Buffer.from([0xF0 | type, tag]);
}

function integer(tag, value) {
  if (typeof value === 'bigint') {
    const output = Buffer.alloc(8);
    output.writeBigInt64BE(value);
    return Buffer.concat([head(tag, TYPE_LONG), output]);
  }
  if (!Number.isSafeInteger(value)) throw new TypeError('JCE integer must be a safe integer');
  if (value === 0) return head(tag, TYPE_ZERO);
  if (value >= -128 && value <= 127) {
    const output = Buffer.alloc(1);
    output.writeInt8(value);
    return Buffer.concat([head(tag, TYPE_BYTE), output]);
  }
  if (value >= -32768 && value <= 32767) {
    const output = Buffer.alloc(2);
    output.writeInt16BE(value);
    return Buffer.concat([head(tag, TYPE_SHORT), output]);
  }
  if (value >= -2147483648 && value <= 2147483647) {
    const output = Buffer.alloc(4);
    output.writeInt32BE(value);
    return Buffer.concat([head(tag, TYPE_INT), output]);
  }
  return integer(tag, BigInt(value));
}

function string(tag, value) {
  const encoded = Buffer.from(String(value), 'utf8');
  if (encoded.length < 256) {
    return Buffer.concat([head(tag, TYPE_STRING1), Buffer.from([encoded.length]), encoded]);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.length);
  return Buffer.concat([head(tag, TYPE_STRING4), length, encoded]);
}

function bytes(tag, value) {
  if (!Buffer.isBuffer(value)) throw new TypeError('JCE byte-vector value must be a Buffer');
  return Buffer.concat([
    head(tag, TYPE_SIMPLE_LIST),
    head(0, TYPE_BYTE),
    integer(0, value.length),
    value,
  ]);
}

function map(tag, entries, encodeKey, encodeValue) {
  const list = entries instanceof Map ? [...entries.entries()] : [...entries];
  const parts = [head(tag, TYPE_MAP), integer(0, list.length)];
  for (const [key, value] of list) {
    parts.push(encodeKey(0, key));
    parts.push(encodeValue(1, value));
  }
  return Buffer.concat(parts);
}

function list(tag, values, encodeValue) {
  const items = Array.from(values || []);
  const encoder = encodeValue || ((_, value) => value);
  return Buffer.concat([
    head(tag, TYPE_LIST),
    integer(0, items.length),
    ...items.map((value) => encoder(0, value)),
  ]);
}

function stringMap(tag, entries) {
  return map(tag, entries, string, string);
}

function struct(fields) {
  return Buffer.concat([head(0, TYPE_STRUCT_BEGIN), ...(fields || []), head(0, TYPE_STRUCT_END)]);
}

function uniPacket(entries) {
  return map(0, entries, string, (tag, innerEntries) => map(
    tag,
    innerEntries,
    string,
    (innerTag, value) => bytes(innerTag, value),
  ));
}

function parseUniPacket(buffer) {
  const reader = new Reader(buffer);
  const field = reader.field();
  if (field.tag !== 0 || field.type !== TYPE_MAP || !(field.value instanceof Map)) {
    throw new Error('WUP parameter buffer is not a UniPacket v2 map');
  }
  if (reader.offset !== reader.end) throw new Error('trailing bytes in WUP parameter map');
  return field.value;
}

function parseRequestPacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) throw new Error('WUP request is too short');
  const packetLength = buffer.readUInt32BE(0);
  if (packetLength < 4 || packetLength > buffer.length) throw new Error('invalid WUP request length');
  const fields = new Reader(buffer, 4, packetLength).fields();
  const parameters = fields.has(7) ? parseUniPacket(fields.get(7)) : new Map();
  return {
    packetLength,
    version: fields.get(1) === undefined ? 2 : Number(fields.get(1)),
    packetType: fields.get(2) === undefined ? 0 : Number(fields.get(2)),
    messageType: fields.get(3) === undefined ? 0 : Number(fields.get(3)),
    requestId: fields.get(4) === undefined ? 0 : Number(fields.get(4)),
    servant: fields.get(5) || '',
    functionName: fields.get(6) || '',
    parameters,
    timeout: fields.get(8) === undefined ? 0 : Number(fields.get(8)),
    suffix: Buffer.from(buffer.subarray(packetLength)),
  };
}

function responsePacket(request, parameterEntries, result) {
  const body = Buffer.concat([
    integer(1, request.version),
    integer(2, request.packetType),
    integer(3, request.requestId),
    integer(4, request.messageType),
    integer(5, result || 0),
    bytes(6, uniPacket(parameterEntries || [])),
    stringMap(7, []),
    string(8, ''),
    stringMap(9, []),
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length + 4);
  return Buffer.concat([length, body]);
}

function parseResponsePacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) throw new Error('WUP response is too short');
  const packetLength = buffer.readUInt32BE(0);
  if (packetLength < 4 || packetLength > buffer.length) throw new Error('invalid WUP response length');
  const fields = new Reader(buffer, 4, packetLength).fields();
  return {
    packetLength,
    version: Number(fields.get(1) || 0),
    packetType: Number(fields.get(2) || 0),
    requestId: Number(fields.get(3) || 0),
    messageType: Number(fields.get(4) || 0),
    result: Number(fields.get(5) || 0),
    parameters: fields.has(6) ? parseUniPacket(fields.get(6)) : new Map(),
    description: fields.get(8) || '',
  };
}

module.exports = {
  Reader,
  TYPE_MAP,
  bytes,
  head,
  integer,
  list,
  map,
  parseRequestPacket,
  parseResponsePacket,
  parseUniPacket,
  responsePacket,
  string,
  struct,
  uniPacket,
};
