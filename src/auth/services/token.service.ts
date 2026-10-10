import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

interface TokenPayload {
  id: number;
  email: string;
}

@Injectable()
export class TokenService {
  constructor(private readonly jwtService: JwtService) {}

  async generateTokens(payload: TokenPayload) {
    const access_token = await this.jwtService.signAsync(payload);

    const refresh_token = await this.jwtService.signAsync(payload, {
      secret: process.env.JWT_REFRESH_SECRET,
      expiresIn: '1d',
    });

    return {
      access_token,
      refresh_token,
    };
  }

  async refreshAccessToken(refreshToken: string) {
    try {
      const payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET,
      });

      const newPayload = {
        id: payload.id,
        email: payload.email,
      };

      const access_token = await this.jwtService.signAsync(newPayload);

      return { access_token };
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }
}
