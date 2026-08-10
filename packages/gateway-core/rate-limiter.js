'use strict';

class FixedWindowRateLimiter {
  constructor(options) {
    const opts = options || {};
    this.maxPerWindow = Math.max(1, Number(opts.maxPerWindow) || 1);
    this.windowMs = Math.max(1, Number(opts.windowMs) || 60000);
    this.minIntervalMs = Math.max(0, Number(opts.minIntervalMs) || 0);
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.entries = new Map();
  }

  allow(key) {
    const identity = key === undefined ? 'global' : key;
    const now = Number(this.now());
    const windowStart = Math.floor(now / this.windowMs);
    let entry = this.entries.get(identity);
    if (!entry) {
      entry = { count: 0, windowStart, lastSend: null };
      this.entries.set(identity, entry);
    }
    if (entry.windowStart !== windowStart) {
      entry.windowStart = windowStart;
      entry.count = 0;
    }
    if (entry.count >= this.maxPerWindow) return false;
    if (entry.lastSend !== null && now - entry.lastSend < this.minIntervalMs) return false;
    entry.count += 1;
    entry.lastSend = now;
    return true;
  }

  delete(key) {
    return this.entries.delete(key === undefined ? 'global' : key);
  }

  clear() {
    this.entries.clear();
  }
}

module.exports = { FixedWindowRateLimiter };
