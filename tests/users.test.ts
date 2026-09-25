import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { sha256 } from "../src/security";
import type { Env, Principal } from "../src/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const origin = "https://mail.example.com";
const password = "member password 123";
const replacement = "replacement password 456";
let client = 0;

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

function post(path: string, cookie: string, body: unknown, overrides: Partial<Env> = {}) {
  return request(
    path,
    {
      method: "POST",
      headers: {
        origin,
        cookie,
        "content-type": "application/json",
        "cf-connecting-ip": `192.0.2.${++client}`,
      },
      body: JSON.stringify(body),
    },
    overrides,
  );
}

function login(username = "admin", value = "admin", overrides: Partial<Env> = {}) {
  return post("/api/auth/login", "", { username, password: value }, overrides);
}

function cookie(response: Response) {
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function owner() {
  const response = await login();
  expect(response.status).toBe(200);
  return cookie(response);
}

const session = (token: string, overrides: Partial<Env> = {}) =>
  request("/api/auth/session", { headers: { cookie: token } }, overrides);
const create = (
  token: string,
  username = "alice",
  value = password,
  overrides: Partial<Env> = {},
) => post("/api/admin/users", token, { username, password: value }, overrides);
const reset = (token: string, id: string, value = replacement, overrides: Partial<Env> = {}) =>
  post(`/api/admin/users/${id}/password`, token, { password: value }, overrides);
const change = (
  token: string,
  currentPassword = password,
  newPassword = replacement,
  overrides: Partial<Env> = {},
) => post("/api/auth/password", token, { currentPassword, newPassword }, overrides);

async function member(token: string, username = "alice") {
  const response = await create(token, username);
  expect(response.status).toBe(201);
  return ((await response.json()) as { user: Principal & { createdAt: number } }).user;
}

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
          if (++arrived === count) ready();
          await gate;
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, waiting, release };
}

beforeAll(() => applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  client = 0;
  await bindings.DB.batch([
    bindings.DB.prepare("DELETE FROM sessions"),
    bindings.DB.prepare("DELETE FROM app_credentials"),
    bindings.DB.prepare("DELETE FROM rate_limits"),
  ]);
  // Permit the intended pre-migration red run to reach endpoint assertions.
  if (await bindings.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").first()) {
    await bindings.DB.prepare("DELETE FROM users").run();
  }
});

