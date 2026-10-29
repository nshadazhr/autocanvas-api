import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
export type ConfigValues = Record<string, unknown>;
export const configurationGroups = {
	'web-settings': ['app_settings'],
	'web-strings': ['app_strings'],
	features: ['backend_settings', 'features'],
	processing: ['backend_settings', 'processing'],
	security: ['backend_settings', 'security'],
	storage: ['backend_settings', 'storage'],
	models: ['openai_settings'],
	pricing: ['credits_settings']
} as const;
export function objectValue(value: unknown): ConfigValues {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ConfigValues) : {};
}
export async function readConfiguration(db: Pick<Prisma.TransactionClient, 'configuration'>, key: string) {
	const row = await db.configuration.findUnique({ where: { key } });
	return objectValue(row?.value);
}
/** All configuration writers share this transaction lock to preserve sibling fields. */
export async function writeConfiguration(
	tx: Prisma.TransactionClient,
	key: string,
	patch: ConfigValues,
	path?: string,
	replace = false
) {
	await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(73127, 0)`;
	const root = await readConfiguration(tx, key);
	const next = replace ? {} : { ...(path ? objectValue(root[path]) : root) };
	for (const [field, value] of Object.entries(patch)) {
		if (!replace && value === null) delete next[field];
		else next[field] = value;
	}
	const value = (path ? { ...root, [path]: next } : next) as Prisma.InputJsonObject;
	if (Buffer.byteLength(JSON.stringify(value)) > 262144)
		throw new BadRequestException('Configuration group must be at most 256 KB');
	await tx.configuration.upsert({ where: { key }, create: { key, value }, update: { value } });
}
