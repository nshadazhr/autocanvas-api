# Audio Studio: data and job flow

## Main flow

1. Create a story or single narration project.
2. For multi-voice: analyze script → validate characters/scenes → assign and save supported voices.
3. Create a generation job; the API returns before provider work finishes.
4. Backend worker/scanner updates persisted state. UI polls the API and restores state after reload.
5. Successful audio is saved through StorageService and referenced by the database.
6. Play/download individual audio, or export complete current scene audio as ZIP/combined WAV.

Single narration and multi-scene generation are different project modes. Story analysis is also a separate job; analysis completion does not mean audio generation has started.

## File map

| File                                                             | Owns                                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/audio-stories/audio-stories.service.ts`                     | Analysis admission/cache, leases/retries, cancellation and syncing validated scenes/characters. |
| `src/audio-stories/services/story-parser.service.ts`             | Local structured-script parser.                                                                 |
| `src/audio-stories/services/story-analysis-validator.service.ts` | Cross-scene/character consistency checks.                                                       |
| `src/ai/analysis/`, `src/ai/ai.service.ts`, `src/ai/prompts/story-analysis.txt`      | Analysis routing/error mapping/adapters; shared JSON schema/prompt and safe response parsing.                 |
| `src/audio-generation/audio-generation.service.ts`               | Multi-scene jobs, item claims/recovery, audio commit/history, retry/cancel and exports.         |
| `src/audio-generation/single-voice.service.ts`                   | Narration drafts, segments, attempts, cancellation and completed assets.                        |
| `src/audio-generation/utils/audio-story-lock.ts`                 | Shared per-story transaction lock/conflicting-job guard.                                        |
| `src/audio-generation/utils/scene-audio-revision.ts`             | Determines whether saved audio matches current scene/voice/settings.                            |
| `src/audio-generation/providers/`                                | Single-key TTS requests and prompt/error helpers.                                               |
| `src/ai/usage/`                                                  | Shared persisted request/character/concurrency accounting.                                      |
| `src/storage/`                                                   | Reads/writes through the configured provider; see [storage.md](storage.md).                     |

## Analysis jobs

`StoryAnalysisJob` records the snapshot/hash, status and attempts. Submission returns HTTP 202 with safe job metadata. Valid structured scripts use the local parser; otherwise the configured Gemini/OpenAI analysis adapter is called. Provider/model order, primary retry limits and delay are captured from `Configuration.analysis_settings` at job start. Until first save, the legacy Gemini selection (`gemini_settings.analysisModel`, then GEMINI_MODEL, then gemini-3.5-flash) remains primary, with two delayed retries at five seconds. Running jobs keep their captured routing configuration; completed cached results are not invalidated by changing the model. Both paths require schema/consistency validation before saving scenes and characters atomically.

- The frontend makes one authenticated `GET /audio-stories/:id/analysis-jobs/:jobId/wait` request, then fetches the story when work ends. There is no analysis polling interval, periodic scanner, heartbeat or countdown.
- Busy-server responses (500/502/503/504) advance immediately through the selected provider's enabled models (primary first), then the other provider's models only if provider fallback is enabled. Once candidates are exhausted, only the original primary provider/model receives delayed retries, bounded by retryLimit. There is no repeated full-list cycle or unlimited retry. Gemini/OpenAI SDK retries are disabled for analysis so this job policy owns attempt counts.
- HTTP 429 skips remaining models of that provider because quota/rate limits may be shared. Explicit exhausted quota is distinguished from generic rate limiting; provider switching may continue, but a rate/quota-blocked primary receives no delayed retries. Invalid credentials/access/request, malformed output, local failures and network errors stop. A completed or failed job settles its single reservation once; switching models/providers does not create another paid job.
- Network/timeouts, authorization, malformed responses and validation errors stop immediately. Provider rate/quota handling follows the routing rule above. Provider requests retain their 90-second timeout. Analysis bypasses custom application request/day/character budgets and AI concurrency leases; custom per-user active-job and global analysis worker-count caps are also removed. Authentication, ownership, duplicate-job locks, input-size/schema validation and cancellation fencing remain. Former AI_SUBMISSIONS_* and ANALYSIS_USER_ACTIVE_JOBS / ANALYSIS_GLOBAL_WORKERS settings are not used. Credits settlement is described below.
- Duplicate submissions reuse active work; valid unchanged completed results are cached. Cancellation/content changes fence late responses and prevent subsequent retries. Cancel does not abort an already-sent provider call or guarantee its cost is refunded.
- Wait requests attach to in-memory work on the API instance that started it. Use a single API instance or sticky routing; this is not a distributed durable queue. A busy provider can keep the wait request open indefinitely; configure deployment proxy timeouts accordingly. If the connection closes, the UI reports a connection error and reload reconnects to active work. A browser disconnect does not itself cancel analysis.
- Jobs are not automatically resumed after restart. Startup marks stale queued/waiting or expired processing records FAILED. A wait request also fails an interrupted job when no worker owns it; an unexpired lease on another instance is not overwritten. There is no periodic restart recovery; reload after lease expiry can identify interruption and allow manual retry.
- A model/settings lookup failure before an attempt is claimed marks only the unchanged queued/waiting version FAILED with ANALYSIS_SETUP_FAILED and releases its credit reservation. A newly claimed worker is preserved.
- Interrupted-job cleanup compares the observed status, lease and updatedAt atomically; a newer lease cannot be failed using an older read.
- Failed errors are safe messages; logs include job IDs, status codes and attempts without scripts or credentials. The current upstream HTTP error status is persisted in nullable `providerHttpStatus` for admin monitoring; user job DTOs exclude it, as well as provider routing source/model metadata. Local failures without an upstream response leave it null. A claimed retry clears previous failure metadata, including this status. Lease tokens still fence stale commits; there is no lease-renewal timer.

## Multi-scene jobs

`AudioGenerationJob` owns `AudioGenerationJobItem` records. Items snapshot text/voice/settings so a running job does not silently switch to edited content. Job states include PENDING, PROCESSING, WAITING, COMPLETED, PARTIAL, FAILED and CANCELLED. Item states also include SKIPPED.

- Per-story locks prevent conflicting jobs. Pending jobs are persisted before background dispatch; scanners recover work after restart.
- Recovery locks/claims the stale job row before reading its currently processing items, preserving audio committed after the initial scan.
- Item ownership and worker timestamps fence stale workers and late responses. Heartbeats support interrupted-worker recovery.
- A retry of failed scenes creates a **new job** containing those failed scenes. It does not erase successful current audio or mean the history consists only of retry rows.
- Quota/application capacity errors move work to WAITING and use a future retry time. Recognized transient provider errors have bounded recovery attempts; defaults are three attempts and a 60-second initial recovery delay.
- Cancellation changes active items/job to CANCELLED, clears retry times and keeps committed audio. A scene whose audio commits just before cancellation remains completed. Already-sent provider requests may still cost usage; they cannot complete a cancelled job with a late result.
- Full regeneration is an explicit new operation. Repeated clicks are blocked by UI refs and backend conflict checks, not by hiding buttons alone.

Current scenes have positive sceneOrder. Re-analysis can retire replaced scene rows for historical references. Matching revision checks distinguish current audio from old recordings when text/voice/emotion/style changes. Do not mark a failed attempt completed merely because previous audio exists.

## Single narration

Statuses are stored on AudioStory: SINGLE_DRAFT, SINGLE_PENDING, SINGLE_PROCESSING, SINGLE_COMPLETED, SINGLE_FAILED and SINGLE_CANCELLED. The saved draft/options and a unique attempt token fence concurrent/late output. Pending claims compare the observed attempt token as well as status; a cancelled/replaced attempt cannot be stolen by an older pending reader.

Generation splits supported emotion segments, creates/merges WAV audio and persists a completed asset. Shared application-capacity waits retain generated chunks within the running process. Pending projects can be redispatched; stale processing is marked interrupted/failed rather than claiming durable recovery of every partial chunk. This differs from the persisted multi-scene item workflow.

Cancellation stops subsequent work and keeps previous completed narration. Failed regeneration similarly keeps the previous asset accessible. A fresh attempt can be started after cancellation/failure. Selected voice/style and content revision determine whether the previous asset is current.

## Usage controls: two layers

Shared PostgreSQL limits below apply to TTS and restricted diagnostics, across instances/restarts; analysis bypasses these application budgets and concurrency leases. They count admitted provider attempts, including failures, and input characters; they are not exact currency billing or the frontend's displayed credits.

| Setting                                                    | Default                  |
| ---------------------------------------------------------- | ------------------------ |
| ANALYSIS_MAX_CHARACTERS / ANALYSIS_MAX_SCENES              | 30,000 / 200             |
| AI_GLOBAL_CONCURRENCY / AI_USER_CONCURRENCY                | 3 / 1                    |
| AI_GLOBAL_REQUESTS_PER_MINUTE / AI_GLOBAL_REQUESTS_PER_DAY | 10 / 300                 |
| AI_USER_REQUESTS_PER_MINUTE / AI_USER_REQUESTS_PER_DAY     | 5 / 100                  |
| AI_GLOBAL_CHARACTERS_PER_DAY / AI_USER_CHARACTERS_PER_DAY  | 500,000 / 100,000        |
| AI_MAX_REQUEST_CHARACTERS                                  | 40,000 per provider call |
| AUDIO_MAX_RECOVERY_ATTEMPTS                                | 3                        |
| AUDIO_RECOVERY_RETRY_DELAY_MS                              | 60,000                   |
| AUDIO_RETRY_SCAN_INTERVAL_MS                               | 30,000                   |

The six request/character budgets above are managed in admin **Audio Configuration** (`/audio-settings`) and stored in `Configuration.backend_settings.processing`. Saved values take precedence over the listed legacy environment variables, then code defaults. Each new non-analysis admission reads the settings; existing usage buckets are preserved when limits change. Request budgets accept integers 1–1,000,000; daily character budgets accept 1–1,000,000,000. Recovery attempts/delay and `retryScanIntervalMs` also use this saved section. The scan interval defaults to 30,000 ms and accepts integers 1,000–1,000,000 ms. Saved changes apply after the next scan without restarting the API. The next timer starts after the current scan completes, preventing overlapping scanner ticks. A settings-read failure retains the last known interval (startup falls back to legacy environment/default), and shutdown prevents rescheduling. Concurrency, per-call size and analysis bounds remain environment-backed.

Shared time buckets use fixed UTC boundaries. These budgets count admitted attempts (including failed provider calls) and input characters, not tokens or wallet credits. Analysis still bypasses these budgets and concurrency leases. Provider calls have a 90-second timeout.

Gemini TTS, Gemini/OpenAI analysis and OpenAI outlines use each provider's single backend environment key (`GEMINI_API_KEY` / `OPENAI_API_KEY`). Analysis model/provider routing is independent of credentials: there is no automatic key rotation, key fallback pool or per-key RPM/RPD counter. GEMINI_API_KEYS, GEMINI_MULTI_KEY_ENABLED and the old GEMINI_RPM_LIMIT/GEMINI_RPD_LIMIT settings are ignored. Shared AI usage/security controls remain independent. A TTS 429 returns ProviderRateLimitError with the provider retry hint (or 60 seconds), allowing the existing multi-scene job scheduler to wait and retry the same key; the provider client does not try another key. Authentication/content errors are returned without key failover. Existing single-voice errors, cancellation, network recovery and downloads retain their flow. Updating environment keys requires restarting the backend; an in-flight SDK request keeps its captured key.

## Verification and maintenance

Use `vitest.audio-flow.config.ts` with a disposable local `_test` database. It covers creation/conflicts, recovery, retry, revisions, cancellation/late responses, playback/exports, history/voices and analysis/usage behavior. Provider/storage calls in these suites are stubs; passing them does not prove a live provider or remote bucket is configured correctly.

Before changing this flow, check no-job, first generation, waiting, partial failure, cancellation, reload and previous-audio scenarios. Reuse the existing locks/revision/adapter helpers. Do not couple file naming to guessed URLs or replace persisted retry state with browser-only state.

Runtime controls: new analysis/audio/outline submissions enforce their feature flag and maintenance setting. Provider-disabled or missing-credential configuration errors are terminal, not Google busy retries. Multi-scene recovery reads configured attempts/delay at processing start; shared request/character budgets are read at each non-analysis admission. Credentials do not change an already-sent request. See operations.md for environment-only credential setup and migration. Pricing values are not used for charging in this change.

## Credit settlement

A user-row database lock serializes balance mutations. Creation reserves funds in the same transaction as the job: one entry for analysis, one per audio item, or one for a single-voice attempt. Cost is fixed at reservation. Analysis costs the configured fixed rate; cached valid completed analysis is free. Audio charges ceil(trimmed Unicode code points × rate / 1000), separately per scene/output; hidden provider prompts are excluded. Single voice uses the submitted script including its text tags.

Saving a successful asset and completing its charge share a transaction. Terminal item failure locks the job row and validates the current worker before marking the item failed and releasing its reservation in the same transaction. An obsolete worker cannot refund a replacement worker’s hold. Cancellation releases unused reservations once, while busy/recovery waits retain them. Successful scenes stay charged when another scene fails or the job is cancelled. Provider retries reuse the reservation; manual failed-scene retry creates a new reservation after the failed one was refunded. Manual regeneration is a new paid operation. Legacy jobs already running before billing deployment are not retroactively charged. The client confirms nonzero estimates, but the server computes all costs and enforces balance. Credits do not replace provider quotas.

Invalid/expired Gemini API keys may arrive as HTTP 400 (API_KEY_INVALID), not just 401/403. Analysis reports these as PROVIDER_CONFIGURATION_ERROR; audio uses a safe configuration message, no key switching or automatic retry. Failed reservations are released. Fix the configured key rather than modifying the story or repeatedly submitting.

Deleting a completed multi-voice story removes its generation jobs/items before scenes inside the existing story-lock transaction, avoiding the composite scene/job FK constraint. An active job still rejects deletion. Credit accounting rows keep their story ID snapshot and remain in the ledger after story deletion. This database deletion does not introduce a background storage cleanup mechanism.

## Admin analysis inspection

The read-only admin monitor shows job status, safe latest errors, submitted
script/hash, and separate historical-job versus current-story result panels.
After migration `20261027120000_analysis_attempt_history`, successful jobs retain
`resultSnapshot`, `successfulProvider` and `successfulModel`. Re-analysis updates
the editor's latest story result but does not overwrite previous job snapshots.
Older jobs are not backfilled from the current story or guessed model settings.

`StoryAnalysisAttempt` records each request dispatch with order, requested API
provider/model ID, trigger (initial/model fallback/provider fallback/primary retry),
start/call-return/finish timestamps, duration and outcome. An optional dispatch
hook is awaited after prompt/credential/client preparation and immediately before
the SDK call. Tracking failure or lost ownership prevents an untracked new call.
Local-parser/cache/preflight failures do not create AI attempts. A crash between
dispatch recording and actual network send cannot prove delivery: the unfinished
record is later classified INTERRUPTED, not a completed model attempt.

Attempt outcomes are RUNNING, COMPLETED (validated result committed), FAILED,
CANCELLED or INTERRUPTED. Actual provider-call timing includes request/SDK parsing,
not queue/retry delay or subsequent result persistence. Cancel/interruption
finishes open rows at local cancellation/detection time; late call return may
populate responseAt, but cannot turn cancelled work into success. Exclude these
rows from completed-attempt latency/success calculations. COMMIT_FAILED identifies
local persistence failure separately from model/provider failure. COMPLETED is
not proof of semantic accuracy. Model IDs are the requested IDs, not an inferred
provider-internal model version. Terminal metadata is preserved across retries.

Failures keep HTTP status, a bounded provider error code and redacted error
message; no failed output payload, stack, keys or per-attempt script copy is stored.
There is no automatic retention purge; history follows normal job/story deletion
cascades. Charts/automatic accuracy evaluation remain planned. Pagination keeps
admin reads bounded; current story data is always labelled separately.
The focused fixture HTTP tests in `src/admin/admin-analysis-jobs.spec.ts` exercise
real auth/role guards with stubbed token verification and Prisma persistence;
they do not claim live PostgreSQL/session integration.

Run the focused fixture HTTP suite from the API repository:

```sh
npx vitest run --config vitest.admin-auth.config.ts src/admin/admin-analysis-jobs.spec.ts
```

This command was verified without a database connection. It checks role/realm
guards, query/UUID validation, cursor ordering, UTC date filters, safe errors,
missing jobs and current-result scope using fixture persistence.

Recovery regression coverage includes cancel/regenerate between the pending read
and claim, audio completion between recovery scan and row claim, analysis lease
replacement between stale read and cleanup, and model lookup failures including
a concurrently leased worker. Terminal-failure coverage also replaces worker ownership
between the optimistic check and settlement, verifies the hold stays reserved,
and verifies the replacement’s successful audio completes the charge. These use real disposable PostgreSQL with stubbed
providers/storage and assert credit reservations/settlement as well as status.
See the remaining critical audit findings in [operations](operations.md#critical-audit-after-recovery-fixes-2026-10-27).

## Analysis code ownership

- `ai/analysis/analysis-runner.service.ts`: per-job candidate order and bounded primary retries.
- `ai/analysis/analysis-errors.ts`: shared HTTP/code classification for providers.
- `ai/analysis/providers/`: Gemini adapter delegates to the existing Gemini schema/prompt path; OpenAI adapter reuses OpenAIProvider with the same Zod schema and prompt.
- `settings/analysis-settings.service.ts`: strict routing validation, legacy defaults and existing configuration-store persistence.
- `audio-stories/audio-stories.service.ts`: existing lease, cancel, revision/result validation and single reservation lifecycle. Delayed waits wake on local cancellation; lease/status checks fence late responses and further requests.

OpenAI uses [Responses Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
with strict JSON Schema, followed by the same local consistency validation as Gemini.
Model IDs are format-validated, not live-probed; choose models supporting the
required structured output. No live provider compatibility/accuracy claim is
implied by fixture tests. Per-attempt history and successful job snapshots are implemented; automatic
accuracy scoring remains future work; read-only model reliability/timing
statistics are implemented in the Analysis workspace Monitoring tab; audio/image configuration is
not migrated by this feature.

## Analysis workspace monitoring

Analysis has Configuration and Monitoring tabs in the admin workspace. The
monitoring API reads persisted attempt history only; it never triggers generation
or changes pricing/configuration. See
[performance API](api-overview.md#analysis-performance-monitoring) for denominator,
UTC cohort, latency and pagination semantics. Metrics cover currently recorded
analysis requests; audio/script/images/key-specific monitoring are not inferred
from this data. Original script/results/attempts remain available through linked
job details for manual quality review.

## Upload retention and orphan cleanup

New uploads receive durable StorageObject receipts before provider I/O. Scene audio, single-voice assets and combined exports validate/lock the receipt in their asset-save transaction; billing and job ownership checks retain their existing transactions. An expired/claimed upload fails safely rather than creating a broken reference. Hourly cleanup removes only unreferenced tracked audio/temp files after a 24-hour grace period, preserving saved history and active work. Failed/late provider operations retain retryable cleanup state. Existing/manual objects are untouched. Apply the storage-cleanup migration before deployment; see [storage cleanup](storage.md#automatic-cleanup-of-tracked-uploads).
