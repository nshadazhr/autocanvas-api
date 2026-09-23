export { authConfig, handlers, auth, signIn, signOut } from "./config";
export { hashPassword, verifyPassword } from "./password";
export { revokeAllSessions } from "./revoke";
export {
  authorize,
  requireAuthorized,
  ForbiddenError,
  type Action,
  type AuthorizeContext,
} from "./rbac";

// ./types.d.ts is a pure ambient module augmentation (no exports) — it just
// needs to be included in the TS program (see tsconfig.json `include`), not
// imported here.
