import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Provider secrets are read only from backend deployment configuration. */
@Injectable()
export class ProviderCredentialsService {
	constructor(private readonly config: ConfigService) {}

	async primary(provider: string): Promise<string> {
		if (!['gemini', 'openai'].includes(provider)) throw new BadRequestException('Unsupported provider');
		const name = provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
		const key = this.config.get<string>(name)?.trim();
		if (!key)
			throw Object.assign(new ServiceUnavailableException('No ' + provider + ' API key is configured.'), {
				nonRetryable: true
			});
		return key;
	}
}
