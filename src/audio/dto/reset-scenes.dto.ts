import { ArrayNotEmpty, IsArray, IsString } from "class-validator";

export class ResetScenesDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  sceneIds!: string[];
}
