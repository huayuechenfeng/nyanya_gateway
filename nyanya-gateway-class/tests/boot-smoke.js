'use strict';

// 入口启动冒烟测试。
//
// 为什么需要它：self-test.js 只 require 各个 core/legacy 模块，**从不加载
// server.js**（server.js 末尾直接调 main()，require 它等于启动网关）。
// 于是「新增了一个模块、忘了在 server.js 顶层 require」这类错误能骗过所有
// 自检，直到真正启动才炸（2026-09-20：createReplayCursors is not defined）。
//
// 这个测试真的把 server.js 拉起来，用临时端口 + 临时数据目录 + 指向不存在的
// NapCat 端口，确认它能装配完成、三个监听都起来，然后杀掉。
//
// 用法：node tests/boot-smoke.js

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TIMEOUT_MS = 15000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function findFreePort(from) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => {
      if (from > from + 200) reject(new Error('no free port'));
      else findFreePort(from + 1).then(resolve, reject);
    });
    probe.listen(from, '0.0.0.0', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function run() {
  return new Promise((resolve, reject) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyanya-boot-smoke-'));
    const base = 15400 + Math.floor(Math.random() * 400);
    // 默认测真正的入口。留这个覆盖点是为了能拿「故意坏掉的替身脚本」自测
    // 这个测试本身是否真的会失败（见 README/记忆里的负向验证说明）。
    const entry = process.env.NYANYA_BOOT_ENTRY || path.join(ROOT, 'server.js');

    findFreePort(base).then((port) => {
      const env = Object.assign({}, process.env, {
        NYANYA_PORT: String(port),
        NYANYA_ADMIN_PORT: String(port + 1),
        NYANYA_MOBILE_PORT: String(port + 2),
        NYANYA_DATA_DIR: dataDir,
        // 指向一个必然连不上的端口，测试不依赖 NapCat 是否在跑。
        NYANYA_ONEBOT_URL: 'ws://127.0.0.1:39999',
      });

      const child = spawn(process.execPath, [entry], {
        cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      let exitCode = null;
      let settled = false;
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk) => { output += chunk.toString(); });
      child.on('exit', (code) => { exitCode = code; });

      function finish(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poller);
        try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
        setTimeout(() => {
          try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
          if (err) reject(err); else resolve();
        }, 200);
      }

      const timer = setTimeout(() => {
        finish(new Error(`网关启动超时（${TIMEOUT_MS}ms 内没有监听）。输出：\n${output}`));
      }, TIMEOUT_MS);

      const poller = setInterval(() => {
        if (exitCode !== null) {
          finish(new Error(
            `网关启动即退出（exitCode=${exitCode}）。输出：\n${output}`));
          return;
        }
        // 三个服务都报出监听才算装配成功。
        const hits = ['已监听', '管理页已监听', '媒体/WAP 服务已监听']
          .filter((needle) => output.includes(needle));
        if (hits.length === 3) finish(null);
      }, 120);
    }, reject);
  });
}

run().then(() => {
  console.log('nyanya gateway boot smoke passed.');
}, (err) => {
  console.error('boot smoke FAILED:', err.message);
  process.exit(1);
});
