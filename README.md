# AutoCanvas API

NestJS backend for the separate AutoCanvas user/admin applications. PostgreSQL + Prisma store application data and job/session state. Audio generation scanners run inside the Nest process; analysis uses in-process work with busy-server retries without periodic scanning. Storage is accessed through a provider adapter.

## Documentation map

| Document                                             | Purpose                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Admin/user auth and superadmin](docs/admin-auth.md) | Simple flow, file map, permissions, sessions, bootstrap, optional features and security decisions. |
| [API overview](docs/api-overview.md)                 | Current route families, client contracts and response/error conventions.                           |
| [Audio and analysis flow](docs/audio-flow.md)        | Job states, retries, cancellation, usage limits and relevant service files.                        |
| [Storage and download names](docs/storage.md)        | Actual local/Supabase layout, playback/export behavior and pending storage work.                   |
| [Operations and troubleshooting](docs/operations.md) | Setup, migration/build/test commands and operating boundaries.                                     |

For the three-repository architecture and user UI, see `autocanvas-web/docs/architecture.md` and its README in the frontend repository. Admin frontend status lives in the `autocanvas-admin` README.

## Local setup

Recent verification used Node 24. Install dependencies and prepare a local `.env` with a deliberate development DATABASE_URL and backend-only credentials:

```sh
npm ci
npx prisma migrate deploy --config prisma7.config.ts
npx prisma generate --config prisma7.config.ts
npm run start:dev
```

Default backend port is **4000** (`PORT` overrides it); Swagger UI is at `/swagger/json`. The Prisma config filename is **prisma7.config.ts**, not the conventional prisma.config.ts. The environment example contains placeholders and is not a complete deployment configuration; read [operations](docs/operations.md).

User frontend normally runs on `http://localhost:3000`, admin frontend on `http://localhost:3001`. Keep their origins and session flows separate.

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

Missing test DB configuration causes those database suites to skip. Example connection details are placeholders, not deployed credentials. See [operations](docs/operations.md) for smoke checks and limitations.

## Maintenance

Reuse existing PrismaService, auth guards, TokenService, role service and StorageService. Keep SQL migrations with schema changes. Update DTOs, clients and docs when changing an API. Never commit real environment secrets, tokens or generated audio. Historical [backend handoff notes](AutoCanvas_Backend_Handoff.md) predate parts of the current implementation and are not the current API/port contract.

## Runtime analysis model

Apply migration `20261025002500_analysis_model_setting` before deploying this code, then regenerate Prisma:

```sh
npx prisma migrate deploy --config prisma7.config.ts
npx prisma generate --config prisma7.config.ts
```

Super Admin can change the Gemini story-analysis model from the admin Global Settings page. Non-secret values live in AppSetting; GEMINI_MODEL remains a fallback until an override is saved. Changes affect new uncached analysis without a restart; running jobs keep their initial model. Resetting the setting restores the environment/default. Existing cached analysis is retained. API credentials remain backend-only and may be managed through encrypted provider-key storage; OpenAI analysis is not implemented. See [API overview](docs/api-overview.md) and [audio flow](docs/audio-flow.md).

## Admin runtime controls

Super Admin now manages shared web text (English/Hindi), public JSON app settings, new-AI/provider feature switches, analysis and outline model settings, one encrypted key per provider (Gemini/OpenAI), multi-scene recovery settings and credits pricing. Read [API overview](docs/api-overview.md), [operations](docs/operations.md) and [audio flow](docs/audio-flow.md) before deployment. Apply the ProviderCredential migration and configure server-only AI_KEYS_ENCRYPTION_KEY before adding/importing keys. Existing .env credentials remain fallback until managed mode is explicitly enabled. Credits billing and Razorpay INR checkout are implemented; activation requires merchant configuration. See operations for setup and limitations.

The public app bootstrap is `GET /app-config` returning appStrings/appSettings/locale/features. Local frontend defaults remain the fallback. Admin saves reuse one existing AppSetting writer; encrypted provider credentials stay separate. No generated string catalog, new config table or schema migration is required. See the frontend guide for the four-step request/context/hook flow.

Automatic provider key switching is removed. Only GEMINI_API_KEY / OPENAI_API_KEY or one explicitly managed key per provider are used; legacy multi-key env flags and per-key quota controls are ignored. See operations for safe handling of legacy saved rows.


Configuration uses the native-JSON `Configuration` Prisma model. Before running
this version on an existing database, deploy migration
`20261026060000_configuration_groups` and regenerate Prisma using the setup commands
above. It preserves existing settings in service groups; see
[configuration migration and export](docs/operations.md#grouped-configuration-storage-and-diagnostics).
