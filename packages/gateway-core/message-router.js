'use strict';

const { safeText, toIdString } = require('./domain');

function oneBotId(value) {
  const id = toIdString(value);
  const numeric = Number(id);
  return Number.isFinite(numeric) && numeric !== 0 ? numeric : id;
}

class OneBotMessageRouter {
  constructor(options) {
    const opts = options || {};
    this.onebot = opts.onebot;
    this.rateLimiter = opts.rateLimiter || null;
  }

  async sendText(options) {
    const opts = options || {};
    const chatType = opts.chatType === 'group' ? 'group' : 'private';
    const peerId = toIdString(opts.peerId);
    const text = safeText(opts.text);
    if (!peerId || !text) {
      return { ok: false, code: 'bad_params', error: 'peer/text required' };
    }
    if (this.rateLimiter && !this.rateLimiter.allow(opts.rateKey)) {
      return { ok: false, code: 'rate_limited', error: 'rate limited' };
    }

    const action = chatType === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params = chatType === 'group'
      ? { group_id: oneBotId(peerId), message: text }
      : { user_id: oneBotId(peerId), message: text };
    const result = await this.onebot.sendAction(action, params);
    if (!result || !result.ok) {
      return {
        ok: false,
        code: 'onebot',
        error: result && result.error ? result.error : 'send failed',
        action,
      };
    }
    return {
      ok: true,
      action,
      messageId: result.data && result.data.message_id,
    };
  }
}

module.exports = { OneBotMessageRouter, oneBotId };
