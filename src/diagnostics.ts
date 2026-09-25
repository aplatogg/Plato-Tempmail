import type { Context } from "hono";
import { credentialConflict, freshSession } from "./auth";
import type { AppBindings } from "./types";

export async function diagnostics(c: Context<AppBindings>): Promise<Response> {
  const fresh = freshSession(c);
  // Fixed aggregate projection; no account/mail contents or infrastructure metadata.
  const counts = await c.env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM inboxes) AS inboxes,
    (SELECT COUNT(*) FROM messages) AS messages
    WHERE ${fresh.sql}`)
    .bind(...fresh.values)
    .first<{ users: number; inboxes: number; messages: number }>();
  if (!counts) credentialConflict();
  const config = c.get("config");
  return c.json({
    ok: true,
    application: {
      name: c.env.APP_NAME ?? "Plato-Tempmail",
      mailDomain: config.mailDomain,
      retentionDays: config.retentionDays,
    },
    database: { ok: true },
    counts,
  });
}
