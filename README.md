# 收信台 Mail Collector

一个本地优先的邮件聚合客户端。可添加支持 IMAP 的邮箱，在统一收件箱中查看和整理邮件，并通过已知服务商的 SMTP 发送邮件。

前端使用 React、TypeScript、Tailwind CSS 和 Vite，生产构建输出到 `public/` 并由 Express 托管。

## 已实现

- 添加多个标准 IMAP 邮箱
- Gmail、Outlook、iCloud、QQ、163、126 常见服务器预设
- 添加账户前测试 IMAP 连接
- 首次同步最近 100 封，之后按 UID 增量同步
- 持久化并校验 IMAP UIDVALIDITY，邮箱 UID 空间重置时安全重建本地收件箱
- 超大邮件或解析失败邮件保留元数据占位，不会静默漏信或阻塞后续邮件
- 聚合列表、按账户筛选、发件人/主题搜索、正文查看
- 同步并显示已读状态，支持在本地标记已读或未读
- 持久化本地星标，支持星标筛选
- 本地收件箱、归档、垃圾箱、垃圾邮件、稍后提醒、草稿和已发送视图
- 默认及自定义标签，支持单封和批量整理
- 基于本地规则自动分类为工作、个人或订阅；新邮件同步时自动执行，并支持一键重新分类
- 本地草稿与 SMTP 发送；发送成功后才保存本地已发送副本
- 分页加载历史邮件和移动端账户切换
- 定时自动同步和手动同步
- AES-256-GCM 加密保存邮箱密码或授权码
- 邮件 HTML 使用沙箱和 CSP 显示，允许远程图片及跟踪像素，但继续禁止脚本和表单
- 邮箱、密码和邀请码注册唯一的本地管理员
- 必填 API Key，保护本地或内网部署的接口并保留兼容登录方式

## 本地运行

要求 Node.js 20 或更高版本。

