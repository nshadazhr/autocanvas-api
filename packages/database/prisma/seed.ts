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

  // ── Voice Profiles matching apps/web's dummy VOICE_CATALOG by name ──────
  // audio.service.ts's resolveVoiceProfileByName() looks up a VoiceProfile
  // by exact `name`. The Scenes table's Voice dropdown and "Apply Voice to
  // Speaker" modal (apps/web's project-workspace.tsx) are still hardcoded
  // against lib/dummy-data.ts's VOICE_CATALOG — that client component is
  // intentionally NOT being changed as part of this pilot, so every one of
  // those 7 names needs a real VoiceProfile row here or picking a voice
  // from the UI 400s with "was not found". Pointed at the mock provider
  // (not ElevenLabs) so local testing works without a real API key —
  // characters run through mock_v1 return a silent clip instantly, same as
  // the two system voices above.
  const catalogVoices: { id: string; name: string; gender: "male" | "female" }[] = [
    { id: "00000000-0000-0000-0000-000000000003", name: "Zephyr - Bright", gender: "female" },
    { id: "00000000-0000-0000-0000-000000000004", name: "Achird - Friendly", gender: "male" },
    { id: "00000000-0000-0000-0000-000000000005", name: "Sadaltager - Knc", gender: "male" },
    { id: "00000000-0000-0000-0000-000000000006", name: "Orus - Firm", gender: "male" },
    { id: "00000000-0000-0000-0000-000000000007", name: "Algenib - Gravell", gender: "male" },
    { id: "00000000-0000-0000-0000-000000000008", name: "Aoede - Warm", gender: "female" },
    { id: "00000000-0000-0000-0000-000000000009", name: "Callirrhoe - Energetic", gender: "female" },
  ];

  for (const voice of catalogVoices) {
    await prisma.voiceProfile.upsert({
      where: { id: voice.id },
      update: {},
      create: {
        id: voice.id,
        name: voice.name,
        providerId: mockProvider.id,
        providerVoiceId: voice.id,
        language: "en-US",
        gender: voice.gender,
        style: "narration",
        speed: 1.0,
        pitch: 0,
        isSystem: true,
      },
    });
  }

  // ── Demo user + credit account ──────────────────────────────────────────
  // apps/web's dummy Credentials provider (packages/auth/src/config.ts)
  // accepts ANY email/password and always mints a bridge token with
  // `sub: "dummy-user-1"` — that's unchanged by this pilot (only Audio
  // Studio's Server Actions now call this real backend; login itself is
  // still dummy-mode). Every audio.service.ts query scopes by
  // `user.sub`/`ownerId`, and generateSceneAudio/requestExport both require
  // a CreditAccount row to exist for that id — without this seed entry,
  // every real request 400s on "No credit account found for this user."
  // the moment someone logs in and tries to generate audio.
  const demoUser = await prisma.user.upsert({
    where: { id: "dummy-user-1" },
    update: {},
    create: {
      id: "dummy-user-1",
      email: "dummy-user-1@autocanvas.local",
      name: "Demo User",
      role: "USER",
    },
  });

  await prisma.creditAccount.upsert({
    where: { userId: demoUser.id },
    update: {},
    create: {
      userId: demoUser.id,
      // Generous placeholder for local testing — real balances come from
      // a subscription/purchase once Chunk 9's billing flow is wired to a
      // live Stripe/Razorpay account (see the plans loop's comment above).
      balance: 5000,
      reserved: 0,
    },
  });

  console.log(
    "✅ Seed complete: plans, feature flags, AI providers/models, system voices (incl. VOICE_CATALOG matches), demo user + credits.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
