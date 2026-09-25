import { ApiError, configurationError } from "./security";
import type { Principal, Role } from "./types";

export const ROLES: readonly Role[] = ["member", "dev", "admin", "owner"];

export function validRoleMask(mask: unknown): mask is number {
  return typeof mask === "number" && Number.isInteger(mask) && mask >= 1 && mask <= 15;
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
export const canManageUsers = (user: Principal): boolean =>
  isOwner(user) || user.roles.includes("admin");
export const canViewDiagnostics = (user: Principal): boolean =>
  isOwner(user) || user.roles.includes("dev");
export const assignableRoles = (user: Principal): readonly Role[] =>
  isOwner(user) ? ROLES : canManageUsers(user) ? ["member", "dev"] : [];

export function requireAssignable(user: Principal, mask: number): void {
  if (!canManageUsers(user) || (!isOwner(user) && (mask & 12) !== 0))
    throw new ApiError(403, "FORBIDDEN", "Role assignment is not allowed.");
}

// Internal SQL only. Recheck the target's current mask at the mutation boundary,
// not a pre-hash SELECT that a concurrent promotion could invalidate.
export const manageableTarget = `id <> 'owner' AND typeof(role_mask) = 'integer'
  AND role_mask BETWEEN 1 AND 15 AND (? = 1 OR (role_mask & 12) = 0)`;
