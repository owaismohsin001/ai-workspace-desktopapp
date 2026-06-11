# Elevated: replace our hand-rolled tailscaled service with the OFFICIAL
# Tailscale MSI (proper wintun driver + WFP + service), then grant operator.
# Logs to a file Claude can read.
$ErrorActionPreference = 'Continue'
$log = 'd:\ai-project\_official-ts-install.log'
"=== starting official Tailscale install ===" | Set-Content $log

# 1. Remove the bundled-binary service we registered earlier.
try { & 'd:\ai-project\ai-workspace-desktopapp\vendor\tailscale\win\x64\tailscaled.exe' uninstall-system-daemon } catch {}
sc.exe stop Tailscale   2>&1 | Add-Content $log
sc.exe delete Tailscale 2>&1 | Add-Content $log
Start-Sleep -Seconds 2

# 2. Install the official MSI silently (no GUI/login window).
"--- installing MSI ---" | Add-Content $log
$p = Start-Process msiexec.exe -ArgumentList '/i','d:\ai-project\ai-workspace-desktopapp\vendor\tailscale\_off\ts.msi','/quiet','/norestart','TS_NOLAUNCH=true' -Wait -PassThru
"msiexec exit=$($p.ExitCode)" | Add-Content $log
Start-Sleep -Seconds 4

# 3. Ensure the service is running and let your user drive it without elevation.
$tsExe = 'C:\Program Files\Tailscale\tailscale.exe'
sc.exe config Tailscale start= auto 2>&1 | Add-Content $log
sc.exe start Tailscale 2>&1 | Add-Content $log
Start-Sleep -Seconds 6
& $tsExe set --operator=HP 2>&1 | Add-Content $log

"--- service ---"  | Add-Content $log
(Get-Service Tailscale | Out-String) | Add-Content $log
"--- status ---"   | Add-Content $log
(& $tsExe status 2>&1 | Out-String) | Add-Content $log
"=== done ===" | Add-Content $log
