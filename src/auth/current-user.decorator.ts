import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { BridgeTokenPayload } from "@platform/auth/bridge-token";
import type { AuthenticatedRequest } from "./bridge-auth.guard";

/**
 * `@CurrentUser() user: BridgeTokenPayload` in a controller method — reads
 * the value BridgeAuthGuard already verified and attached to the request.
 * Only usable on routes actually behind that guard (every audio route is);
 * there's no fallback/default here on purpose, so a route that forgets the
 * guard fails loudly (undefined `.sub`/`.role`) rather than silently.
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): BridgeTokenPayload => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.bridgeUser;
});
