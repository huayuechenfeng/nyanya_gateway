'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 配置优先级：环境变量 > gateway/config.json > 默认值
function loadConfig(overrides) {
  const file = path.join(__dirname, 'config.json');
  let fileCfg = {};
  if (fs.existsSync(file)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error('bad gateway/config.json: ' + err.message);
    }
  }
  const env = process.env;
  const config = {
    host: env.GATEWAY_HOST || fileCfg.host || '127.0.0.1',
    port: Number(env.GATEWAY_PORT || fileCfg.port || 14000),
    token: env.DEVICE_TOKEN || fileCfg.token || 'j2me-qq-dev-token',
    onebotUrl: env.ONEBOT_WS_URL || fileCfg.onebotUrl || 'ws://127.0.0.1:3001',
    onebotToken: env.ONEBOT_TOKEN || fileCfg.onebotToken || '',
    heartbeatMs: Number(env.HEARTBEAT_MS || fileCfg.heartbeatMs || 30000),
    sendMinIntervalMs: Number(env.SEND_MIN_INTERVAL_MS || fileCfg.sendMinIntervalMs || 800),
    sendMaxPerMinute: Number(env.SEND_MAX_PER_MINUTE || fileCfg.sendMaxPerMinute || 30),
    offlineCap: Number(env.OFFLINE_CAP || fileCfg.offlineCap || 200),
    historyCap: Number(env.HISTORY_CAP || fileCfg.historyCap || 100),
    log: console
  };
  if (overrides) Object.assign(config, overrides);
  return config;
}

module.exports = { loadConfig };
