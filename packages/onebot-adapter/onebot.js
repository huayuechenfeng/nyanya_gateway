'use strict';

const { WsClient } = require('./wsclient');

// OneBot v11 客户端：正向 WebSocket 连接 NapCat，事件订阅 + action 调用
class OneBotClient {
  constructor(options) {
    const opts = options || {};
    this.url = opts.url;
    this.token = opts.token || '';
    this.log = opts.log || console;
    this.minReconnectMs = opts.minReconnectMs || 1000;
    this.maxReconnectMs = opts.maxReconnectMs || 30000;
    this.actionQueueCap = opts.actionQueueCap || 100;
    this.ws = null;
    this.connected = false;
    this.seq = 0;
    this.pending = new Map();
    this.actionQueue = [];
    this.eventHandler = null;
    this.statusHandler = null;
    this.reconnectMs = this.minReconnectMs;
    this.closed = false;
    this.timer = null;
  }

  onEvent(handler) {
    this.eventHandler = handler;
  }

  onStatusChange(handler) {
    this.statusHandler = handler;
  }

  start() {
    this.closed = false;
    this._connect();
  }

  stop() {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ws) {
      this.ws.onClose = null;
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.pending.clear();
    this._setStatus(false);
  }

  _connect() {
    if (this.closed) return;
    const ws = new WsClient(this.url, { token: this.token });
    this.ws = ws;
    ws.onOpen = () => {
      this.connected = true;
      this.reconnectMs = this.minReconnectMs;
      this._setStatus(true);
      this._flushQueue();
    };
    ws.onMessage = (text) => {
      let obj;
      try {
        obj = JSON.parse(text);
      } catch (err) {
        this.log.error('[onebot] bad message: ' + err.message);
        return;
      }
      this._handleMessage(obj);
    };
    ws.onClose = () => {
      this.connected = false;
      this._setStatus(false);
      if (this.ws === ws) this.ws = null;
      this._scheduleReconnect();
    };
    ws.onError = (err) => {
      this.log.error('[onebot] ws error: ' + err.message);
    };
    ws.connect().catch((err) => {
      this.connected = false;
      this._setStatus(false);
      if (this.ws === ws) this.ws = null;
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.closed || this.timer) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, this.maxReconnectMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      this._connect();
    }, delay);
  }

  sendAction(action, params) {
    const echo = String(++this.seq);
    const promise = new Promise((resolve, reject) => {
      this.pending.set(echo, { resolve, reject });
    });
    const message = JSON.stringify({ action, params, echo });
    if (this.connected && this.ws) {
      this.ws.sendText(message);
    } else {
      if (this.actionQueue.length < this.actionQueueCap) {
        this.actionQueue.push(message);
      } else {
        const pending = this.pending.get(echo);
        this.pending.delete(echo);
        pending.reject(new Error('onebot action queue is full'));
      }
    }
    return promise;
  }

  _flushQueue() {
    const queue = this.actionQueue;
    this.actionQueue = [];
    for (const message of queue) {
      if (this.ws) this.ws.sendText(message);
    }
  }

  _handleMessage(obj) {
    if (obj && obj.echo !== undefined && obj.echo !== null) {
      const pending = this.pending.get(String(obj.echo));
      if (pending) {
        this.pending.delete(String(obj.echo));
        if (obj.status === 'ok' || obj.retcode === 0) {
          pending.resolve({ ok: true, data: obj.data });
        } else {
          pending.resolve({ ok: false, error: (obj.msg || 'onebot error') + ' (retcode ' + obj.retcode + ')' });
        }
      }
      return;
    }
    if (obj && obj.post_type && this.eventHandler) {
      try {
        this.eventHandler(obj);
      } catch (err) {
        this.log.error('[onebot] event handler error: ' + err.message);
      }
    }
  }

  _setStatus(up) {
    if (this.statusHandler) this.statusHandler(up);
  }
}

module.exports = { OneBotClient };
