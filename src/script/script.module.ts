import { Module } from '@nestjs/common';
import { ScriptController } from './script.controller.js';
import { ScriptService } from './script.service.js';

@Module({
	imports: [],
	controllers: [ScriptController],
	providers: [ScriptService]
})
export class ScriptModule {}
