#!/bin/sh
# 从任意工作目录启动项目内的桌面客户端。
set -eu
cd "$(dirname "$0")"
exec ./scripts/run.sh run dev
