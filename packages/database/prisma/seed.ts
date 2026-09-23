import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // ── Subscription plans ────────────────────────────────────────────────
  // stripePriceId/razorpayPlanId (Chunk 9) are deliberately left unset
  // here — they're real IDs from whoever's Stripe/Razorpay dashboard this
  // deploys against, not something to hardcode into the repo. Backfill
  // them via `pnpm db:studio` (or a follow-up admin-panel field, not built
  // this chunk) once the products/plans exist on the provider side; until
  // then, checkout for "creator"/"pro"/"business" throws
  // PlanNotCheckoutReadyError — see packages/billing/src/errors.ts.
  const plans = [
    { key: "free", name: "Free", monthlyCredits: 100, storageGb: 1, maxTeamMembers: 1, priceCents: 0 },
    { key: "creator", name: "Creator", monthlyCredits: 2000, storageGb: 10, maxTeamMembers: 1, priceCents: 1900 },
    { key: "pro", name: "Pro", monthlyCredits: 8000, storageGb: 50, maxTeamMembers: 3, priceCents: 4900 },
    { key: "business", name: "Business", monthlyCredits: 25000, storageGb: 250, maxTeamMembers: 10, priceCents: 14900 },
    { key: "enterprise", name: "Enterprise", monthlyCredits: 100000, storageGb: 1000, maxTeamMembers: 50, priceCents: 0 },
  ];

  for (const plan of plans) {
    await prisma.subscriptionPlan.upsert({
      where: { key: plan.key },
      update: {},
      create: {
        ...plan,
        currency: "usd",
        features: { models_allowed: ["*"], max_projects: plan.key === "free" ? 3 : -1 },
      },
    });
  }

  // ── Feature flags: only Audio Studio is live at launch ─────────────────
  const flags = [
    { key: "audio_v1", isEnabled: true, description: "Audio Studio — text/CSV to speech" },
    { key: "script_v1", isEnabled: false, description: "Script Studio (Phase 2)" },
    { key: "image_v1", isEnabled: false, description: "Image Studio (Phase 3)" },
    { key: "thumbnail_v1", isEnabled: false, description: "Thumbnail Studio (Phase 3)" },
    { key: "music_v1", isEnabled: false, description: "Music & SFX Studio (Phase 4)" },
    { key: "video_v1", isEnabled: false, description: "Video Studio (Phase 5)" },
    { key: "workflows_v1", isEnabled: false, description: "Workflow Automation (Phase 6)" },
  ];

  for (const flag of flags) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      update: {},
      create: flag,
    });
  }

  // ── AI providers + models (audio) ──────────────────────────────────────
  const elevenlabs = await prisma.aiProvider.upsert({
    where: { key: "elevenlabs" },
    update: {},
    create: { key: "elevenlabs", name: "ElevenLabs", module: "audio", isActive: true, config: {} },
  });

  const mockProvider = await prisma.aiProvider.upsert({
    where: { key: "mock_audio" },
    update: {},
    create: { key: "mock_audio", name: "Mock Audio Provider (dev/test)", module: "audio", isActive: true, config: {} },
  });

  await prisma.aiModel.upsert({
    where: { providerId_key: { providerId: elevenlabs.id, key: "eleven_flash_v2" } },
    update: {},
    create: {
      providerId: elevenlabs.id,
      key: "eleven_flash_v2",
      name: "Eleven Flash v2",
      capabilities: { languages: ["en", "hi", "es"], emotion: true, speed: true },
      costPerUnit: 0.00003, // illustrative $ per character
      isActive: true,
    },
  });

  await prisma.aiModel.upsert({
    where: { providerId_key: { providerId: mockProvider.id, key: "mock_v1" } },
    update: {},
    create: {
      providerId: mockProvider.id,
      key: "mock_v1",
      name: "Mock Model (returns a silent clip instantly)",
      capabilities: { languages: ["*"] },
      costPerUnit: 0,
      isActive: true,
    },
  });

  // ── A couple of system voice profiles, reusable by every user ──────────
  await prisma.voiceProfile.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      name: "Narrator",
      providerId: elevenlabs.id,
      providerVoiceId: "alloy",
      language: "en-US",
      gender: "male",
      style: "narration",
      speed: 1.0,
      pitch: 0,
      isSystem: true,
    },
  });

  await prisma.voiceProfile.upsert({
    where: { id: "00000000-0000-0000-0000-000000000002" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000002",
      name: "Villain",
      providerId: elevenlabs.id,
      providerVoiceId: "onyx",
      language: "en-US",
      gender: "male",
      style: "dramatic",
      speed: 0.9,
      pitch: -2,
      isSystem: true,
    },
  });

  console.log("✅ Seed complete: plans, feature flags, AI providers/models, system voices.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
