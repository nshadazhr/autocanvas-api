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

| Group | Variables / source |
| --- | --- |
| DB and auth | DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET; `prisma7.config.ts`, `src/auth/`. |
| Server | PORT, NODE_ENV; `src/main.ts`. |
| Origins and login limits | REQUEST_ORIGIN_PORT, ADMIN_ORIGIN, additional application origins and limit names documented in [admin-auth.md](admin-auth.md). |
| Email / Google | RESEND_API_KEY, optional RESEND_FROM_EMAIL; GOOGLE_CLIENT_ID. |
| AI | GEMINI_API_KEY, optional GEMINI_MODEL, GEMINI_MULTI_KEY_ENABLED, GEMINI_API_KEYS, GEMINI_RPM_LIMIT, GEMINI_RPD_LIMIT; OPENAI_API_KEY and optional OPENAI_MODEL for script outlines. |
| Shared provider/admission caps | AI_* and ANALYSIS_* names/defaults in [audio-flow.md](audio-flow.md). |
| Audio recovery | AUDIO_MAX_RECOVERY_ATTEMPTS, AUDIO_RECOVERY_RETRY_DELAY_MS, AUDIO_RETRY_SCAN_INTERVAL_MS. |
| Storage | STORAGE_PROVIDER; Supabase URL/service-role key/bucket when selected. See [storage.md](storage.md). |
| Diagnostics | AI_DIAGNOSTICS_USER_IDS; no implicit role bypass. |

The environment example is not a complete runnable configuration. Never commit a real `.env`, provider key, signing secret, refresh cookie or connection credential. NEXT_PUBLIC frontend variables must not contain backend secrets. Current application startup constructs AI/email clients even if a particular request does not use them.

## Operating boundaries

- At least one healthy Nest process must remain available for the in-process scanners/workers. Analysis/audio job state is persisted in PostgreSQL; there is no requirement to install a Redis/BullMQ stack for the implemented pipeline.
- Do not manually toggle active job/item states to force progress. Inspect retry time, worker lease/heartbeat, safe errors and provider/application quotas first.
- Shared provider limits are conservative request/character caps, not exact billing/credit accounting. Frontend plan/credit display still includes demo data.
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

| Symptom | First checks |
| --- | --- |
| Boot/table/column error | Correct DATABASE_URL, migration status and generated client; do not immediately reset data. |
| 401 after logout/role change/upgrade | Intentional session revocation or legacy tokens; sign in through the correct application flow. |
| 403 admin request | Current DB role, token audience and admin Origin; role alone does not bypass diagnostic allowlists. |
| 429 login | Retry-After and fixed-window account/IP caps; check proxy IP handling if many people share a peer. |
| Provider job WAITING | Next retry time, shared usage buckets, per-key cooldown/rate and network/provider status. |
| Failed attempt but old audio plays | Expected: old files are preserved; inspect the latest item error/current revision. |
| Audio file missing/export fails | Persisted provider/key, original bucket/root, current revision and metadata/file existence. |
| Correct job but UI blank/crashes | Verify latest-job response shape, no-job empty response handling and full history; do not infer all scenes from a retry job. |
| Duplicate UI requests | Polling is expected. Check mutation idempotency/refs and backend conflicts before blaming a repeated status GET. |

Log safe resource IDs, status/error codes and timestamps. Redact tokens/credentials and avoid logging full scripts/provider responses or user password records. Historical handoffs are reference material; code and these current docs are the implementation contract.
