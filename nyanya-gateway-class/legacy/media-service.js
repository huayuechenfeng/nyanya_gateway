'use strict';

const crypto = require('node:crypto');
const protocol = require('./protocol');

const MAX_MEDIA_BYTES = 10_002_432;
const INNER_MEDIA_NOTIFY = 0x00B5;

function readSizedBuffer(payload, offset, width) {
  if (offset + width > payload.length) throw new Error('media field length is truncated');
  const length = width === 1 ? payload[offset] : payload.readUInt16BE(offset);
  const start = offset + width;
  const end = start + length;
  if (end > payload.length) throw new Error('media field is truncated');
  return { value: Buffer.from(payload.subarray(start, end)), offset: end };
}

function parseNegotiation(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 1) {
    throw new Error('media negotiation is empty');
  }
  const subtype = payload[0];
  if (subtype === 6) {
    if (payload.length !== 13) throw new Error('media ticket request has an invalid length');
    return {
      subtype,
      targetUin: payload.readUInt32BE(1),
      conversationToken: payload.readUInt32BE(5),
      contactToken: payload.readUInt32BE(9),
    };
  }
  if (subtype !== 1 || payload.length < 19) {
    return { subtype, raw: Buffer.from(payload) };
  }
  let offset = 1;
  const targetUin = payload.readUInt32BE(offset); offset += 4;
  let field = readSizedBuffer(payload, offset, 2); const ticket = field.value; offset = field.offset;
  field = readSizedBuffer(payload, offset, 2); const duplicateTicket = field.value; offset = field.offset;
  if (offset + 6 > payload.length) throw new Error('media registration is truncated');
  const reserved = payload.readUInt16BE(offset); offset += 2;
  const size = payload.readUInt32BE(offset); offset += 4;
  field = readSizedBuffer(payload, offset, 2); const filenameBytes = field.value; offset = field.offset;
  field = readSizedBuffer(payload, offset, 1); const hash = field.value; offset = field.offset;
  field = readSizedBuffer(payload, offset, 1); const duplicateHash = field.value; offset = field.offset;
  field = readSizedBuffer(payload, offset, 2); const sourcePath = field.value; offset = field.offset;
  if (offset !== payload.length) throw new Error('media registration contains trailing bytes');
  if (size <= 0 || size > MAX_MEDIA_BYTES) throw new Error('media size is outside the client limit');
  return {
    subtype, targetUin, ticket, duplicateTicket, reserved, size,
    filename: protocol.decodeLegacyText(filenameBytes),
    hash, duplicateHash, sourcePath,
  };
}

