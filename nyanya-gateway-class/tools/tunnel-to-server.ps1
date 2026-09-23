<#
  Keeps an SSH reverse tunnel alive, so the gateway running on the server can reach
  the NapCat instance running at home.

  Direction (read carefully):
    server 127.0.0.1:3001   -->   this machine 127.0.0.1:3001 (NapCat)

  The gateway on the server dials ws://127.0.0.1:3001; because of this reverse forward
  that connection lands on NapCat here at home. NapCat never needs a public address.

  This machine (the one running NapCat) must stay on for the phone to work.

  IMPORTANT: keep this file pure ASCII. Windows PowerShell 5.1 decodes a BOM-less .ps1
  as ANSI, so a non-ASCII comment can silently swallow the following line of code.

  STALE PORT RECOVERY
  When the network drops the SSH connection, the client exits but the server-side sshd
  child may keep holding 127.0.0.1:<RemotePort> for a long time. Every later attempt then
  dies instantly with exit 255 ("remote port forwarding failed") and the tunnel never
  comes back by itself. This script detects that failure and kills the stale server-side
  listener before retrying. Server-side ClientAliveInterval also helps; see REMOTE-DEPLOY.md.
#>
param(
  [string]$SshTarget = '服务器名',
  [int]$RemotePort = 3001,
  [int]$LocalPort = 3001,
  [int]$RetryDelaySeconds = 5
)

$ErrorActionPreference = 'Continue'

$ssh = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
if (-not (Test-Path -LiteralPath $ssh)) { $ssh = 'ssh' }

$logDir = Join-Path $env:LOCALAPPDATA 'nyanya-tunnel'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'tunnel.log'

function Write-Log([string]$Message) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  try { Add-Content -LiteralPath $logFile -Value $line -Encoding utf8 } catch { }
}

# Kill whatever sshd child on the server still listens on the forward port.
# Safe to run: this cleanup session never binds that port itself.
function Clear-StaleRemoteListener {
  $cmd = 'P=$(ss -ltnp 2>/dev/null | grep -F "127.0.0.1:' + $RemotePort + '" | grep -oE ''pid=[0-9]+'' | head -n1 | cut -d= -f2); if [ -n "$P" ]; then kill "$P" && echo "killed stale listener pid $P" || echo "kill failed pid $P"; else echo "no stale listener"; fi'
  $result = & $ssh -n -o BatchMode=yes -o ConnectTimeout=15 $SshTarget $cmd 2>&1
  $text = ($result | Out-String).Trim()
  if ([string]::IsNullOrWhiteSpace($text)) { $text = '(no output)' }
  Write-Log "  cleanup: $text"
  return $text
}

Write-Log 'nyanya reverse tunnel (home NapCat -> server gateway)'
Write-Log "  ssh target : $SshTarget"
Write-Log "  forward    : server 127.0.0.1:$RemotePort  ->  local 127.0.0.1:$LocalPort"
Write-Log "  log file   : $logFile"
Write-Log '  Keep this window open. Press Ctrl+C to stop.'
Write-Log ''

$attempt = 0
$consecutiveFailures = 0
$lastCleanup = [datetime]::MinValue

while ($true) {
  $attempt++
  Write-Log "connecting (attempt $attempt) ..."

  $output = & $ssh -N -T `
    -o BatchMode=yes `
    -o ExitOnForwardFailure=yes `
    -o ServerAliveInterval=15 `
    -o ServerAliveCountMax=4 `
    -o TCPKeepAlive=yes `
    -o ConnectTimeout=15 `
    -R "${RemotePort}:127.0.0.1:${LocalPort}" `
    $SshTarget 2>&1

  $code = $LASTEXITCODE
  $text = ($output | Out-String).Trim()

  if ($code -eq 0) {
    Write-Log 'tunnel closed normally'
    $consecutiveFailures = 0
    Start-Sleep -Seconds $RetryDelaySeconds
    continue
  }

  $consecutiveFailures++
  Write-Log "tunnel exited with code $code"
  if (-not [string]::IsNullOrWhiteSpace($text)) {
    foreach ($line in ($text -split "`r?`n")) {
      if (-not [string]::IsNullOrWhiteSpace($line)) { Write-Log "  ssh: $line" }
    }
  }

  $portBusy = ($text -match 'remote port forwarding failed') -or
              ($text -match 'Address already in use') -or
              ($text -match 'cannot listen to local port')
  $cooldownOk = ((Get-Date) - $lastCleanup).TotalSeconds -gt 45

  if (($portBusy -or $consecutiveFailures -ge 3) -and $cooldownOk) {
    Write-Log '  forward port looks stuck on the server; trying to clear it ...'
    Clear-StaleRemoteListener | Out-Null
    $lastCleanup = Get-Date
  }

  if ($attempt -le 2) {
    Write-Log '  hint: if this repeats immediately, the SSH key may need a passphrase.'
    Write-Log '        Run "ssh 服务器名" once in a normal window first, or start ssh-agent.'
    Write-Log '  hint: code 255 with "remote port forwarding failed" means something on the'
    Write-Log "        server already holds 127.0.0.1:$RemotePort (a dead tunnel session)."
    Write-Log '        This script clears that automatically; see REMOTE-DEPLOY.md.'
  }

  Write-Log "reconnecting in $RetryDelaySeconds s ..."
  Write-Log ''
  Start-Sleep -Seconds $RetryDelaySeconds
}
