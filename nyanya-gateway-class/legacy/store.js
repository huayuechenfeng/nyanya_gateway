'use strict';

const crypto = require('node:crypto');
const { SqlitePersistence } = require('./sqlite-persistence');

const EMPTY_DIGEST = '00000000000000000000000000000000';
const CURRENT_DATA_VERSION = 4;
const GROUP_REPLY_POLICIES = ['always', 'mentions', 'random', 'llm', 'never'];

function digestPassword(password) {
  return crypto.createHash('md5').update(Buffer.from(password, 'latin1')).digest('hex');
}

function defaultProfile(overrides) {
  return Object.assign({
    realName: '', gender: 0, age: 0, avatar: 0,
    country: '中国', province: '', city: '', address: '', postalCode: '',
    school: '', education: '', occupation: '', company: '',
    phone: '', mobile: '', email: '', homepage: '', hobby: '',
    signature: '', description: '',
  }, overrides || {});
}

function defaultVirtualAgent(overrides) {
  return Object.assign({
    identity: '',
    roleCard: '',
    responseStyle: '像真实的手机 QQ 用户一样简短自然地交谈。',
    providerId: '',
    friendPolicy: 'auto',
    groupReplyPolicy: 'mentions',
    groupReplyProbability: 0.35,
    replyDelayMinMs: 1200,
    replyDelayMaxMs: 5000,
    longTermMemory: '',
    lastCompactedMessageId: 0,
    compactAfterMessages: 50,
    lifeState: {
      location: '', activity: '', mood: '平静', energy: '正常',
      currentStory: '', updatedAt: new Date(0).toISOString(),
    },
  }, overrides || {});
}

function defaultData() {
  return {
    version: CURRENT_DATA_VERSION,
    settings: {
      virtualTime: { yearOffset: -14 },
    },
    nextMessageId: 1,
    nextGroupId: 200001,
    nextGroupMessageId: 1,
    messages: [],
    groups: [],
    groupMessages: [],
    relationships: [],
    providers: [],
    outbox: [],
    accounts: [
      {
        uin: 10001, type: 'human', enabled: true,
        nickname: 'J2ME-A', passwordDigest: digestPassword('qqtest123'),
        profile: defaultProfile({ realName: '测试用户 A', signature: '来自复活后的手机 QQ' }),
        friends: [], incomingRequests: [],
      },
      {
        uin: 10002, type: 'human', enabled: true,
        nickname: 'J2ME-B', passwordDigest: digestPassword('qqtest456'),
        profile: defaultProfile({ realName: '测试用户 B', signature: '局域网里的第二位用户' }),
        friends: [], incomingRequests: [],
      },
    ],
  };
}

function integerUin(value) {
  const uin = Number(value);
  if (!Number.isInteger(uin) || uin <= 0 || uin > 0xFFFFFFFF) {
    throw new Error('UIN must fit in an unsigned 32-bit integer');
  }
  return uin;
}

function cleanText(value, maximum) {
  const text = String(value === undefined || value === null ? '' : value);
  return maximum && text.length > maximum ? text.slice(0, maximum) : text;
}

function normalizeProfile(value) {
  const profile = defaultProfile(value);
  profile.realName = cleanText(profile.realName, 80);
  profile.signature = cleanText(profile.signature, 240);
  profile.description = cleanText(profile.description, 2000);
  profile.age = Math.max(0, Math.min(150, Number(profile.age) || 0));
  profile.gender = Math.max(0, Math.min(2, Number(profile.gender) || 0));
  profile.avatar = Math.max(0, Math.min(0xFFFF, Number(profile.avatar) || 0));
  for (const key of Object.keys(profile)) {
    if (!['age', 'gender', 'avatar'].includes(key)) profile[key] = cleanText(profile[key], 500);
  }
  return profile;
}

