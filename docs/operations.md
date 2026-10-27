# Backend operations and troubleshooting

## Setup and startup

Use the backend repository root as working directory; local storage/prompt paths depend on it. Recent verification used Node 24. Install from the lockfile, configure a deliberate development DB and credentials, then:

```sh
npm ci
npx prisma migrate status --config prisma7.config.ts
npx prisma migrate deploy --config prisma7.config.ts
npx prisma generate --config prisma7.config.ts
npm run build
npm run start:dev
```

Migrate deploy modifies DATABASE_URL's target. Read the migration and verify the environment first. Use versioned migrations; do not reset a shared database or use db push as a substitute for deploying migration history. Production uses built output (`npm run start:prod`) and environment-managed secrets.

See the web repository's `docs/development.md` for the three local applications/ports and a placeholder environment example. Current backend default is 4000; PORT overrides it. Swagger UI is `/swagger/json`. Existing handoff notes contain older port/route assumptions.

## Configuration groups

| Group                          | Variables / source                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| DB and auth                    | DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET; `prisma7.config.ts`, `src/auth/`.                                                 |
| Server                         | PORT, NODE_ENV; `src/main.ts`.                                                                                                  |
| Origins and login limits       | REQUEST_ORIGIN_PORT, ADMIN_ORIGIN, additional application origins and limit names documented in [admin-auth.md](admin-auth.md). |
| Email / Google                 | RESEND_API_KEY, optional RESEND_FROM_EMAIL; GOOGLE_CLIENT_ID.                                                                   |
| AI                             | GEMINI_API_KEY and optional GEMINI_MODEL; OPENAI_API_KEY and optional OPENAI_MODEL for script outlines.                         |
| Shared provider/admission caps | AI_* and ANALYSIS_* names/defaults in [audio-flow.md](audio-flow.md).                                                           |
| Audio recovery                 | AUDIO_MAX_RECOVERY_ATTEMPTS, AUDIO_RECOVERY_RETRY_DELAY_MS, AUDIO_RETRY_SCAN_INTERVAL_MS.                                       |
| Storage                        | STORAGE_PROVIDER; Supabase URL/service-role key/bucket when selected. See [storage.md](storage.md).                             |
| Diagnostics                    | AI_DIAGNOSTICS_USER_IDS; no implicit role bypass.                                                                               |

The environment example is not a complete runnable configuration. Never commit a real `.env`, provider key, signing secret, refresh cookie or connection credential. NEXT_PUBLIC frontend variables must not contain backend secrets. Current application startup constructs AI/email clients even if a particular request does not use them.

## Operating boundaries

- At least one healthy Nest process must remain available for the in-process scanners/workers. Analysis/audio job state is persisted in PostgreSQL; there is no requirement to install a Redis/BullMQ stack for the implemented pipeline.
- Do not manually toggle active job/item states to force progress. Inspect retry time, worker lease/heartbeat, safe errors and provider/application quotas first.
- Shared provider limits are conservative request/character caps, not exact billing/credit accounting. The credit badge is backed by the real wallet; subscription plan labels remain demo data.
- Supabase and local data must be backed up with database references. Retain existing storage providers/buckets when switching new-write destinations.
- If deployed behind a reverse proxy, review Express trust proxy for known proxy addresses. Current main.ts does not provide a magic TRUST_PROXY environment handler; do not assume X-Forwarded-For is trusted or trust arbitrary forwarded headers. The IP login limiter otherwise sees the network peer.
- NODE_ENV=production selects Secure cookies. Configure real HTTPS user/admin origins; do not rely on development defaults for a deployed admin app.
- Restrict the existing local `/uploads/` static route if recordings need privacy; its behavior differs from authorized API streaming. Review how Swagger is exposed at the deployment edge.

## Auth and superadmin rollout

Read [admin-auth.md](admin-auth.md) for detailed session rules and bootstrap command. Apply auth-session and audit migrations before starting the corresponding code. The session-enforcement upgrade requires a one-time re-login for legacy tokens. Subsequent role changes revoke the target's existing sessions intentionally.

