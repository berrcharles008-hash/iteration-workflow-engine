param([int]$IdleSeconds = 30)
# install-watcher.ps1 -- install the IDE QQ-notify watcher as a per-user logon autostart.
# Uses the Startup folder shortcut (no admin needed), NOT a Scheduled Task (which needs
# elevation on this machine). Launches the watcher hidden immediately too.
# NOTE: ASCII-only; project root derived from $PSScriptRoot.
$scriptDir = $PSScriptRoot
$proj = Split-Path (Split-Path $scriptDir -Parent) -Parent
$ps1 = Join-Path $proj 'tools\qqbot\notify-watcher.ps1'
$watchDir = Join-Path $proj 'tools\qqbot'
$startup = [System.Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'CodeBuddyQQWatcher.lnk'
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = 'powershell.exe'
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ps1`" -IdleSeconds $IdleSeconds"
$sc.WorkingDirectory = $watchDir
$sc.Description = 'CodeBuddy IDE QQ notify watcher'
$sc.Save()
Write-Host "Created startup shortcut: $lnk (runs at logon, no admin needed)"
Start-Process -FilePath powershell.exe -ArgumentList $sc.Arguments -WindowStyle Hidden
Write-Host "Watcher launched now. Log: $watchDir\watcher.log"
Write-Host "Remove autostart: delete the shortcut at $lnk"
