$ErrorActionPreference = 'Stop'
if (@(Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue).Count) { throw 'Exit WorkBuddy first.' }
$installation = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installation.json') -Raw | ConvertFrom-Json
$archive = Join-Path $installation.WorkBuddyRoot 'resources\app.asar'
$exe = Join-Path $installation.WorkBuddyRoot 'WorkBuddy.exe'
& (Join-Path $PSScriptRoot 'node.exe') (Join-Path $PSScriptRoot 'patch-workbuddy.mjs') --revert --confirm-workbuddy-closed --archive $archive --exe $exe
if ($LASTEXITCODE -ne 0) { throw 'Restore failed; startup has been retained.' }
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name WorkBuddyChatGPT -ErrorAction SilentlyContinue
$ownNode = Join-Path $PSScriptRoot 'node.exe'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.ExecutablePath -eq $ownNode -and $_.CommandLine.Contains((Join-Path $PSScriptRoot 'service.js')) } | ForEach-Object { Stop-Process -Id $_.ProcessId }
Write-Host 'Original WorkBuddy restored. Account data retained under LocalAppData\WorkBuddyChatGPT.'
