/**
 * `@modules/audio` deliberately has ZERO dependency on `@platform/database`
 * (same design rule packages/storage follows — see its src/keys.ts comment).
 * This module holds Audio Studio's pure domain logic: CSV parsing, scene
 * validation, voice/model fallback resolution, and merge/export readiness
 * checks. None of that needs a live Prisma client, and keeping it
 * dependency-free is what makes it genuinely unit-testable without a
 * database, and safely reusable from both apps/web (Server Actions) and
 * apps/worker (job handlers) without either pulling in the other's
 * concerns.
 *
 * Because of that, this file re-declares the handful of Prisma enum shapes
 * this module's logic actually needs (as plain string-literal unions)
 * instead of importing `@prisma/client`'s generated enums. Keep these in
 * sync with `packages/database/prisma/schema.prisma` by hand — `SceneStatus`
 * here mirrors the `SceneStatus` enum there exactly.
 */
export type SceneStatus = "PENDING" | "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";

/**
 * One row successfully parsed out of an uploaded CSV — no DB lookups have
 * happened yet. `voiceName` is a free-text label the CSV author typed (e.g.
 * "Narrator" or an ElevenLabs voice name); resolving it to an actual
 * VoiceProfile id is a separate, DB-touching step deliberately kept out of
 * this module (see resolveSceneVoiceProfileId for the *fallback* logic that
 * step delegates to once the id is known).
 */
export interface ParsedSceneRow {
  sceneNumber?: number;
  title?: string;
  text: string;
  voiceName?: string;
  character?: string;
  style?: string;
  emotion?: string;
  language?: string;
  targetDuration?: number;
}

export interface CsvRowError {
  /** 1-based data row number (header row is not counted), for user-facing error messages. */
  rowNumber: number;
  message: string;
}

export class CsvFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvFormatError";
  }
}
