import { IsNotEmpty, IsOptional, IsString } from "class-validator";

export class CreateAudioProjectDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  // Both optional — apps/web's "Create New Audio Project" modal has a
  // voice picker + language field that dummy mode saved directly onto the
  // project. The real AudioProject row has matching `defaultVoiceId`/
  // `language` columns (see schema.prisma), so this DTO just carries the
  // same two values through at creation time instead of dropping them.
  // `voice` is a VoiceProfile *name* (see resolveVoiceProfileByName),
  // exactly like every other "voice" field on this controller's DTOs.
  @IsOptional()
  @IsString()
  voice?: string;

  @IsOptional()
  @IsString()
  language?: string;
}
