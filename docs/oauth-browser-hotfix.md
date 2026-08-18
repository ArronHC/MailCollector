# OAuth browser hotfix

The desktop window is served from the bundled loopback mail service (`http://127.0.0.1:<port>`), so Tauri treats it as a remote URL. The default capability already restricts that remote origin to the `main` window and `http://127.0.0.1:*`.

OAuth authorization uses the app command `open_external_url` to launch Google or Microsoft authorization in the system browser. Tauri v2 app commands must also be explicitly granted by a capability. The `allow-open-external-url` permission grants only this command; the Rust command itself keeps its Google/Microsoft URL allowlist.

This fixes the desktop OAuth button falling back to `window.open()` after a denied IPC invocation, which WebView2 can reject as a blocked popup after the asynchronous OAuth flow-start request.
