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
    // 登录后回放群聊历史：老客户端的群窗口只在内存里存消息（不落盘、上限 20 条），
    // 退出即清空；只有私聊会写到本机 RMS。开启后，客户端群接收状态就绪时，把网关
    // 记录的最近 replayGroupHistoryLimit 条群消息当普通群消息补推一遍，群窗口一
    // 打开就有内容。代价：这些消息在客户端看来是新消息（未读/可能提示音）。
    replayGroupHistoryOnLogin: booleanSetting(
      env.NYANYA_REPLAY_GROUP_HISTORY, fileCfg.replayGroupHistoryOnLogin, false),
    replayGroupHistoryLimit: Number(env.NYANYA_REPLAY_GROUP_HISTORY_LIMIT
      || fileCfg.replayGroupHistoryLimit || 10),
    // 回放延迟：客户端刚上报订阅清单时可能还在初始化群列表，太快推会被它丢掉。
    replayGroupHistoryDelayMs: Number(env.NYANYA_REPLAY_GROUP_HISTORY_DELAY_MS
      || (fileCfg.replayGroupHistoryDelayMs === undefined
        ? 1200 : fileCfg.replayGroupHistoryDelayMs)),
    // 登录后回放私聊历史：私聊窗口读的是本机 RMS，又没有「拉服务器历史」的菜单
    // （群里那个「群聊天记录」是客户端专有的）。开启后，客户端登录就绪时把网关
    // 记录的最近 replayPrivateHistoryLimit 条私聊消息（对方发的）当普通私聊消息
    // 补推一遍，私聊窗口一打开就有内容。代价：客户端看来是新消息（未读/可能提示音），
    // 并会写进本机记录。
    replayPrivateHistoryOnLogin: booleanSetting(
      env.NYANYA_REPLAY_PRIVATE_HISTORY, fileCfg.replayPrivateHistoryOnLogin, false),
    replayPrivateHistoryLimit: Number(env.NYANYA_REPLAY_PRIVATE_HISTORY_LIMIT
      || fileCfg.replayPrivateHistoryLimit || 10),
    // 回放延迟：客户端登录后还要跑好友/群同步，太快推会被它丢掉。
    replayPrivateHistoryDelayMs: Number(env.NYANYA_REPLAY_PRIVATE_HISTORY_DELAY_MS
      || (fileCfg.replayPrivateHistoryDelayMs === undefined
        ? 1500 : fileCfg.replayPrivateHistoryDelayMs)),
    // 回放水位有效期（毫秒）：水位 = 每个会话「上次回放到哪条消息 id」，只推增量，
    // 避免客户端掉线重连时把看过的历史又推一遍（详见 core/replay-cursor.js）。
    // 水位存在网关内存里；超过这个时间没动过就作废，下次重新全量喂一遍——
    // 因为「客户端重启」和「掉线重连」在协议上无法区分，隔久了就当它重启过。
    // 0 或负数 = 永不过期（水位只随网关进程结束而清空）。
    replayCursorTtlMs: Number(env.NYANYA_REPLAY_CURSOR_TTL_MS
      || (fileCfg.replayCursorTtlMs === undefined
        ? 600000 : fileCfg.replayCursorTtlMs)),
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
    // 收到 NapCat 图片时，推给老客户端的链接里用的主机。留空则自动探测局域网 IP；
    // 多网卡（VMware/虚拟网卡）可能挑错，这时在这里写死手机能访问的那个 IP。
    mediaPublicHost: env.NYANYA_MEDIA_PUBLIC_HOST || fileCfg.mediaPublicHost || '',
    // 登录响应报文里回给客户端的网关 IP（协议字段固定 4 字节，见 legacy/protocol.js
    // 的 ipv4ToBuffer）。留空则自动探测局域网 IP；服务器上带 docker0 等虚拟网卡时
    // 可能探到 172.x/10.x 内网地址，这时在这里写死手机能访问的那个 IP。
    // 只接受 IPv4 点分字面量，填域名或 IPv6 会被忽略并回退到自动探测。
    loginPublicHost: env.NYANYA_LOGIN_PUBLIC_HOST || fileCfg.loginPublicHost || '',

    log: console
  };
  if (overrides) Object.assign(config, overrides);
  return config;
}

module.exports = { loadConfig };
