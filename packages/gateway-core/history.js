'use strict';

const { toIdString } = require('./domain');

class BoundedHistory {
  constructor(options) {
    const opts = options || {};
    this.capacity = Math.max(1, Number(opts.capacity) || 100);
    this.entries = new Map();
  }

  append(peerId, message) {
    const key = toIdString(peerId);
    if (!key) return false;
    let list = this.entries.get(key);
    if (!list) {
      list = [];
      this.entries.set(key, list);
    }
    list.push(message);
    if (list.length > this.capacity) list.splice(0, list.length - this.capacity);
    return true;
  }

  get(peerId, limit) {
    const list = this.entries.get(toIdString(peerId)) || [];
    const count = Math.max(0, Number(limit) || list.length);
    return list.slice(-count);
  }

  clear() {
    this.entries.clear();
  }
}

module.exports = { BoundedHistory };