```bash
npm install
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

复制 `.env.example` 为 `.env`，将生成的 64 位十六进制字符串写入 `ENCRYPTION_KEY`，然后运行：

```bash
npm run dev
```

访问 <http://localhost:3000>。

生产运行：

```bash
npm run build
npm start
```

## Windows 桌面安装包

桌面版使用 Tauri 2 和系统 WebView2 提供轻量原生窗口，现有 Node 邮件引擎作为隐藏 sidecar 随软件安装。数据保存在 Windows 用户应用数据目录，不需要单独安装或启动 Node.js 服务。

```bash
npm run dist:win
```

安装包输出到 `src-tauri/target/release/bundle/nsis/`。当前定制构建首次启动时会检测 `D:\OpenSpace\MailCollector`，将现有数据库通过 SQLite 在线备份迁移到桌面应用目录；邮件数据和密钥不会写入安装包。迁移完成后，桌面版使用独立数据库。

## 邮箱准备

- Gmail：开启两步验证，创建“应用专用密码”。普通登录密码通常不能用于 IMAP。
- Outlook / Microsoft 365：部分租户已禁用密码式 IMAP，需要后续接入 Microsoft OAuth 2.0 才能使用。
- iCloud：在 Apple ID 中创建 App 专用密码。
- QQ / 163 / 126：在邮箱设置中开启 IMAP，并使用生成的授权码，而不是网页登录密码。
- 自建邮箱：填写服务商提供的 IMAP 主机、端口与 TLS 设置。

## 安全与边界

- SMTP 根据 IMAP 主机映射：Gmail、QQ、163、126 使用 465 TLS，Outlook 和 iCloud 使用 587 STARTTLS。自定义 IMAP 主机在没有明确映射时拒绝发送。
- 已读/未读和星标使用持久化 operation outbox 异步写回 IMAP；移动、标签、稍后提醒和永久删除仍保持本地语义，避免在未可靠发现远端文件夹时执行破坏性操作。
- `ENCRYPTION_KEY` 丢失后，已保存的邮箱凭据无法解密；不要随意更换。
- `REGISTRATION_INVITE_CODE` 为首次注册邀请码，至少 12 个字符；当前本地环境的邀请码为 `MC-2026-7F4K9Q2P`，注册成功后系统会关闭新账户注册。
- `API_KEY` 为必填项且至少 24 个字符，用于保护接口，也可继续作为兼容登录方式。
- 本地管理员密码使用 `scrypt` 加盐慢哈希保存。注册完成后关闭新账户注册，正常登录使用 HttpOnly、SameSite=Strict 的 30 天会话 Cookie。
- 服务默认只监听 `127.0.0.1`。需要通过容器或反向代理访问时，可将 `HOST` 改为 `0.0.0.0`，并配置 HTTPS。
- 自定义 IMAP 主机默认不能解析到回环、私网、链路本地或保留地址。如确需连接内网邮件服务器，可显式设置 `ALLOW_PRIVATE_MAIL_HOSTS=true`。
- 本项目适合单用户自托管。公网部署应放在 HTTPS 反向代理后，并进一步增加审计、密码恢复和密钥托管。
- 核心同步仅拉取 metadata。用户打开邮件时才下载并缓存完整 MIME 正文；此时仍会传输附件数据，但附件内容不会写入数据库或提供下载。超出 `MAX_MESSAGE_BYTES` 的正文会标记为失败并保留 metadata。
- 周期 reconciliation 会在配置的近期窗口内把源邮箱缺失邮件标记为 provider tombstone，不会立即物理删除；本地永久删除使用独立 tombstone，后续同步不会让它重新出现。

## 同步架构

- Provider event/API trigger 只写入 SQLite 持久化队列，不直接修改邮件状态。
- 启用 `IMAP_IDLE_ENABLED` 时，每个可用账号保持一个可恢复的 IDLE watcher；`exists`、`expunge`、`flags` 事件经 debounce 后只触发增量同步。服务器不支持 IDLE 时 ImapFlow 自动使用 NOOP fallback。
- 同账号任务通过带过期时间的数据库租约串行执行，不同账号由 Worker 并行处理。
- Provider 请求通过独立并发门控，默认同一 Provider 最多并发 3 个请求。
- 首次同步先保存最近 `INITIAL_SYNC_LIMIT` 封 metadata，随后用低优先级分页 backfill 继续历史邮件。
- 增量批次在同一 SQLite transaction 中完成 message UPSERT、flags/reconciliation 和 cursor 推进。
- `SYNC_INTERVAL_MINUTES` 是调度扫描周期；账号实际 reconciliation 周期由 active/normal/inactive 配置自适应决定。
- Gmail 和 Microsoft 账号当前仍通过通用 IMAP Adapter 工作；数据库和 Provider 接口已预留独立 adapter/cursor/subscription 扩展点，但尚未接入 Gmail History API、Microsoft Graph、OAuth 或云端 webhook。

## 单用户多设备

桌面端支持两种后端模式：

- 本机模式：继续连接桌面应用自动启动的本地 sidecar，数据保存在当前设备。
- 自托管服务器：多台设备连接同一个 Mail Collector 服务，邮箱账号、邮件、同步 cursor 和用户操作都以服务器数据库为准。

### 部署前准备

一键脚本目前支持 Debian 和 Ubuntu。运行前需要：

1. 一台具有公网 IP 的 Linux 服务器，建议至少 1 核 CPU、1 GB 内存和 10 GB 可用磁盘。
2. 一个域名，例如 `mail.example.com`，其 A/AAAA 记录已经指向服务器。
3. 云防火墙和系统防火墙开放 TCP 80、443；Node 服务端口不会直接暴露。
4. 使用 root，或者拥有 `sudo` 权限的账户。

部署脚本会安装或检查 Docker 和 Docker Compose、生成所有随机密钥、下载最新代码、构建后端镜像，并通过 Caddy 自动申请和续订 HTTPS 证书。服务器已有 Docker CE 时，脚本不会用发行版的 `docker.io` 包替换它。需要 Docker Compose v2 或 `docker-compose` 1.25.0 以上版本；脚本会尝试从系统软件源安装可用版本，否则给出明确错误。

### 一键交互安装

```bash
curl -fsSLo /tmp/install-mail-collector.sh https://raw.githubusercontent.com/ArronHC/MailCollector/main/deploy/install-server.sh \
  && sudo bash /tmp/install-mail-collector.sh
```

脚本会询问域名。完成后会输出：

- 服务器 HTTPS 地址。
- 桌面客户端需要填写的 API Key。
- 首次创建管理员账户使用的邀请码。
- 配置文件和数据目录位置。

请立即把 API Key、邀请码和 `ENCRYPTION_KEY` 的配置文件备份到安全位置。

### 无人值守安装

至少提供域名：

```bash
curl -fsSLo /tmp/install-mail-collector.sh https://raw.githubusercontent.com/ArronHC/MailCollector/main/deploy/install-server.sh
sudo env MAIL_COLLECTOR_DOMAIN=mail.example.com bash /tmp/install-mail-collector.sh
```

也可以自行指定密钥和安装目录：

```bash
curl -fsSLo /tmp/install-mail-collector.sh https://raw.githubusercontent.com/ArronHC/MailCollector/main/deploy/install-server.sh
sudo env \
  MAIL_COLLECTOR_DOMAIN=mail.example.com \
  MAIL_COLLECTOR_INSTALL_DIR=/opt/mail-collector \
  MAIL_COLLECTOR_API_KEY='replace_with_a_long_random_secret' \
  MAIL_COLLECTOR_ENCRYPTION_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' \
  MAIL_COLLECTOR_INVITE_CODE='replace_with_private_invite_code' \
  bash /tmp/install-mail-collector.sh
