# API overview

Start with this route map, then read the controller/DTO for exact validation and payloads. Swagger UI is configured at `/swagger/json`; its presence does not replace ownership/security tests.

## Shared conventions

- No global `/api` prefix is configured for the primary controllers. A legacy profile alias exists at `/api/getProfile`; use `/auth/profile` for current user-session restoration.
- Current IDs for users/stories/audio jobs are numbers; analysis job IDs and session IDs are UUID strings. Do not interchange analysis and generation job IDs.
- User endpoints use a user-audience bearer access token. Admin endpoints use an admin-audience token plus the appropriate current role. Cookie-based refresh/logout and browser origins are described in [admin-auth.md](admin-auth.md).
- Global ValidationPipe strips/validates DTO properties and rejects non-whitelisted properties. Use existing DTOs rather than assuming UI types validate incoming requests.
- Owner-scoped services reject inaccessible resources; do not implement ownership only in the frontend.
- File endpoints return binary audio/archive streams, not JSON URLs. API clients must request blobs/streams as appropriate.

## Authentication and roles

See [admin-auth.md](admin-auth.md) for the complete route table, body/cookie contracts, superadmin role management and first-account command. Registration creates normal users. Superadmin is a backend permission, not a separate login implementation.

Password recovery uses `POST /auth/forgot-password` with `{ email }` and `POST /auth/reset-password` with `{ token, password }`. Both are public, user-origin protected, independently rate-limited and return no-store responses. Reset links expire in 30 minutes, are single-use and revoke all prior sessions when consumed. Invalid/expired/reused links return 400 with `RESET_TOKEN_INVALID`; limits return 429 with Retry-After. See [password recovery](admin-auth.md#password-recovery) for eligibility, email configuration and migration/test requirements.

`GET /ai/test` is an allowlisted diagnostic, not a free health check. It uses the enabled Gemini primary from admin Providers & Models, retaining provider-enable and shared usage checks. Missing Gemini model configuration rejects the test before a provider request; it does not fall through to a separate environment model. Provider calls in diagnostic regression tests are mocked.

## Admin dashboard reporting

`GET /admin/dashboard?days=7|30` requires an active admin-audience session and
current ADMIN/SUPERADMIN role. The default is 30 days; other ranges return 400.
Responses use `Cache-Control: private, no-store`. Controller/service are in
`src/admin/`; existing admin guards and TokenService are reused.

The response contains `generatedAt`, UTC `range`, `totals`, `projectBreakdown`,
`audioJobs.statuses`, zero-filled `userGrowth`, `canViewUsers`, `recentUsers`, and
`recentFailedJobs`. Counts are read in one repeatable-read PostgreSQL transaction.

- Totals are all-time current records. Projects = Project + AudioStory +
  AnimationProject; an audio story represents one project, not each scene/job.
- Audio jobs are AudioGenerationJob records (multi-voice, including single-scene
  retries). Single-voice narration attempts and StoryAnalysisJob are excluded.
- Each retry job counts as a distinct job. All seven statuses are included in
  distribution; jobs with failures = FAILED + PARTIAL, not failed scene count.
- Growth is new User records per UTC calendar day, including today up to request
  time; it includes every account role, excludes pending registrations and
  zero-fills missing days. Counts do not represent historical deleted accounts.
- Recent users are the five newest accounts, selected safe fields only, returned
  exclusively to SUPERADMIN. Ordinary ADMIN receives an empty list and false
  `canViewUsers`. Recent FAILED/PARTIAL jobs expose only IDs, status, story title
  and `updated_at`; that timestamp is labelled last updated, not failure time.
- Errors propagate as errors; a database failure is not reported as zero usage.
  This endpoint is read-only and makes no AI/provider/storage calls.

Run `vitest run --config vitest.admin-dashboard.config.ts` with
`AUDIO_FLOW_TEST_DATABASE_URL` pointing at a disposable local database whose name
ends in `_test`. Without that variable database tests skip; application
DATABASE_URL is never the fallback. No schema migration is required.

## Story analysis and cast

Controller: `src/audio-stories/audio-stories.controller.ts`.

| Route                                               | Purpose                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| POST /audio-stories                                 | Create an owned story (`title`, `content`).                                           |
| GET /audio-stories                                  | List the user's stories.                                                              |
| GET /audio-stories/:id                              | Story details, analysis result/status and latest analysis job metadata.               |
| PATCH /audio-stories/:id                            | Edit title/content; changed content invalidates analysis and cancels active analysis. |
| DELETE /audio-stories/:id                           | Delete the owned database story; do not assume this garbage-collects remote files.    |
| POST /audio-stories/:id/analyze                     | HTTP 202: create/reuse an analysis attempt.                                           |
| GET /audio-stories/:id/analysis-jobs/latest         | Latest owned analysis job metadata.                                                   |
| GET /audio-stories/:id/analysis-jobs/:jobId/wait    | Wait for the owned attempt to finish; private/no-store, no polling.                   |
| POST /audio-stories/:id/analysis-jobs/:jobId/cancel | Cancel active analysis; fence late results.                                           |
| GET /audio-stories/:id/cast                         | Current character/voice assignments.                                                  |
| PATCH /audio-stories/:id/cast                       | Persist character voice assignments.                                                  |

Current create DTO caps title at 120 characters and content at 30,000. Title/content are required; UI defaults are not a promise that the API accepts missing fields. Read `src/audio-stories/dto/` and `src/ai/schemas/story-analysis.schema.ts` before changing analysis shape.

User story and analysis-job responses intentionally exclude provider routing metadata, including source/provider/model. That metadata remains persisted and is available only through the protected admin diagnostics routes.

## Multi-scene generation and files

Controller: `src/audio-generation/audio-generation.controller.ts`.

| Route                                                              | Purpose                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| POST /audio-generation/stories/:storyId/jobs                       | Create a generation job using current analyzed scenes/voices.                              |
| GET /audio-generation/stories/:storyId/jobs/latest                 | Restore the current/latest job after reload or tab navigation.                             |
| GET /audio-generation/jobs/:jobId                                  | Job counters and scene items, errors/retry times and audio metadata.                       |
| POST /audio-generation/jobs/:jobId/cancel                          | Cancel pending/processing/waiting work and retain completed audio.                         |
| POST /audio-generation/jobs/:jobId/retry                           | Create a **new** job for failed items of a FAILED/PARTIAL job.                             |
| POST /audio-generation/stories/:storyId/scenes/:sceneId/regenerate | Create a single-scene generation job; same action also serves a first generation.          |
| GET /audio-generation/stories/:storyId/audio-history               | Full current scene list, assigned voices, audio versions, last attempt and download names. |
| GET /audio-generation/audio/:audioId/stream                        | Authorized WAV streaming; byte ranges are supported.                                       |
| GET /audio-generation/stories/:storyId/download-zip                | ZIP of complete current scene audio.                                                       |
| POST /audio-generation/stories/:storyId/export-wav                 | Generate a persisted combined WAV asset.                                                   |
| GET /audio-generation/exports/:assetId/download                    | Download the owned combined export asset.                                                  |

A latest-job endpoint can send an empty body when no job exists. Browser consumers must normalize it to null and validate that job details contain an items array. The frontend decoder is `audio-generation-response.ts` in the web repo.

ZIP/combined export requires complete current audio. A past recording does not automatically count after script/voice/style changes. Partial retry jobs do not contain all story rows; use audio history as the row source. See [audio-flow.md](audio-flow.md) and [storage.md](storage.md).

## Single-voice narration

Controller: `src/audio-generation/single-voice.controller.ts`.

| Route                                                        | Purpose                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| POST /audio-generation/single/stories                        | Create narration project (`title`, `content`).                                                         |
| GET /audio-generation/single/stories/:storyId                | Saved draft, status, selected voice/style and current/previous asset metadata.                         |
| POST /audio-generation/single/stories/:storyId/generate      | Persist submitted draft/options and start narration (`voiceId`, optional `style`, `title`, `content`). |
| POST /audio-generation/single/stories/:storyId/cancel        | Stop remaining work and preserve previous completed narration.                                         |
| GET /audio-generation/single/stories/:storyId/audio/:audioId | Authorized saved narration stream.                                                                     |

Current script cap is 12,000 characters; supported speaking styles are validated by the service. A single-voice project uses its own status/attempt token, not a multi-scene job ID.

## Other current backend areas

| Area               | Routes / source                                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voices             | GET /voices lists saved voices. POST /voices syncs provider voices and additionally requires the explicit diagnostic allowlist.                                                                                        |
| Gemini diagnostics | GET /ai/test and GET /ai/models require user auth plus `AI_DIAGNOSTICS_USER_IDS`. A role alone does not bypass this check. Diagnostics can consume provider usage.                                                     |
| Generic projects   | POST/GET /projects; GET/PATCH/DELETE /projects/:id. Controller: `src/projects/projects.controller.ts`.                                                                                                                 |
| Animation          | Project CRUD under /animation/projects; scene CRUD under /animation/projects/:projectId/scenes. Source: `src/animation/animation.controller.ts`. Persistence endpoints do not imply a video-rendering pipeline exists. |
| Script outline     | POST /script/outline/generate accepts title/language and uses the configured OpenAI model. Source: `src/script/`.                                                                                                      |

The shared Gemini usage caps do not automatically cover unrelated OpenAI features. A product-page route is not evidence the corresponding backend feature or billing enforcement is implemented.

## Error interpretation

| Status | Typical meaning                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------- |
| 400    | Invalid DTO, unsupported option, incomplete analysis/voices, missing current audio or stale retry input. |
| 401    | Missing/expired/revoked session or wrong token audience/purpose.                                         |
| 403    | Insufficient role, disallowed Origin or diagnostic allowlist denial.                                     |
| 404    | Resource missing or inaccessible to the requesting owner.                                                |
| 409    | Conflicting active generation or a role change that would remove the last superadmin.                    |
| 429    | Login/admission usage limit; inspect Retry-After or returned retry metadata.                             |
| 5xx    | Server/configuration/provider/storage error; inspect safe job status and server context.                 |

Temporary provider errors can appear as WAITING job state instead of a failing submission HTTP response. Preserve that distinction in clients. Never retry creation blindly on every HTTP error: a job may already exist; restore state first.

## Read-only admin audio job monitoring

ADMIN and SUPERADMIN can read `GET /admin/audio-jobs` and
`GET /admin/audio-jobs/:id`. The existing admin session/current-role guards apply;
normal user tokens are rejected. Responses are private/no-store. There are no
admin retry/cancel endpoints: users retain those actions on their own APIs.

List filters: optional `search` (story title or exact job ID), `status`, `userId`,
`storyId`, UTC `from`/`to` dates (`YYYY-MM-DD`), `limit` (1–100, default 25), and
`cursor`. Jobs sort by descending ID; nextCursor fetches older jobs. Dates filter
job creation time and include the entire `to` date. This list covers multi-voice
AudioGenerationJob records, including retry jobs; single-voice/analysis jobs are
not included. Owner IDs are shown without account emails or authentication data.

Details return job metadata and a paginated scene-item list (ascending item ID,
limit/cursor). Attempts, status, assigned voice ID snapshot, retry time and
sanitized errors support diagnosis. Scene text, storage keys, provider settings
and user credentials are not returned. There are no admin audio download or
playback endpoints in this change. UI refresh is manual; no extra polling loop.

Admin UI routes are `/audio-jobs` and `/audio-jobs/[jobId]`. Filters apply on form
submission; loaded-record count is not a total-match count. Long tables scroll
inside cards on phones. Loading, empty, request-error and missing-job states use
the existing theme, strings/config, UI primitives and authenticated API client.

Verification: API tests use `vitest.admin-audio-jobs.config.ts` and require an
explicit local `_test` AUDIO_FLOW_TEST_DATABASE_URL (no application DB fallback).
Frontend response checks run with `node --test tests/audio-jobs-response.test.cjs`.
No database migration or generation/provider calls are needed for this section.

## Analysis model setting (Super Admin)

`GET /admin/settings/analysis-model` returns `{ model, source }`, where source is `database`, `environment` or `default`. `PATCH` accepts `{ "model": "exact-gemini-model-id" }`; `{ "model": null }` deletes the override and restores the backend fallback. Before a new analysis routing configuration is saved, this legacy endpoint controls the Gemini default. After first routing save, PATCH returns 400 directing callers to the routing endpoint; GET remains a legacy value, not the effective routed provider. Both require an admin-realm session and the current SUPERADMIN database role. Writes enforce the existing admin-origin guard. Responses are private/no-store. Unknown fields and invalid model IDs are rejected.

Saving only validates a model ID's format (lowercase letters, digits, dots, underscores and hyphens, up to 120 characters). It does not call Google, list available models or guarantee access. This model endpoint does not manage credentials or select a different provider; provider credentials are read only from backend environment configuration.

## Runtime admin controls

All `/admin/config/*` routes require an admin-realm session, current SUPERADMIN role and the existing origin guard for writes. Responses are private/no-store. Admin clients use their existing auth/refresh flow; user sessions cannot access these routes.

| Route                                                       | Purpose                                                                                                                                                                                            |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /admin/config/:section?locale=en                        | Read saved overrides (web) or effective values/defaults (private backend sections).                                                                                                                |
| PATCH /admin/config/:section                                | `{ values: { allowedKey: valueOrNull }, locale?: "en"                                                                                                                                              | "hi" }`; null removes an override.                                                      |
| PUT /admin/config/web-strings or /admin/config/web-settings | `{ values: { ...JSON }, locale?: "en"                                                                                                                                                              | "hi" }`; replaces the whole web override document, omitted keys restore local fallback. |
| GET /app-config?locale=en                                   | Public startup response `{ appSettings, appStrings, locale, features }`; private backend settings and provider credentials are never included. Omit locale to use the configured default language. |

Allowed config sections: `web-settings`, `web-strings`, `features`, `models`, `processing`, `security`, `storage`, `pricing`. Private backend sections reject unknown fields, wrong types and invalid ranges. Web documents accept arbitrary keys: App Strings requires text values; App Settings supports nested JSON objects/arrays, booleans, numbers, null and text. Existing home-setting types and en/hi language values are validated. Unsafe object keys are rejected or stripped by request transformation; documents are limited to 64 KB and 20 nesting levels. No generated catalog or cross-repository sync is required. Web JSON is public, so credentials belong only in backend environment configuration. Dashboard values override local values; nested objects merge, arrays replace, and false/0/empty text remain overrides. HTML/placeholders are stored as text and are not automatically executed/expanded. Missing keys/translations fall back to local defaults. Important settings controls edit the same JSON keys; no separate store exists. Whole-document publishes use last-publish-wins; private sections do not accept PUT.

The private `storage` section contains boolean `cleanupEnabled` (default true). GET/PATCH `/admin/config/storage` reuse current Super Admin/session/origin guards and private/no-store responses. Saved values are stored as typed JSON under `backend_settings.storage`, never returned by public app-config. A null patch removes the override and restores legacy environment/default behavior. The cleanup worker checks before each file and polls configuration every 30 seconds; already-started deletion may finish. Settings failures do not allow deletion.

The private `security` section stores four numeric password-login limits: `adminLoginAccountLimit`, `adminLoginIpLimit`, `loginAccountLimit`, `loginIpLimit` (integers 1–1,000,000). Super Admin-only access is enforced by the existing runtime controller guards. They use `backend_settings.security`, with legacy environment/default fallback and null-to-reset behavior. Changes affect the next login attempt without clearing persistent counters. These settings are not credentials and are not encrypted; email/IP counter identifiers remain hashed. See [login limits](admin-auth.md#password-login-rate-limits).

Pricing drives wallet reservations and settlement; see Wallet and payments below. Analysis provider/model selection and fallback use the separate routing endpoint below. Gemini audio and OpenAI outlines retain their existing configuration. Each provider has one selected key; analysis, outlines and audio have no automatic key rotation. TTS rate limits may schedule a job retry with the same key. The legacy analysis-model endpoint remains writable only until routing configuration is saved.

The /app-config endpoint replaces /public/config; update web/API deployments together. The backend does not load provider credentials or private section values into this response. The browser fetches once per load and uses local defaults on failure. No frontend client secret is required for public data. Admin reads/writes retain independent admin-session/current-role/origin checks.

## Wallet and payments

Authenticated user routes: GET `/credits/wallet`, GET `/credits/history?cursor=...`, POST `/credits/quote` (kind ANALYSIS/AUDIO/SINGLE_AUDIO, storyId and optional sceneId/jobId/content). Wallet includes available/reserved balance, recent ledger, recent purchases, active packs and current pricing. Quotes are estimates; submission uses current server rates. Insufficient balance returns 402; payment-review block returns 403. Quotes and generation enforce story ownership; history cursors cannot read another wallet.

GET `/credits/payments/config` returns enabled/mode only. POST `/credits/payments/orders` takes packId/requestId UUIDs, POST `/credits/payments/:purchaseId/verify` takes paymentId/signature, and POST `/credits/payments/:purchaseId/refresh` reconciles a lost callback. POST `/credits/payments/webhook` uses raw-body HMAC rather than browser authentication. Browser routes retain existing user auth/origin checks.

Super Admin only: GET `/admin/credits/users?search=...`, GET `/admin/credits/users/:id`, POST `/admin/credits/users/:id/adjust` (signed integer amount, required reason, UUID requestId, optional unblock), GET/POST `/admin/credits/packs`, PATCH `/admin/credits/packs/:id`. Ordinary admins cannot change credits or packs. Deactivate packs rather than deleting payment history. The ledger records actor, reason, idempotency reference and settlement state; story deletion retains accounting history.

### Configuration export and debug (Super Admin only)

`GET /admin/config/export` downloads versioned grouped saved overrides plus credit
pack definitions and safe credential/payment availability. `GET /admin/config/debug`
adds effective backend values and their sources. Both reuse origin/admin/superadmin
guards and private/no-store headers; ordinary admins/users cannot access them.
No credentials or environment dump is returned.
There is no import route. [configuration-store.ts](../src/settings/configuration-store.ts) defines the section/group mapping; see [developer setup](../README.md) for migration and test commands. Existing section URLs,
analysis-model configuration and public app-config payloads remain available; provider keys are managed only through backend environment configuration.

## Admin analysis monitoring

- `GET /admin/analysis-jobs`: read-only ADMIN/SUPERADMIN list using the existing
  admin-realm authentication and current-role guards. Query: `limit` (1–100,
  default 25), UUID `cursor`, `search` (max 120), analysis `status`, positive
  `userId`/`storyId`, and inclusive UTC `from`/`to` dates (`YYYY-MM-DD`).
  Search matches job UUID/story title or numeric user/story IDs. Results are
  `{ jobs, nextCursor }`, ordered by createdAt then UUID descending. An unknown
  cursor returns 400; refresh the list. Script/result payloads are omitted here.
- `GET /admin/analysis-jobs/:id`: UUID job detail with `job` metadata, submitted
  `contentSnapshot`/`contentHash`, and `currentStoryAnalysis` containing status,
  analyzedAt, contentMatchesJob and the current story result (possibly null).
  Unknown jobs return 404. Invalid IDs/filters return 400. No mutation route is
  added. Both responses use `Cache-Control: private, no-store`.

List/detail job metadata includes nullable `successfulProvider`/`successfulModel`.
Detail adds `job.resultSnapshot` (this job's validated successful result or null)
and `attemptHistory: { attempts, nextCursor }` with the first 25 request records.
`currentStoryAnalysis` remains explicitly current story data, not the selected
job's historical result. Older jobs have null historical/model fields; no guessed
backfill is performed. Latest job errors may clear on retry/success while attempt
errors remain available.

`GET /admin/analysis-jobs/:id/attempts?limit=25&cursor=<attempt-uuid>` uses the same
ADMIN/SUPERADMIN guards and private/no-store headers. Limit is 1–100. Records are
ordered by unique per-job sequence; a cursor must belong to that job (400 if not).
Unknown jobs return 404. Rows expose id, sequence, provider/model, kind, status,
startedAt, responseAt, finishedAt, durationMs, errorCategory, providerHttpStatus,
providerErrorCode and redacted errorMessage. This endpoint contains no script,
failed response body, credential or worker-lease fields. It has no mutations.

Deploy `20261027120000_analysis_attempt_history` and regenerate Prisma before
running the updated backend. Existing user job DTOs and billing/routing contracts
are unchanged. Local parsing/cache hits are not model request successes; cancelled,
interrupted and running calls must not enter completed-model-attempt denominators.
See [attempt semantics](audio-flow.md#admin-analysis-inspection) before reporting
latency, availability or success percentages.

## Analysis routing settings (Super Admin)

`GET /admin/settings/analysis` returns the effective configuration;
`PATCH /admin/settings/analysis` accepts `{ "configuration": { ... } }` with:

- `primaryProvider`: `gemini` or `openai`.
- `providerFallback`: boolean. When false, only the selected provider is used.
- `retryLimit`: integer 0–10, additional delayed retries of the original primary.
- `retryDelaySeconds`: integer 1–120; applies only after the initial candidate list.
- `providers.gemini` and `providers.openai`: each `{ primaryModel, models }`.
  `models` is an ordered list of at most 20 `{ id, enabled }` entries. IDs are
  unique within a provider and follow the existing 120-character model-ID format.
  `primaryModel` must name an enabled entry. An unused provider may have null
  primary and an empty/disabled-only list; the selected provider must be usable.
  Enabling fallback requires usable primaries for both providers.

Existing admin-realm/current SUPERADMIN role/origin guards apply. Responses are
private/no-store; unknown fields, unusable primaries and invalid limits return
400. The shared configuration writer persists the non-secret `analysis_settings`
JSON document without a new table/migration. It is excluded from public app-config
and included in authenticated configuration export/debug. No credentials are
accepted here; use existing provider-key controls. Saving does not contact either
provider or guarantee a model supports the required structured output.

Remove models by omitting them from the next saved list, or disable them by
setting enabled=false. Primary replacement is validated before either action.
Empty backups are valid. A running job retains its captured model configuration;
provider feature flags/credential access checks remain authoritative per call.
History is not deleted when configuration entries are removed. See
[audio flow](audio-flow.md#analysis-jobs) for busy/429 routing and cancellation.

## Analysis performance monitoring

`GET /admin/analysis-performance` is read-only ADMIN/SUPERADMIN, using the existing
admin-realm/current-role guards and private/no-store responses. Query fields:
`days` (1, 7, 30, 90; default 7), optional exact `provider` (gemini/openai), optional
exact `model` (existing model-ID format), `page` (1–10000), `limit` (1–100; default
25), and optional ISO `asOf` no later than now. Unknown/invalid fields return 400.

The cohort starts at UTC midnight days-1 days before the cutoff, and ends at
asOf/current time, filtered by request startedAt. asOf pins the start-time cohort
for model-page continuation; it is not historical reconstruction of past request
statuses. Every response uses a repeatable-read transaction for consistent
aggregate/model/recent-job reads. Requests already in that cohort can finish
between pages; Refresh starts a new report cohort.

Response: from/to, selected filters, totals, paginated models, page/nextPage and
latest 10 recentJobs with recorded matching requests. Aggregation is performed in
PostgreSQL over the full filtered cohort, not only the displayed model page.
Models are ordered by provider/model, not ranked by quality. Exact model filters
can inspect historical models removed from configuration. Recent jobs may have
succeeded on a different model after a matching failed attempt; open job details.
No prompts, snapshots, failed response bodies or keys are included here.

Completed attempts = COMPLETED + FAILED, excluding FAILED/COMMIT_FAILED. Rates
use that denominator and are null when it is empty. Busy/server errors use FAILED
with errorCategory BUSY; rate/quota errors use HTTP 429 separately. Running,
cancelled, interrupted and local commit failures are returned as excluded counts.
Average/median timing uses successful rows with recorded duration only; global
median is computed from raw successes, not from model medians. latencySamples
reports the number of measured successes. Success is validated/committed output,
not semantic accuracy, and fallback samples are not controlled benchmarks.

No new schema/migration, job dispatch, configuration writes or billing changes
are introduced. The existing analysis-attempt-history migration must already be
applied. This API does not execute any AI/provider request.
