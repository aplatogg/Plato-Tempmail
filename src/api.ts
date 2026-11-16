import { Hono } from "hono";
import { requireApiKey } from "./apikeys";
import { createInboxFor, inboxRoutes, messageRoutes } from "./mailboxes";
import { canUseApiKey, retentionDaysFor } from "./roles";
import { ApiError, readJson } from "./security";
import type { AppBindings } from "./types";

/**
 * Versioned REST surface for automation clients. It carries the same routers the
 * app uses, so quota, address rules, ownership and retention behave identically
 * whether a request arrives with a cookie or with an API key.
 */
export const v1Routes = new Hono<AppBindings>();
v1Routes.use("*", requireApiKey);

v1Routes.get("/", (c) =>
  c.json({
    name: "Haldgoff Mail API",
    version: 1,
    auth: "Authorization: Bearer hvk_...",
    endpoints: {
      me: "GET /api/v1/me",
      inboxes: "GET|POST /api/v1/inboxes",
      inbox: "PATCH|DELETE /api/v1/inboxes/:id",
      inboxBulk: "POST /api/v1/inboxes/bulk {count, prefix?}",
      messages: "GET /api/v1/inboxes/:id/messages?unread=1&cursor=...",
      message: "GET /api/v1/messages/:id",
      messageRaw: "PATCH|DELETE /api/v1/messages/:id",
      readAll: "POST /api/v1/inboxes/:id/read-all",
      clearInbox: "DELETE /api/v1/inboxes/:id/messages",
    },
  }),
);

v1Routes.get("/me", (c) => {
  const user = c.get("user");
  return c.json({
    id: user.id,
    username: user.username,
    roles: user.roles,
    mailDomain: c.get("config").mailDomain,
    retentionDays: retentionDaysFor(user, c.get("config").retentionDays),
    apiKeys: canUseApiKey(user),
  });
});

// Bulk creation forwards to the single-inbox route so every item passes the exact
// same transactional path (global cap, claims, role quota, address validation).
// Two ways to fill a batch:
//   {"localParts": ["titikwiduri54", "kurirpaket55"]}  -> exactly these addresses
//   {"count": 5, "prefix": "budi"}                     -> budi12, budi47, ...
// With no prefix, names are generated from word pairs plus a number, the shape a
// person actually picks: titikwiduri54, kurirpaket55. Never _ -, never a hex code.
const BULK_WORDS = [
  "titik", "widuri", "kurir", "paket", "budi", "lestari", "umar", "santoso", "dewi",
  "sari", "agus", "putri", "joko", "siti", "rahma", "bayu", "nisa", "fajar", "indah",
  "rizky", "maya", "dimas", "sekar", "yoga", "lina", "taufik", "wulan", "hendra",
  "citra", "dian", "arif", "nadia", "galih", "ratna", "bagas", "sinta", "eko", "tri",
  "wisnu", "kartika", "darma", "novi", "aldi", "pertiwi", "yuni", "hanif", "reza",
];
function randomBelow(limit: number): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] % limit;
}
function humanLocalPart(taken: Set<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const first = BULK_WORDS[randomBelow(BULK_WORDS.length)];
    const second = BULK_WORDS[randomBelow(BULK_WORDS.length)];
    const candidate = `${first}${second}${randomBelow(99) + 1}`;
    if (candidate !== `${first}${second}` && !taken.has(candidate) && candidate.length <= 28) {
      return candidate;
    }
  }
  return `kotak${randomBelow(900000) + 100000}`;
}
function digits(count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) out += String(randomBelow(10));
  return out;
}

v1Routes.post("/inboxes/bulk", async (c) => {
  const body = await readJson(c.req.raw);
  const allowed = ["count", "prefix", "localParts"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new ApiError(400, "INVALID_INPUT", 'body accepts {count, prefix} or {localParts}.');
  }

  const exact = body.localParts;
  let total: number;
  if (exact !== undefined) {
    if (
      !Array.isArray(exact) ||
      exact.length < 1 ||
      exact.length > 50 ||
      exact.some((value) => typeof value !== "string")
    ) {
      throw new ApiError(400, "INVALID_INPUT", "localParts must be an array of 1 to 50 strings.");
    }
    if (body.count !== undefined || body.prefix !== undefined) {
      throw new ApiError(400, "INVALID_INPUT", "localParts cannot be combined with count or prefix.");
    }
    total = exact.length;
  } else {
    const rawCount = body.count;
    if (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1 || rawCount > 50) {
      throw new ApiError(400, "INVALID_INPUT", "count must be an integer from 1 to 50.");
    }
    total = rawCount;
  }

  const prefix = body.prefix === undefined ? "" : String(body.prefix).toLowerCase();
  if (prefix && !/^[a-z0-9][a-z0-9_-]{0,16}$/.test(prefix)) {
    throw new ApiError(400, "INVALID_INPUT", "prefix must be 1-17 chars of a-z, 0-9, _ or -.");
  }

  const created: unknown[] = [];
  const failed: unknown[] = [];
  const taken = new Set<string>();
  let stopped = false;

  const attemptCreate = async (localPart: string) => {
    const response = await createInboxFor(c, localPart);
    const payload = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, payload };
  };

  for (let i = 0; i < total && !stopped; i++) {
    if (Array.isArray(exact)) {
      // An explicit address that collides is reported, never silently renamed.
      try {
        const result = await attemptCreate(String(exact[i]));
        if (result.ok) created.push(result.payload);
        else failed.push({ address: exact[i], status: result.status, error: result.payload });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        failed.push({ address: exact[i], status: error.status, error: { code: error.code, message: error.message } });
        if (error.status === 403) stopped = true;
      }
      continue;
    }

    let settled = false;
    for (let attempt = 0; attempt < 4 && !settled; attempt++) {
      const localPart = prefix
        ? `${prefix}${digits(attempt === 0 ? 2 : 3)}`
        : humanLocalPart(taken);
      if (taken.has(localPart)) continue;
      taken.add(localPart);
      try {
        const result = await attemptCreate(localPart);
        if (result.ok) {
          created.push(result.payload);
          settled = true;
        } else {
          failed.push({ address: localPart, status: result.status, error: result.payload });
          settled = true;
        }
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        // A collision on a generated name is expected: try another number.
        if (error.code === "ADDRESS_EXISTS" && attempt < 3) continue;
        failed.push({ address: localPart, status: error.status, error: { code: error.code, message: error.message } });
        settled = true;
        if (error.status === 403 || error.status === 409) stopped = true;
      }
    }
  }

  if (!created.length && failed.length) return c.json({ created, failed }, 409);
  return c.json({ created, failed }, 201);
});
v1Routes.route("/inboxes", inboxRoutes);
v1Routes.route("/messages", messageRoutes);