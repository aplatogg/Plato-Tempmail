import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readAuthConfig } from "../src/auth";
import worker from "../src/index";
import { hex, readConfig, sha256 } from "../src/security";
import type { Env } from "../src/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const origin = "https://mail.example.com";
const newPassword = "correct horse battery staple";
const payload = { currentPassword: "admin", newPassword };

async function request(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${overrides.PUBLIC_ORIGIN ?? origin}${path}`, init),
    { ...bindings, ...overrides },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

function login(password = "admin", overrides: Partial<Env> = {}) {
  return request(
    "/api/auth/login",
    {
      method: "POST",
      headers: { origin: overrides.PUBLIC_ORIGIN ?? origin, "content-type": "application/json" },
      body: JSON.stringify({ username: overrides.ADMIN_USERNAME ?? "admin", password }),
    },
    overrides,
  );
}

async function cookie(password = "admin") {
  const response = await login(password);
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

function change(
  session: string,
  body: unknown = payload,
  headers: Record<string, string> = {},
  overrides: Partial<Env> = {},
) {
  return request(
    "/api/auth/password",
    {
      method: "POST",
      headers: { origin, cookie: session, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    overrides,
  );
}

const session = (value: string, overrides: Partial<Env> = {}) =>
  request("/api/auth/session", { headers: { cookie: value } }, overrides);

async function reset() {
  // The first red run deliberately has no credentials migration yet.
  if (
    await bindings.DB.prepare(
      "SELECT name FROM sqlite_master WHERE name = 'app_credentials'",
    ).first()
  ) {
    await bindings.DB.prepare("DELETE FROM app_credentials").run();
  }
  await bindings.DB.batch([
    bindings.DB.prepare("DELETE FROM sessions"),
    bindings.DB.prepare("DELETE FROM rate_limits"),
  ]);
}
beforeAll(() => applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS));
beforeEach(reset);
afterEach(reset);

// Pause real transactional writes to deterministically exercise request interleavings.
function pauseBatches(count = 1) {
  let arrived = 0;
  let ready!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const db = new Proxy(bindings.DB, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          arrived++;
          if (arrived === count) ready();
          await gate;
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, waiting, release };
}

describe("password change", () => {
  it("requires authentication", async () => {
    expect((await change("")).status).toBe(401);
  });

  it.each(["https://attacker.invalid", "null", `${origin}/`])(
    "requires exact Origin: %s",
    async (foreign) => {
      expect((await change(await cookie(), payload, { origin: foreign })).status).toBe(403);
    },
  );

  it("requires an Origin header", async () => {
    expect(
      (await request("/api/auth/password", { method: "POST", headers: { cookie: await cookie() } }))
        .status,
    ).toBe(403);
  });

  it.each(
    [
      null,
      [],
      {},
      { ...payload, extra: true },
      { ...payload, currentPassword: 1 },
      { ...payload, currentPassword: "" },
      { ...payload, currentPassword: "x".repeat(1025) },
      { ...payload, newPassword: 3 },
      { ...payload, newPassword: "" },
      { ...payload, newPassword: "four" },
      { ...payload, newPassword: " ".repeat(5) },
      { ...payload, newPassword: "x".repeat(1025) },
      { currentPassword: newPassword, newPassword },
    ].map((body) => [body]),
  )("rejects invalid password input %j", async (body) => {
    expect((await change(await cookie(), body)).status).toBe(400);
  });

  it("rejects malformed JSON, unsupported media and oversized streamed bodies", async () => {
    const token = await cookie();
    for (const [body, type, status] of [
      ["{", "application/json", 400],
      ["{}", "text/plain", 415],
      ["x".repeat(16385), "application/json", 413],
    ] as const) {
      expect(
        (
          await request("/api/auth/password", {
            method: "POST",
            headers: { origin, cookie: token, "content-type": type },
            body,
          })
        ).status,
      ).toBe(status);
    }
  });

  it("checks the current password without changing credentials or sessions", async () => {
    const token = await cookie();
    expect((await change(token, { ...payload, currentPassword: "wrong" })).status).toBe(401);
    expect((await session(token)).status).toBe(200);
  });

  it("persists a salted verifier, omits Set-Cookie, revokes every owner session and accepts only the new password", async () => {
    const first = await cookie();
    const second = await cookie();
    const response = await change(first);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toBeNull();
    const row = await bindings.DB.prepare("SELECT * FROM app_credentials").first();
    expect(row?.singleton).toBe(1);
    expect(row?.bootstrap_fingerprint).toBe(await sha256(bindings.AUTH_PASSWORD_HASH ?? ""));
    expect(row?.password_verifier).toMatch(/^pbkdf2-sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
    expect(String(row?.password_verifier).split("$")[2]).not.toBe(
      bindings.AUTH_PASSWORD_HASH?.split("$")[2],
    );
    expect(JSON.stringify(row)).not.toContain(newPassword);
    expect(JSON.stringify(row)).not.toContain("admin");
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(0);
    expect((await session(first)).status).toBe(401);
    expect((await session(second)).status).toBe(401);
    expect((await login()).status).toBe(401);
    expect((await login(newPassword)).status).toBe(200);
    const auth = await readAuthConfig(bindings, readConfig(bindings));
    expect(auth.verifier).toBe(row?.password_verifier);
  });

  it.each(["x".repeat(5), "x".repeat(11), "x".repeat(12), "😀".repeat(512), "界".repeat(1024)])(
    "accepts valid UTF-16 boundary lengths (%#)",
    async (password) => {
      expect((await change(await cookie(), { ...payload, newPassword: password })).status).toBe(
        200,
      );
      expect((await login(password)).status).toBe(200);
    },
  );

  it.each([
    {
      name: "reported control-character lockout",
      password: `Aa1!${"\u0001".repeat(700)}`,
      escapeUnicode: false,
    },
    { name: "1024 mandatory JSON escapes", password: "\u0001".repeat(1024), escapeUnicode: false },
    { name: "1024 lone surrogates", password: "\ud800".repeat(1024), escapeUnicode: false },
    { name: "1024 escaped BMP code units", password: "界".repeat(1024), escapeUnicode: true },
    { name: "512 escaped astral characters", password: "😀".repeat(512), escapeUnicode: true },
  ])("can log in after accepting $name", async ({ password, escapeUnicode }) => {
    const previous = await cookie();
    const changed = await change(previous, { ...payload, newPassword: password });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("set-cookie")).toBeNull();
    expect((await session(previous)).status).toBe(401);
    let body = JSON.stringify({ username: "admin", password });
    if (escapeUnicode)
      body = body.replace(
        /[\u0080-\uffff]/g,
        (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
    const bytes = new TextEncoder().encode(body);
    expect(bytes.length).toBeGreaterThan(4096);
    expect(bytes.length).toBeLessThanOrEqual(8192);
    const loggedIn = await request("/api/auth/login", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body,
    });
    expect(loggedIn.status).toBe(200);
    const next = loggedIn.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect((await session(next)).status).toBe(200);
  });

  it("fits fully escaped maximum username and password within the login budget", async () => {
    const password = "\u0001".repeat(1024);
    expect((await change(await cookie(), { ...payload, newPassword: password })).status).toBe(200);
    const overrides = { ADMIN_USERNAME: "a".repeat(64) };
    const body = `{"username":"${"\\u0061".repeat(64)}","password":"${"\\u0001".repeat(1024)}"}`;
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(8192);
    expect(
      (
        await request(
          "/api/auth/login",
          {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body,
          },
          overrides,
        )
      ).status,
    ).toBe(200);
  });

  it("supports a second change using the persisted password", async () => {
    expect((await change(await cookie())).status).toBe(200);
    expect(
      (
        await change(await cookie(newPassword), {
          currentPassword: newPassword,
          newPassword: "another long password",
        })
      ).status,
    ).toBe(200);
    expect((await login("another long password")).status).toBe(200);
  });

  it("accepts two maximally JSON-escaped passwords without relaxing other routes' body limits", async () => {
    const old = "界".repeat(1024);
    expect((await change(await cookie(), { ...payload, newPassword: old })).status).toBe(200);
    const token = await cookie(old);
    const body = `{"currentPassword":"${"\\u754c".repeat(1024)}","newPassword":"${"\\u754d".repeat(1024)}"}`;
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(12000);
    expect(
      (
        await request("/api/auth/password", {
          method: "POST",
          headers: { origin, cookie: token, "content-type": "application/json" },
          body,
        })
      ).status,
    ).toBe(200);
    expect((await login("畍".repeat(1024))).status).toBe(200);
  });

  it("rejects invalid UTF-8 instead of replacing password bytes", async () => {
    const token = await cookie();
    expect(
      (
        await request("/api/auth/password", {
          method: "POST",
          headers: { origin, cookie: token, "content-type": "application/json" },
          body: new Uint8Array([0xff]),
        })
      ).status,
    ).toBe(400);
    expect((await session(token)).status).toBe(200);
  });

  it("rotating the bootstrap secret resets the override and invalidates old sessions", async () => {
    expect((await change(await cookie())).status).toBe(200);
    const token = await cookie(newPassword);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("recovery-password"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const digest = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", iterations: 100000, salt },
      material,
      256,
    );
    const overrides = {
      AUTH_PASSWORD_HASH: `pbkdf2-sha256$100000$${hex(salt)}$${hex(new Uint8Array(digest))}`,
    };
    expect((await session(token, overrides)).status).toBe(401);
    expect((await login(newPassword, overrides)).status).toBe(401);
    const response = await login("recovery-password", overrides);
    expect(response.status).toBe(200);
    const recoveryCookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(
      (
        await change(
          recoveryCookie,
          { currentPassword: "recovery-password", newPassword },
          {},
          overrides,
        )
      ).status,
    ).toBe(200);
  });

  it("binds persisted sessions to username and origin as well as the password", async () => {
    expect((await change(await cookie())).status).toBe(200);
    const token = await cookie(newPassword);
    expect((await session(token, { ADMIN_USERNAME: "owner" })).status).toBe(401);
    expect((await session(token, { PUBLIC_ORIGIN: "https://other.invalid" })).status).toBe(401);
  });

  it("still requires a valid bootstrap and fails closed on a malformed matching override", async () => {
    expect((await change(await cookie())).status).toBe(200);
    expect((await login(newPassword, { AUTH_PASSWORD_HASH: undefined })).status).toBe(503);
    await bindings.DB.prepare("UPDATE app_credentials SET password_verifier = 'malformed'").run();
    expect((await login()).status).toBe(503);
    await bindings.DB.prepare("UPDATE app_credentials SET bootstrap_fingerprint = ?")
      .bind("a".repeat(64))
      .run();
    expect((await login()).status).toBe(200);
  });

  it("fails closed without leaking a D1 error", async () => {
    const token = await cookie();
    const response = await change(
      token,
      payload,
      {},
      {
        DB: {
          prepare() {
            throw new Error("private SQL failure");
          },
        } as unknown as D1Database,
      },
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private SQL");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rolls back the verifier and session revocation together on write failure", async () => {
    const token = await cookie();
    await bindings.DB.prepare(
      "CREATE TRIGGER reject_password_revoke BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    ).run();
    try {
      const response = await change(token);
      expect(response.status).toBe(500);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect((await session(token)).status).toBe(200);
    } finally {
      await bindings.DB.prepare("DROP TRIGGER reject_password_revoke").run();
    }
  });

  it("has an independent 5/client/15min quota with Retry-After and expiry", async () => {
    const token = await cookie();
    for (let i = 0; i < 5; i++)
      expect((await change(token, { ...payload, currentPassword: "wrong" })).status).toBe(401);
    const response = await change(token);
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(900);
    expect((await login()).status).toBe(200);
    expect(
      await bindings.DB.prepare(
        "SELECT attempts FROM rate_limits WHERE key = 'password:global'",
      ).first("attempts"),
    ).toBe(5);
    await bindings.DB.prepare(
      "UPDATE rate_limits SET expires_at = 1 WHERE key LIKE 'password:%'",
    ).run();
    expect((await change(token)).status).toBe(200);
  });

  it("admits exactly one request at the independent global quota boundary", async () => {
    const token = await cookie();
    await bindings.DB.prepare("INSERT INTO rate_limits VALUES ('password:global',99,?)")
      .bind(Math.floor(Date.now() / 1000) + 900)
      .run();
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        change(
          token,
          { ...payload, currentPassword: "wrong" },
          { "cf-connecting-ip": `192.0.2.${i}` },
        ),
      ),
    );
    expect(responses.filter((r) => r.status === 401)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(7);
    expect((await login()).status).toBe(200);
  });

  it("enforces the per-client budget atomically", async () => {
    const token = await cookie();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => change(token, { ...payload, currentPassword: "wrong" })),
    );
    expect(responses.filter((r) => r.status === 401)).toHaveLength(5);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(3);
  });

  it.each([false, true])(
    "allows exactly one concurrent credential CAS and returns 409 to the loser (persisted=%s)",
    async (persisted) => {
      if (persisted) expect((await change(await cookie())).status).toBe(200);
      const currentPassword = persisted ? newPassword : "admin";
      const token = await cookie(currentPassword);
      // Assert route existence before waiting on its writes in the initial red run.
      expect((await change(token, {})).status).toBe(400);
      const paused = pauseBatches(2);
      const values = ["first concurrent password", "different new password"];
      const pending = values.map((password) =>
        change(token, { currentPassword, newPassword: password }, {}, { DB: paused.db }),
      );
      await paused.waiting;
      paused.release();
      const responses = await Promise.all(pending);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = responses.findIndex((r) => r.status === 200);
      expect((await login(values[winner])).status).toBe(200);
      expect((await login(values[1 - winner])).status).toBe(401);
    },
  );

  it("rechecks session authorization at the credential write after concurrent logout", async () => {
    const token = await cookie();
    const paused = pauseBatches();
    const pending = change(token, payload, {}, { DB: paused.db });
    await paused.waiting;
    try {
      expect(
        (await request("/api/auth/logout", { method: "POST", headers: { origin, cookie: token } }))
          .status,
      ).toBe(200);
    } finally {
      paused.release();
    }
    expect((await pending).status).toBe(409);
    expect((await login()).status).toBe(200);
    expect((await login(newPassword)).status).toBe(401);
  });

  it("does not issue a session when a password change wins against an in-flight login", async () => {
    const token = await cookie();
    expect((await change(token, {})).status).toBe(400);
    const paused = pauseBatches();
    const pending = login("admin", { DB: paused.db });
    await paused.waiting;
    try {
      expect((await change(token)).status).toBe(200);
    } finally {
      paused.release();
    }
    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(0);
  });
});
