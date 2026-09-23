import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { verifyBridgeToken, type BridgeTokenPayload } from "@platform/auth/bridge-token";

export interface AuthenticatedRequest extends Request {
  bridgeUser: BridgeTokenPayload;
}

/**
 * Every route in this app (except a future health check) sits behind this
 * guard. It's the NestJS-side half of the bridge-token pattern described in
 * packages/auth/src/bridge-token.ts: apps/web mints the token after it has
 * already resolved a real Auth.js session, this guard just verifies that
 * token was signed with the shared AUTH_SECRET and hasn't expired, and
 * attaches the decoded `{ sub, role, email }` onto the request for
 * `@CurrentUser()` (see current-user.decorator.ts) and the RBAC checks in
 * each service to use.
 *
 * This guard does NOT re-derive trust from the database on every request
 * the way Auth.js's own `jwt` callback does (see packages/auth/src/config.ts's
 * tokenVersion-revocation check) — the bridge token's 60-second TTL is the
 * mechanism that keeps a revoked user from calling this API for more than a
 * few seconds after apps/web itself stops minting them new tokens.
 */
@Injectable()
export class BridgeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing bridge token — expected an Authorization: Bearer <token> header.");
    }

    try {
      request.bridgeUser = verifyBridgeToken(header.slice("Bearer ".length));
    } catch {
      throw new UnauthorizedException("Bridge token is invalid or has expired.");
    }

    return true;
  }
}
