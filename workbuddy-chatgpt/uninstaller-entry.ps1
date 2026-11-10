$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
try {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (!$admin) {
        $process = Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"') -PassThru -Wait
        exit $process.ExitCode
    }
    & (Join-Path $PSScriptRoot 'uninstall.ps1')
    if ($LASTEXITCODE -ne 0) { throw '卸载未完成。' }
    $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'WorkBuddy ChatGPT\卸载 WorkBuddy ChatGPT.lnk'
    Remove-Item -LiteralPath $shortcut -ErrorAction SilentlyContinue
    [Windows.MessageBox]::Show('已还原 WorkBuddy 原文件并关闭连接器。账号数据与原始备份已保留。', '卸载完成') | Out-Null
} catch {
    [Windows.MessageBox]::Show($_.Exception.Message, '卸载未完成', 'OK', 'Error') | Out-Null
    exit 1
}
