import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { notifyUser } from "../src/push";
import type { Env } from "../src/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const origin = "https://mail.example.com";
const encoder = new TextEncoder();

/** Throwaway P-256 pair so no real VAPID key ever lives in the repository. */
async function vapidPair() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const base64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return { publicKey: base64url(raw), privateKey: jwk.d as string };
}

let keys: { publicKey: string; privateKey: string };


/** The deployment env with the throwaway VAPID pair the tests generate. */
function configured(): Env {
  return {
    ...bindings,
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey,
    VAPID_SUBJECT: "mailto:test@example.com",
  } as Env;
}

async function call(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
  target: Env = configured(),
) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(origin + path, {
      method,
      headers: { origin, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    target,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function keyedToken(): Promise<string> {
  const login = await call("/api/auth/login", "POST", { username: "admin", password: "admin" });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const minted = await call("/api/keys", "POST", { name: "push" }, { cookie });
  expect(minted.status).toBe(201);
  return ((await minted.json()) as { token: string }).token;
}

const subscription = {
  endpoint: "https://push.example.test/device/1",
  keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
};

beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  keys = await vapidPair();
});

beforeEach(async () => {
  await bindings.DB.batch(
    [
      "DELETE FROM push_subscriptions",
      "DELETE FROM api_keys",
      "DELETE FROM sessions",
      "DELETE FROM rate_limits",
      "DELETE FROM users",
    ].map((sql) => bindings.DB.prepare(sql)),
  );
});

describe("background notifications", () => {
  it("stores, reports and removes a subscription for an API key", async () => {
    const token = await keyedToken();
    const auth = { authorization: `Bearer ${token}` };

    const empty = await call("/api/push", "GET", undefined, auth);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ subscribed: false, devices: 0 });

    const added = await call("/api/push", "POST", subscription, auth);
    expect(added.status).toBe(201);

    const listed = await call("/api/push", "GET", undefined, auth);
    expect(await listed.json()).toMatchObject({ subscribed: true, devices: 1 });

    const removed = await call("/api/push", "DELETE", { endpoint: subscription.endpoint }, auth);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true, removed: 1 });
  });

  it("rejects a subscription that is not an https endpoint with keys", async () => {
    const token = await keyedToken();
    const auth = { authorization: `Bearer ${token}` };
    const insecure = await call(
      "/api/push",
      "POST",
      { endpoint: "http://push.example.test/1", keys: subscription.keys },
      auth,
    );
    expect(insecure.status).toBe(400);
    const missingKeys = await call(
      "/api/push",
      "POST",
      { endpoint: "https://push.example.test/2" },
      auth,
    );
    expect(missingKeys.status).toBe(400);
  });

  it("survives a dead endpoint and counts the failure", async () => {
    const configured = {
      ...bindings,
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT: "mailto:test@example.com",
    };
    await bindings.DB.prepare(`INSERT INTO push_subscriptions
      (id, user_id, endpoint, p256dh, auth, created_at) VALUES ('p1','owner',?,?,?,1000)`)
      .bind(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth)
      .run();

    // The endpoint does not resolve: notifyUser must resolve anyway and record it.
    await notifyUser(configured, "owner", { title: "T", body: "B" });
    const row = await bindings.DB.prepare(
      "SELECT failure_count FROM push_subscriptions WHERE id = 'p1'",
    ).first<{ failure_count: number }>();
    expect(row?.failure_count).toBe(1);
  });

  it("does nothing when VAPID is not configured", async () => {
    await bindings.DB.prepare(`INSERT INTO push_subscriptions
      (id, user_id, endpoint, p256dh, auth, created_at) VALUES ('p2','owner',?,?,?,1000)`)
      .bind(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth)
      .run();
    await notifyUser(bindings, "owner", { title: "T", body: "B" });
    const row = await bindings.DB.prepare(
      "SELECT failure_count FROM push_subscriptions WHERE id = 'p2'",
    ).first<{ failure_count: number }>();
    expect(row?.failure_count).toBe(0);
  });
});