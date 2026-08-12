# 收信台 Mail Collector

一个本地优先、面向单用户的多邮箱聚合客户端。

Mail Collector 在每台设备上直接连接 IMAP/SMTP，邮件正文、索引、草稿和标签均保存在本机。多台设备各自连接邮箱服务商，已读和星标等状态通过邮箱服务商自然收敛，不需要自建任何服务器。

[下载最新 Windows 客户端](https://github.com/ArronHC/MailCollector/releases/latest)

## 介绍

### 为什么使用 Mail Collector

- 在一个界面中查看 Gmail、Outlook、iCloud、QQ、163、126 和其他标准 IMAP 邮箱。
- 邮件数据留在自己的设备，不依赖第三方邮件聚合服务。
- 电脑、手机等多台设备可以各自连接邮箱并保持收件状态一致。
- 同时支持 Windows 桌面客户端和浏览器开发模式，桌面版无需单独安装 Node.js。

### 工作方式

```text
┌─────────────────────────── 设备 A ──────────────────────────────┐
│ React 界面 + 本地 Node sidecar + SQLite                         │
│ 邮件、正文、草稿、标签、索引和本机加密后的邮箱凭据               │
└───────────────┬─────────────────────────────────────────────────┘
                │ IMAP / SMTP
                ▼
           邮箱服务商
                ▲
                │ IMAP / SMTP
┌───────────────┴─────────────────────────────────────────────────┐
│ React 界面 + 本地 Node sidecar + SQLite                         │
│ 邮件、正文、草稿、标签、索引和本机加密后的邮箱凭据               │
└─────────────────────────── 设备 B ──────────────────────────────┘
```

每台设备独立连接邮箱服务商并保存邮件。已读、星标和归档状态通过 IMAP 在设备间自然同步；本地标签、草稿和稍后提醒保持本机语义。

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

### 技术栈

| 部分 | 技术 |
| --- | --- |
| 界面 | React 19、TypeScript、Tailwind CSS、Vite |
| 桌面 | Tauri 2、Rust、系统 WebView2 |
| 本地邮件引擎 | Node.js、Express、ImapFlow、Nodemailer、MailParser |
| 数据 | SQLite、better-sqlite3 |

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

### 多设备使用

- 邮箱连接配置和邮件数据都只保存在当前设备。
- 电脑、手机等每台设备各自添加一次邮箱账户即可。
- 已读、星标和归档状态通过邮箱服务商自然同步；本地标签、草稿和稍后提醒不跨设备。

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
- `API_KEY` 用于接口认证，长度至少为 24 个字符。
- 本地管理员密码使用 `scrypt` 加盐慢哈希保存，会话 Cookie 使用 HttpOnly 和 SameSite=Strict。
- 只应在可信个人设备上选择记住 API Key。
- 邮件 HTML 在沙箱 iframe 中显示；远程图片可能包含跟踪像素，脚本和表单仍被禁止。
- 如需连接私网 IMAP 服务，可显式设置 `ALLOW_PRIVATE_MAIL_HOSTS=true`，但应先确认目标地址可信。
