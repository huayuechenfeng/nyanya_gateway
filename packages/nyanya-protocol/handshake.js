'use strict';

const { VERSION } = require('./frame');

const PROTOCOL_VERSION = VERSION;
const SUPPORTED_VERSIONS = Object.freeze([PROTOCOL_VERSION]);
const CAPABILITY = Object.freeze({
  TEXT: 'text',
  CONTACTS: 'contacts',
  HISTORY: 'history',
  NOTICE: 'notice',
  OFFLINE: 'offline',
});
const SERVER_CAPABILITIES = Object.freeze([
  CAPABILITY.TEXT,
  CAPABILITY.CONTACTS,
  CAPABILITY.HISTORY,
  CAPABILITY.NOTICE,
  CAPABILITY.OFFLINE,
]);

function normalizeCapabilities(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const capability = item.trim();
    if (!capability || seen.has(capability)) continue;
    seen.add(capability);
    result.push(capability);
  }
  return result;
}

function negotiateAuth(payload, options) {
  const request = payload && typeof payload === 'object' ? payload : {};
  const opts = options || {};
  const supportedVersions = Array.isArray(opts.supportedVersions)
    ? opts.supportedVersions.slice() : SUPPORTED_VERSIONS.slice();
  const serverCapabilities = normalizeCapabilities(
    Array.isArray(opts.serverCapabilities) ? opts.serverCapabilities : SERVER_CAPABILITIES);
  const legacyClient = request.protocolVersion === undefined
    || request.protocolVersion === null || request.protocolVersion === '';
  const requestedVersion = legacyClient ? PROTOCOL_VERSION : Number(request.protocolVersion);

  if (!Number.isInteger(requestedVersion) || !supportedVersions.includes(requestedVersion)) {
    return {
      ok: false,
      code: 'unsupported_protocol_version',
      message: 'unsupported protocol version: ' + String(request.protocolVersion),
      supportedVersions,
    };
  }

  const requestedCapabilities = legacyClient
    ? serverCapabilities : normalizeCapabilities(request.capabilities);
  const supportedSet = new Set(serverCapabilities);
  return {
    ok: true,
    protocolVersion: requestedVersion,
    capabilities: requestedCapabilities.filter((item) => supportedSet.has(item)),
    legacyClient,
  };
}

module.exports = {
  CAPABILITY,
  PROTOCOL_VERSION,
  SERVER_CAPABILITIES,
  SUPPORTED_VERSIONS,
  negotiateAuth,
  normalizeCapabilities,
};