describe("multi-user identity and credentials", () => {
  it("lists the sole configured owner and creates a UUID member without private metadata", async () => {
    const token = await owner();
    const listed = await request("/api/admin/users", { headers: { cookie: token } });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      users: [{ id: "owner", username: "admin", role: "owner", roles: ["owner"], createdAt: null }],
      assignableRoles: ["member", "dev", "admin", "owner"],
    });
    const user = await member(token);
    expect(user).toEqual({
      id: expect.any(String),
      username: "alice",
      role: "user",
      roles: ["member"],
      createdAt: expect.any(Number),
    });
    expect(user.id).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    const row = await bindings.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
    expect(row?.revision).toBe(1);
    expect(row?.password_verifier).toMatch(/^pbkdf2-sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(password);
    const second = await member(token, "bob");
    const other = await bindings.DB.prepare("SELECT password_verifier FROM users WHERE id = ?")
      .bind(second.id)
      .first("password_verifier");
    expect(other).not.toBe(row?.password_verifier);
    const all = await request("/api/admin/users", { headers: { cookie: token } });
    expect(await all.json()).toEqual({
      users: [
        { id: "owner", username: "admin", role: "owner", roles: ["owner"], createdAt: null },
        user,
        second,
      ],
      assignableRoles: ["member", "dev", "admin", "owner"],
    });
  });

  it("resolves two case-insensitive member sessions and stores only token hashes", async () => {
    const token = await owner();
    for (const name of ["alice", "bob"]) {
      const user = await member(token, name);
      const response = await login(name.toUpperCase(), password);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        user: { id: user.id, username: name, role: "user", roles: ["member"] },
        mailDomain: "example.com",
        retentionDays: 7,
      });
      const value = cookie(response);
      expect(await (await session(value)).json()).toEqual({
        user: { id: user.id, username: name, role: "user", roles: ["member"] },
        mailDomain: "example.com",
        retentionDays: 7,
      });
      const raw = value.split("=")[1];
      const mapping = await bindings.DB.prepare("SELECT * FROM session_users WHERE token_hash = ?")
        .bind(await sha256(raw))
        .first();
      expect(mapping?.user_id).toBe(user.id);
      expect(
        JSON.stringify(await bindings.DB.prepare("SELECT * FROM sessions").all()),
      ).not.toContain(raw);
      expect(JSON.stringify(mapping)).not.toContain(raw);
    }
  });

  it("derives a password for unknown users and returns the generic login error", async () => {
    await member(await owner());
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    try {
      const unknown = await login("nobody", password);
      expect(unknown.status).toBe(401);
      expect(derive).toHaveBeenCalledTimes(1);
      const wrong = await login("alice", "wrong");
      expect(wrong.status).toBe(401);
      expect(await unknown.json()).toEqual(await wrong.json());
    } finally {
      derive.mockRestore();
    }
  });

  it("accepts pre-0004 unmapped owner sessions only with the legacy credential version", async () => {
    expect(
      await bindings.DB.prepare(
        "SELECT name FROM sqlite_master WHERE name = 'session_users'",
      ).first(),
    ).not.toBeNull();
    const raw = "b".repeat(64);
    const token = `__Host-plato_session=${raw}`;
    const version = await sha256(JSON.stringify([origin, "admin", bindings.AUTH_PASSWORD_HASH]));
    await bindings.DB.prepare(
      "INSERT INTO sessions VALUES (?, ?, unixepoch(), unixepoch() + 86400)",
    )
      .bind(await sha256(raw), version)
      .run();
    const response = await session(token);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { user: Principal }).user).toEqual({
      id: "owner",
      username: "admin",
      role: "owner",
      roles: ["owner"],
    });
    expect((await change(token, "admin")).status).toBe(200);
    expect((await session(token)).status).toBe(401);
  });

  it.each(["unmapped", "missing-user", "wrong-user", "corrupt-verifier", "owner-mapping"])(
    "fails closed for %s member state",
    async (mode) => {
      const token = await owner();
      const user = await member(token);
      const other = await member(token, "bob");
      const own = cookie(await login("alice", password));
      if (mode === "unmapped")
        await bindings.DB.prepare("DELETE FROM session_users WHERE user_id = ?")
          .bind(user.id)
          .run();
      if (mode === "missing-user")
        await bindings.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
      if (mode === "wrong-user" || mode === "owner-mapping")
        await bindings.DB.prepare("UPDATE session_users SET user_id = ? WHERE user_id = ?")
          .bind(mode === "wrong-user" ? other.id : "owner", user.id)
          .run();
      if (mode === "corrupt-verifier")
        await bindings.DB.prepare("UPDATE users SET password_verifier = 'bad' WHERE id = ?")
          .bind(user.id)
          .run();
      expect((await session(own)).status).toBe(401);
      expect((await session(token)).status).toBe(200);
    },
  );

  it("revokes only one device on member logout", async () => {
    const token = await owner();
    await member(token);
    await member(token, "bob");
    const first = cookie(await login("alice", password));
    const second = cookie(await login("alice", password));
    const bob = cookie(await login("bob", password));
    const response = await post("/api/auth/logout", first, {});
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await session(first)).status).toBe(401);
    for (const live of [second, bob, token]) expect((await session(live)).status).toBe(200);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM session_users").first("n")).toBe(3);
  });

  it("member self-change checks current password, omits Set-Cookie and revokes only that user", async () => {
    const token = await owner();
    await member(token);
    await member(token, "bob");
    const first = cookie(await login("alice", password));
    const second = cookie(await login("alice", password));
    const bob = cookie(await login("bob", password));
    expect((await change(first, "wrong")).status).toBe(401);
    const changed = await change(first);
    expect(changed.status).toBe(200);
    expect(changed.headers.get("set-cookie")).toBeNull();
    for (const dead of [first, second]) expect((await session(dead)).status).toBe(401);
    for (const live of [bob, token]) expect((await session(live)).status).toBe(200);
    expect((await login("alice", password)).status).toBe(401);
    expect((await login("alice", replacement)).status).toBe(200);
  });

  it.each(["logout", "password"])(
    "a delayed %s response cannot send a cookie mutation after another member logs in",
    async (operation) => {
      const ownerToken = await owner();
      const alice = await member(ownerToken);
      const bob = await member(ownerToken, "bob");
      const aliceToken = cookie(await login("alice", password));
      const bobOtherDevice = cookie(await login("bob", password));
      // Hold A's response without applying its headers, representing delayed delivery.
      // The assertion is on the actual Worker response, not a simulated browser jar.
      const delayed = await request(`/api/auth/${operation}`, {
        method: "POST",
        headers: {
          origin,
          cookie: aliceToken,
          "content-type": "application/json",
          "X-Plato-User": alice.id,
        },
        body: JSON.stringify(
          operation === "password" ? { currentPassword: password, newPassword: replacement } : {},
        ),
      });
      expect(delayed.status).toBe(200);
      const nextLogin = await login("bob", password);
      expect(nextLogin.status).toBe(200);
      expect(nextLogin.headers.get("set-cookie")).toContain("Max-Age=86400");
      const bobToken = cookie(nextLogin);
      // B's login headers may arrive first. Late delivery of A must carry no Set-Cookie.
      expect(delayed.headers.get("set-cookie")).toBeNull();
      expect(await delayed.json()).toEqual({ ok: true });
      expect((await session(aliceToken)).status).toBe(401);
      for (const live of [bobToken, bobOtherDevice, ownerToken]) {
        expect((await session(live)).status).toBe(200);
      }
      expect(((await (await session(bobToken)).json()) as { user: Principal }).user).toEqual({
        id: bob.id,
        username: "bob",
        role: "user",
        roles: ["member"],
      });
    },
  );

  it("owner password changes and unchanged owner credential writes preserve members", async () => {
    const token = await owner();
    await member(token);
    const alice = cookie(await login("alice", password));
    expect((await change(token, "admin")).status).toBe(200);
    expect((await session(token)).status).toBe(401);
    expect((await session(alice)).status).toBe(200);
    const next = cookie(await login("admin", replacement));
    await bindings.DB.prepare(
      "UPDATE app_credentials SET password_verifier = password_verifier",
    ).run();
    expect((await session(next)).status).toBe(401);
    expect((await session(alice)).status).toBe(200);
  });

  it("bootstrap rotation invalidates every principal and origin is part of member version", async () => {
    const token = await owner();
    await member(token);
    const alice = cookie(await login("alice", password));
    const rotated = {
      AUTH_PASSWORD_HASH: bindings.AUTH_PASSWORD_HASH?.slice(0, -64) + "0".repeat(64),
    };
    for (const old of [token, alice]) expect((await session(old, rotated)).status).toBe(401);
    expect((await session(alice, { PUBLIC_ORIGIN: "https://other.invalid" })).status).toBe(401);
    expect((await login("alice", password, rotated)).status).toBe(200);
  });
});

