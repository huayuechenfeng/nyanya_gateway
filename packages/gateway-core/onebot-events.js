'use strict';

const { normalizeSender, safeText, toIdString } = require('./domain');

const NOTICE_DEFINITIONS = Object.freeze({
  group_increase: Object.freeze({ text: '群成员增加', refreshContacts: true }),
  group_decrease: Object.freeze({ text: '群成员减少', refreshContacts: true }),
  group_recall: Object.freeze({ text: '消息被撤回', refreshContacts: false }),
  friend_recall: Object.freeze({ text: '消息被撤回', refreshContacts: false }),
  group_ban: Object.freeze({ text: '群成员被禁言', refreshContacts: false }),
  group_admin: Object.freeze({ text: '群管理员变更', refreshContacts: false }),
  friend_add: Object.freeze({ text: '新好友', refreshContacts: true }),
  group_upload: Object.freeze({ text: '群文件上传', refreshContacts: false }),
  poke: Object.freeze({ text: '戳了戳你', refreshContacts: false }),
});

function segmentText(segments) {
  if (!Array.isArray(segments)) return '';
  let output = '';
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') continue;
    const data = segment.data || {};
    if (segment.type === 'text') output += safeText(data.text);
    else if (segment.type === 'face') output += '[表情]';
    else if (segment.type === 'image') output += '[图片]';
    else if (segment.type === 'record') output += '[语音]';
    else if (segment.type === 'video') output += '[视频]';
    else if (segment.type === 'at') {
      output += '@' + (safeText(data.name) || safeText(data.qq) || '成员') + ' ';
    } else if (segment.type === 'forward') output += '[合并转发]';
    else if (segment.type === 'json' || segment.type === 'xml') output += '[卡片消息]';
    else if (segment.type === 'file') output += '[文件]';
    else output += '[消息]';
  }
  return output;
}

function normalizeOneBotMessage(event, options) {
  if (!event || event.post_type !== 'message') return null;
  if (event.message_type !== 'private' && event.message_type !== 'group') return null;
  const opts = options || {};
  const senderId = toIdString(event.user_id);
  const selfId = toIdString(opts.selfId === undefined ? event.self_id : opts.selfId);
  if (senderId && selfId && senderId === selfId) return null;

  const chatType = event.message_type;
  const peerId = chatType === 'group' ? toIdString(event.group_id) : senderId;
  if (!peerId || !senderId) return null;
  const sourceSender = event.sender || {};
  const sender = normalizeSender({
    id: senderId,
    nickname: sourceSender.nickname,
    groupCard: sourceSender.card,
  });
  const nowSeconds = typeof opts.nowSeconds === 'function'
    ? opts.nowSeconds() : Math.floor(Date.now() / 1000);

  return {
    kind: 'message',
    chatType,
    peerId,
    sender,
    text: segmentText(event.message),
    time: Number(event.time) || nowSeconds,
    messageId: toIdString(event.message_id),
    groupName: chatType === 'group' ? safeText(event.group_name) : '',
  };
}

function normalizeOneBotNotice(event, options) {
  if (!event || event.post_type !== 'notice') return null;
  const definition = NOTICE_DEFINITIONS[event.notice_type];
  if (!definition) return null;
  const opts = options || {};
  const labels = opts.labels || {};
  const nowSeconds = typeof opts.nowSeconds === 'function'
    ? opts.nowSeconds() : Math.floor(Date.now() / 1000);
  return {
    kind: 'notice',
    noticeType: event.notice_type,
    text: safeText(labels[event.notice_type]) || definition.text,
    refreshContacts: definition.refreshContacts,
    time: Number(event.time) || nowSeconds,
  };
}

module.exports = {
  NOTICE_DEFINITIONS,
  normalizeOneBotMessage,
  normalizeOneBotNotice,
  segmentText,
};
