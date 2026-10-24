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

| File | Owns |
| --- | --- |
| `src/audio-stories/audio-stories.service.ts` | Analysis admission/cache, leases/retries, cancellation and syncing validated scenes/characters. |
| `src/audio-stories/services/story-parser.service.ts` | Local structured-script parser. |
| `src/audio-stories/services/story-analysis-validator.service.ts` | Cross-scene/character consistency checks. |
| `src/ai/ai.service.ts`, `src/ai/prompts/story-analysis.txt` | Gemini analysis request, JSON schema/prompt and safe analysis response parsing. |
| `src/audio-generation/audio-generation.service.ts` | Multi-scene jobs, item claims/recovery, audio commit/history, retry/cancel and exports. |
| `src/audio-generation/single-voice.service.ts` | Narration drafts, segments, attempts, cancellation and completed assets. |
| `src/audio-generation/utils/audio-story-lock.ts` | Shared per-story transaction lock/conflicting-job guard. |
| `src/audio-generation/utils/scene-audio-revision.ts` | Determines whether saved audio matches current scene/voice/settings. |
| `src/audio-generation/providers/` | TTS requests, key cooldowns, prompt/error helpers. |
| `src/ai/usage/` | Shared persisted request/character/concurrency accounting. |
| `src/storage/` | Reads/writes through the configured provider; see [storage.md](storage.md). |

## Analysis jobs

`StoryAnalysisJob` persists a script snapshot/hash, attempts, next retry time and worker lease. Submission returns HTTP 202 with safe metadata. Valid structured scripts can use the local parser; otherwise Gemini is used. Schema and consistency validation gate both paths before scene/character updates commit.

States: **QUEUED → PROCESSING → COMPLETED**, with **WAITING** for temporary failures, **FAILED** for terminal failures, and **CANCELLED** for cancellation/content changes.

- Active duplicate submissions reuse the same job; valid unchanged completed analysis is reused.
- 408/429/temporary 5xx and recognized network/timeout errors wait and retry the same job, rather than creating a new job each time.
- Backoff starts around 30 seconds, grows to about five minutes and adds jitter. Retry-After/application quota reset can push the next attempt later.
- Malformed provider responses have a finite retry allowance; permanent authorization/input failures stop with a safe message. Provider availability is not guaranteed.
- The scanner runs every ten seconds. Worker leases last 120 seconds and renew every 15 seconds; expired workers are fenced/recovered.
- Script changes/cancellation prevent old responses from updating current analysis. Current story rows and result are updated transactionally.

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

Shared PostgreSQL limits apply to Gemini analysis, TTS and restricted diagnostics, across instances/restarts. They count admitted provider attempts, including failures, and input characters; they are not exact currency billing or the frontend's displayed credits.

| Setting | Default |
| --- | --- |
| ANALYSIS_MAX_CHARACTERS / ANALYSIS_MAX_SCENES | 30,000 / 200 |
| ANALYSIS_GLOBAL_WORKERS / ANALYSIS_USER_ACTIVE_JOBS | 2 / 2 |
| AI_SUBMISSIONS_PER_MINUTE / AI_SUBMISSIONS_PER_DAY | 3 / 30 per user for analysis admission |
| AI_GLOBAL_CONCURRENCY / AI_USER_CONCURRENCY | 3 / 1 |
| AI_GLOBAL_REQUESTS_PER_MINUTE / AI_GLOBAL_REQUESTS_PER_DAY | 10 / 300 |
| AI_USER_REQUESTS_PER_MINUTE / AI_USER_REQUESTS_PER_DAY | 5 / 100 |
| AI_GLOBAL_CHARACTERS_PER_DAY / AI_USER_CHARACTERS_PER_DAY | 500,000 / 100,000 |
| AI_MAX_REQUEST_CHARACTERS | 40,000 per provider call |
| AUDIO_MAX_RECOVERY_ATTEMPTS | 3 |
| AUDIO_RECOVERY_RETRY_DELAY_MS | 60,000 |
| AUDIO_RETRY_SCAN_INTERVAL_MS | 30,000 |

Configured limits must be positive integers. Shared time buckets use fixed UTC boundaries. Provider calls have a 90-second timeout.

The Gemini TTS key manager additionally has process-local per-key cooldown/rate tracking (`GEMINI_RPM_LIMIT`, default 3; `GEMINI_RPD_LIMIT`, default 10; daily reset uses America/Los_Angeles). Those counters are not a replacement for shared DB caps. Optional multi-key mode rotates available configured keys; it does not remove provider quotas or guarantee success.

## Verification and maintenance

Use `vitest.audio-flow.config.ts` with a disposable local `_test` database. It covers creation/conflicts, recovery, retry, revisions, cancellation/late responses, playback/exports, history/voices and analysis/usage behavior. Provider/storage calls in these suites are stubs; passing them does not prove a live provider or remote bucket is configured correctly.

Before changing this flow, check no-job, first generation, waiting, partial failure, cancellation, reload and previous-audio scenarios. Reuse the existing locks/revision/adapter helpers. Do not couple file naming to guessed URLs or replace persisted retry state with browser-only state.
