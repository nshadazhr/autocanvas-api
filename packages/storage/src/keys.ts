import { InvalidStorageKeyError } from "./errors";

// ─────────────────────────────────────────────────────────────────────────
// Storage keys are plain strings (the `storageKey` columns on ProjectFile,
// Invoice, AudioGeneration, AudioExport in schema.prisma) — this package
// deliberately has NO dependency on @platform/database. Callers pass in
// whatever IDs they already have (ownerId/organizationId, projectId,
// sceneId, ...); this file only builds and validates the resulting string.
// Keeping this decoupled means packages/storage can be unit-tested with
// zero DB/Prisma involvement at all, and any future module (Script/Image/
// Video Studio) can reuse the same builders without a new dependency edge.
// ─────────────────────────────────────────────────────────────────────────

const MAX_KEY_LENGTH = 1024; // S3's own hard limit
const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

/**
 * Rejects anything that isn't a plain, predictable key: no path traversal,
 * no leading slash, no empty segments, no characters that behave
 * differently across S3-compatible providers. Called by every builder
 * below, and exported so callers building ad-hoc keys elsewhere can reuse
 * the same rules instead of inventing their own.
 */
export function validateStorageKey(key: string): string {
  if (!key) {
    throw new InvalidStorageKeyError(key, "key is empty");
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new InvalidStorageKeyError(key, `exceeds ${MAX_KEY_LENGTH} characters`);
  }
  if (key.startsWith("/") || key.endsWith("/")) {
    throw new InvalidStorageKeyError(key, "must not start or end with '/'");
  }
  if (key.includes("\\")) {
    throw new InvalidStorageKeyError(key, "backslashes are not allowed");
  }
  const segments = key.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new InvalidStorageKeyError(key, `invalid path segment "${segment}"`);
    }
  }
  return key;
}

/** One segment of a key (an id, a slug, ...) — stricter than the full-key check above. */
function safeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new InvalidStorageKeyError(value, `"${label}" must match ${SAFE_SEGMENT} (got "${value}")`);
  }
  return value;
}

/** "org/<id>" for organization-owned projects, "user/<id>" for personal ones — mirrors CreditAccount's own owner-vs-org split (packages/credits). */
export function buildOwnerScope(input: { organizationId?: string | null; userId: string }): string {
  if (input.organizationId) {
    return `org/${safeSegment(input.organizationId, "organizationId")}`;
  }
  return `user/${safeSegment(input.userId, "userId")}`;
}

export interface ProjectFileKeyInput {
  scope: string; // from buildOwnerScope()
  projectId: string;
  fileId: string;
  extension: string; // without the leading dot, e.g. "csv"
}

export function buildProjectFileKey(input: ProjectFileKeyInput): string {
  const key = [
    safeSegment(input.scope.split("/")[0], "scope"), // "org" | "user"
    safeSegment(input.scope.split("/")[1], "scope id"),
    "projects",
    safeSegment(input.projectId, "projectId"),
    "files",
    `${safeSegment(input.fileId, "fileId")}.${safeSegment(input.extension, "extension")}`,
  ].join("/");
  return validateStorageKey(key);
}

export interface AudioGenerationKeyInput {
  scope: string;
  projectId: string;
  sceneId: string;
  generationId: string;
  extension: string;
}

export function buildAudioGenerationKey(input: AudioGenerationKeyInput): string {
  const key = [
    safeSegment(input.scope.split("/")[0], "scope"),
    safeSegment(input.scope.split("/")[1], "scope id"),
    "projects",
    safeSegment(input.projectId, "projectId"),
    "audio",
    "scenes",
    safeSegment(input.sceneId, "sceneId"),
    "generations",
    `${safeSegment(input.generationId, "generationId")}.${safeSegment(input.extension, "extension")}`,
  ].join("/");
  return validateStorageKey(key);
}

export interface AudioExportKeyInput {
  scope: string;
  audioProjectId: string;
  exportId: string;
  extension: string;
}

export function buildAudioExportKey(input: AudioExportKeyInput): string {
  const key = [
    safeSegment(input.scope.split("/")[0], "scope"),
    safeSegment(input.scope.split("/")[1], "scope id"),
    "projects",
    safeSegment(input.audioProjectId, "audioProjectId"),
    "audio",
    "exports",
    `${safeSegment(input.exportId, "exportId")}.${safeSegment(input.extension, "extension")}`,
  ].join("/");
  return validateStorageKey(key);
}

export interface InvoicePdfKeyInput {
  invoiceId: string;
}

export function buildInvoicePdfKey(input: InvoicePdfKeyInput): string {
  // Invoices are platform-billing artifacts, not per-project content — no
  // owner scope segment needed, they're always looked up by invoiceId.
  const key = ["invoices", `${safeSegment(input.invoiceId, "invoiceId")}.pdf`].join("/");
  return validateStorageKey(key);
}
