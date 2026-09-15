# 部署、备份与升级

## 镜像部署

`compose.yaml` 使用 GHCR 预构建镜像，目标架构为 `linux/amd64` 和 `linux/arm64`。实际可用版本以 GitHub Releases 与镜像构建结果为准。

下载发行包并解压，在项目目录执行：

```sh
sh scripts/init-env.sh
docker compose up -d
sh scripts/verify.sh
```

若 `.env` 已存在，初始化脚本会停止而不覆盖它。可直接编辑 `.env` 后重建容器：

```sh
docker compose up -d
```

访问 `http://服务器地址:39210`。容器内端口固定为 `3000`，主机端口通过 `APP_PORT` 设置。

初始账号 `admin / admin` 仅用于全新数据库。成员自行设置的新密码至少 6 位；改动初始化环境变量不会重置已有密码。管理员可以把普通成员密码重置为该成员登记的手机号码。

## 数据目录

```text
data/
├── zongpu.sqlite
├── zongpu.sqlite-wal  # 运行时可能存在
├── zongpu.sqlite-shm  # 运行时可能存在
└── uploads/
```

将整个目录挂载到容器的 `/app/data`。默认 `./data` 相对于 Compose 项目目录；在 NAS 上可使用绝对路径。容器启动脚本会调整此目录的所有者，因此请使用专属目录，不要把整个共享存储根目录挂载进去。

SQLite 必须位于 Docker 主机的本地文件系统。外地亲属通过网页访问，不直接打开数据库文件。数据库和附件备份应放到数据目录之外，并保留异地副本。

## HTTP、HTTPS 与 IPv6

默认允许 HTTP，`APP_ORIGIN` 留空时使用当前浏览器访问地址。使用固定域名时，例如：

```dotenv
APP_ORIGIN=https://family.example.com
FORCE_HTTPS=true
```

应用自身不签发证书，也不监听 TLS 端口。需由 Caddy、Nginx 或 NAS 反向代理终止 HTTPS，并转发到 `http://127.0.0.1:39210` 或容器可达地址；代理应正确传递原始 `Host` 和 `X-Forwarded-Proto`。域名、协议和端口需与 `APP_ORIGIN` 一致，不要带末尾斜线。

公网 IPv6 部署通常由路由器放行反向代理的端口，通过域名 AAAA 记录指向主机全局 IPv6；地址变化时需 DDNS。默认 Compose 明确绑定 IPv4，**仅配置 AAAA 不会自动开启容器的 IPv6 入口**。推荐让支持 IPv6 的反向代理接收入站流量，再转发到本机 IPv4 端口。

只有 IPv6 入口时，访问者网络也必须支持 IPv6。需要照顾仅 IPv4 的网络时，可增加具备双栈入口的代理服务。部署完成后，用另一条外部网络实际验证访问；不要将 fnOS 管理后台或数据库端口作为家谱入口。

## 备份

在含有 `.env` 和 `compose.yaml` 的项目目录执行：

```sh
sh scripts/backup.sh
```

脚本短暂停止应用，将整个数据目录压缩到 `ZONGPU_BACKUP_DIR`（默认 `./backups`），生成 SHA-256 文件后恢复原来的运行状态。这样数据库、WAL 和附件属于同一停止时点。备份时亲属暂时无法访问。

请确认脚本成功结束，并定期在独立目录演练恢复。不要在应用仍写入时只复制主 `.sqlite` 文件。

## 恢复

只恢复来源可信、已核对校验和的本项目备份。校验命令示例：

```sh
sha256sum -c backups/zongpu-YYYYMMDD-HHMMSS.tar.gz.sha256
# macOS 可用 shasum -a 256 -c 替代 sha256sum -c
sh scripts/restore.sh /完整路径/zongpu-YYYYMMDD-HHMMSS.tar.gz
```

输入 `RESTORE` 后，脚本停止应用，将现有数据目录改名为 `.before-restore-时间戳`，然后恢复备份并启动。完成后运行 `sh scripts/verify.sh`，登录核对人物、关系和附件；核对前保留原目录。此操作会回到备份时点，之后的改动不在备份内。

## 升级

先阅读目标版本的更新记录，备份，再修改 `.env` 中的 `ZONGPU_IMAGE` 标签：

```sh
sh scripts/backup.sh
# 编辑 .env，例如 ZONGPU_IMAGE=ghcr.io/91godlike/zongpu:1.0
docker compose pull
docker compose up -d
sh scripts/verify.sh
```

保持 `ZONGPU_DATA_DIR` 不变。遇到数据库迁移不兼容时，回退旧镜像的同时应恢复升级前备份；不要假定旧代码可读取新数据库。

## 源码构建

需要完整源码和可访问的 Node.js 基础镜像、npm 软件源：

```sh
sh scripts/init-env.sh
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

此方式构建本机架构的 `zongpu:1.0-local`。后续使用同样两个 `-f` 参数管理这个部署，避免切回预构建镜像。运行验证脚本前可设置 `COMPOSE_FILE=compose.yaml:compose.build.yaml`（Linux/macOS）。

## 排查问题

```sh
docker compose ps
docker compose logs --tail=100 app
curl -fsS http://127.0.0.1:39210/api/health
```

正常健康接口包含 `{"status":"ok","version":"1.0"}`。

- **容器启动失败**：检查专属数据目录是否可写、主机端口是否冲突。
- **拉取出现 502**：检查 Docker 镜像代理或网络，失败不表示数据库损坏。也可在可联网的环境构建或下载镜像，再通过 `docker save/load` 转移。
- **登录请求被拒绝**：核对固定域名、协议、端口、反向代理请求头与 `APP_ORIGIN`。
- **升级后看似空白**：先检查数据卷是否挂载到了原来的目录，不要立即重新录入或覆盖旧备份。
