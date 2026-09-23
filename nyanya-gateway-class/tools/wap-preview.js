'use strict';

// WAP 页面预览（只读）。
//
// 迭代 WAP 页时的痛点是反馈环太长：改代码 -> 重启网关 -> 装/开模拟器 -> 点手机。
// 这个脚本把线上 sqlite **拷一份**到临时目录（绝不写线上库），用真实数据
// 在随机端口上跑一次 createMobileGroupServer，然后把手机视角（Accept 带
// text/vnd.wap.wml）看到的原始 WML 打出来，PC 视角也一并打出来对照。
//
// 用法：
//   node tools/wap-preview.js                       # 默认预览 bid=202 群聊天记录
//   node tools/wap-preview.js 202 1126386035        # 指定 bid 与内部群 id
//   node tools/wap-preview.js 203 1126386035
//   node tools/wap-preview.js 331 <媒体id>
//   node tools/wap-preview.js 0                     # bid=0 → 腾讯网 WAP 门户
//   node tools/wap-preview.js 20                    # bid=20 → 腾讯网门户（等价）
//
// 支持 bid=202/203/204（群记录/群成员），331 / mobile/media（看图/语音），
// 以及腾讯网门户（bid=0 / bid=20 / 根路径）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccountStore } = require('../legacy/store');
const { createMobileGroupServer } = require('../legacy/mobile-group-server');

const DATA_DIR = path.join(__dirname, '..', 'nyanya-data');
const LEGACY_ACCEPT = 'text/vnd.wap.wml,image/*,audio/*,'
  + 'text/vnd.sun.j2me.app-descriptor,application/*';
const DESKTOP_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

function copyDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyanya-wap-preview-'));
  for (const name of ['nyanya.sqlite', 'nyanya.sqlite-wal', 'nyanya.sqlite-shm']) {
    try { fs.copyFileSync(path.join(DATA_DIR, name), path.join(dir, name)); }
    catch (error) { /* -wal/-shm 不一定存在 */ }
  }
  return dir;
}

async function main() {
  const bid = process.argv[2] || '202';
  const argument = process.argv[3];
  const dir = copyDatabase();
  const store = new AccountStore(path.join(dir, 'nyanya.sqlite'));
  const groups = store.listGroups().filter((group) => group.type === 'group');

  console.log(`groups in nyanya-data: ${groups.length}`);
  for (const group of groups) {
    const rows = store.recentGroupMessages(group.id, 50);
    console.log(`  id=${group.id} publicId=${group.publicId} title=${group.title}`
      + ` members=${group.members.length} messages=${rows.length}`);
  }

  let query;
  if (bid === '0' || bid === '20') {
    // 腾讯网门户：根路径与 forward.jsp?bid=0/20 均可直出<｜image｜>门户。
    query = bid === '0' ? '' : `bid=${bid}`;
    console.log('\nrendering 腾讯网 WAP 门户');
  } else if (bid === '202' || bid === '203' || bid === '204') {
    const target = (argument && groups.find((group) => Number(group.id) === Number(argument)))
      || groups.find((group) => store.recentGroupMessages(group.id, 1).length) || groups[0];
    if (!target) {
      console.log('no group in nyanya-data — nothing to render');
      store.close();
      return;
    }
    query = `bid=${bid}&groupID=${target.id}&fqq=10001`;
    console.log(`\nrendering group "${target.title}" (id=${target.id})`);
  } else if (bid === '331' || bid === 'mobile/media') {
    const media = (store.data.media || []).slice(-1)[0];
    if (!media) {
      console.log('no media in nyanya-data — nothing to render');
      store.close();
      return;
    }
    query = `bid=331&pic=${encodeURIComponent(media.id)}`;
    console.log(`\nrendering the latest media ${media.id}`);
  } else {
    query = `bid=${encodeURIComponent(bid)}`;
  }

  const server = createMobileGroupServer({ store, logger: () => {} });
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    for (const [label, accept] of [['PHONE (WML)', LEGACY_ACCEPT],
      ['PC (HTML)', DESKTOP_ACCEPT]]) {
      const url = `http://127.0.0.1:${port}/forward.jsp?${query}`;
      const response = await fetch(url, { headers: { accept } });
      const body = await response.text();
      console.log(`\n=== ${label}  status=${response.status}`
        + `  content-type=${response.headers.get('content-type')}`
        + `  bytes=${Buffer.byteLength(body, 'utf8')}`);
      console.log(body.length > 4000 ? `${body.slice(0, 4000)}\n…(truncated)` : body);
    }
  } finally {
    server.close();
    store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
