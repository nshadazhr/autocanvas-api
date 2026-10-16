import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class VoicesService {
	constructor(private readonly prisma: PrismaService) {}

	async findAll() {
		return this.prisma.voice.findMany({
			where: {
				isActive: true
			},
			select: {
				id: true,
				name: true,
				gender: true,
				ageCategory: true,
				description: true,
				style: true,
				languages: true,
				previewUrl: true
			},
			orderBy: {
				name: 'asc'
			}
		});
	}
}
