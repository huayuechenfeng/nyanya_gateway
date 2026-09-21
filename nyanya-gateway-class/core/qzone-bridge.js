'use strict';

const http = require('node:http');

// qzone-bridge 是独立部署的第三方服务（家里 D:\AIProject\QQ2011\qzone-bridge，监听 127.0.0.1:5700），
// 通过 frp 映射到服务器本地 5700。这里封装对它的 OneBot HTTP API 调用。
// 只做「看自己说说列表」这一个需求；发说说仍走 NapCat 的 send_qzone_msg
// （第一期已在 napcat-backend.js 实现）。
//
// qzone-bridge 的 HTTP 约定：action 放在 URL 路径（POST /<action>），params 放
// JSON body。返回 { status, retcode, data: { msglist, has_more, next_cursor } }。
//
// 关键坑（2026-09-21 实测）：NapCat 发说说走 taotao 的 emotion_cgi_publish_v6，
// 而 qzone-bridge 的 get_emotion_list 走 feeds3 的「个人主页时间线（scope=1）」——
// 这个流读不到最新发的（有延迟/不同步），只能读到老说说。真正实时的是
// get_friend_feeds（好友动态流 scope=0），刚发的说说立刻在里面。所以这里用
// 「双数据源合并」：get_friend_feeds 过滤 opuin=selfId 拿最新 + get_emotion_list
// 拿历史，按 tid 去重、按时间倒序。
function createQzoneBridge(options) {
  const baseUrl = String(options.baseUrl || 'http://127.0.0.1:5700').replace(/\/+$/, '');
  const timeoutMs = Number(options.timeoutMs || 20000);
  const logger = options.logger || (() => {});
  let cachedSelfId = null;

  function call(action, params) {
    return new Promise((resolve) => {
      const payload = JSON.stringify(params || {});
      let target;
      try {
        target = new URL(action, `${baseUrl}/`);
      } catch {
        resolve({ ok: false, error: 'qzone-bridge 地址配置错误' });
        return;
      }
      const req = http.request({
        host: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ ok: false, error: 'qzone-bridge 返回非 JSON' });
          }
        });
      });
      req.on('error', (err) => {
        resolve({ ok: false, error: `qzone-bridge 不可达: ${err.message}` });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: 'qzone-bridge 请求超时' });
      });
      req.write(payload);
      req.end();
    });
  }

  // 拿当前登录号（selfId）。/status 返回 { ok, qq: "2948126361", ... }，缓存一次。
  async function getSelfId() {
    if (cachedSelfId) return cachedSelfId;
    const resp = await call('/status', {});
    if (resp && resp.ok && resp.qq) {
      cachedSelfId = String(resp.qq);
      return cachedSelfId;
    }
    return '';
  }

  // 把 qzone-bridge 返回的说说条目统一成 { tid, content, time, cmtnum, likenum }。
  function normalizePost(m) {
    return {
      tid: String(m.tid || ''),
      content: String(m.content || '').trim(),
      time: String(m.createTime2 || m.createTime || ''),
      cmtnum: Number(m.cmtnum || 0),
      likenum: Number(m.likenum || 0),
    };
  }

  // 拉「个人主页时间线」说说列表（scope=1，含历史，但读不到最新发的）。
  // feeds3 接口偶发 0103「网络繁忙」限流，带重试。
  async function getEmotionList(params) {
    const p = Object.assign({ num: 50 }, params || {});
    let lastError = '未知错误';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const resp = await call('/get_emotion_list', p);
      if (resp && resp.status === 'ok' && resp.retcode === 0 && resp.data) {
        const list = Array.isArray(resp.data.msglist) ? resp.data.msglist : [];
        // 过滤空内容的噪声条目（如 LikeTipsFeeds 点赞提示，content 为空）。
        const posts = list.map(normalizePost).filter((m) => m.content.length > 0);
        return {
          ok: true,
          posts,
          hasMore: !!resp.data.has_more,
          nextCursor: resp.data.next_cursor || '',
        };
      }
      lastError = (resp && (resp.message || (resp.data && resp.data.message))) || lastError;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    logger({ event: 'qzone_list_failed', message: lastError });
    return { ok: false, error: lastError };
  }

  // 拉「好友动态流」（scope=0，实时，含刚发的）原始条目。每条带 opuin（动态作者）、
  // uin、content、createTime2 等。返回原始 items，由调用方按 opuin 过滤。
  async function getFriendFeeds(params) {
    const p = Object.assign({ num: 50, fast_mode: false }, params || {});
    const resp = await call('/get_friend_feeds', p);
    if (resp && resp.status === 'ok' && resp.data) {
      return {
        ok: true,
        items: Array.isArray(resp.data.msglist) ? resp.data.msglist : [],
        hasMore: !!resp.data.has_more,
        nextCursor: resp.data.next_cursor || '',
      };
    }
    const err = (resp && (resp.message || (resp.data && resp.data.message))) || '好友动态流拉取失败';
    return { ok: false, error: err };
  }

  // 看自己说说列表（第二期主入口）。双数据源合并：
  //   - get_friend_feeds 过滤 opuin=selfId → 最新（含刚发的）
  //   - get_emotion_list(user_id=selfId) → 历史（老说说）
  // 按 tid 去重、按时间倒序。
  async function getMyPosts(params) {
    const num = Math.max(1, Math.min(100, Number((params && params.num) || 50)));
    const selfId = await getSelfId();

    const posts = [];
    const seen = new Set();
    let feedsOk = false;
    let histOk = false;

    // 1. 好友动态流：实时，含刚发的。按 opuin 过滤出「自己发的」。
    const feeds = await getFriendFeeds({ num });
    if (feeds.ok) {
      feedsOk = true;
      for (const m of feeds.items) {
        if (String(m.opuin || m.uin || '') !== String(selfId)) continue;
        const p = normalizePost(m);
        if (!p.content || seen.has(p.tid)) continue;
        seen.add(p.tid);
        posts.push(p);
      }
    }

    // 2. 个人主页时间线：历史老说说。
    const hist = await getEmotionList({ user_id: selfId || undefined, num });
    if (hist.ok) {
      histOk = true;
      for (const p of hist.posts) {
        if (seen.has(p.tid)) continue;
        seen.add(p.tid);
        posts.push(p);
      }
    }

    if (!feedsOk && !histOk) {
      const err = (feeds.error || hist.error || 'qzone-bridge 列表拉取失败');
      logger({ event: 'qzone_list_failed', message: err });
      return { ok: false, error: err };
    }

    // createTime2 是 "YYYY-MM-DD HH:mm"，字典序即时间序，倒序排。
    posts.sort((a, b) => String(b.time).localeCompare(String(a.time)));

    return { ok: true, posts, hasMore: false, nextCursor: '' };
  }

  // 好友动态流条目：{ tid, content, time, cmtnum, likenum, nickname, uin }。
  // 相比 normalizePost 多了作者昵称/uin，供「好友动态」页显示是谁发的。
  function normalizeFriendPost(m) {
    const clean = (v) => String(v || '')
      .replace(/\\t/g, ' ')
      .replace(/\\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      tid: String(m.tid || ''),
      content: clean(m.content),
      time: String(m.createTime2 || m.createTime || ''),
      cmtnum: Number(m.cmtnum || 0),
      likenum: Number(m.likenum || 0),
      nickname: clean(m.nickname),
      uin: String(m.opuin || m.uin || ''),
    };
  }

  // 好友动态流：get_friend_feeds 实时流里过滤掉「自己发的」（自己的走 getMyPosts），
  // 按时间倒序。作者昵称来自 feeds3 解析的 nickname 字段。
  async function getFriendFeedList(params) {
    const num = Math.max(1, Math.min(100, Number((params && params.num) || 50)));
    const selfId = await getSelfId();
    const feeds = await getFriendFeeds({ num });
    if (!feeds.ok) return feeds;

    const posts = [];
    const seen = new Set();
    for (const m of feeds.items) {
      const p = normalizeFriendPost(m);
      if (!p.content || seen.has(p.tid)) continue;
      // 排除自己发的（自己的说说在「我的说说」列表里）。
      if (selfId && p.uin === selfId) continue;
      seen.add(p.tid);
      posts.push(p);
    }

    // createTime2 是 "YYYY-MM-DD HH:mm"，字典序即时间序，倒序排。
    posts.sort((a, b) => String(b.time).localeCompare(String(a.time)));

    return { ok: true, posts, hasMore: feeds.hasMore, nextCursor: feeds.nextCursor };
  }

  // 评论条目统一成 { name, content, time, isReply }。评论里的 $ 由展示层转义。
  function normalizeComment(c) {
    const ts = Number(c.createtime || c.createTime || c.time || 0);
    let time = '';
    if (ts > 0) {
      const d = new Date(ts < 1e12 ? ts * 1000 : ts);
      time = d.toISOString().replace('T', ' ').slice(0, 16);
    }
    // feeds3 解析的评论 name/content 常带 HTML 缩进残留：既可能是真实 tab/换行，
    // 也可能是被转成字面 `\t`/`\n` 的转义序列，统一压成单个空格。
    const clean = (v) => String(v || '')
      .replace(/\\t/g, ' ')
      .replace(/\\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      name: clean(c.name || c.nickname || c.uin),
      content: clean(c.content),
      time,
      isReply: !!c.is_reply,
    };
  }

  // 看某条说说的评论列表。get_comment_list 在 qzone-bridge 里走 feeds3 解析 + 缓存，
  // 返回的 commentlist 里每条是 { name, content, createtime, is_reply, ... }。
  async function getComments(tid, params) {
    const tidStr = String(tid || '');
    if (!tidStr) return { ok: false, error: '缺少说说编号' };
    const num = Math.max(1, Math.min(100, Number((params && params.num) || 30)));
    const resp = await call('/get_comment_list', { tid: tidStr, num });
    if (resp && resp.status === 'ok' && resp.retcode === 0 && resp.data) {
      const list = resp.data.commentlist || resp.data.comment_list
        || resp.data.comments || resp.data.data || [];
      const comments = (Array.isArray(list) ? list : []).map(normalizeComment);
      return { ok: true, comments };
    }
    const err = (resp && (resp.message || (resp.data && resp.data.message))) || '评论列表拉取失败';
    logger({ event: 'qzone_comments_failed', message: err });
    return { ok: false, error: err };
  }

  // 点赞。qzone-bridge 的 send_like 内部会用 postMetaCache 补全 ouin/abstime，
  // 而 postMetaCache 在刚才 getMyPosts 调 get_friend_feeds 时已经填充过。
  async function sendLike(tid) {
    const tidStr = String(tid || '');
    if (!tidStr) return { ok: false, error: '缺少说说编号' };
    const resp = await call('/send_like', { tid: tidStr });
    if (resp && resp.status === 'ok' && resp.retcode === 0) {
      return { ok: true };
    }
    const err = (resp && (resp.message || (resp.data && resp.data.message))) || '点赞失败';
    logger({ event: 'qzone_like_failed', message: err });
    return { ok: false, error: err };
  }

  // 发评论。
  async function sendComment(tid, content) {
    const tidStr = String(tid || '');
    const text = String(content || '').trim();
    if (!tidStr) return { ok: false, error: '缺少说说编号' };
    if (!text) return { ok: false, error: '评论内容不能为空' };
    const resp = await call('/send_comment', { tid: tidStr, content: text });
    if (resp && resp.status === 'ok' && resp.retcode === 0) {
      return { ok: true, commentId: (resp.data && resp.data.comment_id) || undefined };
    }
    const err = (resp && (resp.message || (resp.data && resp.data.message))) || '评论失败';
    logger({ event: 'qzone_comment_failed', message: err });
    return { ok: false, error: err };
  }

  return { getEmotionList, getFriendFeeds, getMyPosts, getFriendFeedList, getComments, sendLike, sendComment };
}

module.exports = { createQzoneBridge };
