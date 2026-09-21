'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 2;

function json(value, fallback) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function resolveFiles(input) {
  if (!input) return { databaseFile: null, legacyDataFile: null };
  const requested = path.resolve(input);
  if (path.extname(requested).toLowerCase() === '.json') {
    return {
      databaseFile: requested.slice(0, -5) + '.sqlite',
      legacyDataFile: requested,
    };
  }
  const legacy = path.extname(requested).toLowerCase() === '.sqlite'
    ? requested.slice(0, -7) + '.json' : requested + '.json';
  return { databaseFile: requested, legacyDataFile: legacy };
}

class SqlitePersistence {
  constructor(input, options) {
    const files = resolveFiles(input);
    this.databaseFile = files.databaseFile;
    this.legacyDataFile = files.legacyDataFile;
    this.logger = (options && options.logger) || null;
    if (this.databaseFile) fs.mkdirSync(path.dirname(this.databaseFile), { recursive: true });
    this.db = new DatabaseSync(this.databaseFile || ':memory:');
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.createSchema();
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (
        uin INTEGER PRIMARY KEY, type TEXT NOT NULL, enabled INTEGER NOT NULL,
        nickname TEXT NOT NULL, password_digest TEXT NOT NULL,
        profile_json TEXT NOT NULL, virtual_json TEXT
      );
      CREATE TABLE IF NOT EXISTS friends (
        owner_uin INTEGER NOT NULL REFERENCES accounts(uin) ON DELETE CASCADE,
        friend_uin INTEGER NOT NULL REFERENCES accounts(uin) ON DELETE CASCADE,
        PRIMARY KEY (owner_uin, friend_uin)
      );
      CREATE TABLE IF NOT EXISTS friend_requests (
        receiver_uin INTEGER NOT NULL REFERENCES accounts(uin) ON DELETE CASCADE,
        sender_uin INTEGER NOT NULL REFERENCES accounts(uin) ON DELETE CASCADE,
        message TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (receiver_uin, sender_uin)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, from_uin INTEGER NOT NULL, to_uin INTEGER NOT NULL,
        text TEXT NOT NULL, sent_at TEXT NOT NULL, source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_virtual_idx ON messages(from_uin, to_uin, id);
      CREATE TABLE IF NOT EXISTS relationships (
        virtual_uin INTEGER NOT NULL, target_uin INTEGER NOT NULL,
        label TEXT NOT NULL, address_as TEXT NOT NULL, description TEXT NOT NULL,
        shared_history TEXT NOT NULL, private_notes TEXT NOT NULL,
        closeness INTEGER NOT NULL, trust INTEGER NOT NULL,
        PRIMARY KEY (virtual_uin, target_uin)
      );
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
        model TEXT NOT NULL, api_key_env TEXT NOT NULL, api_key_protected TEXT NOT NULL,
        temperature REAL NOT NULL, max_tokens INTEGER NOT NULL, timeout_ms INTEGER NOT NULL,
        extra_headers_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, from_uin INTEGER NOT NULL, to_uin INTEGER NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_recipient_idx ON outbox(to_uin, created_at);
      CREATE TABLE IF NOT EXISTS chat_groups (
        id INTEGER PRIMARY KEY, public_id INTEGER NOT NULL UNIQUE, type TEXT NOT NULL,
        owner_uin INTEGER NOT NULL REFERENCES accounts(uin), title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_members (
        group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
        uin INTEGER NOT NULL REFERENCES accounts(uin) ON DELETE CASCADE,
        role TEXT NOT NULL, joined_at TEXT NOT NULL, reply_policy TEXT NOT NULL,
        reply_probability REAL,
        PRIMARY KEY (group_id, uin)
      );
      CREATE INDEX IF NOT EXISTS group_members_uin_idx ON group_members(uin, group_id);
      CREATE TABLE IF NOT EXISTS group_messages (
        id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
        from_uin INTEGER NOT NULL REFERENCES accounts(uin), text TEXT NOT NULL,
        sent_at TEXT NOT NULL, source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS group_messages_group_idx ON group_messages(group_id, id);
      CREATE TABLE IF NOT EXISTS media_items (
        id TEXT PRIMARY KEY, from_uin INTEGER NOT NULL, to_uin INTEGER NOT NULL,
        filename TEXT NOT NULL, mime_type TEXT NOT NULL, media_type INTEGER NOT NULL,
        size INTEGER NOT NULL, sha256 TEXT NOT NULL, legacy_hash BLOB NOT NULL,
        content BLOB NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS media_items_recipient_idx ON media_items(to_uin, created_at);
    `);
  }

  loadLegacyJson() {
    if (!this.legacyDataFile || !fs.existsSync(this.legacyDataFile)) return null;
    const text = fs.readFileSync(this.legacyDataFile, 'utf8');
    return JSON.parse(text);
  }

  load() {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'data_version'").get();
    if (!row) return null;
    const accounts = this.db.prepare('SELECT * FROM accounts ORDER BY uin').all().map((value) => ({
      uin: Number(value.uin), type: value.type, enabled: Boolean(value.enabled),
      nickname: value.nickname, passwordDigest: value.password_digest,
      profile: json(value.profile_json, {}), virtual: value.virtual_json ? json(value.virtual_json, {}) : null,
      friends: [], incomingRequests: [],
    }));
    const byUin = new Map(accounts.map((account) => [account.uin, account]));
    for (const value of this.db.prepare('SELECT * FROM friends ORDER BY owner_uin, friend_uin').all()) {
      const account = byUin.get(Number(value.owner_uin));
      if (account) account.friends.push(Number(value.friend_uin));
    }
    for (const value of this.db.prepare('SELECT * FROM friend_requests ORDER BY created_at').all()) {
      const account = byUin.get(Number(value.receiver_uin));
      if (account) account.incomingRequests.push({
        from: Number(value.sender_uin), message: value.message, createdAt: value.created_at,
      });
    }
    const groups = this.db.prepare('SELECT * FROM chat_groups ORDER BY id').all().map((value) => ({
      id: Number(value.id), publicId: Number(value.public_id), type: value.type,
      ownerUin: Number(value.owner_uin), title: value.title, createdAt: value.created_at, members: [],
    }));
    const byGroup = new Map(groups.map((group) => [group.id, group]));
    for (const value of this.db.prepare('SELECT * FROM group_members ORDER BY group_id, joined_at').all()) {
      const group = byGroup.get(Number(value.group_id));
      if (group) group.members.push({
        uin: Number(value.uin), role: value.role, joinedAt: value.joined_at,
        replyPolicy: value.reply_policy, replyProbability: value.reply_probability,
      });
    }
    const setting = this.db.prepare("SELECT value FROM settings WHERE key = 'virtual_year_offset'").get();
    const meta = Object.fromEntries(this.db.prepare('SELECT key, value FROM meta').all()
      .map((value) => [value.key, value.value]));
    return {
      version: Number(meta.data_version),
      settings: { virtualTime: { yearOffset: Number(setting ? setting.value : -14) } },
      nextMessageId: Number(meta.next_message_id || 1),
      nextGroupId: Number(meta.next_group_id || 200001),
      nextGroupMessageId: Number(meta.next_group_message_id || 1),
      accounts,
      messages: this.db.prepare('SELECT id, from_uin, to_uin, text, sent_at, source FROM messages ORDER BY id')
        .all().map((value) => ({ id: Number(value.id), from: Number(value.from_uin),
          to: Number(value.to_uin), text: value.text, sentAt: value.sent_at, source: value.source })),
      relationships: this.db.prepare('SELECT * FROM relationships').all().map((value) => ({
        virtualUin: Number(value.virtual_uin), targetUin: Number(value.target_uin),
        label: value.label, addressAs: value.address_as, description: value.description,
        sharedHistory: value.shared_history, privateNotes: value.private_notes,
        closeness: Number(value.closeness), trust: Number(value.trust),
      })),
      providers: this.db.prepare('SELECT * FROM providers').all().map((value) => ({
        id: value.id, name: value.name, baseUrl: value.base_url, model: value.model,
        apiKeyEnv: value.api_key_env, apiKeyProtected: value.api_key_protected,
        temperature: Number(value.temperature), maxTokens: Number(value.max_tokens),
        timeoutMs: Number(value.timeout_ms), extraHeaders: json(value.extra_headers_json, {}),
      })),
      outbox: this.db.prepare('SELECT * FROM outbox ORDER BY created_at').all().map((value) => ({
        id: value.id, from: Number(value.from_uin), to: Number(value.to_uin),
        text: value.text, createdAt: value.created_at,
      })),
      groups,
      groupMessages: this.db.prepare('SELECT * FROM group_messages ORDER BY id').all().map((value) => ({
        id: Number(value.id), groupId: Number(value.group_id), from: Number(value.from_uin),
        text: value.text, sentAt: value.sent_at, source: value.source,
      })),
    };
  }

  // 保存前收敛引用：就地剔除会撞外键 / 唯一约束的行。
  //
  // 为什么必须有这一步：save() 是「全表 DELETE + 重建」的单事务，任何一行
  // 违反约束都会让整个事务回滚——库被冻结在上一个版本，后续每次 save 继续
  // 失败。2026-09-20 的故障就是这么来的：NapCat 换号后，旧账号的群从镜像里
  // 消失，但 group_messages 还留着指向那些群的历史消息，
  // group_messages.group_id -> chat_groups(id) 外键失败 → 联系人镜像永远刷不上。
  //
  // 这里的选择是「丢弃失效引用」而不是「让事务失败」：失效引用指向的对象已经
  // 不存在，本身就是坏数据；丢弃后内存模型与落库内容保持一致（就地改 data），
  // 避免每轮 save 重复踩同一个坑。收敛结果通过 report 上报，由调用方写日志。
  reconcile(data) {
    const report = {
      accounts: 0, groups: 0, members: 0, groupMessages: 0,
      friends: 0, requests: 0, messages: 0, outbox: 0,
      providers: 0, relationships: 0,
    };
    const drop = (kind) => { report[kind] += 1; };

    // 1) accounts：uin 重复会撞主键
    const uins = new Set();
    data.accounts = (data.accounts || []).filter((account) => {
      const uin = Number(account.uin);
      if (!Number.isInteger(uin) || uin <= 0 || uins.has(uin)) {
        drop('accounts');
        return false;
      }
      uins.add(uin);
      account.uin = uin;
      account.friends = Array.isArray(account.friends)
        ? account.friends.map(Number).filter((value) => Number.isInteger(value)) : [];
      account.incomingRequests = Array.isArray(account.incomingRequests)
        ? account.incomingRequests : [];
      return true;
    });

    // 2) chat_groups：id / public_id 唯一，且 owner_uin 必须存在
    const groupIds = new Set();
    const publicIds = new Set();
    data.groups = (data.groups || []).filter((group) => {
      const id = Number(group.id);
      const publicId = Number(group.publicId);
      const ownerUin = Number(group.ownerUin);
      if (!Number.isInteger(id) || groupIds.has(id)
          || !Number.isInteger(publicId) || publicIds.has(publicId)
          || !uins.has(ownerUin)) {
        drop('groups');
        return false;
      }
      groupIds.add(id);
      publicIds.add(publicId);
      group.id = id;
      group.publicId = publicId;
      group.ownerUin = ownerUin;
      return true;
    });

    // 3) group_members：uin 必须是已知账号
    for (const group of data.groups) {
      const memberUins = new Set();
      group.members = (group.members || []).filter((member) => {
        const uin = Number(member.uin);
        if (!uins.has(uin) || memberUins.has(uin)) {
          drop('members');
          return false;
        }
        memberUins.add(uin);
        member.uin = uin;
        return true;
      });
    }

    // 4) group_messages：群和发送者都必须还存在（本次故障的直接原因）
    const groupMessageIds = new Set();
    data.groupMessages = (data.groupMessages || []).filter((message) => {
      const id = Number(message.id);
      if (!Number.isInteger(id) || groupMessageIds.has(id)
          || !groupIds.has(Number(message.groupId))
          || !uins.has(Number(message.from))) {
        drop('groupMessages');
        return false;
      }
      groupMessageIds.add(id);
      return true;
    });

    // 5) friends / friend_requests：两端都必须是已知账号
    for (const account of data.accounts) {
      const seenFriends = new Set();
      account.friends = account.friends.filter((friendUin) => {
        const value = Number(friendUin);
        if (!uins.has(value) || seenFriends.has(value)) {
          drop('friends');
          return false;
        }
        seenFriends.add(value);
        return true;
      });
      const seenRequesters = new Set();
      account.incomingRequests = account.incomingRequests.filter((request) => {
        const from = Number(request.from);
        if (!uins.has(from) || seenRequesters.has(from)) {
          drop('requests');
          return false;
        }
        seenRequesters.add(from);
        request.from = from;
        return true;
      });
    }

    // 6) 其余表没有外键，但主键 / 唯一键冲突同样会回滚，一并去重
    const messageIds = new Set();
    data.messages = (data.messages || []).filter((message) => {
      const id = Number(message.id);
      if (!Number.isInteger(id) || messageIds.has(id)) {
        drop('messages');
        return false;
      }
      messageIds.add(id);
      return true;
    });
    const outboxIds = new Set();
    data.outbox = (data.outbox || []).filter((entry) => {
      const id = String(entry.id);
      if (outboxIds.has(id)) {
        drop('outbox');
        return false;
      }
      outboxIds.add(id);
      return true;
    });
    const providerIds = new Set();
    data.providers = (data.providers || []).filter((provider) => {
      const id = String(provider.id);
      if (providerIds.has(id)) {
        drop('providers');
        return false;
      }
      providerIds.add(id);
      return true;
    });
    const relationshipKeys = new Set();
    data.relationships = (data.relationships || []).filter((relationship) => {
      const key = `${Number(relationship.virtualUin)}:${Number(relationship.targetUin)}`;
      if (relationshipKeys.has(key)) {
        drop('relationships');
        return false;
      }
      relationshipKeys.add(key);
      return true;
    });

    let removed = 0;
    for (const kind of Object.keys(report)) removed += report[kind];
    report.removed = removed;
    return report;
  }

  save(data) {
    // 先收敛，再开事务：宁可丢弃失效引用，也不能让整个事务回滚。
    const report = this.reconcile(data);
    if (report.removed > 0 && this.logger) {
      this.logger.error(`[store] 保存前收敛了 ${report.removed} 条失效引用，`
        + '避免外键/唯一约束导致整库回滚: ' + JSON.stringify(report));
    }
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        DELETE FROM group_messages; DELETE FROM group_members; DELETE FROM chat_groups;
        DELETE FROM outbox; DELETE FROM providers; DELETE FROM relationships;
        DELETE FROM messages; DELETE FROM friend_requests; DELETE FROM friends;
        DELETE FROM accounts; DELETE FROM settings; DELETE FROM meta;
      `);
      const meta = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
      for (const [key, value] of [
        ['schema_version', SCHEMA_VERSION], ['data_version', data.version],
        ['next_message_id', data.nextMessageId], ['next_group_id', data.nextGroupId],
        ['next_group_message_id', data.nextGroupMessageId],
      ]) meta.run(key, String(value));
      db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)')
        .run('virtual_year_offset', String(data.settings.virtualTime.yearOffset));
      const account = db.prepare(`INSERT INTO accounts
        (uin,type,enabled,nickname,password_digest,profile_json,virtual_json) VALUES (?,?,?,?,?,?,?)`);
      for (const value of data.accounts) account.run(value.uin, value.type, value.enabled ? 1 : 0,
        value.nickname, value.passwordDigest, JSON.stringify(value.profile),
        value.virtual ? JSON.stringify(value.virtual) : null);
      const friend = db.prepare('INSERT INTO friends(owner_uin, friend_uin) VALUES (?, ?)');
      const request = db.prepare(`INSERT INTO friend_requests
        (receiver_uin,sender_uin,message,created_at) VALUES (?,?,?,?)`);
      for (const value of data.accounts) {
        for (const friendUin of value.friends) friend.run(value.uin, friendUin);
        for (const incoming of value.incomingRequests) request.run(
          value.uin, incoming.from, incoming.message, incoming.createdAt);
      }
      const message = db.prepare(`INSERT INTO messages
        (id,from_uin,to_uin,text,sent_at,source) VALUES (?,?,?,?,?,?)`);
      for (const value of data.messages) message.run(
        value.id, value.from, value.to, value.text, value.sentAt, value.source);
      const relationship = db.prepare(`INSERT INTO relationships
        (virtual_uin,target_uin,label,address_as,description,shared_history,private_notes,closeness,trust)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const value of data.relationships) relationship.run(value.virtualUin, value.targetUin,
        value.label, value.addressAs, value.description, value.sharedHistory, value.privateNotes,
        value.closeness, value.trust);
      const provider = db.prepare(`INSERT INTO providers
        (id,name,base_url,model,api_key_env,api_key_protected,temperature,max_tokens,timeout_ms,extra_headers_json)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for (const value of data.providers) provider.run(value.id, value.name, value.baseUrl, value.model,
        value.apiKeyEnv, value.apiKeyProtected, value.temperature, value.maxTokens, value.timeoutMs,
        JSON.stringify(value.extraHeaders));
      const outbox = db.prepare(`INSERT INTO outbox
        (id,from_uin,to_uin,text,created_at) VALUES (?,?,?,?,?)`);
      for (const value of data.outbox) outbox.run(
        value.id, value.from, value.to, value.text, value.createdAt);
      const group = db.prepare(`INSERT INTO chat_groups
        (id,public_id,type,owner_uin,title,created_at) VALUES (?,?,?,?,?,?)`);
      const member = db.prepare(`INSERT INTO group_members
        (group_id,uin,role,joined_at,reply_policy,reply_probability) VALUES (?,?,?,?,?,?)`);
      for (const value of data.groups) {
        group.run(value.id, value.publicId, value.type, value.ownerUin, value.title, value.createdAt);
        for (const item of value.members) member.run(value.id, item.uin, item.role,
          item.joinedAt, item.replyPolicy || '', item.replyProbability);
      }
      const groupMessage = db.prepare(`INSERT INTO group_messages
        (id,group_id,from_uin,text,sent_at,source) VALUES (?,?,?,?,?,?)`);
      for (const value of data.groupMessages) groupMessage.run(
        value.id, value.groupId, value.from, value.text, value.sentAt, value.source);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return report;
  }

  saveMedia(value) {
    this.db.prepare(`INSERT OR REPLACE INTO media_items
      (id,from_uin,to_uin,filename,mime_type,media_type,size,sha256,legacy_hash,content,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      value.id, value.from, value.to, value.filename, value.mimeType, value.mediaType,
      value.size, value.sha256, value.legacyHash, value.content, value.createdAt);
    return this.getMedia(value.id);
  }

  getMedia(id) {
    const value = this.db.prepare('SELECT * FROM media_items WHERE id = ?').get(String(id));
    if (!value) return null;
    return {
      id: value.id, from: Number(value.from_uin), to: Number(value.to_uin),
      filename: value.filename, mimeType: value.mime_type, mediaType: Number(value.media_type),
      size: Number(value.size), sha256: value.sha256,
      legacyHash: Buffer.from(value.legacy_hash), content: Buffer.from(value.content),
      createdAt: value.created_at,
    };
  }

  listMediaFor(uin, limit) {
    const maximum = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db.prepare(`SELECT id,from_uin,to_uin,filename,mime_type,media_type,size,sha256,
      legacy_hash,created_at FROM media_items WHERE from_uin = ? OR to_uin = ?
      ORDER BY created_at DESC LIMIT ?`).all(Number(uin), Number(uin), maximum).map((value) => ({
      id: value.id, from: Number(value.from_uin), to: Number(value.to_uin),
      filename: value.filename, mimeType: value.mime_type, mediaType: Number(value.media_type),
      size: Number(value.size), sha256: value.sha256,
      legacyHash: Buffer.from(value.legacy_hash), createdAt: value.created_at,
    }));
  }

  close() {
    this.db.close();
  }
}

module.exports = { SCHEMA_VERSION, SqlitePersistence, resolveFiles };
