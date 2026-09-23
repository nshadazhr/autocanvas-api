import type { SceneStatus } from "./types";

export interface MergeableScene {
  id: string;
  orderIndex: number;
  status: SceneStatus;
}

export type MergeValidationError =
  | { reason: "EMPTY_SELECTION" }
  | { reason: "NOT_FOUND"; sceneId: string }
  | { reason: "NOT_COMPLETED"; sceneId: string; status: SceneStatus };

export type MergeValidationResult =
  | { ok: true; orderedSceneIds: string[] }
  | { ok: false; errors: MergeValidationError[] };

export interface ValidateMergeSelectionInput {
  /** All scenes belonging to the AudioProject, in any order. */
  availableScenes: MergeableScene[];
  /** The scene ids the user picked to include in this export. */
  selectedSceneIds: string[];
}

/**
 * Merge/export readiness check — pure, no DB or ffmpeg involved. Given the
 * project's scenes and which ones the user selected for a CHUNK/MERGED
 * export, verifies every selected id actually exists on the project and is
 * SceneStatus.COMPLETED (a scene that's still PENDING/PROCESSING/FAILED has
 * no generated audio to concatenate), then returns the ids sorted by
 * `orderIndex` — the exact order apps/worker's merge_export handler must
 * feed clips into ffmpeg's concat filter for the exported audio to play
 * back in the order the user arranged scenes in.
 *
 * Duplicate ids in `selectedSceneIds` are silently de-duplicated rather
 * than flagged as an error: checking the same scene twice in a UI
 * multi-select is a harmless no-op from the user's point of view, not a
 * validation failure worth surfacing.
 *
 * Collects ALL problems into `errors` (rather than stopping at the first)
 * so a UI can show the user everything wrong with their selection in one
 * pass instead of a slow back-and-forth of fixing one error at a time.
 */
export function validateMergeSelection(input: ValidateMergeSelectionInput): MergeValidationResult {
  const uniqueSelectedIds = Array.from(new Set(input.selectedSceneIds));

  if (uniqueSelectedIds.length === 0) {
    return { ok: false, errors: [{ reason: "EMPTY_SELECTION" }] };
  }

  const sceneById = new Map(input.availableScenes.map((scene) => [scene.id, scene]));
  const errors: MergeValidationError[] = [];

  for (const sceneId of uniqueSelectedIds) {
    const scene = sceneById.get(sceneId);
    if (!scene) {
      errors.push({ reason: "NOT_FOUND", sceneId });
      continue;
    }
    if (scene.status !== "COMPLETED") {
      errors.push({ reason: "NOT_COMPLETED", sceneId, status: scene.status });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const orderedSceneIds = uniqueSelectedIds
    .map((sceneId) => sceneById.get(sceneId)!)
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((scene) => scene.id);

  return { ok: true, orderedSceneIds };
}

/**
 * Turns a MergeValidationError[] into one human-readable sentence — used
 * by both the apps/web Server Action (to show the user why their export
 * request was rejected before a job is even enqueued) and apps/worker's
 * merge_export handler (to give the Job row's `error` column a useful
 * message instead of a generic "validation failed").
 */
export function describeMergeValidationErrors(errors: MergeValidationError[]): string {
  return errors
    .map((error) => {
      switch (error.reason) {
        case "EMPTY_SELECTION":
          return "no scenes were selected";
        case "NOT_FOUND":
          return `scene ${error.sceneId} does not belong to this project`;
        case "NOT_COMPLETED":
          return `scene ${error.sceneId} is not ready yet (status: ${error.status})`;
        default:
          return "unknown validation error";
      }
    })
    .join("; ");
}
