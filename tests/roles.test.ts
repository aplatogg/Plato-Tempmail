import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env, Principal } from "../src/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const origin = "https://mail.example.com";
const password = "role test password";
const allRoles = ["member", "dev", "admin", "owner"];
let client = 0;

async function request(
  path: string,
  token = "",
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  db = bindings.DB,
  expected?: string,
) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        origin,
        cookie: token,
        "content-type": "application/json",
        "cf-connecting-ip": `192.0.2.${++client}`,
        ...(expected === undefined ? {} : { "X-Plato-User": expected }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...bindings, APP_NAME: "Plato", DB: db },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
const cookie = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";
const login = (username = "admin", value = "admin", db = bindings.DB, token = "") =>
  request("/api/auth/login", token, { username, password: value }, "POST", db);
const session = (token: string) => request("/api/auth/session", token);
const edit = (token: string, id: string, roles: unknown, db = bindings.DB) =>
  request(`/api/admin/users/${id}/roles`, token, { roles }, "PATCH", db);
const reset = (token: string, id: string, db = bindings.DB) =>
  request(`/api/admin/users/${id}/password`, token, { password: "replacement" }, "POST", db);
async function root() {
  const response = await login();
  expect(response.status).toBe(200);
  return cookie(response);
}
async function create(token: string, username: string, roles?: string[]) {
  const response = await request("/api/admin/users", token, {
    username,
    password,
    ...(roles === undefined ? {} : { roles }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { user: Principal & { createdAt: number } }).user;
}
function pauseBatch() {
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
          ready();
          await gate;
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, waiting, release };
}

function pauseQuery(fragment: string) {
  let ready!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === "first" || key === "all")
          return async (...args: []) => {
            ready();
            await gate;
            return target[key](...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const db = new Proxy(bindings.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) =>
          sql.includes(fragment) ? wrap(target.prepare(sql)) : target.prepare(sql);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, waiting, release };
}

beforeAll(() => applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  client = 0;
  await bindings.DB.batch(
    ["sessions", "users", "inboxes", "app_credentials", "rate_limits", "address_claims"].map(
      (table) => bindings.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});

describe("fixed additive role contract", () => {
  const masks = Array.from({ length: 15 }, (_, i) => i + 1);
  it.each(masks)("enforces permissions for mask %i", async (mask) => {
    const token = await root();
    const roles = allRoles.filter((_, index) => mask & (1 << index));
    const user = await create(token, "actor", [...roles].reverse());
    expect(user).toEqual({
      id: expect.any(String),
      username: "actor",
      role: mask & 8 ? "owner" : "user",
      roles,
      createdAt: expect.any(Number),
    });
    const loggedIn = await login("actor", password);
    expect(loggedIn.status).toBe(200);
    const identity = { id: user.id, username: "actor", role: user.role, roles };
    const payload = { user: identity, mailDomain: "example.com", retentionDays: 7 };
    expect(await loggedIn.json()).toEqual(payload);
    const own = cookie(loggedIn);
    expect(await (await session(own)).json()).toEqual(payload);
    const list = await request("/api/admin/users", own);
    expect(list.status).toBe(mask & 12 ? 200 : 403);
    if (!(mask & 12)) {
      expect((await edit(own, user.id, ["owner"])).status).toBe(403);
      expect((await reset(own, user.id)).status).toBe(403);
      expect(
        (await request("/api/admin/users", own, { username: "forbidden", password })).status,
      ).toBe(403);
    }
    if (mask & 12)
      expect(await list.json()).toEqual({
        users: [
          { id: "owner", username: "admin", role: "owner", roles: ["owner"], createdAt: null },
          user,
        ],
        assignableRoles: mask & 8 ? allRoles : ["member", "dev"],
      });
    const diagnostics = await request("/api/dev/diagnostics", own);
    expect(diagnostics.status).toBe(mask & 10 ? 200 : 403);
    if (mask & 10)
      expect(await diagnostics.json()).toEqual({
        ok: true,
        application: { name: "Plato", mailDomain: "example.com", retentionDays: 7 },
        database: { ok: true },
        counts: { users: 1, inboxes: 0, messages: 0 },
      });
    expect((await request("/api/inboxes", own, { localPart: "own" })).status).toBe(201);
  });

  it("defaults legacy creation to member and edits canonical roles with revision/revocation", async () => {
    const token = await root();
    const user = await create(token, "alice");
    expect(user).toMatchObject({ role: "user", roles: ["member"] });
    const first = cookie(await login("alice", password));
    const second = cookie(await login("alice", password));
    const updated = await edit(token, user.id, ["admin", "member", "dev"]);
    expect(updated.status).toBe(200);
    expect(updated.headers.get("set-cookie")).toBeNull();
    expect(await updated.json()).toEqual({ user: { ...user, roles: ["member", "dev", "admin"] } });
    expect(
      await bindings.DB.prepare("SELECT role_mask, revision FROM users WHERE id = ?")
        .bind(user.id)
        .first(),
    ).toEqual({ role_mask: 7, revision: 2 });
    for (const dead of [first, second]) expect((await session(dead)).status).toBe(401);
    expect((await session(token)).status).toBe(200);
  });

  it.each([
    [],
    ["member", "member"],
    ["Member"],
    ["unknown"],
    [1],
    null,
    "owner",
    {},
    ["member", null],
  ])("rejects malformed roles (%#)", async (roles) => {
    const token = await root();
    const user = await create(token, "alice");
    expect(
      (await request("/api/admin/users", token, { username: "invalid", password, roles })).status,
    ).toBe(400);
    expect((await edit(token, user.id, roles)).status).toBe(400);
    expect(
      await bindings.DB.prepare("SELECT revision FROM users WHERE id = ?")
        .bind(user.id)
        .first("revision"),
    ).toBe(1);
  });

  it("protects root roles/password even from other owners and validates role bodies", async () => {
    const token = await root();
    const other = await create(token, "other", ["owner"]);
    const own = cookie(await login("other", password));
    for (const actor of [token, own]) {
      expect((await edit(actor, "owner", ["member"])).status).toBe(403);
      expect((await reset(actor, "owner")).status).toBe(403);
    }
    for (const body of [{}, { roles: ["member"], role: "owner" }]) {
      expect(
        (await request(`/api/admin/users/${other.id}/roles`, token, body, "PATCH")).status,
      ).toBe(400);
    }
    expect((await edit(token, crypto.randomUUID(), ["dev"])).status).toBe(404);
    expect((await login()).status).toBe(200);
  });

  it.each([4, 5, 6, 7])("restricts admin mask %i targets and assignments", async (mask) => {
    const token = await root();
    const actor = await create(
      token,
      "actor",
      allRoles.filter((_, i) => mask & (1 << i)),
    );
    const own = cookie(await login("actor", password));
    const target = await create(own, "target", ["dev", "member"]);
    expect((await reset(own, target.id)).status).toBe(200);
    expect((await edit(own, target.id, ["dev"])).status).toBe(200);
    for (const roles of [["admin"], ["owner"], ["member", "dev", "admin", "owner"]]) {
      expect(
        (await request("/api/admin/users", own, { username: "elevate", password, roles })).status,
      ).toBe(403);
      expect((await edit(own, target.id, roles)).status).toBe(403);
    }
    for (const roles of [["admin"], ["owner"], ["admin", "owner"]]) {
      const elevated = await create(token, `high${roles.length}${roles[0]}`, roles);
      expect((await reset(own, elevated.id)).status).toBe(403);
      expect((await edit(own, elevated.id, ["member"])).status).toBe(403);
      expect((await reset(token, elevated.id)).status).toBe(200);
      expect((await edit(token, elevated.id, ["dev"])).status).toBe(200);
    }
    expect((await edit(own, actor.id, ["member"])).status).toBe(403);
    expect((await reset(own, actor.id)).status).toBe(403);
    expect(
      (
        await request("/api/auth/password", own, {
          currentPassword: password,
          newPassword: "new self password",
        })
      ).status,
    ).toBe(200);
  });

  it("stored owner self-change never touches bootstrap credentials or sessions", async () => {
    const token = await root();
    await create(token, "other", ["owner", "dev"]);
    const own = cookie(await login("other", password));
    expect(
      (
        await request("/api/auth/password", own, {
          currentPassword: password,
          newPassword: "changed stored owner",
        })
      ).status,
    ).toBe(200);
    expect(await bindings.DB.prepare("SELECT * FROM app_credentials").first()).toBeNull();
    expect((await session(own)).status).toBe(401);
    expect((await session(token)).status).toBe(200);
    expect((await login()).status).toBe(200);
    expect((await login("other", "changed stored owner")).status).toBe(200);
    expect((await login("other", password)).status).toBe(401);
  });

  it.each(allRoles)("isolates other-mail reads and writes for %s", async (role) => {
    const token = await root();
    await create(token, "actor", [role]);
    const own = cookie(await login("actor", password));
    const inbox = await request("/api/inboxes", token, { localPart: "private" });
    const {
      inbox: { id },
    } = (await inbox.json()) as { inbox: { id: string } };
    await bindings.DB.prepare(
      "INSERT INTO messages VALUES ('message', ?, 'sender@example.net', 'subject', 'body', unixepoch(), unixepoch()+3600, ?)",
    )
      .bind(id, "a".repeat(64))
      .run();
    expect((await request("/api/inboxes?userId=owner", own)).status).toBe(
      role === "owner" ? 200 : 403,
    );
    expect((await request(`/api/inboxes/${id}/messages`, own)).status).toBe(
      role === "owner" ? 200 : 404,
    );
    expect((await request("/api/messages/message", own)).status).toBe(role === "owner" ? 200 : 404);
    for (const [path, method, body] of [
      [`/api/inboxes/${id}`, "PATCH", { favorite: true }],
      ["/api/messages/message", "PATCH", { isRead: true }],
      ["/api/messages/message", "DELETE", undefined],
      [`/api/inboxes/${id}`, "DELETE", undefined],
    ] as const)
      expect((await request(path, own, body, method)).status).toBe(404);
    expect(await bindings.DB.prepare("SELECT COUNT(*) n FROM messages").first("n")).toBe(1);
  });
});

describe("role identity freshness and atomic race guards", () => {
  it.each([0, 16, 1.5, "8", null])("rejects corrupt persisted role state (%#)", async (mask) => {
    const token = await root();
    await create(token, "actor", ["owner"]);
    const own = cookie(await login("actor", password));
    // Simulate corrupt storage at the row boundary without disabling DB constraints.
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, key) {
          if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
          if (key === "first")
            return async () => {
              const row = await target.first();
              return row ? { ...row, role_mask: mask } : row;
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const db = new Proxy(bindings.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) =>
            sql.startsWith("SELECT id, username, password_verifier, revision, role_mask")
              ? wrap(target.prepare(sql))
              : target.prepare(sql);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect((await login("actor", password, db)).status).toBe(401);
    expect((await request("/api/auth/session", own, undefined, "GET", db)).status).toBe(401);
    expect((await session(token)).status).toBe(200);
  });

  it.each(["directory", "diagnostics"])("guards stale %s reads", async (operation) => {
    const token = await root();
    const actor = await create(token, "actor", ["owner"]);
    const own = cookie(await login("actor", password));
    const paused =
      operation === "directory"
        ? pauseBatch()
        : pauseQuery("(SELECT COUNT(*) FROM users) AS users");
    const path = operation === "directory" ? "/api/admin/users" : "/api/dev/diagnostics";
    const pending = request(path, own, undefined, "GET", paused.db);
    await paused.waiting;
    try {
      await bindings.DB.prepare("UPDATE users SET role_mask = 1 WHERE id = ?").bind(actor.id).run();
    } finally {
      paused.release();
    }
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "CREDENTIALS_CHANGED", message: "Credentials changed. Log in again." },
    });
  });

  it.each([
    ["/api/inboxes?userId=owner", "FROM inboxes LEFT JOIN inbox_favorites"],
    ["/api/inboxes/private/messages", "SELECT id, from_address AS"],
    ["/api/messages/message", "SELECT id,inbox_id AS"],
  ])("guards %s reads after owner demotion", async (path, fragment) => {
    const token = await root();
    const actor = await create(token, "actor", ["owner"]);
    const own = cookie(await login("actor", password));
    await bindings.DB.prepare(
      "INSERT INTO inboxes VALUES ('private', 'private@example.com', 1)",
    ).run();
    await bindings.DB.prepare(
      "INSERT INTO messages VALUES ('message', 'private', 'private-sender@example.net', 'private-subject', 'private-body', unixepoch(), unixepoch()+3600, ?)",
    )
      .bind("c".repeat(64))
      .run();
    const paused = pauseQuery(fragment);
    const pending = request(path, own, undefined, "GET", paused.db);
    await paused.waiting;
    try {
      await bindings.DB.prepare("UPDATE users SET role_mask = 1 WHERE id = ?").bind(actor.id).run();
    } finally {
      paused.release();
    }
    const response = await pending;
    const body = await response.text();
    expect(body).not.toContain("private");
  });

  it("same-role API edit still bumps revision and revokes sessions; self-demotion is cookie-neutral", async () => {
    const token = await root();
    const actor = await create(token, "actor", ["owner"]);
    const own = cookie(await login("actor", password));
    expect((await edit(token, actor.id, ["owner"])).status).toBe(200);
    expect((await session(own)).status).toBe(401);
    const next = cookie(await login("actor", password));
    const response = await edit(next, actor.id, ["member"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({ user: { ...actor, role: "user", roles: ["member"] } });
    expect((await session(next)).status).toBe(401);
    expect(
      await bindings.DB.prepare("SELECT revision FROM users WHERE id = ?")
        .bind(actor.id)
        .first("revision"),
    ).toBe(3);
  });

  it("rolls back role changes and revision if session revocation fails", async () => {
    const token = await root();
    const actor = await create(token, "actor", ["dev"]);
    const own = cookie(await login("actor", password));
    await bindings.DB.prepare(
      "CREATE TRIGGER reject_role_revoke BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'test'); END",
    ).run();
    try {
      expect((await edit(token, actor.id, ["owner"])).status).toBe(500);
      expect((await session(own)).status).toBe(200);
      expect(
        await bindings.DB.prepare("SELECT role_mask, revision FROM users WHERE id = ?")
          .bind(actor.id)
          .first(),
      ).toEqual({ role_mask: 2, revision: 1 });
    } finally {
      await bindings.DB.prepare("DROP TRIGGER reject_role_revoke").run();
    }
  });

  it("role-only SQL changes revoke mapped sessions without touching another principal", async () => {
    const token = await root();
    const user = await create(token, "actor", ["owner"]);
    const own = cookie(await login("actor", password));
    await bindings.DB.prepare("UPDATE users SET role_mask = 1 WHERE id = ?").bind(user.id).run();
    expect(
      await bindings.DB.prepare("SELECT revision FROM users WHERE id = ?")
        .bind(user.id)
        .first("revision"),
    ).toBe(1);
    expect(
      await bindings.DB.prepare("SELECT COUNT(*) n FROM session_users WHERE user_id = ?")
        .bind(user.id)
        .first("n"),
    ).toBe(0);
    expect((await session(own)).status).toBe(401);
    expect((await session(token)).status).toBe(200);
  });

  it.each([
    "create",
    "reset",
    "roles",
    "password",
    "inbox",
    "favorite",
    "delete-inbox",
    "read-state",
    "delete-message",
  ])("rejects stale actor at %s write boundary", async (operation) => {
    const token = await root();
    const actor = await create(token, "actor", ["owner", "admin"]);
    const target = await create(token, "target");
    const own = cookie(await login("actor", password));
    const inboxResponse = await request("/api/inboxes", own, { localPart: "actorbox" });
    const {
      inbox: { id },
    } = (await inboxResponse.json()) as { inbox: { id: string } };
    await bindings.DB.prepare(
      "INSERT INTO messages VALUES ('message', ?, 'sender@example.net', 'subject', 'body', unixepoch(), unixepoch()+3600, ?)",
    )
      .bind(id, "b".repeat(64))
      .run();
    const paused = pauseBatch();
    const operations: Record<string, () => Promise<Response>> = {
      create: () =>
        request("/api/admin/users", own, { username: "newuser", password }, "POST", paused.db),
      reset: () => reset(own, target.id, paused.db),
      roles: () => edit(own, target.id, ["dev"], paused.db),
      password: () =>
        request(
          "/api/auth/password",
          own,
          { currentPassword: password, newPassword: "replacement" },
          "POST",
          paused.db,
        ),
      inbox: () => request("/api/inboxes", own, { localPart: "late" }, "POST", paused.db),
      favorite: () => request(`/api/inboxes/${id}`, own, { favorite: true }, "PATCH", paused.db),
      "delete-inbox": () => request(`/api/inboxes/${id}`, own, undefined, "DELETE", paused.db),
      "read-state": () =>
        request("/api/messages/message", own, { isRead: true }, "PATCH", paused.db),
      "delete-message": () => request("/api/messages/message", own, undefined, "DELETE", paused.db),
    };
    const pending = operations[operation]();
    await paused.waiting;
    try {
      await bindings.DB.prepare("UPDATE users SET role_mask = 1 WHERE id = ?").bind(actor.id).run();
    } finally {
      paused.release();
    }
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "CREDENTIALS_CHANGED" } });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await login("actor", password)).status).toBe(200);
    expect((await login("target", password)).status).toBe(200);
    expect(await bindings.DB.prepare("SELECT COUNT(*) n FROM users").first("n")).toBe(2);
    expect(await bindings.DB.prepare("SELECT COUNT(*) n FROM inboxes").first("n")).toBe(1);
    expect(await bindings.DB.prepare("SELECT COUNT(*) n FROM messages").first("n")).toBe(1);
    expect(await bindings.DB.prepare("SELECT COUNT(*) n FROM inbox_favorites").first("n")).toBe(0);
    expect(await bindings.DB.prepare("SELECT COUNT(*) n FROM message_read_state").first("n")).toBe(
      0,
    );
    expect(
      await bindings.DB.prepare("SELECT role_mask FROM users WHERE id = ?")
        .bind(target.id)
        .first("role_mask"),
    ).toBe(1);
    expect(await bindings.DB.prepare("SELECT * FROM app_credentials").first()).toBeNull();
  });

  it.each(["reset", "roles"])("guards target promotion during %s", async (operation) => {
    const token = await root();
    await create(token, "actor", ["admin", "dev"]);
    const target = await create(token, "target");
    const own = cookie(await login("actor", password));
    const paused = pauseBatch();
    const pending =
      operation === "reset"
        ? reset(own, target.id, paused.db)
        : edit(own, target.id, ["dev"], paused.db);
    await paused.waiting;
    try {
      expect((await edit(token, target.id, ["admin", "owner"])).status).toBe(200);
    } finally {
      paused.release();
    }
    expect((await pending).status).toBe(403);
    expect((await login("target", password)).status).toBe(200);
    expect(
      await bindings.DB.prepare("SELECT role_mask, revision FROM users WHERE id = ?")
        .bind(target.id)
        .first(),
    ).toEqual({ role_mask: 12, revision: 2 });
  });

  it("login racing a role-only update fails CAS and preserves previous account cookie", async () => {
    const token = await root();
    const actor = await create(token, "actor", ["owner"]);
    await create(token, "previous");
    const previous = cookie(await login("previous", password));
    const paused = pauseBatch();
    const pending = login("actor", password, paused.db, previous);
    await paused.waiting;
    try {
      await bindings.DB.prepare("UPDATE users SET role_mask = 1 WHERE id = ?").bind(actor.id).run();
    } finally {
      paused.release();
    }
    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await session(previous)).status).toBe(200);
    expect(
      await bindings.DB.prepare("SELECT COUNT(*) n FROM session_users WHERE user_id = ?")
        .bind(actor.id)
        .first("n"),
    ).toBe(0);
  });

  it("new admin/dev APIs respect cookie principal switches without clearing the new cookie", async () => {
    const token = await root();
    const first = await create(token, "first", ["owner"]);
    await create(token, "second", ["owner"]);
    const own = cookie(await login("second", password));
    for (const [path, body, method] of [
      ["/api/dev/diagnostics", undefined, "GET"],
      [`/api/admin/users/${first.id}/roles`, { roles: ["dev"] }, "PATCH"],
    ] as const) {
      const response = await request(path, own, body, method, bindings.DB, first.id);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "SESSION_CHANGED" } });
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect((await session(own)).status).toBe(200);
  });
});
