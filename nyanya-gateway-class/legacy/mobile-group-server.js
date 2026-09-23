'use strict';

const http = require('node:http');
const { digestPassword } = require('./store');

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sendHtml(response, status, title, content) {
  const body = Buffer.from(`<!DOCTYPE html><html><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(title)}</title><style>`
    + 'body{font-family:sans-serif;margin:10px;line-height:1.5}fieldset{margin:10px 0}'
    + 'label{display:block;margin:6px 0}input{max-width:95%}.ok{color:#063}.err{color:#900}'
    + '</style></head><body><h2>私服群聊管理</h2>'
    + '<p><a href="/mobile/groups">首页</a> | '
    + '<a href="/mobile/groups?mode=create">创建群</a> | '
    + '<a href="/mobile/groups?mode=search">查找/加入群</a></p>'
    + content + '<hr><small>仅用于当前私服。密码通过局域网 HTTP 发送，请只在可信 Wi-Fi 使用。</small>'
    + '</body></html>', 'utf8');
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

// 这份 QQ2011 的内置浏览器是**纯 WML 浏览器**：Accept 只有
// `text/vnd.wap.wml,image/*,audio/*,...`，拿到 text/html 会直接弹自己的错误页
// 「错误代码 005 / 页面类型暂不支持」（iw.class，反编译后 iw.java:2018-2024 里
// 对 text/html 显式调用 I() 生成 005）。所以这里按 Accept 协商：
//   老手机 -> text/vnd.wap.wml（WML 1.1，<img> 在它的词法表 ef.java:260 里）
//   PC 浏览器 -> 原来的 HTML
const WML_HEAD = '<?xml version="1.0" encoding="utf-8"?>'
  + '<!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN" "http://www.wapforum.org/DTD/wml_1.1.xml">';

function wantsWml(request) {
  return /text\/vnd\.wap\.wml/i.test(String(request.headers.accept || ''));
}

function sendWml(response, status, title, content) {
  const body = Buffer.from(`${WML_HEAD}<wml><card id="c" title="${escapeHtml(title)}">`
    + `${content}</card></wml>`, 'utf8');
  response.writeHead(status, {
    'content-type': 'text/vnd.wap.wml; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

// 同一份内容按客户端能力二选一，省得每个分支都写两遍。
function sendPage(request, response, status, title, html, wml) {
  if (wantsWml(request)) sendWml(response, status, title, wml);
  else sendHtml(response, status, title, html);
}

function sendMedia(response, media, download) {
  const disposition = download ? 'attachment' : 'inline';
  response.writeHead(200, {
    'content-type': media.mimeType,
    'content-length': media.content.length,
    'content-disposition': `${disposition}; filename="${String(media.filename || 'media.bin').replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')}"`,
    'cache-control': 'private, max-age=86400',
    'x-content-type-options': 'nosniff',
  });
  response.end(media.content);
}

function mediaPage(media, base) {
  // 老 WAP 浏览器对根相对路径支持不稳定，能取到 Host 时一律拼绝对地址。
  const raw = `${base || ''}/mobile/media/${encodeURIComponent(media.id)}/raw`;
  if (media.mediaType === 2) {
    return `<p><img src="${raw}" alt="${escapeHtml(media.filename)}" style="max-width:100%"></p>`
      + `<p><a href="${raw}?download=1">下载原图</a></p>`;
  }
  if (media.mediaType === 3) {
    return `<p>语音：${escapeHtml(media.filename)}（${media.size} 字节）</p>`
      + `<p><a href="${raw}">播放或下载 AMR 语音</a></p>`;
  }
  return `<p><a href="${raw}?download=1">下载 ${escapeHtml(media.filename)}</a></p>`;
}

// WML 版看图卡片。用 <img> 让内置浏览器自己去拉原图（WML 1.1 的 <img> 支持
// src/alt/align/vspace/hspace，都在客户端的 WML 词法表里）。
function mediaCardWml(media, base) {
  const raw = `${base}/mobile/media/${encodeURIComponent(media.id)}/raw`;
  if (media.mediaType === 2) {
    // alt 留空：老客户端会把 alt 文本当正文渲染出来（哪怕图片能显示），
    // 而 WML 1.1 的 <img> 又要求 alt 属性必须存在，所以给空串、不删属性。
    return `<p align="center"><img src="${escapeHtml(raw)}" alt="" vspace="4"/></p>`
      + `<p><a href="${escapeHtml(raw)}">查看原图</a></p>`;
  }
  if (media.mediaType === 3) {
    return `<p>语音：${escapeHtml(media.filename)}（${media.size} 字节）</p>`
      + `<p><a href="${escapeHtml(raw)}">播放或下载</a></p>`;
  }
  return `<p><a href="${escapeHtml(raw)}?download=1">下载 ${escapeHtml(media.filename)}</a></p>`;
}

// WML 里 `$` 是变量引用（客户端 iw.java:1420 会去搜 `$变量名`），正文里出现 `$`
// 可能被当变量替换掉。按 WML 1.1 规定转义成 `$$`。
function escapeWml(value) {
  return escapeHtml(value).replace(/\$/g, '$$$$');
}

// WML 单页最多列这么多条记录：老浏览器的页面解析和内存都很紧。
const WML_HISTORY_LIMIT = 20;

// 群聊天记录（HTML 版，PC 调试用）。
function groupHistoryHtml(rows, store) {
  if (!rows.length) return '<p>还没有群聊天记录。</p>';
  return '<ul>' + rows.map((message) => {
    const account = store.get(message.from);
    return `<li><b>${escapeHtml(account ? account.nickname : message.from)}</b>：`
      + `${escapeHtml(message.text)}</li>`;
  }).join('') + '</ul>';
}

// 消息正文里可能嵌着网关自己拼的图片链接（napcat-backend 的 applyMediaLinks），
// 在 WML 里直接铺开会糊一大串 URL，所以把它转成可点的 <a>。
const MEDIA_TEXT_LINK = /^(.*?)【图片】(https?:\/\/\S+)(.*)$/;

function renderWmlText(value) {
  const text = String(value === undefined || value === null ? '' : value);
  const match = text.match(MEDIA_TEXT_LINK);
  if (!match) return escapeWml(text);
  return `${escapeWml(match[1])}<a href="${escapeWml(match[2])}">【图片】</a>`
    + escapeWml(match[3]);
}

// 群聊天记录（WML 版）。手机端菜单「群聊天记录」走的是
// forward.jsp?bid=202&groupID=<群id>&fqq=<自己QQ号>（ee.java:1106 <- b.java case 10），
// 标题在客户端里写死成「群聊天记录」，所以这一页就得给记录；而手机只吃 WML。
// WML 1.1 没有 ul/li/b，客户端词法表（ef.java:260）只有 p/br/a，所以拼纯文本行。
function groupHistoryWml(rows, store) {
  if (!rows.length) return '<p>还没有群聊天记录。</p>';
  const shown = rows.slice(-WML_HISTORY_LIMIT).reverse();
  const lines = shown.map((message) => {
    const account = store.get(message.from);
    const who = account ? account.nickname : String(message.from);
    return `<p>${escapeWml(who)}：${renderWmlText(message.text)}</p>`;
  });
  const head = rows.length > shown.length
    ? `<p>共 ${rows.length} 条，显示最近 ${shown.length} 条</p>` : '';
  return head + lines.join('');
}

// QQ 空间「发说说」表单。老客户端 WML 词法表（ef.java:260）里有 input/postfield/
// anchor/go/setvar，手机能直接打字提交；HTML 版给 PC 调试用。NapCat 只提供
// send_qzone_msg（发文字说说），没有获取列表接口，所以这里只做「发」。
function qzonePostHtml() {
  return '<fieldset><legend>发一条说说</legend><form method="post" action="/forward.jsp?bid=33">'
    + '<label>说说内容：<input name="content" maxlength="500" required></label>'
    + '<input type="submit" value="发表"></form></fieldset>';
}

function qzonePostWml() {
  return '<p>发一条说说：</p>'
    + '<p><input name="content" maxlength="500" emptyok="false"/></p>'
    + '<p><anchor>发表<go href="/forward.jsp?bid=33" method="post">'
    + '<postfield name="content" value="$content"/></go></anchor></p>';
}

// 说说详情/操作链接。tid 与正文放进 query；content 用 encodeURIComponent 编码，
// 编码结果不含裸 & 或 $，放进 href 安全；& 参数分隔符按 HTML/WML 转义成 &amp;。
function qzoneDetailHref(tid, content) {
  return `/forward.jsp?bid=33&amp;action=detail&amp;tid=${encodeURIComponent(tid)}&amp;content=${encodeURIComponent(content)}`;
}
function qzoneActionHref(action, tid, content) {
  return `/forward.jsp?bid=33&amp;action=${action}&amp;tid=${encodeURIComponent(tid)}&amp;content=${encodeURIComponent(content)}`;
}

// 说说列表（HTML 版，PC 调试用）。每条正文可点进详情页。
function qzoneListHtml(posts) {
  if (!posts.length) return '<p>还没有发过说说。</p>';
  return '<ul>' + posts.map((p) => `<li><b>${escapeHtml(p.time)}</b> `
    + `<a href="${qzoneDetailHref(p.tid, p.content)}">${escapeHtml(p.content)}</a>`
    + ` <small>（${p.cmtnum}评/${p.likenum}赞）</small></li>`).join('') + '</ul>';
}

// 说说列表（WML 版）。每条一行、正文可点进详情；超出 WML_HISTORY_LIMIT 只显示最近若干条。
function qzoneListWml(posts) {
  if (!posts.length) return '<p>还没有发过说说。</p>';
  const shown = posts.slice(0, WML_HISTORY_LIMIT);
  const lines = shown.map((p) => `<p><a href="${qzoneDetailHref(p.tid, p.content)}">`
    + `${escapeWml(p.time)} ${escapeWml(p.content)}</a></p>`);
  const head = posts.length > shown.length
    ? `<p>共 ${posts.length} 条，显示最近 ${shown.length} 条</p>` : '';
  return head + lines.join('');
}

// 好友动态流（HTML 版）。每条带作者昵称，正文可点进详情。
function qzoneFriendsHtml(posts) {
  if (!posts.length) return '<p>好友还没有新动态。</p>';
  return '<ul>' + posts.map((p) => `<li><b>${escapeHtml(p.nickname || p.uin || '')}</b> `
    + `<a href="${qzoneDetailHref(p.tid, p.content)}">${escapeHtml(p.content)}</a>`
    + ` <small>${escapeHtml(p.time)}（${p.cmtnum}评/${p.likenum}赞）</small></li>`).join('') + '</ul>';
}

// 好友动态流（WML 版）。作者昵称 + 正文 + 时间，正文可点进详情。
function qzoneFriendsWml(posts) {
  if (!posts.length) return '<p>好友还没有新动态。</p>';
  const shown = posts.slice(0, WML_HISTORY_LIMIT);
  const lines = shown.map((p) => `<p><a href="${qzoneDetailHref(p.tid, p.content)}">`
    + `${escapeWml(p.nickname || p.uin || '')}：${escapeWml(p.content)}</a>`
    + `（${escapeWml(p.time)}）</p>`);
  const head = posts.length > shown.length
    ? `<p>共 ${posts.length} 条，显示最近 ${shown.length} 条</p>` : '';
  return head + lines.join('');
}

// 说说空间导航链接（HTML/WML 双份）。href 里的 & 必须转义成 &amp;。
// mode='friends' 时给「我的说说 + 发说说」；缺省（自己列表页）给「发说说 + 好友动态」。
function qzoneNavHtml(mode) {
  const post = '<p><a href="/forward.jsp?bid=33&amp;action=post">发一条说说</a></p>';
  const friends = '<p><a href="/forward.jsp?bid=33&amp;action=friends">好友动态</a></p>';
  const mine = '<p><a href="/forward.jsp?bid=33">我的说说</a></p>';
  return mode === 'friends' ? mine + post : post + friends;
}
function qzoneNavWml(mode) {
  const post = '<p><a href="/forward.jsp?bid=33&amp;action=post">发说说</a></p>';
  const friends = '<p><a href="/forward.jsp?bid=33&amp;action=friends">好友动态</a></p>';
  const mine = '<p><a href="/forward.jsp?bid=33">我的说说</a></p>';
  return mode === 'friends' ? mine + post : post + friends;
}

// ── 说说详情 / 评论 / 点赞 ──────────────────────────

function qzoneCommentsHtml(comments, error) {
  if (error) return `<p class="err">评论加载失败：${escapeHtml(error)}</p>`;
  if (!comments || !comments.length) return '<p>还没有评论。</p>';
  return '<ul>' + comments.map((c) => `<li><b>${escapeHtml(c.name)}</b>：${escapeHtml(c.content)}`
    + (c.time ? ` <small>${escapeHtml(c.time)}</small>` : '') + '</li>').join('') + '</ul>';
}

function qzoneCommentsWml(comments, error) {
  if (error) return `<p>评论加载失败：${escapeWml(error)}</p>`;
  if (!comments || !comments.length) return '<p>还没有评论。</p>';
  return comments.map((c) => `<p>${escapeWml(c.name)}：${escapeWml(c.content)}`
    + (c.time ? `（${escapeWml(c.time)}）` : '') + '</p>').join('');
}

function qzoneDetailHtml(post, comments, error) {
  return `<p>${escapeHtml(post.content)}</p>`
    + '<p><a href="' + qzoneActionHref('like', post.tid, post.content) + '">点赞</a> | '
    + '<a href="' + qzoneActionHref('comment', post.tid, post.content) + '">发评论</a> | '
    + '<a href="/forward.jsp?bid=33">回列表</a></p>'
    + '<fieldset><legend>评论</legend>' + qzoneCommentsHtml(comments, error) + '</fieldset>';
}

function qzoneDetailWml(post, comments, error) {
  return `<p>${escapeWml(post.content)}</p>`
    + '<p><a href="' + qzoneActionHref('like', post.tid, post.content) + '">点赞</a> | '
    + '<a href="' + qzoneActionHref('comment', post.tid, post.content) + '">发评论</a></p>'
    + '<p><a href="/forward.jsp?bid=33">回列表</a></p>'
    + qzoneCommentsWml(comments, error);
}

// 评论表单。pcontent 是原说说正文，提交后用来回详情页显示；$ 等按各自语法转义。
function qzoneCommentHtml(tid, content) {
  return '<fieldset><legend>评论这条说说</legend>'
    + `<p>${escapeHtml(content)}</p>`
    + '<form method="post" action="/forward.jsp?bid=33&amp;action=comment">'
    + `<input type="hidden" name="tid" value="${escapeHtml(tid)}">`
    + `<input type="hidden" name="pcontent" value="${escapeHtml(content)}">`
    + '<label>评论：<input name="content" maxlength="200" required></label>'
    + '<input type="submit" value="提交"></form></fieldset>';
}

function qzoneCommentWml(tid, content) {
  return `<p>${escapeWml(content)}</p>`
    + '<p>评论：<input name="content" maxlength="200" emptyok="false"/></p>'
    + '<p><anchor>提交<go href="/forward.jsp?bid=33&amp;action=comment" method="post">'
    + `<postfield name="tid" value="${escapeWml(tid)}"/>`
    + `<postfield name="pcontent" value="${escapeWml(content)}"/>`
    + '<postfield name="content" value="$content"/></go></anchor></p>';
}

// 群资料 + 成员（WML 版）。
function groupInfoWml(group, store) {
  const lines = group.members.map((member) => {
    const account = store.get(member.uin);
    const who = account ? account.nickname : String(member.uin);
    return `<p>${escapeWml(who)} (${member.uin})`
      + `${member.role === 'owner' ? ' - 群主' : ''}</p>`;
  });
  return `<p>群号 ${group.publicId}，${group.members.length} 人</p>` + lines.join('');
}

// ── 腾讯网 WAP 门户（静态首页）──────────────────────────
// 老客户端内置浏览器点「腾讯网」入口时打开的页面。原腾讯官方 WAP 早已关闭，
// 由网关接管成一个静态门户：栏目导航 + 资讯入口 + 常用 QQ 功能入口。
// 手机端给 WML，PC 端给 HTML，二选一按 Accept 协商。

function tencentPortalNavHtml() {
  const link = (href, label) => `<a href="${href}">${label}</a>`;
  return '<p class="tnav">'
    + link('/forward.jsp?bid=20', '资讯')
    + ' | ' + link('/forward.jsp?bid=0', '聊天')
    + ' | ' + link('/forward.jsp?bid=33', '空间')
    + ' | ' + link('/mobile/groups', '群聊')
    + ' | ' + link('/mobile/groups?mode=search', '建群')
    + '</p>';
}

function tencentPortalNavWml() {
  return '<p><a href="/forward.jsp?bid=20">资讯</a> '
    + '<a href="/forward.jsp?bid=0">聊天</a> '
    + '<a href="/forward.jsp?bid=33">空间</a> '
    + '<a href="/mobile/groups">群聊</a> '
    + '<a href="/mobile/groups?mode=search">建群</a></p>';
}

function tencentPortalHtml() {
  const time = new Date().toLocaleDateString('zh-CN',
    { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  return `<div class="portal"><style>.portal{background:linear-gradient(180deg,#eaf3ff 0%,#f7fbff 60%,#ffffff 100%);min-height:100vh;padding:0 0 24px;margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}.portal *{box-sizing:border-box;margin:0;padding:0}.portal .hero{background:linear-gradient(135deg,#0a6cff 0%,#2b8cff 55%,#6fb6ff 100%);padding:26px 20px 30px;text-align:center;color:#fff;border-radius:0 0 24px 24px;box-shadow:0 4px 18px rgba(10,108,255,.28)}.portal .hero .bird{display:inline-block;font-size:40px;line-height:1;filter:drop-shadow(0 3px 4px rgba(0,0,0,.25))}.portal .hero h2{font-size:26px;font-weight:700;letter-spacing:6px;text-shadow:0 2px 6px rgba(0,0,0,.2)}.portal .hero .slogan{margin-top:6px;font-size:13px;letter-spacing:2px;opacity:.92}.portal .hero .date{margin-top:8px;display:inline-block;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.3);padding:3px 14px;border-radius:999px;font-size:12px}.portal .nav{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;padding:14px 16px}.portal .nav a{display:inline-block;padding:7px 18px;border-radius:999px;background:#fff;color:#0a6cff;border:1px solid #d4e4ff;font-size:14px;font-weight:600;text-decoration:none;box-shadow:0 2px 8px rgba(10,108,255,.08);transition:all .2s}.portal .nav a:hover,.portal .nav a:active{background:#0a6cff;color:#fff;transform:translateY(-1px);box-shadow:0 5px 14px rgba(10,108,255,.3)}.portal .wrap{padding:0 16px;max-width:720px;margin:0 auto}.portal .focus{background:#fff;border-radius:14px;padding:16px 18px;margin:6px 0 16px;box-shadow:0 3px 14px rgba(30,80,160,.08);border-left:5px solid #0a6cff}.portal .focus h3{font-size:15px;color:#0a6cff;margin-bottom:10px;letter-spacing:1px}.portal .focus li{list-style:none;font-size:13.5px;color:#445;padding:7px 0 7px 18px;position:relative;border-bottom:1px dashed #e8f0fb}.portal .focus li:last-child{border-bottom:none}.portal .focus li::before{content:"";position:absolute;left:0;top:13px;width:7px;height:7px;border-radius:50%;background:linear-gradient(135deg,#0a6cff,#6fb6ff)}.portal .focus b{color:#1c2b3a}.portal .card{background:#fff;border-radius:14px;padding:16px 18px;margin:0 0 16px;box-shadow:0 2px 14px rgba(30,80,160,.08)}.portal .card h3{font-size:15px;font-weight:700;color:#1c2b3a;margin-bottom:12px;letter-spacing:1px;display:flex;align-items:center;gap:6px}.portal .card h3::after{content:"";flex:1;height:2px;background:linear-gradient(90deg,rgba(10,108,255,.13),transparent);border-radius:2px;margin-left:6px}.portal ul.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.portal ul.grid li{list-style:none}.portal ul.grid a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:14px 6px;background:#f6f9ff;border:1px solid #e6eefc;border-radius:12px;text-align:center;text-decoration:none;color:#334;font-size:13px;font-weight:500;transition:all .2s}.portal ul.grid a:hover,.portal ul.grid a:active{background:linear-gradient(135deg,#0a6cff,#3b8cff);color:#fff;border-color:transparent;transform:translateY(-2px);box-shadow:0 6px 16px rgba(10,108,255,.28)}.portal ul.grid .ico{font-size:24px;line-height:1}.portal .foot{text-align:center;color:#99a;font-size:12px;padding:18px 0 6px}</style><div class="hero"><span class="bird">🐧</span><h2>腾讯网</h2><div class="slogan">真诚沟通 · 快乐生活</div><div class="date">${escapeHtml(time)}</div></div><div class="nav"><a href="/forward.jsp?bid=20">📰 资讯</a><a href="/forward.jsp?bid=0">💬 聊天</a><a href="/forward.jsp?bid=33">🌟 空间</a><a href="/mobile/groups">👥 群聊</a><a href="/mobile/groups?mode=search">＋ 建群</a></div><div class="wrap"><div class="focus"><h3>▍今日焦点</h3><ul><li><b>手机QQ</b> —— 私服网关全面接入，好友、群聊、空间一网打尽。</li><li><b>群空间</b> —— 回到「群聊」看群资料、查聊天记录与群成员。</li><li><b>我的空间</b> —— 从这里写下说说、看好友动态。</li></ul></div><div class="card"><h3>📡 热门频道</h3><ul class="grid"><li><a href="/forward.jsp?bid=21"><span class="ico">📰</span>新闻头条</a></li><li><a href="/forward.jsp?bid=22"><span class="ico">🎬</span>娱乐八卦</a></li><li><a href="/forward.jsp?bid=23"><span class="ico">⚽</span>体育竞技</a></li><li><a href="/forward.jsp?bid=24"><span class="ico">🎮</span>游戏天地</a></li><li><a href="/forward.jsp?bid=25"><span class="ico">📈</span>财经资讯</a></li></ul></div><div class="card"><h3>⚙️ 常用功能</h3><ul class="grid"><li><a href="/forward.jsp?bid=0"><span class="ico">💬</span>好友聊天</a></li><li><a href="/forward.jsp?bid=33"><span class="ico">🌟</span>QQ 空间</a></li><li><a href="/mobile/groups"><span class="ico">👥</span>QQ 群</a></li><li><a href="/mobile/groups?mode=create"><span class="ico">🏗️</span>创建群</a></li></ul></div><div class="card"><h3>🧰 更多</h3><ul class="grid"><li><a href="/forward.jsp?bid=26"><span class="ico">✉️</span>手机邮箱</a></li><li><a href="/forward.jsp?bid=27"><span class="ico">🌤️</span>天气</a></li><li><a href="/forward.jsp?bid=28"><span class="ico">📊</span>股票</a></li></ul></div></div><div class="foot">腾讯网 · 乐在沟通</div></div>`;
}


function tencentPortalWml() {
  const time = new Date().toLocaleDateString('zh-CN',
    { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  return `<p><b>腾讯网</b></p><p>${escapeWml(time)}</p>`
    + tencentPortalNavWml()
    + '<p><b>今日焦点</b></p>'
    + '<p>手机QQ：私服网关接入，好友、群聊一网打尽。</p>'
    + '<p>群空间：回「群聊」看聊天记录与成员。</p>'
    + '<p>我的空间：写说说、看好友动态。</p>'
    + '<p><b>热门频道</b></p>'
    + '<p><a href="/forward.jsp?bid=21">新闻头条</a> '
    + '<a href="/forward.jsp?bid=22">娱乐八卦</a> '
    + '<a href="/forward.jsp?bid=23">体育竞技</a></p>'
    + '<p><a href="/forward.jsp?bid=24">游戏天地</a> '
    + '<a href="/forward.jsp?bid=25">财经资讯</a></p>'
    + '<p><b>常用功能</b></p>'
    + '<p><a href="/forward.jsp?bid=0">QQ 好友聊天</a> '
    + '<a href="/forward.jsp?bid=33">QQ 空间</a> '
    + '<a href="/mobile/groups">QQ 群</a></p>'
    + '<p><a href="/mobile/groups?mode=create">创建群</a></p>'
    + '<p><b>更多</b></p>'
    + '<p><a href="/forward.jsp?bid=26">手机邮箱</a> '
    + '<a href="/forward.jsp?bid=27">天气</a> '
    + '<a href="/forward.jsp?bid=28">股票</a></p>';
}


// 导航页「手机网站」下仍存活的腾讯业务 —— 统一入口卡片页。
// 老 WAP 客户端打不开现代网页，就返回一个带站点介绍 + 现代网址的卡片；
// PC 浏览器点开可直接跳到真实站点。
//
// 服务端“WAP 版浏览”数据（WAP_SUBSITES）：
// 腾讯各 N 站早已没有可用 WML 版，老 J2ME 内置浏览器也渲染不了现代 JS 站点。
// 网关把每个存活子站做成「目录/内容卡片」，用真实栏目名 + 代表条目组织成
// WML/HTML 双版本静态页，老手机像浏览 WAP 门户一样浏览目录与条目。
const WAP_SUBSITES = {
  '56': {                     // QQ书城
    name: 'QQ 书城',
    desc: '海量小说免费读',
    url: 'https://book.qq.com',
    sections: [
      { title: '热门上榜', items: ['斗罗大陆IV·终极斗罗','凡人修仙传','诡秘之主','完美世界','赘婿'] },
      { title: '玄幻奇幻', items: ['斗破苍穹','遮天','雪中悍刀行','蛊真人','异常生物见闻录'] },
      { title: '武侠仙侠', items: ['诛仙','凡人修仙传·仙界篇','剑来','太乙门','择天记'] },
      { title: '都市言情', items: ['何以笙箫默','微微一笑很倾城','三生三世十里桃花','知否知否应是绿肥红瘦','亲爱的热爱的'] },
      { title: '精品栏目', items: ['本周热读','编辑推荐','完结佳作','限时免费'] },
    ],
  },
  13:  { // QQ 游戏
    name: 'QQ 游戏',
    desc: '经典游戏大厅/网页游戏',
    url: 'https://game.qq.com',
    sections: [
      { title: '棋牌麻将', items: ['欢乐斗地主','欢乐麻将','中国象棋','斗牛','跑得快'] },
      { title: '休闲游戏', items: ['QQ堂','穿越火线·手游','天天酷跑','欢乐消消乐'] },
      { title: '大型游戏', items: ['穿越火线','地下城与勇士','英雄联盟','和平精英','王者荣耀'] },
      { title: '网页游戏', items: ['贴吧三国','烽火戏诸侯','志同道合','御剑情缘'] },
    ],
  },
  49: { // 腾讯财经
    name: '腾讯财经',
    desc: '股票行情 / 财经资讯',
    url: 'https://finance.qq.com',
    sections: [
      { title: '大盘指数', items: ['上证指数  3,284.56 +0.32%','深证成指  12,156.73 +0.58%','创业板指  2,214.18 +0.77%','沪深300   4,012.09 +0.21%'] },
      { title: '今日导读', items: ['A股三大指数集体收涨','央行开展逆回购操作','北向资金今日流入情况'] },
      { title: '行业板块', items: ['银行','白酒','新能源','半导体','医药'] },
    ],
  },
  61:  { name: '腾讯资讯', desc: '24 小时新闻资讯', url: 'https://news.qq.com', sections: [
      { title: '要闻', items: ['重点新闻标题示例一','重点新闻标题示例二','重点新闻标题示例三','重点新闻标题示例四'] },
      { title: '国内', items: ['时政要闻','地方动态','政策发布'] },
      { title: '国际', items: ['环球看点','国际时评','外交动态'] },
      { title: '社会', items: ['民生热点','法治社会','暖心瞬间'] },
      { title: '娱乐', items: ['影视剧集','音乐现场','明星动态'] },
    ],
  },
  175: { name: '腾讯导航', desc: '网上冲浪好帮手', url: 'https://hao.qq.com', sections: [
      { title: '常用网站', items: ['QQ 邮箱','腾讯视频','QQ空间','微信网页版','腾讯新闻'] },
      { title: '影音娱乐', items: ['QQ音乐','腾讯视频','酷狗音乐','哔哩哔哩','斗鱼'] },
      { title: '购物生活', items: ['京东','唯品会','当当','顺丰速运','中通快递'] },
      { title: '新闻资讯', items: ['腾讯新闻','搜狐','网易','凤凰网','新浪'] },
      { title: '学习办公', items: ['百度文库','知乎','B站课堂','金山办公','腾讯文档'] },
    ],
  },
  176: { name: 'QQ 音乐', desc: '正版音乐随心听', url: 'https://music.qq.com', sections: [
      { title: '热歌榜', items: ['孤勇者','可能否','大鱼','漠河舞厅','唯一'] },
      { title: '新歌速递', items: ['周五上线','首发单曲','数字专辑'] },
      { title: '分类曲库', items: ['流行','摇滚','民谣','电子','古风'] },
      { title: '歌手', items: ['周杰伦','陈奕迅','林俊杰','邓紫棋'] },
    ],
  },
};

// HTML 版站点目录页（PC 浏览器预览用）
function wapSiteHtml(site) {
  const cards = site.sections.map(sec => `
    <div class="wsection"><h4>${escapeHtml(sec.title)}</h4>
      <ul>${sec.items.map(i=>`<li>${escapeHtml(i)}</li>`).join('')}</ul></div>`).join('');
  return `<div class="portal"><style>
.portal{background:linear-gradient(180deg,#eaf3ff 0%,#f7fbff 60%,#ffffff 100%);min-height:100vh;padding:0 0 24px;margin:0;font-family:-apple-system,\"PingFang SC\",\"Microsoft YaHei\",sans-serif}
.portal *{box-sizing:border-box;margin:0;padding:0}
.portal .hero{background:linear-gradient(135deg,#0a6cff 0%,#2b8cff 55%,#6fb6ff 100%);padding:30px 20px;text-align:center;color:#fff;border-radius:0 0 22px 22px}
.portal .hero h2{font-size:25px;font-weight:700;letter-spacing:3px}
.portal .hero p{font-size:13px;opacity:.9;margin-top:8px}
.portal .wrap{padding:16px;max-width:720px;margin:0 auto}
.portal .wsection{background:#fff;border-radius:12px;padding:14px 16px;margin:12px 0;box-shadow:0 2px 10px rgba(30,80,160,.08)}
.portal .wsection h4{color:#0a6cff;font-size:14px;margin-bottom:8px;border-left:4px solid #0a6cff;padding-left:8px}
.portal .wsection li{list-style:none;font-size:13px;color:#445;padding:5px 0;border-bottom:1px dashed #eee}
.portal .back{margin-top:12px;text-align:center}
.portal .back a{color:#0a6cff;text-decoration:none;font-size:13px}
</style>
<div class="hero"><h2>${escapeHtml(site.name)}</h2><div class="sub">${escapeHtml(site.desc)}</div></div>
<div class="wrap">${cards}<div class="back"><a href="/forward.jsp?bid=20">← 返回腾讯网门户</a></div></div>
</div>`;
}

// WML 版站点目录页（老手机主入口）
function wapSiteWml(site) {
  let out = `<p><b>${escapeWml(site.name)}</b> · ${escapeWml(site.desc)}</p>`;
  site.sections.forEach(sec => {
    out += `<p><b>— ${escapeWml(sec.title)} —</b></p>`;
    sec.items.forEach(it => { out += `<p><a href="/wap?site=${escapeWml(site.name)}&n=${encodeURIComponent(it)}">${escapeWml(it)}</a></p>`; });
  });
  out += `<p><a href="/mobile/groups">返回腾讯网门户</a></p>`;
  return out;
}
// WAP 静态聚合目录条目详情：老客户端点目录里的条目时返回的说明页。
// 不实时抓取（现代腾讯站为 JS 渲染，且对老 WAP 已停服），仅静态呈现条目归属信息，
// 让老手机“点进去有内容”。
function findWapItem(siteName, itemName) {
  for (const key of Object.keys(WAP_SUBSITES)) {
    const site = WAP_SUBSITES[key];
    if (site.name !== siteName) continue;
    for (const sec of site.sections) {
      if (sec.items.includes(itemName)) return { site, section: sec, item: itemName };
    }
  }
  return null;
}
function wapItemHtml(site, item) {
  return `<div class="portal"><style>
.portal{background:linear-gradient(180deg,#eaf3ff 0%,#f7fbff 60%,#ffffff 100%);min-height:100vh;padding:0 0 24px;margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.portal *{box-sizing:border-box;margin:0;padding:0}
.portal .hero{background:linear-gradient(135deg,#0a6cff 0%,#2b8cff 55%,#6fb6ff 100%);padding:26px 20px 30px;text-align:center;color:#fff;border-radius:0 0 22px 22px}
.portal .hero h2{font-size:22px;font-weight:700;letter-spacing:2px}
.portal .hero p{font-size:13px;opacity:.9;margin-top:8px}
.portal .wrap{padding:16px;max-width:720px;margin:0 auto}
.portal .rip{background:#fff;border-radius:12px;padding:16px;margin:12px 0;box-shadow:0 2px 10px rgba(30,80,160,.08)}
.portal .rip h4{color:#0a6cff;font-size:14px;margin-bottom:10px;border-left:4px solid #0a6cff;padding-left:8px}
.portal .rip p{font-size:13px;color:#445;line-height:1.9}
.portal .back{margin-top:12px;text-align:center}
.portal .back a{color:#0a6cff;text-decoration:none;font-size:13px}
.portal .foot{text-align:center;color:#99a;font-size:12px;padding:16px 0 6px}
</style>
<div class="hero"><h2>${escapeHtml(site.name)}</h2><p>${escapeHtml(item)}</p></div>
<div class="wrap">
  <div class="rip"><h4>▍栏目：${escapeHtml(site.name)}</h4>
  <p>${escapeHtml(item)}</p><p>这是腾讯 WAP 时代栏目条目在网关聚合页中的静态呈现。原腾讯 WAP 服务已停服，不再有实时正文。</p></div>
  <div class="back"><a href="/forward.jsp?bid=20">← 返回腾讯网门户</a></div>
</div>
<div class="foot">Nyanya 网关 · 静态聚合门户</div>
</div>`;
}
function wapItemWml(site, item) {
  return `<p><b>${escapeWml(item)}</b></p><p>${escapeWml(site.name)}</p><p>该条目为 WAP 旧版静态呈现，原腾讯 WAP 服务已停服。</p><p><a href="/forward.jsp?bid=20">返回目录</a></p>`;
}

// serviceEntryHtml: 兼容旧卡片 + 提供 WAP 目录断言
function serviceEntryHtml(svc) {
  const site = WAP_SUBSITES[svc.bid];
  if (site) return wapSiteHtml(site);
  return `<div class="portal"><style>
.portal{background:linear-gradient(180deg,#eaf3ff 0%,#f7fbff 60%,#fff 100%);min-height:100vh;padding:0 0 24px;margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;text-align:center}
.portal *{box-sizing:border-box;margin:0;padding:0}
.portal .hero{background:linear-gradient(135deg,#0a6cff 0%,#2b8cff 55%,#6fb6ff 100%);padding:34px 20px 38px;color:#fff;border-radius:0 0 24px 24px}
.portal .hero h2{font-size:26px;font-weight:700;letter-spacing:4px}
.portal .hero p{font-size:13px;letter-spacing:2px;opacity:.92;margin-top:8px}
.portal .card{background:#fff;border-radius:14px;padding:18px 20px;margin:16px;box-shadow:0 3px 14px rgba(30,80,160,.1);color:#334}
.portal .card h3{font-size:15px;margin-bottom:12px;color:#0a6cff}
.portal .card p{color:#445;line-height:1.8;font-size:13.5px}
.portal .card a.btn{display:inline-block;margin-top:16px;padding:10px 24px;border-radius:999px;background:#0a6cff;color:#fff;text-decoration:none;font-size:14px;font-weight:600;box-shadow:0 3px 10px rgba(10,108,255,.3)}
.portal .foot{color:#99a;font-size:12px;padding:18px 0 6px}
</style>
<div class="hero"><h2>${escapeHtml(svc.name)}</h2><p>${escapeHtml(svc.desc)}</p></div>
<div class="card"><h3>▍说明</h3><p>该业务在 QQ2011 时代为手机 WAP 入口，现腾讯已迁移至独立网站 / App。</p>
<p>PC 端可通过下方按钮直接访问现代版本：</p>
<p><a class="btn" href="${escapeHtml(svc.url)}" target="_blank" rel="noopener">前往 ${escapeHtml(svc.name)}</a></p></div>
<div class="foot">Nyanya 网关 · ${escapeHtml(svc.url)}</div>
</div>`;
}
function serviceEntryWml(svc) {
  const site = WAP_SUBSITES[svc.bid];
  if (site) return wapSiteWml(site);
  return `<p><b>${escapeWml(svc.name)}</b></p>`
    + `<p>${escapeWml(svc.desc)}</p>`
    + `<p>该功能的腾讯 WAP 版已下线，如今在独立站点 / App 提供服务。</p>`
    + `<p>请在电脑浏览器打开：${escapeWml(svc.url)}</p>`
    + `<p>Nyanya 网关为您尽力还原当年的访问体验。</p>`;
}

// 腾讯 WAP 业务停服提示页。
// QQ2011 客户端功能导航里的「邮箱 / 微博 / 游戏 / 超级QQ」等图标，走的都是同一组
// 共享 bid（class b 里的 4 / 41 / 113 / 339 / 411），网关无法区分具体点了哪一个，
// 且这些腾讯 WAP 业务早已陆续停服。于是统一接管为一个通用的「业务已下线」提示页，
// 符合勇者要求的「统一文案」。
function serviceShutdownHtml() {
  return `<div class="portal"><style>
.portal{background:linear-gradient(180deg,#f4f0fa 0%,#fbfaff 60%,#ffffff 100%);min-height:100vh;padding:0 0 24px;margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.portal *{box-sizing:border-box;margin:0;padding:0}
.portal .hero{background:linear-gradient(135deg,#6a5acd 0%,#8a7bdd 55%,#b3a6ec 100%);padding:26px 20px 30px;text-align:center;color:#fff;border-radius:0 0 24px 24px;box-shadow:0 4px 18px rgba(90,70,180,.28)}
.portal .hero .bird{display:inline-block;font-size:40px;line-height:1;filter:drop-shadow(0 3px 4px rgba(0,0,0,.25))}
.portal .hero h2{font-size:24px;font-weight:700;letter-spacing:4px;text-shadow:0 2px 6px rgba(0,0,0,.2)}
.portal .hero .slogan{margin-top:6px;font-size:13px;letter-spacing:2px;opacity:.92}
.portal .wrap{padding:0 16px;max-width:720px;margin:0 auto}
.portal .card{background:#fff;border-radius:14px;padding:18px 20px;margin:16px 0;box-shadow:0 3px 14px rgba(60,50,130,.10);border-left:5px solid #6a5acd}
.portal .card h3{font-size:15px;font-weight:700;color:#2a2438;margin-bottom:12px;letter-spacing:1px}
.portal .card p{font-size:13.5px;color:#444;line-height:1.9;margin:8px 0}
.portal .card .sign{margin-top:12px;text-align:right;color:#6a5acd;font-weight:600}
.portal .foot{text-align:center;color:#99a;font-size:12px;padding:18px 0 6px}
</style>
<div class="hero"><span class="bird">🚫</span><h2>服务已下线</h2><div class="slogan">腾讯 WAP 业务 · 停止服务</div></div>
<div class="wrap">
  <div class="card">
    <h3>▍该业务已停止服务</h3>
    <p>亲爱的用户：由于腾讯整体业务调整，本功能对应的腾讯 WAP 服务已正式停止运营，此入口现已无法使用。</p>
    <p>给您带来的不便，我们深表歉意。感谢您多年来的陪伴、理解与支持。</p>
    <p>如需联系好友、查看空间动态等核心功能，请回到手机QQ的「导航」/「群聊」继续使用。</p>
    <p class="sign">腾讯 · 真诚沟通</p>
  </div>
</div>
<div class="foot">该功能入口由 Nyanya 网关接管</div>
</div>`;
}

// WML 版（老手机内置浏览器只认 WML，不认 CSS）；同一份停服提示。
function serviceShutdownWml() {
  return '<p><b>服务已下线</b></p>'
    + '<p>亲爱的用户：由于腾讯整体业务调整，本功能对应的腾讯 WAP 服务已正式停止运营，此入口现已无法使用。</p>'
    + '<p>给您带来不便，我们深表歉意。感谢您多年来的陪伴、理解与支持。</p>'
    + '<p>联系好友、看群动态请回到手机QQ的「导航」/「群聊」继续使用。</p>'
    + '<p>腾讯 · 真诚感谢</p>';
}


function mailShutdownHtml() {
  return `<div class="portal"><style>
.portal{background:linear-gradient(180deg,#eaf6ff 0%,#f7fbff 60%,#fff 100%);min-height:100vh;padding:0 0 24px;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.portal *{box-sizing:border-box;margin:0;padding:0}
.portal .hero{background:linear-gradient(135deg,#0a6cff 0%,#2b8cff 55%,#6fb6ff 100%);padding:28px 20px 32px;text-align:center;color:#fff;border-radius:0 0 24px 24px;box-shadow:0 4px 18px rgba(10,108,255,.28)}
.portal .hero .bird{display:block;font-size:42px;line-height:1;filter:drop-shadow(0 3px 4px rgba(0,0,0,.25))}
.portal .hero h2{font-size:24px;font-weight:700;letter-spacing:4px;text-shadow:0 2px 6px rgba(0,0,0,.2);margin-top:6px}
.portal .hero .sub{margin-top:8px;font-size:12px;letter-spacing:2px;opacity:.9}
.portal .wrap{padding:0 16px;max-width:720px;margin:0 auto}
.portal .card{background:#fff;border-radius:14px;padding:18px 20px;margin:16px 0;box-shadow:0 3px 14px rgba(30,80,160,.1);border-left:5px solid #0a6cff}
.portal .card h3{font-size:15px;font-weight:700;color:#1c2b3a;margin-bottom:12px}
.portal .card p{font-size:13.5px;color:#445;line-height:1.9;margin:8px 0}
.portal .card a.btn{display:inline-block;margin-top:8px;padding:9px 22px;border-radius:999px;background:#0a6cff;color:#fff;font-size:14px;font-weight:600;text-decoration:none;box-shadow:0 3px 10px rgba(10,108,255,.3)}
.portal .foot{text-align:center;color:#99a;font-size:12px;padding:18px 0 6px}
</style>
<div class="hero"><span class="bird">📬</span><h2>邮箱</h2><div class="sub">腾讯邮箱 · 网页版入口</div></div>
<div class="wrap">
<div class="card"><h3>▍关于邮件功能</h3><p>本机老客户端内置的 WAP 邮箱服务已被腾讯停用，网关已将该入口改为引导到腾讯邮箱网页版。</p><p>它仍然支持你日常收发邮件 —— 点击下方按钮，跳转到 QQ 邮箱网页版登录。</p><p><a class="btn" href="https://mail.qq.com/">前往 QQ 邮箱网页版</a></p></div>
</div>
<div class="foot">腾讯邮箱 · mail.qq.com</div></div>`;
}

function mailShutdownWml() {
  return '<p><b>邮箱</b></p>'
    + '<p>说明：本机老 WAP 邮箱已被腾讯停用，网关已把入口改为腾讯邮箱网页版。</p>'
    + '<p>收发邮件请访问网页版登录：</p>'
    + '<p><a href="https://mail.qq.com">mail.qq.com（QQ邮箱网页版）</a></p>'
    + '<p>本服务由 Nyanya Gateway 提供跳转。</p>';
}

function readForm(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > 64 * 1024) {
        reject(new Error('表单过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const values = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      resolve(Object.fromEntries(values.entries()));
    });
    request.on('error', reject);
  });
}

function positiveInteger(value, label) {
  const number = Number(String(value || '').trim());
  if (!Number.isInteger(number) || number <= 0 || number > 0xFFFFFFFF) {
    throw new Error(`${label}格式不正确`);
  }
  return number;
}

function authenticate(store, body, field) {
  const name = field || 'uin';
  const uin = positiveInteger(body[name], 'QQ号');
  const account = store.authenticate(
    uin, Buffer.from(digestPassword(String(body.password || '')), 'hex'));
  if (!account) throw new Error('QQ号或密码不正确');
  return account;
}

function groupList(store, query) {
  const normalized = String(query || '').trim().toLowerCase();
  const groups = store.listGroups().filter((group) => group.type === 'group'
    && (!normalized || String(group.publicId) === normalized
      || group.title.toLowerCase().includes(normalized)));
  if (!groups.length) return '<p>没有找到群。</p>';
  return '<ul>' + groups.map((group) => `<li><b>${escapeHtml(group.title)}</b> `
    + `(群号 ${group.publicId}，${group.members.length} 人)</li>`).join('') + '</ul>';
}

function homePage(store, mode, query) {
  const create = `<fieldset><legend>创建群</legend><form method="post" action="/mobile/groups/create">`
    + '<label>你的私服 QQ 号：<input name="uin" inputmode="numeric"></label>'
    + '<label>密码：<input name="password" type="password"></label>'
    + '<label>群名称：<input name="title" maxlength="60"></label>'
    + '<label>邀请成员 QQ 号（逗号分隔，可留空）：<input name="members"></label>'
    + '<input type="submit" value="创建群"></form></fieldset>';
  const search = `<fieldset><legend>查找群</legend><form method="get" action="/mobile/groups">`
    + '<input type="hidden" name="mode" value="search">'
    + `<label>群号或名称：<input name="q" value="${escapeHtml(query || '')}"></label>`
    + '<input type="submit" value="查找"></form>'
    + (mode === 'search' ? groupList(store, query) : '') + '</fieldset>';
  const join = '<fieldset><legend>加入群</legend><form method="post" action="/mobile/groups/join">'
    + '<label>你的私服 QQ 号：<input name="uin" inputmode="numeric"></label>'
    + '<label>密码：<input name="password" type="password"></label>'
    + '<label>群号：<input name="groupId" inputmode="numeric"></label>'
    + '<input type="submit" value="加入群"></form></fieldset>';
  const invite = '<fieldset><legend>邀请用户</legend><form method="post" action="/mobile/groups/invite">'
    + '<label>邀请人 QQ 号：<input name="uin" inputmode="numeric"></label>'
    + '<label>密码：<input name="password" type="password"></label>'
    + '<label>群号：<input name="groupId" inputmode="numeric"></label>'
    + '<label>被邀请人 QQ 号：<input name="memberUin" inputmode="numeric"></label>'
    + '<input type="submit" value="发送邀请"></form></fieldset>';
  if (mode === 'create') return create + search + join + invite;
  if (mode === 'search') return search + join + create + invite;
  return '<p>这里替代已经停用的腾讯 WAP 建群页面。</p>' + create + search + join + invite;
}

function createMobileGroupServer(options) {
  const store = options.store;
  const mediaService = options.mediaService;
  const logger = options.logger || (() => {});
  const requestEvent = options.requestEvent || 'mobile_http_request';
  const errorEvent = options.errorEvent || 'mobile_group_error';
  const pushGroupDiscovery = options.pushGroupDiscovery || (() => {});
  // 发说说回调：server.js 注入 backend.sendQzoneMsg。缺省时返回不可用，避免崩。
  const sendQzoneMsg = options.sendQzoneMsg
    || (async () => ({ ok: false, code: 'not_available', error: '发说说未启用' }));
  // 看说说列表回调：server.js 注入 qzoneBridge.getEmotionList。缺省时返回不可用。
  const getQzoneList = options.getQzoneList
    || (async () => ({ ok: false, error: '说说列表未启用' }));
  // 看评论/点赞/发评论回调：server.js 注入 qzoneBridge 对应方法。
  const getQzoneComments = options.getQzoneComments
    || (async () => ({ ok: false, error: '评论功能未启用' }));
  const sendQzoneLike = options.sendQzoneLike
    || (async () => ({ ok: false, error: '点赞功能未启用' }));
  const sendQzoneComment = options.sendQzoneComment
    || (async () => ({ ok: false, error: '评论功能未启用' }));
  // 看好友动态流回调：server.js 注入 qzoneBridge.getFriendFeedList。
  const getQzoneFriends = options.getQzoneFriends
    || (async () => ({ ok: false, error: '好友动态未启用' }));
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const rawHost = String(request.headers.host || '');
      const baseUrl = /^[0-9A-Za-z.:\-[\]]+$/.test(rawHost) ? `http://${rawHost}` : '';
      logger({
        event: requestEvent,
        method: request.method,
        path: url.pathname,
        // 老手机是 `text/vnd.wap.wml,...`，PC 浏览器是 `text/html,...`。
        // KEmulator 和网关同机，peer 都是本机 LAN IP，只能靠这个字段区分来源。
        accept: String(request.headers.accept || '').slice(0, 120) || undefined,
        bid: url.searchParams.get('bid') || undefined,
        // 取图失败时全靠这几个字段定位：客户端实际拼出来的 pic/fileid 是什么。
        pic: url.searchParams.get('pic') || undefined,
        fileid: url.searchParams.get('fileid') || undefined,
        query: url.search ? url.search.slice(0, 300) : undefined,
        peer: String(request.socket.remoteAddress || '').replace(/^::ffff:/, ''),
        contentLength: Number(request.headers['content-length'] || 0),
      });
      if (request.method === 'POST' && url.pathname === '/' && mediaService
          && url.searchParams.has('ukey') && url.searchParams.has('filekey')) {
        await mediaService.receiveUpload(request, response, url);
        return;
      }
      // 根路径 = 腾讯网 WAP 门户。老客户端内置浏览器点「腾讯网」、
      // 或直接在浏览器访问网关根地址，都落在这里。
      if (request.method === 'GET' && url.pathname === '/') {
        sendPage(request, response, 200, '腾讯网',
          tencentPortalHtml(), tencentPortalWml());
        return;
      }
      const mediaMatch = url.pathname.match(/^\/mobile\/media\/([^/]+)(\/raw)?$/);
      if (request.method === 'GET' && mediaMatch) {
        const media = store.getMedia(decodeURIComponent(mediaMatch[1]));
        if (!media) {
          sendPage(request, response, 404, '媒体不存在',
            '<p class="err">这条图片或语音不存在。</p>',
            '<p>这条图片或语音不存在。</p>');
          return;
        }
        if (mediaMatch[2]) {
          sendMedia(response, media, url.searchParams.get('download') === '1');
        } else {
          sendPage(request, response, 200, media.mediaType === 2 ? '查看图片' : '播放语音',
            mediaPage(media, baseUrl), mediaCardWml(media, baseUrl));
        }
        return;
      }

      // WAP 静态聚合门户：目录条目详情入口 (?site=站点名&n=条目名)
      if (request.method === 'GET' && url.pathname === '/wap') {
        const siteName = url.searchParams.get('site') || '';
        const itemName = url.searchParams.get('n') || '';
        const found = findWapItem(siteName, itemName);
        if (!found) {
          sendPage(request, response, 404, '条目不存在',
            '<p class="err">未找到该条目。</p><p><a href="/forward.jsp?bid=20">返回目录</a></p>',
            '<p>未找到该条目。</p><p><a href="/forward.jsp?bid=20">返回目录</a></p>');
          return;
        }
        sendPage(request, response, 200, itemName,
          wapItemHtml(found.site, found.item), wapItemWml(found.site, found.item));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/forward.jsp') {
        const bid = url.searchParams.get('bid');
        if (bid === '20' || bid === '6') {
          // 腾讯网门户（原腾讯 WAP 首页已停，由网关接管成静态门户）。
          // bid=20 是主入口；bid=6 是「导航页→手机网站→腾讯网」菜单入口（class bk），
          // 显式路由到门户，避免落入停服分支/其它误判。
          sendPage(request, response, 200, '腾讯网',
            tencentPortalHtml(), tencentPortalWml());
          return;
        }
        if (bid === '342' || bid === '205') {
          const mode = bid === '342' ? 'create' : 'search';
          const title = mode === 'create' ? '创建群' : '查找群';
          sendPage(request, response, 200, title,
            homePage(store, mode, url.searchParams.get('q') || ''),
            '<p>建群 / 查群需要输入框，请在电脑浏览器上打开这个地址。</p>'
            + '<p>手机上的群聊、图片和语音不受影响。</p>');
          return;
        }
        if (bid === '331') {
          // 群图片气泡（0x0094 富媒体块）里带的是 pic=<媒体 id>；老链接用的是 fileid。
          // 两者都认，pic 优先。手机必须拿 WML —— 它把 text/html 直接判成错误码 005。
          const rawId = url.searchParams.get('pic') || url.searchParams.get('fileid') || '';
          const media = store.getMedia(rawId);
          if (!media) {
            logger({
              event: 'mobile_wap_image_miss',
              bid,
              rawId: rawId.slice(0, 80),
              query: url.search.slice(0, 300),
              peer: String(request.socket.remoteAddress || '').replace(/^::ffff:/, ''),
            });
            sendPage(request, response, 404, '查看群图片',
              '<p class="err">图片不存在或旧链接缺少文件编号。</p>',
              '<p>图片不存在或旧链接缺少文件编号。</p>');
            return;
          }
          if (url.searchParams.get('page') === '1') {
            sendHtml(response, 200, '查看群图片', mediaPage(media, baseUrl));
            return;
          }
          sendPage(request, response, 200, '查看群图片',
            mediaPage(media, baseUrl), mediaCardWml(media, baseUrl));
          return;
        }
        // 导航页「手机网站」下仍存活、可继续接入的腾讯业务。
        // 老客户端外链到现代网页会显示“错误代码 005”，所以这里接管成一个
        // 业务入口页：手机端给 WML 文字说明，PC 端给可点的现代站点外链。
        const SERVICE_ENTRY = {
          56:  { name: 'QQ 书城', desc: '海量小说免费读',       url: 'https://book.qq.com' },
          13:  { name: 'QQ 游戏', desc: '经典游戏大厅/页游',   url: 'https://game.qq.com' },
          49:  { name: '腾讯财经', desc: '股票行情 / 财经资讯', url: 'https://finance.qq.com' },
          61:  { name: '腾讯资讯', desc: '24 小时新闻资讯',     url: 'https://news.qq.com' },
          175: { name: '腾讯导航', desc: '网上冲浪好帮手',       url: 'https://hao.qq.com' },
          176: { name: 'QQ 音乐', desc: '正版音乐随心听',       url: 'https://music.qq.com' },
          // 209: class hu 里的另一个腾讯网入口，语义等同 6/20，统一路由到门户
          209: { name: '腾讯网', desc: '诚意沟通 · 快乐生活',  url: 'https://www.qq.com' },
        };
        const svc = SERVICE_ENTRY[bid];
        if (svc) {
          sendPage(request, response, 200, svc.name,
            serviceEntryHtml(svc), serviceEntryWml(svc));
          return;
        }

        // 邮箱 / 微博 / 游戏 / 超级QQ 等停服功能的共享 bid 组（class b 导航）。
        // 客户端无法按 bid 区分具体点了哪一个，而这些腾讯 WAP 业务都已停服，
        // 所以一律返回统一的「服务已下线」提示页（统一文案）。
        const SHUTDOWN_BIDS = new Set(['4', '41', '113', '339', '411']);
if (SHUTDOWN_BIDS.has(bid)) {
          sendPage(request, response, 200, '服务已下线',
            serviceShutdownHtml(), serviceShutdownWml());
          return;
        }

        const MAIL_BIDS = new Set(['126', '127']);
if (MAIL_BIDS.has(bid)) {
  // 腾讯邮箱 WAP 入口（QQ2011 class u 中 bid=126/127 关联 qqmail.com）。
  // 腾讯已停老客户端 WAP 邮箱，网关改成跳转网页版。
          sendPage(request, response, 200, 'QQ邮箱',
            mailShutdownHtml(), mailShutdownWml());
          return;
        }

if (bid === '33') {
          // QQ 空间入口：客户端点空间图标发 `bid=33&autoReg=true&g_q=2`，原本指向
          // 腾讯官方空间 WAP。接管成「看自己说说列表 + 好友动态 + 详情评论点赞 + 发说说」：
          //   - 无 action → 我的说说列表（数据来自 qzone-bridge）
          //   - action=friends → 好友动态流（好友们最近发的）
          //   - action=post → 发说说表单（走 NapCat send_qzone_msg）
          //   - action=detail → 说说详情 + 评论列表（tid/content 走 query）
          //   - action=like → 点赞后回详情
          //   - action=comment → 发评论表单
          const action = url.searchParams.get('action') || '';
          const peer = String(request.socket.remoteAddress || '').replace(/^::ffff:/, '');
          if (action === 'post') {
            sendPage(request, response, 200, '发说说', qzonePostHtml(), qzonePostWml());
            return;
          }
          if (action === 'friends') {
            const result = await getQzoneFriends();
            if (!result.ok) {
              logger({ event: 'qzone_friends_failed', peer, message: result.error || 'unknown' });
              sendPage(request, response, 502, '好友动态',
                `<p class="err">好友动态获取失败：${escapeHtml(result.error || '未知错误')}</p>` + qzoneNavHtml('friends'),
                `<p>好友动态获取失败：${escapeWml(result.error || '未知错误')}</p>` + qzoneNavWml('friends'));
              return;
            }
            sendPage(request, response, 200, '好友动态',
              qzoneFriendsHtml(result.posts) + qzoneNavHtml('friends'),
              qzoneFriendsWml(result.posts) + qzoneNavWml('friends'));
            return;
          }
          if (action === 'detail' || action === 'like' || action === 'comment') {
            const tid = String(url.searchParams.get('tid') || '').trim();
            const content = url.searchParams.get('content') || '';
            if (!tid) {
              sendPage(request, response, 400, '说说详情',
                '<p class="err">缺少说说编号。</p>', '<p>缺少说说编号。</p>');
              return;
            }
            const post = { tid, content };
            if (action === 'comment') {
              sendPage(request, response, 200, '评论说说',
                qzoneCommentHtml(tid, content), qzoneCommentWml(tid, content));
              return;
            }
            if (action === 'like') {
              const like = await sendQzoneLike(tid);
              const notice = like.ok ? '已点赞。' : `点赞失败：${like.error || '未知错误'}`;
              logger({ event: like.ok ? 'qzone_like' : 'qzone_like_failed', peer, tid });
              const cmt = await getQzoneComments(tid);
              sendPage(request, response, like.ok ? 200 : 502, '说说详情',
                `<p class="${like.ok ? 'ok' : 'err'}">${escapeHtml(notice)}</p>`
                  + qzoneDetailHtml(post, cmt.ok ? cmt.comments : null, cmt.ok ? '' : cmt.error),
                `<p>${escapeWml(notice)}</p>`
                  + qzoneDetailWml(post, cmt.ok ? cmt.comments : null, cmt.ok ? '' : cmt.error));
              return;
            }
            // action === 'detail'
            const cmt = await getQzoneComments(tid);
            if (!cmt.ok) {
              logger({ event: 'qzone_comments_failed', peer, message: cmt.error || 'unknown' });
            }
            sendPage(request, response, 200, '说说详情',
              qzoneDetailHtml(post, cmt.ok ? cmt.comments : null, cmt.ok ? '' : cmt.error),
              qzoneDetailWml(post, cmt.ok ? cmt.comments : null, cmt.ok ? '' : cmt.error));
            return;
          }
          const result = await getQzoneList();
          if (!result.ok) {
            logger({ event: 'qzone_list_failed', peer, message: result.error || 'unknown' });
            sendPage(request, response, 502, 'QQ空间',
              `<p class="err">说说列表获取失败：${escapeHtml(result.error || '未知错误')}</p>` + qzoneNavHtml(),
              `<p>说说列表获取失败：${escapeWml(result.error || '未知错误')}</p>` + qzoneNavWml());
            return;
          }
          sendPage(request, response, 200, 'QQ空间',
            qzoneListHtml(result.posts) + qzoneNavHtml(),
            qzoneListWml(result.posts) + qzoneNavWml());
          return;
        }
        if (bid === '202' || bid === '203' || bid === '204') {
          const groupId = positiveInteger(url.searchParams.get('groupID')
            || url.searchParams.get('gid'), '群号');
          const group = store.getGroup(groupId);
          if (!group) {
            sendPage(request, response, 404, '群不存在',
              '<p class="err">没有找到这个群。</p>', '<p>没有找到这个群。</p>');
            return;
          }
          // 202 = 手机菜单「群聊天记录」；204 = 旧「查看群聊天记录」链接。
          // 两者都是记录页，必须给 WML，否则手机上只会看到 005。
          if (bid === '203') {
            const list = '<ul>' + group.members.map((member) => {
              const account = store.get(member.uin);
              return `<li>${escapeHtml(account ? account.nickname : member.uin)} (${member.uin})`
                + `${member.role === 'owner' ? ' - 群主' : ''}</li>`;
            }).join('') + '</ul>';
            sendPage(request, response, 200, group.title,
              `<p>群号：<b>${group.publicId}</b>，成员：${group.members.length} 人</p>${list}`,
              groupInfoWml(group, store));
            return;
          }
          // 不按 fqq 过滤：那个参数是客户端自己的 QQ 号（「查看我的记录」语义），
          // 而菜单标题是「群聊天记录」，用户要的是这个群最近的对话。
          const rows = store.recentGroupMessages(group.id, 50);
          sendPage(request, response, 200, `${group.title} - 聊天记录`,
            groupHistoryHtml(rows, store), groupHistoryWml(rows, store));
          return;
        }
        // 其它 bid / 未知入口一律落回腾讯网 WAP 门户（原腾讯 WAP 已停，
        // 由网关接管成静态门户，点「腾讯网」入口即看到这一页）。
        sendPage(request, response, 200, '腾讯网',
          tencentPortalHtml(), tencentPortalWml());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/forward.jsp'
          && url.searchParams.get('bid') === '33') {
        const body = await readForm(request);
        const peer = String(request.socket.remoteAddress || '').replace(/^::ffff:/, '');
        if (url.searchParams.get('action') === 'comment') {
          const tid = String(body.tid || '').trim();
          const pcontent = String(body.pcontent || '');
          const commentText = String(body.content || '').trim();
          if (!tid) {
            sendPage(request, response, 400, '评论说说',
              '<p class="err">缺少说说编号。</p>', '<p>缺少说说编号。</p>');
            return;
          }
          if (!commentText) {
            sendPage(request, response, 200, '评论说说',
              '<p class="err">评论内容不能为空。</p>' + qzoneCommentHtml(tid, pcontent),
              '<p>评论内容不能为空。</p>' + qzoneCommentWml(tid, pcontent));
            return;
          }
          const result = await sendQzoneComment(tid, commentText);
          const post = { tid, content: pcontent };
          if (!result.ok) {
            logger({ event: 'qzone_comment_failed', peer, message: result.error || 'unknown' });
            sendPage(request, response, 502, '评论失败',
              `<p class="err">评论失败：${escapeHtml(result.error || '未知错误')}</p>`
                + qzoneCommentHtml(tid, pcontent),
              `<p>评论失败：${escapeWml(result.error || '未知错误')}</p>`
                + qzoneCommentWml(tid, pcontent));
            return;
          }
          logger({ event: 'qzone_comment', peer, tid, commentId: result.commentId || undefined });
          const cmt = await getQzoneComments(tid);
          sendPage(request, response, 200, '说说详情',
            '<p class="ok">评论已发表。</p>'
              + qzoneDetailHtml(post, cmt.ok ? cmt.comments : null, cmt.ok ? '' : cmt.error),
            '<p>评论已发表。</p>'
              + qzoneDetailWml(post, cmt.ok ? cmt.comments : null, cmt.ok ? '' : cmt.error));
          return;
        }
        const content = String(body.content || '').trim();
        if (!content) {
          sendPage(request, response, 200, '发说说',
            '<p class="err">说说内容不能为空。</p>' + qzonePostHtml(),
            '<p>说说内容不能为空。</p>' + qzonePostWml());
          return;
        }
        const result = await sendQzoneMsg(content);
        if (!result.ok) {
          logger({ event: 'qzone_post_failed', peer, message: result.error || 'unknown' });
          sendPage(request, response, 502, '发说说失败',
            `<p class="err">发表失败：${escapeHtml(result.error || '未知错误')}</p>` + qzonePostHtml(),
            `<p>发表失败：${escapeWml(result.error || '未知错误')}</p>` + qzonePostWml());
          return;
        }
        logger({ event: 'qzone_post', peer, tid: result.tid || undefined });
        sendPage(request, response, 200, '发表成功',
          '<p class="ok">说说已发表。</p>'
          + '<p><a href="/forward.jsp?bid=33">回列表</a> | '
          + '<a href="/forward.jsp?bid=33&amp;action=post">再发一条</a></p>',
          '<p>说说已发表。</p>'
          + '<p><a href="/forward.jsp?bid=33">回列表</a></p>'
          + '<p><a href="/forward.jsp?bid=33&amp;action=post">再发一条</a></p>');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/mobile/groups') {
        sendHtml(response, 200, '私服群聊管理',
          homePage(store, url.searchParams.get('mode') || '', url.searchParams.get('q') || ''));
        return;
      }
      if (request.method !== 'POST' || !url.pathname.startsWith('/mobile/groups/')) {
        sendPage(request, response, 404, '未找到', '<p class="err">页面不存在。</p>',
          '<p>页面不存在。</p>');
        return;
      }
      const body = await readForm(request);
      const account = authenticate(store, body);
      if (url.pathname === '/mobile/groups/create') {
        const memberUins = String(body.members || '').split(/[,，\s]+/)
          .filter(Boolean).map((value) => positiveInteger(value, '成员 QQ 号'));
        const group = store.createGroup({
          ownerUin: account.uin, memberUins,
          title: String(body.title || '').trim() || `${account.nickname}的群聊`,
          type: 'group',
        });
        pushGroupDiscovery(group, group.members.map((member) => member.uin), 'mobile_created');
        logger({ event: 'mobile_group_created', uin: account.uin, groupId: group.id,
          memberUins: group.members.map((member) => member.uin) });
        sendHtml(response, 201, '创建成功', `<p class="ok">群“${escapeHtml(group.title)}”创建成功，群号：`
          + `<b>${group.publicId}</b>。</p>` + groupList(store, String(group.publicId)));
        return;
      }
      const groupId = positiveInteger(body.groupId, '群号');
      const group = store.getGroup(groupId);
      if (!group || group.type !== 'group') throw new Error('没有找到这个群');
      if (url.pathname === '/mobile/groups/join') {
        const result = store.inviteGroupMember(group.id, group.ownerUin, account.uin);
        if (!result.ok) throw new Error(result.reason);
        if (!result.alreadyMember) pushGroupDiscovery(group, [account.uin], 'mobile_joined');
        logger({ event: 'mobile_group_joined', uin: account.uin, groupId: group.id,
          alreadyMember: result.alreadyMember });
        sendHtml(response, 200, '加入成功', `<p class="ok">已加入“${escapeHtml(group.title)}”。`
          + '返回 QQ 后如未立即出现，请重新登录一次。</p>');
        return;
      }
      if (url.pathname === '/mobile/groups/invite') {
        if (!group.members.some((member) => member.uin === account.uin)) {
          throw new Error('只有群成员可以邀请用户');
        }
        const memberUin = positiveInteger(body.memberUin, '被邀请人 QQ 号');
        const result = store.inviteGroupMember(group.id, account.uin, memberUin);
        if (!result.ok) throw new Error(result.reason);
        if (!result.alreadyMember) pushGroupDiscovery(group, [memberUin], 'mobile_invited');
        logger({ event: 'mobile_group_member_invited', uin: account.uin,
          groupId: group.id, memberUin, alreadyMember: result.alreadyMember });
        sendHtml(response, 200, '邀请成功', `<p class="ok">已邀请 ${memberUin} 加入“`
          + `${escapeHtml(group.title)}”。</p>`);
        return;
      }
      sendHtml(response, 404, '未找到', '<p class="err">页面不存在。</p>');
    } catch (error) {
      logger({ event: errorEvent, method: request.method,
        url: request.url, message: error.message });
      if (!response.headersSent) {
        sendHtml(response, 400, '操作失败', `<p class="err">${escapeHtml(error.message)}</p>`
          + '<p><a href="/mobile/groups">返回重试</a></p>');
      } else response.destroy();
    }
  });
  const connectionEvent = requestEvent.endsWith('_request')
    ? `${requestEvent.slice(0, -8)}_connection` : `${requestEvent}_connection`;
  server.on('connection', (socket) => {
    logger({
      event: connectionEvent,
      peer: String(socket.remoteAddress || '').replace(/^::ffff:/, ''),
      peerPort: socket.remotePort || 0,
    });
  });
  return server;
}

module.exports = { createMobileGroupServer, escapeHtml, readForm };
