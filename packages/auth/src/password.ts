import bcrypt from "bcryptjs";

// bcryptjs (pure JS, no native compile step) rather than bcrypt — keeps this
// package installable on any CI/dev box without a node-gyp toolchain, which
// matters once `apps/worker` and `apps/admin` also depend on it.

const SALT_ROUNDS = 12;

export async function hashPassword(plainTextPassword: string): Promise<string> {
  if (plainTextPassword.length < 8) {
    throw new Error("Password must be at least 8 characters long.");
  }
  return bcrypt.hash(plainTextPassword, SALT_ROUNDS);
}

export async function verifyPassword(
  plainTextPassword: string,
  passwordHash: string,
): Promise<boolean> {
  return bcrypt.compare(plainTextPassword, passwordHash);
}
