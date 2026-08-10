'use strict';

// J2ME QQ 客户端 <-> 网关帧协议 v1
// Magic(2) | Version(1) | Type(1) | Seq(4) | Len(4) | Payload(UTF-8 JSON)
const MAGIC = 0x4a51;
const VERSION = 1;

const TYPE = {
  // 客户端 -> 网关
  AUTH: 1,
  PING: 2,
  PONG: 3,
  SEND_TEXT: 10,
  FETCH_CONTACTS: 11,
  FETCH_HISTORY: 12,
  READ_ACK: 13,
  // 网关 -> 客户端
  AUTH_OK: 20,
  AUTH_FAIL: 21,
  MSG_PUSH: 30,
  CONTACTS_SYNC: 31,
  HISTORY_PAGE: 32,
  KICK: 33,
  NOTICE: 34,
  ERROR: 40,
  SEND_RESULT: 41
};

function encode(type, seq, payload) {
  let body;
  if (Buffer.isBuffer(payload)) {
    body = payload;
  } else if (payload === undefined || payload === null) {
    body = Buffer.alloc(0);
  } else {
    body = Buffer.from(JSON.stringify(payload), 'utf8');
  }
  const header = Buffer.allocUnsafe(12);
  header.writeUInt16BE(MAGIC, 0);
  header.writeUInt8(VERSION, 2);
  header.writeUInt8(type & 0xff, 3);
  header.writeUInt32BE((seq >>> 0) & 0xffffffff, 4);
  header.writeUInt32BE(body.length, 8);
  return Buffer.concat([header, body]);
}

class FrameReader {
  constructor(maxPayload) {
    this.maxPayload = maxPayload || 256 * 1024;
    this.buffer = Buffer.alloc(0);
  }

  feed(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out = [];
    while (this.buffer.length >= 12) {
      const magic = this.buffer.readUInt16BE(0);
      const version = this.buffer.readUInt8(2);
      const type = this.buffer.readUInt8(3);
      const seq = this.buffer.readUInt32BE(4);
      const len = this.buffer.readUInt32BE(8);
      if (magic !== MAGIC || version !== VERSION) {
        throw new Error('bad frame header');
      }
      if (len > this.maxPayload) {
        throw new Error('frame too large: ' + len);
      }
      if (this.buffer.length < 12 + len) break;
      const body = this.buffer.slice(12, 12 + len);
      this.buffer = this.buffer.slice(12 + len);
      out.push({ type, seq, body });
    }
    return out;
  }
}

module.exports = { MAGIC, VERSION, TYPE, encode, FrameReader };
