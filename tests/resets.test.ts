import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";

const origin = "https://mail.example.com";
const credentials = { username: "admin", password: "admin" };
const bindings = env as unknown as {
  DB: D1Database;
  AUTH_PASSWORD_HASH: string;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  PUBLIC_ORIGIN: string;
  ADMIN_USERNAME: string;
  MAIL_DOMAIN: string;
  MESSAGE_RETENTION_DAYS: string;
};

type SentMail = { from: string; to: string; subject: string; text: string };
const sent: SentMail[] = [];
const mailBinding = {
  send: async (message: SentMail) => {
    sent.push(message);
    return { messageId: `test-${sent.length}` };
  },
};

const mailOverrides = {
  RESET_EMAIL: mailBinding,
  RESET_EMAIL_TO: "owner@example.net",
};

async function request(
  path: string,
  init: RequestInit = {},
  overrides: Record<string, unknown> = mailOverrides,
) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${origin}${path}`, init),
    { ...bindings, ...overrides },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return request(path, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "cf-connecting-ip": "192.0.2.7",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function cookieFor(body: { username: string; password: string }) {
  const response = await post("/api/auth/login", body);
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).not.toBeNull();
  return cookie?.split(";")[0] ?? "";
}

function tokenFrom(text: string) {
  const match = /[?&]reset=([a-f0-9]{64})/.exec(text);
  if (!match) throw new Error("reset token missing from email");
  return match[1];
}

beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});

beforeEach(async () => {
  sent.length = 0;
  await bindings.DB.batch([
    bindings.DB.prepare("DELETE FROM sessions"),
    bindings.DB.prepare("DELETE FROM rate_limits"),
    bindings.DB.prepare("DELETE FROM password_resets"),
  ]);
});

describe("password reset", () => {
  it("answers identically for unknown accounts and stores no token", async () => {
    const response = await post("/api/auth/forgot", { username: "missing" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
    const count = await bindings.DB.prepare("SELECT COUNT(*) AS total FROM password_resets").first<{
      total: number;
    }>("total");
    expect(count).toBe(0);
  });

  it("drops the token when sending the reset email fails", async () => {
    const response = await request(
      "/api/auth/forgot",
      {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "cf-connecting-ip": "192.0.2.7",
        },
        body: JSON.stringify({ username: "admin" }),
      },
      {
        RESET_EMAIL: {
          send: async () => {
            throw new Error("E_RECIPIENT_NOT_ALLOWED");
          },
        },
        RESET_EMAIL_TO: "owner@example.net",
      },
    );
    expect(response.status).toBe(202);
    const count = await bindings.DB.prepare("SELECT COUNT(*) AS total FROM password_resets").first<{
      total: number;
    }>("total");
    expect(count).toBe(0);
  });

  it("resets a member password once and revokes existing sessions", async () => {
    const owner = await cookieFor(credentials);
    const created = await post(
      "/api/admin/users",
      { username: "member1", password: "secret1", roles: ["member"] },
      { cookie: owner },
    );
    expect(created.status).toBe(201);

    const memberCookie = await cookieFor({ username: "member1", password: "secret1" });
    const forgot = await post("/api/auth/forgot", { username: "member1" });
    expect(forgot.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("owner@example.net");
    expect(sent[0]?.from).toBe("no-reply@example.com");

    const token = tokenFrom(sent[0]?.text ?? "");
    const reset = await post("/api/auth/reset", { token, password: "secret2" });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ ok: true, username: "member1" });

    const stale = await request("/api/auth/session", { headers: { cookie: memberCookie } });
    expect(stale.status).toBe(401);

    const login = await post("/api/auth/login", { username: "member1", password: "secret2" });
    expect(login.status).toBe(200);

    const replay = await post("/api/auth/reset", { token, password: "secret3" });
    expect(replay.status).toBe(400);
  });

  it("resets the bootstrap owner and keeps the secret readable", async () => {
    const forgot = await post("/api/auth/forgot", { username: "admin" });
    expect(forgot.status).toBe(202);
    const token = tokenFrom(sent[0]?.text ?? "");

    const reset = await post("/api/auth/reset", { token, password: "ownerpass2" });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ ok: true, username: "admin" });

    const login = await post("/api/auth/login", {
      username: "admin",
      password: "ownerpass2",
    });
    expect(login.status).toBe(200);
  });

  it("rejects expired tokens", async () => {
    await post("/api/auth/forgot", { username: "admin" });
    const token = tokenFrom(sent[0]?.text ?? "");
    await bindings.DB.prepare("UPDATE password_resets SET created_at = 1, expires_at = 2").run();
    const response = await post("/api/auth/reset", { token, password: "ownerpass3" });
    expect(response.status).toBe(400);
  });
});
