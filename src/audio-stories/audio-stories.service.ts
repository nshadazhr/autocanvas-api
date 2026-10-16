import {
	ConflictException,
	HttpException,
	HttpStatus,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateAudioStoryDto } from './dto/create-audio-story.dto.js';
import { UpdateAudioStoryDto } from './dto/update-audio-story.dto.js';
import { AudioStoryAnalysisService } from './audio-story-analysis.service.js';
import { StoryParserService } from './services/story-parser.service.js';
import { UnprocessableEntityException } from '@nestjs/common';
import { StoryAnalysisValidatorService } from './services/story-analysis-validator.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { randomUUID } from 'node:crypto';
import { StoryAnalysisSchema, type StoryAnalysisResult } from '../ai/schemas/story-analysis.schema.js';
import { BadRequestException } from '@nestjs/common';
import { UpdateStoryCastDto } from './dto/update-story-cast.dto.js';
@Injectable()
export class AudioStoriesService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly audioStoryAnalysisService: AudioStoryAnalysisService,
		private readonly storyParserService: StoryParserService,
		private readonly storyAnalysisValidator: StoryAnalysisValidatorService
	) {}

	async create(userId: number, dto: CreateAudioStoryDto) {
		return this.prisma.audioStory.create({
			data: {
				title: dto.title,
				content: dto.content,
				userId
			}
		});
	}

	async findAll(userId: number) {
		return this.prisma.audioStory.findMany({
			where: {
				userId
			},
			orderBy: {
				created_at: 'desc'
			}
		});
	}

	async findOne(id: number, userId: number) {
		const story = await this.prisma.audioStory.findFirst({
			where: {
				id,
				userId
			}
		});

		if (!story) {
			throw new NotFoundException('Audio story not found');
		}

		return story;
	}

	async update(id: number, userId: number, dto: UpdateAudioStoryDto) {
		const story = await this.findOne(id, userId);
		const contentChanged = dto.content !== undefined && dto.content !== story.content;
		return this.prisma.audioStory.update({
			where: {
				id,
				userId
			},
			data: {
				title: dto.title,
				content: dto.content,

				...(contentChanged
					? {
							analysisResult: Prisma.DbNull,
							analyzedAt: null,
							analysisStatus: 'PENDING',
							analysisError: null,
							analysisStartedAt: null,
							analysisAttemptId: null
						}
					: {})
			}
		});
	}

	async remove(id: number, userId: number) {
		await this.findOne(id, userId);

		return this.prisma.audioStory.delete({
			where: {
				id,
				userId
			}
		});
	}

	async analyze(id: number, userId: number) {
		const attemptId = randomUUID();
		const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
		// 1. Fetch story and verify ownership
		const story = await this.findOne(id, userId);

		if (story.analysisResult) {
			if (story.analysisStatus === 'COMPLETED') {
				const result = StoryAnalysisSchema.parse(story.analysisResult);

				await this.prisma.$transaction(async tx => {
					await this.syncCharacters(tx, story.id, result.characters);
					await this.syncScenes(tx, story.id, result.scenes);
				});

				return story.analysisResult;
			}

			throw new ConflictException('Existing analysis has an inconsistent status.');
		}

		const lock = await this.prisma.audioStory.updateMany({
			where: {
				id: story.id,
				userId,
				OR: [
					{
						analysisStatus: {
							in: ['PENDING', 'FAILED']
						}
					},
					{
						analysisStatus: 'PROCESSING',
						analysisStartedAt: {
							lt: staleBefore
						}
					}
				],
				analysisResult: {
					equals: Prisma.DbNull
				}
			},
			data: {
				analysisStatus: 'PROCESSING',
				analysisError: null,
				analysisStartedAt: new Date(),
				analysisAttemptId: attemptId
			}
		});

		if (lock.count === 0) {
			throw new ConflictException({
				code: 'ANALYSIS_ALREADY_PROCESSING',
				message: 'Story analysis is already processing.'
			});
		}

		// 2. Local parser
		const parsedScenes = this.storyParserService.parseScenes(story.content);

		const validation = this.storyParserService.validateParsedScenes(parsedScenes);

		if (validation.valid) {
			const characters = Array.from(
				new Map(
					parsedScenes.map(scene => [
						scene.speakerName,
						{
							name: scene.speakerName,
							gender: scene.gender
						}
					])
				).values()
			);

			return this.saveAnalysis(story.id, userId, story.content, attemptId, {
				storyId: story.id,
				source: 'LOCAL_PARSER',
				characters,
				scenes: parsedScenes.map(scene => ({
					sceneOrder: scene.sceneNumber,
					partNumber: scene.partNumber,
					speakerName: scene.speakerName,
					text: scene.text,
					language: 'hi-IN',
					emotion: scene.emotion,
					style: scene.style
				})),
				validation
			});
		}

		// Local parser failed: use Gemini AI.

		let aiResult;

		try {
			aiResult = await this.audioStoryAnalysisService.analyze(story.content);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown analysis error';

			await this.prisma.audioStory.updateMany({
				where: {
					id: story.id,
					userId,
					content: story.content,
					analysisStatus: 'PROCESSING',
					analysisAttemptId: attemptId,
					analysisResult: {
						equals: Prisma.DbNull
					}
				},
				data: {
					analysisStatus: 'FAILED',
					analysisError: errorMessage,
					analysisStartedAt: null,
					analysisAttemptId: null
				}
			});

			const status =
				typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
					? error.status
					: 500;

			switch (status) {
				case 403:
					throw new HttpException(
						{
							code: 'AI_PERMISSION_DENIED',
							message: 'Gemini project access denied.'
						},
						HttpStatus.FORBIDDEN
					);

				case 429:
					throw new HttpException(
						{
							code: 'AI_QUOTA_EXCEEDED',
							message: 'Gemini API quota exceeded. Please try again later.'
						},
						HttpStatus.TOO_MANY_REQUESTS
					);

				case 503:
					throw new HttpException(
						{
							code: 'AI_MODEL_UNAVAILABLE',
							message: 'Gemini model is currently experiencing high demand. Please try again later.'
						},
						HttpStatus.SERVICE_UNAVAILABLE
					);

				default:
					throw error;
			}
		}

		// Validate Gemini response.
		const aiValidation = this.storyAnalysisValidator.validate(aiResult);

		if (!aiValidation.valid) {
			await this.prisma.audioStory.updateMany({
				where: {
					id: story.id,
					userId,
					content: story.content,
					analysisStatus: 'PROCESSING',
					analysisAttemptId: attemptId,
					analysisResult: {
						equals: Prisma.DbNull
					}
				},
				data: {
					analysisStatus: 'FAILED',
					analysisError: 'Gemini story analysis validation failed',
					analysisStartedAt: null,
					analysisAttemptId: null
				}
			});

			throw new UnprocessableEntityException({
				message: 'Gemini story analysis validation failed',
				errors: aiValidation.errors
			});
		}

		return this.saveAnalysis(story.id, userId, story.content, attemptId, {
			...aiResult,
			storyId: story.id,
			source: 'GEMINI_AI',
			parserErrors: validation.errors,
			validation: aiValidation
		});
	}

	private async saveAnalysis(
		storyId: number,
		userId: number,
		originalContent: string,
		attemptId: string,
		result: StoryAnalysisResult & Record<string, unknown>
	) {
		await this.prisma.$transaction(async tx => {
			const saved = await tx.audioStory.updateMany({
				where: {
					id: storyId,
					userId,
					content: originalContent,
					analysisStatus: 'PROCESSING',
					analysisAttemptId: attemptId
				},
				data: {
					analysisResult: result as Prisma.InputJsonValue,
					analysisStatus: 'COMPLETED',
					analysisError: null,
					analyzedAt: new Date(),
					analysisStartedAt: null,
					analysisAttemptId: null
				}
			});

			if (saved.count === 0) {
				throw new ConflictException({
					code: 'ANALYSIS_ATTEMPT_EXPIRED',
					message: 'Analysis is no longer active. Please analyze again.'
				});
			}

			await this.syncCharacters(tx, storyId, result.characters);
			await this.syncScenes(tx, storyId, result.scenes);
		});

		return result;
	}

	private async syncCharacters(
		tx: Prisma.TransactionClient,
		storyId: number,
		characters: StoryAnalysisResult['characters']
	) {
		for (const character of characters) {
			await tx.audioCharacter.upsert({
				where: {
					storyId_name: {
						storyId,
						name: character.name
					}
				},
				create: {
					storyId,
					name: character.name,
					gender: character.gender,
					voiceId: null
				},
				update: {
					gender: character.gender
				}
			});
		}
	}

	private async syncScenes(tx: Prisma.TransactionClient, storyId: number, scenes: StoryAnalysisResult['scenes']) {
		const characters = await tx.audioCharacter.findMany({
			where: { storyId },
			select: {
				id: true,
				name: true
			}
		});

		const characterMap = new Map(characters.map(character => [character.name, character.id]));

		const existingScenes = await tx.audioScene.findMany({
			where: { storyId },
			select: {
				sceneOrder: true,
				speakerName: true,
				text: true
			}
		});

		const existingSceneMap = new Map(existingScenes.map(scene => [scene.sceneOrder, scene]));

		for (const scene of scenes) {
			const characterId = characterMap.get(scene.speakerName);

			const existingScene = existingSceneMap.get(scene.sceneOrder);

			const sceneChanged =
				existingScene !== undefined &&
				(existingScene.speakerName !== scene.speakerName || existingScene.text !== scene.text);
			await tx.audioScene.upsert({
				where: {
					storyId_sceneOrder: {
						storyId,
						sceneOrder: scene.sceneOrder
					}
				},
				create: {
					storyId,
					sceneOrder: scene.sceneOrder,
					speakerName: scene.speakerName,
					characterId: characterId ?? null,
					text: scene.text,
					language: scene.language,
					emotion: scene.emotion,
					style: scene.style
				},
				update: {
					...(sceneChanged ? { voiceOverrideId: null } : {}),
					speakerName: scene.speakerName,
					characterId: characterId ?? null,
					text: scene.text,
					language: scene.language,
					emotion: scene.emotion,
					style: scene.style
				}
			});
		}
	}

	async updateCast(storyId: number, userId: number, dto: UpdateStoryCastDto) {
		return this.prisma.$transaction(async tx => {
			const story = await tx.audioStory.findFirst({
				where: { id: storyId, userId }
			});

			if (!story) {
				throw new NotFoundException('Audio story not found');
			}

			if (story.analysisStatus !== 'COMPLETED' || !story.analysisResult) {
				throw new BadRequestException('Story analysis must be completed before assigning voices.');
			}

			const analyzedCharacters =
				(
					story.analysisResult as {
						characters?: { name: string }[];
					}
				).characters ?? [];

			const allowedNames = new Set(analyzedCharacters.map(character => character.name));

			const submittedNames = dto.characters.map(character => character.name);

			if (
				new Set(submittedNames).size !== submittedNames.length ||
				dto.characters.some(character => !allowedNames.has(character.name))
			) {
				throw new BadRequestException('Invalid or duplicate characters in cast.');
			}

			const voiceIds = [
				...new Set(dto.characters.map(character => character.voiceId).filter((id): id is number => id != null))
			];

			const activeVoices = await tx.voice.findMany({
				where: {
					id: { in: voiceIds },
					isActive: true
				},
				select: { id: true }
			});

			if (activeVoices.length !== voiceIds.length) {
				throw new BadRequestException('One or more selected voices are invalid or inactive.');
			}

			for (const character of dto.characters) {
				await tx.audioCharacter.upsert({
					where: {
						storyId_name: {
							storyId,
							name: character.name
						}
					},
					create: {
						storyId,
						name: character.name,
						gender: character.gender,
						voiceId: character.voiceId ?? null
					},
					update: {
						gender: character.gender,
						...(character.voiceId !== undefined ? { voiceId: character.voiceId } : {})
					}
				});
			}

			return tx.audioCharacter.findMany({
				where: {
					storyId,
					name: { in: submittedNames }
				},
				select: {
					id: true,
					name: true,
					gender: true,
					voiceId: true
				},
				orderBy: { id: 'asc' }
			});
		});
	}

	async getCast(storyId: number, userId: number) {
		const story = await this.findOne(storyId, userId);

		if (story.analysisStatus !== 'COMPLETED' || !story.analysisResult) {
			return [];
		}

		const analysis = story.analysisResult as {
			characters?: { name: string }[];
		};

		const characterNames = [...new Set((analysis.characters ?? []).map(character => character.name))];

		if (characterNames.length === 0) {
			return [];
		}

		return this.prisma.audioCharacter.findMany({
			where: {
				storyId,
				name: { in: characterNames }
			},
			select: {
				id: true,
				name: true,
				gender: true,
				voiceId: true
			},
			orderBy: {
				id: 'asc'
			}
		});
	}
}
