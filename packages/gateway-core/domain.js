'use strict';

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

function toIdString(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function cleanName(value) {
  return safeText(value).trim();
}

function normalizeSender(value, fallbackId) {
  const source = value && typeof value === 'object' ? value : {};
  const id = toIdString(source.id === undefined ? fallbackId : source.id);
  const nickname = cleanName(source.nickname);
  const groupCard = cleanName(source.groupCard === undefined ? source.card : source.groupCard);
  return {
    id,
    nickname,
    groupCard,
    displayName: groupCard || nickname || id,
  };
}

function normalizeFriend(value) {
  const source = value && typeof value === 'object' ? value : {};
  const id = toIdString(source.id === undefined
    ? (source.user_id === undefined ? source.uin : source.user_id)
    : source.id);
  const nickname = cleanName(source.nickname === undefined ? source.name : source.nickname);
  const remark = cleanName(source.remark);
  return {
    id,
    nickname,
    remark,
    displayName: remark || nickname || id,
  };
}

function normalizeGroup(value) {
  const source = value && typeof value === 'object' ? value : {};
  const id = toIdString(source.id === undefined ? source.group_id : source.id);
  const title = cleanName(source.title === undefined ? source.group_name : source.title) || id;
  return { id, title };
}

function normalizeGroupMember(value, groupId) {
  const source = value && typeof value === 'object' ? value : {};
  const sender = normalizeSender({
    id: source.id === undefined
      ? (source.user_id === undefined ? source.uin : source.user_id)
      : source.id,
    nickname: source.nickname,
    groupCard: source.groupCard === undefined ? source.card : source.groupCard,
  });
  return {
    groupId: toIdString(groupId === undefined ? source.group_id : groupId),
    id: sender.id,
    nickname: sender.nickname,
    groupCard: sender.groupCard,
    displayName: sender.displayName,
  };
}

class GatewayError extends Error {
  constructor(code, message, details) {
    super(safeText(message) || safeText(code) || 'gateway error');
    this.name = 'GatewayError';
    this.code = safeText(code) || 'gateway_error';
    this.details = details === undefined ? null : details;
  }

  toPayload() {
    const payload = { code: this.code, message: this.message };
    if (this.details !== null) payload.details = this.details;
    return payload;
  }
}

function errorPayload(error, fallbackCode) {
  if (error instanceof GatewayError) return error.toPayload();
  return {
    code: safeText(fallbackCode) || 'gateway_error',
    message: error && typeof error.message === 'string' ? error.message : 'gateway error',
  };
}

module.exports = {
  GatewayError,
  cleanName,
  errorPayload,
  normalizeFriend,
  normalizeGroup,
  normalizeGroupMember,
  normalizeSender,
  safeText,
  toIdString,
};
