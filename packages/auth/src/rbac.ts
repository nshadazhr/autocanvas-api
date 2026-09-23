import type { OrgMemberRole, UserRole } from "@platform/database";

// ─────────────────────────────────────────────────────────────────────────
// Two independent RBAC layers, checked through ONE gate (`authorize`):
//
//   1. Platform role  (User.role)              — user | admin | super_admin
//   2. Organization role (OrganizationMember.role) — owner | admin | editor |
//      writer | designer | viewer
//
// Every module (audio today, script/image/video later) calls `authorize()`
// instead of comparing role strings inline — this is what section 8 of the
// architecture doc means by "a single authorize(user, action, resource)
// helper" and it's the only thing that makes RBAC consistent across studios
// that don't exist yet.
// ─────────────────────────────────────────────────────────────────────────

export type Action =
  // Projects (generic — every module's projects go through these)
  | "project:create"
  | "project:read"
  | "project:update"
  | "project:delete"
  | "project:export"
  | "project:duplicate"
  // Generation (credits-consuming actions)
  | "generation:trigger"
  | "generation:cancel"
  // Organization management
  | "org:manage_members"
  | "org:manage_billing"
  | "org:manage_settings"
  // Platform admin (apps/admin)
  | "admin:access"
  | "admin:manage_users"
  | "admin:manage_providers"
  | "admin:manage_flags"
  | "admin:manage_jobs"
  | "credits:grant";

export interface AuthorizeContext {
  platformRole: UserRole;
  /** Org role for the specific organization the resource belongs to, if any. */
  orgRole?: OrgMemberRole | null;
  /** True if the user owns the resource outright (personal, non-org project). */
  isResourceOwner?: boolean;
}

const PLATFORM_ADMIN_ACTIONS: Action[] = [
  "admin:access",
  "admin:manage_users",
  "admin:manage_providers",
  "admin:manage_flags",
  "admin:manage_jobs",
  "credits:grant",
];

/** Org roles are ordered from most to least privileged for the hierarchy check below. */
const ORG_ROLE_RANK: Record<OrgMemberRole, number> = {
  OWNER: 5,
  ADMIN: 4,
  EDITOR: 3,
  WRITER: 3,
  DESIGNER: 3,
  VIEWER: 1,
};

const ORG_ACTION_MIN_RANK: Partial<Record<Action, number>> = {
  "project:create": ORG_ROLE_RANK.EDITOR,
  "project:update": ORG_ROLE_RANK.EDITOR,
  "project:delete": ORG_ROLE_RANK.ADMIN,
  "project:export": ORG_ROLE_RANK.EDITOR,
  "project:duplicate": ORG_ROLE_RANK.EDITOR,
  "project:read": ORG_ROLE_RANK.VIEWER,
  "generation:trigger": ORG_ROLE_RANK.EDITOR,
  "generation:cancel": ORG_ROLE_RANK.EDITOR,
  "org:manage_members": ORG_ROLE_RANK.ADMIN,
  "org:manage_billing": ORG_ROLE_RANK.OWNER,
  "org:manage_settings": ORG_ROLE_RANK.ADMIN,
};

/**
 * The single gate every module calls before performing a guarded action.
 * Returns true/false rather than throwing — callers decide whether that
 * means a 403 response, a hidden button, or a redirect.
 */
export function authorize(context: AuthorizeContext, action: Action): boolean {
  // Platform-level admin actions ignore org context entirely.
  if (PLATFORM_ADMIN_ACTIONS.includes(action)) {
    return context.platformRole === "ADMIN" || context.platformRole === "SUPER_ADMIN";
  }

  // Super admins can do anything a module defines, platform-wide (support/ops use).
  if (context.platformRole === "SUPER_ADMIN") {
    return true;
  }

  // Personal (non-org) resources: the owner can do anything scoped to it.
  if (context.isResourceOwner) {
    return true;
  }

  // Org-scoped resources: check the member's org role against the action's
  // minimum required rank.
  const minRank = ORG_ACTION_MIN_RANK[action];
  if (minRank === undefined) {
    // Unknown/unmapped action inside an org context — fail closed.
    return false;
  }
  if (!context.orgRole) {
    return false;
  }
  return ORG_ROLE_RANK[context.orgRole] >= minRank;
}

/** Convenience helper for API route guards: throws a typed error instead of a bool. */
export class ForbiddenError extends Error {
  constructor(action: Action) {
    super(`Not authorized to perform: ${action}`);
    this.name = "ForbiddenError";
  }
}

export function requireAuthorized(context: AuthorizeContext, action: Action): void {
  if (!authorize(context, action)) {
    throw new ForbiddenError(action);
  }
}
