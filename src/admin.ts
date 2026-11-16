import type { Context } from "hono";
import { Hono } from "hono";
import { recordAudit, requestIp } from "./audit";
import { credentialConflict, freshSession, passwordVerifier, validNewPassword } from "./auth";
import {
  assignableRoles,
  canDeleteUsers,
  isOwner,
  manageableTarget,
  PEASANT_MASK,
  parseRoles,
  principal,
  requireAssignable,
  validRoleMask,
} from "./roles";
import { ApiError, readJson } from "./security";
import { canClaimReserved, reservedCategory, reservedMessage } from "./reserved";
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
  // A username becomes an address, so the reserved rule covers this path too:
  // only Celestial may hand out a name that reads as authority or as the system.
  if (reservedCategory(body.username) && !canClaimReserved(c.get("user"))) {
    throw new ApiError(403, "RESERVED_ADDRESS", reservedMessage(body.username));
  }
  requireAssignable(c.get("user"), mask);
  const id = crypto.randomUUID();
  const createdAt = Math.floor(Date.now() / 1000);
  const verifier = await passwordVerifier(body.password);
  const fresh = freshSession(c);
  const peasant = (mask & PEASANT_MASK) !== 0;
  const inboxId = crypto.randomUUID();
  const inboxAddress = `${body.username.toLowerCase()}@${c.get("config").mailDomain}`;
  // A peasant account owns exactly one inbox named after the username. Keep the
  // address collision and inbox quota inside the same INSERT predicate as the
  // account write, so a failed inbox can never leave a stranded account behind.
  const inboxGuard = peasant
    ? `AND NOT EXISTS (SELECT 1 FROM inboxes WHERE address = ?)
       AND NOT EXISTS (SELECT 1 FROM address_claims WHERE address = ?)
       AND (SELECT COUNT(*) FROM inboxes) < 100`
    : "";
  const userInsert =
    c.env.DB.prepare(`INSERT INTO users (id, username, password_verifier, revision, created_at, role_mask)
      SELECT ?, ?, ?, 1, ?, ? WHERE ${fresh.sql} AND (SELECT COUNT(*) FROM users) < 100 ${inboxGuard}
      ON CONFLICT(username) DO NOTHING RETURNING id`).bind(
      id,
      body.username,
      verifier,
      createdAt,
      mask,
      ...fresh.values,
      ...(peasant ? [inboxAddress, inboxAddress] : []),
    );
  const inboxInsert = c.env.DB.prepare(`INSERT INTO inboxes (id, address, created_at)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
      ON CONFLICT(address) DO NOTHING RETURNING id`).bind(inboxId, inboxAddress, createdAt, id);
  const claimInsert = c.env.DB.prepare(`INSERT INTO address_claims (address, user_id, claimed_at)
      SELECT address, ?, ? FROM inboxes WHERE id = ?
      ON CONFLICT(address) DO NOTHING`).bind(id, createdAt, inboxId);
  const ownerInsert = c.env.DB.prepare(`INSERT INTO inbox_owners (inbox_id, user_id)
      SELECT id, ? FROM inboxes WHERE id = ?`).bind(id, inboxId);
  const statements = [
    c.env.DB.prepare(`SELECT 1 WHERE ${fresh.sql}`).bind(...fresh.values),
    userInsert,
    c.env.DB.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").bind(body.username),
    c.env.DB.prepare(`SELECT 1 AS collision WHERE EXISTS (SELECT 1 FROM inboxes WHERE address = ?)
      OR EXISTS (SELECT 1 FROM address_claims WHERE address = ? AND user_id <> ?)`).bind(
      inboxAddress,
      inboxAddress,
      id,
    ),
    ...(peasant ? [inboxInsert, claimInsert, ownerInsert] : []),
    c.env.DB.prepare(
      `INSERT INTO audit_log
         (id, actor_id, actor_username, action, target_id, target_username, detail, ip, created_at)
       SELECT ?, ?, ?, 'user.create', ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)`,
    ).bind(
      crypto.randomUUID(),
      c.get("user").id,
      c.get("user").username,
      id,
      body.username,
      JSON.stringify({ roles: body.roles ?? ["member"] }),
      requestIp(c),
      createdAt,
      id,
    ),
  ];
  const [authorized, inserted, existing, collision] = await c.env.DB.batch(statements);
  if (!authorized.results.length) credentialConflict();
  if (!inserted.results.length) {
    if (existing.results.length)
      throw new ApiError(409, "USERNAME_EXISTS", "Username already exists.");
    if (collision.results.length)
      throw new ApiError(409, "ADDRESS_EXISTS", "Inbox address is already in use.");
    throw new ApiError(409, "USER_LIMIT_REACHED", "The member account limit has been reached.");
  }
  return c.json(
    {
      user: { ...principal(id, body.username, mask), createdAt },
      ...(peasant ? { inbox: { id: inboxId, address: inboxAddress } } : {}),
    },
    201,
  );
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
  await recordAudit(c.env.DB, {
    actorId: c.get("user").id,
    actorUsername: c.get("user").username,
    action: "user.password_reset",
    targetId: id,
    targetUsername: target.results[0]?.username ?? null,
    ip: requestIp(c),
    now: Math.floor(Date.now() / 1000),
  });
  return c.json({ ok: true });
});

adminRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (id === "owner") throw new ApiError(403, "FORBIDDEN", "The primary owner cannot be deleted.");
  if (!canDeleteUsers(c.get("user")))
    throw new ApiError(403, "FORBIDDEN", "Celestial, Cosmos, or Astral access is required.");
  if (c.get("user").id === id)
    throw new ApiError(400, "INVALID_TARGET", "You cannot delete your own account.");

  const fresh = freshSession(c);
  const owner = isOwner(c.get("user"));
  const [authorized, target] = await c.env.DB.batch<UserRow>([
    c.env.DB.prepare(`SELECT 1 WHERE ${fresh.sql}`).bind(...fresh.values),
    c.env.DB.prepare(
      "SELECT id, username, role_mask, created_at AS createdAt FROM users WHERE id = ?",
    ).bind(id),
  ]);
  if (!authorized.results.length) credentialConflict();
  const row = target.results[0];
  if (!row) throw new ApiError(404, "NOT_FOUND", "Member not found.");
  checkTarget(row, owner);

  // The guarded user delete runs first: dependent cleanup only fires when the
  // account was actually removed, so a concurrent promotion cannot strip a
  // still-existing account of its sessions, inboxes or reset tokens.
  const orphan = "NOT EXISTS (SELECT 1 FROM users WHERE id = ?)";
  const [deleted] = await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM users WHERE id = ? AND ${manageableTarget} AND ${fresh.sql} RETURNING id`,
    ).bind(id, Number(owner), ...fresh.values),
    c.env.DB.prepare(
      `DELETE FROM sessions WHERE token_hash IN
         (SELECT token_hash FROM session_users WHERE user_id = ?) AND ${orphan}`,
    ).bind(id, id),
    c.env.DB.prepare(
      `DELETE FROM inboxes WHERE id IN
         (SELECT inbox_id FROM inbox_owners WHERE user_id = ?) AND ${orphan}`,
    ).bind(id, id),
    c.env.DB.prepare(`DELETE FROM address_claims WHERE user_id = ? AND ${orphan}`).bind(id, id),
    c.env.DB.prepare(`DELETE FROM password_resets WHERE user_id = ? AND ${orphan}`).bind(id, id),
    c.env.DB.prepare(
      `INSERT INTO audit_log
         (id, actor_id, actor_username, action, target_id, target_username, detail, ip, created_at)
       SELECT ?, ?, ?, 'user.delete', ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = ?)`,
    ).bind(
      crypto.randomUUID(),
      c.get("user").id,
      c.get("user").username,
      id,
      row.username,
      JSON.stringify({ roleMask: row.role_mask }),
      requestIp(c),
      Math.floor(Date.now() / 1000),
      id,
    ),
  ]);
  if (!deleted.results.length)
    throw new ApiError(409, "TARGET_CHANGED", "This account can no longer be deleted.");
  return c.json({ ok: true, id, username: row.username });
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
  await recordAudit(c.env.DB, {
    actorId: c.get("user").id,
    actorUsername: c.get("user").username,
    action: "user.roles",
    targetId: id,
    targetUsername: updated.results[0]?.username ?? null,
    detail: JSON.stringify({ roleMask: mask }),
    ip: requestIp(c),
    now: Math.floor(Date.now() / 1000),
  });
  // Keep the response cookie-neutral, including when an owner edits their own roles.
  return c.json({ user: publicUser(updated.results[0]) });
});

export async function auditLog(c: Context<AppBindings>): Promise<Response> {
  if (!isOwner(c.get("user"))) throw new ApiError(403, "FORBIDDEN", "Owner access is required.");
  const rows = await c.env.DB.prepare(
    `SELECT id, actor_username AS actor, action, target_username AS target,
            detail, ip, created_at AS createdAt
       FROM audit_log
      ORDER BY created_at DESC, rowid DESC
      LIMIT 100`,
  ).all();
  return c.json({ entries: rows.results });
}
