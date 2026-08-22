# Mail Collector

Mail Collector 是一个自建的多邮箱聚合客户端。当前架构以 **VPS 作为长期在线的邮件同步核心**，Windows 和 Android 是地位相同的客户端。

## 架构

```text
Gmail / Outlook / QQ / 163 / IMAP
                 │
                 │ IMAP / SMTP / OAuth
                 ▼
          VPS Mail Collector
      同步调度 · 账户凭据 · API
                 │
          HTTPS  │
        ┌────────┴────────┐
        ▼                 ▼
  Windows Client     Android Client
  本地邮件缓存        本地邮件缓存
  独立登录            独立登录
```

核心原则：

- Windows 和 Android 都不依赖另一台设备在线。
- 两端都直接连接同一个 VPS。
- 邮件服务商只由 VPS 负责同步，避免每台设备都建立一套 IMAP IDLE/轮询连接。
- 客户端会把已经读取的账户、邮件列表、邮件正文和标签数据缓存到本地，网络不可用时可回读最近缓存。
- VPS 保留同步所需的服务端数据库和加密凭据，是设备之间的一致性来源。
- Windows 安装包不再内置 Node 邮件服务、SQLite 邮件主库或 FRP。
- 不再需要“电脑批准手机”或“VPS FRP Relay”才能使用 Android。

旧的 `v0.10.1-vps-relay-preview.1` 架构仍可作为历史版本使用，但它要求 Windows 在线；新架构不再使用该依赖关系。

## VPS 部署

推荐使用 Docker，并在前面放 Nginx、Caddy 或 Nginx Proxy Manager 提供 HTTPS。

### 1. 准备环境变量

复制 `.env.example` 为 `.env`，至少设置：

```env
ENCRYPTION_KEY=<64 位十六进制随机值>
API_KEY=<长随机值>
REGISTRATION_INVITE_CODE=<首次注册邀请码>
OAUTH_REDIRECT_BASE_URL=https://mail.example.com/
```

生成随机值可以使用：

```bash
openssl rand -hex 32
```

`ENCRYPTION_KEY` 一旦投入使用不要随意更换，否则已有加密邮箱凭据将无法读取。

### 2. Docker Compose 示例

```yaml
services:
  mail-collector:
    image: ghcr.io/arronhc/mailcollector:latest
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - ./data:/app/data
    ports:
      - "127.0.0.1:8080:8080"
```

如果自行从源码构建：

```bash
docker build -t mail-collector .
docker run -d \
  --name mail-collector \
  --restart unless-stopped \
  --env-file .env \
  -v "$PWD/data:/app/data" \
  -p 127.0.0.1:8080:8080 \
  mail-collector
```

### 3. HTTPS 反向代理

公网只需要暴露 HTTPS。反向代理目标指向：

```text
http://127.0.0.1:8080
```

例如最终地址：

```text
https://mail.example.com
```

客户端首次启动时填写这个地址即可。

不再需要：

- frps
- frpc
- 7000 端口
- 23001 端口
- Windows 公网穿透

## 首次注册与登录

VPS 第一次启动后还没有管理员账户。

Windows 或 Android 第一次连接 VPS 时：

1. 填写 `https://mail.example.com`。
2. 进入注册界面。
3. 输入邮箱、密码和 `.env` 中的 `REGISTRATION_INVITE_CODE`。
4. 注册成功后，该客户端会得到独立的登录 session token。
5. 另一台设备直接连接同一个 VPS 并使用同一账户登录即可。

原生客户端使用 Bearer session，不依赖跨域 Cookie，因此 Windows 和 Android 的认证模型一致。

## 添加邮箱

### Gmail

推荐 OAuth。

由于 OAuth 现在发生在 VPS，请在 Google Cloud 中把 Mail Collector 的 HTTPS 回调地址注册为允许的 redirect URI，并把 Client ID 填入：

```env
GOOGLE_OAUTH_CLIENT_ID=...
OAUTH_REDIRECT_BASE_URL=https://mail.example.com/
```

也可以使用 Google 支持的应用专用密码方式连接 IMAP/SMTP。

### Outlook / Microsoft 365

推荐 OAuth：

```env
MICROSOFT_OAUTH_CLIENT_ID=...
OAUTH_REDIRECT_BASE_URL=https://mail.example.com/
```

Microsoft 应用注册中需要允许对应 redirect URI 和 IMAP/SMTP delegated scopes。

### QQ / 163 / 126 / iCloud

先在邮件服务商后台开启 IMAP/SMTP，并使用服务商生成的授权码或 App 专用密码。

## 客户端缓存

Windows 和 Android 使用相同的前端缓存层。

当前缓存策略：

- 账户列表：本地缓存
- 标签：本地缓存
- 邮件列表：按查询条件缓存
- 已打开的邮件正文：本地缓存
- 在线读取成功后自动刷新缓存
- 网络请求失败时，GET 请求会尝试返回最近一次本地缓存

缓存只是客户端副本，不是新的同步主库。已读、星标、移动、删除、发信等修改操作仍提交到 VPS，再由 VPS 同邮件服务商同步。

## Windows 客户端

Windows 现在是纯客户端：

```text
Tauri
  └─ React UI
       ├─ HTTPS → VPS
       └─ IndexedDB 本地缓存
```

安装包不再启动本地 Node sidecar，也不会因为关闭 Windows 导致 Android 离线。

## Android 客户端

Android 与 Windows 使用同一套 API、认证和缓存逻辑：

```text
Capacitor
  └─ React UI
       ├─ HTTPS → VPS
       └─ 本地 WebView / IndexedDB 缓存
```

首次启动只需要填写 VPS 地址并登录，不再输入电脑生成的 6 位配对码。

## 开发

安装依赖：

```bash
npm ci
```

类型检查：

```bash
npm run typecheck
```

测试：

```bash
npm test
```

构建 VPS 服务和 Web：

```bash
npm run build
```

运行 VPS 服务：

```bash
npm start
```

开发 Web：

```bash
npm run dev:web
```

构建 Windows：

```bash
npm run dist:win
```

## 数据与安全

VPS 的 `data` 目录需要持久化和备份，其中包含：

- SQLite 同步数据库
- 加密后的邮箱账户信息
- OAuth refresh token 加密存储
- 邮件同步状态

不要公开 `API_KEY`、`ENCRYPTION_KEY` 或注册邀请码。

原生客户端只保存自己的登录 session 和本地邮件缓存，不保存 VPS 的主 API Key。

## 从旧 VPS Relay 预览版迁移

旧架构：

```text
Android → HTTPS → VPS/frps → Windows/frpc → Windows sidecar
```

新架构：

```text
Windows ─┐
         ├→ HTTPS → VPS Mail Collector → 邮件服务商
Android ─┘
```

迁移时保留旧 Windows 数据作为备份，然后在 VPS 部署新的服务端数据目录并重新连接邮箱。确认 VPS 同步正常后，再让 Windows 和 Android 都指向新的 HTTPS 地址。
