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
| `src/ai/ai.service.ts`, `src/ai/prompts/story-analysis.txt`      | Gemini analysis request, JSON schema/prompt and safe analysis response parsing.                 |
| `src/audio-generation/audio-generation.service.ts`               | Multi-scene jobs, item claims/recovery, audio commit/history, retry/cancel and exports.         |
| `src/audio-generation/single-voice.service.ts`                   | Narration drafts, segments, attempts, cancellation and completed assets.                        |
| `src/audio-generation/utils/audio-story-lock.ts`                 | Shared per-story transaction lock/conflicting-job guard.                                        |
| `src/audio-generation/utils/scene-audio-revision.ts`             | Determines whether saved audio matches current scene/voice/settings.                            |
| `src/audio-generation/providers/`                                | Single-key TTS requests and prompt/error helpers.                                              |
| `src/ai/usage/`                                                  | Shared persisted request/character/concurrency accounting.                                      |
| `src/storage/`                                                   | Reads/writes through the configured provider; see [storage.md](storage.md).                     |

## Analysis jobs

`StoryAnalysisJob` records the snapshot/hash, status and attempts. Submission returns HTTP 202 with safe job metadata. Valid structured scripts use the local parser; otherwise Gemini is called. The Gemini analysis model is resolved from the non-secret AppSetting record at job start, with GEMINI_MODEL then gemini-3.5-flash as fallbacks. Busy retries keep that starting model; completed cached results are not invalidated by changing the model. Both paths require schema/consistency validation before saving scenes and characters atomically.

- The frontend makes one authenticated `GET /audio-stories/:id/analysis-jobs/:jobId/wait` request, then fetches the story when work ends. There is no analysis polling interval, periodic scanner, heartbeat or countdown.
- Only busy-server responses (500/502/503/504) retry, with a one-second wait between calls and no attempt limit. One iterative loop continues until success, cancellation, or a different error. Actual provider quota errors stop work; analysis has no custom application request budgets.
- Network/timeouts, actual provider quota/rate limits, authorization, malformed responses and validation errors stop immediately. Provider requests retain their 90-second timeout. Analysis bypasses custom application request/day/character budgets and AI concurrency leases; custom per-user active-job and global analysis worker-count caps are also removed. Authentication, ownership, duplicate-job locks, input-size/schema validation and cancellation fencing remain. Former AI_SUBMISSIONS_* and ANALYSIS_USER_ACTIVE_JOBS / ANALYSIS_GLOBAL_WORKERS settings are not used. Credits settlement is described below.
- Duplicate submissions reuse active work; valid unchanged completed results are cached. Cancellation/content changes fence late responses and prevent subsequent retries. Cancel does not abort an already-sent provider call or guarantee its cost is refunded.
- Wait requests attach to in-memory work on the API instance that started it. Use a single API instance or sticky routing; this is not a distributed durable queue. A busy provider can keep the wait request open indefinitely; configure deployment proxy timeouts accordingly. If the connection closes, the UI reports a connection error and reload reconnects to active work. A browser disconnect does not itself cancel analysis.
- Jobs are not automatically resumed after restart. Startup marks stale queued/waiting or expired processing records FAILED. A wait request also fails an interrupted job when no worker owns it; an unexpired lease on another instance is not overwritten. There is no periodic restart recovery; reload after lease expiry can identify interruption and allow manual retry.
- Failed errors are safe messages; logs include job IDs, status codes and attempts without scripts or credentials. A claimed retry clears previous failure metadata. Lease tokens still fence stale commits; there is no lease-renewal timer.

## Multi-scene jobs

`AudioGenerationJob` owns `AudioGenerationJobItem` records. Items snapshot text/voice/settings so a running job does not silently switch to edited content. Job states include PENDING, PROCESSING, WAITING, COMPLETED, PARTIAL, FAILED and CANCELLED. Item states also include SKIPPED.

- Per-story locks prevent conflicting jobs. Pending jobs are persisted before background dispatch; scanners recover work after restart.
- Item ownership and worker timestamps fence stale workers and late responses. Heartbeats support interrupted-worker recovery.
- A retry of failed scenes creates a **new job** containing those failed scenes. It does not erase successful current audio or mean the history consists only of retry rows.
- Quota/application capacity errors move work to WAITING and use a future retry time. Recognized transient provider errors have bounded recovery attempts; defaults are three attempts and a 60-second initial recovery delay.
- Cancellation changes active items/job to CANCELLED, clears retry times and keeps committed audio. A scene whose audio commits just before cancellation remains completed. Already-sent provider requests may still cost usage; they cannot complete a cancelled job with a late result.
- Full regeneration is an explicit new operation. Repeated clicks are blocked by UI refs and backend conflict checks, not by hiding buttons alone.