function parseServiceEnvelope(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 48) {
    throw new Error('media service envelope is too short');
  }
  // Two client families use the same 0x00B5 body with different service
  // prefixes. The older synthetic/J2ME form starts the inner command at 26;
  // the packets captured from both real J2ME and Symbian clients start it at
  // 32 and place the session sender/target at offsets 8/12.
  let senderOffset;
  let targetOffset;
  let innerOffset;
  let subtypeOffset;
  let bodyOffset;
  let layout;
  if (payload.length >= 54 && payload.readUInt16BE(32) === INNER_MEDIA_NOTIFY) {
    senderOffset = 8;
    targetOffset = 12;
    innerOffset = 32;
    subtypeOffset = 53;
    bodyOffset = 54;
    layout = 'service32';
  } else if (payload.readUInt16BE(26) === INNER_MEDIA_NOTIFY) {
    senderOffset = 2;
    targetOffset = 6;
    innerOffset = 26;
    subtypeOffset = 47;
    bodyOffset = 48;
    layout = 'service26';
  } else {
    const candidate = payload.length >= 34 ? payload.readUInt16BE(32) : payload.readUInt16BE(26);
    throw new Error(`unsupported media service command 0x${candidate.toString(16)}`);
  }
  const innerCommand = payload.readUInt16BE(innerOffset);
  if (innerCommand !== INNER_MEDIA_NOTIFY) {
    throw new Error(`unsupported media service command 0x${innerCommand.toString(16)}`);
  }
  const senderUin = payload.readUInt32BE(senderOffset);
  const targetUin = payload.readUInt32BE(targetOffset);
  const subtype = payload[subtypeOffset];
  if (subtype === 2) {
    if (bodyOffset >= payload.length) throw new Error('media acceptance is truncated');
    const result = payload[bodyOffset];
    const field = readSizedBuffer(payload, bodyOffset + 1, 1);
    if (field.offset !== payload.length) throw new Error('media acceptance contains trailing bytes');
    return { innerCommand, senderUin, targetUin, subtype, result, hash: field.value, layout };
  }
  if (subtype === 3) {
    const field = readSizedBuffer(payload, bodyOffset, 1);
    if (field.offset !== payload.length) throw new Error('media completion contains trailing bytes');
    return { innerCommand, senderUin, targetUin, subtype, hash: field.value, layout };
  }
  if (subtype !== 1) {
    return { innerCommand, senderUin, targetUin, subtype, raw: Buffer.from(payload), layout };
  }
  let field = readSizedBuffer(payload, bodyOffset, 2);
  const filename = protocol.decodeLegacyText(field.value);
  field = readSizedBuffer(payload, field.offset, 1);
  const hash = field.value;
  let offset = field.offset;
  if (offset + 5 !== payload.length) throw new Error('media announcement is truncated');
  const mediaType = payload[offset]; offset += 1;
  const size = payload.readUInt32BE(offset);
  if (size <= 0 || size > MAX_MEDIA_BYTES) throw new Error('media size is outside the client limit');
  return { innerCommand, senderUin, targetUin, subtype, filename, hash, mediaType, size, layout };
}

function buildTicketResponse(ticket) {
  const payload = Buffer.alloc(9 + ticket.length);
  payload[0] = 6;
  payload.writeUInt32BE(0, 1);
  payload.writeUInt16BE(0, 5);
  payload.writeUInt16BE(ticket.length, 7);
  ticket.copy(payload, 9);
  return payload;
}

function ipv4Number(value) {
  const normalized = String(value || '').replace(/^::ffff:/, '');
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`media upload host must be IPv4, received ${value}`);
  }
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function buildUploadTargetResponse(options) {
  const fileKey = options.fileKey;
  const uploadKey = options.uploadKey;
  const payload = Buffer.alloc(42 + fileKey.length + uploadKey.length);
  payload[0] = 1;
  payload.writeUInt32BE(0, 1);
  payload.writeUInt16BE(0, 5);
  payload.writeUInt32BE(ipv4Number(options.host), 27);
  payload.writeUInt16BE(Number(options.port), 31);
  payload.writeUInt16BE(fileKey.length, 33);
  fileKey.copy(payload, 35);
  let offset = 35 + fileKey.length;
  payload.writeUInt16BE(uploadKey.length, offset); offset += 2;
  uploadKey.copy(payload, offset); offset += uploadKey.length;
  payload[offset] = 0; offset += 1;
  payload.writeUInt32BE(0, offset);
  return payload;
}

function buildServiceResult(peerUin, subtype, hash, result) {
  const value = Buffer.from(hash || Buffer.alloc(0));
  const payload = Buffer.alloc((subtype === 2 ? 56 : 55) + value.length);
  payload.writeUInt32BE(Number(peerUin) >>> 0, 0);
  payload.writeUInt16BE(INNER_MEDIA_NOTIFY, 32);
  payload[53] = Number(subtype) & 0xFF;
  if (subtype === 2) {
    payload[54] = Number(result === undefined ? 1 : result) & 0xFF;
    payload[55] = value.length;
    value.copy(payload, 56);
    return payload.subarray(0, 56 + value.length);
  }
  payload[54] = value.length;
  value.copy(payload, 55);
  return payload;
}

function buildOnlinePictureAck(peerUin) {
  const payload = Buffer.alloc(51);
  payload.writeUInt32BE(Number(peerUin) >>> 0, 0);
  payload.writeUInt16BE(11, 32);
  payload[50] = 2;
  return payload;
}