```

自定义 API Key 和邀请码只能包含英文字母、数字、点、下划线、波浪线和连字符，分别至少需要 24 和 12 个字符。`ENCRYPTION_KEY` 必须是 64 位十六进制字符串。需要固定程序版本时，可以额外设置 `MAIL_COLLECTOR_REF` 为包含部署文件的 release tag；后续升级会保留该值。

### 部署内容

默认目录结构：

```text
/opt/mail-collector/
├── compose.sh              统一的服务管理命令，兼容 Compose v1/v2
├── source/                 当前程序源码和 Compose 文件
└── state/
    ├── server.env          密钥和服务器配置，权限 600
    ├── server.env.bak      更新前的配置备份
    ├── data/               SQLite 邮件数据库
    ├── caddy-data/         HTTPS 证书和 Caddy 状态
    └── caddy-config/
```

Docker Compose 启动两个容器：

- `mail-collector-app`：Node 邮件同步、API、SQLite queue 和 IMAP IDLE。
- `mail-collector-caddy`：唯一公开入口，监听 80/443 并反向代理到应用容器。

应用容器不映射宿主机端口，不能绕过 Caddy 直接访问。默认服务器配置等价于：

```env
HOST=0.0.0.0
DATABASE_PATH=/data/mail-collector.db
ALLOW_REMOTE_CLIENTS=true
TRUSTED_PROXY=uniquelocal
REQUIRE_HTTPS=true
```

`TRUSTED_PROXY=uniquelocal` 会信任私有地址来源的转发头，不会验证来源一定是 Caddy。默认 Compose 不公开应用容器的 3000 端口；不要映射该端口，也不要把不可信容器加入同一网络。

### 连接桌面客户端

在桌面端登录页或顶部齿轮中打开“数据与同步”，选择“自托管服务器”，填写 HTTPS 地址和服务器的 `API_KEY`，然后点击“测试并应用”。远端模式使用 API Key，不依赖跨域 Cookie。

第一台设备也可以直接浏览 `https://mail.example.com`，使用脚本输出的邀请码创建唯一管理员账户。管理员注册完成后会自动关闭再次注册。

多台设备连接同一服务器后：

- 邮箱账号只需要在服务器模式下添加一次。
- 邮件、标签、草稿、已读和星标状态以服务器为准。
- 设备每 15 秒静默刷新一次，并在窗口重新聚焦时立即刷新。
- 邮件 Provider 只由服务器同步，不会因设备数量增加而重复调用 IMAP。

### 查看状态和日志

```bash
sudo /opt/mail-collector/compose.sh ps
sudo /opt/mail-collector/compose.sh logs -f --tail=200
```

只查看邮件后端：

```bash
sudo docker logs -f --tail=200 mail-collector-app
```

### 升级服务器

再次执行同一个安装命令即可。脚本会下载最新代码并重新构建容器，同时保留 `state/` 中的数据库、密钥和 Caddy 证书：

```bash
curl -fsSLo /tmp/install-mail-collector.sh https://raw.githubusercontent.com/ArronHC/MailCollector/main/deploy/install-server.sh \
  && sudo bash /tmp/install-mail-collector.sh
```

脚本管理的域名、密钥、版本和同步调优参数会在升级时保留，并额外生成 `server.env.bak`。脚本会重新生成 `server.env`；如果手工增加了其他变量，升级后需要从备份中重新合并。

### 备份和恢复

为了获得一致的 SQLite 和 Caddy 状态备份，短暂停止两个容器，再打包整个 `state` 目录：

```bash
(
  set -e
  compose() {
    sudo /opt/mail-collector/compose.sh "$@"
  }
  compose stop
  trap 'compose start' EXIT
  sudo tar -czf "/root/mail-collector-backup-$(date +%F-%H%M%S).tar.gz" -C /opt/mail-collector state
  compose start
  trap - EXIT
)
```

