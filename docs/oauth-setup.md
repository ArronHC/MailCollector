# OAuth mail account setup

Mail Collector supports OAuth-first account setup for Gmail and Outlook / Microsoft 365 while keeping application-password authentication for iCloud, QQ, NetEase, and generic IMAP providers.

## Google / Gmail

1. Create or select a Google Cloud project and configure the OAuth consent screen.
2. Create an OAuth client with application type **Desktop app**.
3. Copy the client ID into `GOOGLE_OAUTH_CLIENT_ID`.
4. Enable the Gmail account access required by the app. Mail Collector currently keeps its IMAP/SMTP engine and requests the `https://mail.google.com/` scope so the OAuth access token can authenticate both protocols.
5. For a public distribution, complete Google's OAuth app verification requirements before treating the integration as production-ready. The Gmail scope used by IMAP/SMTP is intentionally broad.

Desktop builds use a loopback redirect on the local Mail Collector service and open the authorization page in the system browser. Do not add a client secret to the desktop app.

## Microsoft / Outlook

1. Register an application in Microsoft Entra ID.
2. Add the **Mobile and desktop applications** platform and the `http://localhost` redirect URI.
3. Enable public client flows; do not create or embed a client secret for the desktop app.
4. Add delegated permissions for IMAP and SMTP access. Mail Collector requests:
   - `https://outlook.office.com/IMAP.AccessAsUser.All`
   - `https://outlook.office.com/SMTP.Send`
   - `offline_access`, `openid`, `profile`, and `email`
5. Copy the application (client) ID into `MICROSOFT_OAUTH_CLIENT_ID`.

The desktop callback uses an ephemeral localhost port. Microsoft treats the port component of a localhost native-app redirect as dynamic.

## GitHub release builds

Create these repository **Variables** (not Secrets; OAuth public-client IDs are not confidential):

- `GOOGLE_OAUTH_CLIENT_ID`
- `MICROSOFT_OAUTH_CLIENT_ID`

The Windows release workflow exposes the variables while compiling the Tauri app. The client IDs are embedded as public configuration and are passed to the bundled local mail service at runtime.

If either variable is absent, that provider's OAuth button is disabled and the UI keeps the application-password fallback available.

## Local and container development

Set the same values in the environment or `.env` file:

```env
GOOGLE_OAUTH_CLIENT_ID=...
MICROSOFT_OAUTH_CLIENT_ID=...
```

For a hosted browser deployment, set `OAUTH_REDIRECT_BASE_URL` to the externally reachable callback base URL. Desktop builds normally leave it unset so the local loopback callback is used.

## Token storage

Mail Collector stores only an encrypted OAuth marker in the existing account credential column. Refresh/access credentials are kept in a separate local `*.oauth-secrets.json` store and each record is encrypted with the existing Mail Collector encryption key. Access tokens are refreshed automatically before expiry. Removing an account also removes its OAuth credential record.

If a refresh grant is revoked or expires, the provider error is classified as reauthentication-required and the cached mailbox remains available locally.
