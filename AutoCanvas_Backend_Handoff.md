# AutoCanvas Backend — Conversation Handoff (15 October 2026)

> Historical handoff (older archive/conversation context). Port, route, auth and storage assumptions below may be outdated. Start with the current [README](README.md), [API overview](docs/api-overview.md) and [operations guide](docs/operations.md); verify source before applying old implementation notes.

## Purpose

Use this document in a fresh ChatGPT conversation together with `Backend.zip` and, if relevant, the frontend `src` ZIP. Continue the existing AutoCanvas Audio Studio implementation; do not redesign existing Prisma models or recreate existing frontend screens. Verify actual files before proposing code changes.

## Verified archive and stack

Source: user-supplied `Backend.zip`, inspected on 15 October 2026. Contains `src/`, `prisma/schema.prisma`, and migrations. NestJS, TypeScript ESM (`.js` import suffix), Prisma/PostgreSQL, Gemini TTS. `src/prisma/prisma.service.ts` exists; reuse it.

`src/main.ts` already configures `NestExpressApplication`, CORS origin `http://localhost:4000`, cookie parser, global ValidationPipe, Swagger at `/swagger/json`, and **static file serving**:

```ts
app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads/' });
```

Listening port: `process.env.PORT ?? 3000`. Do **not** assume backend is on 4000 without checking runtime environment. Static serving makes audio files accessible to anyone with their URL; consider authenticated delivery before production.

## Verified routes

### Audio Stories (`src/audio-stories/audio-stories.controller.ts`, AuthGuard)

- `POST /audio-stories` — create
- `GET /audio-stories` — list current user's stories
- `GET /audio-stories/:id` — details
- `PATCH /audio-stories/:id` — update
- `DELETE /audio-stories/:id` — delete
- `POST /audio-stories/:id/analyze` — analyze and persist scenes/characters
- `PATCH /audio-stories/:id/cast` — update character voice assignment
- `GET /audio-stories/:id/cast` — read cast

### Audio Generation (`src/audio-generation/audio-generation.controller.ts`, AuthGuard)

- `POST /audio-generation/stories/:storyId/jobs` — create generation job and start background processing
- `GET /audio-generation/jobs/:jobId` — job status and per-scene items/audio
- `POST /audio-generation/jobs/:jobId/retry` — create retry job for failed scenes

### Voices (`src/voices/voices.controller.ts`)

- `GET /voices` — voice list (controller has no AuthGuard decorator)

Other modules in archive: auth, user, profile, projects, scripts, AI. Their full route contracts should be inspected if needed rather than inferred.

## Verified backend implementation

- `src/audio-stories/audio-stories.service.ts` handles ownership, CRUD, analysis, scene/character syncing, and cast updates.
- `src/audio-stories/services/story-parser.service.ts` parses `PART N` and `SCENE N` headings, speaker/dialogue metadata, and validates scene ordering.
- `src/audio-stories/services/story-analysis-validator.service.ts` validates analysis output.
- `src/audio-stories/audio-story-analysis.service.ts` delegates to AI service.
- **Important actual-code observation:** `AudioStoriesService.analyze()` first tries local parsing. If local validation fails, it currently **calls Gemini AI fallback**. Earlier product decision was to disable AI-based story analysis using a centralized global feature flag while keeping local parser enabled. This ZIP does **not** demonstrate that the desired disabled fallback has been enforced. Check and reconcile this before claiming AI analysis is disabled. Do not conflate Gemini **story analysis** with Gemini **TTS**, which is meant to remain active.
- Analysis logic has status/attempt tracking and recovery for stale processing (10-minute threshold in `analyze`).
- `src/audio-generation/audio-generation.service.ts` implements voice resolution, speech generation, WAV saving, job creation, sequential processing, job status, retry of failed items, and recovery of interrupted jobs (`OnModuleInit`).
- `src/audio-generation/providers/gemini-tts.service.ts` calls Gemini for TTS.
- Background job launch uses `setImmediate`; this is not a durable queue and needs production hardening later, not a premature rewrite now.
- Voice mapping via `VoiceProviderMapping`: `provider`, `providerVoiceId`, `model`, optional settings. Generation needs an assigned voice with a compatible mapping.

## Prisma schema

`prisma/schema.prisma` contains these models:
`User`, `PendingRegistration`, `AuthIdentity`, `Project`, `Script`, `ProjectScript`, `AudioStory`, `AudioCharacter`, `AudioScene`, `Voice`, `VoiceProviderMapping`, `AudioGenerationJob`, `AudioGenerationJobItem`, `SceneAudio`, `AudioAsset`.
Enums: `AudioAnalysisStatus`, `AudioJobStatus`, `AudioJobItemStatus`.
**Preserve the current story-specific `AudioCharacter`/`AudioScene` design and existing migrations** unless a concrete defect necessitates a change.

## Known successfully tested data (from preceding conversation, not re-tested against database in ZIP)

- Story ID `2`, user ID `17`, 2 scenes.
- Original generation job `2`: `PARTIAL`; scene 1 completed, WAV saved under `uploads/audio-stories/2/`.
- Retry job `5`: `COMPLETED`, one failed scene retried and generated successfully. Scene 2 audio ID `4`, duration `3451 ms`, format `wav`, path `uploads/audio-stories/2/2-14d155a3-98e1-4873-8ca1-7637f0ddf2a7.wav`.
- Previously, scene 2 failed due to a missing voice-provider mapping; mapping was added, then retry succeeded.
- Static file serving was added to `src/main.ts` and user subsequently reported `done`. This is not independent proof that browser playback succeeded.
- Do not rerun Gemini generation merely to verify frontend integration; use existing saved audio.

## Frontend integration next

User says Audio Studio frontend is already substantially implemented. Do not rebuild dashboard, scene editor, cast UI, or playback controls. Review the **actual uploaded frontend source ZIP** and existing API client/auth flow before suggesting edits.

Suggested minimal incremental workflow:

1. Identify current Audio Studio story detail route, components, existing API client, and authentication conventions.
2. Compare existing API calls with the verified backend endpoints and response shapes; reuse existing code.
3. Load story details/scenes/cast and `/voices` from real APIs.
4. Wire generation action to `POST /audio-generation/stories/:storyId/jobs` and poll `GET /audio-generation/jobs/:jobId`.
5. Display progress and errors; wire retry endpoint for failed items.
6. Resolve existing `SceneAudio.filePath` into playable URLs, taking account of actual API origin and authorization. **Original and retry audio may be in different jobs**, so avoid assuming one job contains every scene's latest audio.
7. Verify frontend audio playback using saved WAV without additional paid TTS calls.

## Conventions / user preferences

- Explain in Roman Hindi, concise, with exact paths and copy-paste code.
- Work **one step at a time**, user often replies `done`.
- Avoid speculative variable names and invented endpoints.
- Preserve current architecture, Prisma schema, and real API-driven voice lists; no hardcoded demo voices.
- Keep local parser analysis enabled; AI story-analysis disabled by centralized config when implemented; Gemini TTS remains enabled.
- Focus on existing frontend/backend integration and playback, not redesign or unnecessary migrations.

## Verification boundaries

This document is a static snapshot of the supplied ZIP and conversation. Runtime environment variables, live database rows, frontend source, and end-to-end playback were not independently verified here. Do not claim they were. Avoid exposing secrets from `.env` files.
