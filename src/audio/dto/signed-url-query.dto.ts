import { IsNotEmpty, IsString } from "class-validator";

export class SignedUrlQueryDto {
  @IsString()
  @IsNotEmpty()
  key!: string;
}
