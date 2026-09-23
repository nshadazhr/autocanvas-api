import { IsNotEmpty, IsString } from "class-validator";

export class CreateAudioProjectDto {
  @IsString()
  @IsNotEmpty()
  name!: string;
}
