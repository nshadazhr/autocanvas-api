import { ArrayNotEmpty, IsArray, IsIn, IsString } from "class-validator";

export class RequestExportDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  sceneIds!: string[];

  @IsIn(["CHUNK", "MERGED"])
  type!: "CHUNK" | "MERGED";
}
