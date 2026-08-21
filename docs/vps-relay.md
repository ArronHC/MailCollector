# Mail Collector VPS Relay

Mail Collector Desktop can keep its Node service bound to `127.0.0.1` while a bundled `frpc` creates an outbound tunnel to your VPS. The Android app then uses one fixed HTTPS origin such as `https://mail.example.com`.

## Recommended topology

```text
Android -> HTTPS -> Nginx/Caddy on VPS -> 127.0.0.1:23001 -> frps -> encrypted FRP tunnel -> Desktop 127.0.0.1:<random-port>
```

The VPS is only a transport relay. Mail credentials, OAuth tokens, the SQLite database, and message bodies stay on the desktop machine.

## 1. Install frps v0.70.1

Use the same FRP version as Mail Collector Desktop. The official release is `v0.70.1`.

Create `/etc/frp/frps.toml`:

```toml
bindAddr = "0.0.0.0"
bindPort = 7000
proxyBindAddr = "127.0.0.1"

# Replace this with a long random secret and enter the same value in
# Mail Collector -> Settings -> VPS Relay -> Relay Token.
auth.method = "token"
auth.token = "CHANGE_ME_TO_A_LONG_RANDOM_TOKEN"
auth.additionalScopes = ["HeartBeats", "NewWorkConns"]

# Reject non-TLS frpc control connections.
transport.tls.force = true

# Only let this FRP server allocate the Mail Collector relay port.
allowPorts = [
  { single = 23001 }
]
```

Run frps using the official binary or the official `ghcr.io/fatedier/frps:v0.70.1` container. Keep TCP port `7000` reachable from the desktop. Do **not** expose `23001` directly to the Internet; with the native binary, `proxyBindAddr = "127.0.0.1"` keeps it local to the VPS.

If you run frps in Docker instead of host networking, publish the ports like this:

```yaml
ports:
  - "7000:7000/tcp"
  - "127.0.0.1:23001:23001/tcp"
```

and omit `proxyBindAddr = "127.0.0.1"` inside the container if your container runtime cannot bind that address. The host-side `127.0.0.1` publishing rule is what prevents direct public access to the relay port.

## 2. Add HTTPS reverse proxy

Point `mail.example.com` to the VPS and issue a valid TLS certificate. A host Nginx configuration can use:

```nginx
server {
    listen 443 ssl;
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

For Nginx Proxy Manager or another containerized reverse proxy, make sure it can reach the FRP relay port without publishing that port publicly. Prefer a shared private Docker network or an explicit host-gateway route over opening `23001` on `0.0.0.0`.

## 3. Configure Mail Collector Desktop

Open **Settings -> VPS Relay** and enter:

- VPS address: the VPS hostname/IP used by `frpc` to reach `frps`
- FRP server port: `7000`
- Relay remote port: `23001`
- Phone HTTPS address: `https://mail.example.com`
- Relay Token: the same long token as `auth.token` on frps

Enable the relay and click **Save and Apply**, then **Test Public Endpoint**. A successful test performs a full round trip through the HTTPS domain, VPS reverse proxy, FRP tunnel, and the local Mail Collector service.

The token is encrypted in Mail Collector's settings store with the application's existing AES-256-GCM key. The generated `frpc.toml` references the token through an environment variable, so the token itself is not written into the FRP configuration file.

## 4. Pair Android

Once the relay test passes, create a device pairing code. The desktop pairing UI automatically prefers the configured Relay HTTPS address. On Android, use that HTTPS address and the six-digit code; after desktop approval, the phone receives its own device credential and no longer needs the desktop API key.
