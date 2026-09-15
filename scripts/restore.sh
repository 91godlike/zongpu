#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
[ "${1:-}" ] || { echo "用法：./scripts/restore.sh 备份文件.tar.gz"; exit 1; }
[ -f "$1" ] || { echo "备份文件不存在：$1"; exit 1; }
[ -f .env ] && { set -a; . ./.env; set +a; }
printf "恢复会替换当前数据库和附件。输入 RESTORE 继续："
read answer
[ "$answer" = RESTORE ] || { echo "已取消"; exit 1; }
data_dir="${ZONGPU_DATA_DIR:-./data}"
previous="$data_dir.before-restore-$(date +%Y%m%d-%H%M%S)"
docker compose stop app >/dev/null 2>&1 || true
[ ! -e "$data_dir" ] || mv "$data_dir" "$previous"
mkdir -p "$data_dir"
tar -xzf "$1" -C "$data_dir"
docker compose up -d app
echo "恢复完成。原数据保存在：$previous"
