# One-time DEV setup: install the bundled tailscaled as the Windows "Tailscale"
# service via tailscaled's own installer, START it, then grant your non-admin
# user operator rights so the desktop app can drive it without elevation.
# Uses the bundled wintun.dll for the TUN adapter.
#
# RUN AS ADMINISTRATOR: right-click -> "Run with PowerShell" (accept UAC).
#
# ErrorActionPreference is 'Continue' on purpose: tailscaled writes notices to
# stderr which would otherwise abort the script on PowerShell 5.1.

$ErrorActionPreference = 'Continue'
$bin = 'd:\ai-project\ai-workspace-desktopapp\vendor\tailscale\win\x64'
$tsd = Join-Path $bin 'tailscaled.exe'
$ts  = Join-Path $bin 'tailscale.exe'

if (-not (Test-Path $tsd)) { Write-Host "ERROR: tailscaled.exe not found at $tsd" -ForegroundColor Red; exit 1 }

# 1. Remove the earlier hand-rolled service, if present.
if (Get-Service AIWorkspaceTailscale -ErrorAction SilentlyContinue) {
  Write-Host 'Removing old AIWorkspaceTailscale service...'
  Stop-Service AIWorkspaceTailscale -Force -ErrorAction SilentlyContinue
  sc.exe delete AIWorkspaceTailscale | Out-Null
  Start-Sleep -Seconds 2
}

# 2. (Re)install the proper "Tailscale" service via tailscaled's own installer.
Write-Host 'Reinstalling Tailscale service...'
& $tsd uninstall-system-daemon
Start-Sleep -Seconds 1
& $tsd install-system-daemon
Start-Sleep -Seconds 3

# 3. Ensure auto-start and START it now (this elevated context can).
Set-Service Tailscale -StartupType Automatic -ErrorAction SilentlyContinue
Start-Service Tailscale -ErrorAction SilentlyContinue

# 4. Wait until the daemon answers, THEN set the operator (must be running).
Write-Host 'Waiting for tailscaled to come up...'
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 2
  $s = (& $ts status) 2>&1 | Out-String
  if ($s -notmatch 'failed to connect') { break }
}
& $ts set --operator=$env:USERNAME

Write-Host "`n=== service ===" -ForegroundColor Cyan
Get-Service Tailscale -ErrorAction SilentlyContinue | Format-Table -AutoSize
Write-Host "=== tailscale status (expect 'Logged out', NOT 'NoState' and NOT 'failed to connect') ===" -ForegroundColor Cyan
& $ts status
Write-Host "`nDone. Tell Claude to launch the app." -ForegroundColor Green
