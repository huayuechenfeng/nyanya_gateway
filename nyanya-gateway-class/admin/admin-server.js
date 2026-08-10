'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { EMPTY_DIGEST } = require('../legacy/store');

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > (limit || 1 * 1024 * 1024)) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function createAdminServer(options) {
  const config = options.config;
  const store = options.store;
  const backend = options.backend;
  const logger = options.logger || console;
  const logBuffer = options.logBuffer || [];
  const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

  function authorized(request, url) {
    if (!config.adminToken) return true;
    const header = request.headers.authorization || '';
    return header === 'Bearer ' + config.adminToken
      || url.searchParams.get('token') === config.adminToken;
  }

  function deviceAccounts() {
    return store.listAccounts().filter((account) =>
      (account.profile && account.profile.nyanyaDevice)
      || account.passwordDigest !== EMPTY_DIGEST);
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      if (!authorized(request, url)) {
        sendJson(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      if (request.method === 'GET' && pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(indexHtml);
        return;
      }
      if (request.method === 'GET' && pathname === '/api/status') {
        sendJson(response, 200, {
          ok: true,
          status: backend.status(),
          adminPort: config.adminPort,
          mobilePort: config.mobilePort,
        });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/device') {
        sendJson(response, 200, {
          ok: true,
          devices: deviceAccounts().map((account) => ({
            uin: account.uin,
            nickname: account.nickname,
            enabled: account.enabled,
            hasToken: account.passwordDigest !== EMPTY_DIGEST,
          })),
        });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/device') {
        const body = JSON.parse((await readBody(request)) || '{}');
        const uin = Number(body.uin);
        const token = String(body.token || '');
        if (!Number.isInteger(uin) || uin <= 0 || uin > 0xFFFFFFFF) {
          throw new Error('QQ 号必须是正整数');
        }
        if (!token) throw new Error('token 不能为空');
        let account = store.get(uin);
        if (account) {
          store.resetPassword(uin, token);
        } else {
          account = store.addAccount({
            uin,
            nickname: String(uin),
            password: token,
            type: 'human',
          });
        }
        account.profile = Object.assign({}, account.profile || {}, { nyanyaDevice: true });
        store.save();
        logger.log(`[admin] 设备账号已保存: ${uin}`);
        const selfId = backend.selfId || 0;
        sendJson(response, 200, {
          ok: true,
          uin,
          mustMatchNapcat: selfId ? (uin === selfId) : true,
          warning: selfId && uin !== selfId
            ? `注意：当前 NapCat self_id=${selfId}，与该设备 QQ 号不一致时老客户端无法登录。`
            : undefined,
        });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/refresh') {
        if (!backend.connected) throw new Error('NapCat 未连接');
        const result = await backend.refreshMirror();
        sendJson(response, 200, { ok: true, result });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/logs') {
        const lines = Math.max(1, Math.min(1000, Number(url.searchParams.get('lines') || 200)));
        sendJson(response, 200, { ok: true, lines: logBuffer.slice(-lines) });
        return;
      }
      sendJson(response, 404, { ok: false, error: 'not found' });
    } catch (error) {
      logger.error('[admin] ' + error.message);
      if (!response.headersSent) {
        sendJson(response, 400, { ok: false, error: error.message });
      } else {
        response.destroy();
      }
    }
  });
  return server;
}

module.exports = { createAdminServer };
