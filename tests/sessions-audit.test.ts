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
const sent: string[] = [];
const mail = {
  send: async (message: { text: string }) => {
    sent.push(message.text);
    return { messageId: `m-${sent.length}` };
  },
} as unknown as Env["RESET_EMAIL"];
let client = 0;

async function request(
  path: string,
  init: RequestInit = {},
  overrides: Partial<Env> = { RESET_EMAIL: mail, RESET_EMAIL_TO: "owner@example.net" },
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

function call(method: string, path: string, cookie: string, body?: unknown, ua = "test-agent") {
  return request(path, {
    method,
    headers: {
      origin,
      cookie,
      "cf-connecting-ip": `192.0.2.${++client}`,
      "user-agent": ua,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const login = (username: string, value: string, ua = "test-agent") =>
  call("POST", "/api/auth/login", "", { username, password: value }, ua);

function cookieOf(response: Response) {
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function owner(ua = "owner-agent") {
  const response = await login("admin", "admin", ua);
  expect(response.status).toBe(200);
  return cookieOf(response);
}

beforeAll(() => applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS));

beforeEach(async () => {
  client = 0;
  sent.length = 0;
  await bindings.DB.batch([
    bindings.DB.prepare("DELETE FROM sessions"),
    bindings.DB.prepare("DELETE FROM password_resets"),
    bindings.DB.prepare("DELETE FROM audit_log"),
    bindings.DB.prepare("DELETE FROM rate_limits"),
    bindings.DB.prepare("DELETE FROM users"),
    bindings.DB.prepare("DELETE FROM inboxes"),
    bindings.DB.prepare("DELETE FROM address_claims"),
    bindings.DB.prepare("DELETE FROM app_credentials"),
  ]);
});

describe("session management", () => {
  it("lists sessions, marks the current one and revokes a single device", async () => {
    const first = await owner("device-a");
    const second = await login("admin", "admin", "device-b");
    expect(second.status).toBe(200);
    const secondCookie = cookieOf(second);

    const listed = await call("GET", "/api/auth/sessions", first);
    expect(listed.status).toBe(200);
    const { sessions } = (await listed.json()) as {
      sessions: { id: number; userAgent: string; current: boolean }[];
    };
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((session) => session.current)).toHaveLength(1);
    expect(sessions.map((session) => session.userAgent)).toContain("device-b");

    const other = sessions.find((session) => !session.current);
    expect(other).toBeTruthy();
    if (!other) throw new Error("missing non-current session");
    expect((await call("DELETE", `/api/auth/sessions/${other.id}`, first)).status).toBe(200);
    expect((await call("GET", "/api/auth/session", secondCookie)).status).toBe(401);
    expect((await call("GET", "/api/auth/session", first)).status).toBe(200);
  });

  it("revokes every other session and keeps the caller signed in", async () => {
    const first = await owner("device-a");
    for (const ua of ["device-b", "device-c"]) {
      expect((await login("admin", "admin", ua)).status).toBe(200);
    }
    const before = (await (await call("GET", "/api/auth/sessions", first)).json()) as {
      sessions: unknown[];
    };
    const revoked = await call("DELETE", "/api/auth/sessions/others", first);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ ok: true, revoked: before.sessions.length - 1 });

    const listed = await call("GET", "/api/auth/sessions", first);
    const { sessions } = (await listed.json()) as { sessions: unknown[] };
    expect(sessions).toHaveLength(1);
    expect((await call("GET", "/api/auth/session", first)).status).toBe(200);
  });
});

describe("audit log", () => {
  it("records account actions and stays owner-only", async () => {
    const ownerCookie = await owner();
    const created = await call("POST", "/api/admin/users", ownerCookie, {
      username: "alice",
      password,
      roles: ["member"],
    });
    expect(created.status).toBe(201);
    const alice = ((await created.json()) as { user: { id: string } }).user;

    expect(
      (
        await call("PATCH", `/api/admin/users/${alice.id}/roles`, ownerCookie, {
          roles: ["dev"],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("POST", `/api/admin/users/${alice.id}/password`, ownerCookie, {
          password: "another password 456",
        })
      ).status,
    ).toBe(200);

    const audit = await call("GET", "/api/admin/audit", ownerCookie);
    expect(audit.status).toBe(200);
    const { entries } = (await audit.json()) as { entries: { action: string }[] };
    expect(entries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["user.create", "user.roles", "user.password_reset"]),
    );

    expect((await call("DELETE", `/api/admin/users/${alice.id}`, ownerCookie)).status).toBe(200);
    const after = await call("GET", "/api/admin/audit", ownerCookie);
    const deleted = (await after.json()) as { entries: { action: string }[] };
    expect(deleted.entries[0]?.action).toBe("user.delete");

    const adminCookie = await owner();
    await call("POST", "/api/admin/users", adminCookie, {
      username: "admin2",
      password,
      roles: ["admin"],
    });
    const memberLogin = await login("admin2", password);
    const member = cookieOf(memberLogin);
    expect((await call("GET", "/api/admin/audit", member)).status).toBe(403);
  });
});

describe("reset request hardening", () => {
  it("sends at most one link per account inside the cooldown window", async () => {
    expect((await call("POST", "/api/auth/forgot", "", { username: "admin" })).status).toBe(202);
    expect(sent).toHaveLength(1);
    const firstToken = /[?&]reset=([a-f0-9]{64})/.exec(sent[0] ?? "")?.[1];
    expect(firstToken).toBeTruthy();

    expect((await call("POST", "/api/auth/forgot", "", { username: "admin" })).status).toBe(202);
    expect(sent).toHaveLength(1);

    // The link from the first request must still work, not be replaced.
    const reset = await call("POST", "/api/auth/reset", "", {
      token: firstToken,
      password: "owner pass 456",
    });
    expect(reset.status).toBe(200);
  });

  it("sends nothing for an unknown account", async () => {
    const response = await call("POST", "/api/auth/forgot", "", { username: "missing" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
  });
});
