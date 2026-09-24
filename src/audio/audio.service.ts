import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma, Prisma } from "@platform/database";
import { requireAuthorized, ForbiddenError } from "@platform/auth/rbac";
import type { BridgeTokenPayload } from "@platform/auth/bridge-token";
import { enqueueJob } from "@platform/queue";
import { estimateCharacterBasedCost } from "@platform/ai-core";
import { getDownloadUrl } from "@platform/storage";
import {
  parseSceneRowsFromCsv,
  resolveSceneVoiceProfileId,
  pickActiveModelForProvider,
  validateMergeSelection,
  describeMergeValidationErrors,
  type MergeableScene,
  type SceneStatus,
} from "@modules/audio";
import type { SceneUpdateEntryDto } from "./dto/bulk-update-scenes.dto";

// ─────────────────────────────────────────────────────────────────────────
// This is a direct port of apps/web/app/(app)/audio/actions.ts's business
// logic into the pilot NestJS backend (see README's "Chunk 10" write-up for
// the full reasoning). Three real differences from the Server Actions
// version, everywhere they show up below:
//
//   1. No `session` from `auth()` — callers pass the already-verified
//      `BridgeTokenPayload` from the bridge token instead (see
//      packages/auth/src/bridge-token.ts + ../auth/bridge-auth.guard.ts).
//   2. No `redirect()` / `revalidatePath()` — those are Next.js rendering
//      concerns. This service just returns data or throws; apps/web's own
//      thin API-client wrapper (apps/web/app/(app)/audio/actions.ts) is
//      what still calls redirect/revalidatePath, same as before, after a
//      successful HTTP response comes back.
//   3. Failures throw real HTTP exceptions (Nest maps these to proper
//      status codes) instead of returning an `{ ok: false }` value — the
//      API-client wrapper on the web side is what translates a caught
//      exception back into the `ActionResult` shape action-forms.tsx
//      already expects, so that file needs no changes at all.
//
// The actual domain logic (RBAC checks via `authorize`/`requireAuthorized`,
// CSV parsing, voice/model resolution, merge validation, credit
// reservation via enqueueJob) is untouched — still the same calls into the
// same shared packages, just running in this process instead of apps/web's.
// ─────────────────────────────────────────────────────────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  audioProject: { id: string; _count: { scenes: number } } | null;
}

export interface ImportScenesResult {
  imported: number;
  rowErrors: string[];
}

interface AiModelRow {
  id: string;
  key: string;
  isActive: boolean;
}

interface AudioSceneSummaryRow {
  id: string;
  orderIndex: number;
  status: SceneStatus;
  sceneNumber: number;
  title: string | null;
}

interface VoiceProfileRow {
  id: string;
  name: string;
}

/**
 * Real shape of `loadAudioProjectOrThrow`'s query. Given explicitly (rather
 * than left as Prisma's inferred payload type) for the same reason every
 * `*Row` interface in this file exists — see apps/web's old actions.ts (now
 * apps/web/lib/backend-client.ts's sibling on the web side) for the
 * precedent: this sandbox's Prisma client ships without a real generated
 * client (see README), so every DB call resolves to `any` here, and an
 * un-annotated `any` occasionally defeats strict-mode inference on chained
 * `.map`/`.filter` calls downstream. Typing the query's return shape once,
 * here, fixes that at the source instead of casting at every call site.
 */
interface AudioProjectRow {
  id: string;
  projectId: string;
  project: { id: string; name: string; ownerId: string };
  scenes: AudioSceneSummaryRow[];
}

/** Prisma's own shape for a caught `PrismaClientKnownRequestError` — just the one field this file actually reads off it. */
interface PrismaKnownRequestErrorLike {
  code?: string;
}

@Injectable()
export class AudioService {
  /** Every not-found Prisma lookup below funnels through here so a bad id is a clean 404, not a 500. */
  private notFound(): never {
    throw new NotFoundException("Audio project not found.");
  }

