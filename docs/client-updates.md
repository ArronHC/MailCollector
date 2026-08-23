# 客户端更新与 Android 签名

## Release 产物协议

正式 Release 必须同时包含更新包和对应的 SHA-256 文件：

- `MailCollector-Windows-v<version>-x64-setup.exe`
- `MailCollector-Windows-v<version>-x64-setup.exe.sha256`
- `MailCollector-Android-v<version>.apk`
- `MailCollector-Android-v<version>.apk.sha256`

客户端只接受三段数字版本号，并固定从本仓库同版本 Release 下载。下载完成后必须通过 SHA-256 校验；Android 还会由系统校验 APK 与已安装应用的签名是否一致。

这套方案消除了“去 GitHub 页面重新找安装包”的步骤。Windows 和 Android 的平台安全模型仍要求下载一个可验证的更新载荷；Docker 服务端则天然按镜像层增量拉取。

## 首次配置 Android 发布密钥

只执行一次，并妥善离线备份生成的 `.jks`。密钥丢失后，已经安装的 Android 应用将无法再覆盖升级。

```bash
keytool -genkeypair -v \
  -keystore mailcollector-release.jks \
  -alias mailcollector \
  -keyalg RSA -keysize 4096 -validity 10000

base64 -w 0 mailcollector-release.jks > mailcollector-release.jks.base64
```

在 GitHub 仓库的 Settings → Secrets and variables → Actions 中新增：

- `ANDROID_KEYSTORE_BASE64`：`mailcollector-release.jks.base64` 的完整内容
- `ANDROID_KEYSTORE_PASSWORD`：keystore 密码
- `ANDROID_KEY_ALIAS`：上例为 `mailcollector`
- `ANDROID_KEY_PASSWORD`：私钥密码

工作流不会回退到临时 debug 签名；缺少任意一项会直接失败，以避免发布无法覆盖升级的 APK。

## Android 一次性迁移

历史 APK 使用 GitHub 临时 runner 的 debug 密钥，各次构建签名并不稳定。因此第一次安装固定发布密钥构建的 `v0.13.0` 时：

1. 确认 VPS 正常、记住服务地址与登录账户。
2. 卸载旧 Android 客户端。
3. 从 `v0.13.0` Release 手动安装一次正式 APK。
4. 重新连接 VPS 并登录。
5. 此后收到更新提示时直接在应用内更新。

本地 IndexedDB 缓存会在卸载时清除，但 VPS 邮件主数据、邮箱配置和同步状态不会受影响。
