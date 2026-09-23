import { prisma } from "@platform/database";
import { ModelNotFoundError } from "./errors";
import type { AudioCostEstimate } from "./types";

// ─────────────────────────────────────────────────────────────────────────
// Cost estimation is deliberately DATA, not code: `AiModel.costPerUnit`
// (USD per character, seeded in packages/database/prisma/seed.ts) lives in
// the database specifically so a future admin panel (Chunk 8) can retune
// pricing without a deploy. Nothing about "how much does ElevenLabs's
// eleven_flash_v2 cost per character" should ever be a hard-coded constant
// in this package.
//
// USD_PER_CREDIT, on the other hand, IS a code constant here — it's a
// platform-wide pricing/margin decision (how many credits equal a dollar),
// not something that varies per model. 0.001 (1000 credits = $1) is a
// placeholder the business should tune before launch; changing it belongs
// in one obvious place, which is why it's exported rather than buried.
// ─────────────────────────────────────────────────────────────────────────

export const USD_PER_CREDIT = 0.001;

/** Structural port so this can be unit tested without a generated Prisma client. */
export interface AiModelLookup {
  findModel(providerKey: string, modelKey: string): Promise<{ costPerUnit: number } | null>;
}

export const prismaAiModelLookup: AiModelLookup = {
  async findModel(providerKey, modelKey) {
    const model = await prisma.aiModel.findFirst({
      where: { key: modelKey, provider: { key: providerKey } },
    });
    if (!model) return null;
    // Prisma's Decimal type coerces cleanly through Number() for values in
    // this range (USD per character is always tiny); if that ever stops
    // being safe (very high-precision pricing), swap this for decimal.js
    // arithmetic throughout instead of just at this one boundary.
    return { costPerUnit: Number(model.costPerUnit) };
  },
};

/**
 * Character-count-based cost estimate, shared by every character-billed
 * audio provider (both MockAudioProvider and ElevenLabsProvider delegate
 * their `estimateCost` to this). A future provider billed some other way
 * (e.g. per-second of requested audio) would NOT call this — it would
 * compute its own `AudioCostEstimate` and is still free to do so, since
 * `estimateCost` is part of the AudioProvider interface, not hard-wired to
 * this function.
 */
export async function estimateCharacterBasedCost(
  providerKey: string,
  modelKey: string,
  characterCount: number,
  lookup: AiModelLookup = prismaAiModelLookup,
): Promise<AudioCostEstimate> {
  const model = await lookup.findModel(providerKey, modelKey);
  if (!model) {
    throw new ModelNotFoundError(providerKey, modelKey);
  }

  const providerCostUsd = model.costPerUnit * characterCount;
  const credits = Math.max(1, Math.ceil(providerCostUsd / USD_PER_CREDIT));

  return { credits, providerCostUsd };
}
