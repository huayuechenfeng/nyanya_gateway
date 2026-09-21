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
      if (request.method === 'GET' && url.pathname === '/forward.jsp') {
        const bid = url.searchParams.get('bid');
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
        sendPage(request, response, 200, '网关兼容页面',
          `<p>原腾讯 WAP 功能编号：${escapeHtml(bid || '未知')}。</p>`
          + '<p>该入口已经由网关接管，但第一版只开放建群、查群、图片和语音页面。</p>',
          `<p>功能编号 ${escapeHtml(bid || '未知')} 已经由网关接管。</p>`
          + '<p>手机端目前只开放看图与语音。</p>');
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
