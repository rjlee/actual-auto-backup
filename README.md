# actual-auto-backup

Automated backup helper for [Actual Budget](https://actualbudget.com/) deployments. The service exports native Actual backup archives (`.zip`) on a schedule, stores them locally (optional), and can replicate the archives to common cloud providers (Google Drive, Amazon S3–compatible storage, Dropbox, WebDAV).

Backups created by this service can be restored directly through the Actual web interface (`Settings → Manage Data → Restore`) without any conversion.

## Features

- **Native ZIP exports** – Uses `@actual-app/api` to generate the same archive produced by Actual's “Download backup” button.
- **Configurable schedule** – Cron expression (default weekly: Mondays at 00:00 UTC) controls when exports run; on-demand runs available via `npm run backup`.
- **Local retention** – Keep the most recent _N_ archives plus optional week/month snapshots to manage disk usage.
- **Multiple budgets** – Provide a comma-separated list of sync targets and the service backs up each one in sequence (archives are named after the budget display name, with the sync ID appended when needed). Targets can include an optional budget identifier in the form `budgetId:syncId` when a single sync contains multiple budgets.
- **Cloud replication** – Independently toggle uploads for Google Drive, S3/B2-compatible storage, Dropbox, or WebDAV shares.
- **Health monitoring** – Structured logging via `pino` and a `/bin/healthcheck.sh` script compatible with Docker health checks (reports healthy until the first backup completes, then enforces freshness thresholds).

## Quick start

```bash
cp env/actual-auto-backup.env.example env/actual-auto-backup.env
cp docker-compose.yml.example docker-compose.yml
```

If you want a self-contained deployment with password protection, copy
`docker-compose.with-auth.yml.example` instead – it bundles Traefik and
[`actual-auto-auth`](https://github.com/rjlee/actual-auto-auth) so the web UI
is fronted by the familiar login screen.

Fill in `env/actual-auto-backup.env` with your Actual credentials and any cloud
provider settings, then launch via Docker Compose or run locally:

```bash
npm install
npm run backup         # Run one export immediately
npm start              # Start the cron scheduler
```

## Configuration

All configuration is sourced from `env/actual-auto-backup.env` when running inside the stack, or from process environment variables directly. Key options:

| Variable                                                        | Description                                                                                                                                          | Default     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `ACTUAL_SERVER_URL`                                             | Base URL of your Actual self-hosted instance                                                                                                         | required    |
| `ACTUAL_PASSWORD`                                               | Actual server password                                                                                                                               | required    |
| `ACTUAL_SYNC_ID`                                                | Primary budget sync ID (used if `BACKUP_SYNC_ID` unset)                                                                                              | required    |
| `BACKUP_SYNC_ID`                                                | Comma-separated list of budgets to export. Each entry must be `BudgetID:SyncID` (as shown in Actual’s Advanced settings); overrides `ACTUAL_SYNC_ID` | _unset_     |
| `ACTUAL_BUDGET_ENCRYPTION_PASSWORD`                             | Budget encryption password (if enabled)                                                                                                              | _unset_     |
| `BACKUP_CRON`                                                   | Cron schedule (UTC)                                                                                                                                  | `0 0 * * 1` |
| `ENABLE_LOCAL`                                                  | Write archives to local disk                                                                                                                         | `true`      |
| `LOCAL_RETENTION_COUNT`                                         | Keep the most recent _N_ archives                                                                                                                    | `4`         |
| `LOCAL_RETENTION_WEEKS`                                         | Keep one archive per week for _N_ weeks                                                                                                              | `0`         |
| `ENABLE_GDRIVE`, `ENABLE_S3`, `ENABLE_DROPBOX`, `ENABLE_WEBDAV` | Toggle cloud uploads                                                                                                                                 | `false`     |

See `env/actual-auto-backup.env.example` for a full list of supported options and comments covering each provider.

## Development

- `npm run lint` – ESLint (flat config).
- `npm run format:check` – Prettier validation.
- `npm test` – Jest test suite (mocks Actual API calls).

The repository ships with GitHub Actions workflows mirroring the existing automation projects: lint/test CI, Docker image builds, release automation, and Dependabot integration.

### Web UI & OAuth Linking

The service exposes a tiny web UI (default port `4010`) for:

- Triggering ad-hoc backups
- Linking / unlinking Google Drive and Dropbox via OAuth
- Viewing the status of each destination

Set `BACKUP_PUBLIC_URL` to the externally reachable base URL (for OAuth
callbacks) and switch Google Drive to OAuth mode by setting `GDRIVE_MODE=oauth`
alongside your OAuth Client ID/Secret. For Dropbox, provide
`DROPBOX_APP_KEY` and `DROPBOX_APP_SECRET`. Linked tokens are stored under
`/app/data/tokens`.

When using the bundled Traefik/auth compose file, the login cookie name defaults
to `backup-auth` – update `AUTH_COOKIE_NAME` in the compose file (and set the
same value in `env/actual-auto-backup.env`) if you want to run multiple
services side-by-side.

#### Multiple budgets

- Add `BACKUP_SYNC_ID` with a comma-separated list of targets. Each target must
  be specified as `BudgetID:SyncID`, matching the labels shown in Actual’s
  **Settings → Advanced → Sync** panel. You can copy those values directly from
  the UI; the Backup overview page also echoes the pairs currently in use.
- Archives are named after the budget’s display name. If two targets resolve to
  the same name the sync ID (or budget ID) is appended to keep filenames
  unique.

### Provider-specific setup

#### Local storage

- Enable with `ENABLE_LOCAL=true` (default). Archives live under `/app/data/backups/<budget-id>/`.
- `LOCAL_RETENTION_COUNT` keeps the newest _N_ archives; `LOCAL_RETENTION_WEEKS` preserves one archive per ISO week for the last _N_ weeks. Any backup that satisfies either rule is retained while older ones are pruned.

#### Google Drive

1. **Service account (default)**
   - Create a Google Cloud service account and share your Drive folder with it.
   - Mount the JSON credentials (`GDRIVE_SERVICE_ACCOUNT_JSON`) and set `ENABLE_GDRIVE=true`.
   - Optional: set `GDRIVE_FOLDER_ID`; otherwise a folder named “Actual Budget Backups” is created.
2. **OAuth (user account)**
   - In Google Cloud Console, create an OAuth client via **APIs & Services → Credentials → Create Credentials → OAuth client ID** (configure the consent screen first if prompted, and choose _Desktop app_ or _Web application_ for the type).
   - Copy the generated **Client ID** and **Client Secret** into `GDRIVE_OAUTH_CLIENT_ID` / `GDRIVE_OAUTH_CLIENT_SECRET`, set `GDRIVE_MODE=oauth`.
   - If you create a Web application client, add `<BACKUP_PUBLIC_URL>/oauth/google/callback` as an authorised redirect URI.
   - Ensure `BACKUP_PUBLIC_URL` points to your externally reachable base (e.g. `https://stack.example.com/backup`).
   - Visit the web UI and click **Link** under Google Drive to authorize. Tokens persist in `/app/data/tokens/google.json`.

#### Amazon S3 / compatible storage

- Set `ENABLE_S3=true`, `S3_BUCKET`, and optionally `S3_PREFIX`.
- Provide credentials via `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`, or rely on the runtime’s IAM role.
- Custom endpoints (MinIO, B2, DigitalOcean) require `S3_ENDPOINT`; set `S3_FORCE_PATH_STYLE=true` if needed.

#### Dropbox

1. **Static token**
   - Generate a long-lived token in Dropbox App Console.
   - Set `DROPBOX_ACCESS_TOKEN` and `ENABLE_DROPBOX=true`.
2. **OAuth workflow**
   - In the Dropbox App Console, create an app (Scoped access) with **Full Dropbox** or **App folder** permissions as desired.
   - Note the generated **App key** / **App secret** and place them in `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET`; leave `DROPBOX_ACCESS_TOKEN` unset.
   - Set the app redirect URI to `<BACKUP_PUBLIC_URL>/oauth/dropbox/callback`.
   - Use the web UI **Link** button; tokens are stored in `/app/data/tokens/dropbox.json`.

#### WebDAV / Nextcloud

- Set `ENABLE_WEBDAV=true`, supply `WEBDAV_URL` (e.g. `https://nextcloud.example.com/remote.php/dav/files/user/`), `WEBDAV_USERNAME`, and `WEBDAV_PASSWORD`.
- Adjust `WEBDAV_BASE_PATH` (default `/actual-backups`) to control the destination folder.

All enabled destinations are attempted in parallel; if any upload fails the backup run is considered unsuccessful (and the health marker is not updated).

## License

MIT
