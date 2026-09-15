<div align="center">

# 宗谱 · Family Archive

**一脉相承，世代有迹。**

记录家人、理清关系，让分散各地的亲属共同维护一份家谱。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0-blue.svg)](https://github.com/91godlike/zongpu/releases/tag/v1.0)

[在线演示](https://91godlike.github.io/zongpu/) · [快速部署](#快速部署) · [使用指南](docs/usage.md) · [部署与备份](docs/deployment.md) · [更新记录](CHANGELOG.md)

</div>

宗谱是一款可自行部署的中文家谱管理系统。家人可以通过电脑或手机访问，将人物档案、亲属关系、照片、文献和家族资料保存在自己的服务器或 NAS 上。

**一个 Docker 容器，一个数据目录。** 系统使用 Node.js 内置 SQLite，不需要额外部署数据库或缓存服务；局域网可直接使用 HTTP，公网可通过域名和反向代理提供 HTTPS。

## 在线演示

访问 [GitHub Pages 在线演示](https://91godlike.github.io/zongpu/)。演示使用虚构的只读数据，不接收注册、密码、照片或家谱资料；完整编辑与持久化功能请使用 Docker 版。

也可以使用 Vercel Hobby 免费部署同一套只读演示：

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2F91godlike%2Fzongpu)

## 主要功能

| 功能 | 说明 |
| --- | --- |
| 家谱图 | 按代数和家庭排列，配偶并排、男左女右；支持缩放、拖动、全图、祖辈路径、代数筛选和家庭视图 |
| 人物档案 | 记录姓名、曾用名、性别、公历与农历生日、籍贯、现居地、电话、生存状态、去世记载和人物简介 |
| 关系维护 | 维护父母子女与配偶关系；添加子女时可同时选择父母，并可随时调整 |
| 照片与文献 | 上传 JPEG、PNG、WebP 和 PDF；支持头像裁剪，照片显示在家谱卡片、人物名录和详情页 |
| 多人协作 | 邀请注册或由管理员新建账号；权限区分可编辑和仅查看 |
| 简便登录 | 成员可使用中文姓名或手机号码登录，初始密码可设为手机号码，管理员可重置普通成员密码 |
| 家族资料 | 记录家谱名称、家族发源地和家族介绍；上传电子族谱并在线预览或下载 |
| 数据管理 | Excel 预览导入、Excel/JSON 导出、一键完整备份与恢复、最近三次备份和七天回收站 |
| 分享与审计 | 创建 1 天、7 天或 30 天全谱只读链接；保留修改人、修改时间及前后内容 |
| 移动端与导出 | 响应式界面、PWA、家谱图 PNG 导出以及浏览器打印/PDF |

## 快速部署

需要 Docker 和 Docker Compose v2。在服务器中新建目录并下载配置：

```sh
mkdir zongpu
cd zongpu
curl -fLO https://raw.githubusercontent.com/91godlike/zongpu/v1.0/compose.yaml
curl -fLo .env https://raw.githubusercontent.com/91godlike/zongpu/v1.0/.env.example
docker compose up -d
```

打开 `http://你的服务器地址:39210`。

| 初始账号 | 初始密码 |
| --- | --- |
| `admin` | `admin` |

首次登录后建议修改管理员密码，再开放公网访问。初始账号只在全新数据库中创建，不会覆盖已有账号。

镜像地址：`ghcr.io/91godlike/zongpu:1.0`。若需要自行构建，请查看[部署与备份](docs/deployment.md#源码构建)。

### fnOS / NAS

在 Docker 项目管理中导入 `compose.yaml`，配置端口和数据目录后启动。数据库、人物附件和电子族谱都保存在持久化目录中，例如：

```dotenv
APP_PORT=39210
ZONGPU_DATA_DIR=/vol3/1000/appdata/zongpu/data
ZONGPU_MANAGED_BACKUP_DIR=/vol3/1000/appdata/zongpu/managed-backups
```

示例路径应根据自己的存储卷调整。SQLite 数据库应放在 Docker 主机的本地文件系统中。

## 常用配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `APP_PORT` | `39210` | 主机访问端口 |
| `APP_BIND_IP` | `0.0.0.0` | IPv4 监听地址 |
| `ZONGPU_DATA_DIR` | `./data` | 数据库、人物附件和电子族谱目录 |
| `ZONGPU_MANAGED_BACKUP_DIR` | `./managed-backups` | 系统内一键备份目录 |
| `APP_ORIGIN` | 留空 | 自动使用当前访问地址，也可填写固定域名 |
| `FORCE_HTTPS` | `false` | 设为 `true` 时要求固定地址使用 HTTPS |
| `INITIAL_ADMIN_USERNAME` | `admin` | 仅全新数据库生效 |
| `INITIAL_ADMIN_PASSWORD` | `admin` | 仅全新数据库生效 |

IPv6 域名、反向代理、源码构建、备份和恢复见[部署指南](docs/deployment.md)。

## 本地试用与开发

需要 Node.js 24 和 npm：

```sh
git clone https://github.com/91godlike/zongpu.git
cd zongpu
npm ci
npm run check
npm test
npm run build
npm run preview:local
```

本地预览使用虚构演示人物，并写入操作系统的临时目录；停止进程后会清除临时数据库。正式部署请使用 Docker 持久化目录。

前端采用 React、TypeScript 和 Vite，后端采用 Node.js、Express 与 SQLite。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。第三方依赖保留各自许可证。
