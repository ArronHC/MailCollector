# 收信台 Mail Collector

Mail Collector 是一个本地优先的多邮箱聚合客户端。Windows 桌面端保存邮件数据并直接连接邮箱服务商；Android 客户端通过你自己的 VPS Relay 安全访问桌面端。

> 当前移动端 + VPS Relay 为预览功能。Windows 预览安装包未签名，Android 为 debug APK。

## 下载

本次 VPS Relay 预览版：

- [Windows 安装包 + Android APK](https://github.com/ArronHC/MailCollector/releases/tag/v0.10.1-vps-relay-preview.1)
- [全部 Releases](https://github.com/ArronHC/MailCollector/releases)

预览版 Release 中包含：

- `MailCollector-Windows-v0.10.1-vps-relay-preview.1-x64-setup.exe`
- `MailCollector-Windows-v0.10.1-vps-relay-preview.1-x64-setup.exe.sha256`
- `MailCollector-Android-v0.10.1-vps-relay-preview.1-debug.apk`
- `MailCollector-Android-v0.10.1-vps-relay-preview.1-debug.apk.sha256`

## 架构

推荐的移动端架构如下：

```text
Android
   │
   │ HTTPS :443
   ▼
mail.example.com
Nginx / Caddy / Nginx Proxy Manager
   │
   ▼
VPS 127.0.0.1:23001
   │
   │ frps
   │ TLS + Relay Token
   ▼
Internet
   ▲
   │ frpc 主动建立连接
   │
Windows Mail Collector
   │
   ▼
127.0.0.1:<随机端口>
Node sidecar + SQLite
```

VPS 只负责传输流量。邮箱密码、OAuth Token、SQLite 数据库、邮件正文、草稿和索引仍保存在 Windows 主机，不会同步到 VPS。

Android 要访问邮件时，Windows Mail Collector 必须处于运行状态。如果 Windows 主机离线，VPS 不会保存一份邮件副本供手机继续访问。

## 快速开始

完整流程只有四步：

1. 在 VPS 安装并配置 `frps v0.70.1`。
2. 给 VPS 配置一个 HTTPS 域名，例如 `https://mail.example.com`。
3. 在 Windows Mail Collector 中填写 VPS Relay 设置并测试连通。
4. 桌面生成 6 位配对码，在 Android 上输入并由桌面批准。

下面分别说明每一端的操作。

---

## Windows 桌面端操作指南

### 1. 安装

从上面的预览 Release 下载：

```text
MailCollector-Windows-v0.10.1-vps-relay-preview.1-x64-setup.exe
```

运行安装程序即可。当前预览包没有 Authenticode 签名，因此 Windows SmartScreen 可能显示“未知发布者”，这是预览构建的已知现象。

桌面安装包已经内置：

- Mail Collector UI
- Node.js sidecar
- 生产依赖
- `frpc v0.70.1`

不需要另行安装 Node.js 或 FRP 客户端。

本地数据库、密钥和 Relay 配置保存在当前 Windows 用户的应用数据目录，不会写入安装包。

### 2. 添加邮箱

打开 Mail Collector 后，在账户界面添加需要聚合的邮箱。

常见邮箱准备方式：

- Gmail：优先使用应用支持的 OAuth；如果使用 IMAP 密码方式，需要 Google 允许的应用专用凭据。
- Outlook / Microsoft 365：优先使用 OAuth；部分租户已经禁用传统密码式 IMAP。
- iCloud：在 Apple ID 中创建 App 专用密码。
- QQ / 163 / 126：先在邮箱设置中开启 IMAP/SMTP，再使用生成的授权码。
- 自建邮箱：填写服务商提供的 IMAP 主机、端口、TLS 和认证信息。

### 3. 配置 VPS Relay

先完成后面的 VPS 部署，再回到 Windows：

```text
设置 → VPS Relay
```

填写：

| 设置项 | 示例 | 说明 |
| --- | --- | --- |
| 启用 VPS Relay | 开启 | 保存后自动启动 frpc |
| VPS 地址 | `203.0.113.10` 或 `vps.example.com` | 不要带 `http://` / `https://` |
| FRP 服务端口 | `7000` | 必须与 `frps.toml` 的 `bindPort` 一致 |
| Relay 端口 | `23001` | 必须与 `allowPorts` 和反代目标一致 |
| 手机 HTTPS 地址 | `https://mail.example.com` | 手机最终只访问这个地址 |
| Relay Token | 一段长随机字符串 | 必须与 VPS 上 `auth.token` 完全一致 |

点击：

```text
保存并应用
```

正常情况下状态会依次变成：

```text
FRP 进程：运行中
隧道：已连接
```

然后点击：

```text
测试公网入口
```

测试会实际执行完整链路：

```text
Windows → frpc → VPS frps → 127.0.0.1:23001
        → HTTPS 反向代理 → 公网域名 → Windows Mail Collector
```

只有“公网入口可访问”成功后再进行手机配对。

### 4. 生成手机配对码

进入：

```text
设置 → 设备配对
```

点击：

```text
生成配对码
```

会出现一个 6 位一次性代码。代码有效期为 5 分钟，并且只能完成一次配对。

当 VPS Relay 已配置时，桌面端会优先使用 Relay 的 HTTPS 地址作为手机连接地址。

手机提交配对请求后，桌面会显示设备名称和平台。确认是自己的手机后点击：

```text
批准
```

配对完成后，Android 会获得独立的 Device Token。手机不会保存桌面的 API Key。

### 5. 日常使用

Windows Mail Collector 打开时：

```text
本机 Node sidecar
      ↑
    frpc
      ↑
     VPS
      ↑
   Android
```

关闭 Windows Mail Collector 后，frpc 会同时关闭，手机将无法连接。

frpc 如果异常退出，Mail Collector 会尝试自动重连。

---

## VPS 操作指南

### 1. 准备条件

需要：

- 一台 Linux VPS
- 一个域名，例如 `mail.example.com`
- 域名 A/AAAA 记录指向 VPS
- TCP `443` 对公网开放
- TCP `7000` 能被 Windows 主机访问
- TCP `23001` **不要对公网开放**

推荐端口用途：

```text
443    Android → HTTPS
7000   Windows frpc → VPS frps
23001  VPS 本机反向代理 → FRP 转发端口
```

生成 Relay Token：

```bash
openssl rand -hex 32
```

保存输出，后面 VPS 和 Windows 要填写同一个 Token。

### 2. 配置 frps v0.70.1

Mail Collector 桌面端固定使用 FRP `v0.70.1`，VPS 建议保持同一版本。

创建：

```text
/etc/frp/frps.toml
```

内容：

```toml
bindAddr = "0.0.0.0"
bindPort = 7000

# 让 23001 只监听 VPS 本机，禁止 Internet 直接访问。
proxyBindAddr = "127.0.0.1"

auth.method = "token"
auth.token = "替换为 openssl rand -hex 32 生成的 Token"
auth.additionalScopes = ["HeartBeats", "NewWorkConns"]

# 拒绝未使用 TLS 的 frpc 控制连接。
transport.tls.force = true

# 此 frps 只允许 Mail Collector 使用 23001。
allowPorts = [
  { single = 23001 }
]
```

#### Docker Compose 方式

Linux 上可以使用 host network，使 `proxyBindAddr = "127.0.0.1"` 真正绑定到 VPS 本机回环地址。

```yaml
services:
  frps:
    image: ghcr.io/fatedier/frps:v0.70.1
    container_name: mailcollector-frps
    restart: unless-stopped
    network_mode: host
    volumes:
      - /etc/frp/frps.toml:/etc/frp/frps.toml:ro
    command: ["-c", "/etc/frp/frps.toml"]
```

启动：

```bash
docker compose up -d
docker logs -f mailcollector-frps
```

#### 原生二进制 / systemd 方式

也可以下载 FRP 官方 `v0.70.1` Linux 包，把 `frps` 放到 `/usr/local/bin/frps`，然后创建 systemd 服务：

```ini
[Unit]
Description=Mail Collector FRP Server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

保存为：

```text
/etc/systemd/system/mailcollector-frps.service
```

然后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mailcollector-frps
sudo systemctl status mailcollector-frps
```

### 3. 防火墙

至少确认：

```text
443/tcp   允许 Internet
7000/tcp  允许 Windows 主机访问
23001/tcp 不允许 Internet
```

如果 Windows 有固定公网 IP，可以进一步把 `7000/tcp` 只允许该 IP，提高安全性。

不要为了排错把 `23001` 长期开放到 `0.0.0.0`。

### 4. 配置 HTTPS 域名

把：

```text
mail.example.com
```

解析到 VPS。

#### Caddy

最简单的配置：

```caddy
mail.example.com {
    reverse_proxy 127.0.0.1:23001
}
```

Caddy 正常情况下会自动申请和续期 HTTPS 证书。

#### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name mail.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:23001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
        client_max_body_size 20m;
    }
}
```

#### Nginx Proxy Manager

如果 Nginx Proxy Manager 运行在 Docker 中，容器内的 `127.0.0.1` 指向 NPM 容器自己，而不是 VPS 主机。

需要让 NPM 通过以下任一方式访问 VPS 主机的 `23001`：

- host network；
- `host-gateway`；
- 与 FRP 使用受控的私有 Docker 网络。

不要简单把 `23001:23001` 发布到所有公网网卡。

### 5. VPS 自检

Windows Relay 已连接以后，在 VPS 本机测试：

```bash
curl http://127.0.0.1:23001/api/service
```

再测试公网 HTTPS：

```bash
curl https://mail.example.com/api/service
```

两者都应返回 Mail Collector 服务信息。

如果第一个失败，问题通常在 FRP。

如果第一个成功、第二个失败，问题通常在域名、TLS 或反向代理。

---

## Android 操作指南

### 1. 安装 APK

从预览 Release 下载：

```text
MailCollector-Android-v0.10.1-vps-relay-preview.1-debug.apk
```

Android 可能要求允许当前浏览器或文件管理器“安装未知应用”。这是侧载 APK 的正常系统权限。

当前为 debug APK，仅用于预览测试。

### 2. 首次配对

先保证：

- Windows Mail Collector 正在运行；
- Windows 中 VPS Relay 显示已连接；
- “测试公网入口”成功；
- 桌面已经生成 6 位配对码。

打开 Android Mail Collector，选择配对码方式。

填写：

```text
服务地址：https://mail.example.com
配对码：桌面显示的 6 位数字
```

提交后手机会等待桌面批准。

回到 Windows：

```text
设置 → 设备配对 → 批准
```

批准后，手机会完成加密密钥交换并保存：

- VPS HTTPS 地址
- Android 自己的 Device Token

不会保存桌面 API Key。

### 3. 配对后的使用

之后 Android 直接访问：

```text
https://mail.example.com/api/...
```

请求路径为：

```text
Android
  → HTTPS
  → VPS
  → FRP
  → Windows Mail Collector
