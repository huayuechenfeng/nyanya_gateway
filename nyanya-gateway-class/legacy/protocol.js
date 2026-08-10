'use strict';

const crypto = require('node:crypto');
const qqtea = require('./qqtea');

const CLIENT_VERSION = 0x0608;
const COMMAND_GET_KEY = 0x0049;
const COMMAND_CHANGE_PRESENCE = 0x000D;
const COMMAND_LOGIN = 0x0050;
const COMMAND_LOGOUT = 0x0051;
const COMMAND_BUDDY_LIST = 0x0054;
const COMMAND_FRIEND_ROSTER = 0x0069;
const COMMAND_FRIEND_METADATA = 0x006A;
const COMMAND_GROUP_SERVICE = 0x006D;
const COMMAND_GROUP_SYNC = 0x0070;
const COMMAND_AUXILIARY_KEY = 0x0064;
const COMMAND_EXTENDED_SERVICE = 0x006C;
const COMMAND_BUDDY_DETAILS = 0x0071;
const COMMAND_BUDDY_TOKENS = 0x0072;
const COMMAND_SEND_TEXT = 0x0055;
const COMMAND_USER_PROFILE = 0x005A;
const COMMAND_FRIEND_ACTION = 0x006B;
const COMMAND_SEARCH_USER = 0x0078;
const COMMAND_FRIEND_PREFLIGHT = 0x0091;
const COMMAND_FRIEND_RESULT = 0x0093;
const COMMAND_FRIEND_NOTIFICATION = 0x0095;
const COMMAND_FRIEND_ACTIVITY = 0x0083;
const COMMAND_AUXILIARY_FEATURES = 0x008E;
const COMMAND_MEDIA_TRANSFER = 0x0065;
const COMMAND_MEDIA_COMPLETION = 0x00A9;
const COMMAND_MEDIA_NOTIFY = 0x00B5;
const COMMAND_GROUP_SEND = 0x0090;
const COMMAND_GROUP_MESSAGE = 0x0094;
const COMMAND_GROUP_MAPPING = 0x00A4;
const COMMAND_GROUP_NOTIFY_CONFIG = 0x008A;
const COMMAND_GROUP_RECEIVE_FILTER = 0x008C;
const COMMAND_INCOMING_TEXT = 0x0056;
const MIN_FRAME_SIZE = 15;
const MAX_FRAME_SIZE = 65533;

function createFrame(options) {
  const payload = options.payload || Buffer.alloc(0);
  if (!Buffer.isBuffer(payload)) throw new TypeError('payload must be a Buffer');
  const length = MIN_FRAME_SIZE + payload.length;
  if (length > MAX_FRAME_SIZE) throw new RangeError('frame is too large');
  const frame = Buffer.allocUnsafe(length);
  frame[0] = 0x02;
  frame.writeUInt16BE(length, 1);
  frame.writeUInt16BE(options.version === undefined ? CLIENT_VERSION : options.version, 3);
  frame.writeUInt16BE(options.command, 5);
  frame.writeUInt16BE(options.sequence, 7);
  frame.writeUInt32BE(Number(options.uin) >>> 0, 9);
  frame[13] = options.status === undefined ? 0 : options.status;
  payload.copy(frame, 14);
  frame[length - 1] = 0x03;
  return frame;
}

function parseFrame(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < MIN_FRAME_SIZE) {
    throw new Error('frame is shorter than 15 bytes');
  }
  const declaredLength = frame.readUInt16BE(1);
  if (frame[0] !== 0x02 || frame[frame.length - 1] !== 0x03
      || declaredLength !== frame.length) {
    throw new Error('invalid QQ frame envelope');
  }
  return {
    length: declaredLength,
    version: frame.readUInt16BE(3),
    command: frame.readUInt16BE(5),
    sequence: frame.readUInt16BE(7),
    uin: frame.readUInt32BE(9),
    status: frame[13],
    payload: Buffer.from(frame.subarray(14, frame.length - 1)),
    raw: frame,
  };
}

function consumeFrames(input) {
  let buffer = input;
  const frames = [];
  while (buffer.length > 0) {
    const start = buffer.indexOf(0x02);
    if (start < 0) return { frames, remainder: Buffer.alloc(0) };
    if (start > 0) buffer = buffer.subarray(start);
    if (buffer.length < 3) break;
    const length = buffer.readUInt16BE(1);
    if (length < MIN_FRAME_SIZE || length > MAX_FRAME_SIZE) {
      buffer = buffer.subarray(1);
      continue;
    }
    if (buffer.length < length) break;
    const candidate = buffer.subarray(0, length);
    if (candidate[length - 1] !== 0x03) {
      buffer = buffer.subarray(1);
      continue;
    }
    frames.push(parseFrame(Buffer.from(candidate)));
    buffer = buffer.subarray(length);
  }
  return { frames, remainder: Buffer.from(buffer) };
}

function buildGetKeyResponsePayload(sessionKey) {
  if (!Buffer.isBuffer(sessionKey) || sessionKey.length !== 16) {
    throw new Error('sessionKey must contain 16 bytes');
  }
  return Buffer.concat([sessionKey, Buffer.from([0])]);
}

function deriveSymbianSessionKey(sessionKey, getKeyRequestPayload) {
  if (!Buffer.isBuffer(sessionKey) || sessionKey.length !== 16) {
    throw new Error('sessionKey must contain 16 bytes');
  }
  if (!Buffer.isBuffer(getKeyRequestPayload) || getKeyRequestPayload.length < 7) {
    throw new Error('GET_KEY request payload must contain at least 7 bytes');
  }
  // QQ2013 for Symbian copies the 16-byte server key, then merges byte 6
  // with byte 6 of its client marker before installing the QQ-TEA key.
  const effectiveKey = Buffer.from(sessionKey);
  effectiveKey[6] |= getKeyRequestPayload[6];
  return effectiveKey;
}