function normalizeVirtualAgent(value) {
  if (!value) return null;
  const agent = defaultVirtualAgent(value);
  agent.identity = cleanText(agent.identity, 8000);
  agent.roleCard = cleanText(agent.roleCard, 30000);
  agent.responseStyle = cleanText(agent.responseStyle, 4000);
  // Version 3 uses the gateway computer's local system time for every
  // virtual resident. Remove the old per-agent override during migration.
  delete agent.timezone;
  agent.providerId = cleanText(agent.providerId, 80);
  agent.friendPolicy = ['auto', 'delayed', 'manual', 'deny'].includes(agent.friendPolicy)
    ? agent.friendPolicy : 'auto';
  agent.groupReplyPolicy = GROUP_REPLY_POLICIES.includes(agent.groupReplyPolicy)
    ? agent.groupReplyPolicy : 'mentions';
  agent.groupReplyProbability = Math.max(0, Math.min(1,
    Number.isFinite(Number(agent.groupReplyProbability))
      ? Number(agent.groupReplyProbability) : 0.35));
  agent.replyDelayMinMs = Math.max(0, Math.min(300000, Number(agent.replyDelayMinMs) || 0));
  agent.replyDelayMaxMs = Math.max(agent.replyDelayMinMs,
    Math.min(600000, Number(agent.replyDelayMaxMs) || agent.replyDelayMinMs));
  agent.longTermMemory = cleanText(agent.longTermMemory, 100000);
  agent.lastCompactedMessageId = Math.max(0, Number(agent.lastCompactedMessageId) || 0);
  agent.compactAfterMessages = Math.max(10, Math.min(1000, Number(agent.compactAfterMessages) || 50));
  agent.lifeState = Object.assign(defaultVirtualAgent().lifeState, agent.lifeState || {});
  return agent;
}

function normalizeSettings(value) {
  const settings = value && typeof value === 'object' ? value : {};
  const virtualTime = settings.virtualTime && typeof settings.virtualTime === 'object'
    ? settings.virtualTime : {};
  const parsedOffset = Number(virtualTime.yearOffset);
  const yearOffset = Number.isFinite(parsedOffset)
    ? Math.max(-200, Math.min(200, Math.trunc(parsedOffset))) : -14;
  return { virtualTime: { yearOffset } };
}

