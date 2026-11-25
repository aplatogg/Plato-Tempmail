import { ApiError, configurationError } from "./security";
import type { Principal, Role } from "./types";

export const ROLES: readonly Role[] = ["member", "dev", "admin", "owner", "peasant", "member_paid"];
export const PEASANT_MASK = 16;
export const MEMBER_PAID_MASK = 32;

export function validRoleMask(mask: unknown): mask is number {
  return (
    typeof mask === "number" &&
    Number.isInteger(mask) &&
    mask >= 1 &&
    mask <= 63 &&
    ((mask & PEASANT_MASK) === 0 || mask === PEASANT_MASK)
  );
}

export function parseRoles(value: unknown): number {
  if (!Array.isArray(value) || value.length === 0 || value.length > ROLES.length)
    throw new ApiError(400, "INVALID_INPUT", "Provide nonempty, unique known roles.");
  let mask = 0;
  for (const role of value) {
    const index = ROLES.indexOf(role);
    if (index < 0 || mask & (1 << index))
      throw new ApiError(400, "INVALID_INPUT", "Provide nonempty, unique known roles.");
    mask |= 1 << index;
  }
  if (!validRoleMask(mask))
    throw new ApiError(400, "INVALID_INPUT", "Quark must be the only role.");
  return mask;
}

export function principal(id: string, username: string, mask: number): Principal {
  if (!validRoleMask(mask)) return configurationError();
  return {
    id,
    username,
    role: mask & 8 ? "owner" : "user",
    roles: ROLES.filter((_, index) => mask & (1 << index)),
  };
}

export const isOwner = (user: Principal): boolean => user.roles.includes("owner");
export const isPeasant = (user: Principal): boolean => user.roles.includes("peasant");
export const isMemberPaid = (user: Principal): boolean => user.roles.includes("member_paid");
export const isElevated = (user: Principal): boolean =>
  isOwner(user) || user.roles.includes("admin") || user.roles.includes("dev");
export const canCreateInbox = (user: Principal): boolean => !isPeasant(user);
export const canDeleteInbox = (user: Principal): boolean => isElevated(user);

/**
 * Retention ceiling per plan, in days. A message keeps the ceiling of the account
 * that owns the inbox, and the highest role wins when an account holds several.
 *   Celestial / Cosmos / Astral -> 30 · Stardust -> 14 · Voyager / Quark -> 7
 */
export const RETENTION_DAYS: Readonly<Record<Role, number>> = {
  owner: 30,
  admin: 30,
  dev: 30,
  member_paid: 14,
  member: 7,
  peasant: 7,
};

export function retentionDaysFor(user: Principal, fallback: number): number {
  let days = 0;
  for (const role of user.roles) days = Math.max(days, RETENTION_DAYS[role] ?? 0);
  // The plan is authoritative; the env value only covers an account with no role.
  return days || fallback;
}

/** Voyager (member) and Quark (peasant) cannot hold API keys; any higher role can. */
export const canUseApiKey = (user: Principal): boolean =>
  user.roles.some((role) => role !== "member" && role !== "peasant");

/** Per-account creation quota. `since` null means lifetime (current owned inboxes). */
export type InboxQuota = { limit: number; since: number | null };
export function inboxQuota(user: Principal): InboxQuota | null {
  if (isElevated(user)) return null;
  if (isMemberPaid(user)) {
    const now = new Date();
    const yearStart = Math.floor(Date.UTC(now.getUTCFullYear(), 0, 1) / 1000);
    return { limit: 100, since: yearStart };
  }
  if (user.roles.includes("member")) return { limit: 6, since: null };
  return { limit: 0, since: null };
}
export const canManageUsers = (user: Principal): boolean =>
  isOwner(user) || user.roles.includes("admin");
export const canViewDiagnostics = (user: Principal): boolean =>
  isOwner(user) || user.roles.includes("dev");
export const canDeleteUsers = (user: Principal): boolean =>
  isOwner(user) || user.roles.includes("admin") || user.roles.includes("dev");
export const assignableRoles = (user: Principal): readonly Role[] =>
  isOwner(user) ? ROLES : canManageUsers(user) ? ["peasant", "member", "member_paid", "dev"] : [];

export function requireAssignable(user: Principal, mask: number): void {
  if (!validRoleMask(mask) || !canManageUsers(user) || (!isOwner(user) && (mask & 12) !== 0))
    throw new ApiError(403, "FORBIDDEN", "Role assignment is not allowed.");
}

// Internal SQL only. Recheck the target's current mask at the mutation boundary,
// not a pre-hash SELECT that a concurrent promotion could invalidate.
export const manageableTarget = `id <> 'owner' AND typeof(role_mask) = 'integer'
  AND role_mask BETWEEN 1 AND 63 AND (? = 1 OR (role_mask & 12) = 0)`;