function parseLoginRequestPayload(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 26) {
    throw new Error('login payload is too short');
  }
  const digestLength = payload[24];
  const digestEnd = 25 + digestLength;
  if (digestEnd >= payload.length) throw new Error('login digest is truncated');
  const extensionCount = payload[digestEnd];
  const extensions = [];
  let offset = digestEnd + 1;
  for (let index = 0; index < extensionCount; index += 1) {
    if (offset + 3 > payload.length) throw new Error('login extension header is truncated');
    const type = payload[offset];
    const length = payload.readUInt16BE(offset + 1);
    offset += 3;
    if (offset + length > payload.length) throw new Error('login extension value is truncated');
    extensions.push({ type, value: Buffer.from(payload.subarray(offset, offset + length)) });
    offset += length;
  }
  if (offset !== payload.length) throw new Error('login payload contains trailing bytes');
  return {
    service: payload.readUInt16BE(0),
    revision: payload.readUInt16BE(2),
    reserved: payload.readUInt16BE(4),
    presence: payload.readUInt16BE(6),
    clientConstant: Buffer.from(payload.subarray(8, 24)),
    passwordDigest: Buffer.from(payload.subarray(25, digestEnd)),
    extensions,
  };
}

function passwordDigest(password) {
  return crypto.createHash('md5').update(Buffer.from(password, 'latin1')).digest();
}

function buildLoginSuccessPayload(options) {
  const token = options.token || crypto.randomBytes(32);
  const loginIp = options.loginIp || Buffer.from([127, 0, 0, 1]);
  const extra = options.extra || crypto.randomBytes(4);
  if (token.length !== 32 || loginIp.length !== 4 || extra.length !== 4) {
    throw new Error('invalid login response token sizes');
  }
  const payload = Buffer.alloc(58);
  loginIp.copy(payload, 0);
  payload.writeUInt16BE(options.port || 14000, 4);
  payload.writeUInt32BE((options.loginId || Math.floor(Date.now() / 1000)) >>> 0, 6);
  payload.writeUInt16BE(0, 10);
  payload.writeUInt16BE(0, 12);
  token.copy(payload, 14);
  loginIp.copy(payload, 46);
  payload[50] = 1;
  payload[51] = 1;
  payload.writeUInt16BE(4, 52);
  extra.copy(payload, 54);
  return payload;
}

function buildBuddyListPayload(entries) {
  // MobileQQ 12.0.16 parses the modern (D >= 1538) response as:
  // result byte, next cursor, current cursor, then zero or more six-byte
  // entries (UIN, relation type, packed group/flags). Zero cursors finish
  // paging. np creates a normal buddy for relationType 1 and a group
  // placeholder for relationType 4; online presence is delivered separately
  // by command 0x0071.
  const values = entries || [];
  if (!Array.isArray(values) || values.length > 0x7FFF) {
    throw new Error('buddy list entries must be an array');
  }
  const payload = Buffer.alloc(9 + (values.length * 6));
  let offset = 9;
  for (const entry of values) {
    const relationType = Number(entry.relationType == null ? 1 : entry.relationType);
    const groupIndex = Number(entry.groupIndex == null ? 0 : entry.groupIndex);
    const flags = Number(entry.flags == null ? 0 : entry.flags);
    if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex > 15) {
      throw new Error('buddy groupIndex must be between 0 and 15');
    }
    payload.writeUInt32BE(Number(entry.uin) >>> 0, offset);
    payload[offset + 4] = relationType & 0xFF;
    payload[offset + 5] = ((groupIndex & 0x0F) << 2) | (flags & 0x03);
    offset += 6;
  }
  return payload;
}

function buildEmptyBuddyListPayload() {
  return buildBuddyListPayload([]);
}

function parseFriendRosterRequest(payload) {
  if (!Buffer.isBuffer(payload) || payload.length !== 3) {
    throw new Error('friend roster request must contain a two-byte cursor and one reserved byte');
  }
  return {
    cursor: payload.readInt16BE(0),
    reserved: payload[2],
  };
}

function buildFriendRosterPayload(entries, nextCursor) {
  const values = entries || [];
  if (!Array.isArray(values) || values.length > 0x7FFF) {
    throw new Error('friend roster entries must be an array');
  }
  const encoded = values.map((entry) => {
    let nickname = encodeLegacyText(entry.nickname || String(entry.uin));
    // The original decoder stores the byte length in one signed byte. Keep
    // complete UTF-16BE code units and stay below its positive signed range.
    if (nickname.length > 126) nickname = nickname.subarray(0, 126);
    return { entry, nickname };
  });
  const payload = Buffer.alloc(4 + encoded.reduce(
    (total, value) => total + 13 + value.nickname.length, 0));
  payload.writeInt16BE(nextCursor === undefined ? -1 : Number(nextCursor), 0);
  payload.writeUInt16BE(encoded.length, 2);
  let offset = 4;
  for (const value of encoded) {
    const entry = value.entry;
    payload.writeUInt32BE(Number(entry.uin) >>> 0, offset); offset += 4;
    payload.writeUInt32BE(Number(entry.lastSeen || 0) >>> 0, offset); offset += 4;
    payload.writeUInt16BE(Number(entry.group || 0) & 0xFFFF, offset); offset += 2;
    payload[offset] = Number(entry.presence || 0) & 0xFF; offset += 1;
    payload[offset] = Number(entry.attributes || 0) & 0xFF; offset += 1;
    payload[offset] = value.nickname.length; offset += 1;
    value.nickname.copy(payload, offset); offset += value.nickname.length;
  }
  return payload;
}

function buildAuxiliaryKeyPayload(auxiliaryKey) {
  const key = auxiliaryKey || crypto.randomBytes(16);
  if (!Buffer.isBuffer(key) || key.length !== 16) {
    throw new Error('auxiliaryKey must contain 16 bytes');
  }
  // The parser reserves two bytes, reads a 16-byte key at offset 2, then a
  // one-byte service-data length. An empty service table is sufficient for
  // the TCP-only milestone and keeps retired HTTP endpoints disabled.
  const payload = Buffer.alloc(19);
  key.copy(payload, 2);
  return payload;
}