function mimeFor(mediaType, filename) {
  // The J2ME client announces compressed camera/gallery JPEGs as type 1,
  // while QQ2013 for Symbian uses type 2 for pictures.
  if (Number(mediaType) === 1 || Number(mediaType) === 2) return 'image/jpeg';
  if (Number(mediaType) === 3) return 'audio/amr';
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}

class MediaTransferService {
  constructor(options) {
    this.store = options.store;
    this.logger = options.logger || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.httpPort = Number(options.httpPort || 0);
    this.pendingByTicket = new Map();
    this.pendingByHash = new Map();
    this.pendingByUploadKey = new Map();
  }

  setHttpPort(port) {
    this.httpPort = Number(port || 0);
  }

  issueTicket(senderUin, request) {
    const ticket = crypto.randomBytes(16);
    const transfer = {
      id: crypto.randomUUID(), senderUin: Number(senderUin), targetUin: Number(request.targetUin),
      ticket, chunks: [], received: 0, createdAt: Date.now(),
    };
    this.pendingByTicket.set(ticket.toString('hex'), transfer);
    return { transfer, payload: buildTicketResponse(ticket) };
  }

  isNegotiation(senderUin, payload) {
    try {
      const request = parseNegotiation(payload);
      if (request.subtype === 6) return true;
      return request.subtype === 1 && this.pendingByTicket.has(request.ticket.toString('hex'))
        && this.pendingByTicket.get(request.ticket.toString('hex')).senderUin === Number(senderUin);
    } catch (_) {
      return false;
    }
  }

  register(senderUin, request, host) {
    const ticketHex = request.ticket.toString('hex');
    const transfer = this.pendingByTicket.get(ticketHex);
    if (!transfer || transfer.senderUin !== Number(senderUin)) throw new Error('media ticket is unknown');
    const hashKey = `${transfer.senderUin}:${request.hash.toString('hex')}`;
    const announced = this.pendingByHash.get(hashKey);
    if (announced && announced !== transfer && announced.size
        && Number(announced.size) !== Number(request.size)) {
      throw new Error('media announcement and registration sizes disagree');
    }
    const fileKey = crypto.randomBytes(16);
    const uploadKey = crypto.randomBytes(16);
    Object.assign(transfer, {
      filename: request.filename || `media-${transfer.id}`,
      size: request.size,
      legacyHash: Buffer.from(request.hash),
      fileKey, uploadKey, uploadHost: String(host).replace(/^::ffff:/, ''),
    });
    // Real phones announce 0x0065/0x00B5 before sending the upload
    // registration. announce() therefore may have created a hash-only
    // transfer. Carry its delivery metadata/callback onto the ticket transfer
    // instead of overwriting and orphaning it here.
    if (announced && announced !== transfer) {
      Object.assign(transfer, {
        targetUin: announced.targetUin,
        mediaType: announced.mediaType,
        acknowledge: announced.acknowledge,
      });
      if (!request.filename && announced.filename) transfer.filename = announced.filename;
    }
    this.pendingByHash.set(hashKey, transfer);
    this.pendingByUploadKey.set(uploadKey.toString('hex'), transfer);
    return buildUploadTargetResponse({ host: transfer.uploadHost, port: this.httpPort, fileKey, uploadKey });
  }

  announce(senderUin, request, acknowledge) {
    if (request.senderUin !== Number(senderUin)) throw new Error('media sender does not match session');
    const key = `${Number(senderUin)}:${request.hash.toString('hex')}`;
    let transfer = this.pendingByHash.get(key);
    if (!transfer) {
      transfer = {
        id: crypto.randomUUID(), senderUin: Number(senderUin), targetUin: request.targetUin,
        legacyHash: Buffer.from(request.hash), chunks: [], received: 0, createdAt: Date.now(),
      };
      this.pendingByHash.set(key, transfer);
    }
    Object.assign(transfer, {
      targetUin: request.targetUin, filename: request.filename,
      mediaType: request.mediaType, size: request.size, acknowledge,
    });
    this.finishIfComplete(transfer);
    return transfer;
  }