describe("owner-only users administration", () => {
  it("rejects anonymous and member list/create/reset and forbids owner reset", async () => {
    const token = await owner();
    const user = await member(token);
    const alice = cookie(await login("alice", password));
    for (const [actor, status] of [
      ["", 401],
      [alice, 403],
    ] as const) {
      expect((await request("/api/admin/users", { headers: { cookie: actor } })).status).toBe(
        status,
      );
      expect((await create(actor, "bob")).status).toBe(status);
      expect((await reset(actor, user.id)).status).toBe(status);
    }
    expect((await reset(token, "owner")).status).toBe(403);
    expect((await reset(token, crypto.randomUUID())).status).toBe(404);
    expect((await post("/api/auth/signup", "", { username: "eve", password })).status).toBe(404);
  });

  it.each(["ab", "a".repeat(33), "Alice", "_abc", "a.b", "a b", "ábc", "admin"])(
    "rejects invalid or reserved username %s",
    async (name) => {
      expect((await create(await owner(), name)).status).toBe(400);
    },
  );

  it("reserves the configured owner case-insensitively", async () => {
    const overrides = { ADMIN_USERNAME: "Alice" };
    const response = await login("Alice", "admin", overrides);
    expect(response.status).toBe(200);
    expect((await create(cookie(response), "alice", password, overrides)).status).toBe(400);
  });

  it.each(["abc", "a".repeat(32), "a_-"])("accepts username boundary %s", async (name) => {
    expect((await create(await owner(), name)).status).toBe(201);
  });

  it("atomically rejects duplicate username races with USERNAME_EXISTS", async () => {
    const token = await owner();
    const responses = await Promise.all([create(token), create(token)]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = responses.find((r) => r.status === 409);
    expect(await loser?.json()).toMatchObject({ error: { code: "USERNAME_EXISTS" } });
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(1);
  });

  it("enforces the 100-member cap atomically", async () => {
    const token = await owner();
    await member(token);
    const row = await bindings.DB.prepare("SELECT password_verifier FROM users").first<string>(
      "password_verifier",
    );
    await bindings.DB.batch(
      Array.from({ length: 98 }, (_, i) =>
        bindings.DB.prepare(
          "INSERT INTO users (id, username, password_verifier, revision, created_at) VALUES (?, ?, ?, 1, 1)",
        ).bind(crypto.randomUUID(), `user${i}`, row),
      ),
    );
    const responses = await Promise.all([create(token, "lastone"), create(token, "lasttwo")]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(100);
  });

  it.each(["", "four", " ".repeat(5), "a".repeat(1025)])(
    "enforces new password lengths and nonblank policy (%#)",
    async (value) => {
      const token = await owner();
      const user = await member(token);
      expect((await create(token, "bob", value)).status).toBe(400);
      expect((await reset(token, user.id, value)).status).toBe(400);
    },
  );

  it("accepts five-character passwords for create, reset and member self-change", async () => {
    const token = await owner();
    const created = await create(token, "alice", "abcde");
    expect(created.status).toBe(201);
    const { user } = (await created.json()) as { user: Principal };
    const previous = cookie(await login("alice", "abcde"));
    expect((await session(previous)).status).toBe(200);
    expect((await reset(token, user.id, "vwxyz")).status).toBe(200);
    expect((await session(previous)).status).toBe(401);
    const current = cookie(await login("alice", "vwxyz"));
    expect((await change(current, "vwxyz", "four")).status).toBe(400);
    expect((await change(current, "vwxyz", "klmno")).status).toBe(200);
    expect((await session(current)).status).toBe(401);
    expect((await login("alice", "klmno")).status).toBe(200);
    expect((await session(token)).status).toBe(200);
  });

  it("rejects extra fields, foreign/missing Origin, malformed JSON and oversized admin bodies", async () => {
    const token = await owner();
    const user = await member(token);
    for (const [path, body] of [
      ["/api/admin/users", { username: "bob", password }],
      [`/api/admin/users/${user.id}/password`, { password }],
    ] as const) {
      expect((await post(path, token, { ...body, role: "owner" })).status).toBe(400);
      for (const foreign of [undefined, "https://attacker.invalid"]) {
        expect(
          (
            await request(path, {
              method: "POST",
              headers: {
                cookie: token,
                "content-type": "application/json",
                ...(foreign ? { origin: foreign } : {}),
              },
              body: JSON.stringify(body),
            })
          ).status,
        ).toBe(403);
      }
      for (const [raw, status] of [
        ["{", 400],
        [JSON.stringify(body).padEnd(8193), 413],
      ] as const) {
        expect(
          (
            await request(path, {
              method: "POST",
              headers: {
                origin,
                cookie: token,
                "content-type": "application/json",
                "content-length": "1",
              },
              body: raw,
            })
          ).status,
        ).toBe(status);
      }
    }
  });

  it("reset revokes all target sessions, even for an unchanged password, without revoking others", async () => {
    const token = await owner();
    const user = await member(token);
    await member(token, "bob");
    const first = cookie(await login("alice", password));
    const second = cookie(await login("alice", password));
    const bob = cookie(await login("bob", password));
    expect((await reset(token, user.id, password)).status).toBe(200);
    for (const dead of [first, second]) expect((await session(dead)).status).toBe(401);
    for (const live of [token, bob]) expect((await session(live)).status).toBe(200);
    expect((await login("alice", password)).status).toBe(200);
    expect((await reset(token, user.id)).status).toBe(200);
    expect((await login("alice", password)).status).toBe(401);
    expect((await login("alice", replacement)).status).toBe(200);
  });

  it.each(["create", "reset"])(
    "rechecks owner session at the %s SQL boundary after logout",
    async (operation) => {
      const token = await owner();
      const user = await member(token);
      const paused = pauseBatches();
      const pending =
        operation === "create"
          ? create(token, "bob", password, { DB: paused.db })
          : reset(token, user.id, replacement, { DB: paused.db });
      await paused.waiting;
      try {
        expect((await post("/api/auth/logout", token, {})).status).toBe(200);
      } finally {
        paused.release();
      }
      expect((await pending).status).toBe(409);
      expect((await login("alice", password)).status).toBe(200);
      expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(1);
    },
  );

  it("rejects a member login when a concurrent reset wins its CAS", async () => {
    const token = await owner();
    const user = await member(token);
    const paused = pauseBatches();
    const pending = login("alice", password, { DB: paused.db });
    await paused.waiting;
    try {
      expect((await reset(token, user.id)).status).toBe(200);
    } finally {
      paused.release();
    }
    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(
      await bindings.DB.prepare("SELECT COUNT(*) AS n FROM session_users WHERE user_id = ?")
        .bind(user.id)
        .first("n"),
    ).toBe(0);
  });

  it("preserves another member's cookie when the replacement login loses to a reset", async () => {
    const token = await owner();
    const alice = await member(token);
    const bob = await member(token, "bob");
    const previous = cookie(await login("bob", password));
    const previousHash = await sha256(previous.split("=")[1]);
    const before = await bindings.DB.prepare("SELECT * FROM sessions WHERE token_hash = ?")
      .bind(previousHash)
      .first();
    const paused = pauseBatches();
    const pending = post(
      "/api/auth/login",
      previous,
      { username: "alice", password },
      { DB: paused.db },
    );
    await paused.waiting;
    try {
      expect((await reset(token, alice.id)).status).toBe(200);
    } finally {
      paused.release();
    }
    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await session(previous)).status).toBe(200);
    expect(
      await bindings.DB.prepare("SELECT * FROM sessions WHERE token_hash = ?")
        .bind(previousHash)
        .first(),
    ).toEqual(before);
    expect(
      await bindings.DB.prepare("SELECT * FROM session_users WHERE token_hash = ?")
        .bind(previousHash)
        .first(),
    ).toEqual({ token_hash: previousHash, user_id: bob.id });
    expect(
      await bindings.DB.prepare("SELECT COUNT(*) AS n FROM session_users WHERE user_id = ?")
        .bind(alice.id)
        .first("n"),
    ).toBe(0);
  });

  it("rechecks member self-change after reset and after logout", async () => {
    const token = await owner();
    const user = await member(token);
    for (const operation of ["reset", "logout"]) {
      const own = cookie(await login("alice", password));
      const paused = pauseBatches();
      const pending = change(own, password, replacement, { DB: paused.db });
      await paused.waiting;
      try {
        expect(
          (operation === "reset"
            ? await reset(token, user.id, password)
            : await post("/api/auth/logout", own, {})
          ).status,
        ).toBe(200);
      } finally {
        paused.release();
      }
      expect((await pending).status).toBe(409);
    }
  });

  it("rolls back session and previous-cookie revocation if mapping insertion fails", async () => {
    const token = await owner();
    await member(token);
    const own = cookie(await login("alice", password));
    await bindings.DB.prepare(
      "CREATE TRIGGER reject_mapping BEFORE INSERT ON session_users BEGIN SELECT RAISE(ABORT, 'test'); END",
    ).run();
    try {
      const response = await post("/api/auth/login", own, { username: "alice", password });
      expect(response.status).toBe(500);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect((await session(own)).status).toBe(200);
      expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(2);
    } finally {
      await bindings.DB.prepare("DROP TRIGGER reject_mapping").run();
    }
  });

  it.each(["create", "reset"])(
    "rechecks owner revision at the %s write boundary",
    async (operation) => {
      const token = await owner();
      const user = await member(token);
      const paused = pauseBatches();
      const pending =
        operation === "create"
          ? create(token, "bob", password, { DB: paused.db })
          : reset(token, user.id, replacement, { DB: paused.db });
      await paused.waiting;
      try {
        expect((await change(token, "admin")).status).toBe(200);
      } finally {
        paused.release();
      }
      expect((await pending).status).toBe(409);
      expect((await login("alice", password)).status).toBe(200);
      expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(1);
    },
  );

  it("allows a member login to finish across an owner password change", async () => {
    const token = await owner();
    await member(token);
    const paused = pauseBatches();
    const pending = login("alice", password, { DB: paused.db });
    await paused.waiting;
    try {
      expect((await change(token, "admin")).status).toBe(200);
    } finally {
      paused.release();
    }
    const response = await pending;
    expect(response.status).toBe(200);
    expect((await session(cookie(response))).status).toBe(200);
  });

  it("allows exactly one concurrent member self-change", async () => {
    await member(await owner());
    const own = cookie(await login("alice", password));
    const paused = pauseBatches(2);
    const values = [replacement, "different replacement 789"];
    const pending = values.map((value) => change(own, password, value, { DB: paused.db }));
    await paused.waiting;
    paused.release();
    const responses = await Promise.all(pending);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = responses.findIndex((r) => r.status === 200);
    expect((await login("alice", values[winner])).status).toBe(200);
    expect((await login("alice", values[1 - winner])).status).toBe(401);
  });

  it("checks expiry at the admin write boundary", async () => {
    const token = await owner();
    const paused = pauseBatches();
    const pending = create(token, "alice", password, { DB: paused.db });
    await paused.waiting;
    try {
      await bindings.DB.prepare("UPDATE sessions SET expires_at = 1").run();
    } finally {
      paused.release();
    }
    expect((await pending).status).toBe(409);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(0);
  });

  it("rolls back member reset and revocation together on storage failure", async () => {
    const token = await owner();
    const user = await member(token);
    const own = cookie(await login("alice", password));
    await bindings.DB.prepare(
      "CREATE TRIGGER reject_revoke BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'test'); END",
    ).run();
    try {
      expect((await reset(token, user.id)).status).toBe(500);
      expect((await session(own)).status).toBe(200);
      expect((await login("alice", password)).status).toBe(200);
    } finally {
      await bindings.DB.prepare("DROP TRIGGER reject_revoke").run();
    }
  });
});