function buildBuddyDetailsPayload(entries, finalPage) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 0x7FFF) {
    throw new Error('entries must contain between 1 and 32767 buddies');
  }
  // The legacy parser accidentally reports an empty page as a decode failure,
  // so the bootstrap page contains the signed-in account as a harmless anchor.
  // Each 38-byte item is: UIN, flags, timestamps/counters, 16-byte token,
  // another timestamp, short flag and byte flag.
  const payload = Buffer.alloc(3 + (entries.length * 38));
  // In the original `fv` response, zero asks the client for another page and
  // one completes the phase. This is the reverse of a conventional "more"
  // flag and was the cause of an observed one-request-per-second loop.
  payload[0] = finalPage ? 1 : 0;
  payload.writeUInt16BE(entries.length, 1);
  let offset = 3;
  for (const entry of entries) {
    const uin = typeof entry === 'object' ? entry.uin : entry;
    const presence = typeof entry === 'object' && entry.presence !== undefined
      ? Number(entry.presence) : 10;
    if (!Number.isInteger(Number(uin)) || Number(uin) <= 0 || Number(uin) > 0xFFFFFFFF) {
      throw new Error('buddy detail UIN must fit in an unsigned 32-bit integer');
    }
    if (!Number.isInteger(presence) || presence < 0 || presence > 0xFFFF) {
      throw new Error('buddy detail presence must fit in an unsigned 16-bit integer');
    }
    payload.writeUInt32BE(Number(uin) >>> 0, offset);
    // `fv.b short[]` (record offset 11) is copied into ln.c(), the classic QQ
    // presence value: 10 online, 20 offline, 30 away, 40 invisible. Zero is
    // not ordinary online and is rendered by this build as a special/SuperQQ
    // presence badge.
    payload.writeUInt16BE(presence, offset + 11);
    offset += 38;
  }
  return payload;
}

function normalizePresence(value) {
  const numeric = Number(value);
  // The J2ME login form uses zero for its default online option, while later
  // requests and buddy records use the classic QQ values below.
  if (numeric === 0 || numeric === 10) return 10;
  if ([20, 30, 40].includes(numeric)) return numeric;
  throw new Error('presence must be online (10), offline (20), away (30), or invisible (40)');
}

function parsePresenceChangePayload(payload) {
  if (!Buffer.isBuffer(payload) || (payload.length !== 1 && payload.length !== 2)) {
    throw new Error('presence change payload must contain one byte or one unsigned short');
  }
  return normalizePresence(payload.length === 1 ? payload[0] : payload.readUInt16BE(0));
}

function parseFriendMetadataRequest(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 3) {
    throw new Error('friend metadata request is too short');
  }
  const subtype = payload[0];
  const count = payload.readUInt16BE(1);
  const recordWidth = subtype === 3 ? 8 : 4;
  if (payload.length !== 3 + (count * recordWidth)) {
    throw new Error('friend metadata request records are truncated');
  }
  const uins = [];
  for (let offset = 3; offset < payload.length; offset += recordWidth) {
    uins.push(payload.readUInt32BE(offset));
  }
  return { subtype, uins };
}

function buildFriendMetadataPayload(request, accounts) {
  if (!request || request.subtype !== 3) {
    return Buffer.from([Number(request && request.subtype) & 0xFF, 0]);
  }
  const byUin = new Map((accounts || []).map((account) => [Number(account.uin), account]));
  const records = request.uins.map((uin) => {
    const account = byUin.get(Number(uin));
    let nickname = encodeLegacyText(account ? account.nickname : String(uin));
    if (nickname.length > 0xFFFE) nickname = nickname.subarray(0, 0xFFFE);
    const record = Buffer.alloc(10 + nickname.length);
    record.writeUInt32BE(Number(uin) >>> 0, 0);
    // The second UIN-sized field was historically a mobile/contact flag. The
    // J2ME decoder retains it but does not require a non-zero value.
    record.writeUInt32BE(0, 4);
    record.writeUInt16BE(nickname.length, 8);
    nickname.copy(record, 10);
    return record;
  });
  // The client reserves four bytes after the subtype/result header before it
  // starts scanning the variable-width records.
  return Buffer.concat([Buffer.from([3, 0, 0, 0, 0, 0]), ...records]);
}

function parseFriendActivityRequest(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 3) {
    throw new Error('friend activity request is too short');
  }
  const subtype = payload[0];
  const count = payload.readUInt16BE(1);
  if (payload.length !== 3 + (count * 4)) {
    throw new Error('friend activity request records are truncated');
  }
  const uins = [];
  for (let offset = 3; offset < payload.length; offset += 4) {
    uins.push(payload.readUInt32BE(offset));
  }
  return { subtype, uins };
}

function buildFriendActivityPayload(subtype) {
  // Both subtype parsers accept an empty terminal result page.
  return Buffer.from([Number(subtype) & 0xFF, 0, 0]);
}

function buildAuxiliaryFeaturesPayload() {
  // ja's decoder reads a count byte followed by tagged integer entries.
  return Buffer.from([0]);
}

function parseGroupSendPayload(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 17 || payload[0] !== 1) {
    throw new Error('unsupported group message payload');
  }
  const groupId = payload.readUInt32BE(1);
  let offset = 5;
  const firstTokenLength = payload.readUInt16BE(offset); offset += 2;
  if (offset + firstTokenLength + 2 > payload.length) throw new Error('group token is truncated');
  offset += firstTokenLength;
  const secondTokenLength = payload.readUInt16BE(offset); offset += 2;
  if (offset + secondTokenLength + 8 > payload.length) throw new Error('group token is truncated');
  offset += secondTokenLength;
  const clientSequence = payload.readUInt16BE(offset); offset += 2;
  const clientTimestamp = payload.readUInt32BE(offset); offset += 4;
  const textLength = payload.readUInt16BE(offset); offset += 2;
  if (textLength === 0 || offset + textLength > payload.length) {
    throw new Error('group message text is empty or truncated');
  }
  const text = decodeLegacyText(payload.subarray(offset, offset + textLength));
  if (!text.trim()) throw new Error('group message text is empty');
  return { subtype: 1, groupId, clientSequence, clientTimestamp, text };
}