The bootstrap command promotes a registered, email-verified password account; deployment does not auto-create/promote a real administrator. Administrative role operations must use AdminRoleService so locks, last-superadmin protection, session revocation and audit stay transactional.

## Focused verification

Build/type checks:

```sh
npm run build
npx tsc --noEmit --incremental false
```

Provision a disposable local `_test` database with the migrations before integration tests. Never use the application database: fixture/accounting cleanup is intentional.

```sh
AUDIO_FLOW_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/autocanvas_test npx vitest run --config vitest.admin-auth.config.ts
AUDIO_FLOW_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/autocanvas_test npx vitest run --config vitest.audio-flow.config.ts
```

Those configs skip DB suites if the variable is absent. Auth suites exercise real sessions/roles over HTTP/PostgreSQL. Audio/analysis suites use stubbed Gemini/storage and a JWT-verification auth test double; they test their own workflow behavior, not live provider availability. Previously run full-Nest smoke checks used disposable accounts and real password hashing. Do not describe stub tests as a live Supabase/Gemini validation.

After a relevant change, verify only the affected flows and their boundaries. Useful smoke paths include fresh login/refresh/logout, role denial, first generation, wait/retry, cancellation, reload restoration, playback/range, ZIP and combined export. A paid provider call should be a deliberate separate smoke test.

## Troubleshooting map

| Symptom                              | First checks                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Boot/table/column error              | Correct DATABASE_URL, migration status and generated client; do not immediately reset data.                                  |
| 401 after logout/role change/upgrade | Intentional session revocation or legacy tokens; sign in through the correct application flow.                               |
| 403 admin request                    | Current DB role, token audience and admin Origin; role alone does not bypass diagnostic allowlists.                          |
| 429 login                            | Retry-After and fixed-window account/IP caps; check proxy IP handling if many people share a peer.                           |
| Provider job WAITING                 | Next retry time, shared usage buckets and provider retry/network status.                                                     |
| Failed attempt but old audio plays   | Expected: old files are preserved; inspect the latest item error/current revision.                                           |
| Audio file missing/export fails      | Persisted provider/key, original bucket/root, current revision and metadata/file existence.                                  |
| Correct job but UI blank/crashes     | Verify latest-job response shape, no-job empty response handling and full history; do not infer all scenes from a retry job. |
| Duplicate UI requests                | Polling is expected. Check mutation idempotency/refs and backend conflicts before blaming a repeated status GET.             |

Log safe resource IDs, status/error codes and timestamps. Redact tokens/credentials and avoid logging full scripts/provider responses or user password records. Historical handoffs are reference material; code and these current docs are the implementation contract.

## Dashboard runtime controls and encrypted provider keys

Apply migration `20261025011500_provider_credentials` and regenerate Prisma before deploying these controls. Keep the existing analysis-model AppSetting migration as well. Local development verification uses the configured development database; tests use a separate disposable `_test` database.

```sh
npx prisma migrate deploy --config prisma7.config.ts
npx prisma generate --config prisma7.config.ts
```

`AI_KEYS_ENCRYPTION_KEY` is a server-only, base64-encoded 32-byte key. Generate it securely, store it in the backend environment/hosting secret store, and back it up separately from the database. Never commit it or put it in NEXT_PUBLIC variables. Provider credentials use AES-256-GCM with a random IV and provider/record identity as authenticated context. API responses contain only masked suffixes. A missing master key disables add/import; unreadable encrypted keys fail safely. Changing the master key without re-encrypting existing records makes those records unreadable; master-key rotation/re-encryption is not implemented.

Before first save/import, each provider uses its single environment key (GEMINI_API_KEY or OPENAI_API_KEY). Save/import explicitly replaces the selected dashboard key after UI confirmation; the record identity stays stable. There is no automatic key rotation or fallback on errors. Disabled, removed or unreadable selected keys fail clearly. Environment mode is restored only by the explicit admin action. Existing legacy extra credential rows are preserved, ignored by selection and hidden from the single-key UI. Remove clears the selected encrypted value and leaves a disabled primary row, so old extras never become an automatic fallback. No schema migration or bulk deletion runs. Already-sent requests may finish using their captured key.

