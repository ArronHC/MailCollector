# Cloud configuration sync migration

Applied idempotently by `MailDatabase.migrate()` as schema version 3.

- Adds stable UUID `sync_id` and `sync_updated_at` fields to accounts and backfills existing rows.
- Adds a unique account sync ID index.
- Adds the singleton `cloud_config_bundle` table with revisioned opaque JSON storage and a 512 KiB envelope limit.
