import { Hono, type MiddlewareHandler } from "hono";
import { credentialConflict, freshSession, readAuthConfig, requireSession } from "./auth";
import { isOwner } from "./roles";
import { ApiError, hex, readJson } from "./security";
import type { AppBindings } from "./types";

const reserved = new Set([
  "admin",
  "postmaster",
  "abuse",
  "security",
  "mailer-daemon",
  "noreply",
  "no-reply",
]);
const authorize: MiddlewareHandler<AppBindings> = async (c, next) => {
  c.set("auth", await readAuthConfig(c.env, c.get("config")));
  await requireSession(c);
  await next();
};
export const inboxRoutes = new Hono<AppBindings>();
export const messageRoutes = new Hono<AppBindings>();
inboxRoutes.use("*", authorize);
messageRoutes.use("*", authorize);
const now = () => Math.floor(Date.now() / 1000);

// Unmapped legacy rows belong only to the owner. Inspection privilege never
// appears in write predicates; every mutation checks ownership inside its SQL.
const ownedInboxIds = `SELECT i.id FROM inboxes i
  LEFT JOIN inbox_owners o ON o.inbox_id = i.id
  WHERE COALESCE(o.user_id, 'owner') = ?`;
const readableInboxIds = `SELECT i.id FROM inboxes i
  LEFT JOIN inbox_owners o ON o.inbox_id = i.id
  WHERE (COALESCE(o.user_id, 'owner') = ? OR ? = 1)`;

async function readBoolean(request: Request, field: "favorite" | "isRead"): Promise<boolean> {
  const body = await readJson(request);
  if (Object.keys(body).some((key) => key !== field) || typeof body[field] !== "boolean") {
    throw new ApiError(400, "INVALID_INPUT", `Gunakan satu field boolean ${field}.`);
  }
  return body[field];
}

