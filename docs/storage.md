# Storage, playback and download naming

## Current implementation

`src/storage/storage.service.ts` chooses a writer from STORAGE_PROVIDER (default local), and stores locations as **provider://key**. Reads use the provider already recorded in that location, not just the currently configured writer.

| Provider | Destination | Configuration |
| --- | --- | --- |
| local | `uploads/` relative to backend process working directory | STORAGE_PROVIDER=local |
| supabase | Configured bucket; default `autocanvas-audio` | STORAGE_PROVIDER=supabase, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, optional SUPABASE_STORAGE_BUCKET |

Current generated keys are provider-independent:

```text
audio-stories/
└── {storyId}/
    ├── {sceneId}-{uuid}.wav
    ├── single/
    │   └── {uuid}.wav
    └── exports/
        └── story-{storyId}-{uuid}.wav
```

Example persisted location: `local://audio-stories/54/123-example-uuid.wav`. Local disk adds the uploads root; Supabase uses the key inside its bucket. The older `uploads/audio-stories/...` local location format remains readable.

UUID names keep new versions from overwriting previous files. Both writers use no-overwrite semantics. The database references exact saved locations; titles are not used to reconstruct old paths.

## Storage names versus download names

They are different contracts. The source of readable multi-scene names is `src/audio-generation/utils/scene-download-filename.ts`, exposed through audio history as downloadFilename and used by individual downloads/ZIP entries.

| Output | Current naming |
| --- | --- |
| Stored scene audio | `{sceneId}-{uuid}.wav` |
| Individual scene download / ZIP entry | `001_नौकरी_छोड़ने_की_चिंता.wav` style: padded scene order + cleaned title; dialogue words if title absent |
| ZIP download | `story-{storyId}-audio.zip` |
| Stored combined WAV | `exports/story-{storyId}-{uuid}.wav` |
| Combined download | `story-{storyId}-export-{assetId}.wav` |
| Stored single narration | `single/{uuid}.wav` |
| Single narration browser download | Current frontend sanitizes its title with an ASCII-oriented expression, falling back to `audio.wav`; Hindi-title download support still needs the planned naming change. |

Per-scene readable labels use at most six words, preserve Hindi marks/graphemes, sanitize path/control characters and bound UTF-8 length. Order numbers stay unique even when labels repeat. Old recordings do not need to be renamed for current per-scene downloads to receive the readable name.

## Approved future layout: not applied yet

The agreed direction is voice type → stable story folder → job/attempt → files:

```text
audio-stories/
├── multiple-voice/
│   └── story_54_roman_story_title/
│       └── job-40/
│           └── 001_roman_scene_name.wav
└── single-voice/
    └── story_55_untitled/
        └── attempt-example/
            └── narration.wav
```

Storage segments should use safe ASCII/Roman names for provider compatibility; browser downloads/ZIP entries can use readable Hindi names. Title-based ZIP naming and single narration download naming are part of this pending work. The desired title-less ZIP fallback is `story_54_audio.zip`.

The layout must preserve a stable story identity across renames and keep regeneration versions distinct. It has **not** been implemented or used to move existing files. Do not document these paths as live or change only upload paths: export-directory validation and location parsing also need coordinated changes and local/Supabase tests.

## Playback and exports

User clients fetch authorized audio blobs/streams from the backend. Scene streaming supports byte ranges; a request for another owner's recording is rejected. Current revision checks decide whether audio matches text, voice and settings. ZIP and combined WAV exports require complete current recordings; missing files are checked before streaming/export.

The combined-asset download service validates its owned story/export prefix. Updating folder rules without updating that validation will break exports. Keep old saved locations readable during a migration, and verify play, range requests, individual downloads, ZIP, combined export, cancellation and regeneration for both adapters.

Local `src/main.ts` also currently mounts uploads as static assets at `/uploads/`. That static route is separate from authenticated audio APIs and does not itself enforce per-user auth. Treat this as a deployment boundary; do not assume local files are private just because API streams are authenticated. Use appropriate access restrictions/private buckets for private content.

## Changing or adding a provider

StorageAdapter defines upload, getFile, getMetadata and delete; reuse it. Add/register an adapter and extend provider selection, typed names and persisted-location parsing together. Test new writes **and old-location reads**. The type union mentioning r2 is not a registered working R2 adapter.

Changing STORAGE_PROVIDER affects new writes; historical prefixes continue selecting their original provider. Keep old provider credentials/data available. Supabase locations currently include provider + key, **not the bucket name**: changing SUPABASE_STORAGE_BUCKET without migrating its content can break historical reads.

Back up PostgreSQL and the corresponding storage objects together. No automatic global cleanup/migration is implied by deleting database records or changing providers. Cancellation can leave a provider request/upload finishing in flight; do not delete supposedly unused objects without checking persisted references and running workers. Never use blanket bucket deletion as an application repair.
