'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// 零依赖 RFC6455 WebSocket 客户端（支持 Authorization 头，供 OneBot 鉴权使用）
class WsClient {
  constructor(url, options) {
    const opts = options || {};
    this.url = url;
    this.token = opts.token || '';
    this.maxPayload = opts.maxPayload || 4 * 1024 * 1024;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.onOpen = null;
    this.onMessage = null;
    this.onClose = null;
    this.onError = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
        reject(new Error('unsupported websocket url: ' + this.url));
        return;
      }
      const isTls = u.protocol === 'wss:';
      const port = u.port ? Number(u.port) : isTls ? 443 : 80;
      const key = crypto.randomBytes(16).toString('base64');
      const headers = {
        Host: u.host,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13'
      };
      if (this.token) headers.Authorization = 'Bearer ' + this.token;
      const transport = isTls ? https : http;
      const request = transport.request({
        hostname: u.hostname,
        port,
        path: u.pathname || '/',
        headers
      }, () => {
        request.destroy();
        reject(new Error('unexpected HTTP response from websocket endpoint'));
      });
      request.on('upgrade', (response, socket) => {
        const accept = response.headers['sec-websocket-accept'];
        const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
        if (!accept || accept !== expected) {
          socket.destroy();
          reject(new Error('bad websocket accept header'));
          return;
        }
        this.socket = socket;
        socket.setNoDelay(true);
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('close', () => {
          this.socket = null;
          if (this.onClose) this.onClose();
        });
        socket.on('error', (err) => {
          if (this.onError) this.onError(err);
        });
        resolve();
        if (this.onOpen) this.onOpen();
      });
      request.on('error', (err) => reject(err));
      request.end();
    });
  }

  sendText(text) {
    return this._sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  close() {
    if (!this.socket) return;
    try {
      this._sendFrame(0x8, Buffer.alloc(0));
    } catch (err) {
      // ignore
    }
    this.socket.destroy();
  }

  _sendFrame(opcode, payload) {
    if (!this.socket) return false;
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
    return true;
  }

  _onData(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (true) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let len = second & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) {
          this.close();
          return;
        }
        len = Number(big);
        offset = 10;
      }
      if (len > this.maxPayload) {
        this.close();
        return;
      }
      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + len) return;
      let payload = this.buffer.subarray(offset, offset + len);
      this.buffer = this.buffer.slice(offset + len);
      if (maskKey) {
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i & 3];
        payload = unmasked;
      }
      if (opcode === 0x1) {
        if (this.onMessage) this.onMessage(payload.toString('utf8'));
      } else if (opcode === 0x8) {
        this.close();
      } else if (opcode === 0x9) {
        this._sendFrame(0xa, payload);
      }
    }
  }
}

module.exports = { WsClient };
