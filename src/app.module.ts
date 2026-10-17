import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { UserModule } from './user/user.module.js';
import { ConfigModule } from '@nestjs/config';
import { ProfileModule } from './profile/profile.module.js';
import { ScriptModule } from './script/script.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { AudioStoriesModule } from './audio-stories/audio-stories.module.js';
import { AiModule } from './ai/ai.module.js';
import { VoicesModule } from './voices/voices.module.js';
import { AudioGenerationModule } from './audio-generation/audio-generation.module.js';
import { AnimationModule } from './animation/animation.module.js';
export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true
		}),
		AuthModule,
		UserModule,
		ProfileModule,
		ScriptModule,
		ProjectsModule,
		AudioStoriesModule,
		AiModule,
		VoicesModule,
		AudioGenerationModule,
		AnimationModule
	],
	controllers: [AppController],
	providers: [AppService]
})
export class AppModule {}
