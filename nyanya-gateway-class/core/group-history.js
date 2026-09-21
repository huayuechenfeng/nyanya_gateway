'use strict';

// 群聊历史回放。
//
// 老客户端的群窗口只在内存里存消息：hq.java 收到群消息只做
// `insertElementAt(bl, 0)`（上限 20 条），整个类没有一处写 RMS，退出即清空。
// 只有私聊会落到本机 RMS（qq_rms_history，上限 300 条），所以重启后私聊窗口
// 有记录、群窗口空白。
//
// 网关这边是落库的（store.groupMessages），所以「客户端群接收状态就绪」时，
// 把网关记录的最近若干条当普通群消息补推一遍，群窗口一打开就有内容。
//
// 代价：这些消息在客户端看来和刚收到的新消息没有区别（未读标记/可能提示音），
// 而且仍在内存里。默认关闭，由 config 开关控制。
//
// 水位（settings.cursors，见 core/replay-cursor.js）：客户端掉线重连等于重新登录一遍，
// 没有水位时每次都会把最近 limit 条重推。接上水位后只推「上次之后的新消息」。

const { groupCursorKey } = require('./replay-cursor');

// 与 legacy/protocol.js 的 GROUP_IMAGE_PLACEHOLDER 一致：客户端会把正文里的
// 这个占位符按顺序替换成它自己渲染的图片块（ime/im 的 0x15 块）。
const IMAGE_PLACEHOLDER = '\u005b\u56fe\u7247\u005d'; // [图片]

// core/napcat-backend.js 的 applyMediaLinks 把群图片正文写成「【图片】<WAP 链接>」，
// 链接里带 media id。回放时抠出来还原成图片块，让历史图片消息和实时收到的
// 形态一致（气泡可点，点开是看图页）。
// 注意 [^\s【]：一条消息里有多个图片时，URL 后面紧跟下一个「【图片】」，
// 用 \S+ 会把两块黏成一条长链接。
const IMAGE_LINK_PATTERN = /【图片】[ \t]*(https?:\/\/[^\s【]+)/g;
const MEDIA_ID_PATTERN = /[?&]fileid=([^&\s]+)/;

// 把「【图片】<链接>」还原成图片块参数：images 是 media id 列表，
// imageText 是占位符版本的正文。没有图片时 images 为空、imageText 就是原文。
function parseHistoricalMedia(text) {
  const source = String(text == null ? '' : text);
  const images = [];
  if (source.indexOf('【图片】') < 0) return { images, imageText: source };
  const imageText = source.replace(IMAGE_LINK_PATTERN, (match, link) => {
    const found = MEDIA_ID_PATTERN.exec(link);
    if (!found) return match;
    let id = found[1];
    try {
      id = decodeURIComponent(id);
    } catch (error) {
      // 转义坏了就按原样用：宁可 id 差一点，也别把整条消息丢掉。
    }
    images.push(id);
    return IMAGE_PLACEHOLDER;
  });
  return { images, imageText };
}

// 把 store 里记录的群聊历史逐条交给 deliverGroup（每条消息一次，保持原发送者）。
// groupReceiveFilter 是该会话当前订阅的群（客户端 0x0070 / 0x008C 上报）；
// 不在清单里的群推了也会被 deliverGroup 拦掉，索性提前跳过，省一次遍历。
function replayGroupHistory(options) {
  const settings = options || {};
  const report = {
    groups: 0, messages: 0, delivered: 0, skippedGroups: 0, resumed: 0, fresh: 0,
  };
  const store = settings.store;
  const deliverGroup = settings.deliverGroup;
  const cursors = settings.cursors || null;
  const uin = Number(settings.uin);
  if (!store || typeof deliverGroup !== 'function' || !uin) return report;
  const limit = Math.max(1, Math.min(50, Number(settings.limit) || 10));
  const filter = settings.groupReceiveFilter || null;
  for (const group of store.groupsOf(uin)) {
    if (filter && !filter.has(Number(group.publicId))
        && !filter.has(Number(group.id))) {
      report.skippedGroups += 1;
      continue;
    }
    // 不订阅的群不推进水位：下次订阅了就按老水位把这段补上。
    const key = cursors ? groupCursorKey(uin, group.id) : null;
    const cursor = key ? cursors.get(key) : null;
    // 只在接了水位时才统计「这轮是增量还是全量」，没接水位的调用不该在这里留痕。
    if (cursors) {
      if (cursor) report.resumed += 1; else report.fresh += 1;
    }
    const rows = store.recentGroupMessages(group.id, limit, cursor ? cursor.afterId : 0);
    if (rows.length === 0) continue;
    report.groups += 1;
    let advanced = 0;
    for (const message of rows) {
      advanced = Math.max(advanced, Number(message.id) || 0);
      const media = parseHistoricalMedia(message.text);
      const sentAt = Date.parse(message.sentAt);
      const result = deliverGroup(group.id, message.from, message.text, {
        triggerVirtual: false,
        replay: settings.reason || 'group_history',
        images: media.images,
        imageText: media.imageText,
        timestamp: Number.isFinite(sentAt) ? Math.floor(sentAt / 1000) : undefined,
      });
      report.messages += 1;
      if (result && result.delivered) report.delivered += result.delivered;
    }
    // 同私聊：读到就推进，避免同一批记录在每轮空转里反复重读。
    if (key && advanced > 0) cursors.set(key, advanced);
  }
  return report;
}

module.exports = { IMAGE_PLACEHOLDER, parseHistoricalMedia, replayGroupHistory };
