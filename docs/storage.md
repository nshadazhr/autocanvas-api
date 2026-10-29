# Storage, playback and download naming

## Current implementation

`src/storage/storage.service.ts` chooses a writer from STORAGE_PROVIDER (default local), and stores locations as **provider://key**. Reads use the provider already recorded in that location, not just the currently configured writer.

| Provider | Destination | Configuration |
| --- | --- | --- |
| local | `autocanvas-assets/` relative to the backend working directory | STORAGE_PROVIDER=local |
| supabase | Configured bucket; default `autocanvas-assets` | STORAGE_PROVIDER=supabase, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, optional SUPABASE_STORAGE_BUCKET |
| r2 | Private Cloudflare R2 bucket through its S3 API | STORAGE_PROVIDER=r2, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_STORAGE_BUCKET |

The logical module paths are identical across providers. Use cloud bucket `autocanvas-assets`; local new writes use the matching directory `autocanvas-assets/`.

```text
audio-stories/
├── multiple-voice/
│   └── story_54_gaanv_men_phrench_phraaij/
│       ├── job-40/
│       │   └── take-{uuid}/
│       │       └── 001_naukree_chhodne_kee_chintaa.wav
│       └── exports/
│           └── export-{uuid}/
│               └── gaanv_men_phrench_phraaij.wav
└── single-voice/
    └── story_55_meree_kahaanee/
        └── attempt-{uuid}/
            └── meree_kahaanee.wav
```

The examples are illustrative Roman spellings. `audio-storage-names.ts` builds shared keys before choosing the writer. New local writes add `autocanvas-assets/`; Supabase and R2 use their configured `autocanvas-assets` buckets. All providers store bucket-relative locations in the same form: `local://audio-stories/...`, `supabase://audio-stories/...` or `r2://audio-stories/...`. The local adapter adds its assets root; cloud adapters add their configured bucket. Raw `uploads/...` paths, old local root fallback and the old story-ID-only export layout are no longer supported. This simplification is intended for the user-planned data reset; the code does not delete existing database/storage data. Supabase's [filename rules](https://supabase.com/docs/guides/storage/uploads/file-limits) restrict object keys, so all stores use the same ASCII-safe labels. Hindi is romanized without an AI call or extra dependency. Other unsupported characters are removed; an empty label falls back to `untitled`/`scene`. Transliteration is a practical storage label, not a linguistic translation.

Story ID remains the identity even if the title changes. New generations use the title at save time; existing recordings in the supported layout keep their saved keys. Job ID groups multi-scene generation; the unique take subfolder prevents a recovered worker from colliding with an upload that finished before its database transaction. Single voice uses its persisted generation attempt ID. New exports have independent export IDs. All writers retain no-overwrite semantics; R2 uses atomic `If-None-Match: *` conditional uploads. No database migration or bulk movement of existing objects is required.

## Environment setup

Choose the writer explicitly for each deployment; NODE_ENV does not silently select storage:

- Local development: `STORAGE_PROVIDER=local`. R2/Supabase credentials are not required unless reading historical assets from those providers.
- Sandbox: `STORAGE_PROVIDER=supabase`, with the sandbox Supabase URL/service-role key and `SUPABASE_STORAGE_BUCKET=autocanvas-assets`. The default bucket is also `autocanvas-assets`; an explicit environment override still takes precedence.
- Production (Render or VPS): `STORAGE_PROVIDER=r2`, with the four server-only R2 values below. Keep the bucket private and use an Object Read & Write S3 token scoped to that bucket. The application does not create buckets or upload directly from the browser.

```dotenv
STORAGE_PROVIDER=r2
R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=replace-with-r2-access-key-id
R2_SECRET_ACCESS_KEY=replace-with-r2-secret-access-key
R2_STORAGE_BUCKET=autocanvas-assets
```

Replace placeholders with the S3 API endpoint and S3 access-key pair from Cloudflare, not a public bucket/custom-domain URL or a general Cloudflare API bearer token. The endpoint must be an HTTPS Cloudflare R2 S3 origin without a bucket path, embedded credentials, query or fragment. Jurisdiction-specific R2 endpoints are accepted. Region is `auto`; the SDK uses path-style addressing and only required checksums for R2 compatibility. The adapter initializes lazily, so local/sandbox startup does not require production credentials. Missing/invalid R2 configuration fails explicitly when R2 is used; it never silently writes to a different provider. Restart the backend after environment changes. Never put these credentials in public app configuration or NEXT_PUBLIC variables.

