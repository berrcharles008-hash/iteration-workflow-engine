# notify.qqbot.ps1 - push "task done" notification via QQ bot C2C private chat
#
# Security: AppID / Secret / openid are read from ENV ONLY, never hardcode or commit.
# Config (persist with setx):
#   setx QQ_BOT_APPID   "<YOUR_APP_ID>"
#   setx QQ_BOT_SECRET  "<clientSecret>"
#   setx QQ_BOT_OPENID  "<openid>"   # get it via qqbot-listen-once.js first
#
# Usage: pwsh -File notify.qqbot.ps1 -Message "M2 audit module compiled (0 error)"
# Limits: proactive msg 20/qpm, 1000/day per friend; may be blocked if no recent chat.

param(
    [Parameter(Mandatory = $true)][string]$Message,
    [string]$OpenId = $env:QQ_BOT_OPENID
)

$appId  = $env:QQ_BOT_APPID
$secret = $env:QQ_BOT_SECRET
if (-not $appId -or -not $secret) { Write-Error "Missing QQ_BOT_APPID / QQ_BOT_SECRET, run setx first."; exit 1 }
if (-not $OpenId) { Write-Error "Missing QQ_BOT_OPENID (get it via qqbot-listen-once.js)."; exit 1 }

# Force UTF-8 byte array for request body to avoid GBK mojibake in PS 5.1
$enc = [System.Text.Encoding]::UTF8

$tokenBody = $enc.GetBytes((@{ appId = $appId; clientSecret = $secret } | ConvertTo-Json -Compress))
try {
    $r = Invoke-WebRequest -Uri "https://bots.qq.com/app/getAppAccessToken" `
        -Method Post -ContentType "application/json; charset=utf-8" -Body $tokenBody -TimeoutSec 10
    $tok = $r.Content | ConvertFrom-Json
    $accessToken = $tok.access_token
}
catch { Write-Error "getAppAccessToken failed: $_"; exit 2 }
if (-not $accessToken) { Write-Error "access_token empty, check AppID/Secret."; exit 2 }

$headers = @{ Authorization = "QQBot $accessToken"; "X-UnionAppid" = $appId }
$body = $enc.GetBytes((@{ content = $Message; msg_type = 0 } | ConvertTo-Json -Compress))
try {
    $mr = Invoke-WebRequest -Uri "https://api.sgroup.qq.com/v2/users/$OpenId/messages" `
        -Method Post -ContentType "application/json; charset=utf-8" -Headers $headers -Body $body -TimeoutSec 10
    if ($mr.StatusCode -eq 200) { Write-Host "[OK] sent to openid=$OpenId"; exit 0 }
    Write-Error "non-200: $($mr.StatusCode)"; exit 3
}
catch { Write-Error "send failed (may be blocked if no recent chat): $_"; exit 3 }
