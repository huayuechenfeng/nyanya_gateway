'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inspectAoDirectMode } = require('./class-direct-http-patcher');
const { makeNetworkRestricted } = require('./local-network-guard');

function constantSize(tag) {
  if (tag === 3 || tag === 4) return 4;
  if (tag === 5 || tag === 6) return 8;
  if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) return 2;
  if (tag === 9 || tag === 10 || tag === 11 || tag === 12
      || tag === 17 || tag === 18) return 4;
  if (tag === 15) return 3;
  throw new Error(`unsupported constant-pool tag ${tag}`);
}

function utf8Constants(input) {
  if (input.length < 10 || input.readUInt32BE(0) !== 0xCAFEBABE) {
    throw new Error('not a Java class file');
  }
  const values = [];
  const count = input.readUInt16BE(8);
  let position = 10;
  for (let index = 1; index < count; index += 1) {
    if (position >= input.length) throw new Error('truncated constant pool');
    const tag = input[position++];
    if (tag === 1) {
      if (position + 2 > input.length) throw new Error('truncated UTF-8 constant');
      const length = input.readUInt16BE(position);
      position += 2;
      if (position + length > input.length) throw new Error('truncated UTF-8 value');
      values.push(input.subarray(position, position + length).toString('utf8'));
      position += length;
    }
    else {
      position += constantSize(tag);
      if (position > input.length) throw new Error('truncated constant-pool entry');
      if (tag === 5 || tag === 6) index += 1;
    }
  }
  return values;
}

function filesUnder(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  return files.sort();
}

function parseManifest(text) {
  const unfolded = [];
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith(' ') && unfolded.length > 0) unfolded[unfolded.length - 1] += line.slice(1);
    else unfolded.push(line);
  }
  const values = {};
  for (const line of unfolded) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    values[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return values;
}

function isQq2008OrEarlier(manifest) {
  const version = String(manifest['MIDlet-Version'] || '');
  const identity = `${manifest['MIDlet-Name'] || ''} ${manifest['MIDlet-1'] || ''}`;
  const yearMatch = identity.match(/QQ\s*(20\d{2})/i);
  return version === '12.05.2' || (yearMatch && Number(yearMatch[1]) <= 2008);
}

function classifyInventory(inventory) {
  const version = inventory.manifest['MIDlet-Version'] || '';
  const routeKind = inventory.aoHttpRoute ? inventory.aoHttpRoute.routeKind : '';
  const isMobileQq12 = version === '12.0.16';
  let profileId = 'generic-tcp-core';
  let supportLevel = 'experimental-tcp';
  let displayName = '通用 TCP 核心模式（实验性）';

  if (isMobileQq12 && inventory.hasHttpClass
      && (routeKind === 'http-jl-helper' || routeKind === 'http-open-helper')) {
    profileId = 'mobileqq-12.0.16-http-helper';
    supportLevel = 'full';
    displayName = 'MobileQQ 12.0.16 HTTP 辅助类版（完整补丁）';
  }
  else if (isMobileQq12 && routeKind === 'connector-direct') {
    profileId = 'mobileqq-12.0.16-connector-direct';
    supportLevel = 'full';
    displayName = 'MobileQQ 12.0.16 原生直连版（完整补丁）';
  }

  const groupBids = new Set(inventory.groupBids);
  const fullProfile = supportLevel === 'full';
  const warnings = [];
  if (!inventory.socketEndpointCount) {
    warnings.push('没有发现可替换的 socket://...:14000 常量，不能生成客户端。');
  }
  if (supportLevel !== 'full') {
    warnings.push('该版本只执行 TCP 地址替换和局域网隔离；登录、好友、群组与消息协议尚未实机验证。');
  }
  if (supportLevel !== 'full' && isQq2008OrEarlier(inventory.manifest)) {
    warnings.push('QQ2008 及以下存在已知登录兼容性风险；QQ2008 12.05.2 实测会提示“付费用户余额不足（ID 31）”。推荐使用 QQ2009 及以上版本。');
  }
  if (fullProfile && (!groupBids.has('205') || !groupBids.has('342'))) {
    warnings.push('没有同时发现 bid=205/342 群网页入口，将跳过群网页重定向。');
  }
  if (inventory.signedEntries.length > 0) {
    warnings.push('JAR 带有签名文件；修改后签名会失效，因此拒绝生成。');
  }

  return {
    profileId,
    supportLevel,
    displayName,
    patches: {
      methodReference: fullProfile && routeKind === 'http-jl-helper',
      httpHelper: fullProfile && (routeKind === 'http-jl-helper' || routeKind === 'http-open-helper'),
      forceAoDirect: fullProfile,
      groupWeb: fullProfile && groupBids.has('205') && groupBids.has('342'),
    },
    warnings,
  };
}

