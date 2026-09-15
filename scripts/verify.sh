#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; . ./.env; set +a; }
docker compose config --quiet
docker compose ps
curl -fsS "http://127.0.0.1:${APP_PORT:-39210}/api/health"
echo
docker compose exec -T app node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/data/zongpu.sqlite',{readOnly:true});console.log('有效人物：'+db.prepare('SELECT count(*) AS n FROM people WHERE deleted_at IS NULL').get().n)"
echo "单容器、健康检查和 SQLite 数据库访问正常。"
