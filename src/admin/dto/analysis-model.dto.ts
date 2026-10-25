import { Matches, ValidateIf } from 'class-validator';
export class UpdateAnalysisModelDto {
	@ValidateIf((_object, value) => value !== null)
	@Matches(/^[a-z0-9][a-z0-9._-]{0,119}$/, {
		message:
			'Enter a Gemini model ID using lowercase letters, numbers, dots, underscores or hyphens (maximum 120 characters).'
	})
	model!: string | null;
}
