import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const origin = "https://mail.example.com";
const password = "member password 123";
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

function send(
  method: "POST" | "DELETE",
  path: string,
  cookie: string,
  body?: unknown,
  overrides: Partial<Env> = {},
) {
  return request(
    path,
    {
      method,
      headers: {
        origin,
        cookie,
        "cf-connecting-ip": `192.0.2.${++client}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    overrides,
  );
}

const post = (path: string, cookie: string, body: unknown, overrides: Partial<Env> = {}) =>
  send("POST", path, cookie, body, overrides);

const remove = (path: string, cookie: string, overrides: Partial<Env> = {}) =>
  send("DELETE", path, cookie, undefined, overrides);

const login = (username: string, value: string) =>
  post("/api/auth/login", "", { username, password: value });

function cookieOf(response: Response) {
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function ownerSession() {
  const response = await login("admin", "admin");
  expect(response.status).toBe(200);
  return cookieOf(response);
}

async function account(
  ownerCookie: string,
  username: string,
  roles: string[],
): Promise<{ id: string; username: string }> {
  const response = await post("/api/admin/users", ownerCookie, { username, password, roles });
  expect(response.status).toBe(201);
  return ((await response.json()) as { user: { id: string; username: string } }).user;
}

async function sessionFor(username: string) {
  const response = await login(username, password);
  expect(response.status).toBe(200);
  return cookieOf(response);
}

beforeAll(() => applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS));

beforeEach(async () => {
  client = 0;
  await bindings.DB.batch([
    bindings.DB.prepare("DELETE FROM sessions"),
    bindings.DB.prepare("DELETE FROM inboxes"),
    bindings.DB.prepare("DELETE FROM address_claims"),
    bindings.DB.prepare("DELETE FROM password_resets"),
    bindings.DB.prepare("DELETE FROM rate_limits"),
    bindings.DB.prepare("DELETE FROM users"),
    bindings.DB.prepare("DELETE FROM app_credentials"),
  ]);
});

describe("member deletion", () => {
  it("refuses a plain member", async () => {
    const owner = await ownerSession();
    const alice = await account(owner, "alice", ["member"]);
    await account(owner, "bob", ["member"]);
    const aliceCookie = await sessionFor("alice");
    const response = await remove(`/api/admin/users/${alice.id}`, aliceCookie);
    expect(response.status).toBe(403);
  });

  it("lets an admin delete a member with its inbox, messages and sessions", async () => {
    const owner = await ownerSession();
    const admin = await account(owner, "admin2", ["admin"]);
    const guest = await account(owner, "guest", ["member"]);
    const guestCookie = await sessionFor("guest");
    const inbox = await post("/api/inboxes", guestCookie, { localPart: "guestbox" });
    expect(inbox.status).toBe(201);
    const inboxId = ((await inbox.json()) as { inbox: { id: string } }).inbox.id;
    const now = Math.floor(Date.now() / 1000);
    await bindings.DB.prepare(
      `INSERT INTO messages (id, inbox_id, from_address, subject, body, received_at, expires_at, raw_digest)
       VALUES ('msg-1', ?, 'a@b.test', 's', 'b', ?, ?, 'digest-1')`,
    )
      .bind(inboxId, now, now + 3600)
      .run();
    await bindings.DB.prepare(
      `INSERT INTO password_resets (token_hash, user_id, username, created_at, expires_at)
       VALUES ('hash-1', ?, 'guest', ?, ?)`,
    )
      .bind(guest.id, now, now + 600)
      .run();

    const adminCookie = await sessionFor("admin2");
    const response = await remove(`/api/admin/users/${guest.id}`, adminCookie);
    expect(response.status).toBe(200);

    expect((await session(guestCookie)).status).toBe(401);
    expect((await login("guest", password)).status).toBe(401);
    const counts = await bindings.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM users WHERE id = ?) AS users,
              (SELECT COUNT(*) FROM inboxes WHERE id = ?) AS inboxes,
              (SELECT COUNT(*) FROM messages WHERE inbox_id = ?) AS messages,
              (SELECT COUNT(*) FROM password_resets WHERE user_id = ?) AS resets,
              (SELECT COUNT(*) FROM address_claims WHERE user_id = ?) AS claims`,
    )
      .bind(guest.id, inboxId, inboxId, guest.id, guest.id)
      .first<Record<string, number>>();
    expect(counts).toEqual({ users: 0, inboxes: 0, messages: 0, resets: 0, claims: 0 });
    expect(admin.id).toBeTruthy();
  });

  it("stops an admin from deleting another admin", async () => {
    const owner = await ownerSession();
    await account(owner, "admin2", ["admin"]);
    const other = await account(owner, "admin3", ["admin"]);
    const cookie = await sessionFor("admin2");
    const response = await remove(`/api/admin/users/${other.id}`, cookie);
    expect(response.status).toBe(403);
  });

  it("lets a dev delete a member but not create or reset one", async () => {
    const owner = await ownerSession();
    await account(owner, "dev1", ["dev"]);
    const guest = await account(owner, "guest", ["member"]);
    const devCookie = await sessionFor("dev1");

    const list = await request("/api/admin/users", { headers: { cookie: devCookie } });
    expect(list.status).toBe(200);

    const create = await post("/api/admin/users", devCookie, {
      username: "nope",
      password,
      roles: ["member"],
    });
    expect(create.status).toBe(403);

    const reset = await post(`/api/admin/users/${guest.id}/password`, devCookie, {
      password: "new password 789",
    });
    expect(reset.status).toBe(403);

    const response = await remove(`/api/admin/users/${guest.id}`, devCookie);
    expect(response.status).toBe(200);
  });

  it("protects the bootstrap owner and the caller's own account", async () => {
    const owner = await ownerSession();
    expect((await remove("/api/admin/users/owner", owner)).status).toBe(403);

    const admin = await account(owner, "admin-self", ["admin"]);
    const adminCookie = await sessionFor("admin-self");
    const self = await remove(`/api/admin/users/${admin.id}`, adminCookie);
    expect(self.status).toBe(400);

    const guest = await account(owner, "guest", ["member"]);
    const guestCookie = await sessionFor("guest");
    expect((await remove(`/api/admin/users/${guest.id}`, guestCookie)).status).toBe(403);
  });
});

function session(cookie: string) {
  return request("/api/auth/session", { headers: { cookie } });
}
