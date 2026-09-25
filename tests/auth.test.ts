import {
  applyD1Migrations,
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";

const origin = "https://mail.example.com";
const cookieName = "__Host-plato_session";
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

async function request(
  path: string,
  init: RequestInit = {},
  overrides: Record<string, unknown> = {},
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

function login(
  body: unknown = credentials,
  headers: Record<string, string> = {},
  overrides: Record<string, unknown> = {},
) {
  return request(
    "/api/auth/login",
    {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "cf-connecting-ip": "192.0.2.1",
        ...headers,
      },
      body: JSON.stringify(body),
    },
    overrides,
  );
}

async function sessionCookie() {
  const response = await login();
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).not.toBeNull();
  return cookie?.split(";")[0] ?? "";
}

beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await bindings.DB.batch([
    bindings.DB.prepare("DELETE FROM sessions"),
    bindings.DB.prepare("DELETE FROM rate_limits"),
  ]);
});

describe("authentication contract", () => {
  it("serves a minimal public health response without credentials", async () => {
    const response = await request("/api/health", {}, { AUTH_PASSWORD_HASH: undefined });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("issues a host-only secure cookie and returns only public account configuration", async () => {
    const response = await login();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: { id: "owner", username: "admin", role: "owner", roles: ["owner"] },
      mailDomain: "example.com",
      retentionDays: 7,
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^__Host-plato_session=[a-f0-9]{64};/);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=86400"]) {
      expect(cookie).toContain(attribute);
    }
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("stores only the token digest, never the cookie token or password", async () => {
    const cookie = await sessionCookie();
    const token = cookie.slice(cookie.indexOf("=") + 1);
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const row = await bindings.DB.prepare("SELECT * FROM sessions").first();
    expect(row?.token_hash).toBe(digest);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain("admin");
    expect(Number(row?.expires_at) - Number(row?.created_at)).toBe(86400);
  });

  it.each([
    { username: "admin", password: "wrong" },
    { username: "unknown", password: "admin" },
    { username: "ADMIN", password: "admin" },
  ])("rejects incorrect credentials with the same generic error: %j", async (body) => {
    const response = await login(body);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "INVALID_CREDENTIALS", message: "Username or password is incorrect." },
    });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(0);
  });

  it.each([
    undefined,
    "",
    "admin",
    "pbkdf2-sha256$1$00$00",
    `pbkdf2-sha256$999999999$00112233445566778899aabbccddeeff$${"a".repeat(64)}`,
  ])("fails closed for missing or invalid verifier: %s", async (verifier) => {
    expect((await login(credentials, {}, { AUTH_PASSWORD_HASH: verifier })).status).toBe(503);
    expect((await request("/api/auth/session", {}, { AUTH_PASSWORD_HASH: verifier })).status).toBe(
      503,
    );
  });

  it("requires a valid stored session", async () => {
    expect((await request("/api/auth/session")).status).toBe(401);
    expect(
      (
        await request("/api/auth/session", {
          headers: { cookie: `${cookieName}=${"a".repeat(64)}` },
        })
      ).status,
    ).toBe(401);
    const cookie = await sessionCookie();
    const response = await request("/api/auth/session", { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { user: unknown }).user).toEqual({
      id: "owner",
      username: "admin",
      role: "owner",
      roles: ["owner"],
    });
  });

  it("rejects expired sessions without depending on scheduled cleanup", async () => {
    const cookie = await sessionCookie();
    await bindings.DB.prepare("UPDATE sessions SET expires_at = 1").run();
    expect((await request("/api/auth/session", { headers: { cookie } })).status).toBe(401);
  });

  it("invalidates existing sessions after password rotation", async () => {
    const cookie = await sessionCookie();
    const rotated = bindings.AUTH_PASSWORD_HASH.slice(0, -64) + "0".repeat(64);
    expect(
      (await request("/api/auth/session", { headers: { cookie } }, { AUTH_PASSWORD_HASH: rotated }))
        .status,
    ).toBe(401);
  });

  it("invalidates existing sessions after username rotation", async () => {
    const cookie = await sessionCookie();
    expect(
      (await request("/api/auth/session", { headers: { cookie } }, { ADMIN_USERNAME: "owner" }))
        .status,
    ).toBe(401);
  });

  it("revokes only the current device on logout", async () => {
    const first = await sessionCookie();
    const second = await sessionCookie();
    expect(first).not.toBe(second);
    const response = await request("/api/auth/logout", {
      method: "POST",
      headers: { origin, cookie: first },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await request("/api/auth/session", { headers: { cookie: first } })).status).toBe(401);
    expect((await request("/api/auth/session", { headers: { cookie: second } })).status).toBe(200);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(1);
  });

  it("replaces the current cookie session on re-login", async () => {
    const first = await sessionCookie();
    const response = await login(credentials, { cookie: first });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).not.toContain(first);
    expect((await request("/api/auth/session", { headers: { cookie: first } })).status).toBe(401);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(1);
  });

  it("does not interpret bearer tokens or Base64 credentials as a session", async () => {
    expect(
      (
        await request("/api/auth/session", {
          headers: { authorization: "Bearer YWRtaW46YWRtaW4=" },
        })
      ).status,
    ).toBe(401);
  });

  it("rejects duplicate cookie names instead of selecting an ambiguous token", async () => {
    const cookie = await sessionCookie();
    expect(
      (await request("/api/auth/session", { headers: { cookie: `${cookie}; ${cookie}` } })).status,
    ).toBe(401);
  });
});

