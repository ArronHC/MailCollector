# Multi-device account sync

Mail Collector account sync is intentionally separate from mail synchronization.

Each device continues to connect directly to Gmail, Outlook/Microsoft 365, or the configured IMAP server and maintains its own local SQLite mail cache, UIDVALIDITY/UID cursors, backfill state, search data, drafts, and attachments. The relay only carries encrypted mailbox account configuration and renewable credentials.

## What is synchronized

The encrypted account payload contains:

- stable `syncId`
- display name and email address
- provider, IMAP host/port/TLS, username, and mailbox
- enabled/disabled state
- application password/password, or an OAuth refresh credential

The payload never contains mail bodies, attachments, local SQLite contents, IMAP cursors, local sync errors, access tokens, or the local `ENCRYPTION_KEY`.

OAuth access tokens are intentionally not synchronized. A new device imports the refresh credential and obtains its own short-lived access token from Google or Microsoft.

## Encryption model

A device generates a 256-bit Recovery Key formatted as `mcsk1_...`. Account payloads are encrypted with AES-256-GCM before they leave that device.

The Recovery Key is stored locally inside the encrypted Mail Collector account-sync configuration. It is never sent to the relay. The relay sees only:

- `syncId`
- monotonically increasing revision
- ciphertext
- deletion/tombstone marker
- timestamp

The relay bearer token and Recovery Key are separate secrets. Knowing the relay token allows access to encrypted records but does not decrypt them.

Back up the Recovery Key. If every device that knows it is lost, relay data cannot be decrypted. Existing local Mail Collector installations remain usable because account sync is not required for normal mail operation.

## Run a self-hosted relay

Any Mail Collector server/container can act as the relay for its own account-sync namespace. Set a long random token on the relay instance:

```env
ACCOUNT_SYNC_RELAY_TOKEN=replace-with-a-long-random-secret
```

A convenient generator is:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Expose that Mail Collector instance through HTTPS. Client configuration rejects plain HTTP for non-loopback relay URLs so the bearer token is not sent over an unencrypted network.

The relay API is separate from the normal Mail Collector session/API-key authentication and uses:

```text
Authorization: Bearer <ACCOUNT_SYNC_RELAY_TOKEN>
```

Do not configure the Recovery Key in relay environment variables.

## Configure the first device

Open **Settings → Account sync** and:

1. Enter the HTTPS URL of the relay, for example `https://mail-sync.example.com`.
2. Enter the relay bearer token.
3. Click **Generate sync key**.
4. Copy the displayed Recovery Key somewhere safe.
5. Enable account sync and save.
6. Click **Sync now** for the first upload.

The first upload creates encrypted records for existing local accounts.

## Add another device

On the new device:

1. Install/sign in to Mail Collector normally.
2. Open **Settings → Account sync**.
3. Enter the same relay URL and relay token.
4. Paste the same Recovery Key from the first device.
5. Enable account sync, save, and click **Sync now**.

The device downloads account configuration, re-encrypts passwords/OAuth credentials with its own local `ENCRYPTION_KEY`, creates local account rows while keeping runtime state local, and starts its own initial IMAP synchronization.

For Gmail or Microsoft OAuth accounts, the new device must also have the corresponding `GOOGLE_OAUTH_CLIENT_ID` or `MICROSOFT_OAUTH_CLIENT_ID` configured. Official Windows builds embed the repository OAuth client IDs; self-hosted web/container deployments should configure them in the environment.

## Conflicts and deletes

The relay uses optimistic base revisions. Every write creates a new monotonically increasing revision. Clients pull before pushing; a stale writer is forced to observe the newer revision before retrying.

Remote tombstones win over an unchanged offline copy, preventing a deleted mailbox account from being silently resurrected when an old device reconnects. Local changes detected after a non-delete remote update are preserved and re-pushed against the latest revision.

Deleted account tombstones remain in the relay history so offline devices can observe the delete later.

## Local-first behavior

Account sync is optional. If it is disabled or the relay is unavailable:

- existing accounts continue working locally
- IMAP/SMTP synchronization continues
- local mail data is not blocked by the relay
- a later successful account sync resumes from the saved relay cursor

## Current v0.10 limitations

- one relay token represents one encrypted sync namespace; a multi-user hosted service is a future implementation of the same protocol
- Recovery Key transfer is manual copy/paste; QR/device pairing is planned
- Recovery Key rotation is not yet exposed
- app settings, trusted senders, labels/rules, mail bodies, attachments, and local drafts are not synchronized