function buildGroupMessagePayload(options) {
  const text = encodeLegacyText(options.text || '');
  if (text.length === 0) throw new Error('group message text is empty');
  let displayName = encodeLegacyText(options.displayName || String(options.senderUin));
  if (displayName.length > 126) displayName = displayName.subarray(0, 126);
  const messageField = Buffer.concat([Buffer.alloc(10), text]);
  const payload = Buffer.alloc(27 + displayName.length + messageField.length);
  payload[0] = Number(options.subtype || 1) & 0xFF;
  payload[1] = displayName.length;
  displayName.copy(payload, 2);
  let offset = 2 + displayName.length;
  offset += 2;
  payload.writeUInt32BE(Number(options.groupId) >>> 0, offset); offset += 4;
  offset += 1;
  payload.writeUInt32BE(Number(options.senderUin) >>> 0, offset); offset += 4;
  offset += 4;
  payload.writeUInt32BE(Number(options.timestamp || Math.floor(Date.now() / 1000)) >>> 0, offset);
  offset += 4;
  offset += 4;
  payload.writeUInt16BE(messageField.length, offset); offset += 2;
  messageField.copy(payload, offset);
  return payload;
}

function buildGroupMappingPayload(groups) {
  const values = (groups || []).slice(0, 127).map((group) => {
    const publicId = Buffer.from(String(group.publicId || group.id), 'ascii');
    if (publicId.length > 127) throw new Error('group public ID is too long');
    return { group, publicId };
  });
  const payload = Buffer.alloc(11 + values.reduce(
    (total, value) => total + 6 + value.publicId.length, 0));
  payload[0] = 1;
  payload[9] = 0;
  payload[10] = values.length;
  let offset = 11;
  for (const value of values) {
    payload.writeUInt32BE(Number(value.group.id) >>> 0, offset); offset += 4;
    payload[offset] = value.group.type === 'discussion' ? 1 : 0; offset += 1;
    payload[offset] = value.publicId.length; offset += 1;
    value.publicId.copy(payload, offset); offset += value.publicId.length;
  }
  return payload;
}

function parseGroupServiceRequest(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 1) {
    throw new Error('group service request is empty');
  }
  const subtype = payload[0];
  if (subtype === 0x72 && payload.length === 9) {
    // QQ2013/S60 asks for the group-member stage with command 0x006D and a
    // nine-byte body: operation, internal group UIN, cursor. This is not the
    // classic J2ME subtype-4 group-information request.
    return {
      subtype,
      groupId: payload.readUInt32BE(1),
      cursor: payload.readUInt32BE(5),
      memberUins: [],
    };
  }
  if (subtype === 4 && payload.length === 5) {
    return { subtype, groupId: payload.readUInt32BE(1), memberUins: [] };
  }
    if (subtype === 2 && payload.length >= 6 && (payload.length - 6) % 4 === 0) {
    const memberUins = [];
    for (let offset = 6; offset < payload.length; offset += 4) {
      memberUins.push(payload.readUInt32BE(offset));
    }
      return { subtype, groupId: payload.readUInt32BE(1), action: payload[5], memberUins };
    }
    if (subtype === 26) {
      // QQ2009 J2ME and QQ2013/S60 send group text through 0x006D subtype 26.
      // Layout recovered from ik.b(long,short,long,byte[]):
      // subtype, group UIN, encoded-body length, ten fixed header bytes,
      // UTF-16BE text, and a fixed 16-byte client capability trailer. QQ2013
      // excludes the ten-byte header from encoded-body length (for example,
      // a two-character message reports 0x0014 = 4 text + 16 trailer bytes).
      if (payload.length < 35) throw new Error('group message service payload is too short');
      const bodyLength = payload.readUInt16BE(5);
      if (bodyLength !== payload.length - 17 || payload.readUInt16BE(7) !== 1) {
        throw new Error('group message service length/header is invalid');
      }
      const trailer = Buffer.from([
        0x00, 0x20, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00,
        0x00, 0x86, 0x02, 0x8B, 0x5B, 0x53, 0x4F, 0x0D,
      ]);
      const encoded = payload.subarray(17);
      const textBytes = encoded.length >= trailer.length
          && encoded.subarray(encoded.length - trailer.length).equals(trailer)
        ? encoded.subarray(0, encoded.length - trailer.length) : encoded;
      if (textBytes.length === 0 || (textBytes.length & 1) !== 0) {
        throw new Error('group message service text is empty or truncated');
      }
      const text = decodeLegacyText(textBytes);
      if (!text.trim()) throw new Error('group message service text is empty');
      return { subtype, groupId: payload.readUInt32BE(1), memberUins: [], text };
    }
    return { subtype, groupId: payload.length >= 5 ? payload.readUInt32BE(1) : null,
      memberUins: [], raw: Buffer.from(payload) };
  }

function buildGroupServiceAck(subtype, result) {
  return Buffer.from([Number(subtype) & 0xFF, Number(result || 0) & 0xFF]);
}

function buildGroupInfoPayload(group) {
  let title = encodeLegacyText(group.title || String(group.publicId || group.id));
  if (title.length > 0xFFFE) title = title.subarray(0, 0xFFFE);
  const members = (group.members || []).slice(0, 1000);
  const payload = Buffer.alloc(32 + title.length + (members.length * 5));
  payload[0] = 4;
  payload[1] = 0;
  payload.writeUInt32BE(Number(group.id) >>> 0, 2);
  payload.writeUInt32BE(Number(group.publicId || group.id) >>> 0, 6);
  payload[10] = group.type === 'discussion' ? 1 : 0;
  payload.writeUInt32BE(Number(group.ownerUin) >>> 0, 11);
  payload.writeUInt16BE(title.length, 24);
  title.copy(payload, 26);
  let offset = 26 + title.length;
  payload.writeUInt16BE(members.length, offset); offset += 2;
  payload.writeUInt16BE(0, offset); offset += 2;
  payload.writeUInt16BE(0, offset); offset += 2;
  for (const member of members) {
    payload.writeUInt32BE(Number(member.uin) >>> 0, offset); offset += 4;
    payload[offset] = member.role === 'owner' ? 1 : 0; offset += 1;
  }
  return payload;
}