Current scenes have positive sceneOrder. Re-analysis can retire replaced scene rows for historical references. Matching revision checks distinguish current audio from old recordings when text/voice/emotion/style changes. Do not mark a failed attempt completed merely because previous audio exists.

## Single narration

Statuses are stored on AudioStory: SINGLE_DRAFT, SINGLE_PENDING, SINGLE_PROCESSING, SINGLE_COMPLETED, SINGLE_FAILED and SINGLE_CANCELLED. The saved draft/options and a unique attempt token fence concurrent/late output.

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

Configured limits must be positive integers. Shared time buckets use fixed UTC boundaries. Provider calls have a 90-second timeout.

Gemini TTS, analysis and outlines each use the provider's single configured key. There is no key manager, rotation, fallback pool or per-key RPM/RPD counter. GEMINI_API_KEYS, GEMINI_MULTI_KEY_ENABLED and the old GEMINI_RPM_LIMIT/GEMINI_RPD_LIMIT settings are ignored. Shared AI usage/security controls remain independent. A TTS 429 returns ProviderRateLimitError with the provider retry hint (or 60 seconds), allowing the existing multi-scene job scheduler to wait and retry the same key; the provider client does not try another key. Authentication/content errors are returned without key failover. Existing single-voice errors, cancellation, network recovery and downloads retain their flow. Manual key replacement affects subsequent requests; an in-flight SDK request keeps its captured key.

## Verification and maintenance

Use `vitest.audio-flow.config.ts` with a disposable local `_test` database. It covers creation/conflicts, recovery, retry, revisions, cancellation/late responses, playback/exports, history/voices and analysis/usage behavior. Provider/storage calls in these suites are stubs; passing them does not prove a live provider or remote bucket is configured correctly.

Before changing this flow, check no-job, first generation, waiting, partial failure, cancellation, reload and previous-audio scenarios. Reuse the existing locks/revision/adapter helpers. Do not couple file naming to guessed URLs or replace persisted retry state with browser-only state.

Runtime controls: new analysis/audio/outline submissions enforce their feature flag and maintenance setting. Provider-disabled or missing-credential configuration errors are terminal, not Google busy retries. Multi-scene recovery reads configured attempts/delay at processing start; Gemini audio RPM/RPD settings are refreshed with the key list. Credentials do not change an already-sent request. See operations.md for environment/managed-mode and encryption details. Pricing values are not used for charging in this change.


## Credit settlement

A user-row database lock serializes balance mutations. Creation reserves funds in the same transaction as the job: one entry for analysis, one per audio item, or one for a single-voice attempt. Cost is fixed at reservation. Analysis costs the configured fixed rate; cached valid completed analysis is free. Audio charges ceil(trimmed Unicode code points × rate / 1000), separately per scene/output; hidden provider prompts are excluded. Single voice uses the submitted script including its text tags.

Saving a successful asset and completing its charge share a transaction. Terminal failure/cancellation releases unused reservations once, while busy/recovery waits retain them. Successful scenes stay charged when another scene fails or the job is cancelled. Provider retries reuse the reservation; manual failed-scene retry creates a new reservation after the failed one was refunded. Manual regeneration is a new paid operation. Legacy jobs already running before billing deployment are not retroactively charged. The client confirms nonzero estimates, but the server computes all costs and enforces balance. Credits do not replace provider quotas.


Invalid/expired Gemini API keys may arrive as HTTP 400 (API_KEY_INVALID), not just 401/403. Analysis reports these as PROVIDER_CONFIGURATION_ERROR; audio uses a safe configuration message, no key switching or automatic retry. Failed reservations are released. Fix the configured key rather than modifying the story or repeatedly submitting.


Deleting a completed multi-voice story removes its generation jobs/items before scenes inside the existing story-lock transaction, avoiding the composite scene/job FK constraint. An active job still rejects deletion. Credit accounting rows keep their story ID snapshot and remain in the ledger after story deletion. This database deletion does not introduce a background storage cleanup mechanism.
