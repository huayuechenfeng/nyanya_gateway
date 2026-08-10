'use strict';

const { toIdString } = require('./domain');

class MemoryQueueStorage {
  constructor() {
    this.queues = new Map();
  }

  enqueue(key, item, capacity) {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = [];
      this.queues.set(key, queue);
    }
    if (queue.length >= capacity) return false;
    queue.push(item);
    return true;
  }

  take(key) {
    const queue = this.queues.get(key) || [];
    this.queues.delete(key);
    return queue;
  }

  size(key) {
    const queue = this.queues.get(key);
    return queue ? queue.length : 0;
  }

  clear() {
    this.queues.clear();
  }
}

class OfflineDeliveryQueue {
  constructor(options) {
    const opts = options || {};
    this.capacity = Math.max(1, Number(opts.capacity) || 200);
    this.storage = opts.storage || new MemoryQueueStorage();
    this.key = typeof opts.key === 'function' ? opts.key : toIdString;
  }

  enqueue(target, item) {
    return this.storage.enqueue(this.key(target), item, this.capacity);
  }

  take(target) {
    const values = this.storage.take(this.key(target));
    return Array.isArray(values) ? values : [];
  }

  size(target) {
    if (typeof this.storage.size !== 'function') return null;
    return Number(this.storage.size(this.key(target))) || 0;
  }

  clear() {
    if (typeof this.storage.clear === 'function') this.storage.clear();
  }
}

module.exports = { MemoryQueueStorage, OfflineDeliveryQueue };
