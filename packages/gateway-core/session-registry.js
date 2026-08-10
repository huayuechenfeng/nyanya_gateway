'use strict';

const { toIdString } = require('./domain');

class SessionRegistry {
  constructor(options) {
    const opts = options || {};
    this.key = typeof opts.key === 'function' ? opts.key : toIdString;
    this.sessions = new Set();
    this.active = new Map();
    this.known = new Set();
  }

  add(session) {
    this.sessions.add(session);
    return session;
  }

  activate(identity, session) {
    const key = this.key(identity);
    if (!key) throw new Error('session identity is required');
    this.sessions.add(session);
    this.known.add(key);
    const previous = this.active.get(key) || null;
    this.active.set(key, session);
    return previous;
  }

  get(identity) {
    return this.active.get(this.key(identity)) || null;
  }

  remove(session) {
    this.sessions.delete(session);
    for (const [key, value] of this.active) {
      if (value === session) this.active.delete(key);
    }
  }

  knownKeys() {
    return Array.from(this.known);
  }

  all() {
    return Array.from(this.sessions);
  }

  clear(options) {
    this.sessions.clear();
    this.active.clear();
    if (!options || options.forgetKnown !== false) this.known.clear();
  }
}

module.exports = { SessionRegistry };
