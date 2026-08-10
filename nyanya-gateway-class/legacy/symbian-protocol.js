'use strict';

const jce = require('./jce');

const COMMAND_MESSAGE_ACCOST = 0x00AB;
const COMMAND_WUP = 0x00AD;
const COMMAND_AUXILIARY_PRESENCE = 0x00AE;
const COMMAND_BUDDY_STATUS = 0x00AF;

const ACCOST_SERVANT = 'AccostSvr';
const ACCOST_GET_MESSAGE = 'CMD_GET_Msg';
const ROUTE_CREATE_DISCUSS = 'QQServiceDiscussSvc.ReqCreateDiscuss';
const ROUTE_GET_DISCUSS = 'QQServiceDiscussSvc.ReqGetDiscuss';
const ROUTE_GET_DISCUSS_INFO = 'QQServiceDiscussSvc.ReqGetDiscussInfo';
const ROUTE_GET_COUNT = 'SuperQQsvc.GetCountReq';

function parseAccostEnvelope(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 8) {
    throw new Error('Symbian Accost envelope is too short');
  }
  const protocolVersion = payload[0];
  if (protocolVersion !== 1) {
    throw new Error('unsupported Symbian Accost protocol version ' + protocolVersion);
  }
  const transportLength = payload.readUInt16BE(1);
  const packetOffset = 3;
  if (transportLength < 4 || packetOffset + transportLength > payload.length) {
    throw new Error('invalid Symbian Accost transport length');
  }
  const request = jce.parseRequestPacket(
    payload.subarray(packetOffset, packetOffset + transportLength));
  if (request.packetLength !== transportLength) {
    throw new Error('Symbian Accost length fields disagree');
  }
  return {
    protocolVersion,
    transportLength,
    request,
    suffix: Buffer.from(payload.subarray(packetOffset + transportLength)),
  };
}

function buildAccostEnvelope(protocolVersion, packet, suffix) {
  if (!Number.isInteger(protocolVersion) || protocolVersion < 0 || protocolVersion > 0xFF) {
    throw new Error('Symbian Accost response has an invalid protocol version');
  }
  if (!Buffer.isBuffer(packet) || packet.length < 4 || packet.length > 0xFFFF) {
    throw new Error('Symbian Accost response packet has an invalid length');
  }
  const prefix = Buffer.alloc(3);
  prefix[0] = protocolVersion;
  prefix.writeUInt16BE(packet.length, 1);
  return Buffer.concat([
    prefix,
    packet,
    suffix === undefined ? Buffer.from([0]) : suffix,
  ]);
}

function parseAccostResponseEnvelope(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 8) {
    throw new Error('Symbian Accost response envelope is too short');
  }
  const protocolVersion = payload[0];
  const transportLength = payload.readUInt16BE(1);
  const packetOffset = 3;
  if (transportLength < 4 || packetOffset + transportLength > payload.length) {
    throw new Error('invalid Symbian Accost response transport length');
  }
  const response = jce.parseResponsePacket(
    payload.subarray(packetOffset, packetOffset + transportLength));
  if (response.packetLength !== transportLength) {
    throw new Error('Symbian Accost response length fields disagree');
  }
  return {
    protocolVersion,
    transportLength,
    response,
    suffix: Buffer.from(payload.subarray(packetOffset + transportLength)),
  };
}

function parseWupEnvelope(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 10) {
    throw new Error('Symbian WUP envelope is too short');
  }
  const routeLength = payload.readUInt16BE(0);
  const lengthOffset = 2 + routeLength;
  if (routeLength === 0 || lengthOffset + 7 > payload.length) {
    throw new Error('Symbian WUP route is truncated');
  }
  const route = payload.subarray(2, lengthOffset).toString('ascii');
  if (!/^[\x20-\x7E]+$/.test(route)) throw new Error('Symbian WUP route is not ASCII');
  const transportLength = payload.readUIntBE(lengthOffset, 3);
  const packetOffset = lengthOffset + 3;
  if (transportLength < 4 || packetOffset + transportLength > payload.length) {
    throw new Error('invalid Symbian WUP transport length');
  }
  const packetBuffer = payload.subarray(packetOffset, packetOffset + transportLength);
  const request = jce.parseRequestPacket(packetBuffer);
  if (request.packetLength !== transportLength) {
    throw new Error('Symbian WUP length fields disagree');
  }
  return {
    route,
    transportLength,
    request,
    suffix: Buffer.from(payload.subarray(packetOffset + transportLength)),
  };
}

