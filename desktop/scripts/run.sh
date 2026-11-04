#!/bin/sh
# 依赖、下载缓存、用户数据均收在客户端目录；使用系统已安装的Node/npm。
set -eu
cd "$(dirname "$0")/.."
OBSERVER_PROJECT_ROOT="$(cd .. && pwd)"
export OBSERVER_PROJECT_ROOT
PATH="${PATH:+$PATH:}$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
export PATH
if ! command -v node >/dev/null 2>&1; then
  echo '系统 PATH 中找不到 Node，请检查已有 Node 的安装位置。' >&2
  exit 1
fi
export npm_config_cache="$PWD/.cache/npm"
export ELECTRON_CACHE="$PWD/.cache/electron"
export ELECTRON_BUILDER_CACHE="$PWD/.cache/electron-builder"
export XDG_CACHE_HOME="$PWD/.cache/xdg-cache"
export XDG_CONFIG_HOME="$PWD/.cache/xdg-config"
export XDG_DATA_HOME="$PWD/.cache/xdg-data"
export TMPDIR="$PWD/.cache/tmp"
# 使用直接下载，避免继承已失效的本机代理；仅影响本脚本的子进程。
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export NODE_USE_ENV_PROXY=0
mkdir -p "$TMPDIR" "$ELECTRON_CACHE" "$ELECTRON_BUILDER_CACHE"
exec npm "$@"
