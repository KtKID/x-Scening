param([Parameter(ValueFromRemainingArguments=$true)][string[]]$NpmArguments)
# Windows入口：环境变更仅作用于本次脚本及子进程，结束后还原。
$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path -Parent $PSScriptRoot
$observerRoot = Split-Path -Parent $desktopRoot
$settings = @{
  OBSERVER_PROJECT_ROOT = $observerRoot
  npm_config_cache = "$desktopRoot/.cache/npm"
  ELECTRON_CACHE = "$desktopRoot/.cache/electron"
  ELECTRON_BUILDER_CACHE = "$desktopRoot/.cache/electron-builder"
  XDG_CACHE_HOME = "$desktopRoot/.cache/xdg-cache"
  XDG_CONFIG_HOME = "$desktopRoot/.cache/xdg-config"
  XDG_DATA_HOME = "$desktopRoot/.cache/xdg-data"
  TMPDIR = "$desktopRoot/.cache/tmp"
  TEMP = "$desktopRoot/.cache/tmp"
  TMP = "$desktopRoot/.cache/tmp"
  NODE_USE_ENV_PROXY = '0'
  HTTP_PROXY = $null
  HTTPS_PROXY = $null
  ALL_PROXY = $null
}
$previous = @{}
foreach ($key in $settings.Keys) {
  $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
  [Environment]::SetEnvironmentVariable($key, $settings[$key], 'Process')
}
Push-Location $desktopRoot
try {
  New-Item -ItemType Directory -Force -Path "$desktopRoot/.cache/tmp" | Out-Null
  if (!$NpmArguments) { $NpmArguments = @('run', 'dev') }
  & npm.cmd @NpmArguments
  if ($LASTEXITCODE -ne 0) { throw "npm 退出码：$LASTEXITCODE" }
} finally {
  Pop-Location
  foreach ($key in $previous.Keys) {
    [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process')
  }
}
