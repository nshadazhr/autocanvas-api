# Storage, playback and download naming

## Current implementation

`src/storage/storage.service.ts` chooses a writer from STORAGE_PROVIDER (default local), and stores locations as **provider://key**. Reads use the provider already recorded in that location, not just the currently configured writer.

| Provider | Destination | Configuration |
| --- | --- | --- |
| local | `uploads/` relative to backend process working directory | STORAGE_PROVIDER=local |
| supabase | Configured bucket; default `autocanvas-audio` | STORAGE_PROVIDER=supabase, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, optional SUPABASE_STORAGE_BUCKET |

New generated keys are provider-independent:

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

The examples are illustrative Roman spellings. `audio-storage-names.ts` builds shared keys before choosing the writer. Local adds `uploads/`; Supabase adds its configured bucket. Supabase's [filename rules](https://supabase.com/docs/guides/storage/uploads/file-limits) restrict object keys, so both stores use the same ASCII-safe labels. Hindi is romanized without an AI call or extra dependency. Other unsupported characters are removed; an empty label falls back to `untitled`/`scene`. Transliteration is a practical storage label, not a linguistic translation.

Story ID remains the identity even if the title changes. New generations use the title at save time; historical database locations stay unchanged and readable. Job ID groups multi-scene generation; the unique take subfolder prevents a recovered worker from colliding with an upload that finished before its database transaction. Single voice uses its persisted generation attempt ID. New exports have independent export IDs. Both writers retain no-overwrite semantics. No database migration or bulk movement of existing objects is required.

## Download names

- Scene WAV and ZIP entries: `001_नौकरी_छोड़ने_की_चिंता.wav` (existing ordered naming helper).
- ZIP: `गांव_में_फ्रेंच_फ्राइज.zip`.
- Single and combined WAV: `मेरी_कहानी.wav` / the sanitized story title.
- Missing or default title: `story_55_audio.wav` or `story_54_audio.zip`.

Readable download names preserve Hindi graphemes, remove path/control characters, use at most six words and bound the label to 160 UTF-8 bytes. Backend ZIP/combined downloads send RFC 5987 UTF-8 Content-Disposition with an ASCII fallback; blob downloads explicitly set the readable browser filename. Stored file names need not equal download names. Legacy recordings also receive current readable download names without renaming their objects.

## Playback and exports

User clients fetch authorized audio blobs/streams from the backend. Scene streaming supports byte ranges; a request for another owner's recording is rejected. Current revision checks decide whether audio matches text, voice and settings. ZIP and combined WAV exports require complete current recordings; missing files are checked before streaming/export.

The combined-asset download service accepts both the legacy owned story/export prefix and the new multiple-voice story/export layout. It checks exact story IDs and rejects traversal; renaming a story does not invalidate old exports. Audio-flow regression tests cover play/ranges, ZIP, combined exports, cancellation and regeneration. The storage layout test uses actual temporary local files and a mocked Supabase SDK to verify identical keys, no-overwrite, legacy reads and ranged reads. Those automated checks do not access a live bucket. Later live probe results and remaining provider blockers are recorded in docs/operations.md.

Local `src/main.ts` also currently mounts uploads as static assets at `/uploads/`. That static route is separate from authenticated audio APIs and does not itself enforce per-user auth. Treat this as a deployment boundary; do not assume local files are private just because API streams are authenticated. Use appropriate access restrictions/private buckets for private content.

## Changing or adding a provider

StorageAdapter defines upload, getFile, getMetadata and delete; reuse it. Add/register an adapter and extend provider selection, typed names and persisted-location parsing together. Test new writes **and old-location reads**. The type union mentioning r2 is not a registered working R2 adapter.

Changing STORAGE_PROVIDER affects new writes; historical prefixes continue selecting their original provider. Keep old provider credentials/data available. Supabase locations currently include provider + key, **not the bucket name**: changing SUPABASE_STORAGE_BUCKET without migrating its content can break historical reads.

Back up PostgreSQL and the corresponding storage objects together. No automatic global cleanup/migration is implied by deleting database records or changing providers. Cancellation can leave a provider request/upload finishing in flight; do not delete supposedly unused objects without checking persisted references and running workers. Never use blanket bucket deletion as an application repair.
