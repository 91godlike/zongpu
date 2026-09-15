#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; . ./.env; set +a; }
checksum() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}
backup_dir="${ZONGPU_BACKUP_DIR:-./backups}"
data_dir="${ZONGPU_DATA_DIR:-./data}"
stamp="$(date +%Y%m%d-%H%M%S)"
archive="$backup_dir/zongpu-$stamp.tar.gz"
mkdir -p "$backup_dir" "$data_dir"
running="$(docker compose ps --status running -q app)"
restart() {
  [ -z "$running" ] || docker compose start app >/dev/null
}
trap restart EXIT INT TERM
[ -z "$running" ] || docker compose stop app >/dev/null
tar -C "$data_dir" -czf "$archive" .
checksum "$archive" > "$archive.sha256"
trap - EXIT INT TERM
restart
echo "备份完成：$archive"
