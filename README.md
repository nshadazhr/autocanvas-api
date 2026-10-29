# AutoCanvas API

NestJS backend for the separate AutoCanvas user/admin applications. PostgreSQL + Prisma store application data and job/session state. Audio generation scanners run inside the Nest process; analysis uses in-process work with busy-server retries without periodic scanning. Storage is accessed through a provider adapter.

## Documentation map

| Document                                             | Purpose                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Admin/user auth and superadmin](docs/admin-auth.md) | Simple flow, file map, permissions, sessions, bootstrap, optional features and security decisions. |
| [API overview](docs/api-overview.md)                 | Current route families, client contracts and response/error conventions.                           |
| [Audio and analysis flow](docs/audio-flow.md)        | Job states, retries, cancellation, usage limits and relevant service files.                        |
| [Storage and download names](docs/storage.md)        | Actual local/Supabase/R2 layout, playback/exports and tracked-upload cleanup.                   |

For user UI setup/behavior see the web repository README and frontend guide when that checkout is available. Admin frontend status lives in the `autocanvas-admin` README.

## Local setup

Recent verification used Node 24. Install dependencies and prepare a local `.env` with a deliberate development DATABASE_URL and backend-only credentials:

```sh
npm ci
npx prisma migrate deploy --config prisma7.config.ts
npx prisma generate --config prisma7.config.ts
npm run start:dev
```

Default backend port is **4000** (`PORT` overrides it); Swagger UI is at `/swagger/json`. The Prisma config filename is **prisma7.config.ts**, not the conventional prisma.config.ts. The environment example contains placeholders, not working credentials; use the environment notes below.

User frontend normally runs on `http://localhost:3000`, admin frontend on `http://localhost:3001`. Keep their origins and session flows separate.

## Docker deployment

Use the same Dockerfile for sandbox and production, with separate hosting environment values. Both build and runtime use Node 24 Alpine with OpenSSL. `npm ci --include=dev` installs the lockfile versions and build tools, then Prisma generation explicitly uses `prisma7.config.ts` before compiling Nest. Runtime includes that config alongside the CLI/schema/migrations, dependencies and compiled prompts. The API runs as the unprivileged `node` user using compiled `dist/main.js`, not TypeScript source; its local assets directory is writable by that user. Set `NODE_ENV=production` in Render for both hosted sandbox and production; the Dockerfile does not set it or select a database, storage provider or payment mode. `EXPOSE 4000` documents the API default; the actual listener honors the platform's `PORT` value. Real environment files, local recordings and generated Prisma sources are excluded from the build context; Prisma is regenerated inside the image. Build dependencies are retained because the runtime image also supplies the Prisma migration CLI.

```sh
docker build -t autocanvas-api:check .
```

The image build does not require production credentials or run database migrations. Supply backend secrets only at runtime through the host. Before starting against an intended database, apply reviewed migrations with:

```sh
npx prisma migrate deploy --config prisma7.config.ts
```

On Render select Docker, use `./Dockerfile`, leave Root Directory blank for this repository, and supply the matching web/admin origins and server-only credentials. Configure the migration command above as the **Pre-Deploy Command** on each paid service before enabling releases; leave Docker Command blank. Set HTTP Health Check Path to the existing `/app-config` endpoint, which exercises configuration/database reads, rather than relying only on an open TCP port. The order is image build, successful pending migrations, new API startup and platform health checks/traffic switch. Failed migration blocks the new deploy, but earlier successful migration statements might already have changed the shared database, so reviewed migrations must remain compatible with the old running app. Commit migrations with their schema/code changes; a local migration does not update remote databases. Auto-deploy on a Git push does not itself configure automatic migration. The default Docker command only starts the API and does not change a database. For a sandbox service without pre-deploy support, use this Docker Command override after confirming DATABASE_URL is the sandbox database:

```sh
/bin/sh -c 'npx prisma migrate deploy --config prisma7.config.ts && exec node dist/main.js'
```

Do not run migrations in an image build or copy production data into sandbox. Native Node Build/Start fields and Render's `NODE_VERSION` selection do not control this Docker image. Deployment and runtime smoke checks still require a working Docker daemon and deliberate environment configuration; a source build alone does not prove a container boot or remote deployment.

## Verification

```sh
npm run build
npx tsc --noEmit --incremental false
```

For database suites, first provision and migrate a **disposable local database whose name ends in `_test`**. They never fall back to the app DATABASE_URL:

```sh
AUDIO_FLOW_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/autocanvas_test npx vitest run --config vitest.admin-auth.config.ts
AUDIO_FLOW_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/autocanvas_test npx vitest run --config vitest.audio-flow.config.ts
```

Missing test DB configuration causes those database suites to skip. Example connection details are placeholders, not deployed credentials. The suites require an explicitly configured disposable test database; skipped suites are not passed tests.

## Maintenance

Reuse existing PrismaService, auth guards, TokenService, role service and StorageService. Keep SQL migrations with schema changes. Update DTOs, clients and docs when changing an API. Never commit real environment secrets, tokens or generated audio.

## Runtime analysis model

Apply migration `20261025002500_analysis_model_setting` before deploying this code, then regenerate Prisma:

```sh
npx prisma migrate deploy --config prisma7.config.ts
npx prisma generate --config prisma7.config.ts
```

