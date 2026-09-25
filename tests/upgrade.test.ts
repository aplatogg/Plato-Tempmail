import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";
import { hex, sha256 } from "../src/security";
import type { Env, Principal } from "../src/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const origin = "https://mail.example.com";
const username = "Legacy.Owner-1";
const password = "legacy override password";

async function request(path: string, token: string, body?: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin, cookie: token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...bindings, ADMIN_USERNAME: username },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

it("preserves populated pre-multi-user records, owner recovery credentials and private mail through upgrade", async () => {
  // vitest.config.ts supplies readD1Migrations() output: each query is already parsed,
  // including complete trigger bodies. This isolated file applies the two phases once.
  const legacy = bindings.TEST_MIGRATIONS.filter((migration) => /^000[1-3]_/.test(migration.name));
  const upgrade = bindings.TEST_MIGRATIONS.filter((migration) => /^000[4-6]_/.test(migration.name));
  expect(legacy).toHaveLength(3);
  expect(upgrade).toHaveLength(3);
  await applyD1Migrations(bindings.DB, legacy);
  expect(
    await bindings.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").first(),
  ).toBeNull();

  const salt = new Uint8Array(16).fill(42);
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const digest = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", iterations: 100000, salt },
    material,
    256,
  );
  const verifier = `pbkdf2-sha256$100000$${hex(salt)}$${hex(new Uint8Array(digest))}`;
  const fingerprint = await sha256(bindings.AUTH_PASSWORD_HASH ?? "");
  const revision = 7;
  const raw = "c".repeat(64);
  const token = `__Host-plato_session=${raw}`;
  const tokenHash = await sha256(raw);
  const version = await sha256(JSON.stringify([origin, username, fingerprint, verifier, revision]));
  const timestamp = Math.floor(Date.now() / 1000);
  const expiresAt = timestamp + 86400;
  const inboxId = "legacy-inbox";
  const address = "legacy@example.com";
  const messageId = "legacy-message";
  const subject = "Original subject – 日本語";
  const text = "Original private body\nSecond line; preserved verbatim.";
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO app_credentials VALUES (1, ?, ?, ?)").bind(
      fingerprint,
      verifier,
      revision,
    ),
    bindings.DB.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").bind(
      tokenHash,
      version,
      timestamp,
      expiresAt,
    ),
    bindings.DB.prepare("INSERT INTO inboxes VALUES (?, ?, ?)").bind(
      inboxId,
      address,
      timestamp - 100,
    ),
    bindings.DB.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(
      messageId,
      inboxId,
      "sender@example.net",
      subject,
      text,
      timestamp - 50,
      expiresAt,
      "d".repeat(64),
    ),
    bindings.DB.prepare("INSERT INTO inbox_favorites VALUES (?, 1)").bind(inboxId),
    bindings.DB.prepare("INSERT INTO message_read_state VALUES (?, 1)").bind(messageId),
  ]);
  const snapshot = async () => {
    const results = await bindings.DB.batch<Record<string, unknown>>([
      bindings.DB.prepare("SELECT * FROM app_credentials"),
      bindings.DB.prepare("SELECT * FROM sessions"),
      bindings.DB.prepare("SELECT * FROM inboxes"),
      bindings.DB.prepare("SELECT * FROM messages"),
      bindings.DB.prepare("SELECT * FROM inbox_favorites"),
      bindings.DB.prepare("SELECT * FROM message_read_state"),
      bindings.DB.prepare("SELECT * FROM message_arrivals"),
    ]);
    return results.map((result) => result.results);
  };
  const before = await snapshot();
  expect(before.map((rows) => rows.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  const arrival = before[6][0].sequence;
  await applyD1Migrations(bindings.DB, upgrade);
  expect(await snapshot()).toEqual(before);
  expect(await bindings.DB.prepare("SELECT * FROM session_users").all()).toMatchObject({
    results: [],
  });
  expect(await bindings.DB.prepare("SELECT * FROM inbox_owners").all()).toMatchObject({
    results: [{ inbox_id: inboxId, user_id: "owner" }],
  });
  expect(await bindings.DB.prepare("SELECT * FROM address_claims").all()).toMatchObject({
    results: [{ address, user_id: "owner", claimed_at: timestamp - 100 }],
  });

  const identity = { id: "owner", username, role: "owner", roles: ["owner"] };
  const session = await request("/api/auth/session", token);
  expect(session.status).toBe(200);
  expect(await session.json()).toEqual({
    user: identity,
    mailDomain: "example.com",
    retentionDays: 7,
  });
  const admins = await request("/api/admin/users", token);
  expect(await admins.json()).toEqual({
    users: [{ ...identity, createdAt: null }],
    assignableRoles: ["member", "dev", "admin", "owner"],
  });
  const inboxes = await request("/api/inboxes", token);
  expect(await inboxes.json()).toEqual({
    inboxes: [
      {
        id: inboxId,
        address,
        createdAt: timestamp - 100,
        favorite: true,
        messageCount: 1,
        unreadCount: 0,
        latestMessageId: messageId,
        latestArrival: arrival,
      },
    ],
  });
  const message = await request(`/api/messages/${messageId}`, token);
  expect(message.status).toBe(200);
  expect(await message.json()).toEqual({
    message: {
      id: messageId,
      inboxId,
      from: "sender@example.net",
      subject,
      body: text,
      receivedAt: timestamp - 50,
      expiresAt,
      isRead: true,
    },
  });
  const loggedIn = await request("/api/auth/login", "", { username, password });
  expect(loggedIn.status).toBe(200);
  expect(((await loggedIn.json()) as { user: Principal }).user).toEqual(identity);
  expect((await request("/api/auth/login", "", { username, password: "admin" })).status).toBe(401);
  expect(
    (await request("/api/auth/login", "", { username: username.toLowerCase(), password })).status,
  ).toBe(401);
  expect((await request("/api/auth/session", token)).status).toBe(200);

  const created = await request("/api/admin/users", token, {
    username: "member",
    password: "member password 123",
  });
  expect(created.status).toBe(201);
  const member = await request("/api/auth/login", "", {
    username: "member",
    password: "member password 123",
  });
  expect(member.status).toBe(200);
  const memberIdentity = ((await member.json()) as { user: Principal }).user;
  expect(memberIdentity.role).toBe("user");
  expect(memberIdentity.id).not.toBe("owner");
  const memberToken = member.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(await (await request("/api/inboxes", memberToken)).json()).toEqual({ inboxes: [] });
  expect((await request("/api/inboxes?userId=owner", memberToken)).status).toBe(403);
  expect((await request(`/api/inboxes/${inboxId}/messages`, memberToken)).status).toBe(404);
  expect((await request(`/api/messages/${messageId}`, memberToken)).status).toBe(404);
  expect((await request("/api/admin/users", memberToken)).status).toBe(403);
  // Additional logins only append sessions; all persisted credential/mail/state rows stay exact.
  const after = await snapshot();
  expect(after[0]).toEqual(before[0]);
  expect(after.slice(2)).toEqual(before.slice(2));
  expect(after[1]).toContainEqual(before[1][0]);
});