function normalizeData(data) {
  if (!data || !Array.isArray(data.accounts)) throw new Error('account data has no accounts array');
  const seen = new Set();
  const accounts = data.accounts.map((value) => {
    const uin = integerUin(value.uin);
    if (seen.has(uin)) throw new Error('account data contains a duplicate UIN');
    seen.add(uin);
    const type = value.type === 'virtual' ? 'virtual' : 'human';
    let passwordDigest = String(value.passwordDigest || (type === 'virtual' ? EMPTY_DIGEST : '')).toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(passwordDigest)) {
      throw new Error(`account ${uin} has an invalid password digest`);
    }
    if (type === 'virtual') passwordDigest = EMPTY_DIGEST;
    return {
      uin,
      type,
      enabled: value.enabled !== false,
      nickname: cleanText(value.nickname || uin, 80),
      passwordDigest,
      profile: normalizeProfile(value.profile || { avatar: value.avatar || 0 }),
      virtual: type === 'virtual' ? normalizeVirtualAgent(value.virtual || {}) : null,
      friends: Array.from(new Set((value.friends || []).map(Number)))
        .filter((friend) => Number.isInteger(friend) && friend > 0 && friend <= 0xFFFFFFFF),
      incomingRequests: (value.incomingRequests || []).map((request) => ({
        from: Number(request.from),
        message: cleanText(request.message, 1000),
        createdAt: String(request.createdAt || new Date(0).toISOString()),
      })).filter((request) => Number.isInteger(request.from)),
    };
  });
  const messages = (data.messages || []).map((message, index) => ({
    id: Number(message.id) || index + 1,
    from: Number(message.from),
    to: Number(message.to),
    text: cleanText(message.text, 10000),
    sentAt: String(message.sentAt || new Date(0).toISOString()),
    source: message.source === 'virtual' ? 'virtual' : 'client',
  })).filter((message) => Number.isInteger(message.from) && Number.isInteger(message.to));
  const maximumMessageId = messages.reduce((maximum, message) => Math.max(maximum, message.id), 0);
  const relationships = (data.relationships || []).map((relationship) => ({
    virtualUin: Number(relationship.virtualUin),
    targetUin: Number(relationship.targetUin),
    label: cleanText(relationship.label, 80),
    addressAs: cleanText(relationship.addressAs, 80),
    description: cleanText(relationship.description, 8000),
    sharedHistory: cleanText(relationship.sharedHistory, 12000),
    privateNotes: cleanText(relationship.privateNotes, 12000),
    closeness: Math.max(0, Math.min(100, Number(relationship.closeness) || 0)),
    trust: Math.max(0, Math.min(100, Number(relationship.trust) || 0)),
  })).filter((relationship) => Number.isInteger(relationship.virtualUin)
    && Number.isInteger(relationship.targetUin));
  const providers = (data.providers || []).map((provider) => ({
    id: cleanText(provider.id, 80),
    name: cleanText(provider.name, 120),
    baseUrl: cleanText(provider.baseUrl, 500),
    model: cleanText(provider.model, 200),
    apiKeyEnv: cleanText(provider.apiKeyEnv, 120),
    apiKeyProtected: cleanText(provider.apiKeyProtected, 20000),
    temperature: Math.max(0, Math.min(2, Number(provider.temperature) || 0.85)),
    maxTokens: Math.max(16, Math.min(8192, Number(provider.maxTokens) || 300)),
    timeoutMs: Math.max(1000, Math.min(300000, Number(provider.timeoutMs) || 60000)),
    extraHeaders: provider.extraHeaders && typeof provider.extraHeaders === 'object'
      ? provider.extraHeaders : {},
  })).filter((provider) => provider.id && provider.baseUrl && provider.model);
  const outbox = (data.outbox || []).map((entry) => ({
    id: cleanText(entry.id || crypto.randomUUID(), 100),
    from: Number(entry.from), to: Number(entry.to), text: cleanText(entry.text, 10000),
    createdAt: String(entry.createdAt || new Date().toISOString()),
  })).filter((entry) => Number.isInteger(entry.from) && Number.isInteger(entry.to));
  const groups = (data.groups || []).map((group, index) => {
    const id = Number(group.id) || 200001 + index;
    const ownerUin = Number(group.ownerUin);
    const seenMembers = new Set();
    const members = (group.members || []).map((member) => {
      const value = typeof member === 'object' ? member : { uin: member };
      const uin = Number(value.uin);
      if (!Number.isInteger(uin) || seenMembers.has(uin)) return null;
      seenMembers.add(uin);
      return {
        uin,
        role: value.role === 'owner' || uin === ownerUin ? 'owner' : 'member',
        joinedAt: String(value.joinedAt || group.createdAt || new Date(0).toISOString()),
        replyPolicy: GROUP_REPLY_POLICIES.includes(value.replyPolicy)
          ? value.replyPolicy : '',
        replyProbability: value.replyProbability === undefined || value.replyProbability === null
          ? null : Math.max(0, Math.min(1, Number(value.replyProbability) || 0)),
      };
    }).filter(Boolean);
    if (Number.isInteger(ownerUin) && !seenMembers.has(ownerUin)) {
      members.unshift({
        uin: ownerUin, role: 'owner',
        joinedAt: String(group.createdAt || new Date(0).toISOString()),
        replyPolicy: '', replyProbability: null,
      });
    }
    return {
      id,
      publicId: Number(group.publicId) || id,
      type: group.type === 'discussion' ? 'discussion' : 'group',
      ownerUin,
      title: cleanText(group.title || `Group ${id}`, 120),
      createdAt: String(group.createdAt || new Date(0).toISOString()),
      members,
    };
  }).filter((group) => Number.isInteger(group.id) && group.id > 0
    && Number.isInteger(group.ownerUin));
  const groupMessages = (data.groupMessages || []).map((message, index) => ({
    id: Number(message.id) || index + 1,
    groupId: Number(message.groupId),
    from: Number(message.from),
    text: cleanText(message.text, 10000),
    sentAt: String(message.sentAt || new Date(0).toISOString()),
    source: message.source === 'virtual' ? 'virtual' : 'client',
  })).filter((message) => Number.isInteger(message.groupId) && Number.isInteger(message.from));
  const maximumGroupId = groups.reduce((maximum, group) => Math.max(maximum, group.id), 200000);
  const maximumGroupMessageId = groupMessages.reduce(
    (maximum, message) => Math.max(maximum, message.id), 0);
  return {
    version: CURRENT_DATA_VERSION,
    settings: normalizeSettings(data.settings),
    nextMessageId: Math.max(maximumMessageId + 1, Number(data.nextMessageId) || 1),
    nextGroupId: Math.max(maximumGroupId + 1, Number(data.nextGroupId) || 200001),
    nextGroupMessageId: Math.max(maximumGroupMessageId + 1,
      Number(data.nextGroupMessageId) || 1),
    accounts, messages, relationships, providers, outbox, groups, groupMessages,
  };
}

