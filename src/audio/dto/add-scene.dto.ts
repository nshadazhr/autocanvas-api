import { IsNotEmpty, IsOptional, IsString } from "class-validator";

export class AddSceneDto {
  @IsString()
  @IsNotEmpty()
  text!: string;

  @IsOptional()
  @IsString()
  title?: string;
}
