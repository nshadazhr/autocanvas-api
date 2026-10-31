import { describe, expect, it, vi } from 'vitest';
import { ProjectsController } from './projects.controller.js';
import type { ProjectsService } from './projects.service.js';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface.js';

describe('ProjectsController authenticated dispatch', () => {
	it('passes the authenticated user ID to every project operation', async () => {
		// HTTP guards are exercised by integration suites; this unit checks controller ownership forwarding.
		const service = { create: vi.fn(), findAll: vi.fn(), findOne: vi.fn(), update: vi.fn(), remove: vi.fn() };
		const controller = new ProjectsController(service as unknown as ProjectsService);
		const request = { user: { id: 17 } } as AuthenticatedRequest;
		const dto = { name: 'Fixture', description: 'Test' };
		await controller.create(dto, request);
		await controller.findAll(request);
		await controller.findOne(3, request);
		await controller.update(3, dto, request);
		await controller.remove(3, request);
		expect(service.create).toHaveBeenCalledWith(17, dto);
		expect(service.findAll).toHaveBeenCalledWith(17);
		expect(service.findOne).toHaveBeenCalledWith(3, 17);
		expect(service.update).toHaveBeenCalledWith(3, 17, dto);
		expect(service.remove).toHaveBeenCalledWith(3, 17);
	});
});