class AccountStore {
  constructor(dataFile, initialData) {
    this.persistence = new SqlitePersistence(dataFile);
    this.dataFile = this.persistence.databaseFile;
    this.legacyDataFile = this.persistence.legacyDataFile;
    const stored = this.persistence.load();
    const imported = stored || this.persistence.loadLegacyJson();
    this.data = normalizeData(imported || initialData || defaultData());
    if (!stored) this.save();
  }

  save() {
    this.persistence.save(this.data);
  }

  get(uin) {
    return this.data.accounts.find((account) => account.uin === Number(uin)) || null;
  }

  listAccounts() {
    return this.data.accounts.slice().sort((left, right) => left.uin - right.uin);
  }

  updateVirtualTime(yearOffset) {
    const parsed = Number(yearOffset);
    if (!Number.isInteger(parsed) || parsed < -200 || parsed > 200) {
      throw new Error('virtual year offset must be an integer between -200 and 200');
    }
    this.data.settings.virtualTime.yearOffset = parsed;
    this.save();
    return this.data.settings.virtualTime;
  }

  addAccount(uinOrOptions, nickname, password) {
    const options = typeof uinOrOptions === 'object' ? uinOrOptions
      : { uin: uinOrOptions, nickname, password, type: 'human' };
    const uin = integerUin(options.uin);
    if (this.get(uin)) throw new Error(`account ${uin} already exists`);
    const type = options.type === 'virtual' ? 'virtual' : 'human';
    if (type === 'human' && !String(options.password || '')) throw new Error('password cannot be empty');
    const account = normalizeData({ accounts: [{
      uin,
      type,
      nickname: options.nickname || uin,
      enabled: options.enabled !== false,
      passwordDigest: type === 'human' ? digestPassword(String(options.password)) : EMPTY_DIGEST,
      profile: options.profile || {},
      virtual: type === 'virtual' ? options.virtual || {} : null,
      friends: [], incomingRequests: [],
    }] }).accounts[0];
    this.data.accounts.push(account);
    this.save();
    return account;
  }

  updateAccount(uin, changes) {
    const account = this.get(uin);
    if (!account) throw new Error(`account ${uin} was not found`);
    if (changes.nickname !== undefined) account.nickname = cleanText(changes.nickname, 80) || String(account.uin);
    if (changes.enabled !== undefined) account.enabled = Boolean(changes.enabled);
    if (changes.profile) account.profile = normalizeProfile(Object.assign({}, account.profile, changes.profile));
    if (account.type === 'virtual' && changes.virtual) {
      account.virtual = normalizeVirtualAgent(Object.assign({}, account.virtual, changes.virtual, {
        lifeState: Object.assign({}, account.virtual.lifeState, changes.virtual.lifeState || {}),
      }));
    }
    this.save();
    return account;
  }

  resetPassword(uin, password) {
    const account = this.get(uin);
    if (!account || account.type !== 'human') throw new Error(`human account ${uin} was not found`);
    if (!String(password || '')) throw new Error('password cannot be empty');
    account.passwordDigest = digestPassword(String(password));
    this.save();
    return account;
  }

  authenticate(uin, digest) {
    const account = this.get(uin);
    if (!account || account.type !== 'human' || !account.enabled
        || !Buffer.isBuffer(digest) || digest.length !== 16) return null;
    const expected = Buffer.from(account.passwordDigest, 'hex');
    return crypto.timingSafeEqual(expected, digest) ? account : null;
  }

  search(query, requesterUin) {
    const normalized = String(query || '').trim().toLowerCase();
    if (!normalized) return [];
    return this.data.accounts.filter((account) => account.enabled
      && account.uin !== Number(requesterUin)
      && (String(account.uin) === normalized || account.nickname.toLowerCase().includes(normalized)
        || account.profile.realName.toLowerCase().includes(normalized)));
  }

