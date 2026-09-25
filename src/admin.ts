import { Hono } from "hono";
import { credentialConflict, freshSession, passwordVerifier, validNewPassword } from "./auth";
import {
  assignableRoles,
  isOwner,
  manageableTarget,
  parseRoles,
  principal,
  requireAssignable,
  validRoleMask,
} from "./roles";
import { ApiError, readJson } from "./security";
import type { AppBindings } from "./types";

export const adminRoutes = new Hono<AppBindings>();

interface UserRow {
  id: string;
  username: string;
  role_mask: number;
  createdAt: number;
}

function publicUser(row: UserRow) {
  return { ...principal(row.id, row.username, row.role_mask), createdAt: row.createdAt };
}

function checkTarget(row: UserRow | undefined, owner: boolean): void {
  if (!row) throw new ApiError(404, "NOT_FOUND", "Member not found.");
  if (!validRoleMask(row.role_mask) || (!owner && (row.role_mask & 12) !== 0))
    throw new ApiError(403, "FORBIDDEN", "This account cannot be managed.");
}

adminRoutes.get("/", async (c) => {
  const fresh = freshSession(c);
  const [authorized, listed] = await c.env.DB.batch<UserRow>([
    c.env.DB.prepare(`SELECT 1 WHERE ${fresh.sql}`).bind(...fresh.values),
    c.env.DB.prepare(`SELECT id, username, role_mask, created_at AS createdAt FROM users
      WHERE ${fresh.sql} ORDER BY username`).bind(...fresh.values),
  ]);
  if (!authorized.results.length) credentialConflict();
  return c.json({
    users: [
      { ...principal("owner", c.get("config").username, 8), createdAt: null },
      ...listed.results.map(publicUser),
    ],
    assignableRoles: assignableRoles(c.get("user")),
  });
});

adminRoutes.post("/", async (c) => {
  const body = await readJson(c.req.raw, 8192);
  if (
    Object.keys(body).some((key) => key !== "username" && key !== "password" && key !== "roles") ||
    typeof body.username !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{2,31}$/.test(body.username) ||
    body.username === c.get("config").username.toLowerCase() ||
    !validNewPassword(body.password)
  )
    throw new ApiError(
      400,
      "INVALID_INPUT",
      "Provide an available lowercase username of 3–32 characters and a nonblank password of 5–1024 characters.",
    );
  const mask = body.roles === undefined ? 1 : parseRoles(body.roles);
  requireAssignable(c.get("user"), mask);
  const id = crypto.randomUUID();
  const createdAt = Math.floor(Date.now() / 1000);
  const verifier = await passwordVerifier(body.password);
  const fresh = freshSession(c);
  // Both the quota and authorization are predicates of the INSERT, serialized by D1.
  const [authorized, inserted, existing] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT 1 WHERE ${fresh.sql}`).bind(...fresh.values),
    c.env.DB.prepare(`INSERT INTO users (id, username, password_verifier, revision, created_at, role_mask)
      SELECT ?, ?, ?, 1, ?, ? WHERE ${fresh.sql} AND (SELECT COUNT(*) FROM users) < 100
      ON CONFLICT(username) DO NOTHING RETURNING id`).bind(
      id,
      body.username,
      verifier,
      createdAt,
      mask,
      ...fresh.values,
    ),
    c.env.DB.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").bind(body.username),
  ]);
  if (!authorized.results.length) credentialConflict();
  if (!inserted.results.length) {
    if (existing.results.length)
      throw new ApiError(409, "USERNAME_EXISTS", "Username already exists.");
    throw new ApiError(409, "USER_LIMIT_REACHED", "The member account limit has been reached.");
  }
  return c.json({ user: { ...principal(id, body.username, mask), createdAt } }, 201);
});

adminRoutes.post("/:id/password", async (c) => {
  const id = c.req.param("id");
  if (id === "owner")
    throw new ApiError(403, "FORBIDDEN", "The owner must use self-service password change.");
  const body = await readJson(c.req.raw, 8192);
  if (Object.keys(body).some((key) => key !== "password") || !validNewPassword(body.password)) {
    throw new ApiError(400, "INVALID_INPUT", "Provide a nonblank password of 5–1024 characters.");
  }
  const verifier = await passwordVerifier(body.password);
  const fresh = freshSession(c);
  const owner = isOwner(c.get("user"));
  const [authorized, target, result] = await c.env.DB.batch<UserRow>([
    c.env.DB.prepare(`SELECT 1 WHERE ${fresh.sql}`).bind(...fresh.values),
    c.env.DB.prepare(
      "SELECT id, username, role_mask, created_at AS createdAt FROM users WHERE id = ?",
    ).bind(id),
    c.env.DB.prepare(`UPDATE users SET password_verifier = ?, revision = revision + 1
      WHERE id = ? AND revision < 9007199254740991 AND ${manageableTarget} AND ${fresh.sql} RETURNING id`).bind(
      verifier,
      id,
      Number(owner),
      ...fresh.values,
    ),
  ]);
  if (!authorized.results.length) credentialConflict();
  checkTarget(target.results[0], owner);
  if (!result.results.length) credentialConflict();
  return c.json({ ok: true });
});

adminRoutes.patch("/:id/roles", async (c) => {
  const id = c.req.param("id");
  if (id === "owner")
    throw new ApiError(403, "FORBIDDEN", "The bootstrap owner's roles cannot be changed.");
  const body = await readJson(c.req.raw);
  if (Object.keys(body).some((key) => key !== "roles"))
    throw new ApiError(400, "INVALID_INPUT", "Provide only roles.");
  const mask = parseRoles(body.roles);
  requireAssignable(c.get("user"), mask);
  const fresh = freshSession(c);
  const owner = isOwner(c.get("user"));
  const [authorized, target, updated] = await c.env.DB.batch<UserRow>([
    c.env.DB.prepare(`SELECT 1 WHERE ${fresh.sql}`).bind(...fresh.values),
    c.env.DB.prepare(
      "SELECT id, username, role_mask, created_at AS createdAt FROM users WHERE id = ?",
    ).bind(id),
    c.env.DB.prepare(`UPDATE users SET role_mask = ?, revision = revision + 1
      WHERE id = ? AND revision < 9007199254740991 AND ${manageableTarget} AND ${fresh.sql}
      RETURNING id, username, role_mask, created_at AS createdAt`).bind(
      mask,
      id,
      Number(owner),
      ...fresh.values,
    ),
  ]);
  if (!authorized.results.length) credentialConflict();
  checkTarget(target.results[0], owner);
  if (!updated.results.length) credentialConflict();
  // Keep the response cookie-neutral, including when an owner edits their own roles.
  return c.json({ user: publicUser(updated.results[0]) });
});