// QQ2013/S60 still uses the classic 0x006D/4 group-info field order.  It is
// not interchangeable with the compact MobileQQ/J2ME layout above: in
// particular, four unknown bytes precede the owner UIN and QQ2007+ clients
// expect a seven-byte capability block before the variable strings.  Feeding
// the compact layout to the native parser shifts every later field and can
// make it interpret title bytes as member counts.
function buildSymbianGroupInfoPayload(group) {
  let title = encodeLegacyText(group.title || String(group.publicId || group.id));
  // The native vstr length is one byte.  Keep complete UTF-16BE code units and
  // stay below the signed-byte boundary used by old mobile decoders.
  if (title.length > 126) title = title.subarray(0, 126);
  const members = (group.members || []).slice(0, 500);
  const fixed = Buffer.from([
    0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0xFC,
  ]);
  const payload = Buffer.alloc(45 + title.length + (members.length * 6));
  let offset = 0;
  payload[offset] = 4; offset += 1;
  payload[offset] = 0; offset += 1;
  payload.writeUInt32BE(Number(group.id) >>> 0, offset); offset += 4;
  payload.writeUInt32BE(Number(group.publicId || group.id) >>> 0, offset); offset += 4;
  // 1 = permanent Qun in the classic protocol.  Discussions use a separate
  // discovery path and must not be made to look like permanent groups here.
  payload[offset] = group.type === 'discussion' ? 2 : 1; offset += 1;
  payload.writeUInt32BE(0, offset); offset += 4; // unknown/version flags
  payload.writeUInt32BE(Number(group.ownerUin) >>> 0, offset); offset += 4;
  payload[offset] = 2; offset += 1; // membership requires authorization
  payload.writeUInt32BE(0, offset); offset += 4; // legacy category
  payload.writeUInt16BE(0, offset); offset += 2;
  payload.writeUInt32BE(1, offset); offset += 4; // general category
  payload.writeUInt16BE(Math.max(200, members.length), offset); offset += 2;
  payload[offset] = 0; offset += 1;
  fixed.copy(payload, offset); offset += fixed.length;
  payload[offset] = title.length; offset += 1;
  title.copy(payload, offset); offset += title.length;
  payload.writeUInt16BE(0, offset); offset += 2;
  payload[offset] = 0; offset += 1; // empty notice vstr
  payload[offset] = 0; offset += 1; // empty description vstr
  for (const member of members) {
    payload.writeUInt32BE(Number(member.uin) >>> 0, offset); offset += 4;
    payload[offset] = 0; offset += 1; // organization
    payload[offset] = member.role === 'owner' ? 1 : 0; offset += 1;
  }
  return payload;
}

function buildSymbianGroupMemberPayload(group) {
  const groupId = Number(group && group.id);
  const publicId = Number(group && (group.publicId || group.id));
  if (!Number.isInteger(groupId) || groupId <= 0 || groupId > 0xFFFFFFFF
      || !Number.isInteger(publicId) || publicId <= 0 || publicId > 0xFFFFFFFF) {
    throw new Error('Symbian group-member response requires valid group identifiers');
  }

  // QQ2013 EngineIM builds 0x72 requests as:
  //   72 | group UIN (u32) | cursor (u32)
  // Its success decoder (EngineIM VA 0x16238) strips the first two response
  // bytes, then unconditionally reads three u32 values before consulting the
  // optional-field bitmask. Returning the generic two-byte `72 00` ACK makes
  // the native decoder read beyond the packet and terminate the client.
  //
  // Bit 0 adds the group profile block. CQQGroupEngine::HandleGetGroupMember
  // applies its first UTF-16BE field as the group title, which is what turns
  // a numeric kind=4 placeholder into a named group in QQ2013. Bit 1 is the
  // optional member-record page; leave it absent for now. Incoming 0x0094
  // messages already teach the engine about an unseen sender, while omitting
  // a potentially huge member page keeps discovery safe on memory-poor S60.
  //
  // The native title destination is only 50 bytes wide. Keep complete UTF-16
  // code units and reserve two bytes rather than letting an overlong NapCat
  // group name overwrite the fields that follow it.
  let title = encodeLegacyText(group.title || String(publicId));
  if (title.length > 48) title = title.subarray(0, 48);
  const memberCapacity = Math.max(200, Math.min(0xFFFF,
    Array.isArray(group.members) ? group.members.length : 0));
  const payload = Buffer.alloc(59 + title.length);
  let offset = 0;
  payload[offset] = 0x72; offset += 1;
  payload[offset] = 0; offset += 1;
  payload.writeUInt32BE(groupId >>> 0, offset); offset += 4;
  payload.writeUInt32BE(publicId >>> 0, offset); offset += 4;
  payload.writeUInt32BE(1, offset); offset += 4; // profile block present

  payload[offset] = group.type === 'discussion' ? 2 : 1; offset += 1;
  payload.writeUInt32BE(0, offset); offset += 4; // version/reserved
  payload.writeUInt32BE(Number(group.ownerUin || 0) >>> 0, offset); offset += 4;
  payload.writeUInt32BE(0, offset); offset += 4; // creation/category reserved
  payload[offset] = 2; offset += 1; // membership requires authorization
  payload.writeUInt32BE(0, offset); offset += 4;
  payload.writeUInt16BE(0, offset); offset += 2;
  payload.writeUInt32BE(1, offset); offset += 4;
  payload.writeUInt16BE(memberCapacity, offset); offset += 2;
  payload[offset] = 0; offset += 1;
  payload.writeUInt32BE(0x00000100, offset); offset += 4;
  payload.writeUInt32BE(0x000000FC, offset); offset += 4;
  payload.writeUInt16BE(title.length, offset); offset += 2;
  title.copy(payload, offset); offset += title.length;
  payload.writeUInt16BE(memberCapacity, offset); offset += 2;
  payload.writeUInt16BE(0, offset); offset += 2; // empty notice
  payload.writeUInt16BE(0, offset); offset += 2; // empty description
  payload[offset] = 0; offset += 1;
  payload[offset] = 0;
  return payload;
}