  friendsOf(uin) {
    const account = this.get(uin);
    return account ? account.friends.map((friendUin) => this.get(friendUin))
      .filter((friend) => friend && friend.enabled) : [];
  }

  requestFriend(fromUin, toUin, message) {
    const from = this.get(fromUin);
    const to = this.get(toUin);
    if (!from || !to || !from.enabled || !to.enabled || from.uin === to.uin) {
      return { ok: false, reason: 'invalid_account' };
    }
    if (from.friends.includes(to.uin)) return { ok: true, alreadyFriends: true };
    const existing = to.incomingRequests.find((request) => request.from === from.uin);
    if (existing) {
      existing.message = cleanText(message, 1000);
      existing.createdAt = new Date().toISOString();
    } else {
      to.incomingRequests.push({
        from: from.uin,
        message: cleanText(message, 1000),
        createdAt: new Date().toISOString(),
      });
    }
    this.save();
    return { ok: true, alreadyFriends: false };
  }

  acceptFriend(receiverUin, requesterUin) {
    const receiver = this.get(receiverUin);
    const requester = this.get(requesterUin);
    if (!receiver || !requester) return { ok: false, reason: 'invalid_account' };
    const index = receiver.incomingRequests.findIndex((request) => request.from === requester.uin);
    if (index < 0 && !receiver.friends.includes(requester.uin)) {
      return { ok: false, reason: 'request_not_found' };
    }
    if (index >= 0) receiver.incomingRequests.splice(index, 1);
    if (!receiver.friends.includes(requester.uin)) receiver.friends.push(requester.uin);
    if (!requester.friends.includes(receiver.uin)) requester.friends.push(receiver.uin);
    this.save();
    return { ok: true };
  }

  rejectFriend(receiverUin, requesterUin) {
    const receiver = this.get(receiverUin);
    const requester = this.get(requesterUin);
    if (!receiver || !requester) return { ok: false, reason: 'invalid_account' };
    const previousLength = receiver.incomingRequests.length;
    receiver.incomingRequests = receiver.incomingRequests
      .filter((request) => request.from !== requester.uin);
    if (receiver.incomingRequests.length === previousLength) {
      return { ok: false, reason: 'request_not_found' };
    }
    this.save();
    return { ok: true };
  }

  saveMessage(fromUin, toUin, text, source) {
    const message = {
      id: this.data.nextMessageId++,
      from: Number(fromUin), to: Number(toUin), text: cleanText(text, 10000),
      sentAt: new Date().toISOString(),
      source: source === 'virtual' ? 'virtual' : 'client',
    };
    this.data.messages.push(message);
    this.save();
    return message;
  }

  messagesForVirtual(virtualUin, options) {
    const afterId = Number(options && options.afterId) || 0;
    const limit = Math.max(1, Math.min(5000, Number(options && options.limit) || 200));
    return this.data.messages.filter((message) => message.id > afterId
      && (message.from === Number(virtualUin) || message.to === Number(virtualUin))).slice(-limit);
  }

  setRelationship(virtualUin, targetUin, changes) {
    const virtual = this.get(virtualUin);
    const target = this.get(targetUin);
    if (!virtual || virtual.type !== 'virtual' || !target) throw new Error('relationship accounts were not found');
    let relationship = this.getRelationship(virtualUin, targetUin);
    if (!relationship) {
      relationship = { virtualUin: virtual.uin, targetUin: target.uin };
      this.data.relationships.push(relationship);
    }
    Object.assign(relationship, changes || {});
    const normalized = normalizeData({ accounts: this.data.accounts, relationships: [relationship] })
      .relationships[0];
    Object.assign(relationship, normalized);
    this.save();
    return relationship;
  }

  getRelationship(virtualUin, targetUin) {
    return this.data.relationships.find((relationship) => relationship.virtualUin === Number(virtualUin)
      && relationship.targetUin === Number(targetUin)) || null;
  }

  virtualAccounts() {
    return this.data.accounts.filter((account) => account.type === 'virtual' && account.enabled);
  }