describe("request boundaries", () => {
  it.each([
    "https://attacker.invalid",
    "null",
    "https://mail.example.com.attacker.invalid",
    "http://mail.example.com",
  ])("rejects a foreign Origin: %s", async (foreign) => {
    expect((await login(credentials, { origin: foreign })).status).toBe(403);
  });

  it("requires Origin even when a mutation has a valid cookie", async () => {
    const cookie = await sessionCookie();
    expect(
      (await request("/api/auth/logout", { method: "POST", headers: { cookie } })).status,
    ).toBe(403);
    expect(
      (
        await request("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(credentials),
        })
      ).status,
    ).toBe(403);
  });

  it("rejects a cross-origin read even if a cookie is supplied", async () => {
    const cookie = await sessionCookie();
    expect(
      (
        await request("/api/auth/session", {
          headers: { cookie, origin: "https://attacker.invalid" },
        })
      ).status,
    ).toBe(403);
  });

  it("rejects alternate hosts rather than trusting the request Host for CSRF", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://alternate.invalid/api/auth/login", {
        method: "POST",
        headers: { origin: "https://alternate.invalid", "content-type": "application/json" },
        body: JSON.stringify(credentials),
      }),
      bindings,
      ctx,
    );
    expect(response.status).toBe(403);
    await waitOnExecutionContext(ctx);
  });

  it.each(
    [
      null,
      [],
      {},
      { username: 42, password: "admin" },
      { username: "admin", password: [] },
      { username: "admin", password: "" },
      { username: "admin", password: "a".repeat(1025) },
      { ...credentials, role: "admin" },
    ].map((body) => [body]),
  )("validates the login JSON object: %j", async (body) => {
    expect((await login(body)).status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    expect(
      (
        await request("/api/auth/login", {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
  });

  it("rejects unsupported content types", async () => {
    expect((await login(credentials, { "content-type": "text/plain" })).status).toBe(415);
  });

  it("bounds body bytes even without Content-Length", async () => {
    const response = await login({ ...credentials, padding: "x".repeat(8193) });
    expect(response.status).toBe(413);
  });

  it.each([
    { size: 4096, declared: undefined, status: 200 },
    { size: 4097, declared: undefined, status: 200 },
    { size: 8192, declared: undefined, status: 200 },
    { size: 8193, declared: undefined, status: 413 },
    { size: 8192, declared: "1", status: 200 },
    { size: 8193, declared: "1", status: 413 },
    { size: 8192, declared: "8193", status: 413 },
  ])(
    "enforces login's 8 KiB stream limit: $size bytes, declared $declared",
    async ({ size, declared, status }) => {
      const json = JSON.stringify(credentials);
      const bytes = new TextEncoder().encode(json.padEnd(size, " "));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 4096));
          controller.enqueue(bytes.slice(4096, 8192));
          controller.enqueue(bytes.slice(8192));
          controller.close();
        },
      });
      const response = await request("/api/auth/login", {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          ...(declared === undefined ? {} : { "content-length": declared }),
        },
        body: stream,
      });
      expect(response.status).toBe(status);
    },
  );

  it.each([
    [4096, 400],
    [4097, 413],
  ])("keeps the general API stream limit at 4 KiB (%i bytes)", async (size, status) => {
    // Invalid input reaches mailbox validation at 4 KiB without creating inbox data.
    const cookie = await sessionCookie();
    const bytes = new TextEncoder().encode(JSON.stringify({ localPart: 42 }).padEnd(size, " "));
    const response = await request("/api/inboxes", {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json", "content-length": "1" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 4096));
          controller.enqueue(bytes.slice(4096));
          controller.close();
        },
      }),
    });
    expect(response.status).toBe(status);
  });

  it("decodes multibyte UTF-8 characters across chunks before checking credentials", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ username: "admiñ", password: "admin" }),
    );
    const split = bytes.indexOf(0xc3) + 1;
    const response = await request("/api/auth/login", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, split));
          controller.enqueue(bytes.slice(split));
          controller.close();
        },
      }),
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_CREDENTIALS",
    );
  });

  it.each([[0xff], [0xc3]])("rejects invalid or incomplete UTF-8 sequence %j", async (byte) => {
    const response = await request("/api/auth/login", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: new Uint8Array([byte]),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_JSON",
    );
  });

  it.each([
    { PUBLIC_ORIGIN: "http://mail.example.com" },
    { PUBLIC_ORIGIN: "https://mail.example.com/path" },
    { PUBLIC_ORIGIN: "https://user:pass@mail.example.com" },
    { ADMIN_USERNAME: "" },
    { MESSAGE_RETENTION_DAYS: "31" },
    { MESSAGE_RETENTION_DAYS: "0" },
    { MAIL_DOMAIN: "invalid/domain" },
  ])("fails closed on invalid deployment configuration: %j", async (overrides) => {
    expect((await login(credentials, {}, overrides)).status).toBe(503);
  });

  it("does not leak database details on storage failure", async () => {
    const response = await login(
      credentials,
      {},
      {
        DB: {
          prepare() {
            throw new Error("SQL secret database failure");
          },
        },
      },
    );
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("SQL secret");
    expect(JSON.parse(text).error.code).toBe("INTERNAL_ERROR");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rolls back re-login when the replacement session insert fails", async () => {
    const previous = await sessionCookie();
    await bindings.DB.prepare(
      "CREATE TRIGGER reject_test_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END",
    ).run();
    try {
      const response = await login(credentials, { cookie: previous });
      expect(response.status).toBe(500);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect((await request("/api/auth/session", { headers: { cookie: previous } })).status).toBe(
        200,
      );
      expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(1);
    } finally {
      await bindings.DB.prepare("DROP TRIGGER reject_test_session").run();
    }
  });

  it("applies no-store and browser security headers to successes and failures", async () => {
    for (const response of [
      await request("/api/health"),
      await request("/api/auth/session"),
      await login(credentials, { origin: "null" }),
    ]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("strict-transport-security")).toContain("max-age=");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("rejects malformed email envelopes rather than silently accepting mail", async () => {
    const rejected: string[] = [];
    await worker.email(
      {
        setReject: (reason: string) => rejected.push(reason),
      } as unknown as ForwardableEmailMessage,
      bindings,
      createExecutionContext(),
    );
    expect(rejected).toHaveLength(1);
  });

  it("uses a separate non-Secure cookie only for explicitly configured loopback development", async () => {
    const localOrigin = "http://127.0.0.1:8787";
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${localOrigin}/api/auth/login`, {
        method: "POST",
        headers: { origin: localOrigin, "content-type": "application/json" },
        body: JSON.stringify(credentials),
      }),
      { ...bindings, PUBLIC_ORIGIN: localOrigin },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^plato_session=[a-f0-9]{64};/);
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("HttpOnly");
  });

  it("returns structured JSON rather than an asset response for unknown API paths", async () => {
    const response = await request("/api/missing");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  it("cleans expired session and throttle rows without deleting live sessions", async () => {
    await sessionCookie();
    await bindings.DB.prepare("INSERT INTO sessions VALUES ('expired','old',0,1)").run();
    await bindings.DB.prepare("INSERT INTO rate_limits VALUES ('expired',1,1)").run();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), bindings, ctx);
    await waitOnExecutionContext(ctx);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(1);
    expect(
      await bindings.DB.prepare(
        "SELECT COUNT(*) AS n FROM rate_limits WHERE key = 'expired'",
      ).first("n"),
    ).toBe(0);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first("n")).toBe(2);
  });
});

describe("persistent login throttling", () => {
  it("limits each client to 5 attempts per 15 minutes, even for valid passwords", async () => {
    for (let i = 0; i < 5; i++)
      expect((await login({ ...credentials, password: "wrong" })).status).toBe(401);
    const response = await login();
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(900);
    expect((await login(credentials, { "cf-connecting-ip": "192.0.2.2" })).status).toBe(200);
  });

  it("stores no raw IP or password in rate buckets", async () => {
    await login({ ...credentials, password: "wrong" });
    const { results } = await bindings.DB.prepare("SELECT * FROM rate_limits").all();
    expect(results.length).toBe(2);
    expect(JSON.stringify(results)).not.toContain("192.0.2.1");
    expect(JSON.stringify(results)).not.toContain("wrong");
  });

  it("resets expired rate windows", async () => {
    for (let i = 0; i < 5; i++) await login({ ...credentials, password: "wrong" });
    await bindings.DB.prepare("UPDATE rate_limits SET expires_at = 1").run();
    expect((await login()).status).toBe(200);
  });

  it("does not let concurrent attempts race through the per-IP quota", async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => login({ ...credentials, password: "wrong" })),
    );
    expect(responses.filter((response) => response.status === 401)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(3);
  });

  it("uses a global limit when a client changes its IP", async () => {
    const now = Math.floor(Date.now() / 1000);
    await bindings.DB.prepare(
      "INSERT INTO rate_limits (key, attempts, expires_at) VALUES ('login:global', 100, ?)",
    )
      .bind(now + 900)
      .run();
    expect((await login(credentials, { "cf-connecting-ip": "192.0.2.100" })).status).toBe(429);
  });

  it("admits exactly one concurrent attempt at the global quota boundary", async () => {
    await bindings.DB.prepare("INSERT INTO rate_limits VALUES ('login:global', 99, ?)")
      .bind(Math.floor(Date.now() / 1000) + 900)
      .run();
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        login(
          { ...credentials, password: "wrong" },
          { "cf-connecting-ip": `192.0.2.${index + 1}` },
        ),
      ),
    );
    expect(responses.filter((response) => response.status === 401)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(7);
    expect(
      await bindings.DB.prepare(
        "SELECT attempts FROM rate_limits WHERE key = 'login:global'",
      ).first("attempts"),
    ).toBe(100);
  });

  it("does not let a blocked IP continue consuming global attempts", async () => {
    for (let index = 0; index < 8; index++) await login({ ...credentials, password: "wrong" });
    expect(
      await bindings.DB.prepare(
        "SELECT attempts FROM rate_limits WHERE key = 'login:global'",
      ).first("attempts"),
    ).toBe(5);
  });

  it("ignores spoofable X-Forwarded-For when CF-Connecting-IP is unavailable", async () => {
    for (let i = 0; i < 6; i++) {
      const response = await request("/api/auth/login", {
        method: "POST",
        headers: { origin, "content-type": "application/json", "x-forwarded-for": `192.0.2.${i}` },
        body: JSON.stringify({ ...credentials, password: "wrong" }),
      });
      expect(response.status).toBe(i < 5 ? 401 : 429);
    }
  });
});
