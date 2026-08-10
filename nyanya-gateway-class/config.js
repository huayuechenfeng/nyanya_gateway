'use strict';

const fs = require('node:fs');
const path = require('node:path');

function booleanSetting(envValue, fileValue, fallback) {
  if (envValue === '1') return true;
  if (envValue === '0') return false;
  if (typeof fileValue === 'boolean') return fileValue;
  return fallback;
}

// 配置优先级：环境变量 > config.json > 默认值
function loadConfig(overrides) {
  const root = __dirname;
  const file = path.join(root, 'config.json');
  let fileCfg = {};
  if (fs.existsSync(file)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error('bad config.json: ' + err.message);
    }
  }
  const env = process.env;
  const config = {
    // 老客户端接入（TCP 旧 QQ 协议）
    host: env.NYANYA_HOST || fileCfg.host || '0.0.0.0',
    port: Number(env.NYANYA_PORT || fileCfg.port || 14000),

    // NapCat 上联（OneBot v11 正向 WebSocket）
    onebotUrl: env.NYANYA_ONEBOT_URL || fileCfg.onebotUrl || 'ws://127.0.0.1:3001',
    onebotToken: env.NYANYA_ONEBOT_TOKEN || fileCfg.onebotToken || '',

    // 单账号设备：QQ 号必须等于 NapCat self_id，密码为 nyanya 本地 token。
    // deviceUin 留空时，连接 NapCat 后自动采用 self_id。
    deviceUin: Number(env.NYANYA_DEVICE_UIN || fileCfg.deviceUin || 0) || 0,
    deviceToken: env.NYANYA_DEVICE_TOKEN || fileCfg.deviceToken || 'nyanya-dev-token',

    // 数据与日志
    dataDir: path.resolve(root, env.NYANYA_DATA_DIR || fileCfg.dataDir || 'nyanya-data'),

    // 协议行为
    friendPresence: Number(env.NYANYA_FRIEND_PRESENCE
      || (fileCfg.friendPresence === undefined ? 10 : fileCfg.friendPresence) || 10),
    pushGroupMessages: env.NYANYA_PUSH_GROUP_MESSAGES === '0'
      ? false : (fileCfg.pushGroupMessages === false ? false : true),
    // 按群屏蔽：填真实 QQ 群号，这些群的 0x0094 推送会被网关直接丢弃。
    // 客户端本地的"关闭群消息"开关不产生网络命令，只能由网关侧过滤。
    mutedGroupIds: Array.isArray(fileCfg.mutedGroupIds)
      ? fileCfg.mutedGroupIds.map(Number).filter(Number.isInteger) : [],
    notifyIntervalSeconds: Number(env.NYANYA_NOTIFY_INTERVAL_SECONDS
      || fileCfg.notifyIntervalSeconds || 60),
    buddyDetailsPageSize: Number(env.NYANYA_BUDDY_PAGE_SIZE
      || fileCfg.buddyDetailsPageSize || 100),
    symbianBuddyDetailsPageSize: Number(env.NYANYA_SYMBIAN_BUDDY_PAGE_SIZE
      || fileCfg.symbianBuddyDetailsPageSize || 25),
    friendRosterPageSize: Number(env.NYANYA_ROSTER_PAGE_SIZE
      || fileCfg.friendRosterPageSize || 100),
    symbianFriendRosterPageSize: Number(env.NYANYA_SYMBIAN_ROSTER_PAGE_SIZE
      || fileCfg.symbianFriendRosterPageSize || 25),
    symbianGroupDiscoveryBatchSize: Number(env.NYANYA_SYMBIAN_GROUP_BATCH_SIZE
      || fileCfg.symbianGroupDiscoveryBatchSize || 10),
    symbianGroupDiscoveryDelayMs: Number(env.NYANYA_SYMBIAN_GROUP_DELAY_MS
      || fileCfg.symbianGroupDiscoveryDelayMs || 750),
    symbianGroupDiscoveryIntervalMs: Number(env.NYANYA_SYMBIAN_GROUP_INTERVAL_MS
      || fileCfg.symbianGroupDiscoveryIntervalMs || 250),
    // Put this many stable groups first in S60's requested 0x00AF list. The
    // complete group mirror follows in group-only pages; their page width is
    // symbianGroupDiscoveryBatchSize (10 by default). Unsolicited 0x0054 does
    // not create a CQQGroup object on QQ2013 and cannot replace this list.
    symbianGroupProbeLimit: Number(env.NYANYA_SYMBIAN_GROUP_PROBE_LIMIT
      || (fileCfg.symbianGroupProbeLimit === undefined ? 1
        : fileCfg.symbianGroupProbeLimit)),
    symbianGroupProbeId: Number(env.NYANYA_SYMBIAN_GROUP_PROBE_ID
      || fileCfg.symbianGroupProbeId || 0),
    symbianGroupProbeSendMapping: booleanSetting(
      env.NYANYA_SYMBIAN_GROUP_PROBE_SEND_MAPPING,
      fileCfg.symbianGroupProbeSendMapping, false),
    symbianGroupInfoProfile: env.NYANYA_SYMBIAN_GROUP_INFO_PROFILE
      || fileCfg.symbianGroupInfoProfile || 's60_qq2013',
    symbianDiscussionListLimit: Number(env.NYANYA_SYMBIAN_DISCUSSION_LIST_LIMIT
      || fileCfg.symbianDiscussionListLimit || 60),
    groupMemberMirrorLimit: Number(env.NYANYA_GROUP_MEMBER_MIRROR_LIMIT
      || (fileCfg.groupMemberMirrorLimit === undefined ? 60 : fileCfg.groupMemberMirrorLimit)),
    sendMinIntervalMs: Number(env.NYANYA_SEND_MIN_INTERVAL_MS
      || fileCfg.sendMinIntervalMs || 800),
    sendMaxPerMinute: Number(env.NYANYA_SEND_MAX_PER_MINUTE
      || fileCfg.sendMaxPerMinute || 30),
    offlineCap: Number(env.NYANYA_OFFLINE_CAP || fileCfg.offlineCap || 200),
    traceProtocol: env.NYANYA_TRACE_PROTOCOL === '1' || fileCfg.traceProtocol === true,

    // 管理页（默认仅本机）
    adminHost: env.NYANYA_ADMIN_HOST || fileCfg.adminHost || '127.0.0.1',
    adminPort: Number(env.NYANYA_ADMIN_PORT || fileCfg.adminPort || 13980),
    adminToken: env.NYANYA_ADMIN_TOKEN || fileCfg.adminToken || '',

    // 媒体/手机 WAP 服务（降级使用，图片语音只存本地不上传真实 QQ）
    mobileHost: env.NYANYA_MOBILE_HOST || fileCfg.mobileHost || '0.0.0.0',
    mobilePort: Number(env.NYANYA_MOBILE_PORT || fileCfg.mobilePort || 13981),

    log: console
  };
  if (overrides) Object.assign(config, overrides);
  return config;
}

module.exports = { loadConfig };