  upsertProvider(input) {
    const id = cleanText(input.id || crypto.randomUUID(), 80);
    let provider = this.data.providers.find((value) => value.id === id);
    const candidate = Object.assign({}, provider || {}, input, { id });
    const normalized = normalizeData({ accounts: this.data.accounts, providers: [candidate] }).providers[0];
    if (!normalized) throw new Error('provider requires a base URL and model');
    if (provider) Object.assign(provider, normalized);
    else { provider = normalized; this.data.providers.push(provider); }
    this.save();
    return provider;
  }

  getProvider(id) {
    return this.data.providers.find((provider) => provider.id === String(id)) || null;
  }

  updateVirtualMemory(uin, longTermMemory, lastMessageId, lifeState) {
    const account = this.get(uin);
    if (!account || account.type !== 'virtual') throw new Error(`virtual account ${uin} was not found`);
    account.virtual.longTermMemory = cleanText(longTermMemory, 100000);
    account.virtual.lastCompactedMessageId = Math.max(
      account.virtual.lastCompactedMessageId, Number(lastMessageId) || 0);
    if (lifeState) account.virtual.lifeState = Object.assign({}, account.virtual.lifeState, lifeState, {
      updatedAt: new Date().toISOString(),
    });
    this.save();
    return account.virtual;
  }

  enqueueOutbox(from, to, text) {
    const entry = { id: crypto.randomUUID(), from: Number(from), to: Number(to),
      text: cleanText(text, 10000), createdAt: new Date().toISOString() };
    this.data.outbox.push(entry);
    this.save();
    return entry;
  }

  takeOutbox(to) {
    const selected = this.data.outbox.filter((entry) => entry.to === Number(to));
    this.data.outbox = this.data.outbox.filter((entry) => entry.to !== Number(to));
    if (selected.length > 0) this.save();
    return selected;
  }

  createGroup(options) {
    const values = options || {};
    const owner = this.get(values.ownerUin);
    if (!owner || !owner.enabled) throw new Error('group owner was not found');
    const requestedMembers = Array.from(new Set(
      [owner.uin].concat(values.memberUins || []).map(Number)));
    const missing = requestedMembers.filter((uin) => {
      const account = this.get(uin);
      return !account || !account.enabled;
    });
    if (missing.length) throw new Error(`group members were not found: ${missing.join(', ')}`);
    let id = integerUin(this.data.nextGroupId);
    while (this.getGroup(id)) {
      if (id === 0xFFFFFFFF) throw new Error('no unused group ID remains');
      id += 1;
    }
    const publicId = values.publicId === undefined || values.publicId === null
      || values.publicId === '' ? id : integerUin(values.publicId);
    if (publicId !== id && this.getGroup(publicId)) {
      throw new Error(`group number ${publicId} already exists`);
    }
    this.data.nextGroupId = id + 1;
    const createdAt = new Date().toISOString();
    const group = {
      id,
      publicId,
      type: values.type === 'discussion' ? 'discussion' : 'group',
      ownerUin: owner.uin,
      title: cleanText(values.title || `${owner.nickname}的群聊`, 120),
      createdAt,
      members: requestedMembers.map((uin) => ({
        uin, role: uin === owner.uin ? 'owner' : 'member', joinedAt: createdAt,
        replyPolicy: '', replyProbability: null,
      })),
    };
    this.data.groups.push(group);
    this.save();
    return group;
  }

  getGroup(groupId) {
    const id = Number(groupId);
    return this.data.groups.find((group) => group.id === id || group.publicId === id) || null;
  }

  listGroups() {
    return this.data.groups.slice().sort((left, right) => left.id - right.id);
  }

  groupsOf(uin) {
    const memberUin = Number(uin);
    return this.listGroups().filter(
      (group) => group.members.some((member) => member.uin === memberUin));
  }