```

不需要与 Windows 位于同一 Wi-Fi，也不需要知道 Windows 局域网 IP。

### 4. 手机无法连接时

按顺序检查：

1. Windows Mail Collector 是否开着。
2. Windows「设置 → VPS Relay」里的 FRP 进程是否运行。
3. 隧道是否显示已连接。
4. “测试公网入口”是否成功。
5. 手机上填写的域名是否是 HTTPS。
6. 配对凭证是否仍有效；持续出现 401 时重新配对。

---

## 配对与认证是怎么工作的

设备配对使用：

```text
P-256 ECDH
   ↓
HKDF-SHA256
   ↓
AES-GCM
```

桌面批准后，配对 bundle 加密传给 Android。

Android 之后使用独立的：

```text
X-Device-Token
```

访问 Mail Collector API。

VPS Relay 又有单独一层 FRP Token，因此是两套不同的凭证：

```text
FRP Relay Token
用于 Windows ↔ VPS

Device Token
用于 Android ↔ Mail Collector API
```

Relay Token 在 Windows 本地使用 Mail Collector 的 AES-256-GCM 密钥加密保存。生成的 `frpc.toml` 不包含明文 Token，而是通过环境变量模板注入。

---

## 常见故障排查

### Relay 显示“FRP 客户端不可用”

请确认安装的是包含 VPS Relay 的最新 Windows 版本。预览安装包已经内置并在 CI 中校验 `frpc v0.70.1`。

### FRP 进程运行，但隧道未连接

检查：

- VPS `7000/tcp` 是否可达；
- `frps` 是否正在运行；
- Windows 和 VPS 的 Relay Token 是否完全一致；
- `frps.toml` 是否允许 `23001`；
- 服务端是否强制 TLS，但客户端版本过旧。

VPS：

```bash
docker logs mailcollector-frps
```

或：

```bash
journalctl -u mailcollector-frps -f
```

### 隧道已连接，但公网入口测试失败

在 VPS 上依次执行：

```bash
curl http://127.0.0.1:23001/api/service
curl https://mail.example.com/api/service
```

第一条失败：检查 FRP。

第一条成功、第二条失败：检查 DNS、HTTPS 证书和 Nginx/Caddy/NPM。

### Android 显示 401

设备凭证无效或配对信息已经丢失。重新生成配对码并批准手机。

### Android 显示超时 / 502

通常意味着：

- Windows 电脑关机或休眠；
- Mail Collector 已退出；
- frpc 与 VPS 断开；
- VPS 反代无法访问 `127.0.0.1:23001`。

### Windows SmartScreen 警告

当前 VPS Relay 预览安装包未签名。正式发布启用 Authenticode 签名后可消除此类“未知发布者”提示。

---

## 安全建议

- VPS 的 `23001` 必须只在本机或受控私网可访问。
- 对公网只开放 HTTPS `443`；FRP `7000` 能限制来源 IP 时尽量限制。
- Relay Token 建议至少 32 字节随机值。
- 不要把 Relay Token 提交进 Git 仓库、截图或公开日志。
- 手机只使用 HTTPS 公网地址，不要把未加密 HTTP 暴露到 Internet。
- VPS 不需要保存邮箱密码、OAuth Token、数据库或邮件正文。
- Windows 本地 Node sidecar 继续绑定 `127.0.0.1`，不要为了移动端直接改成公网监听。
- 如果怀疑 Relay Token 泄露，立即在 VPS 生成新 Token，并在 Windows Relay 设置中同步更换。

---

## 已实现功能

- 多邮箱统一收件箱。
- Gmail、Outlook、iCloud、QQ、163、126 和标准 IMAP 邮箱。
- OAuth/密码等账户认证路径。
- IMAP 增量同步、UIDVALIDITY 校验、历史邮件分页回填。
- 聚合列表、账户筛选、发件人/主题搜索和正文阅读。
- 已读、星标、归档、垃圾箱、垃圾邮件、草稿、已发送等视图。
- 自定义标签、批量整理和规则分类。
- SMTP 发信和本地草稿。
- IMAP IDLE / NOOP fallback 与定时同步。
- AES-256-GCM 加密本地凭据。
- HTML 邮件 iframe 沙箱与 CSP 防护。
- Windows Tauri 桌面端。
- Android Capacitor 客户端。
- 6 位一次性设备配对。
- Android Device Token 鉴权。
- Windows 自动管理 VPS FRP Relay。

## 技术栈

| 部分 | 技术 |
| --- | --- |
| UI | React 19、TypeScript、Tailwind CSS、Vite |
| Windows | Tauri 2、Rust、WebView2 |
| Android | Capacitor 8 |
| 邮件引擎 | Node.js、Express、ImapFlow、Nodemailer、MailParser |
| 数据 | SQLite、better-sqlite3 |
| VPS Relay | FRP v0.70.1 + HTTPS reverse proxy |
| 设备配对 | P-256 ECDH、HKDF-SHA256、AES-GCM |

---

## 本地开发

### Node / Web

要求 Node.js 20 或更高版本；Android/Capacitor 构建使用 Node.js 22。

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

启动：

```bash
npm run dev
npm run dev:web
```

开发界面：

```text
http://localhost:5173
```

生产检查：

```bash
npm run typecheck
npm test
npm run build
```

### Windows 构建

需要 Rust、Windows WebView2 和 Windows C++ 构建工具：

```bash
npm run dist:win
```

`prepare:desktop-runtime` 会在 Windows 构建主机上下载官方 FRP v0.70.1 archive、校验官方 SHA-256，然后把 `frpc.exe` 打入桌面 runtime。

### Android 构建

需要 Node.js 22、JDK 21 和 Android SDK：

```bash
npm run build:web
npm install --no-save @capacitor/core@8 @capacitor/cli@8 @capacitor/android@8
npx cap add android
npx cap sync android
cd android
./gradlew assembleDebug
```

APK 位于：

```text
android/app/build/outputs/apk/debug/
```

## 进一步文档

- [`docs/vps-relay.md`](docs/vps-relay.md)：VPS Relay 的独立部署说明。
- GitHub Actions 会持续验证 Node、Rust、Windows runtime、FRP bundle 和 Android APK 构建。