function buildWupEnvelope(route, packet, suffix) {
  const routeBytes = Buffer.from(route, 'ascii');
  if (routeBytes.length === 0 || routeBytes.length > 0xFFFF) {
    throw new Error('Symbian WUP response route has an invalid length');
  }
  if (!Buffer.isBuffer(packet) || packet.length < 4 || packet.length > 0xFFFFFF) {
    throw new Error('Symbian WUP response packet has an invalid length');
  }
  const routeLength = Buffer.alloc(2);
  routeLength.writeUInt16BE(routeBytes.length);
  const transportLength = Buffer.alloc(3);
  transportLength.writeUIntBE(packet.length, 0, 3);
  return Buffer.concat([
    routeLength,
    routeBytes,
    transportLength,
    packet,
    suffix === undefined ? Buffer.from([0]) : suffix,
  ]);
}

function parseWupResponseEnvelope(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 10) {
    throw new Error('Symbian WUP response envelope is too short');
  }
  const routeLength = payload.readUInt16BE(0);
  const lengthOffset = 2 + routeLength;
  if (routeLength === 0 || lengthOffset + 7 > payload.length) {
    throw new Error('Symbian WUP response route is truncated');
  }
  const route = payload.subarray(2, lengthOffset).toString('ascii');
  const transportLength = payload.readUIntBE(lengthOffset, 3);
  const packetOffset = lengthOffset + 3;
  if (transportLength < 4 || packetOffset + transportLength > payload.length) {
    throw new Error('invalid Symbian WUP response transport length');
  }
  const response = jce.parseResponsePacket(
    payload.subarray(packetOffset, packetOffset + transportLength));
  if (response.packetLength !== transportLength) {
    throw new Error('Symbian WUP response length fields disagree');
  }
  return {
    route,
    transportLength,
    response,
    suffix: Buffer.from(payload.subarray(packetOffset + transportLength)),
  };
}

function responseHeaderParameter() {
  return ['DiscussRespHeader', [[
    'QQService.DiscussRespHeader', jce.struct([
      jce.integer(0, 0),
      jce.string(1, ''),
    ]),
  ]]];
}

function discussResponseParameters(groups) {
  // Static analysis of QQ2013's generated JCE classes shows that the response
  // header requires tag 0 (result) and tag 1 (description), while
  // RespGetDiscuss requires tag 0 as a vector<DiscussInfo>.
  const discussList = jce.struct([
    jce.list(0, groups || [], (_tag, group) => jce.struct([
      jce.integer(0, BigInt(group.id)),
      jce.integer(1, 0),
    ])),
  ]);
  return [
    responseHeaderParameter(),
    ['RespGetDiscuss', [
      ['QQService.RespGetDiscuss', discussList],
    ]],
  ];
}

function discussInfoResponseParameters(group) {
  if (!group) throw new Error('the requested discussion was not found');
  const info = jce.struct([
    jce.integer(0, BigInt(group.id)),
    jce.integer(1, BigInt(group.ownerUin)),
    jce.integer(2, 0),
    jce.integer(3, 0),
    jce.string(4, group.title || String(group.id)),
    jce.list(5, group.members || [], (_tag, member) => jce.struct([
      jce.integer(0, BigInt(member.uin)),
      jce.integer(1, member.role === 'owner' ? 1 : 0),
    ])),
  ]);
  return [responseHeaderParameter(),
    ['RespGetDiscussInfo', [['QQService.RespGetDiscussInfo', info]]]];
}