// Kept as an API alias for older harnesses and third-party integrations.
const buildSymbianGroupInfoBootstrapPayload = buildSymbianGroupMemberPayload;

function parseBuddyTokensRequest(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 1) {
    throw new Error('buddy token request is empty');
  }
  const subtype = payload[0];
  if (subtype === 1 && payload.length === 3) {
    return { subtype, cursor: payload.readInt16BE(1), targetUin: null };
  }
  if (subtype === 2 && payload.length === 5) {
    return { subtype, cursor: null, targetUin: payload.readUInt32BE(1) };
  }
  throw new Error(`unsupported buddy token request subtype ${subtype}`);
}

function buildBuddyTokensPayload(request) {
  if (request.subtype === 1) {
    // Subtype, final cursor, fixed token width. An empty final page is valid.
    return Buffer.from([1, 0xFF, 0xFF, 0]);
  }
  if (request.subtype === 2) {
    const payload = Buffer.alloc(5);
    payload[0] = 2;
    payload.writeUInt32BE(Number(request.targetUin) >>> 0, 1);
    return payload;
  }
  throw new Error(`unsupported buddy token response subtype ${request.subtype}`);
}

function buildFriendServiceAck(subtype) {
  const value = Number(subtype) & 0xFF;
  // Subtype zero is a paged friend-alias sync. Its second response byte is
  // the final-page flag; returning zero makes the client retry every 10s.
  if (value === 0) return Buffer.from([0, 1]);
  if (value === 1) return Buffer.from([1, 0]);
  return Buffer.from([value]);
}

function buildExtendedServicePayload(subtype, uin) {
  if (!Number.isInteger(subtype) || subtype < 0 || subtype > 0xFF) {
    throw new Error('extended service subtype must be a byte');
  }
  if (subtype === 0x20) {
    // QQ2013 S60's CQQBuddyEngine handler reads the subtype-0x20 result header
    // through offset 0x0d and passes offset 0x10 as the first record. Its
    // empty terminal page must therefore contain the complete 16-byte header;
    // the generic 8-byte housekeeping reply makes it read beyond the buffer.
    // The client treats pages as one-based: byte 6 is the page total, byte
    // 0x0c is the current page, and byte 0x0d is the 12-byte record count.
    // A 1/1 page with zero records clears the bootstrap store and terminates.
    const payload = Buffer.alloc(16);
    payload[0] = subtype;
    payload[6] = 1;
    payload[12] = 1;
    return payload;
  }
  // Subtype 0x1f is part of post-login housekeeping. The parser expects the
  // subtype, a zero result byte, a UIN/cursor and a reserved record count.
  const payload = Buffer.alloc(8);
  payload[0] = subtype;
  payload.writeUInt32BE(Number(uin || 0) >>> 0, 2);
  return payload;
}

function encodeLegacyText(value) {
  const output = Buffer.from(String(value || ''), 'utf16le');
  return output.swap16();
}

function decodeLegacyText(value) {
  if (!Buffer.isBuffer(value) || (value.length & 1) !== 0) {
    throw new Error('legacy text must contain complete UTF-16BE code units');
  }
  return Buffer.from(value).swap16().toString('utf16le');
}

function parseSearchUserPayload(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 13) throw new Error('search payload is too short');
  const length = payload.readUInt16BE(5);
  if ((length & 1) !== 0 || 7 + length > payload.length) throw new Error('search text is truncated');
  return { query: decodeLegacyText(payload.subarray(7, 7 + length)) };
}

function buildSearchUserPayload(accounts) {
  const encoded = (accounts || []).map((account) => ({
    account,
    nickname: encodeLegacyText(account.nickname),
  }));
  const size = 2 + encoded.reduce((total, value) => total + 10 + value.nickname.length, 0);
  const payload = Buffer.alloc(size);
  payload.writeUInt16BE(encoded.length, 0);
  let offset = 2;
  for (const value of encoded) {
    payload.writeUInt32BE(Number(value.account.uin) >>> 0, offset); offset += 4;
    payload.writeUInt16BE(value.nickname.length, offset); offset += 2;
    value.nickname.copy(payload, offset); offset += value.nickname.length;
    payload.writeUInt16BE(0, offset); offset += 2; // unused secondary label
    payload.writeUInt16BE(Number(value.account.avatar || 0) & 0xFFFF, offset); offset += 2;
  }
  return payload;
}

function parseUserProfilePayload(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 6) throw new Error('profile payload is too short');
  return { subtype: payload.readUInt16BE(0), targetUin: payload.readUInt32BE(2) };
}

function legacyProfileValue(account, name, fallback) {
  const profile = account && account.profile ? account.profile : {};
  const value = Object.prototype.hasOwnProperty.call(profile, name) ? profile[name] : fallback;
  return value === undefined || value === null ? '' : value;
}

function uint16(value) {
  const output = Buffer.alloc(2);
  output.writeUInt16BE(Math.max(0, Math.min(0xFFFF, Number(value) || 0)), 0);
  return output;
}

function uint32(value) {
  const output = Buffer.alloc(4);
  output.writeUInt32BE(Number(value) >>> 0, 0);
  return output;
}

function legacyField(value) {
  const encoded = encodeLegacyText(String(value || ''));
  if (encoded.length > 0xFFFF) throw new Error('legacy profile field is too long');
  return Buffer.concat([uint16(encoded.length), encoded]);
}

