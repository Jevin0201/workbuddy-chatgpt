param([string]$StatusFile)
$ErrorActionPreference = 'Stop'
try {
    & (Join-Path $PSScriptRoot 'install.ps1') -AcceptedSignatureChange -StatusFile $StatusFile *>&1 | Out-File -LiteralPath (Join-Path $PSScriptRoot 'install.log') -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw '安装脚本未能完成，请检查 WorkBuddy 版本及权限。' }
    $installed = Join-Path $env:LOCALAPPDATA 'WorkBuddyChatGPT\app'
    $programs = Join-Path ([Environment]::GetFolderPath('Programs')) 'WorkBuddy ChatGPT'
    New-Item -ItemType Directory -Force -Path $programs | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path $programs '卸载 WorkBuddy ChatGPT.lnk'))
    $shortcut.TargetPath = Join-Path $installed 'Uninstall.cmd'
    $shortcut.WorkingDirectory = $installed
    $shortcut.Save()
    if ($StatusFile) { [IO.File]::WriteAllText($StatusFile, '100|安装完成', [Text.UTF8Encoding]::new($false)) }
    exit 0
} catch {
    if ($StatusFile) { [IO.File]::WriteAllText($StatusFile, ('-1|' + $_.Exception.Message), [Text.UTF8Encoding]::new($false)) }
    exit 1
}
