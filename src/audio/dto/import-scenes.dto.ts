import { IsNotEmpty, IsString } from "class-validator";

export class ImportScenesDto {
  @IsString()
  @IsNotEmpty()
  csvText!: string;
}