function buildBriefUserProfilePayload(account) {
  const nickname = encodeLegacyText(account.nickname);
  const payload = Buffer.alloc(16 + nickname.length);
  payload.writeUInt16BE(2, 0);
  payload.writeUInt32BE(Number(account.uin) >>> 0, 2);
  payload.writeUInt16BE(Number(legacyProfileValue(account, 'avatar', account.avatar || 0)) & 0xFFFF, 6);
  payload.writeUInt16BE(Number(legacyProfileValue(account, 'age', 0)) & 0xFFFF, 8);
  payload.writeUInt16BE(Number(legacyProfileValue(account, 'gender', 0)) & 0xFFFF, 10);
  payload.writeUInt16BE(nickname.length, 12);
  nickname.copy(payload, 14);
  const signature = encodeLegacyText(String(legacyProfileValue(account, 'signature', '')));
  const result = Buffer.alloc(payload.length + signature.length);
  payload.copy(result, 0);
  result.writeUInt16BE(signature.length, 14 + nickname.length);
  signature.copy(result, 16 + nickname.length);
  return result;
}

// MobileQQ 12.0.16's decoder (the obfuscated `ik.h` method) reads subtype 3
// as a fixed sequence of length-prefixed UTF-16BE strings. Even fields that
// are no longer rendered by this client must be present or the profile view
// silently discards the response.
function buildDetailedUserProfilePayload(account) {
  const profile = account.profile || {};
  const nickname = account.nickname || String(account.uin);
  const realName = legacyProfileValue(account, 'realName', nickname);
  const signature = legacyProfileValue(account, 'signature', '');
  const avatar = legacyProfileValue(account, 'avatar', account.avatar || 0);
  const age = legacyProfileValue(account, 'age', 0);
  const gender = legacyProfileValue(account, 'gender', 0);
  const fields = [
    uint16(3), uint32(account.uin),
    legacyField(nickname),
    legacyField(realName),
    legacyField(signature),
    legacyField(profile.country),
    legacyField(profile.province),
    legacyField(profile.city),
    uint16(age), uint16(gender),
    legacyField(realName),
    legacyField(profile.country),
    legacyField(profile.province),
    legacyField(profile.city),
    legacyField(profile.address),
    legacyField(profile.postalCode),
    legacyField(profile.education),
    legacyField(profile.school),
    legacyField(profile.occupation),
    legacyField(profile.phone),
    legacyField(profile.email),
    uint16(avatar),
    legacyField(profile.mobile),
    legacyField(profile.email),
    legacyField(profile.hobby),
    legacyField(profile.description || signature),
    legacyField(profile.homepage),
    legacyField(profile.company),
    Buffer.from([0, 0, 0]),
    legacyField(signature),
    Buffer.from([0, 0, 0]),
  ];
  return Buffer.concat(fields);
}

function buildUserProfilePayload(account, subtype) {
  const requestedSubtype = subtype === undefined ? 2 : Number(subtype);
  if (requestedSubtype === 1) return buildFriendAddedPayload(account);
  if (requestedSubtype === 2) return buildBriefUserProfilePayload(account);
  if (requestedSubtype === 3) return buildDetailedUserProfilePayload(account);
  throw new Error(`unsupported user profile subtype ${requestedSubtype}`);
}

function buildFriendAddedPayload(account) {
  const nickname = encodeLegacyText(account.nickname);
  const payload = Buffer.alloc(8 + nickname.length);
  payload.writeUInt16BE(1, 0);
  payload.writeUInt32BE(Number(account.uin) >>> 0, 2);
  payload.writeUInt16BE(nickname.length, 6);
  nickname.copy(payload, 8);
  return payload;
}

function parseFriendActionPayload(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 9 || payload[0] !== 1) {
    throw new Error('unsupported friend action payload');
  }
  const length = payload.readUInt16BE(7);
  if ((length & 1) !== 0 || 9 + length > payload.length) throw new Error('friend message is truncated');
  return {
    subtype: payload[0],
    action: payload[1],
    targetUin: payload.readUInt32BE(2),
    message: decodeLegacyText(payload.subarray(9, 9 + length)),
  };
}

function buildFriendActionAck(result, subtype) {
  return Buffer.from([subtype === undefined ? 1 : subtype & 0xFF, result || 0]);
}

function parseFriendPreflightPayload(payload) {
  if (!Buffer.isBuffer(payload) || payload.length !== 4) {
    throw new Error('friend preflight payload must contain one UIN');
  }
  return { targetUin: payload.readUInt32BE(0) };
}

function buildFriendPreflightPayload(targetUin, result, decision) {
  const payload = Buffer.alloc(6);
  payload.writeUInt32BE(Number(targetUin) >>> 0, 0);
  payload[4] = Number(result || 0) & 0xFF;
  payload[5] = Number(decision || 0) & 0xFF;
  return payload;
}

function buildFriendResultPayload(action, targetUin, result, message) {
  const resultCode = Number(result) & 0xFF;
  if (resultCode === 0) {
    const payload = Buffer.alloc(6);
    payload[0] = Number(action) & 0xFF;
    payload.writeUInt32BE(Number(targetUin) >>> 0, 1);
    payload[5] = 0;
    return payload;
  }
  const text = Buffer.from(String(message || 'Request failed'), 'latin1').subarray(0, 255);
  const payload = Buffer.alloc(7 + text.length);
  payload[0] = Number(action) & 0xFF;
  payload.writeUInt32BE(Number(targetUin) >>> 0, 1);
  payload[5] = resultCode;
  payload[6] = text.length;
  text.copy(payload, 7);
  return payload;
}

function buildFriendRequestNotificationPayload(requesterUin, message) {
  const text = encodeLegacyText(String(message || '')).subarray(0, 255);
  const payload = Buffer.alloc(7 + text.length);
  payload.writeUInt32BE(Number(requesterUin) >>> 0, 0);
  // pn subtype 40 is the validation-request record understood by
  // MobileQQ 12.0.16. The decoder treats the following field as an
  // unsigned one-byte opaque validation message.
  payload.writeUInt16BE(40, 4);
  payload[6] = text.length;
  text.copy(payload, 7);
  return payload;
}

