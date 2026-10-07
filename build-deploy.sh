#!/bin/bash
# 构建 + 部署到 Nginx/OpenResty 站点目录(按自己的环境修改 SITE 与 base)
# 要求:站点 location 对播放器路径附加 COOP/COEP 响应头(多线程软解需要),见 README
set -e
cd "$(dirname "$0")"
npm run build -- --base=/stream/
SITE="${SITE:-/var/www/emby/stream}"
sudo rm -rf "$SITE"
sudo mkdir -p "$SITE"
sudo cp -r dist/. "$SITE/"
sudo chmod -R a+rX "$SITE"
echo "已部署到 $SITE"
