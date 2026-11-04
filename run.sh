#!/bin/sh
# 固定项目工作目录，默认读取开发配置；--config可选择已保存的用户配置。
set -eu
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo '请先创建项目虚拟环境并安装 requirements.txt。' >&2
  exit 1
fi
# 参数原样交给活动入口；Ctrl+C完成当前图片与记录后退出。
export PYTHONPATH="$PWD/src${PYTHONPATH:+:$PYTHONPATH}"
exec .venv/bin/python -B -m scening.observe_activity "$@"
