/**
 * Pure mime-type <-> file-extension helpers for Audio Studio's generated
 * clips and merged exports.
 *
 * `AudioGeneration` (schema.prisma) deliberately has no `mimeType` column —
 * adding one just to remember "wav vs mp3" for the one place that needs it
 * later (the merge job, picking a demux-friendly temp file extension)
 * seemed like schema bloat for a fact we can recover for free: this
 * module's storage key builders always suffix the object key with the
 * real extension at upload time (see apps/worker's generate_scene_audio
 * handler), so `extensionFromStorageKey` just reads it back off the key
 * instead. This is a deliberate simplification, flagged here the same way
 * the "no default AiModel flag yet" gap is flagged in voice-resolution.ts.
 */

const KNOWN_AUDIO_MIME_EXTENSIONS: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/flac": "flac",
};

/** Falls back to the mime subtype (e.g. "audio/aac" -> "aac") for anything not in the known-good table above. */
export function extensionForAudioMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  const known = KNOWN_AUDIO_MIME_EXTENSIONS[normalized];
  if (known) return known;

  const subtype = normalized.split("/")[1];
  const cleaned = subtype?.replace(/[^a-z0-9]/g, "");
  return cleaned && cleaned.length > 0 ? cleaned : "bin";
}

/** Reads the extension back off a storage key built by buildAudioGenerationKey/buildAudioExportKey (packages/storage/src/keys.ts). */
export function extensionFromStorageKey(storageKey: string): string {
  const lastDot = storageKey.lastIndexOf(".");
  const lastSlash = storageKey.lastIndexOf("/");
  if (lastDot === -1 || lastDot < lastSlash || lastDot === storageKey.length - 1) {
    return "bin";
  }
  return storageKey.slice(lastDot + 1);
}