  inviteGroupMember(groupId, inviterUin, memberUin, options) {
    const group = this.getGroup(groupId);
    const inviter = this.get(inviterUin);
    const account = this.get(memberUin);
    if (!group) return { ok: false, reason: 'group_not_found' };
    if (!inviter || !group.members.some((member) => member.uin === inviter.uin)) {
      return { ok: false, reason: 'inviter_not_member' };
    }
    if (!account || !account.enabled) return { ok: false, reason: 'account_not_found' };
    const existing = group.members.find((member) => member.uin === account.uin);
    if (existing) return { ok: true, alreadyMember: true, member: existing };
    const settings = options || {};
    const member = {
      uin: account.uin,
      role: 'member',
      joinedAt: new Date().toISOString(),
      replyPolicy: GROUP_REPLY_POLICIES.includes(settings.replyPolicy)
        ? settings.replyPolicy : '',
      replyProbability: settings.replyProbability === undefined
        ? null : Math.max(0, Math.min(1, Number(settings.replyProbability) || 0)),
    };
    group.members.push(member);
    this.save();
    return { ok: true, alreadyMember: false, member };
  }

  updateGroupMember(groupId, memberUin, changes) {
    const group = this.getGroup(groupId);
    const member = group && group.members.find((value) => value.uin === Number(memberUin));
    if (!group || !member) throw new Error('group member was not found');
    if (changes.replyPolicy !== undefined) {
      if (!GROUP_REPLY_POLICIES.concat('').includes(changes.replyPolicy)) {
        throw new Error('invalid group reply policy');
      }
      member.replyPolicy = changes.replyPolicy;
    }
    if (changes.replyProbability !== undefined) {
      member.replyProbability = changes.replyProbability === null ? null
        : Math.max(0, Math.min(1, Number(changes.replyProbability) || 0));
    }
    this.save();
    return member;
  }

  saveGroupMessage(groupId, fromUin, text, source) {
    const group = this.getGroup(groupId);
    const from = Number(fromUin);
    if (!group || !group.members.some((member) => member.uin === from)) {
      throw new Error('sender is not a member of the group');
    }
    const message = {
      id: this.data.nextGroupMessageId++, groupId: group.id, from,
      text: cleanText(text, 10000), sentAt: new Date().toISOString(),
      source: source === 'virtual' ? 'virtual' : 'client',
    };
    this.data.groupMessages.push(message);
    this.save();
    return message;
  }

  groupMessagesForVirtual(virtualUin, options) {
    const afterId = Number(options && options.afterId) || 0;
    const limit = Math.max(1, Math.min(5000, Number(options && options.limit) || 200));
    const groupIds = new Set(this.groupsOf(virtualUin).map((group) => group.id));
    return this.data.groupMessages.filter(
      (message) => message.id > afterId && groupIds.has(message.groupId)).slice(-limit);
  }

  recentGroupMessages(groupId, limit) {
    const group = this.getGroup(groupId);
    if (!group) return [];
    const maximum = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.data.groupMessages.filter(
      (message) => message.groupId === group.id).slice(-maximum);
  }

  saveMedia(value) {
    const from = integerUin(value.from);
    const to = integerUin(value.to);
    if (!this.get(from) || !this.get(to)) throw new Error('media accounts were not found');
    if (!Buffer.isBuffer(value.content) || value.content.length <= 0
        || value.content.length > 10002432) throw new Error('media content has an invalid size');
    if (Number(value.size) !== value.content.length) throw new Error('media size does not match content');
    const media = {
      id: cleanText(value.id || crypto.randomUUID(), 100), from, to,
      filename: cleanText(value.filename || 'media.bin', 255),
      mimeType: cleanText(value.mimeType || 'application/octet-stream', 100),
      mediaType: Math.max(1, Math.min(255, Number(value.mediaType) || 1)),
      size: value.content.length, sha256: cleanText(value.sha256, 64),
      legacyHash: Buffer.from(value.legacyHash || Buffer.alloc(0)),
      content: Buffer.from(value.content), createdAt: String(value.createdAt || new Date().toISOString()),
    };
    return this.persistence.saveMedia(media);
  }

  getMedia(id) {
    return this.persistence.getMedia(id);
  }

  listMediaFor(uin, limit) {
    return this.persistence.listMediaFor(integerUin(uin), limit);
  }

  close() {
    this.persistence.close();
  }
}

module.exports = {
  AccountStore, EMPTY_DIGEST, defaultData, defaultProfile, defaultVirtualAgent,
  digestPassword, normalizeData, normalizeSettings,
};
