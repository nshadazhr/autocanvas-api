import { AppSettingsModule } from '../settings/app-settings.module.js';
import { StorageObjectsService } from './storage-objects.service.js';
import { StorageCleanupService } from './storage-cleanup.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Module } from '@nestjs/common';

import { StorageService } from './storage.service.js';
import { LocalStorageProvider } from './providers/local-storage.provider.js';
import { R2StorageProvider } from './providers/r2-storage.provider.js';
import { SupabaseStorageProvider } from './providers/supabase-storage.provider.js';

@Module({
	imports: [AppSettingsModule],
	providers: [
		PrismaService,
		StorageObjectsService,
		StorageCleanupService,
		StorageService,
		LocalStorageProvider,
		SupabaseStorageProvider,
		R2StorageProvider
	],
	exports: [StorageService]
})
export class StorageModule {}