inboxRoutes.get("/", async (c) => {
  const user = c.get("user");
  const selectors = c.req.queries("userId") ?? [];
  if (
    selectors.length > 1 ||
    (selectors.length === 1 && !/^[a-zA-Z0-9_-]{1,80}$/.test(selectors[0]))
  ) {
    throw new ApiError(400, "INVALID_INPUT", "Pilihan pengguna tidak valid.");
  }
  const userId = selectors[0] ?? user.id;
  if (userId !== user.id && !isOwner(user)) {
    throw new ApiError(403, "FORBIDDEN", "Pilihan pengguna tidak diizinkan.");
  }
  if (userId !== "owner" && userId !== user.id) {
    const exists = await c.env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
    if (!exists) throw new ApiError(404, "NOT_FOUND", "Pengguna tidak ditemukan.");
  }
  const timestamp = now();
  const fresh = freshSession(c);
  const { results } = await c.env.DB.prepare(`SELECT id, address, created_at AS createdAt,
    COALESCE(f.favorite, 0) AS favorite,
    (SELECT COUNT(*) FROM messages WHERE inbox_id = inboxes.id AND expires_at > ?) AS messageCount,
    (SELECT COUNT(*) FROM messages m LEFT JOIN message_read_state r ON r.message_id = m.id
      WHERE m.inbox_id = inboxes.id AND m.expires_at > ? AND COALESCE(r.is_read, 0) = 0) AS unreadCount,
    (SELECT id FROM messages WHERE inbox_id = inboxes.id AND expires_at > ?
      ORDER BY received_at DESC, id DESC LIMIT 1) AS latestMessageId,
    (SELECT COALESCE(MAX(a.sequence), 0) FROM messages m
      JOIN message_arrivals a ON a.message_id = m.id
      WHERE m.inbox_id = inboxes.id AND m.expires_at > ?) AS latestArrival
    FROM inboxes LEFT JOIN inbox_favorites f ON f.inbox_id = inboxes.id
    WHERE inboxes.id IN (${ownedInboxIds}) AND (${fresh.sql})
    ORDER BY favorite DESC, created_at DESC, id DESC LIMIT 100`)
    .bind(timestamp, timestamp, timestamp, timestamp, userId, ...fresh.values)
    .all();
  return c.json({
    inboxes: results.map((inbox) => ({ ...inbox, favorite: inbox.favorite === 1 })),
  });
});
inboxRoutes.post("/", async (c) => {
  if (c.req.queries("userId") !== undefined) {
    throw new ApiError(400, "INVALID_INPUT", "Inbox hanya dapat dibuat untuk pengguna sendiri.");
  }
  const body = await readJson(c.req.raw);
  if (
    Object.keys(body).some((key) => key !== "localPart") ||
    (body.localPart !== undefined && typeof body.localPart !== "string")
  ) {
    throw new ApiError(400, "INVALID_INPUT", "Nama inbox harus berupa teks.");
  }
  const custom = body.localPart as string | undefined;
  const localPart = custom
    ? custom.toLowerCase()
    : `mail-${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(localPart) || reserved.has(localPart)) {
    throw new ApiError(
      400,
      "INVALID_ADDRESS",
      "Gunakan 1–32 huruf, angka, tanda - atau _. Nama ini tidak boleh digunakan.",
    );
  }
  const address = `${localPart}@${c.get("config").mailDomain}`;
  const id = crypto.randomUUID();
  const createdAt = now();
  const userId = c.get("user").id;
  const fresh = freshSession(c);
  // D1 batches execute transactionally. Only a newly inserted inbox can acquire
  // a claim/mapping; a collision (including an unmapped legacy row) cannot.
  // The quota and claim predicates run at the same write boundary as insertion.
  // Classify stale sessions in the same transaction, before resource errors.
  // Repeat the bound freshness predicate at every write, including side tables.
  const [authorized, inserted, , , conflict] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT 1 WHERE ${fresh.sql}`).bind(...fresh.values),
    c.env.DB.prepare(`INSERT INTO inboxes (id,address,created_at)
      SELECT ?,?,? WHERE (SELECT COUNT(*) FROM inboxes) < 100
        AND NOT EXISTS (SELECT 1 FROM address_claims WHERE address = ? AND user_id <> ?)
        AND (${fresh.sql})
      ON CONFLICT(address) DO NOTHING RETURNING id`).bind(
      id,
      address,
      createdAt,
      address,
      userId,
      ...fresh.values,
    ),
    c.env.DB.prepare(`INSERT INTO address_claims (address,user_id,claimed_at)
      SELECT address,?,? FROM inboxes WHERE id = ? AND (${fresh.sql})
      ON CONFLICT(address) DO NOTHING`).bind(userId, createdAt, id, ...fresh.values),
    c.env.DB.prepare(`INSERT INTO inbox_owners (inbox_id,user_id)
      SELECT id,? FROM inboxes WHERE id = ? AND (${fresh.sql})`).bind(userId, id, ...fresh.values),
    // Capture collision classification in this same transaction, before any
    // concurrent delete/recreate can change the reason for a rejected insert.
    c.env.DB.prepare(`SELECT 1 AS collision WHERE EXISTS (SELECT 1 FROM inboxes WHERE address = ?)
      OR EXISTS (SELECT 1 FROM address_claims WHERE address = ? AND user_id <> ?)`).bind(
      address,
      address,
      userId,
    ),
  ]);
  if (!authorized.results.length) credentialConflict();
  if (!inserted.results.length) {
    const exists = conflict.results.length > 0;
    throw new ApiError(
      409,
      exists ? "ADDRESS_EXISTS" : "INBOX_LIMIT",
      exists
        ? "Email sudah digunakan. Silakan gunakan email lain."
        : "Maksimal 100 inbox. Hapus inbox lama terlebih dahulu.",
    );
  }
  return c.json(
    {
      inbox: {
        id,
        address,
        createdAt,
        messageCount: 0,
        favorite: false,
        unreadCount: 0,
        latestMessageId: null,
        latestArrival: 0,
      },
    },
    201,
  );
});
inboxRoutes.patch("/:id", async (c) => {
  const favorite = await readBoolean(c.req.raw, "favorite");
  const fresh = freshSession(c);
  // Existence check and setter share one statement, including repeated same-value requests.
  const [authorized, updated] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT 1 WHERE ${fresh.sql}`).bind(...fresh.values),
    c.env.DB.prepare(`INSERT INTO inbox_favorites (inbox_id, favorite)
      SELECT id, ? FROM inboxes WHERE id = ? AND id IN (${ownedInboxIds}) AND (${fresh.sql})
      ON CONFLICT(inbox_id) DO UPDATE SET favorite = excluded.favorite RETURNING inbox_id`).bind(
      Number(favorite),
      c.req.param("id"),
      c.get("user").id,
      ...fresh.values,
    ),
  ]);
  if (!authorized.results.length) credentialConflict();
  if (!updated.results.length) throw new ApiError(404, "NOT_FOUND", "Inbox tidak ditemukan.");
  return c.json({ ok: true });
});
inboxRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const userId = c.get("user").id;
  const fresh = freshSession(c);
  // Also reserve post-migration positional legacy inserts before deleting them.
  // FK cascades remove messages/state/mapping, but never address reservations.
  const [authorized, , deleted] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT 1 WHERE ${fresh.sql}`).bind(...fresh.values),
    c.env.DB.prepare(`INSERT INTO address_claims (address,user_id,claimed_at)
      SELECT address,?,created_at FROM inboxes WHERE id = ? AND id IN (${ownedInboxIds})
        AND (${fresh.sql})
      ON CONFLICT(address) DO NOTHING`).bind(userId, id, userId, ...fresh.values),
    c.env.DB.prepare(
      `DELETE FROM inboxes WHERE id = ? AND id IN (${ownedInboxIds}) AND (${fresh.sql}) RETURNING id`,
    ).bind(id, userId, ...fresh.values),
  ]);
  if (!authorized.results.length) credentialConflict();
  if (!deleted.results.length) throw new ApiError(404, "NOT_FOUND", "Inbox tidak ditemukan.");
  return c.json({ ok: true });
});