GEMINI_API_KEYS, GEMINI_MULTI_KEY_ENABLED and GEMINI_RPM_LIMIT/GEMINI_RPD_LIMIT are no longer read; remove these obsolete entries from deployment configuration when convenient. Runtime processing controls now cover recovery attempts and retry delay only. Shared AI usage protections remain.

Non-secret runtime configuration stays in Configuration, separate from ProviderCredential. Backend .env retains infrastructure/auth/mail/storage secrets, server origins, the encryption master key, scanner timing and fallback values. Dashboard changes do not rewrite .env. Login protection is unchanged. Configuration/key change history is not added to the existing role-audit UI in this change.

Feature switches block new analysis/audio/outline submissions. Maintenance blocks new AI work without blocking admin login, existing reads/downloads or cancellation. Provider switches also prevent subsequent provider requests; they do not abort a request already sent. Multi-scene recovery attempts/delay are read for new processing/recovery work; scanner interval remains deployment configuration. Script outlines reuse OpenAIProvider and resolve saved outline model and the current enabled key on each request.

App Strings accepts arbitrary text keys; generated catalogs/export scripts are no longer needed. App Settings accepts arbitrary public JSON configuration. PUT /admin/config/web-strings and /admin/config/web-settings replace the whole override document (body: {values, locale}); PATCH remains partial and null removes a field. Omitted keys fall back locally, nested objects merge and arrays replace in the web resolver. Important controls edit the same JSON keys. Both documents are public; never store credentials there. Text HTML/placeholders stay data. Root must be an object; text values must be strings. Known home setting types/language, 64 KB document size, nesting depth and unsafe object keys are validated. Private backend sections retain strict allowlists and cannot use PUT. Hardcoded copy in other untouched pages is not automatically migrated. Credit pricing is enforced by wallet reservations and settlement; Razorpay activation requires the backend credentials below.

Public configuration flow: `GET /app-config` -> frontend AppConfigProvider -> existing text/settings hooks. Response fields are appStrings/appSettings/locale/features; the old /public/config route is removed. Deploy web and API together. Each browser load fetches once; published changes require reload. There is no focus timer, polling or frontend secret. The Configuration migration below preserves existing configuration data. Both save APIs reuse one transaction writer; PATCH merges fields while PUT replaces only the web override document. Legacy AppSetting keys are consolidated by the Configuration migration; encrypted ProviderCredential rows are unchanged. ProviderCredential remains separate because public JSON must never contain provider keys.

## Credits and Razorpay INR

Apply `20261025120000_credits_and_payments` and regenerate Prisma before starting API, web or admin. Existing users start with zero credits and no retroactive welcome grant. Newly verified users receive the configured welcome grant once, when their wallet is first used. Defaults are zero; Super Admin configures rates and packs on Pricing & Credits.

