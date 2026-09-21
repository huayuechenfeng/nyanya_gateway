#!/usr/bin/env bash
#
# Deploy nyanya-gateway-class as a systemd service on a Linux server.
#
# Run this ON the server as root. It expects two files already uploaded to /tmp:
#   - a release zip produced by `npm run release` (release/Nyanya-Gateway-Class-v*.zip)
#   - a server-side config.json (start from config.example.json and fill in
#     dataDir, mediaPublicHost, loginPublicHost, onebotToken, deviceToken)
#
# Layout produced (everything on the data disk, never the system disk):
#   /data/jar/nyanya/gateway/nyanya-gateway-class/   <- gateway code
#   /data/jar/nyanya/gateway/packages/               <- shared packages (must stay siblings)
#   /data/jar/nyanya/data/                           <- sqlite + gateway.jsonl
#
# Usage:
#   bash deploy-server.sh [--pkg /tmp/pkg.zip] [--config /tmp/config.json] [--root /data/jar/nyanya]
#
set -euo pipefail

PKG=/tmp/nyanya-class.zip
CONFIG=/tmp/nyanya-server-config.json
ROOT=/data/jar/nyanya
GATEWAY=$ROOT/gateway
DATA=$ROOT/data
SERVICE=nyanya-gateway
RUN_USER=nyanya
NODE_BIN=/usr/local/bin/node

while [ $# -gt 0 ]; do
  case "$1" in
    --pkg) PKG=$2; shift 2 ;;
    --config) CONFIG=$2; shift 2 ;;
    --root) ROOT=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Recompute after --root.
GATEWAY=$ROOT/gateway
DATA=$ROOT/data

echo "=== 0/7 preconditions ==="
[ "$(id -u)" = "0" ] || { echo "must run as root" >&2; exit 1; }
[ -f "$PKG" ] || { echo "package not found: $PKG" >&2; exit 1; }
[ -f "$CONFIG" ] || { echo "config not found: $CONFIG" >&2; exit 1; }
[ -x "$NODE_BIN" ] || { echo "node not found at $NODE_BIN" >&2; exit 1; }
"$NODE_BIN" -e "require('node:sqlite')" || { echo "node lacks node:sqlite (need >= 22.5)" >&2; exit 1; }
"$NODE_BIN" -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$CONFIG" \
  || { echo "config is not valid JSON" >&2; exit 1; }
echo "node $("$NODE_BIN" -v), package $PKG, config $CONFIG"

echo "=== 1/7 extract ==="
rm -rf "$GATEWAY"
mkdir -p "$GATEWAY"
python3 -m zipfile -e "$PKG" "$GATEWAY"

echo "=== 2/7 layout check ==="
# server.js requires ../packages/*, so packages/ must sit beside nyanya-gateway-class/.
for path in \
  "$GATEWAY/nyanya-gateway-class/server.js" \
  "$GATEWAY/nyanya-gateway-class/config.js" \
  "$GATEWAY/nyanya-gateway-class/core/replay-cursor.js" \
  "$GATEWAY/packages/gateway-core/index.js" \
  "$GATEWAY/packages/onebot-adapter/index.js"
do
  [ -f "$path" ] || { echo "missing: $path" >&2; exit 1; }
  echo "  ok  ${path#"$GATEWAY/"}"
done

echo "=== 3/7 service account and data dir ==="
if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
  echo "created user $RUN_USER"
else
  echo "user $RUN_USER already exists"
fi
mkdir -p "$DATA"
chown -R "$RUN_USER:$RUN_USER" "$ROOT"

echo "=== 4/7 install config ==="
install -m 600 -o "$RUN_USER" -g "$RUN_USER" "$CONFIG" "$GATEWAY/nyanya-gateway-class/config.json"
echo "installed config.json (mode 600, owner $RUN_USER)"
"$NODE_BIN" -e "
const c = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
for (const k of ['port', 'mobilePort', 'adminHost', 'adminPort', 'onebotUrl', 'dataDir', 'mediaPublicHost', 'loginPublicHost']) {
  console.log('  ' + k + ' = ' + JSON.stringify(c[k]));
}
console.log('  deviceToken length = ' + String(c.deviceToken || '').length);
" "$GATEWAY/nyanya-gateway-class/config.json"

echo "=== 5/7 systemd unit ==="
cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=Nyanya Gateway Class (legacy J2ME/Symbian QQ compatibility gateway)
After=network-online.target
Wants=network-online.target
# Code and data live on the data disk; do not start before it is mounted.
RequiresMountsFor=$ROOT

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$GATEWAY/nyanya-gateway-class
ExecStart=$NODE_BIN $GATEWAY/nyanya-gateway-class/server.js
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=15
# The gateway talks to NapCat over ws://127.0.0.1:3001 (an SSH reverse tunnel from home).
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
echo "wrote /etc/systemd/system/$SERVICE.service and enabled it"

echo "=== 6/7 start ==="
systemctl restart "$SERVICE"
sleep 4

echo "=== 7/7 verify ==="
STATE=$(systemctl is-active "$SERVICE" || true)
echo "service state: $STATE"
echo "--- listening ---"
ss -lntp | grep -E ':(14000|13980|13981)\b' || echo "  (nothing listening on 14000/13980/13981!)"
echo "--- recent journal ---"
journalctl -u "$SERVICE" --no-pager -n 40 --output=cat || true

if [ "$STATE" != "active" ]; then
  echo "DEPLOY FAILED: service is $STATE" >&2
  exit 1
fi
echo "DEPLOY OK"