function createDiscussResponseParameters(group) {
  if (!group || !Number.isInteger(Number(group.id)) || Number(group.id) <= 0) {
    throw new Error('a created discussion is required for the Symbian response');
  }
  // RespCreateDiscuss::readFrom requires int64 tag 0 and a
  // map<int64,int32> tag 1 containing member UIN -> status. Its generated
  // writer emits JCE type 8 followed by long/int key-value pairs; encoding a
  // string or a type-9 list makes QQ2013 abandon the asynchronous callback.
  const responseHeader = jce.struct([
    jce.integer(0, 0),
    jce.string(1, ''),
  ]);
  const created = jce.struct([
    jce.integer(0, BigInt(group.id)),
    jce.map(1, (group.members || []).map((member) => [BigInt(member.uin), 0]),
      jce.integer, jce.integer),
  ]);
  return [
    ['DiscussRespHeader', [
      ['QQService.DiscussRespHeader', responseHeader],
    ]],
    ['RespCreateDiscuss', [
      ['QQService.RespCreateDiscuss', created],
    ]],
  ];
}

function parseCreateDiscussRequest(envelope) {
  const typeName = 'QQService.ReqCreateDiscuss';
  let encoded = null;
  for (const typedValues of envelope.request.parameters.values()) {
    if (typedValues instanceof Map && typedValues.has(typeName)) {
      encoded = typedValues.get(typeName);
      break;
    }
  }
  if (!Buffer.isBuffer(encoded)) return { title: '', memberUins: [] };
  const field = new jce.Reader(encoded).field();
  if (!(field.value instanceof Map)) throw new Error('ReqCreateDiscuss is not a JCE struct');
  const title = typeof field.value.get(0) === 'string' ? field.value.get(0) : '';
  const members = Array.isArray(field.value.get(1)) ? field.value.get(1) : [];
  const memberUins = Array.from(new Set(members.map((member) => Number(
    member instanceof Map ? member.get(0) : 0,
  )).filter((uin) => Number.isInteger(uin) && uin > 0 && uin <= 0xFFFFFFFF)));
  return { title, memberUins };
}

function parseGetDiscussInfoRequest(envelope) {
  const typeName = 'QQService.ReqGetDiscussInfo';
  for (const typedValues of envelope.request.parameters.values()) {
    const encoded = typedValues instanceof Map ? typedValues.get(typeName) : null;
    if (!Buffer.isBuffer(encoded)) continue;
    const field = new jce.Reader(encoded).field();
    if (!(field.value instanceof Map)) throw new Error('ReqGetDiscussInfo is not a JCE struct');
    const groupId = Number(field.value.get(0));
    if (!Number.isInteger(groupId) || groupId <= 0) {
      throw new Error('ReqGetDiscussInfo has an invalid discussion ID');
    }
    return groupId;
  }
  throw new Error('ReqGetDiscussInfo parameter is missing');
}

