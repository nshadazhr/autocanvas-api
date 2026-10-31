import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ProjectsService } from './projects.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function setup() {
	const project = { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() };
	return { project, service: new ProjectsService({ project } as unknown as PrismaService) };
}

describe('ProjectsService ownership', () => {
	it('uses authenticated ownership when creating and listing projects', async () => {
		const { project, service } = setup();
		const dto = { name: 'Fixture', description: 'Test project', userId: 99 };
		await service.create(17, dto);
		expect(project.create).toHaveBeenCalledWith({
			data: { name: 'Fixture', description: 'Test project', userId: 17 }
		});
		await service.findAll(17);
		expect(project.findMany).toHaveBeenCalledWith({ where: { userId: 17 }, orderBy: { created_at: 'desc' } });
	});
	it('treats absent or other-owner projects as unavailable before writes', async () => {
		const { project, service } = setup();
		project.findFirst.mockResolvedValue(null);
		await expect(service.findOne(3, 17)).rejects.toBeInstanceOf(NotFoundException);
		await expect(service.update(3, 17, { name: 'Blocked' })).rejects.toBeInstanceOf(NotFoundException);
		await expect(service.remove(3, 17)).rejects.toBeInstanceOf(NotFoundException);
		expect(project.update).not.toHaveBeenCalled();
		expect(project.delete).not.toHaveBeenCalled();
	});
	it('keeps owner identity on successful update/delete operations', async () => {
		const { project, service } = setup();
		project.findFirst.mockResolvedValue({ id: 3, userId: 17 });
		await service.update(3, 17, { name: 'Renamed' });
		await service.remove(3, 17);
		expect(project.update).toHaveBeenCalledWith({
			where: { id: 3, userId: 17 },
			data: { name: 'Renamed', description: undefined }
		});
		expect(project.delete).toHaveBeenCalledWith({ where: { id: 3, userId: 17 } });
	});
});