  async receiveUpload(request, response, url) {
    const uploadKeyHex = String(url.searchParams.get('ukey') || '').toLowerCase();
    const fileKeyHex = String(url.searchParams.get('filekey') || '').toLowerCase();
    const transfer = this.pendingByUploadKey.get(uploadKeyHex);
    // QQ2009 J2ME calls the original file MD5 "filekey" in its HTTP URL.
    // The upload-target response also contains a random field with that name,
    // and older gateway tests incorrectly assumed the phone echoed it. Accept
    // both layouts so real phones and the synthetic compatibility client work.
    const acceptedFileKeys = transfer ? [transfer.legacyHash, transfer.fileKey]
      .filter(Buffer.isBuffer).map((value) => value.toString('hex')) : [];
    if (!transfer || !acceptedFileKeys.includes(fileKeyHex)) {
      this.logger({ event: 'media_upload_rejected', reason: 'unknown_key',
        peer: String(request.socket.remoteAddress || '').replace(/^::ffff:/, ''),
        matchedUploadKey: Boolean(transfer), suppliedFileKeyBytes: fileKeyHex.length / 2,
        acceptedFileKeyKinds: transfer ? acceptedFileKeys.length : 0 });
      response.writeHead(403, { 'User-ReturnCode': '1', 'content-length': '0' }); response.end(); return;
    }
    const range = /^bytes=(\d+)-/i.exec(String(request.headers.range || ''));
    const offset = range ? Number(range[1]) : 0;
    this.logger({ event: 'media_upload_started', mediaId: transfer.id,
      from: transfer.senderUin, to: transfer.targetUin, offset,
      expectedBytes: transfer.size, receivedBytes: transfer.received,
      contentLength: Number(request.headers['content-length'] || 0),
      peer: String(request.socket.remoteAddress || '').replace(/^::ffff:/, '') });
    if (offset !== transfer.received) {
      this.logger({ event: 'media_upload_rejected', mediaId: transfer.id,
        reason: 'range_mismatch', offset, receivedBytes: transfer.received });
      response.writeHead(409, { 'User-ReturnCode': '2', Range: String(transfer.received), 'content-length': '0' });
      response.end(); return;
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (transfer.received + length > transfer.size || transfer.received + length > MAX_MEDIA_BYTES) {
        throw new Error('media upload exceeds declared size');
      }
      chunks.push(chunk);
    }
    if (length) transfer.chunks.push(Buffer.concat(chunks));
    transfer.received += length;
    this.logger({ event: 'media_upload_chunk_received', mediaId: transfer.id,
      bytes: length, receivedBytes: transfer.received, expectedBytes: transfer.size });
    response.writeHead(200, {
      'User-ReturnCode': '0', Range: String(transfer.received),
      'content-length': '0', 'cache-control': 'no-store',
    });
    response.end();
    this.finishIfComplete(transfer);
  }

  finishIfComplete(transfer) {
    if (transfer.completed || !transfer.filename || !transfer.mediaType
        || !transfer.size || transfer.received !== transfer.size) return false;
    const content = Buffer.concat(transfer.chunks, transfer.received);
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const media = this.store.saveMedia({
      id: transfer.id, from: transfer.senderUin, to: transfer.targetUin,
      filename: transfer.filename, mimeType: mimeFor(transfer.mediaType, transfer.filename),
      mediaType: transfer.mediaType, size: transfer.size, sha256,
      legacyHash: transfer.legacyHash, content,
    });
    transfer.completed = true;
    if (transfer.acknowledge) transfer.acknowledge(media);
    Promise.resolve(this.onComplete(media, transfer.uploadHost)).catch((error) => {
      this.logger({ event: 'media_delivery_failed', mediaId: media.id, message: error.message });
    });
    this.logger({ event: 'media_upload_complete', mediaId: media.id, from: media.from,
      to: media.to, mediaType: media.mediaType, bytes: media.size });
    return true;
  }
}

module.exports = {
  INNER_MEDIA_NOTIFY, MAX_MEDIA_BYTES, MediaTransferService,
  buildOnlinePictureAck, buildServiceResult, buildTicketResponse, buildUploadTargetResponse,
  ipv4Number, mimeFor, parseNegotiation, parseServiceEnvelope,
};
