import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { BridgeAuthGuard } from "../auth/bridge-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { BridgeTokenPayload } from "@platform/auth/bridge-token";
import { AudioService } from "./audio.service";
import { CreateAudioProjectDto } from "./dto/create-audio-project.dto";
import { AddSceneDto } from "./dto/add-scene.dto";
import { ImportScenesDto } from "./dto/import-scenes.dto";
import { RequestExportDto } from "./dto/request-export.dto";
import { SignedUrlQueryDto } from "./dto/signed-url-query.dto";

// One REST endpoint per Server Action in the pre-Chunk-10
// apps/web/app/(app)/audio/actions.ts — see audio.service.ts's top comment
// for the three mechanical differences (no session/redirect/ActionResult
// here; that glue now lives in apps/web's api-client wrapper instead).
@Controller("audio")
@UseGuards(BridgeAuthGuard)
export class AudioController {
  constructor(private readonly audioService: AudioService) {}

  @Get("projects")
  listProjects(@CurrentUser() user: BridgeTokenPayload) {
    return this.audioService.listAudioProjects(user);
  }

  @Post("projects")
  createProject(@CurrentUser() user: BridgeTokenPayload, @Body() dto: CreateAudioProjectDto) {
    return this.audioService.createAudioProject(user, dto.name);
  }

  @Get("projects/:audioProjectId")
  getProjectDetail(@CurrentUser() user: BridgeTokenPayload, @Param("audioProjectId") audioProjectId: string) {
    return this.audioService.getAudioProjectDetail(user, audioProjectId);
  }

  @Post("projects/:audioProjectId/scenes")
  async addScene(
    @CurrentUser() user: BridgeTokenPayload,
    @Param("audioProjectId") audioProjectId: string,
    @Body() dto: AddSceneDto,
  ) {
    await this.audioService.addScene(user, audioProjectId, dto.text, dto.title);
    return { ok: true };
  }

  @Delete("projects/:audioProjectId/scenes/:sceneId")
  async deleteScene(
    @CurrentUser() user: BridgeTokenPayload,
    @Param("audioProjectId") audioProjectId: string,
    @Param("sceneId") sceneId: string,
  ) {
    await this.audioService.deleteScene(user, audioProjectId, sceneId);
    return { ok: true };
  }

  @Post("projects/:audioProjectId/scenes/import")
  importScenes(
    @CurrentUser() user: BridgeTokenPayload,
    @Param("audioProjectId") audioProjectId: string,
    @Body() dto: ImportScenesDto,
  ) {
    return this.audioService.importScenesFromCsv(user, audioProjectId, dto.csvText);
  }

  @Post("scenes/:sceneId/generate")
  async generateScene(@CurrentUser() user: BridgeTokenPayload, @Param("sceneId") sceneId: string) {
    const { audioProjectId } = await this.audioService.generateSceneAudio(user, sceneId);
    return { ok: true, audioProjectId };
  }

  @Post("projects/:audioProjectId/generate-all")
  generateAllPending(@CurrentUser() user: BridgeTokenPayload, @Param("audioProjectId") audioProjectId: string) {
    return this.audioService.generateAllPendingScenes(user, audioProjectId);
  }

  @Post("projects/:audioProjectId/export")
  async requestExport(
    @CurrentUser() user: BridgeTokenPayload,
    @Param("audioProjectId") audioProjectId: string,
    @Body() dto: RequestExportDto,
  ) {
    await this.audioService.requestExport(user, audioProjectId, dto.sceneIds, dto.type);
    return { ok: true };
  }

  @Get("signed-url")
  async getSignedUrl(@CurrentUser() user: BridgeTokenPayload, @Query() query: SignedUrlQueryDto) {
    const url = await this.audioService.getSignedAudioUrl(user, query.key);
    return { url };
  }
}
