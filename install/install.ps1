<#
  IMA Reply Tracking installer, Windows launcher.
  Doctors run ONE line (the organizer sends it with their personal invite code):

    powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/amits-ds/ima-reply-tracking-addon/main/install/install.ps1))) -Code XXXX-XXXX-XXXX-XXXX"

  This file only makes sure Node.js 18+ is available (a private portable copy in ~\.ima-reply-tracking\node, no admin rights,
  nothing changed system-wide), downloads install.js from the same repository and runs it. All the real work is in install.js.
#>
param(
  [string]$Code = '',
  [string]$Gateway = '',
  [string]$ReleaseBase = '',
  [string]$Source = '',
  [string]$LocalInstaller = '',     # testing: use this install.js instead of downloading it (no checksum check)
  [string]$InstallerUrl = '',       # testing: download install.js from this address instead of GitHub (checksum still enforced)
  [switch]$DryRun, [switch]$Yes, [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'amits-ds/ima-reply-tracking-addon'
$Ref = 'main'                                         # replaced by tools/release.py with the release tag
$ExpectedInstallJsSha256 = '6b61c7b7a123ae22eb72894438f73b354abfbe898e9c656a685588450c0486b0'   # replaced by tools/release.py: SHA-256 of install.js for this release
$Root = Join-Path $env:USERPROFILE '.ima-reply-tracking'
$NodeDir = Join-Path $Root 'node'
New-Item -ItemType Directory -Force $Root | Out-Null

function Get-NodeMajor([string]$exe) {
  try { $v = & $exe -v 2>$null; if ($v -match '^v(\d+)') { return [int]$Matches[1] } } catch { }
  return 0
}

function Get-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and (Get-NodeMajor $cmd.Source) -ge 18) { return $cmd.Source }
  $portable = Join-Path $NodeDir 'node.exe'
  if ((Test-Path $portable) -and (Get-NodeMajor $portable) -ge 18) { return $portable }

  Write-Host 'Downloading a private copy of Node.js (one time, about 30 MB)...'
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $base = 'https://nodejs.org/dist/latest-v22.x'
  $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content -split "`n"
  $line = $sums | Where-Object { $_ -match "node-v[\d\.]+-win-$arch\.zip\s*$" } | Select-Object -First 1
  if (-not $line) { throw "Could not find a Node.js download for Windows $arch." }
  $hash, $file = ($line.Trim() -split '\s+')
  $zip = Join-Path $Root $file
  Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $zip
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $hash.ToLower()) { Remove-Item $zip -Force; throw 'The Node.js download failed its checksum. Try again.' }
  $tmp = Join-Path $Root 'node-extract'
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
  Move-Item (Get-ChildItem $tmp | Select-Object -First 1).FullName $NodeDir
  Remove-Item $tmp -Recurse -Force; Remove-Item $zip -Force
  return $portable
}

try {
  $node = Get-Node
  $env:Path = (Split-Path $node) + ';' + $env:Path        # so npm (used by the installer) finds this node

  if ($LocalInstaller) { $installer = $LocalInstaller }
  else {
    $installer = Join-Path $Root 'install.js'
    $url = if ($InstallerUrl) { $InstallerUrl } else { "https://raw.githubusercontent.com/$Repo/$Ref/install/install.js" }
    Invoke-WebRequest -UseBasicParsing $url -OutFile $installer
    if ($ExpectedInstallJsSha256 -like 'PASTE_*') { Remove-Item $installer -Force; throw 'This launcher has no checksum for install.js, so it refuses to run it. Ask the organizer for a current command.' }
    $got = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $ExpectedInstallJsSha256.ToLower()) { Remove-Item $installer -Force; throw ('install.js does not match its published checksum (expected ' + $ExpectedInstallJsSha256 + ', got ' + $got + '). Nothing was run.') }
  }

  $a = @($installer)
  if ($Code)        { $a += @('--code', $Code) }
  if ($Gateway)     { $a += @('--gateway', $Gateway) }
  if ($ReleaseBase) { $a += @('--release-base', $ReleaseBase) }
  if ($Source)      { $a += @('--source', $Source) }
  if ($DryRun)      { $a += '--dry-run' }
  if ($Yes)         { $a += '--yes' }
  if ($NoOpen)      { $a += '--no-open' }
  & $node @a
  # return, not exit: the command runs this launcher inside the member's own PowerShell window, and exit would close it (and the
  # installer's last messages with it).
  return
}
catch {
  Write-Host ''
  Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host 'If this keeps happening, send the organizer a screenshot of this window.'
  return
}