Backend-only variables: `RAZORPAY_ENABLED=true`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`. Never put secrets in public appConfig or browser environment variables. Checkout receives only the public key ID and a server-priced order. Use Razorpay test credentials first and configure automatic capture. Set a public HTTPS webhook URL `/credits/payments/webhook` for payment.captured, order.paid, refund.processed and payment.dispute.created. Localhost requires a reachable testing endpoint. See [official integration](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/) and [webhook validation](https://razorpay.com/docs/webhooks/validate-test/).

Callback and webhook processing verify signatures, then fetch provider payment status and verify order, amount, INR currency and capture. Duplicate delivery grants credits once. A lost browser callback can be recovered through Check payment. Failed or dismissed checkout does not grant credits. If verification is unavailable after paying, check existing purchase status; do not pay again. Order creation is idempotent per user/request ID and limited to ten checkout attempts per fifteen minutes to prevent provider abuse. Changing/deactivating a pack does not change existing orders.

Refunds/disputes freeze new wallet spending for manual review; the app does not issue monetary refunds. Super Admin checks the payment in Razorpay, adjusts unearned credits where possible, and clears the review with a reason. Reserved generation can finish or refund while the wallet is blocked. A negative adjustment cannot make available balance negative. Review clearing is idempotent and audited in the ledger. There is no automatic accounting for chargeback debt or subscription billing. Review all related purchases before clearing a user's block.

Payment signing-key rotation with outstanding orders requires operational care: verification uses the currently configured secret; retain working provider access and reconcile outstanding purchases before rotating keys. Production payment activation and real test-mode checkout require merchant credentials and a reachable signed webhook; automated tests use mocked provider responses, never live money.

Disposable database verification: `AUDIO_FLOW_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/autocanvas_test npx vitest run --config vitest.credits.config.ts`. Tests reject non-local/non-test URLs. Existing audio tests also exercise paid reservation, partial failure, retry and cancellation. No AI/provider requests are made in these fixtures.

### Live verification — 2026-10-25

Initial attempts exposed an invalid Gemini key (Google HTTP 400 / API_KEY_INVALID) and an admin-disabled audio feature. After the operator replaced the key and enabled audio, the following real checks passed using a separate synthetic development account:

- Gemini analyzed the Hindi story on its first attempt. Voices were assigned through the authenticated cast API; multi-voice generation was started from the actual web UI.
- All five scene recordings completed. A real provider 429 put the last scene in WAITING after four completed scenes; normal recovery resumed it and completed the job. Reload during generation restored current state.
- Generated audio played in the browser with advancing time and no media errors. Ordered Hindi scene filenames and the title-based Hindi ZIP filename were verified through actual browser downloads; all five ZIP entries contained valid WAV data.
- Single-voice generation was cancelled from the UI, remained cancelled after reload, then completed on a new attempt with playable audio and the correct Hindi WAV download name.
- Manual single-scene regeneration created a new job and audio version while the previous recording remained playable. Retrying a completed job was correctly rejected with 400; terminal FAILED/PARTIAL retry scenarios remain covered by regression tests rather than an injected live-provider failure.
- A 2,033-character single-voice script crossed the chunk boundary and produced a merged 77.1-second WAV. Browser playback, seeking past 70 seconds and Hindi download naming passed. Scene, single, combined and long outputs were non-silent mono 24 kHz 16-bit PCM WAVs.
- Actual generated objects were copied at identical logical keys through the real Supabase adapter, with byte-exact reads. Only test-account database locations were switched to those cloud copies; global STORAGE_PROVIDER was not changed. Authenticated range reads, browser playback/ZIP downloads, single-voice cloud reads and combined WAV exports passed. An earlier unique synthetic storage probe also passed upload/read/range/metadata/delete; unauthenticated export access returned 401.
- Phone widths 360/393, tablet 768 and desktop 1440 were checked without horizontal overflow. No browser runtime errors were observed. Test wallet reservations settled to zero. Global pricing and real user balances were not changed; nonzero pricing/concurrency/refund scenarios are covered by isolated regression tests.

No live payment was attempted: Razorpay test key ID, secret and webhook secret remain unconfigured and checkout stays disabled. Configure the merchant test environment and a reachable signed webhook before validating payment capture/callback/webhook delivery end to end. No card/bank details or credentials belong in chat.

Cleanup also exposed a real generated-story deletion failure: composite scene/job foreign keys caused DELETE /audio-stories/:id to return 500. The service now deletes owned generation jobs/items inside the story-lock transaction before deleting the story. Active jobs still block deletion; the independent credits ledger is retained. The real test-story delete returned 200 after the fix; 81 isolated audio/analysis/storage regression tests passed, including completed deletion, ledger retention and active-job protection.

Verification data is synthetic. Its generated local/cloud objects, owned database rows and auth sessions are removed only after checking jobs are terminal and reservations are released. Global table/bucket cleanup is never used. Deleting a normal story still does not imply automatic object-storage garbage collection; see the storage guide.

### Nonzero credit utilization verification — 2026-10-25

A disposable database and separate API on a temporary local port were used, so live pricing and real users' balances were unchanged. The isolated API reused the configured Gemini key for real requests. Test rates were analysis 10 credits, audio 1,000 credits per 1,000 Unicode characters, and welcome 25; these are verification values, not a recommended production price.

A Super Admin granted the test user 100 credits through the real guarded adjustment API. Repeating the same request ID did not grant twice. A separate verified account received welcome credits once under concurrent wallet requests. Actual analysis reserved/charged 10 (balance 90); the cached repeat was free. A real 12-character single-voice generation reserved/charged 12 (balance 78). Regeneration reserved another 12, then Google quota/rate limiting caused a terminal failure: all 12 were released and the balance returned to 78. Cancellation and repeated cancellation likewise left 78 with no reserved balance.

Reducing only the fixture wallet to 5 made a 12-credit generation return 402/INSUFFICIENT_CREDITS without creating paid work. After restoring the fixture balance, a controlled provider-disabled failure and its failed-scene retry each received separate reservations and full refunds. The provider-disabled setting affected only the disposable database; no global live feature flag was changed. The final wallet balance (78) matched completed grants/charges in the ledger exactly; released entries did not count as extra credits or charges. This test observed successful paid audio plus a real failed regeneration, rather than claiming another successful provider generation after its quota was exhausted.

The web UI was connected to this real isolated API for wallet/refund-history checks and a 12-credit confirmation. Dismissing confirmation must issue no generation request. The test API, temporary uploads, synthetic accounts/sessions and disposable database are removed after verification. Razorpay settlement remains a separate pending merchant test.

## Grouped Configuration storage and diagnostics

Migration `20261026060000_configuration_groups` renames `AppSetting` to
`Configuration`, converts text to native JSONB and folds rows into groups. It
preserves saved values/timestamps and never decrypts or moves ProviderCredential.
Stop old API processes before migration, back up configuration/database, run the
existing migrate-deploy and generate commands above, then start the new API.
Do not run an old API binary against the renamed table. On another development
machine, pull migration/code and run these commands before starting the backend.

| Configuration key  | Contents                                                                           |
| ------------------ | ---------------------------------------------------------------------------------- |
| `app_strings`      | Locale objects (`en`, `hi`), shared naming for future web/mobile/desktop consumers |
| `app_settings`     | Public app configuration overrides                                                 |
| `backend_settings` | `features` and `processing` objects                                                |
| `gemini_settings`  | `analysisModel`, provider `enabled`, `credentialMode`                              |
| `openai_settings`  | `outlineModel`, provider `enabled`, `credentialMode`                               |
| `credits_settings` | Analysis/audio/welcome rates                                                       |

Resend sender/key and Razorpay activation remain environment-backed; they are not
silently migrated into unused database rows. Their safe effective/configured
status appears in diagnostics. Audio model selection retains the existing voice/
generation flow; no new audio model override is introduced here. Missing keys
retain existing environment/code defaults. Settings HTTP section names and public
`/app-config` fields remain compatible. Central mappings and the shared read/write
helpers are in `src/settings/configuration-store.ts`. All grouped writers use the
same transaction lock, so languages and provider/backend sibling fields survive
concurrent updates. Credentials remain encrypted in their existing table.

Super Admin → Global Settings offers **Export configuration** and **View debug
snapshot**. Export `GET /admin/config/export` returns schemaVersion 1, exportedAt,
`allConfig` (saved JSON overrides), credit packs and safe provider/payment status.
New stored groups are included automatically. Debug `GET /admin/config/debug` adds
`effectiveConfig` backend values with database/environment/default sources.
Client defaults remain owned by each client; read web `allSettings`/`allStrings`
for effective client values. Neither route is public or available to ordinary
admins. Responses use private/no-store. No automatic logging or browser storage
is introduced. Keys, encryption material, tokens and credential-like arbitrary
JSON fields are excluded/redacted. Treat user-authored configuration text as
private diagnostic data; never paste secrets into public app settings.

This export is **not** a database/credential backup and has no import endpoint.
Credit packs are exported with stable IDs, INR amounts in paise and active status;
users, balances, ledger, purchases and generated files are not exported. Resend
configuration editing, import/restore preview and configuration-change audit are
planned, not implemented by this refactor. Existing role audit is unchanged.
New fields/groups do not require schema migrations, but runtime consumers and
validated admin editing still require code. Do not add a second value store.

Verification for this migration/refactor: populated legacy migration fixture and
configuration/provider/export integration regressions passed on a disposable
local `_test` PostgreSQL database; audio/analysis (81 tests), credits (17 tests),
settings/runtime clients (26 tests), migration preservation (1 test), backend
TypeScript and build passed. Development migration was applied after a private
configuration backup; all seven legacy rows matched their five resulting groups.
The running public app-config contract and unauthenticated diagnostic rejection
were read-checked. Admin download/debug/error states were browser-checked with
mock API responses at 360, 393, 768 and 1440px in light/dark modes. No live provider
request or payment was used. Admin TypeScript and isolated production build passed.

## Critical audit after recovery fixes (2026-10-27)

Implemented without schema changes:

- Single narration claims the same pending attempt it observed, preventing an
  old reader from taking a replacement generation/credit reservation.
- Multi-scene recovery re-reads processing items after locking/claiming the job
  row, so a completed scene is not overwritten by stale scan data.
- Analysis cleanup matches the observed status/lease/timestamp rather than
  invalidating a newly leased worker.
- Pre-attempt model lookup failure fails the unchanged pending job and releases
  its credit hold atomically; it cannot overwrite another worker.

Verification used a newly created, migrated local disposable `_test` database.
All 86 tests in vitest.audio-flow.config.ts and 17 tests in
vitest.credits.config.ts passed, including the five new PostgreSQL regression
cases. Type checking and formatting passed. Provider/storage/payment calls were
stubbed; no real generation, payments, application records or wallet changes
were used. The temporary test database was removed after verification.

### Remaining high-priority findings — identified, not fixed

1. **Private local storage has a public static bypass.** `src/main.ts` mounts
   the entire uploads directory at /uploads without authentication. Someone
   possessing a private file's path can bypass the owned audio stream APIs.
   The same static mount returned a synthetic file with HTTP 200 and no token
   in an isolated Nest app; actual uploads were not read. This is already noted
   in [storage](storage.md#playback-and-exports), but remains unresolved.
   Restrict private audio to owned authenticated endpoints while preserving any
   intentionally public voice-preview assets. Production exposure/bucket policy
   was not tested.
### Follow-up fix: stale worker credit refund (2026-10-27)

Implemented without schema/API changes: terminal item failure now locks the
AudioGenerationJob row and verifies its PROCESSING status and worker timestamp
inside the settlement transaction. Only a successfully failed current item can
release its reservation. This uses the same job-row lock as cancellation,
recovery and successful asset commits.

A permanent PostgreSQL regression test replaces ownership after the optimistic
worker check but before the failure transaction. It verifies the replacement item
stays PROCESSING, its credit reservation stays RESERVED, and its later successful
audio settles the reservation as COMPLETED. This supersedes the earlier temporary
audit reproduction of a refunded replacement hold.

Follow-up verification: all 87 audio/analysis tests and 17 credits/payment tests
passed against a newly created local disposable database with existing migrations.
Type checking, changed TypeScript formatting and diff whitespace checks passed.
Provider/storage/payment calls were stubbed; the disposable database was removed
after verification. No production data or live provider calls were used.

No additional confirmed payment-signature, duplicate-credit
or cross-owner authenticated audio-access issue was found in the inspected paths
and existing isolated tests. This is a targeted audit, not a claim of complete
production security or provider reliability.