describe("optional expected-principal header", () => {
  it.each(["owner", "member"])("accepts the matching %s ID and omitted headers", async (actor) => {
    const ownerToken = await owner();
    const alice = await member(ownerToken);
    const token = actor === "owner" ? ownerToken : cookie(await login("alice", password));
    const id = actor === "owner" ? "owner" : alice.id;
    const response = await request("/api/auth/session", {
      headers: { cookie: token, "X-Plato-User": id },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { user: Principal }).user.id).toBe(id);
    expect((await session(token)).status).toBe(200);
    const logout = await request("/api/auth/logout", {
      method: "POST",
      headers: { origin, cookie: token, "X-Plato-User": id },
    });
    expect(logout.status).toBe(200);
    expect((await session(token)).status).toBe(401);
  });

  it.each([
    ["owner", "alice"],
    ["alice", "owner"],
    ["alice", "bob"],
    ["owner", "user"],
    ["alice", "user"],
    ["owner", ""],
  ])(
    "rejects %s cookie with expected %s without state or cookie changes",
    async (actor, expected) => {
      const ownerToken = await owner();
      const alice = await member(ownerToken);
      const bob = await member(ownerToken, "bob");
      const token = actor === "owner" ? ownerToken : cookie(await login("alice", password));
      const expectedId = expected === "alice" ? alice.id : expected === "bob" ? bob.id : expected;
      const snapshot = () =>
        bindings.DB.batch([
          bindings.DB.prepare("SELECT * FROM sessions ORDER BY token_hash"),
          bindings.DB.prepare("SELECT * FROM session_users ORDER BY token_hash"),
          bindings.DB.prepare("SELECT * FROM users ORDER BY id"),
          bindings.DB.prepare("SELECT * FROM app_credentials"),
          bindings.DB.prepare("SELECT * FROM rate_limits ORDER BY key"),
        ]).then((results) => results.map((result) => result.results));
      const before = await snapshot();
      for (const [path, method, body] of [
        ["/api/auth/session", "GET", undefined],
        ["/api/inboxes", "GET", undefined],
        ["/api/admin/users", "GET", undefined],
        ["/api/admin/users", "POST", { username: "charlie", password }],
        [`/api/admin/users/${bob.id}/password`, "POST", { password: replacement }],
        ["/api/auth/logout", "POST", {}],
        [
          "/api/auth/password",
          "POST",
          {
            currentPassword: actor === "owner" ? "admin" : password,
            newPassword: replacement,
          },
        ],
      ] as const) {
        const response = await request(path, {
          method,
          headers: {
            origin,
            cookie: token,
            "content-type": "application/json",
            "X-Plato-User": expectedId,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
          error: { code: "SESSION_CHANGED", message: "Session changed. Reload and try again." },
        });
        expect(response.headers.get("set-cookie")).toBeNull();
      }
      expect(await snapshot()).toEqual(before);
      expect((await session(token)).status).toBe(200);
    },
  );

  it("ignores the expected-principal header on login", async () => {
    const token = await owner();
    const alice = await member(token);
    const response = await request("/api/auth/login", {
      method: "POST",
      headers: { origin, "content-type": "application/json", "X-Plato-User": "owner" },
      body: JSON.stringify({ username: "alice", password }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { user: Principal }).user).toEqual({
      id: alice.id,
      username: "alice",
      role: "user",
      roles: ["member"],
    });
  });
});
