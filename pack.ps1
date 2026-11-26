# pack.ps1
# 删除当前目录的 dist，然后运行 npm run pack
#
# 注意：如果本目录位于 Windows“低完整性级别（Low）”的沙箱工作区里，
# electron-builder 直接写进 dist 的 exe 会继承 Low 标签；双击启动时 Windows 会以
# Low 完整性运行它，Electron/Chromium 的沙箱会在启动阶段崩溃（0x80000003，闪退）。
# 因此打包完成后先把 dist 复制到同盘的普通目录（新文件为默认 Medium 完整性），
# 再移回 dist（同盘移动不会重新继承父目录标签），这样 dist 里的 exe 就能正常运行。

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$dist = Join-Path $root "dist"

if (Test-Path $dist) {
  Remove-Item -LiteralPath $dist -Recurse -Force
  Write-Host "Deleted: $dist"
} else {
  Write-Host "No dist folder found."
}

Write-Host "Running: npm run pack"
Push-Location $root
try {
  npm run pack
} finally {
  Pop-Location
}
if ($LASTEXITCODE -ne 0) {
  throw "npm run pack failed with exit code $LASTEXITCODE"
}
if (-not (Test-Path $dist)) {
  throw "npm run pack finished but $dist was not created"
}

# Copy out to a normal folder on the same drive, then move back.
# Same-volume move preserves each file's integrity label, so the rebuilt dist
# no longer carries the workspace's Low label.
$qualifier = Split-Path -Qualifier $dist
$staging = Join-Path $qualifier ("_rr_pack_staging_" + [guid]::NewGuid().ToString("N"))

try {
  New-Item -ItemType Directory -Path $staging | Out-Null
  Copy-Item -LiteralPath $dist -Destination (Join-Path $staging "dist") -Recurse
  Remove-Item -LiteralPath $dist -Recurse -Force
  Move-Item -LiteralPath (Join-Path $staging "dist") -Destination $dist
  Write-Host "Normalized integrity labels: $dist"
} finally {
  if (Test-Path $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
  }
}

Write-Host "Done. Run: $dist\win-unpacked\random-runes.exe"
