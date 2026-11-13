$ErrorActionPreference = 'Stop'
$source = Split-Path $PSScriptRoot -Parent
$workspace = Split-Path $source -Parent
$outputs = Join-Path $workspace 'outputs'
& node (Join-Path $source 'build.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Payload build failed.' }
$payload = Join-Path $outputs 'WorkBuddy-ChatGPT-0.4.3-preview.zip'
Compress-Archive -LiteralPath (Join-Path $outputs 'WorkBuddy-ChatGPT-0.4.3-preview') -DestinationPath $payload -Force
$hash = (Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash.ToLowerInvariant()
$generated = Join-Path $outputs 'Setup.generated.cs'
$code = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Setup.cs')).Replace('PAYLOAD_SHA256', $hash)
[IO.File]::WriteAllText($generated, $code, [Text.UTF8Encoding]::new($true))
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$exe = Join-Path $outputs 'WorkBuddy-ChatGPT-Setup-0.4.3-preview.exe'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ ('/win32manifest:' + (Join-Path $PSScriptRoot 'app.manifest')) /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll ('/resource:' + $payload + ',payload.zip') ('/out:' + $exe) $generated
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
Get-FileHash -LiteralPath $exe -Algorithm SHA256 | Format-List
