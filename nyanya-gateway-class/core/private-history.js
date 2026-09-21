'use strict';

// 私聊历史回放。
//
// 群聊和私聊在老客户端里行为正好相反：
//   - 群窗口只把消息放内存（hq.java，上限 20 条），不落盘、退出即空 —— 见 core/group-history.js；
//   - 私聊会写本机 RMS（qq_rms_history），但那只记得住「客户端自己在线的那些时刻收到的」，
//     而且实测里窗口可能读得到记录却渲染不出来（2026-09-20 现场：本机 RMS 有 20 条
//     属于某好友的记录、客户端登录时也确实读了，私聊窗口却是空白）。私聊窗口也没有
//     「拉服务器历史」的菜单，只有「清除记录」（群里那个「群聊天记录」是客户端专有的）。
//
// 所以这里沿用群回放的思路：客户端登录就绪后，把网关记录的私聊历史当普通私聊消息
// 补推一遍。客户端收到即显示，等于把历史重新「喂」进它的会话。
//
// 只回放「对方发的」：0x0056 的载荷只有发送者 uin、没有接收者，客户端只能靠 from
// 决定落到哪个会话；from 若是自己，它无从判断目标会话，所以自己发的不回放
// （那些本来也由客户端发送时自己写进本机记录）。对应 store.incomingPrivateMessages。
//
// 代价：这些消息在客户端看来是新消息（未读标记/可能提示音），并且会被写进本机 RMS。
// 默认关闭，由 config 开关控制。
//
// 水位（settings.cursors，见 core/replay-cursor.js）：客户端掉线会自己重连，重连等于
// 重新登录一遍，回放就会把看过的消息再推一次。接上水位后只推「上次之后的新消息」；
// 水位缺失（首次登录、网关刚重启、水位过期）时才读最近 limit 条。

const { privateCursorKey } = require('./replay-cursor');

// 把 store 里记录的私聊历史逐条交给 deliverText（每条消息一次，保持原发送者）。
// deliverText(fromUin, toUin, text, subtype, reason) 是 legacy 层的推送入口，
// toUin 固定为本账号（它据此找会话）。
function replayPrivateHistory(options) {
  const settings = options || {};
  const report = { peers: 0, messages: 0, delivered: 0, resumed: 0, fresh: 0 };
  const store = settings.store;
  const deliverText = settings.deliverText;
  const cursors = settings.cursors || null;
  const uin = Number(settings.uin);
  if (!store || typeof deliverText !== 'function' || !uin) return report;
  const limit = Math.max(1, Math.min(50, Number(settings.limit) || 10));
  const reason = settings.reason || 'private_history';
  const peers = typeof store.privateConversations === 'function'
    ? store.privateConversations(uin) : [];
  for (const peer of peers) {
    const key = cursors ? privateCursorKey(uin, peer) : null;
    const cursor = key ? cursors.get(key) : null;
    // 只在接了水位时才统计「这轮是增量还是全量」，没接水位的调用不该在这里留痕。
    if (cursors) {
      if (cursor) report.resumed += 1; else report.fresh += 1;
    }
    const rows = typeof store.incomingPrivateMessages === 'function'
      ? store.incomingPrivateMessages(uin, peer, limit, cursor ? cursor.afterId : 0) : [];
    if (rows.length === 0) continue;
    report.peers += 1;
    // 水位推进到本次「读到」的最后一条，而不是「推出去」的最后一条：
    // 万一有整条被跳过的情况，也不会让同一批记录每轮重读一遍。
    let advanced = 0;
    for (const message of rows) {
      advanced = Math.max(advanced, Number(message.id) || 0);
      // 双保险：自己发的绝不回放（见文件头说明）。
      if (Number(message.from) === uin) continue;
      report.messages += 1;
      if (deliverText(message.from, uin, message.text, 9, reason)) report.delivered += 1;
    }
    // 只有真的推了才推进水位：这一轮没新消息时留着旧水位，
    // 下次重连仍按增量读（否则每轮空转都会把窗口重新撑满）。
    if (key && advanced > 0) cursors.set(key, advanced);
  }
  return report;
}

module.exports = { replayPrivateHistory };