interface MessageSummary {
  id: string;
  from: string;
  subject: string;
  preview: string;
  receivedAt: number;
  expiresAt: number;
  isRead: number;
}
function parseCursor(cursor: string | undefined): [number, string] | null {
  if (cursor === undefined) return null;
  try {
    if (cursor.length > 256 || !/^[a-zA-Z0-9_-]+$/.test(cursor)) throw new Error();
    const data: unknown = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
    if (
      !Array.isArray(data) ||
      data.length !== 2 ||
      !Number.isSafeInteger(data[0]) ||
      data[0] < 0 ||
      typeof data[1] !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(data[1])
    )
      throw new Error();
    return data as [number, string];
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "Penanda halaman tidak valid.");
  }
}
inboxRoutes.get("/:id/messages", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const cursor = parseCursor(c.req.query("cursor"));
  const queries = c.req.queries("q") ?? [];
  const search = queries[0] ?? "";
  // Bound the decoded input before trimming (200 UTF-16 code units, matching JS length).
  if (queries.length > 1 || search.length > 200 || search.includes("\0")) {
    throw new ApiError(400, "INVALID_QUERY", "Pencarian maksimal 200 karakter tanpa karakter NUL.");
  }
  const term = search.trim();
  const fresh = freshSession(c);
  const inbox = await c.env.DB.prepare(
    `SELECT id FROM inboxes WHERE id = ? AND id IN (${readableInboxIds}) AND (${fresh.sql})`,
  )
    .bind(id, user.id, Number(isOwner(user)), ...fresh.values)
    .first();
  if (!inbox) throw new ApiError(404, "NOT_FOUND", "Inbox tidak ditemukan.");
  let sql = `SELECT id, from_address AS "from", subject, substr(body,1,160) AS preview,
    received_at AS receivedAt, expires_at AS expiresAt, COALESCE(r.is_read, 0) AS isRead
    FROM messages LEFT JOIN message_read_state r ON r.message_id = messages.id
    WHERE inbox_id = ? AND expires_at > ? AND inbox_id IN (${readableInboxIds}) AND (${fresh.sql})`;
  const parameters: (string | number)[] = [
    id,
    now(),
    user.id,
    Number(isOwner(user)),
    ...fresh.values,
  ];
  if (term) {
    // instr is literal: %, _, quotes and backslashes are never wildcard syntax.
    // SQLite lower folds ASCII only; non-ASCII has exact matching, no Unicode normalization.
    sql +=
      " AND (instr(lower(from_address), lower(?)) > 0 OR instr(lower(subject), lower(?)) > 0 OR instr(lower(body), lower(?)) > 0)";
    parameters.push(term, term, term);
  }
  if (cursor) {
    sql += " AND (received_at < ? OR (received_at = ? AND id < ?))";
    parameters.push(cursor[0], cursor[0], cursor[1]);
  }
  sql += " ORDER BY received_at DESC,id DESC LIMIT 31";
  const { results } = await c.env.DB.prepare(sql)
    .bind(...parameters)
    .all<MessageSummary>();
  const messages = results
    .slice(0, 30)
    .map((message) => ({ ...message, isRead: message.isRead === 1 }));
  const last = messages.at(-1);
  const nextCursor =
    results.length > 30 && last
      ? btoa(JSON.stringify([last.receivedAt, last.id]))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "")
      : null;
  return c.json({ messages, nextCursor });
});
messageRoutes.get("/:id", async (c) => {
  const fresh = freshSession(c);
  const message =
    await c.env.DB.prepare(`SELECT id,inbox_id AS inboxId,from_address AS "from",subject,body,
    received_at AS receivedAt, expires_at AS expiresAt, COALESCE(r.is_read, 0) AS isRead
    FROM messages LEFT JOIN message_read_state r ON r.message_id = messages.id
    WHERE id = ? AND expires_at > ? AND inbox_id IN (${readableInboxIds}) AND (${fresh.sql})`)
      .bind(
        c.req.param("id"),
        now(),
        c.get("user").id,
        Number(isOwner(c.get("user"))),
        ...fresh.values,
      )
      .first();
  if (!message)
    throw new ApiError(404, "NOT_FOUND", "Pesan tidak ditemukan atau sudah kedaluwarsa.");
  return c.json({ message: { ...message, isRead: message.isRead === 1 } });
});
messageRoutes.patch("/:id", async (c) => {
  const isRead = await readBoolean(c.req.raw, "isRead");
  const fresh = freshSession(c);
  // Filtering before the upsert prevents updates to existing state for expired messages.
  const [authorized, updated] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT 1 WHERE ${fresh.sql}`).bind(...fresh.values),
    c.env.DB.prepare(`INSERT INTO message_read_state (message_id, is_read)
      SELECT id, ? FROM messages WHERE id = ? AND expires_at > ? AND inbox_id IN (${ownedInboxIds})
        AND (${fresh.sql})
      ON CONFLICT(message_id) DO UPDATE SET is_read = excluded.is_read RETURNING message_id`).bind(
      Number(isRead),
      c.req.param("id"),
      now(),
      c.get("user").id,
      ...fresh.values,
    ),
  ]);
  if (!authorized.results.length) credentialConflict();
  if (!updated.results.length)
    throw new ApiError(404, "NOT_FOUND", "Pesan tidak ditemukan atau sudah kedaluwarsa.");
  return c.json({ ok: true });
});
messageRoutes.delete("/:id", async (c) => {
  const fresh = freshSession(c);
  const [authorized, deleted] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT 1 WHERE ${fresh.sql}`).bind(...fresh.values),
    c.env.DB.prepare(
      `DELETE FROM messages WHERE id = ? AND inbox_id IN (${ownedInboxIds}) AND (${fresh.sql}) RETURNING id`,
    ).bind(c.req.param("id"), c.get("user").id, ...fresh.values),
  ]);
  if (!authorized.results.length) credentialConflict();
  if (!deleted.results.length) throw new ApiError(404, "NOT_FOUND", "Pesan tidak ditemukan.");
  return c.json({ ok: true });
});
