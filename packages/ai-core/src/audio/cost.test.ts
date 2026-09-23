import { describe, it, expect } from "vitest";
import { estimateCharacterBasedCost, USD_PER_CREDIT, type AiModelLookup } from "./cost";
import { ModelNotFoundError } from "./errors";

// Fake AiModelLookup — stands in for the AiModel table (costPerUnit is USD
// per character, seeded in packages/database/prisma/seed.ts) so this test
// never needs a real Prisma client.
function fakeLookup(costPerUnit: number | null): AiModelLookup {
  return {
    async findModel() {
      return costPerUnit === null ? null : { costPerUnit };
    },
  };
}

describe("estimateCharacterBasedCost", () => {
  it("throws ModelNotFoundError when the lookup returns null", async () => {
    await expect(
      estimateCharacterBasedCost("elevenlabs", "does_not_exist", 100, fakeLookup(null)),
    ).rejects.toThrow(ModelNotFoundError);
  });

  it("computes providerCostUsd as costPerUnit * characterCount", async () => {
    // eleven_flash_v2's seeded costPerUnit is 0.00003 USD/char.
    const result = await estimateCharacterBasedCost("elevenlabs", "eleven_flash_v2", 1000, fakeLookup(0.00003));
    expect(result.providerCostUsd).toBeCloseTo(0.03, 6);
  });

  it("rounds credits up to the nearest whole credit (ceil, never under-charge)", async () => {
    // 1000 chars * 0.00003 USD/char = 0.03 USD; at USD_PER_CREDIT = 0.001,
    // that's 30 credits exactly — pick a case that doesn't land on a whole
    // number to prove ceil() is actually being applied.
    const result = await estimateCharacterBasedCost("elevenlabs", "eleven_flash_v2", 1234, fakeLookup(0.00003));
    const exact = (0.00003 * 1234) / USD_PER_CREDIT; // 37.02
    expect(result.credits).toBe(Math.ceil(exact));
    expect(result.credits).toBeGreaterThan(exact - 1);
  });

  it("never charges 0 credits, even for a free/mock model (costPerUnit 0)", async () => {
    // mock_v1's seeded costPerUnit is exactly 0 — the Math.max(1, ...) floor
    // exists specifically so a "free" model still consumes at least 1
    // credit, rather than letting a job cost nothing at all.
    const result = await estimateCharacterBasedCost("mock_audio", "mock_v1", 500, fakeLookup(0));
    expect(result.providerCostUsd).toBe(0);
    expect(result.credits).toBe(1);
  });

  it("never charges 0 credits for a tiny amount of real cost either", async () => {
    // A single character at a tiny per-char cost rounds to well under 1
    // credit's worth of USD — the floor still guarantees at least 1.
    const result = await estimateCharacterBasedCost("elevenlabs", "eleven_flash_v2", 1, fakeLookup(0.00003));
    expect(result.credits).toBe(1);
  });
});