  /** Translates `@platform/auth`'s thrown ForbiddenError into a NestJS 403. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      if (err instanceof ForbiddenError) {
        throw new ForbiddenException(err.message);
      }
      throw err;
    }
  }

  /**
   * Resolves a VoiceProfile *name* (what apps/web's Scenes table and its
   * dummy-mode VOICE_CATALOG both call "voice") to a real VoiceProfile id,
   * scoped to voices the caller can actually use (their own + system
   * voices) — same scoping importScenesFromCsv already uses above. Throws
   * a clear 400 instead of silently leaving a scene voiceless when the
   * name doesn't match any real voice (e.g. a name from the dummy-mode
   * VOICE_CATALOG that hasn't been created as a VoiceProfile row yet).
   */
  private async resolveVoiceProfileByName(user: BridgeTokenPayload, voiceName: string): Promise<string> {
    const voice = (await prisma.voiceProfile.findFirst({
      where: { name: voiceName, OR: [{ ownerId: user.sub }, { isSystem: true }] },
      select: { id: true },
    })) as { id: string } | null;
    if (!voice) {
      throw new BadRequestException(
        `Voice "${voiceName}" was not found — add it as a Voice Profile first, or pick an existing one.`,
      );
    }
    return voice.id;
  }

  private async loadAudioProjectOrThrow(audioProjectId: string): Promise<AudioProjectRow> {
    try {
      return (await prisma.audioProject.findUniqueOrThrow({
        where: { id: audioProjectId },
        include: {
          project: true,
          scenes: { orderBy: { orderIndex: "asc" } },
          exports: { orderBy: { createdAt: "desc" } },
        },
      })) as AudioProjectRow;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && (err as PrismaKnownRequestErrorLike).code === "P2025") {
        this.notFound();
      }
      throw err;
    }
  }

  async listAudioProjects(user: BridgeTokenPayload): Promise<ProjectSummary[]> {
    const projects = await prisma.project.findMany({
      where: { ownerId: user.sub, type: "AUDIO", deletedAt: null },
      include: { audioProject: { include: { _count: { select: { scenes: true } } } } },
      orderBy: { updatedAt: "desc" },
    });
    return projects as unknown as ProjectSummary[];
  }

  async createAudioProject(
    user: BridgeTokenPayload,
    name: string,
    voice?: string,
    language?: string,
  ): Promise<{ audioProjectId: string }> {
    this.guard(() => requireAuthorized({ platformRole: user.role, isResourceOwner: true }, "project:create"));

    const trimmed = name.trim();
    if (!trimmed) {
      throw new BadRequestException("Project name is required.");
    }

    // `voice` names a VoiceProfile the same way it does everywhere else on
    // this service — resolved up front so a bad name 400s before any row
    // is written, instead of leaving a half-created project behind.
    const defaultVoiceId = voice ? await this.resolveVoiceProfileByName(user, voice) : undefined;

    const project = await prisma.project.create({
      data: {
        ownerId: user.sub,
        type: "AUDIO",
        name: trimmed,
        status: "DRAFT",
        audioProject: {
          create: {
            ...(defaultVoiceId ? { defaultVoiceId } : {}),
            ...(language ? { language } : {}),
          },
        },
      },
      include: { audioProject: true },
    });

    return { audioProjectId: project.audioProject!.id };
  }

  async getAudioProjectDetail(user: BridgeTokenPayload, audioProjectId: string) {
    let audioProject;
    try {
      audioProject = await prisma.audioProject.findUniqueOrThrow({
        where: { id: audioProjectId },
        include: {
          project: true,
          // apps/web's Scenes table shows a Voice/Gender cell per scene and
          // needs the project's fallback voice too (see
          // resolveSceneVoiceProfileId) — both relations are included here
          // so lib/backend-client.ts's mapping layer never needs a second
          // round trip just to resolve a display name.
          defaultVoice: true,
          exports: { orderBy: { createdAt: "desc" } },
          scenes: {
            orderBy: { orderIndex: "asc" },
            include: {
              voiceProfile: true,
              generations: { orderBy: { createdAt: "desc" }, take: 1 },
            },
          },
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && (err as PrismaKnownRequestErrorLike).code === "P2025") {
        this.notFound();
      }
      throw err;
    }

    this.guard(() =>
      requireAuthorized(
        { platformRole: user.role, isResourceOwner: audioProject.project.ownerId === user.sub },
        "project:read",
      ),
    );
    return audioProject;
  }

  async addScene(user: BridgeTokenPayload, audioProjectId: string, text: string, title?: string) {
    const audioProject = await this.loadAudioProjectOrThrow(audioProjectId);
    this.guard(() =>
      requireAuthorized(
        { platformRole: user.role, isResourceOwner: audioProject.project.ownerId === user.sub },
        "project:update",
      ),
    );

    const trimmedText = text.trim();
    if (!trimmedText) {
      throw new BadRequestException("Scene text cannot be empty.");
    }
    const trimmedTitle = title?.trim() || null;

    const nextOrderIndex = audioProject.scenes.length;
    await prisma.audioScene.create({
      data: {
        audioProjectId,
        sceneNumber: nextOrderIndex + 1,
        orderIndex: nextOrderIndex,
        title: trimmedTitle,
        text: trimmedText,
        status: "PENDING",
      },
    });
  }

  async deleteScene(user: BridgeTokenPayload, audioProjectId: string, sceneId: string): Promise<void> {
    const audioProject = await this.loadAudioProjectOrThrow(audioProjectId);
    this.guard(() =>
      requireAuthorized(
        { platformRole: user.role, isResourceOwner: audioProject.project.ownerId === user.sub },
        "project:update",
      ),
    );

    await prisma.audioScene.delete({ where: { id: sceneId } });
  }

  async importScenesFromCsv(
    user: BridgeTokenPayload,
    audioProjectId: string,
    csvText: string,
  ): Promise<ImportScenesResult> {
    const audioProject = await this.loadAudioProjectOrThrow(audioProjectId);
    this.guard(() =>
      requireAuthorized(
        { platformRole: user.role, isResourceOwner: audioProject.project.ownerId === user.sub },
        "project:update",
      ),
    );

    let parsed;
    try {
      parsed = parseSceneRowsFromCsv(csvText);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : "Failed to parse CSV.");
    }

    if (parsed.rows.length === 0) {
      throw new BadRequestException("No importable rows found in this CSV.");
    }

    const voiceNames = Array.from(
      new Set(parsed.rows.map((row) => row.voiceName).filter((name): name is string => Boolean(name))),
    );
    const voiceProfiles = (voiceNames.length
      ? await prisma.voiceProfile.findMany({
          where: { name: { in: voiceNames }, OR: [{ ownerId: user.sub }, { isSystem: true }] },
        })
      : []) as VoiceProfileRow[];
    const voiceIdByName = new Map(voiceProfiles.map((v) => [v.name, v.id]));

    let nextOrderIndex = audioProject.scenes.length;
    let imported = 0;
    for (const row of parsed.rows) {
      await prisma.audioScene.create({
        data: {
          audioProjectId,
          sceneNumber: row.sceneNumber ?? nextOrderIndex + 1,
          orderIndex: nextOrderIndex,
          title: row.title ?? null,
          text: row.text,
          voiceProfileId: row.voiceName ? voiceIdByName.get(row.voiceName) ?? null : null,
          character: row.character ?? null,
          style: row.style ?? null,
          emotion: row.emotion ?? null,
          language: row.language ?? null,
          targetDuration: row.targetDuration ?? null,
          status: "PENDING",
        },
      });
      nextOrderIndex += 1;
      imported += 1;
    }

    return { imported, rowErrors: parsed.errors.map((e) => `Row ${e.rowNumber}: ${e.message}`) };
  }

  /**
   * Updates zero or more scene fields per entry, mirroring apps/web's dummy
   * `bulkUpdateScenes` (Scenes table's "Save Changes"). Two real-schema
   * differences from that dummy version, both because AudioScene has no
   * speed/pitch/gender columns of its own — those live on VoiceProfile (see
   * apply-voice.dto.ts's header comment):
   *   1. `speaker` maps to the real `character` column.
   *   2. `voice` (a VoiceProfile *name*) resolves to `voiceProfileId` via
   *      resolveVoiceProfileByName; `gender`/`speed`/`pitch` in the same
   *      entry are NOT written anywhere — they're derived, read-only
   *      display values that come from whichever VoiceProfile a scene
   *      resolves to, not independent per-scene overrides. (apps/web's
   *      mapping layer in lib/backend-client.ts should stop rendering these
   *      as editable once a project is backend-backed, to avoid a silent
   *      no-op in the UI.)
   */
  async bulkUpdateScenes(
    user: BridgeTokenPayload,
    audioProjectId: string,
    updates: SceneUpdateEntryDto[],
  ): Promise<void> {
    const audioProject = await this.loadAudioProjectOrThrow(audioProjectId);
    this.guard(() =>
      requireAuthorized(
        { platformRole: user.role, isResourceOwner: audioProject.project.ownerId === user.sub },
        "project:update",
      ),
    );

    const sceneIds = new Set((audioProject.scenes as AudioSceneSummaryRow[]).map((s) => s.id));

    for (const update of updates) {
      if (!sceneIds.has(update.id)) {
        throw new BadRequestException(`Scene "${update.id}" does not belong to this project.`);
      }

      // Hand-typed (not `Prisma.AudioSceneUpdateInput`) for the same reason
      // every `*Row` interface up top is — see AudioProjectRow's comment.
      const data: Record<string, unknown> = {};
      if (update.title !== undefined) data.title = update.title;
      if (update.text !== undefined) data.text = update.text;
      if (update.speaker !== undefined) data.character = update.speaker;
      if (update.style !== undefined) data.style = update.style;
      if (update.emotion !== undefined) data.emotion = update.emotion;
      if (update.voice !== undefined) {
        data.voiceProfileId = update.voice ? await this.resolveVoiceProfileByName(user, update.voice) : null;
      }
      // gender/speed/pitch intentionally not persisted here — see method doc.

      if (Object.keys(data).length > 0) {
        await prisma.audioScene.update({ where: { id: update.id }, data });
      }
    }
  }

  /**
   * Applies one voice (by name) + gender to every scene whose `character`
   * (apps/web's "speaker") matches, mirroring the dummy
   * `applyVoiceToSpeaker` bulk action. `gender` is accepted (matching the
   * dummy signature apps/web already calls this with) but not persisted,
   * for the same reason bulkUpdateScenes doesn't persist it above — it's
   * intrinsic to the resolved VoiceProfile, not an independent scene
   * attribute in the real schema.
   */
  async applyVoiceToSpeaker(
    user: BridgeTokenPayload,
    audioProjectId: string,
    speaker: string,
    voice: string,
    _gender: "Male" | "Female",
  ): Promise<{ affected: number }> {
    const audioProject = await this.loadAudioProjectOrThrow(audioProjectId);
    this.guard(() =>
      requireAuthorized(
        { platformRole: user.role, isResourceOwner: audioProject.project.ownerId === user.sub },
        "project:update",
      ),
    );

    const voiceProfileId = await this.resolveVoiceProfileByName(user, voice);
    const result = await prisma.audioScene.updateMany({
      where: { audioProjectId, character: speaker },
      data: { voiceProfileId },
    });
    return { affected: result.count };
  }

  /**
   * Reverts selected scenes to PENDING, mirroring the dummy
   * `resetScenesToPending` bulk action ("Reset Selected to Pending"). Dummy
   * mode nulled the scene's own `storageKey` directly; the real schema
   * keeps storage keys on historical `AudioGeneration` rows instead (a
   * scene can have several, one per generation job), so there's nothing to
   * null on the scene itself — reverting `status` to PENDING is what makes
   * the Scenes table stop showing a playable link (its "latest generation"
   * lookup is status-gated the same way generateAllPendingScenes' own
   * PENDING/FAILED filter is). Past AudioGeneration rows are left alone as
   * history rather than deleted.
   */
  async resetScenesToPending(
    user: BridgeTokenPayload,
    audioProjectId: string,
    sceneIds: string[],
  ): Promise<{ affected: number }> {
    const audioProject = await this.loadAudioProjectOrThrow(audioProjectId);
    this.guard(() =>
      requireAuthorized(
        { platformRole: user.role, isResourceOwner: audioProject.project.ownerId === user.sub },
        "project:update",
      ),
    );

    const validIds = new Set((audioProject.scenes as AudioSceneSummaryRow[]).map((s) => s.id));
    const targetIds = sceneIds.filter((id) => validIds.has(id));
    if (targetIds.length === 0) {
      throw new BadRequestException("None of the selected scenes belong to this project.");
    }

    const result = await prisma.audioScene.updateMany({
      where: { audioProjectId, id: { in: targetIds } },
      data: { status: "PENDING" },
    });
    return { affected: result.count };
  }

  private async planGeneration(sceneId: string) {
    let scene;
    try {
      scene = await prisma.audioScene.findUniqueOrThrow({
        where: { id: sceneId },
        include: { audioProject: { include: { project: true } } },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && (err as PrismaKnownRequestErrorLike).code === "P2025") {
        this.notFound();
      }
      throw err;
    }

    const voiceProfileId = resolveSceneVoiceProfileId(
      { voiceProfileId: scene.voiceProfileId },
      { defaultVoiceId: scene.audioProject.defaultVoiceId },
    );
    if (!voiceProfileId) {
      throw new BadRequestException(
        `Scene "${scene.title ?? scene.id}" has no voice set and the project has no default voice.`,
      );
    }

    const voiceProfile = await prisma.voiceProfile.findUniqueOrThrow({ where: { id: voiceProfileId } });
    const models = (await prisma.aiModel.findMany({
      where: { providerId: voiceProfile.providerId },
      orderBy: { key: "asc" },
    })) as AiModelRow[];
    const model = pickActiveModelForProvider(models);
    if (!model) {
      throw new BadRequestException("No active AI model is configured for this scene's voice provider.");
    }
    const provider = await prisma.aiProvider.findUniqueOrThrow({ where: { id: voiceProfile.providerId } });
    const estimate = await estimateCharacterBasedCost(provider.key, model.key, scene.text.length);

    return { scene, provider, model, estimate };
  }

  async generateSceneAudio(user: BridgeTokenPayload, sceneId: string): Promise<{ audioProjectId: string }> {
    const plan = await this.planGeneration(sceneId);
    const { scene } = plan;

    this.guard(() =>
      requireAuthorized(
        { platformRole: user.role, isResourceOwner: scene.audioProject.project.ownerId === user.sub },
        "generation:trigger",
      ),
    );

    const creditAccount = await prisma.creditAccount.findUnique({ where: { userId: user.sub } });
    if (!creditAccount) {
      throw new BadRequestException("No credit account found for this user.");
    }

    try {
      await enqueueJob({
        userId: user.sub,
        projectId: scene.audioProject.projectId,
        creditAccountId: creditAccount.id,
        module: "audio",
        jobType: "generate_scene_audio",
        payload: { sceneId },
        creditsToReserve: plan.estimate.credits,
        provider: plan.provider.key,
        model: plan.model.key,
      });
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : "Failed to queue generation.");
    }

    await prisma.audioScene.update({ where: { id: sceneId }, data: { status: "QUEUED" } });
    // Handed back so apps/web's api-client wrapper can revalidate the right
    // detail page without needing its own DB read just to learn this id
    // (see generateSceneAudioFormAction's binding in action-forms.tsx — it
    // only ever has `sceneId`, not `audioProjectId`, at the call site).
    return { audioProjectId: scene.audioProjectId };
  }

  /** Sequential on purpose — see enqueueJob's own comment on why credit reservation shouldn't race itself. */
  async generateAllPendingScenes(
    user: BridgeTokenPayload,
    audioProjectId: string,
  ): Promise<{ queued: number; failures: string[] }> {
    const audioProject = await this.loadAudioProjectOrThrow(audioProjectId);
    const eligible = (audioProject.scenes as AudioSceneSummaryRow[]).filter(
      (s) => s.status === "PENDING" || s.status === "FAILED",
    );

    const failures: string[] = [];
    let queued = 0;
    for (const scene of eligible) {
      try {
        await this.generateSceneAudio(user, scene.id);
        queued += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to queue generation.";
        failures.push(`Scene "${scene.title ?? scene.sceneNumber}": ${message}`);
      }
    }

    return { queued, failures };
  }

  async requestExport(
    user: BridgeTokenPayload,
    audioProjectId: string,
    sceneIds: string[],
    type: "CHUNK" | "MERGED",
  ): Promise<void> {
    const audioProject = await this.loadAudioProjectOrThrow(audioProjectId);
    this.guard(() =>
      requireAuthorized(
        { platformRole: user.role, isResourceOwner: audioProject.project.ownerId === user.sub },
        "project:export",
      ),
    );

    const availableScenes: MergeableScene[] = audioProject.scenes.map((scene) => ({
      id: scene.id,
      orderIndex: scene.orderIndex,
      status: scene.status as SceneStatus,
    }));
    const validation = validateMergeSelection({ availableScenes, selectedSceneIds: sceneIds });
    if (!validation.ok) {
      throw new BadRequestException(describeMergeValidationErrors(validation.errors));
    }

    const creditAccount = await prisma.creditAccount.findUnique({ where: { userId: user.sub } });
    if (!creditAccount) {
      throw new BadRequestException("No credit account found for this user.");
    }

    try {
      await enqueueJob({
        userId: user.sub,
        projectId: audioProject.projectId,
        creditAccountId: creditAccount.id,
        module: "audio",
        jobType: "merge_export",
        // Merging is local ffmpeg re-encoding of audio the user already
        // generated (and already paid credits for) — no additional cost.
        creditsToReserve: 0,
        payload: { audioProjectId, sceneIds: validation.orderedSceneIds, type },
      });
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : "Failed to queue export.");
    }
  }

  async getSignedAudioUrl(_user: BridgeTokenPayload, storageKey: string): Promise<string> {
    // Any signed-in user reaching this endpoint already had the containing
    // audioProject's ownership verified by the page that rendered the
    // link — same trust boundary the original Server Action relied on.
    const result = await getDownloadUrl({ key: storageKey });
    return result.url;
  }
}
