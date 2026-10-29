import type { AuthRealm } from './token.service.js';

export function authAllowedOrigins(env: NodeJS.ProcessEnv = process.env, realm?: AuthRealm): string[] {
	const production = env.NODE_ENV === 'production';
	const user = [env.REQUEST_ORIGIN_PORT || (production ? '' : 'http://localhost:3000')];
	const admin = [env.ADMIN_ORIGIN || (production ? '' : 'http://localhost:3001')];
	const values = realm === 'admin' ? admin : realm === 'user' ? user : [...user, ...admin];
	return [
		...new Set(
			values
				.map(value => value.trim())
				.filter(Boolean)
				.map(value => {
					const url = new URL(value);
					if (
						!['http:', 'https:'].includes(url.protocol) ||
						url.username ||
						url.password ||
						url.pathname !== '/' ||
						url.search ||
						url.hash
					)
						throw new Error('Auth origins must be HTTP(S) origins without paths');
					return url.origin;
				})
		)
	];
}
