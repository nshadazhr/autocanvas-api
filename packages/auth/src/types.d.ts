import type { DefaultSession } from "next-auth";

// Augments Auth.js's built-in types so `session.user.id` / `.role` are
// typed everywhere in apps/web and apps/admin without casting.
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: "USER" | "ADMIN" | "SUPER_ADMIN";
    } & DefaultSession["user"];
  }

  interface User {
    role?: "USER" | "ADMIN" | "SUPER_ADMIN";
    tokenVersion?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: string;
    tokenVersion?: number;
    revoked?: boolean;
  }
}
