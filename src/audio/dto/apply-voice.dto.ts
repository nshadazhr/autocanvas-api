import { IsIn, IsNotEmpty, IsString } from "class-validator";

// `voice` is deliberately a VoiceProfile *name* (e.g. "Narrator"), not an
// id — apps/web's Scenes table only ever dealt in the dummy VOICE_CATALOG's
// free-text labels (see lib/dummy-data.ts's VoiceOption), and keeping that
// contract unchanged here means action-forms.tsx / project-workspace.tsx
// needed zero changes for this pilot. audio.service.ts resolves this name
// to a real VoiceProfile id (scoped to the caller's own profiles + system
// ones) and throws a clear 400 if no such voice exists yet.
export class ApplyVoiceDto {
  @IsString()
  @IsNotEmpty()
  speaker!: string;

  @IsString()
  @IsNotEmpty()
  voice!: string;

  @IsIn(["Male", "Female"])
  gender!: "Male" | "Female";
}
