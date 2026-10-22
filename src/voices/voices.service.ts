import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

type GeminiStudioVoice = {
	geminiVoiceName: string;
	indianVoiceName: string;
	gender?: string | null;
	description?: string | null;
};

@Injectable()
export class VoicesService {
	constructor(private readonly prismaService: PrismaService) {}

	async findAll() {
		return this.prismaService.voice.findMany({
			where: { isActive: true },
			select: {
				id: true,
				name: true,
				displayName: true,
				provider: true,
				providerVoiceId: true,
				model: true,
				gender: true,
				description: true,
				previewUrl: true
			},
			orderBy: { name: 'asc' }
		});
	}

	async importGeminiVoices(fetchVoices: () => Promise<GeminiStudioVoice[]>) {
		// Initial import only; never overwrite existing voice IDs or references.
		const existingCount = await this.prismaService.voice.count({
			where: { provider: { in: ['GEMINI', 'GOOGLE'] } }
		});
		if (existingCount > 0) {
			throw new ConflictException('Gemini voices already exist. Initial import is allowed only once.');
		}

		const filteredVoices = await fetchVoices();
		if (filteredVoices.length !== 30) {
			throw new BadRequestException(`Expected 30 voices, received ${filteredVoices.length}`);
		}

		const indianNames = filteredVoices.map(v => v.indianVoiceName?.trim().toLowerCase());
		const geminiNames = filteredVoices.map(v => v.geminiVoiceName?.trim().toLowerCase());
		if (
			indianNames.some(name => !name) ||
			geminiNames.some(name => !name) ||
			new Set(indianNames).size !== 30 ||
			new Set(geminiNames).size !== 30
		) {
			throw new BadRequestException('Missing or duplicate Indian/Gemini voice names found');
		}

		try {
			return await this.prismaService.$transaction(async tx => {
				const existing = await tx.voice.count({
					where: { provider: { in: ['GEMINI', 'GOOGLE'] } }
				});
				if (existing > 0) {
					throw new ConflictException('Gemini voices already imported');
				}

				const voices = await tx.voice.createManyAndReturn({
					data: filteredVoices.map(voice => ({
						name: voice.indianVoiceName.trim(),
						displayName: voice.geminiVoiceName.trim(),
						provider: 'GEMINI',
						providerVoiceId: voice.geminiVoiceName.trim(),
						model: 'gemini-3.1-flash-tts-preview',
						gender: voice.gender ?? null,
						description: voice.description ?? null
					}))
				});

				return {
					message: 'Gemini voices imported successfully',
					importedCount: voices.length,
					voices
				};
			});
		} catch (error: any) {
			if (error?.code === 'P2002') {
				throw new ConflictException('Some Gemini voices already exist');
			}
			throw error;
		}
	}
}
