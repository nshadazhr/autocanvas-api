import { Injectable, UnauthorizedException, InternalServerErrorException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { jwtDecode } from 'jwt-decode';

@Injectable()
export class GoogleAuthService {
	constructor(private readonly prisma: PrismaService) {}
	private readonly googleClient = new OAuth2Client();

	async verifyGoogleToken(idToken: string) {
		const clientId = process.env.GOOGLE_CLIENT_ID;

		if (!clientId) {
			throw new InternalServerErrorException('GOOGLE_CLIENT_ID is not configured');
		}

		try {
			console.log('Token received:', {
				type: typeof idToken,
				length: idToken?.length,
				segments: idToken?.split('.').length
			});

			const decoded = jwtDecode<{ aud: string }>(idToken);

			const backendClientId = process.env.GOOGLE_CLIENT_ID?.trim();

			console.log('Google Audience Check:', {
				audienceMatches: decoded.aud === backendClientId,
				tokenAudienceLength: decoded.aud?.length,
				backendClientIdLength: backendClientId?.length
			});

			const clientId = process.env.GOOGLE_CLIENT_ID?.trim();

			if (!clientId) {
				throw new InternalServerErrorException('GOOGLE_CLIENT_ID is not configured');
			}

			const ticket = await this.googleClient.verifyIdToken({
				idToken: idToken.trim(),
				audience: clientId
			});

			const payload = ticket.getPayload();

			console.log('Google verification successful:', {
				verified: !!payload,
				emailVerified: payload?.email_verified
			});

			if (!payload?.sub || !payload.email || !payload.email_verified) {
				throw new UnauthorizedException('Invalid Google account');
			}

			return {
				provider: 'GOOGLE',
				providerAccountId: payload.sub,
				email: payload.email.trim().toLowerCase(),
				name: payload.name ?? null
			};
		} catch (error) {
			console.error('Google token verification failed:', error instanceof Error ? error.message : error);

			if (error instanceof UnauthorizedException) {
				throw error;
			}

			throw new UnauthorizedException('Invalid or expired Google token');
		}
	}

	async findOrCreateGoogleUser(idToken: string) {
		const googleUser = await this.verifyGoogleToken(idToken);

		return this.prisma.$transaction(async tx => {
			// 1. Check whether this Google account is already linked
			const existingIdentity = await tx.authIdentity.findUnique({
				where: {
					provider_providerAccountId: {
						provider: 'GOOGLE',
						providerAccountId: googleUser.providerAccountId
					}
				},
				include: {
					user: true
				}
			});

			if (existingIdentity) {
				return existingIdentity.user;
			}

			// 2. Prevent automatic linking with an existing email/password account
			const existingUser = await tx.user.findUnique({
				where: {
					email: googleUser.email
				}
			});

			if (existingUser) {
				throw new ConflictException(
					'An account with this email already exists. Please use your existing login method.'
				);
			}

			// 3. Create a new user and Google identity together
			return tx.user.create({
				data: {
					email: googleUser.email,
					name: googleUser.name,
					password: null,
					email_verified_at: new Date(),
					identities: {
						create: {
							provider: 'GOOGLE',
							providerAccountId: googleUser.providerAccountId
						}
					}
				}
			});
		});
	}
}
