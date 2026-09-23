import jwt from "jsonwebtoken";

// ─────────────────────────────────────────────────────────────────────────
// The "bridge" token: how apps/web authenticates itself to apps/backend.
//
// apps/web's own session cookie (minted by Auth.js, see config.ts) is an
// ENCRYPTED JWE — decoding it requires next-auth's internal machinery, not
// something worth porting into a separate NestJS process just so it can
// read a Bearer header. Instead, once apps/web has already resolved a real
// `session.user` via `auth()`, it mints a small, short-lived, plain HS256
// JWT of its own — signed with the same shared `AUTH_SECRET` both
// processes already have — and sends THAT as the Bearer token on its
// server-to-server call to apps/backend. apps/backend only ever needs to
// verify a generic JWT (see BridgeAuthGuard), never Auth.js's session
// format.
//
// Deliberately framework-agnostic (no next-auth/@platform/database import
// here) so it can be imported by BOTH apps/web (already deep in next-auth
// anyway) and apps/backend (a plain Node/NestJS process that must NOT need
// next-auth as a dependency) via the lightweight `@platform/auth/bridge-token`
// subpath — importing `@platform/auth` itself would pull in `./config.ts`
// and therefore next-auth + the Prisma adapter, which apps/backend has no
// business depending on.
// ─────────────────────────────────────────────────────────────────────────

export type PlatformRole = "USER" | "ADMIN" | "SUPER_ADMIN";

export interface BridgeTokenPayload {
  /** The signed-in user's id — always the JWT `sub` claim. */
  sub: string;
  role: PlatformRole;
  email?: string | null;
}

/**
 * Deliberately very short-lived: this token is minted fresh on every
 * server-to-server call (it's cheap — just a JWT sign) and never stored or
 * reused, so there's no reason to give a stolen/replayed one a long window
 * to be useful.
 */
const BRIDGE_TOKEN_TTL_SECONDS = 60;

const BRIDGE_TOKEN_ISSUER = "platform-web";

function getSharedSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_SECRET is not set — apps/web and apps/backend must share this value to sign/verify bridge tokens.",
    );
  }
  return secret;
}

export function signBridgeToken(payload: BridgeTokenPayload): string {
  return jwt.sign(payload, getSharedSecret(), {
    expiresIn: BRIDGE_TOKEN_TTL_SECONDS,
    issuer: BRIDGE_TOKEN_ISSUER,
  });
}

export class InvalidBridgeTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid bridge token: ${reason}`);
    this.name = "InvalidBridgeTokenError";
  }
}

export function verifyBridgeToken(token: string): BridgeTokenPayload {
  let decoded: string | jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, getSharedSecret(), { issuer: BRIDGE_TOKEN_ISSUER });
  } catch (err) {
    throw new InvalidBridgeTokenError(err instanceof Error ? err.message : "verification failed");
  }

  if (typeof decoded === "string" || typeof decoded.sub !== "string" || typeof decoded.role !== "string") {
    throw new InvalidBridgeTokenError("malformed payload");
  }

  return {
    sub: decoded.sub,
    role: decoded.role as PlatformRole,
    email: typeof decoded.email === "string" ? decoded.email : null,
  };
}
