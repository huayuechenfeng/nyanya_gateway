'use strict';

// 回放水位：记住每个「账号 + 会话」最后回放到哪条消息 id，下次只推增量。
//
// 为什么需要：老客户端掉线会自己重连，而重连在协议上等于重新走一遍登录——
// 网关就会把「登录后回放历史」再做一次。于是已经看过的消息又被当成新消息推一遍。
// 2026-09-20 现场：加好友时 QQ 自动发的那句「我们已成功添加为好友…」落进了私聊
// 记录，每次重连都被重推，看着像「加好友通知在隔一段时间重复发」。
//
// 为什么存在内存里、不落库：水位的语义是「这台设备已经看过哪些消息」，而设备侧的
// 容器本来就随客户端进程消失（群窗口是内存列表 hq.java、私聊虽写本机 RMS 但没有
// 「拉服务器历史」的入口）。如果落库，客户端重启后网关仍然以为「都推过了」，
// 反而再也给不出历史。放在网关进程内存里，重启网关 = 重新喂一遍，正好对应
// 「网关重启时客户端通常也跟着重启」这个常见搭配。
//
// 关于 TTL：客户端重启和掉线重连，在协议层长得一模一样（都是新 TCP 连接 + 完整登录），
// 没有可靠信号能区分。所以给水位加一个过期时间做折中：
//   - 短时间内重连  → 视为同一台设备，只推增量（不再重复轰炸）；
//   - 隔得久了      → 视为设备可能已经重启过（群窗口本来就空了），重新全量喂一遍。
// ttlMs <= 0 表示永不过期（水位只随网关进程结束而清空）。

const DEFAULT_TTL_MS = 600000; // 10 分钟

function createReplayCursors(options) {
  const settings = options || {};
  const requested = Number(settings.ttlMs);
  const ttlMs = Number.isFinite(requested) ? requested : DEFAULT_TTL_MS;
  const now = typeof settings.now === 'function' ? settings.now : Date.now;
  const entries = new Map();
  return {
    // 取水位；已过期就当作没有（顺便丢掉，避免 Map 无限增长）。
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (ttlMs > 0 && now() - entry.at >= ttlMs) {
        entries.delete(key);
        return null;
      }
      return entry;
    },
    // 记录水位。afterId 是这次真正推出去的最后一消息 id。
    set(key, afterId) {
      entries.set(key, { afterId: Math.max(0, Number(afterId) || 0), at: now() });
    },
    size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}

// 会话键：私聊按对端好友，群聊按群。都带上账号，换号（NapCat 换 self_id）不串水位。
function privateCursorKey(uin, peerUin) {
  return `private:${Number(uin)}:${Number(peerUin)}`;
}

function groupCursorKey(uin, groupId) {
  return `group:${Number(uin)}:${Number(groupId)}`;
}

module.exports = { DEFAULT_TTL_MS, createReplayCursors, privateCursorKey, groupCursorKey };
