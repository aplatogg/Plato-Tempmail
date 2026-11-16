import type { Context } from "hono";
import type { AppBindings } from "./types";

export type AuditAction =
  | "user.create"
  | "user.delete"
  | "user.password_reset"
  | "user.roles"
  | "auth.password_change"
  | "auth.password_reset";

export interface AuditEntry {
  actorId: string;
  actorUsername: string;
  action: AuditAction;
  targetId?: string | null;
  targetUsername?: string | null;
  detail?: string | null;
  ip: string;
  now: number;
}

export function requestIp(c: Context<AppBindings>): string {
  return (c.req.header("cf-connecting-ip") ?? "unknown").slice(0, 64);
}

export function auditStatement(db: D1Database, entry: AuditEntry): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log
         (id, actor_id, actor_username, action, target_id, target_username, detail, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      entry.actorId,
      entry.actorUsername,
      entry.action,
      entry.targetId ?? null,
      entry.targetUsername ?? null,
      entry.detail ?? null,
      entry.ip,
      entry.now,
    );
}

/** Best-effort audit for actions already committed in their own transaction. */
export async function recordAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  try {
    await auditStatement(db, entry).run();
  } catch {
    // An audit failure must never turn a committed action into a client error.
  }
}
/** Ninety days of action history; the table must not grow forever. */
export async function cleanupAudit(env: { DB: D1Database }): Promise<void> {
  await env.DB.prepare("DELETE FROM audit_log WHERE created_at < ?")
    .bind(Math.floor(Date.now() / 1000) - 90 * 86400)
    .run();
}
