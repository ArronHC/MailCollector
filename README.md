# 收信台 Mail Collector

一个本地优先、面向单用户的多邮箱聚合客户端。

Mail Collector 在每台设备上直接连接 IMAP/SMTP，邮件正文、索引、草稿和标签均保存在本机。可选的自托管服务端只负责同步经过端到端加密的邮箱连接配置，不接收邮件数据，也无法解密邮箱授权码。

[下载最新 Windows 客户端](https://github.com/ArronHC/MailCollector/releases/latest) · [服务端一键部署](#一键部署)

## 介绍

### 为什么使用 Mail Collector

- 在一个界面中查看 Gmail、Outlook、iCloud、QQ、163、126 和其他标准 IMAP 邮箱。
- 邮件数据留在自己的设备，不依赖第三方邮件聚合服务。
- 多台设备可以同步邮箱连接配置，但每台设备仍独立连接邮箱服务商并保存邮件。
- 同时支持 Windows 桌面客户端和浏览器开发模式，桌面版无需单独安装 Node.js。

### 工作方式

```text
┌─────────────────────────── 客户端 A ───────────────────────────┐
│ React 界面 + 本地 Node sidecar + SQLite                        │
│ 邮件、正文、草稿、标签、索引和本机加密后的邮箱凭据              │
└───────────────┬──────────────────────────┬─────────────────────┘
                │ IMAP / SMTP              │ AES-256-GCM 配置密文
                ▼                          ▼
          邮箱服务商                可选的自托管同步服务端
                ▲                          ▲
                │ IMAP / SMTP              │ AES-256-GCM 配置密文
┌───────────────┴──────────────────────────┴─────────────────────┐
│ React 界面 + 本地 Node sidecar + SQLite                        │
│ 邮件、正文、草稿、标签、索引和本机加密后的邮箱凭据              │
└─────────────────────────── 客户端 B ───────────────────────────┘
```

服务端只看到版本号、随机 IV 和密文。用于解密配置的 256 位同步密钥仅保存在客户端，不会发送到服务端。

### 已实现功能

- 多个标准 IMAP 邮箱账户与统一收件箱。
- Gmail、Outlook、iCloud、QQ、163、126 常见服务器预设。
- 添加账户前测试 IMAP 连接。
- 首次同步最近邮件，之后按 UID 增量同步并分页回填历史邮件。
- 持久化校验 IMAP UIDVALIDITY，UID 空间变化时安全重建本地数据。
- 聚合列表、按账户筛选、发件人和主题搜索、正文阅读。
- 已读和星标状态写回 IMAP，并支持星标筛选。
- 收件箱、归档、垃圾箱、垃圾邮件、稍后提醒、草稿和已发送视图。
- 默认标签、自定义标签、批量整理和本地规则自动分类。
- 本地草稿与 SMTP 发送，发送成功后保存本地已发送副本。
- 定时同步、手动同步、IMAP IDLE 和 NOOP fallback。
- 超大或解析失败邮件保留元数据占位，不阻塞后续同步。
- AES-256-GCM 加密保存邮箱密码或授权码。
- 沙箱与 CSP 隔离邮件 HTML，禁止脚本和表单。
- 可选的端到端加密多设备配置同步。

### 技术栈

| 部分 | 技术 |
| --- | --- |
| 界面 | React 19、TypeScript、Tailwind CSS、Vite |
| 桌面 | Tauri 2、Rust、系统 WebView2 |
| 本地邮件引擎 | Node.js、Express、ImapFlow、Nodemailer、MailParser |
| 数据 | SQLite、better-sqlite3 |
| 配置同步 | AES-256-GCM、版本化密文配置包 |
| 部署 | Docker Compose、Nginx 或 Caddy |

### 当前边界

- 当前定位是单用户自托管，不提供多租户隔离。
- Gmail 和 Microsoft 账户暂时通过通用 IMAP 连接，尚未接入 OAuth 2.0、Gmail History API 或 Microsoft Graph。
- 移动、标签、稍后提醒和永久删除保持本地语义；已读和星标状态通过 operation outbox 异步写回 IMAP。
- 邮件正文按需下载并缓存。附件数据可能随 MIME 正文传输，但当前版本不保存附件内容，也不提供附件下载。
- 自定义 IMAP 主机默认不能解析到回环、私网、链路本地或保留地址。

## 客户端

### 下载与安装

Windows 用户可从 [Releases](https://github.com/ArronHC/MailCollector/releases/latest) 下载最新的 `Mail.Collector_*_x64-setup.exe`。

桌面版使用当前用户安装模式，运行时包含邮件引擎所需的 Node sidecar。安装后无需另行启动后端服务。

本地数据库、密钥和客户端连接设置保存在当前 Windows 用户的应用数据目录中，不会写入安装包。

### 使用模式

客户端顶部齿轮中的“数据与同步”提供两种模式：

#### 仅本机

- 邮箱连接配置和邮件数据都只保存在当前设备。
- 不需要部署服务器。
- 适合单设备使用，或希望完全离线管理配置的场景。

#### 加密配置同步

- 邮箱地址、IMAP 参数和授权码在客户端加密后上传。
- 服务端只保存密文配置包，不保存邮件、正文、草稿、标签或索引。
- 每台设备使用相同的 64 位十六进制同步密钥解密配置。
- 每台设备独立连接 IMAP，因此会分别下载并保存邮件。
- 已读和星标状态可以通过邮箱服务商自然收敛；本地标签和草稿不会跨设备同步。

连接时需要填写：

1. 服务端 HTTPS 地址，例如 `https://mail.example.com`。
2. 服务端安装时生成的 `API_KEY`。
3. 所有设备共用的 64 位十六进制管理员同步密钥。

同步密钥丢失后无法解密云端配置。API Key 与同步密钥用途不同，应分别安全备份。

### 邮箱准备

- Gmail：开启两步验证并创建应用专用密码，普通登录密码通常不能用于 IMAP。
- Outlook / Microsoft 365：部分租户已禁用密码式 IMAP，这类账户需要等待 OAuth 2.0 支持。
- iCloud：在 Apple ID 中创建 App 专用密码。
- QQ / 163 / 126：在邮箱设置中开启 IMAP，并使用生成的授权码。
- 自建邮箱：填写服务商提供的 IMAP 主机、端口和 TLS 设置。

SMTP 会根据已知 IMAP 主机选择安全参数：Gmail、QQ、163、126 使用 465 TLS，Outlook 和 iCloud 使用 587 STARTTLS。无法识别的自定义主机默认拒绝发送，避免错误地向未知 SMTP 端点提交凭据。

### 本地开发

要求 Node.js 20 或更高版本。

```bash
npm install
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

复制 `.env.example` 为 `.env`，至少设置：

```env
ENCRYPTION_KEY=<64 位十六进制字符串>
API_KEY=<至少 24 个字符的随机字符串>
REGISTRATION_INVITE_CODE=<至少 12 个字符的私密邀请码>
```

分别启动本地后端和 Vite：

```bash
npm run dev
npm run dev:web
```

开发界面位于 <http://localhost:5173>，API 请求会代理到 <http://127.0.0.1:3000>。

生产构建和测试：

```bash
npm run build
npm run typecheck
npm test
```

构建 Windows 安装包还需要 Rust 工具链和 WebView2：

```bash
npm run dist:win
```

安装包输出到 `src-tauri/target/release/bundle/nsis/`。

### 客户端安全说明

- `ENCRYPTION_KEY` 用于加密本机数据库中的邮箱密码或授权码，丢失后无法恢复已有凭据。
- 管理员同步密钥用于加密跨设备配置，不会发送到服务端。
- `API_KEY` 用于接口认证，长度至少为 24 个字符。
- 本地管理员密码使用 `scrypt` 加盐慢哈希保存，会话 Cookie 使用 HttpOnly 和 SameSite=Strict。
- 只应在可信个人设备上选择记住 API Key 和同步密钥。
- 邮件 HTML 在沙箱 iframe 中显示；远程图片可能包含跟踪像素，脚本和表单仍被禁止。
- 如需连接私网 IMAP 服务，可显式设置 `ALLOW_PRIVATE_MAIL_HOSTS=true`，但应先确认目标地址可信。

## 服务端

### 服务端职责

服务端是可选组件，仅用于多设备之间同步端到端加密的邮箱连接配置。

推荐部署始终启用：

```env
CONFIG_SYNC_ONLY=true
```

在此模式下：

- 不连接 IMAP 或 SMTP。
- 不启动邮件 Worker 或 IMAP IDLE。
- 不开放账户、邮件、草稿和标签接口。
- 只提供健康检查、版本信息和加密配置包接口。
- SQLite 中只保存配置密文及其 revision，不保存邮件数据。

### 部署要求

一键安装脚本支持 Debian 和 Ubuntu。部署前需要：

1. 一台具有公网 IP 的 Linux 服务器，建议至少 1 核 CPU、1 GB 内存和 10 GB 可用磁盘。
2. 一个已经将 A/AAAA 记录指向服务器的域名。
3. 宿主机上的 Nginx、Caddy 或面板反向代理，由其负责 80/443 和 HTTPS 证书。
4. root 权限或可使用 `sudo` 的账户。

脚本会检查或安装 Docker 与 Docker Compose、生成随机密钥、下载代码并构建应用容器。应用通过 host network 仅监听宿主机 `127.0.0.1:8080`，不会直接暴露到公网。

### 一键部署

```bash
curl -fsSLo /tmp/install-mail-collector.sh https://raw.githubusercontent.com/ArronHC/MailCollector/main/deploy/install-server.sh \
  && sudo bash /tmp/install-mail-collector.sh
```

脚本会询问域名，并在完成后输出：

- 服务端 HTTPS 地址。
- 客户端连接所需的 API Key。
- 配置文件和数据目录位置。
- 反向代理目标 `http://127.0.0.1:8080`。

请立即备份 `/opt/mail-collector/state/server.env`。其中包含服务端 API Key 和应用加密密钥。

### 无人值守部署

至少提供域名：

```bash
curl -fsSLo /tmp/install-mail-collector.sh https://raw.githubusercontent.com/ArronHC/MailCollector/main/deploy/install-server.sh
sudo env MAIL_COLLECTOR_DOMAIN=mail.example.com bash /tmp/install-mail-collector.sh
```

也可以指定安装目录、端口、版本和密钥：

```bash
sudo env \
  MAIL_COLLECTOR_DOMAIN=mail.example.com \
  MAIL_COLLECTOR_INSTALL_DIR=/opt/mail-collector \
  MAIL_COLLECTOR_PROXY_PORT=8080 \
  MAIL_COLLECTOR_REF=main \
  MAIL_COLLECTOR_API_KEY='replace_with_a_long_random_secret' \
  MAIL_COLLECTOR_ENCRYPTION_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' \
  MAIL_COLLECTOR_INVITE_CODE='replace_with_private_invite_code' \
  bash /tmp/install-mail-collector.sh
```

`MAIL_COLLECTOR_API_KEY` 至少需要 24 个字符，`MAIL_COLLECTOR_INVITE_CODE` 至少需要 12 个字符，`MAIL_COLLECTOR_ENCRYPTION_KEY` 必须是 64 位十六进制字符串。需要固定版本时，将 `MAIL_COLLECTOR_REF` 设置为对应 release tag。

### 目录结构

```text
/opt/mail-collector/
├── compose.sh              兼容 Compose v1/v2 的服务管理命令
├── source/                 当前源码和 Compose 文件
└── state/
    ├── server.env          密钥和服务端配置，权限 600
    ├── server.env.bak      升级前的配置备份
    └── data/               SQLite 加密配置包数据库
```

Docker Compose 只启动一个 `mail-collector-app` 容器。默认关键配置为：

```env
HOST=127.0.0.1
PORT=8080
DATABASE_PATH=/data/mail-collector.db
ALLOW_REMOTE_CLIENTS=true
TRUSTED_PROXY=loopback
REQUIRE_HTTPS=true
CONFIG_SYNC_ONLY=true
```

不要将 `HOST` 改为 `0.0.0.0`。`TRUSTED_PROXY=loopback` 只信任同机反向代理的转发头，可避免客户端绕过 HTTPS 入口。

### 反向代理

Nginx HTTPS 站点：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Caddy：

```caddyfile
mail.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

在宝塔或 1Panel 中，将目标设置为 `http://127.0.0.1:8080`，开启 HTTPS，并传递原始 `Host` 和 `X-Forwarded-Proto: https`。

如果反向代理本身运行在 Docker 容器中，它无法直接访问宿主机的 `127.0.0.1`。应改用宿主机 Nginx/Caddy，或单独设计受防火墙保护的 Docker 网络入口。

### 连接客户端

1. 在客户端顶部齿轮中打开“数据与同步”。
2. 选择“加密配置同步”。
3. 填写服务端 HTTPS 地址和安装脚本输出的 API Key。
4. 在第一台设备生成或填写 64 位十六进制同步密钥。
5. 在其他设备填写相同的服务端地址、API Key 和同步密钥。

第一台设备会将已有邮箱连接配置加密上传。其他设备解密并导入配置后，各自开始同步 IMAP 邮件。

### 状态与日志

```bash
sudo /opt/mail-collector/compose.sh ps
sudo /opt/mail-collector/compose.sh logs -f --tail=200
```

直接查看容器日志：

```bash
sudo docker logs -f --tail=200 mail-collector-app
```

健康检查：

```bash
curl -H 'X-API-Key: your-api-key' https://mail.example.com/api/health
```

### 升级

再次执行安装命令即可下载最新代码并重建容器，`state/` 中的数据和密钥会保留：

```bash
curl -fsSLo /tmp/install-mail-collector.sh https://raw.githubusercontent.com/ArronHC/MailCollector/main/deploy/install-server.sh \
  && sudo bash /tmp/install-mail-collector.sh
```

升级时会生成 `server.env.bak`。如果曾手工增加自定义变量，升级后需要从备份中重新合并。

早期版本如果仍运行 `mail-collector-caddy`，应先准备宿主机反向代理，再显式执行迁移：

```bash
curl -fsSLo /tmp/install-mail-collector.sh https://raw.githubusercontent.com/ArronHC/MailCollector/main/deploy/install-server.sh
sudo env MAIL_COLLECTOR_MIGRATE_EXTERNAL_PROXY=true bash /tmp/install-mail-collector.sh
```

迁移完成后立即重启宿主机 Nginx 或 Caddy，并验证 HTTPS 地址。

### 备份与恢复

为获得一致的 SQLite 备份，短暂停止容器并打包整个 `state` 目录：

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

恢复时必须同时恢复 `server.env` 和 `data/`，然后设置权限并重新运行安装脚本：

```bash
sudo chmod 600 /opt/mail-collector/state/server.env
sudo chown -R 1000:1000 /opt/mail-collector/state/data
sudo env MAIL_COLLECTOR_PROXY_PORT=8080 bash /tmp/install-mail-collector.sh
```

### 停止与卸载

停止服务但保留数据：

```bash
sudo /opt/mail-collector/compose.sh down
```

重新启动：

```bash
sudo /opt/mail-collector/compose.sh up -d
```

完全删除程序和数据：

```bash
sudo /opt/mail-collector/compose.sh down --remove-orphans
sudo rm -rf /opt/mail-collector
```

完全删除不可恢复。执行前应确认已有备份，并同时移除反向代理站点和证书配置。

### 手工部署

不使用安装脚本时，可基于 `deploy/server.env.example` 和 `deploy/docker-compose.server.yml` 启动：

```bash
sudo install -d -m 700 /srv/mail-collector /srv/mail-collector/data
sudo install -m 600 deploy/server.env.example /srv/mail-collector/server.env
sudo chown -R 1000:1000 /srv/mail-collector/data
sudo editor /srv/mail-collector/server.env
# 设置全部 replace-me 字段，并将 MAIL_COLLECTOR_STATE_DIR 改为 /srv/mail-collector
sudo docker compose --project-name mail-collector \
  --env-file /srv/mail-collector/server.env \
  -f deploy/docker-compose.server.yml \
  up -d --build
```

使用独立 Web Origin 时，可在 `server.env` 中设置：

```env
ALLOWED_REMOTE_ORIGINS=https://mail-client.example.com
```

公开 Origin 必须使用 HTTPS。`TRUSTED_PROXY` 必须填写实际反向代理 IP/CIDR 或受控的 Express 预设，不能信任任意来源的转发头。
