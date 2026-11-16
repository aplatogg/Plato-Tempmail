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
v1Routes.post("/inboxes/bulk", async (c) => {
  const body = await readJson(c.req.raw);
  if (Object.keys(body).some((key) => key !== "count" && key !== "prefix")) {
    throw new ApiError(400, "INVALID_INPUT", "body accepts {count, prefix}.");
  }
  const rawCount = body.count;
  if (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1 || rawCount > 50) {
    throw new ApiError(400, "INVALID_INPUT", "count must be an integer from 1 to 50.");
  }
  const count = rawCount;
  const prefix = body.prefix === undefined ? "" : String(body.prefix).toLowerCase();
  if (prefix && !/^[a-z0-9][a-z0-9_-]{0,16}$/.test(prefix)) {
    throw new ApiError(400, "INVALID_INPUT", "prefix must be 1-17 chars of a-z, 0-9, _ or -.");
  }
  const created: unknown[] = [];
  const failed: unknown[] = [];
  let stopped = false;
  for (let i = 0; i < count && !stopped; i++) {
    // 6 hex chars keep the local part inside the 32-char limit for any prefix.
    const localPart = prefix ? `${prefix}-${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}` : undefined;
    try {
      const response = await createInboxFor(c, localPart);
      const payload = await response.json().catch(() => null);
      if (response.ok) created.push(payload);
      else failed.push({ status: response.status, error: payload });
    } catch (error) {
      if (error instanceof ApiError) {
        failed.push({ status: error.status, error: { code: error.code, message: error.message } });
        // Quota or the global cap: the remaining items cannot succeed either.
        if (error.status === 403 || error.status === 409) stopped = true;
      } else {
        throw error;
      }
    }
  }
  if (!created.length && failed.length) return c.json({ created, failed }, 409);
  return c.json({ created, failed }, 201);
});

v1Routes.route("/inboxes", inboxRoutes);
v1Routes.route("/messages", messageRoutes);