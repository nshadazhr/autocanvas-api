import { Type } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";

// Mirrors apps/web's `SceneFieldUpdate` (lib/dummy-data.ts) exactly — one
// entry per scene, only the fields the Scenes table actually edited are
// present. `speaker` here is the same concept as AudioScene.character
// (apps/web calls it "speaker", the DB column is named "character" — see
// audio.service.ts's bulkUpdateScenes for the field-name translation).
// `voice` is a VoiceProfile *name* (not an id) for the same reason
// apply-voice.dto.ts's `voice` field is — see that file's comment.
export class SceneUpdateEntryDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsOptional()
  @IsString()
  title?: string | null;

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsString()
  speaker?: string;

  @IsOptional()
  @IsString()
  style?: string;

  @IsOptional()
  @IsString()
  emotion?: string;

  @IsOptional()
  @IsString()
  voice?: string;

  @IsOptional()
  @IsIn(["Male", "Female"])
  gender?: "Male" | "Female";

  @IsOptional()
  @IsNumber()
  speed?: number;

  @IsOptional()
  @IsNumber()
  pitch?: number;
}

export class BulkUpdateScenesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SceneUpdateEntryDto)
  updates!: SceneUpdateEntryDto[];
}
