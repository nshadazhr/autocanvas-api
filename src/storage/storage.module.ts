import { Module } from '@nestjs/common';

import { StorageService } from './storage.service.js';
import { LocalStorageProvider } from './providers/local-storage.provider.js';
import { SupabaseStorageProvider } from './providers/supabase-storage.provider.js';

@Module({
	providers: [StorageService, LocalStorageProvider, SupabaseStorageProvider],
	exports: [StorageService]
})
export class StorageModule {}