恢复时停止两个容器，用备份中的 `state/` 替换当前目录，执行 `sudo chmod 600 /opt/mail-collector/state/server.env` 和 `sudo chown -R 1000:1000 /opt/mail-collector/state/data`，再重新启动 Compose。必须同时恢复 `server.env` 和数据库，否则已加密的邮箱凭据可能无法解密。

### 停止或卸载

停止服务但保留数据：

```bash
sudo /opt/mail-collector/compose.sh down
```

重新启动：

```bash
sudo /opt/mail-collector/compose.sh up -d
```

完全删除程序和所有邮件数据：

```bash
sudo /opt/mail-collector/compose.sh down --remove-orphans
sudo rm -rf /opt/mail-collector
```

完全删除不可恢复，执行前必须确认已有备份。

### 手工部署和高级配置

不使用安装脚本时，可以复制示例环境文件并直接运行 Compose。以下命令要求 Docker Compose v2：

```bash
sudo install -d -m 700 /srv/mail-collector /srv/mail-collector/data /srv/mail-collector/caddy-data /srv/mail-collector/caddy-config
sudo install -m 600 deploy/server.env.example /srv/mail-collector/server.env
sudo chown -R 1000:1000 /srv/mail-collector/data
sudo editor /srv/mail-collector/server.env
# 设置全部 replace-me 字段、MAIL_COLLECTOR_DOMAIN 和 MAIL_COLLECTOR_STATE_DIR=/srv/mail-collector
sudo docker compose --project-name mail-collector \
  --env-file /srv/mail-collector/server.env \
  -f deploy/docker-compose.server.yml \
  up -d --build
```

使用独立 Web 前端域名时，在 `server.env` 中增加：

```env
ALLOWED_REMOTE_ORIGINS=https://mail-client.example.com
```

该 Origin 必须使用 HTTPS。桌面客户端使用随机 loopback Origin，在 `ALLOW_REMOTE_CLIENTS=true` 时会自动允许。

注意：

- 非 localhost/127.0.0.1 地址必须使用 HTTPS。
- `ALLOW_REMOTE_CLIENTS` 默认关闭，不会改变现有本机部署的跨站安全边界。
- `TRUSTED_PROXY` 必须填写实际反向代理 IP/CIDR 或受控的 Express 预设，不能信任任意来源的转发头；Node 端口还应通过防火墙限制为仅代理可访问。
- 桌面版通过 Tauri 应用数据目录保存后端配置；只有选择“记住 API Key”时才会一并持久化密钥。浏览器版使用当前站点的 Web Storage。只应在可信个人设备上记住密钥。
- 当前不会自动把已有本机数据库上传到服务器。首次切换时应在服务器模式下重新添加邮箱账号，或手工迁移服务器数据库。
- 桌面应用目前仍会启动本地 sidecar，但远端模式下前端邮件请求不会使用本地数据库。

## 后端 API

- `GET /api/auth/status` 查询是否已完成首次注册；`POST /api/auth/register` 使用 `email`、`password`、`inviteCode` 创建唯一管理员；`POST /api/auth/login` 使用邮箱和密码登录，`POST /api/auth/logout` 和 `GET /api/auth/session` 管理登录会话。
- `GET /api/messages?view=inbox|archive|trash|spam|snoozed|sent|drafts|all&label=<id-or-name>`，并支持 `accountId`、`accountIds`、`query`、`readState`、`starred`、`limit`、`offset`。
- `PATCH /api/messages/:id` 和 `POST /api/messages/bulk` 支持 `isRead`、`isStarred`、`folder`、`snoozedUntil`、`labels`；批量请求额外传 `ids`。
- `DELETE /api/messages/:id` 永久删除本地记录，不写回 IMAP。
- `GET|POST /api/labels`、`DELETE /api/labels/:id` 管理标签；`工作`、`个人`、`订阅` 为受保护默认标签。
- `POST /api/drafts`、`PATCH /api/drafts/:id` 管理草稿；`POST /api/send` 直接发送；`POST /api/drafts/:id/send` 发送并将草稿转换为已发送记录。

## 下一阶段建议

1. Gmail OAuth 2.0 与 Microsoft OAuth 2.0，避免保存应用密码并兼容企业租户。
2. 多用户体系，让每位用户只能访问自己的邮箱与邮件。
3. 附件按需下载、文件类型校验和对象存储。
4. Gmail Pub/Sub 和 Microsoft Graph webhook/subscription，替代对应账号的 IMAP IDLE。
5. 邮件线程、过滤规则和更完整的本地搜索索引。