Super Admin configures story analysis on the admin Providers & Models page:
primary provider, each provider's primary/backup models, optional provider
fallback, and bounded delayed primary retries. Gemini and OpenAI reuse the shared
prompt/schema and existing backend credential storage. Configuration is stored
under `Configuration.analysis_settings`; until first save, the current legacy
Gemini model remains the primary with two delayed retries at five seconds.
Running jobs capture their configuration; cached results remain valid. No new
schema migration is required for routing. Audio generation and script outlines
keep their existing settings. See [API overview](docs/api-overview.md#analysis-routing-settings-super-admin)
and [audio flow](docs/audio-flow.md).

## Admin runtime controls

Super Admin now manages shared web text (English/Hindi), public JSON app settings, new-AI/provider feature switches, analysis and outline model settings, multi-scene recovery settings, credits pricing and new-payment checkout enablement. Read [API overview](docs/api-overview.md) and [audio flow](docs/audio-flow.md) before deployment. Provider credentials are managed only through backend GEMINI_API_KEY / OPENAI_API_KEY environment settings. Apply migration `20261028143000_env_only_provider_keys` and regenerate Prisma when upgrading; it removes stored credentials and source flags, preserving models and feature settings. Credits billing and Razorpay INR checkout are implemented; activation requires merchant configuration. See environment notes below and the retained API/auth guides for setup boundaries.

The public app bootstrap is `GET /app-config` returning appStrings/appSettings/locale/features. Local frontend defaults remain the fallback. Admin saves reuse one existing AppSetting writer; provider credentials stay in the backend environment. No generated string catalog, new config table or schema migration is required. See the frontend guide for the four-step request/context/hook flow.

Automatic provider key switching is removed. Only GEMINI_API_KEY / OPENAI_API_KEY are used; legacy multi-key env flags and per-key quota controls are ignored. Provider keys stay in server environment configuration.


Configuration uses the native-JSON `Configuration` Prisma model. Before running
this version on an existing database, deploy migration
`20261026060000_configuration_groups` and regenerate Prisma using the setup commands
above. It preserves existing settings in service groups; see
[setup and checks](#local-setup).

## Analysis diagnostics migration

Before deploying the current backend, apply
`20261027060000_analysis_provider_http_status` using the migration/generation
commands above. It adds one nullable HTTP status field to analysis jobs for
admin diagnostics; see [setup and checks](#local-setup).

## Analysis attempt history migration

Before deploying attempt/model history, apply
`20261027120000_analysis_attempt_history` with the existing migrate-deploy and
Prisma-generate commands. This adds per-request metadata and per-job successful
result snapshots. Historical records are not guessed/backfilled. See
[audio flow](docs/audio-flow.md#admin-analysis-inspection) and
[setup and checks](#local-setup).

## Analysis workspace

The admin /providers page groups configuration and read-only monitoring under
Analysis tabs. Monitoring uses the existing request history, not live provider
probes, and needs no additional database migration. See
[performance API](docs/api-overview.md#analysis-performance-monitoring).


## Developer environment and safety

Run backend commands from this repository root. For local work select a deliberate local PostgreSQL database, local user/admin origins and `STORAGE_PROVIDER=local`. Read `.env.example` for supported deployment variable names; never commit real credentials or edit an operator's real environment file. DATABASE_URL, JWT_SECRET and JWT_REFRESH_SECRET are server-only. Email/Google/provider features require their configured server credentials; frontend NEXT_PUBLIC values contain no backend secrets. Startup currently constructs AI/email clients, so local storage selection alone does not remove their configuration requirements.

Default origins are localhost:3000 (user) and localhost:3001 (admin) outside production. Configure exact HTTPS REQUEST_ORIGIN_PORT and ADMIN_ORIGIN for deployed apps; NODE_ENV=production has Secure cookies. API documentation is `/swagger/json`. Missing tables/columns require checking the selected database and versioned migration status, not resetting shared data.

Inspect migrations before applying them. `migrate deploy` modifies the selected database. Never use reset/db-push as a routine shared-data repair. Provider/storage changes do not move existing files; retain saved-provider readers and follow [storage contracts](docs/storage.md). Non-secret budgets/recovery/cleanup/login controls belong in private Super Admin configuration; signing/provider/storage credentials remain server deployment values.

Backend test config files include vitest.admin-auth.config.ts, vitest.audio-flow.config.ts and focused feature configs. Commands above use a disposable local `_test` database only; suites can remove fixture data. Real provider/payment/storage calls require task-specific authorization. A mocked or skipped suite is not a successful live check.

## Documentation maintenance

AGENTS.md owns contributor/AI-agent rules. This README owns local setup and command discovery; docs/api-overview.md, admin-auth.md, audio-flow.md and storage.md own necessary developer contracts. Detailed owner-only operations, cross-app architecture, planning and verification history live in a separate private documentation repository. Code maintenance must remain possible without private access; do not reproduce private runbooks here.


Razorpay checkout enablement is managed only by Super Admin → Pricing & Credits → Payment checkout. Credentials remain backend environment values. A disabled checkout does not disable existing payment verification/reconciliation or signed webhook processing. See [payments contract](docs/api-overview.md#runtime-admin-controls). Existing installations should save and verify their current effective flag before manually removing legacy `RAZORPAY_ENABLED`; agents must not edit real environment files.