function analyzeTree(rootArgument, allowedHost) {
  const root = path.resolve(rootArgument);
  const files = filesUnder(root);
  const classFiles = files.filter((file) => file.endsWith('.class'));
  const manifestPath = path.join(root, 'META-INF', 'MANIFEST.MF');
  if (!fs.existsSync(manifestPath)) throw new Error('JAR staging tree has no META-INF/MANIFEST.MF');
  const manifest = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
  const socketEndpoints = [];
  const groupBids = new Set();
  const externalNetworkLiterals = [];

  for (const file of classFiles) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    for (const value of utf8Constants(fs.readFileSync(file))) {
      if (/^socket:\/\/[^/:]+:14000$/.test(value)) socketEndpoints.push({ file: relative, value });
      try {
        const parsed = new URL(value);
        if (/^https?:$/.test(parsed.protocol) && parsed.searchParams.has('bid')) {
          groupBids.add(parsed.searchParams.get('bid'));
        }
      }
      catch (_) {
        // Most UTF-8 constants are not URLs.
      }
      if (makeNetworkRestricted(value, allowedHost) !== value) {
        externalNetworkLiterals.push({ file: relative, value });
      }
    }
  }

  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  if (makeNetworkRestricted(manifestText, allowedHost) !== manifestText) {
    externalNetworkLiterals.push({ file: 'META-INF/MANIFEST.MF', value: '<manifest>' });
  }

  const aoPath = path.join(root, 'ao.class');
  let aoHttpRoute = null;
  let aoInspectionError = '';
  if (fs.existsSync(aoPath)) {
    try { aoHttpRoute = inspectAoDirectMode(fs.readFileSync(aoPath)); }
    catch (error) { aoInspectionError = error.message; }
  }

  const signedEntries = files
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .filter((file) => /^META-INF\/.*\.(?:SF|RSA|DSA|EC)$/i.test(file));
  const inventory = {
    manifest,
    classCount: classFiles.length,
    entryCount: files.length,
    hasAoClass: fs.existsSync(aoPath),
    hasHttpClass: fs.existsSync(path.join(root, 'http.class')),
    signedEntries,
    socketEndpointCount: socketEndpoints.length,
    socketEndpoints,
    groupBids: Array.from(groupBids).sort((a, b) => Number(a) - Number(b)),
    externalNetworkLiteralCount: externalNetworkLiterals.length,
    externalNetworkLiterals,
    aoHttpRoute,
    aoInspectionError,
  };
  return { ...inventory, profile: classifyInventory(inventory) };
}

function main(args) {
  if (args.length < 1 || args.length > 2) {
    throw new Error('usage: client-jar-analyzer.js STAGING_ROOT [ALLOWED_HOST]');
  }
  process.stdout.write(JSON.stringify(analyzeTree(args[0], args[1] || '')) + '\n');
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`Client JAR analysis failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { analyzeTree, classifyInventory, isQq2008OrEarlier, parseManifest, utf8Constants };