Playback, metadata, ZIP and WAV exports keep using the authenticated backend storage APIs, with no public R2 URL or frontend changes. Ranged reads use S3 Range requests and stream only the selected bytes; `StorageFile.size` remains the full object size. Invalid ranges fail rather than returning the wrong audio. Missing objects return not-found errors, duplicate uploads return conflicts, and upstream errors are sanitized. The adapter closes its SDK client on application shutdown. Connection/request timeouts are bounded at 10/90 seconds per request.

Setup references: [Cloudflare S3 SDK example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/) and [R2 S3 API compatibility, including atomic conditional writes](https://developers.cloudflare.com/r2/api/s3/api/).

## Verification

R2 tests use SDK stubs plus an actual AWS SDK request/response pipeline with an in-memory transport (no live network). They cover upload/no-overwrite, complete and partial streaming, full-size metadata, deletion, missing files, invalid ranges/keys/configuration, sanitized errors, saved-provider routing and export ownership. The full audio-flow suite passed 151 tests, including R2-prefixed HTTP playback/ZIP/combined-export ownership checks and existing real-local/mocked-Supabase coverage. Backend build and typechecking also passed. These automated tests do not verify a real Cloudflare bucket/token. A separate 2026-10-29 live check subsequently passed against the configured local/Supabase/R2 stores; see [operations](operations.md#live-storage-and-audio-verification--2026-10-29) for results and scope. The R2 adapter itself needs no data migration; the upload-cleanup feature below requires its own schema migration. No bulk object migration or `.env` rewrite is performed.

## Download names

- Scene WAV and ZIP entries: `001_नौकरी_छोड़ने_की_चिंता.wav` (existing ordered naming helper).
- ZIP: `गांव_में_फ्रेंच_फ्राइज.zip`.
- Single and combined WAV: `मेरी_कहानी.wav` / the sanitized story title.
- Missing or default title: `story_55_audio.wav` or `story_54_audio.zip`.

Readable download names preserve Hindi graphemes, remove path/control characters, use at most six words and bound the label to 160 UTF-8 bytes. Backend ZIP/combined downloads send RFC 5987 UTF-8 Content-Disposition with an ASCII fallback; blob downloads explicitly set the readable browser filename. Stored file names need not equal download names. Legacy recordings also receive current readable download names without renaming their objects.

## Playback and exports

User clients fetch authorized audio blobs/streams from the backend. Scene streaming supports byte ranges; a request for another owner's recording is rejected. Current revision checks decide whether audio matches text, voice and settings. ZIP and combined WAV exports require complete current recordings; missing files are checked before streaming/export.

The combined-asset download service accepts only the current multiple-voice story/export layout. It checks exact story IDs and rejects traversal; renaming a story does not invalidate old exports. Audio-flow regression tests cover play/ranges, ZIP, combined exports, cancellation and regeneration. The storage layout test uses actual temporary local files and a mocked Supabase SDK to verify identical keys, no-overwrite, current-format saved-provider reads and ranged reads. Those automated checks do not access a live bucket. Later live probe results and remaining provider blockers are recorded in docs/operations.md.

Local `src/main.ts` also currently mounts the local assets directory at `/autocanvas-assets/`. That static route is separate from authenticated audio APIs and does not itself enforce per-user auth. Treat this as a deployment boundary; do not assume local files are private just because API streams are authenticated. Use appropriate access restrictions/private buckets for private content.

## Changing or adding a provider

StorageAdapter defines upload, getFile, getMetadata and delete; reuse it. Add/register an adapter and extend provider selection, typed names and persisted-location parsing together. Test new writes **and old-location reads**. Local, Supabase and R2 adapters are registered and share this contract.

Changing STORAGE_PROVIDER affects new writes; historical prefixes continue selecting their original provider. Keep old provider credentials/data available. Supabase and R2 locations contain provider + key, **not the bucket/account name**. Changing SUPABASE_STORAGE_BUCKET, R2_STORAGE_BUCKET or the R2 account endpoint without migrating the objects can break historical reads. Retain the local uploads directory when moving servers if local historical assets still reference it.

Back up PostgreSQL and the corresponding storage objects together. Changing providers does not migrate objects. Only the tracked-file cleanup below runs automatically; never use blanket bucket deletion as an application repair.

## Automatic cleanup of tracked uploads

Deploy migrations `20261028170000_storage_cleanup` and `20261028173000_storage_cleanup_fence`, regenerate Prisma and deploy the new backend before using upload tracking. Drain/stop old backend workers before rollout; an older binary does not participate in the reference/deletion locks. The migrations add `StorageObject` receipts, per-attempt deletion fencing and indexes for existing scene/asset file-path lookups. It does not move files, scan buckets or backfill old objects.

New `StorageService.upload` calls record the intended provider/location and a non-secret namespace hash before starting I/O. Successful uploads and uncertain/failed uploads remain eligible for a check after **24 hours**. Explicit no-overwrite rejections (for example an already-existing object) are marked UNOWNED and excluded, because a failed attempt does not prove ownership of that pre-existing file. The scanner starts 30 seconds after app startup and runs hourly, processing at most 100 due receipts per pass. Super Admin → Storage manages the private `storage.cleanupEnabled` boolean in `backend_settings.storage` through GET/PATCH `/admin/config/storage`. Only current SUPERADMIN sessions can read/write it; ordinary admins cannot access the page/control/API. The worker checks this setting every 30 seconds and before each file, so pause/resume needs no restart. A file deletion already in progress may finish. Disabled state still polls for re-enablement without scanning objects. Invalid/unavailable configuration stops collection safely. No public/manual cleanup endpoint is added. Saved values override the legacy environment fallback, then the enabled-by-default code value. Reset removes the saved override and restores the environment/default. Preserve the effective value before manually removing an old environment entry.

Before deleting an object, cleanup checks all SceneAudio and AudioAsset references, including old recordings/history/exports, plus pending/processing/waiting multi-scene jobs and active single-voice stories. Referenced files remain indefinitely; an active story postpones cleanup. Removing a saved reference makes its tracked object eligible at a later due check, rather than deleting other history. Files are not deleted merely because a regeneration produced a newer recording. `temp/` uploads through StorageService have the same 24-hour expiry but still respect existing database references. Future module prefixes are skipped until their reference resolver is implemented.

All three audio commit paths lock/validate the upload receipt inside the same transaction that persists the asset and charges credits. Cleanup obtains that row lock and commits a DELETING marker before provider I/O. This prevents a late transaction attaching an object that cleanup has claimed. Failed deletion retries in a later scan, including after process restart. Each deletion attempt has a unique fence: an older successful response cannot clear a retry scheduled for a late upload. Successful deletion retains a small DELETED tombstone, preventing reuse of the immutable location. An upload completing after collection is fenced and deleted again rather than attached. Logs identify only receipt IDs; provider errors/credentials are not exposed.

The namespace hash includes provider endpoint/bucket (local: hostname/root), not credential secrets. Cleanup skips unavailable or changed namespaces rather than deleting the same logical key in a different bucket/server. Keep original credentials/configuration for providers with existing tracked objects. Local cleanup is scoped to the original host/root; replicas with separate local filesystems must not assume shared storage.

**Existing/manual files and folder markers remain untouched.** Only receipts created by this upload flow are collected; there is no automatic historical-orphan audit/backfill. The R2 folders already created in the console do not need deletion or recreation, and no bucket lifecycle rule is required for app-managed cleanup. Do not apply an age-based rule to `audio-stories/`, because it would delete saved history regardless of database references. Manually uploaded `temp/` objects without receipts are also outside this scanner.

Verification covers real PostgreSQL locks and receipt persistence with fake provider I/O: grace period, saved scene/audio history, active jobs, temp expiry, namespace mismatches, deletion retry/restart, multi-worker claims, commit/delete races and late uploads. Timer checks cover maintenance disable, shutdown and overlap. All 151 audio/analysis/storage tests plus build/typechecking passed; no live R2/Supabase files were deleted by these tests.
