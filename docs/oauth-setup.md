# OAuth mail account setup

Mail Collector supports OAuth-first account setup for Gmail and Outlook / Microsoft 365 while keeping application-password authentication for iCloud, QQ, NetEase, and generic IMAP providers.

## Google / Gmail

1. Create or select a Google Cloud project and configure the OAuth consent screen.
2. Create an OAuth client with application type **Desktop app**.
3. Copy the client ID into `GOOGLE_OAUTH_CLIENT_ID`.
4. Enable the Gmail account access required by the app. Mail Collector currently keeps its IMAP/SMTP engine and requests the `https://mail.google.com/` scope so the OAuth access token can authenticate both protocols.
5. For a public distribution, complete Google's OAuth app verification requirements before treating the integration as production-ready.

`https://mail.google.com/` is a Google restricted scope and covers IMAP/SMTP access. A public production app using this scope must complete restricted-scope verification unless it qualifies for an exception, and Google can require recurring security assessment/reverification for restricted-scope access. Plan this as an operational/compliance dependency rather than only a client-ID setup step.

Windows builds use a random loopback redirect handled by the Tauri process and open the authorization page in the system browser. Do not add a client secret to the desktop app.

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

## Configure the Windows client

Open **Settings → Mail OAuth** in Mail Collector and enter the values shown as **Google Client ID** and **Microsoft Client ID**.

The values are public identifiers and are stored only in that Windows profile's local application settings. They are not embedded into a release and do not need to be configured on Android or in the VPS `.env` file.

If either value is absent, that provider's OAuth button is disabled and the application-password fallback remains available.

## Credential handoff to the VPS

After Windows completes Authorization Code + PKCE locally, it sends the resulting credential through the authenticated HTTPS API to the configured VPS. The VPS:

- verifies the access token by opening the provider IMAP connection before creating the account;
- encrypts the refresh/access tokens and per-account public Client ID at rest;
- refreshes access tokens with the Client ID stored alongside that account;
- owns the long-running IMAP/SMTP synchronization, so Windows can go offline;
- exposes the synchronized account and mail data to both Windows and Android clients.

Android does not receive provider OAuth tokens or Client IDs. It only uses its Mail Collector session to read and update VPS data. The optional server environment Client IDs and `OAUTH_REDIRECT_BASE_URL` remain only as a legacy hosted-browser fallback.

## Token storage

Mail Collector stores only an encrypted OAuth marker in the existing account credential column. Refresh/access credentials are kept in a separate local `*.oauth-secrets.json` store and each record is encrypted with the existing Mail Collector encryption key. Access tokens are refreshed automatically before expiry. Removing an account also removes its OAuth credential record.

If a refresh grant is revoked or expires, the provider error is classified as reauthentication-required and the cached mailbox remains available locally.
