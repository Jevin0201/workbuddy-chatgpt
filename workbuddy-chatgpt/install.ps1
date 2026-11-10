param([string]$WorkBuddyRoot = 'C:\Program Files\WorkBuddy', [switch]$AcceptedSignatureChange, [string]$StatusFile)
function Set-InstallProgress([int]$Percent, [string]$Message) {
    if ($StatusFile) { [IO.File]::WriteAllText($StatusFile, ($Percent.ToString() + '|' + $Message), [Text.UTF8Encoding]::new($false)) }
}
Set-InstallProgress 30 '正在检查安装环境…'
$ErrorActionPreference = 'Stop'
$target = Join-Path $env:LOCALAPPDATA 'WorkBuddyChatGPT\app'
$node = Join-Path $PSScriptRoot 'node.exe'
if (!(Test-Path -LiteralPath $node)) { throw '安装文件不完整，请重新下载安装器。' }
if (@(Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue).Count) { throw '请先退出 WorkBuddy，再点击重试。' }
$archive = Join-Path $WorkBuddyRoot 'resources\app.asar'
$exe = Join-Path $WorkBuddyRoot 'WorkBuddy.exe'
$legacyReceipt = $archive + '.dsh-codex-bridge-5.9.3.json'
$ownReceipt = $archive + '.workbuddy-chatgpt-5.9.3.json'
$upgrade = $false
$migrate = $false
# The initial probe may legitimately reject an already-patched installation.
$ErrorActionPreference = 'Continue'
& $node (Join-Path $PSScriptRoot 'patch-workbuddy.mjs') --dry-run --archive $archive --exe $exe
$probeExitCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($probeExitCode -ne 0) {
    if (Test-Path -LiteralPath $ownReceipt) {
        $ownRecord = Get-Content -LiteralPath $ownReceipt -Raw | ConvertFrom-Json
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower() -ne $ownRecord.patchedSha256 -or (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLower() -ne $ownRecord.patchedExecutableSha256) { throw 'WorkBuddy 文件发生变化，暂时无法升级。' }
        $upgrade = $true
    }
    if (!$upgrade) {
    if (!(Test-Path -LiteralPath $legacyReceipt)) { throw '暂不支持当前 WorkBuddy 版本，请使用 5.9.3。' }
    $record = Get-Content -LiteralPath $legacyReceipt -Raw | ConvertFrom-Json
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower() -ne $record.patchedSha256 -or (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLower() -ne $record.patchedExecutableSha256) { throw 'WorkBuddy 文件发生变化，暂时无法安装。' }
    # Review the next patch using copies of the retained original pair.
    $preview = Join-Path ([IO.Path]::GetTempPath()) ('wb-preview-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path (Join-Path $preview 'resources') -Force | Out-Null
    try {
        Copy-Item -LiteralPath ($archive + '.dsh-codex-bridge-5.9.3.original') -Destination (Join-Path $preview 'resources\app.asar')
        Copy-Item -LiteralPath ($exe + '.dsh-codex-bridge-5.9.3.original') -Destination (Join-Path $preview 'WorkBuddy.exe')
        & $node (Join-Path $PSScriptRoot 'patch-workbuddy.mjs') --dry-run --archive (Join-Path $preview 'resources\app.asar') --exe (Join-Path $preview 'WorkBuddy.exe')
        if ($LASTEXITCODE -ne 0) { throw '原始备份校验失败，安装已停止。' }
    } finally {
        $resolvedPreview = [IO.Path]::GetFullPath($preview)
        if ([IO.Path]::GetDirectoryName($resolvedPreview) -eq [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') -and [IO.Path]::GetFileName($resolvedPreview).StartsWith('wb-preview-')) { Remove-Item -LiteralPath $resolvedPreview -Recurse -Force }
    }
    $migrate = $true
    }
}
if (!$AcceptedSignatureChange) {
    Add-Type -AssemblyName PresentationFramework
    $answer = [System.Windows.MessageBox]::Show('安装将备份并修改 WorkBuddy 文件，影响原厂签名校验。是否继续？', 'WorkBuddy ChatGPT', 'YesNo', 'Information')
    if ($answer -ne 'Yes') { exit }
}
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (!$isAdmin) { throw '需要管理员权限才能安装，请重新启动安装器。' }
Set-InstallProgress 45 '正在更新组件…'
New-Item -ItemType Directory -Force -Path $target | Out-Null
$ownNode = Join-Path $target 'node.exe'
$ownService = Join-Path $target 'service.js'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.ExecutablePath -eq $ownNode -and $_.CommandLine.Contains($ownService) } | ForEach-Object { Stop-Process -Id $_.ProcessId }
Get-ChildItem -LiteralPath $PSScriptRoot | Where-Object { $_.Name -notin @('test','settings.json') } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force }
Set-InstallProgress 60 '正在安装登录入口…'
if ($upgrade) {
    & $node (Join-Path $target 'patch-workbuddy.mjs') --revert --confirm-workbuddy-closed --archive $archive --exe $exe
    if ($LASTEXITCODE -ne 0) { throw '旧版本还原失败，升级已停止。' }
    Move-Item -LiteralPath $ownReceipt -Destination ($ownReceipt + '.previous-' + [guid]::NewGuid())
}
if ($migrate) {
    & $node (Join-Path $target 'legacy-patch.mjs') --revert --confirm-workbuddy-closed --archive $archive --exe $exe
    if ($LASTEXITCODE -ne 0) { throw '旧版本还原失败，安装已停止。' }
}
& $node (Join-Path $target 'patch-workbuddy.mjs') --apply --confirm-workbuddy-closed --accept-signature-change --archive $archive --exe $exe
if ($LASTEXITCODE -ne 0) {
    if ($migrate) { & $node (Join-Path $target 'legacy-patch.mjs') --apply --confirm-workbuddy-closed --accept-signature-change --archive $archive --exe $exe }
    throw '登录入口安装失败，请重试。'
}
Set-InstallProgress 80 '正在保留模型设置…'
$launcher = Join-Path $target 'launch.vbs'
& $node (Join-Path $target 'migrate-models.mjs')
if ($LASTEXITCODE -ne 0) { throw '模型设置更新失败，原配置备份已保留。' }
$nodeInstalled = Join-Path $target 'node.exe'
$service = Join-Path $target 'service.js'
$vbs = 'CreateObject("WScript.Shell").Run """' + $nodeInstalled + '"" ""' + $service + '""", 0, False'
[IO.File]::WriteAllText($launcher, $vbs)
New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name WorkBuddyChatGPT -Value ('wscript.exe "' + $launcher + '"') -PropertyType String -Force | Out-Null
@{ WorkBuddyRoot=$WorkBuddyRoot } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target 'installation.json') -Encoding UTF8
Set-InstallProgress 90 '正在启动连接服务…'
Start-Process -FilePath wscript.exe -ArgumentList ('"' + $launcher + '"') -WindowStyle Hidden
Write-Host 'Installed. Open WorkBuddy > Settings > Models > Login ChatGPT.'