function createWupResponse(envelope, options) {
  const context = options || {};
  let parameters = [];
  let kind = 'generic_ack';
  let group = null;
  if (envelope.route === ROUTE_CREATE_DISCUSS
      || (envelope.request.servant === 'QQServiceDiscussSvc'
        && envelope.request.functionName === 'ReqCreateDiscuss')) {
    if (typeof context.createDiscussion !== 'function') {
      throw new Error('Symbian discussion creation is not configured');
    }
    group = context.createDiscussion(parseCreateDiscussRequest(envelope));
    parameters = createDiscussResponseParameters(group);
    kind = 'discussion_created';
  } else if (envelope.route === ROUTE_GET_DISCUSS
      || (envelope.request.servant === 'QQServiceDiscussSvc'
        && envelope.request.functionName === 'ReqGetDiscuss')) {
    const groups = typeof context.getDiscussions === 'function' ? context.getDiscussions() : [];
    parameters = discussResponseParameters(groups);
    kind = groups.length ? 'discussion_list' : 'empty_discuss_list';
  } else if (envelope.route === ROUTE_GET_DISCUSS_INFO
      || (envelope.request.servant === 'QQServiceDiscussSvc'
        && envelope.request.functionName === 'ReqGetDiscussInfo')) {
    if (typeof context.getDiscussion !== 'function') {
      throw new Error('Symbian discussion lookup is not configured');
    }
    group = context.getDiscussion(parseGetDiscussInfoRequest(envelope));
    parameters = discussInfoResponseParameters(group);
    kind = 'discussion_info';
  } else if (envelope.route === ROUTE_GET_COUNT
      || (envelope.request.servant === 'SuperQQsvc'
        && envelope.request.functionName === 'GetCountReq')) {
    // GetCountReq is an asynchronous trigger: QQ2013 accepts the immediate
    // WUP acknowledgement without output parameters. Counter delivery is a
    // separate SuperQQsvc.GetCountMessage callback and is intentionally not
    // fabricated here.
    kind = 'count_request_ack';
  }
  const packet = jce.responsePacket(envelope.request, parameters, 0);
  return {
    payload: buildWupEnvelope(envelope.route, packet, envelope.suffix),
    kind,
    group,
    parameterNames: parameters.map(([name]) => name),
  };
}

function messageResponseParameters() {
  // Static analysis of QQ2013's generated MessageSvcAccost.RespGetMsg::writeTo
  // shows required tags 0..3: int64, byte, string and vector<AccostMsg>.
  // An account with no pending messages therefore uses zero scalar values and
  // an empty tag-3 list. Tags 4..6 are optional and stay absent.
  const emptyMessageResponse = jce.struct([
    jce.integer(0, 0),
    jce.integer(1, 0),
    jce.string(2, ''),
    Buffer.concat([jce.head(3, 9), jce.integer(0, 0)]),
  ]);
  return [
    ['RespGetMsg', [
      ['MessageSvcAccost.RespGetMsg', emptyMessageResponse],
    ]],
  ];
}

function createAccostResponse(envelope) {
  if (envelope.request.servant !== ACCOST_SERVANT
      || envelope.request.functionName !== ACCOST_GET_MESSAGE) {
    throw new Error('unsupported Symbian Accost request '
      + envelope.request.servant + '.' + envelope.request.functionName);
  }
  const parameters = messageResponseParameters();
  const packet = jce.responsePacket(envelope.request, parameters, 0);
  return {
    payload: buildAccostEnvelope(envelope.protocolVersion, packet, envelope.suffix),
    kind: 'empty_message_list',
    parameterNames: parameters.map(([name]) => name),
  };
}

function parseBuddyStatusRequest(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 14) {
    throw new Error('Symbian buddy-status request is too short');
  }
  return {
    accountUin: payload.readUInt32BE(0),
    generation: payload.readUInt32BE(4),
    cursor: payload.readUInt16BE(8),
    pageSize: payload.readUInt16BE(10),
    reserved: payload.readUInt16BE(12),
  };
}

function parseAuxiliaryPresenceRequest(payload) {
  if (!Buffer.isBuffer(payload) || (payload.length !== 5 && payload.length !== 6)) {
    throw new Error('Symbian auxiliary-presence request must contain 5 or 6 bytes');
  }
  const opcode = payload[0];
  if (opcode !== 0x88 && opcode !== 0x89) {
    throw new Error('unsupported Symbian auxiliary-presence opcode ' + opcode);
  }
  return {
    opcode,
    action: opcode === 0x88 ? 'subscribe' : 'unsubscribe',
    targetUin: payload.readUInt32BE(1),
    flag: payload.length === 6 ? payload[5] : null,
  };
}

