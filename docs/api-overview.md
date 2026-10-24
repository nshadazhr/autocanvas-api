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

## Story analysis and cast

Controller: `src/audio-stories/audio-stories.controller.ts`.

| Route | Purpose |
| --- | --- |
| POST /audio-stories | Create an owned story (`title`, `content`). |
| GET /audio-stories | List the user's stories. |
| GET /audio-stories/:id | Story details, analysis result/status and latest analysis job metadata. |
| PATCH /audio-stories/:id | Edit title/content; changed content invalidates analysis and cancels active analysis. |
| DELETE /audio-stories/:id | Delete the owned database story; do not assume this garbage-collects remote files. |
| POST /audio-stories/:id/analyze | HTTP 202: create/reuse a durable analysis job. |
| GET /audio-stories/:id/analysis-jobs/latest | Latest owned analysis job metadata. |
| POST /audio-stories/:id/analysis-jobs/:jobId/cancel | Cancel active analysis; fence late results. |
| GET /audio-stories/:id/cast | Current character/voice assignments. |
| PATCH /audio-stories/:id/cast | Persist character voice assignments. |

Current create DTO caps title at 120 characters and content at 30,000. Title/content are required; UI defaults are not a promise that the API accepts missing fields. Read `src/audio-stories/dto/` and `src/ai/schemas/story-analysis.schema.ts` before changing analysis shape.

## Multi-scene generation and files

Controller: `src/audio-generation/audio-generation.controller.ts`.

| Route | Purpose |
| --- | --- |
| POST /audio-generation/stories/:storyId/jobs | Create a generation job using current analyzed scenes/voices. |
| GET /audio-generation/stories/:storyId/jobs/latest | Restore the current/latest job after reload or tab navigation. |
| GET /audio-generation/jobs/:jobId | Job counters and scene items, errors/retry times and audio metadata. |
| POST /audio-generation/jobs/:jobId/cancel | Cancel pending/processing/waiting work and retain completed audio. |
| POST /audio-generation/jobs/:jobId/retry | Create a **new** job for failed items of a FAILED/PARTIAL job. |
| POST /audio-generation/stories/:storyId/scenes/:sceneId/regenerate | Create a single-scene generation job; same action also serves a first generation. |
| GET /audio-generation/stories/:storyId/audio-history | Full current scene list, assigned voices, audio versions, last attempt and download names. |
| GET /audio-generation/audio/:audioId/stream | Authorized WAV streaming; byte ranges are supported. |
| GET /audio-generation/stories/:storyId/download-zip | ZIP of complete current scene audio. |
| POST /audio-generation/stories/:storyId/export-wav | Generate a persisted combined WAV asset. |
| GET /audio-generation/exports/:assetId/download | Download the owned combined export asset. |

A latest-job endpoint can send an empty body when no job exists. Browser consumers must normalize it to null and validate that job details contain an items array. The frontend decoder is `audio-generation-response.ts` in the web repo.

ZIP/combined export requires complete current audio. A past recording does not automatically count after script/voice/style changes. Partial retry jobs do not contain all story rows; use audio history as the row source. See [audio-flow.md](audio-flow.md) and [storage.md](storage.md).

## Single-voice narration

Controller: `src/audio-generation/single-voice.controller.ts`.

| Route | Purpose |
| --- | --- |
| POST /audio-generation/single/stories | Create narration project (`title`, `content`). |
| GET /audio-generation/single/stories/:storyId | Saved draft, status, selected voice/style and current/previous asset metadata. |
| POST /audio-generation/single/stories/:storyId/generate | Persist submitted draft/options and start narration (`voiceId`, optional `style`, `title`, `content`). |
| POST /audio-generation/single/stories/:storyId/cancel | Stop remaining work and preserve previous completed narration. |
| GET /audio-generation/single/stories/:storyId/audio/:audioId | Authorized saved narration stream. |

Current script cap is 12,000 characters; supported speaking styles are validated by the service. A single-voice project uses its own status/attempt token, not a multi-scene job ID.

## Other current backend areas

| Area | Routes / source |
| --- | --- |
| Voices | GET /voices lists saved voices. POST /voices syncs provider voices and additionally requires the explicit diagnostic allowlist. |
| Gemini diagnostics | GET /ai/test and GET /ai/models require user auth plus `AI_DIAGNOSTICS_USER_IDS`. A role alone does not bypass this check. Diagnostics can consume provider usage. |
| Generic projects | POST/GET /projects; GET/PATCH/DELETE /projects/:id. Controller: `src/projects/projects.controller.ts`. |
| Animation | Project CRUD under /animation/projects; scene CRUD under /animation/projects/:projectId/scenes. Source: `src/animation/animation.controller.ts`. Persistence endpoints do not imply a video-rendering pipeline exists. |
| Script outline | POST /script/outline/generate accepts title/language and uses the configured OpenAI model. Source: `src/script/`. |

The shared Gemini usage caps do not automatically cover unrelated OpenAI features. A product-page route is not evidence the corresponding backend feature or billing enforcement is implemented.

## Error interpretation

| Status | Typical meaning |
| --- | --- |
| 400 | Invalid DTO, unsupported option, incomplete analysis/voices, missing current audio or stale retry input. |
| 401 | Missing/expired/revoked session or wrong token audience/purpose. |
| 403 | Insufficient role, disallowed Origin or diagnostic allowlist denial. |
| 404 | Resource missing or inaccessible to the requesting owner. |
| 409 | Conflicting active generation or a role change that would remove the last superadmin. |
| 429 | Login/admission usage limit; inspect Retry-After or returned retry metadata. |
| 5xx | Server/configuration/provider/storage error; inspect safe job status and server context. |

Temporary provider errors can appear as WAITING job state instead of a failing submission HTTP response. Preserve that distinction in clients. Never retry creation blindly on every HTTP error: a job may already exist; restore state first.
