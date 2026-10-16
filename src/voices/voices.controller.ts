import { Controller, Get } from '@nestjs/common';
import { VoicesService } from './voices.service.js';

@Controller('voices')
export class VoicesController {
	constructor(private readonly voicesService: VoicesService) {}

	@Get()
	async findAll() {
		return this.voicesService.findAll();
	}
}
