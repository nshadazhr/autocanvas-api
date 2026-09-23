/**
 * Pure fallback-resolution helpers. Both take already-fetched, plain data
 * (whatever shape the caller's Prisma query returned) rather than Prisma
 * model types directly — that's what keeps this module DB-free while still
 * encoding the actual fallback *rules* in one tested place instead of
 * being re-implemented ad hoc at each call site (apps/worker's
 * generate_scene_audio handler, and any future admin/debug tooling that
 * wants to preview what a scene would resolve to).
 */

export interface SceneVoiceInput {
  voiceProfileId: string | null;
}

export interface ProjectVoiceDefaults {
  defaultVoiceId: string | null;
}

/**
 * A scene's own `voiceProfileId` wins when set; otherwise it falls back to
 * the parent AudioProject's `defaultVoiceId`. Returns null if neither is
 * set — callers must treat that as "no voice resolved, cannot generate"
 * rather than picking an arbitrary voice.
 */
export function resolveSceneVoiceProfileId(scene: SceneVoiceInput, project: ProjectVoiceDefaults): string | null {
  return scene.voiceProfileId ?? project.defaultVoiceId ?? null;
}

export interface SelectableAiModel {
  id: string;
  isActive: boolean;
}

/**
 * Picks which AiModel to bill/generate against for a given provider, given
 * the provider's models (already scoped to the right provider by the
 * caller's query). AiModel has no "default" flag yet — this is a known,
 * intentionally simple placeholder (see README's Chunk 7 status notes):
 * it takes the first model that is currently active, in whatever order the
 * caller's query returned them (callers should order by something stable,
 * e.g. `createdAt asc`, if they care which "first" means). Returns null if
 * no model for the provider is active, which callers must treat as
 * "cannot generate with this provider right now."
 *
 * Generic over `T extends SelectableAiModel` (rather than fixed to exactly
 * `{id, isActive}`) so callers get back the SAME full row shape they passed
 * in — e.g. apps/worker's generate_scene_audio handler passes real Prisma
 * `AiModel` rows through and still gets a typed `.key` back on the result,
 * not just the two fields this function actually reads.
 */
export function pickActiveModelForProvider<T extends SelectableAiModel>(models: T[]): T | null {
  return models.find((model) => model.isActive) ?? null;
}
