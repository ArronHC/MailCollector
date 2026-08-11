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
- 删除本地邮件不会通过 IMAP 删除源邮箱邮件；移动、标签、稍后提醒和永久删除均为本地状态。
- `ENCRYPTION_KEY` 丢失后，已保存的邮箱凭据无法解密；不要随意更换。
- `REGISTRATION_INVITE_CODE` 为首次注册邀请码，至少 12 个字符；当前本地环境的邀请码为 `MC-2026-7F4K9Q2P`，注册成功后系统会关闭新账户注册。
- `API_KEY` 为必填项且至少 24 个字符，用于保护接口，也可继续作为兼容登录方式。
- 本地管理员密码使用 `scrypt` 加盐慢哈希保存。注册完成后关闭新账户注册，正常登录使用 HttpOnly、SameSite=Strict 的 30 天会话 Cookie。
- 服务默认只监听 `127.0.0.1`。需要通过容器或反向代理访问时，可将 `HOST` 改为 `0.0.0.0`，并配置 HTTPS。
- 自定义 IMAP 主机默认不能解析到回环、私网、链路本地或保留地址。如确需连接内网邮件服务器，可显式设置 `ALLOW_PRIVATE_MAIL_HOSTS=true`。
- 本项目适合单用户自托管。公网部署应放在 HTTPS 反向代理后，并进一步增加审计、密码恢复和密钥托管。
- 同步完整邮件时 IMAP 仍会传输邮件内的附件数据，但附件内容不会写入数据库或提供下载；超出 `MAX_MESSAGE_BYTES` 的邮件只保存 envelope 元数据。后续版本应改为按 MIME part 下载正文，进一步降低带附件邮件的网络和内存开销。
- 源邮箱删除或移动邮件目前不会删除本地副本，当前语义更接近本地聚合归档。

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
4. IMAP IDLE 或任务队列，实现更低延迟和更可靠的后台同步。
5. 邮件线程、过滤规则和更完整的本地搜索索引。