function parseFriendResultActionPayload(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 6) {
    throw new Error('friend-result action payload is too short');
  }
  return {
    action: payload[0],
    targetUin: payload.readUInt32BE(1),
    value: payload[5],
    extra: payload.subarray(6),
  };
}

function parseSendTextPayload(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 22) throw new Error('text message payload is too short');
  const targetUin = payload.readUInt32BE(0);
  const length = payload.readUInt16BE(4);
  if (length < 16 || 6 + length > payload.length || ((length - 16) & 1) !== 0) {
    throw new Error('text message body is truncated');
  }
  return {
    targetUin,
    text: decodeLegacyText(payload.subarray(6, 6 + length - 16)),
  };
}

function buildIncomingTextPayload(senderUin, text, timestampSeconds, subtype) {
  const message = encodeLegacyText(text);
  if (message.length > 0x7FFF) throw new Error('incoming text is longer than the legacy packet allows');

  // Command 0x0056 decodes to `eu`, the one-to-one receive event paired with
  // the client's 0x0055 send command. In MobileQQ 12.0.16 subtype 3 is routed
  // through q.b(eu) into an `ib` system/service session. Subtype 9 is routed
  // through q.a(eu) into the sender's `ln` contact chat and can also create a
  // temporary contact if the roster has not finished loading.
  // MobileQQ 12.0.16 (protocol revision 0x0608) expects: subtype, timestamp,
  // sender UIN, text byte length and UTF-16BE text.
  const payload = Buffer.alloc(12 + message.length);
  const messageSubtype = subtype === undefined ? 9 : Number(subtype);
  if (!Number.isInteger(messageSubtype) || messageSubtype < 1 || messageSubtype > 0xFFFF) {
    throw new Error('incoming text subtype must fit in an unsigned 16-bit integer');
  }
  payload.writeUInt16BE(messageSubtype, 0);
  const sentAt = timestampSeconds === undefined
    ? Math.floor(Date.now() / 1000) : Number(timestampSeconds);
  payload.writeUInt32BE(sentAt >>> 0, 2);
  payload.writeUInt32BE(Number(senderUin) >>> 0, 6);
  payload.writeUInt16BE(message.length, 10);
  message.copy(payload, 12);
  return payload;
}

function encryptPayload(payload, sessionKey, randomBytes) {
  return qqtea.encrypt(payload, sessionKey, randomBytes);
}

function decryptPayload(payload, sessionKey) {
  return qqtea.decrypt(payload, sessionKey);
}

module.exports = {
  CLIENT_VERSION,
  COMMAND_CHANGE_PRESENCE,
  COMMAND_GET_KEY,
  COMMAND_LOGIN,
  COMMAND_LOGOUT,
  COMMAND_BUDDY_LIST,
  COMMAND_FRIEND_ROSTER,
  COMMAND_FRIEND_METADATA,
  COMMAND_GROUP_SERVICE,
  COMMAND_GROUP_SYNC,
  COMMAND_AUXILIARY_KEY,
  COMMAND_EXTENDED_SERVICE,
  COMMAND_BUDDY_DETAILS,
  COMMAND_BUDDY_TOKENS,
  COMMAND_SEND_TEXT,
  COMMAND_USER_PROFILE,
  COMMAND_FRIEND_ACTION,
  COMMAND_SEARCH_USER,
  COMMAND_FRIEND_PREFLIGHT,
  COMMAND_FRIEND_RESULT,
  COMMAND_FRIEND_NOTIFICATION,
  COMMAND_FRIEND_ACTIVITY,
  COMMAND_MEDIA_TRANSFER,
  COMMAND_MEDIA_COMPLETION,
  COMMAND_MEDIA_NOTIFY,
  COMMAND_AUXILIARY_FEATURES,
  COMMAND_GROUP_SEND,
  COMMAND_GROUP_MESSAGE,
  COMMAND_GROUP_MAPPING,
  COMMAND_GROUP_NOTIFY_CONFIG,
  COMMAND_GROUP_RECEIVE_FILTER,
  COMMAND_INCOMING_TEXT,
  buildAuxiliaryKeyPayload,
  buildBuddyListPayload,
  buildFriendRosterPayload,
  buildBuddyDetailsPayload,
  buildBuddyTokensPayload,
  buildFriendMetadataPayload,
  buildFriendActivityPayload,
  buildAuxiliaryFeaturesPayload,
  buildGroupInfoPayload,
  buildSymbianGroupInfoPayload,
  buildSymbianGroupMemberPayload,
  buildSymbianGroupInfoBootstrapPayload,
  buildGroupMappingPayload,
  buildGroupMessagePayload,
  buildGroupServiceAck,
  buildEmptyBuddyListPayload,
  buildExtendedServicePayload,
  buildFriendActionAck,
  buildFriendAddedPayload,
  buildFriendPreflightPayload,
  buildFriendRequestNotificationPayload,
  buildFriendResultPayload,
  buildFriendServiceAck,
  buildIncomingTextPayload,
  buildSearchUserPayload,
  buildUserProfilePayload,
  buildGetKeyResponsePayload,
  deriveSymbianSessionKey,
  buildLoginSuccessPayload,
  consumeFrames,
  createFrame,
  decryptPayload,
  decodeLegacyText,
  encodeLegacyText,
  encryptPayload,
  parseFrame,
  parseLoginRequestPayload,
  normalizePresence,
  parsePresenceChangePayload,
  parseFriendMetadataRequest,
  parseFriendActivityRequest,
  parseGroupSendPayload,
  parseGroupServiceRequest,
  parseFriendActionPayload,
  parseFriendRosterRequest,
  parseBuddyTokensRequest,
  parseFriendPreflightPayload,
  parseFriendResultActionPayload,
  parseSearchUserPayload,
  parseSendTextPayload,
  parseUserProfilePayload,
  passwordDigest,
};