function buildBuddyStatusResponse(entries, options) {
  const values = entries || [];
  const settings = Object.assign({ cursor: 0, finalPage: true }, options || {});
  if (!Array.isArray(values) || values.length > 200) {
    throw new Error('Symbian buddy-status page must contain at most 200 entries');
  }
  if (!Number.isInteger(settings.cursor) || settings.cursor < 0 || settings.cursor > 0xFFFF) {
    throw new Error('Symbian buddy-status cursor must fit in an unsigned 16-bit integer');
  }

  const encoded = values.map((entry) => {
    const uin = Number(typeof entry === 'object' ? entry.uin : entry);
    if (!Number.isInteger(uin) || uin <= 0 || uin > 0xFFFFFFFF) {
      throw new Error('Symbian buddy-status UIN must fit in an unsigned 32-bit integer');
    }
    const groups = typeof entry === 'object' && Array.isArray(entry.groups)
      ? entry.groups : [typeof entry === 'object' ? Number(entry.group || 0) : 0];
    if (groups.length > 0xFFFF || groups.some(
      (group) => !Number.isInteger(Number(group)) || Number(group) < 0 || Number(group) > 0xFFFF)) {
      throw new Error('Symbian buddy-status group identifiers must fit in unsigned 16-bit integers');
    }
    const relationKind = typeof entry === 'object'
      ? (entry.kind === undefined
        ? (entry.relationType === undefined ? 1 : entry.relationType)
        : entry.kind)
      : 1;
    const kind = Number(relationKind);
    if (!Number.isInteger(kind) || kind < 0 || kind > 0xFF) {
      throw new Error('Symbian buddy-status relation kind must fit in an unsigned byte');
    }
    return { uin, kind, groups: groups.map(Number) };
  });

  // QQ2013's GetNewList decoder reads this 20-byte page header followed by
  // variable-size records. Result 0 is a valid page; byte 15 is the last-page
  // flag. Each record is UIN, five metadata bytes, a 16-bit group count and
  // that many 16-bit group identifiers. QQ2013's CLoginEngine::UpDateBuddyList
  // dispatches kind 1 to CQQBuddyEngine and kind 4 to CQQGroupEngine. Groups
  // must therefore be present in this requested list; an unsolicited legacy
  // 0x0054 relation push never reaches the Symbian group-list branch.
  const payload = Buffer.alloc(22 + encoded.reduce(
    (total, entry) => total + 11 + (entry.groups.length * 2), 0));
  payload[0] = 0;
  payload[15] = settings.finalPage ? 1 : 0;
  payload.writeUInt16BE(settings.cursor, 16);
  payload.writeUInt16BE(encoded.length, 18);
  let offset = 20;
  for (const entry of encoded) {
    payload.writeUInt32BE(entry.uin >>> 0, offset); offset += 4;
    payload[offset] = entry.kind; offset += 5;
    payload.writeUInt16BE(entry.groups.length, offset); offset += 2;
    for (const group of entry.groups) {
      payload.writeUInt16BE(group, offset); offset += 2;
    }
  }
  // The generated decoder expects one final length-prefixed byte field after
  // the fixed 200-record array. Its empty representation is a zero u16.
  payload.writeUInt16BE(0, offset);
  return payload;
}

module.exports = {
  ACCOST_GET_MESSAGE,
  ACCOST_SERVANT,
  COMMAND_BUDDY_STATUS,
  COMMAND_AUXILIARY_PRESENCE,
  COMMAND_MESSAGE_ACCOST,
  COMMAND_WUP,
  ROUTE_GET_COUNT,
  ROUTE_CREATE_DISCUSS,
  ROUTE_GET_DISCUSS,
  ROUTE_GET_DISCUSS_INFO,
  buildBuddyStatusResponse,
  buildAccostEnvelope,
  buildWupEnvelope,
  createAccostResponse,
  createDiscussResponseParameters,
  discussInfoResponseParameters,
  createWupResponse,
  discussResponseParameters,
  messageResponseParameters,
  parseAccostEnvelope,
  parseAccostResponseEnvelope,
  parseBuddyStatusRequest,
  parseCreateDiscussRequest,
  parseGetDiscussInfoRequest,
  parseAuxiliaryPresenceRequest,
  parseWupEnvelope,
  parseWupResponseEnvelope,
};
