import NextAuth from "next-auth";
import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@platform/database";
import { verifyPassword } from "./password";

// ─────────────────────────────────────────────────────────────────────────
// NOTE ON SESSION STRATEGY
//
// The architecture doc calls for database-backed sessions (revocable from
// the admin panel). Auth.js's Credentials provider does not support the
// "database" session strategy — it requires "jwt". Since email/password is
// a hard requirement here, we use JWT sessions and get revocability back
// via `User.tokenVersion`: every JWT embeds the tokenVersion it was issued
// with, and `packages/auth/src/revoke.ts` bumps the DB value to invalidate
// all previously-issued tokens for that user on the next request.
// Google OAuth continues to persist real Account/User rows via the Prisma
// adapter regardless of session strategy — only session storage is affected.
// ─────────────────────────────────────────────────────────────────────────

export const authConfig: NextAuthConfig = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.passwordHash) return null; // Google-only account

        const valid = await verifyPassword(password, user.passwordHash);
        if (!valid) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          tokenVersion: user.tokenVersion,
        };
      },
    }),
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // Runs once at sign-in with `user` populated, then on every subsequent
      // request with only `token`. We re-check tokenVersion against the DB
      // on every call so a revoked session actually stops working on its
      // very next request rather than lingering until expiry.
      if (user) {
        token.id = user.id as string;
        token.role = (user as { role?: string }).role ?? "USER";
        token.tokenVersion = (user as { tokenVersion?: number }).tokenVersion ?? 0;
        return token;
      }

      if (typeof token.id === "string") {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.id },
          select: { role: true, tokenVersion: true, deletedAt: true },
        });
        if (!dbUser || dbUser.deletedAt || dbUser.tokenVersion !== token.tokenVersion) {
          // Signals a revoked/deleted account — session callback below
          // strips the user, and route guards treat `session.user` as
          // missing (i.e. logged out) rather than trusting a stale token.
          token.revoked = true;
        } else {
          token.role = dbUser.role;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token.revoked) {
        // @ts-expect-error — intentionally emptying the session for a revoked token.
        session.user = undefined;
        return session;
      }
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as "USER" | "ADMIN" | "SUPER_ADMIN";
      }
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
