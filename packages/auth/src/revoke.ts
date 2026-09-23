import { prisma } from "@platform/database";

/**
 * Force-invalidates every JWT session currently issued for this user.
 * Call this on password change, suspected compromise, or an admin-initiated
 * "log out everywhere" action. See the note in config.ts for why this exists
 * instead of relying on Auth.js's database session strategy.
 */
export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
  });
}
