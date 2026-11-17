import { Hono } from "hono";
import {
  buildPushPayload,
  type PushSubscription as WebPushSubscription,
  type PushMessage,
} from "@block65/webcrypto-web-push";
import { readAuthConfig, requireSession } from "./auth";
import { authenticateApiKey } from "./apikeys";
import { ApiError, readJson } from "./security";
import type { AppBindings, Env, Principal } from "./types";

const now = () => Math.floor(Date.now() / 1000);
const MAX_SUBSCRIPTIONS = 10;
const ENDPOINT_LIMIT = 1024;

type SubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

/** A push endpoint is a URL a browser handed us; validate the shape before storing. */
function parseSubscription(body: Record<string, unknown>): WebPushSubscription {
  const endpoint = body.endpoint;
  const keys = body.keys as { p256dh?: unknown; auth?: unknown } | undefined;
  if (
    typeof endpoint !== "string" ||
    endpoint.length < 12 ||
    endpoint.length > ENDPOINT_LIMIT ||
    !/^https:\/\//.test(endpoint) ||
    !keys ||
    typeof keys.p256dh !== "string" ||
    typeof keys.auth !== "string" ||
    keys.p256dh.length > 200 ||
    keys.auth.length > 100
  ) {
    throw new ApiError(400, "INVALID_INPUT", "Langganan push tidak valid.");
  }
  return {
    endpoint,
    expirationTime: null,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}

function vapidKeys(env: Env) {
  return {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
}

/** Sends one notification to one subscription. Returns false when it is gone. */
async function deliver(
  env: Env,
  subscription: WebPushSubscription,
  payload: PushMessage["data"],
): Promise<boolean> {
  const push = await buildPushPayload({ data: payload }, subscription, vapidKeys(env));
  const response = await fetch(subscription.endpoint, {
    method: push.method,
    headers: push.headers,
    body: push.body,
  });
  // 404/410 mean the browser dropped the subscription: prune it.
  if (response.status === 404 || response.status === 410) return false;
  if (!response.ok) throw new Error(`push endpoint responded ${response.status}`);
  return true;
}

/**
 * Fan-out for one account. Called from the inbound path, so it never throws into
 * the mail flow: a failed push must not reject a message that is already stored.
 */
export async function notifyUser(
  env: Env,
  userId: string,
  payload: PushMessage["data"],
): Promise<void> {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return;
  const { results } = await env.DB.prepare(
    "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?",
  )
    .bind(userId)
    .all<SubscriptionRow>();
  for (const row of results ?? []) {
    const subscription: WebPushSubscription = {
      endpoint: row.endpoint,
      expirationTime: null,
      keys: { p256dh: row.p256dh, auth: row.auth },
    };
    try {
      const alive = await deliver(env, subscription, payload);
      if (alive) {
        await env.DB.prepare(
          "UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE id = ?",
        )
          .bind(now(), row.id)
          .run();
      } else {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(row.id).run();
      }
    } catch {
      // Transient endpoint errors: count them and drop the row after a few tries so
      // a dead device cannot slow every arrival down.
      await env.DB.prepare(
        "UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?",
      )
        .bind(row.id)
        .run();
      await env.DB.prepare(
        "DELETE FROM push_subscriptions WHERE id = ? AND failure_count >= 5",
      )
        .bind(row.id)
        .run();
    }
  }
}

export const pushRoutes = new Hono<AppBindings>();

// Session or API key: the browser uses the session, a script can use either.
pushRoutes.use("*", async (c, next) => {
  if (!c.get("apiKey")) {
    if (!(await authenticateApiKey(c))) {
      c.set("auth", await readAuthConfig(c.env, c.get("config")));
      await requireSession(c);
    }
  }
  await next();
});

pushRoutes.get("/", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?",
  )
    .bind(c.get("user").id)
    .first<{ n: number }>();
  return c.json({
    publicKey: c.env.VAPID_PUBLIC_KEY ?? null,
    subscribed: (row?.n ?? 0) > 0,
    devices: row?.n ?? 0,
  });
});

pushRoutes.post("/", async (c) => {
  const body = await readJson(c.req.raw, 4096);
  if (Object.keys(body).some((key) => key !== "endpoint" && key !== "keys")) {
    throw new ApiError(400, "INVALID_INPUT", "Kirim {endpoint, keys:{p256dh, auth}}.");
  }
  // Validate the request before the configuration check: a malformed subscription is
  // a 400 regardless of how the server is configured.
  const subscription = parseSubscription(body);
  if (!c.env.VAPID_PUBLIC_KEY) {
    throw new ApiError(503, "PUSH_DISABLED", "Notifikasi latar belum dikonfigurasi di server ini.");
  }
  const user: Principal = c.get("user");
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?",
  )
    .bind(user.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_SUBSCRIPTIONS) {
    throw new ApiError(409, "PUSH_LIMIT", `Maksimum ${MAX_SUBSCRIPTIONS} perangkat per akun.`);
  }
  await c.env.DB.prepare(`INSERT INTO push_subscriptions
    (id, user_id, endpoint, p256dh, auth, created_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      failure_count = 0`)
    .bind(
      crypto.randomUUID(),
      user.id,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      now(),
    )
    .run();
  return c.json({ ok: true }, 201);
});

pushRoutes.delete("/", async (c) => {
  const body = await readJson(c.req.raw, 4096);
  if (Object.keys(body).some((key) => key !== "endpoint") || typeof body.endpoint !== "string") {
    throw new ApiError(400, "INVALID_INPUT", "Kirim {endpoint}.");
  }
  const result = await c.env.DB.prepare(
    "DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?",
  )
    .bind(body.endpoint, c.get("user").id)
    .run();
  return c.json({ ok: true, removed: result.meta.changes });
});