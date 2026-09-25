import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const origin = "https://mail.example.com";
const now = () => Math.floor(Date.now() / 1000);
interface Principal {
  id: string;
  cookie: string;
}
interface Inbox {
  id: string;
  address: string;
  favorite: boolean;
  messageCount: number;
  unreadCount: number;
  latestMessageId: string | null;
  latestArrival: number;
}
interface Page {
  messages: { id: string; isRead: boolean }[];
  nextCursor: string | null;
}
let owner: Principal;
let backfill: unknown;
let existingTables: string[] = [];
async function req(
  user: Principal,
  path: string,
  method = "GET",
  body?: unknown,
  db = bindings.DB,
) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(origin + path, {
      method,
      headers: { origin, cookie: user.cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { ...bindings, DB: db },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
async function login(username: string, password: string) {
  const response = await req({ id: "", cookie: "" }, "/api/auth/login", "POST", {
    username,
    password,
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}
async function member(username: string): Promise<Principal> {
  const password = `test-password-${username}`;
  const response = await req(owner, "/api/admin/users", "POST", { username, password });
  expect(response.status, "auth agent's member creation contract").toBe(201);
  const { user } = (await response.json()) as { user: { id: string } };
  return { id: user.id, cookie: await login(username, password) };
}
async function create(user: Principal, localPart: string): Promise<Inbox> {
  const response = await req(user, "/api/inboxes", "POST", { localPart });
  expect(response.status).toBe(201);
  return ((await response.json()) as { inbox: Inbox }).inbox;
}
async function list(user: Principal, query = "") {
  const response = await req(user, `/api/inboxes${query}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { inboxes: Inbox[] }).inboxes;
}
async function seed(inbox: string, id: string, expires = now() + 1000) {
  await bindings.DB.prepare(
    "INSERT INTO messages VALUES (?, ?, 'sender', 'needle', 'body', 1000, ?, ?)",
  )
    .bind(id, inbox, expires, id)
    .run();
}
async function duplicate(response: Response) {
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: {
      code: "ADDRESS_EXISTS",
      message: "Email sudah digunakan. Silakan gunakan email lain.",
    },
  });
}
beforeAll(async () => {
  await applyD1Migrations(
    bindings.DB,
    bindings.TEST_MIGRATIONS.filter((m) => m.name < "0005"),
  );
  await bindings.DB.prepare(
    "INSERT INTO inboxes VALUES ('legacy-backfill', 'backfill@example.com', 42)",
  ).run();
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  existingTables = (
    await bindings.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{
      name: string;
    }>()
  ).results.map((row) => row.name);
  // Missing migration is an assertion failure, not a suite-hook exception during RED.
  if (existingTables.includes("inbox_owners") && existingTables.includes("address_claims")) {
    backfill =
      await bindings.DB.prepare(`SELECT o.user_id AS owner, a.user_id AS claimant, a.claimed_at AS claimedAt
      FROM inbox_owners o JOIN inboxes i ON i.id = o.inbox_id
      JOIN address_claims a ON a.address = i.address WHERE i.id = 'legacy-backfill'`).first();
  }
});
beforeEach(async () => {
  const tables = [
    "messages",
    "inboxes",
    "sessions",
    "rate_limits",
    "users",
    "address_claims",
    "app_credentials",
  ];
  await bindings.DB.batch(
    tables
      .filter((table) => existingTables.includes(table))
      .map((table) => bindings.DB.prepare(`DELETE FROM ${table}`)),
  );
  owner = { id: "owner", cookie: await login("admin", "admin") };
});

// Pause actual D1 execution after middleware, supporting both single statements
// and transactional batches. Queries/results and session verification stay real.
function pauseMailboxWrites() {
  let release = () => {};
  let reached = () => {};
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const statements = new WeakMap<
    D1PreparedStatement,
    { raw: D1PreparedStatement; write: boolean }
  >();
  const pause = async () => {
    reached();
    await gate;
  };
  const wrap = (raw: D1PreparedStatement, write: boolean): D1PreparedStatement => {
    const proxy = new Proxy(raw, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), write);
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if (write) await pause();
          return value.apply(target, args);
        };
      },
    });
    statements.set(proxy, { raw, write });
    return proxy;
  };
  const db = new Proxy(bindings.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) =>
          wrap(
            target.prepare(sql),
            /^\s*(?:INSERT INTO (?:inboxes|address_claims|inbox_owners|inbox_favorites|message_read_state)|DELETE FROM (?:inboxes|messages))\b/i.test(
              sql,
            ),
          );
      if (key === "batch")
        return async (batch: D1PreparedStatement[]) => {
          if (batch.some((statement) => statements.get(statement)?.write)) await pause();
          return target.batch(
            batch.map((statement) => statements.get(statement)?.raw ?? statement),
          );
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, waiting, release };
}

async function mailboxSnapshot() {
  return Promise.all(
    [
      "inboxes",
      "messages",
      "inbox_owners",
      "address_claims",
      "inbox_favorites",
      "message_read_state",
      "message_arrivals",
    ].map(
      async (table) =>
        (await bindings.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results,
    ),
  );
}

describe("mailbox mutation session freshness", () => {
  const revocations = [
    "owner logout",
    "member logout",
    "member reset",
    "owner password",
    "owner expiry",
    "member expiry",
    "owner version",
    "member version",
  ] as const;
  const operations = [
    "create",
    "favorite",
    "delete inbox",
    "read",
    "unread",
    "delete message",
  ] as const;
  describe.each(revocations)("%s after admission", (revocation) => {
    it.each(operations)("rejects %s without changing mailbox data or claims", async (operation) => {
      const user = revocation.startsWith("member") ? await member("alice") : owner;
      const inbox = await create(user, "freshness");
      await seed(inbox.id, "freshness-message");
      if (operation === "unread") {
        expect(
          (await req(user, "/api/messages/freshness-message", "PATCH", { isRead: true })).status,
        ).toBe(200);
      }
      // Exercise the deletion path that would create a missing legacy claim.
      if (operation === "delete inbox") {
        await bindings.DB.prepare("DELETE FROM address_claims").run();
        if (user.id === "owner") await bindings.DB.prepare("DELETE FROM inbox_owners").run();
      }
      const before = await mailboxSnapshot();
      const paths = {
        create: ["/api/inboxes", "POST", { localPart: "stale-create" }],
        favorite: [`/api/inboxes/${inbox.id}`, "PATCH", { favorite: true }],
        "delete inbox": [`/api/inboxes/${inbox.id}`, "DELETE", undefined],
        read: ["/api/messages/freshness-message", "PATCH", { isRead: true }],
        unread: ["/api/messages/freshness-message", "PATCH", { isRead: false }],
        "delete message": ["/api/messages/freshness-message", "DELETE", undefined],
      } as const;
      const [path, method, body] = paths[operation];
      const paused = pauseMailboxWrites();
      const pending = req(user, path, method, body, paused.db);
      try {
        await Promise.race([
          paused.waiting,
          pending.then(() => {
            throw new Error("Request did not reach mailbox write boundary");
          }),
        ]);
        if (revocation.endsWith("logout")) {
          expect((await req(user, "/api/auth/logout", "POST")).status).toBe(200);
        } else if (revocation === "member reset") {
          expect(
            (
              await req(owner, `/api/admin/users/${user.id}/password`, "POST", {
                password: "replacement-password",
              })
            ).status,
          ).toBe(200);
        } else if (revocation === "owner password") {
          expect(
            (
              await req(owner, "/api/auth/password", "POST", {
                currentPassword: "admin",
                newPassword: "replacement-password",
              })
            ).status,
          ).toBe(200);
        } else if (revocation.endsWith("expiry")) {
          await bindings.DB.prepare("UPDATE sessions SET expires_at = 1").run();
        } else {
          await bindings.DB.prepare(
            "UPDATE sessions SET credential_version = 'invalid-version'",
          ).run();
        }
      } finally {
        paused.release();
      }
      const response = await pending;
      // Compare data even on RED, so an incorrect status cannot hide a mutation.
      const after = await mailboxSnapshot();
      expect.soft(after).toEqual(before);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "CREDENTIALS_CHANGED" } });
    });
  });

  it.each(["missing", "foreign", "quota", "collision"])(
    "prioritizes stale sessions over %s errors",
    async (reason) => {
      const user = await member("alice");
      const inbox = await create(owner, "taken");
      if (reason === "quota") {
        await bindings.DB.prepare(`WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n < 99)
        INSERT INTO inboxes SELECT 'full-'||n, 'full-'||n||'@example.com', 1 FROM nums`).run();
      }
      const creating = reason === "quota" || reason === "collision";
      const paused = pauseMailboxWrites();
      const before = await mailboxSnapshot();
      const pending = req(
        user,
        creating ? "/api/inboxes" : `/api/inboxes/${reason === "missing" ? "missing" : inbox.id}`,
        creating ? "POST" : "DELETE",
        creating ? { localPart: reason === "collision" ? "taken" : "unclaimed" } : undefined,
        paused.db,
      );
      try {
        await Promise.race([
          paused.waiting,
          pending.then(() => {
            throw new Error("Request did not reach mailbox write boundary");
          }),
        ]);
        expect((await req(user, "/api/auth/logout", "POST")).status).toBe(200);
      } finally {
        paused.release();
      }
      const response = await pending;
      expect(await mailboxSnapshot()).toEqual(before);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "CREDENTIALS_CHANGED" } });
    },
  );
});

describe("inbox ownership and durable address privacy", () => {
  it("backfills legacy ownership and address reservations without changing positional layouts", async () => {
    expect(backfill).toEqual({ owner: "owner", claimant: "owner", claimedAt: 42 });
    for (const [table, count] of [
      ["inboxes", 3],
      ["messages", 8],
    ] as const) {
      expect((await bindings.DB.prepare(`PRAGMA table_info(${table})`).all()).results).toHaveLength(
        count,
      );
    }
    const keys = (await bindings.DB.prepare("PRAGMA foreign_key_list(inbox_owners)").all()).results;
    expect(keys).toContainEqual(
      expect.objectContaining({
        table: "inboxes",
        from: "inbox_id",
        to: "id",
        on_delete: "CASCADE",
      }),
    );
    expect(
      (await bindings.DB.prepare("PRAGMA index_list(inbox_owners)").all()).results,
    ).toContainEqual(expect.objectContaining({ name: "idx_inbox_owners_user" }));
  });

  it.each([
    "?userId=",
    "?userId=owner&userId=owner",
    "?userId=%20owner",
    "?userId=a%00b",
    "?userId=../owner",
    `?userId=${"a".repeat(81)}`,
  ])("rejects malformed or duplicate list selector %s", async (query) => {
    expect((await req(owner, `/api/inboxes${query}`)).status).toBe(400);
  });
  it("returns 404 for an unknown owner inspection selector", async () => {
    expect((await req(owner, "/api/inboxes?userId=missing-user")).status).toBe(404);
  });
  it("rejects creation selectors and forged principal fields", async () => {
    expect(
      (await req(owner, "/api/inboxes?userId=owner", "POST", { localPart: "query" })).status,
    ).toBe(400);
    for (const field of ["owner", "role", "userId"]) {
      expect(
        (await req(owner, "/api/inboxes", "POST", { localPart: "forged", [field]: "owner" }))
          .status,
      ).toBe(400);
    }
    expect(await list(owner)).toEqual([]);
  });
  it("uses the exact non-disclosing duplicate error after normalization", async () => {
    const inbox = await create(owner, "DuPlicate");
    await duplicate(await req(owner, "/api/inboxes", "POST", { localPart: "DUPLICATE" }));
    expect((await list(owner)).map((row) => row.id)).toEqual([inbox.id]);
  });

  it("lists only each principal's inboxes and preserves scoped metadata during owner inspection", async () => {
    const alice = await member("alice");
    const bob = await member("bob");
    const own = await create(owner, "owner-box");
    const a = await create(alice, "alice-box");
    const b = await create(bob, "bob-box");
    await seed(a.id, "alice-live");
    await seed(a.id, "alice-expired", 1);
    await seed(b.id, "bob-live");
    expect((await req(alice, `/api/inboxes/${a.id}`, "PATCH", { favorite: true })).status).toBe(
      200,
    );
    expect((await list(owner)).map((row) => row.id)).toEqual([own.id]);
    expect((await list(bob)).map((row) => row.id)).toEqual([b.id]);
    const rows = await list(alice);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: a.id,
      favorite: true,
      messageCount: 1,
      unreadCount: 1,
      latestMessageId: "alice-live",
    });
    expect(rows[0].latestArrival).toBeGreaterThan(0);
    expect(await list(owner, `?userId=${alice.id}`)).toEqual(rows);
    expect(await list(alice, `?userId=${alice.id}`)).toEqual(rows);
    expect(await list(owner, "?userId=owner")).toEqual(await list(owner));
    for (const id of [bob.id, "owner", "unknown"]) {
      expect((await req(alice, `/api/inboxes?userId=${id}`)).status).toBe(403);
    }
  });

  it("treats unmapped positional legacy inboxes as owner-only and reserves them on deletion", async () => {
    const alice = await member("alice");
    await bindings.DB.prepare(
      "INSERT INTO inboxes VALUES ('legacy', 'legacy@example.com', 1)",
    ).run();
    await seed("legacy", "legacy-message");
    expect((await list(owner)).map((row) => row.id)).toEqual(["legacy"]);
    expect(await list(alice)).toEqual([]);
    expect((await req(alice, "/api/messages/legacy-message")).status).toBe(404);
    await duplicate(await req(alice, "/api/inboxes", "POST", { localPart: "LEGACY" }));
    expect((await req(owner, "/api/inboxes/legacy", "PATCH", { favorite: true })).status).toBe(200);
    expect(
      (await req(owner, "/api/messages/legacy-message", "PATCH", { isRead: true })).status,
    ).toBe(200);
    expect((await req(owner, "/api/inboxes/legacy", "DELETE")).status).toBe(200);
    await duplicate(await req(alice, "/api/inboxes", "POST", { localPart: "legacy" }));
    await create(owner, "legacy");
  });

  it("hides cross-user IDs for GET/list/search/page and every mutation, including existing state", async () => {
    const alice = await member("alice");
    const bob = await member("bob");
    const inbox = await create(alice, "private");
    await seed(inbox.id, "private-message");
    await req(alice, `/api/inboxes/${inbox.id}`, "PATCH", { favorite: true });
    await req(alice, "/api/messages/private-message", "PATCH", { isRead: true });
    const cursor = btoa(JSON.stringify([2000, "private-message"])).replace(/=+$/, "");
    for (const id of [inbox.id, "missing"]) {
      for (const query of ["", "?q=needle", `?q=needle&cursor=${cursor}`, `?userId=${alice.id}`]) {
        expect((await req(bob, `/api/inboxes/${id}/messages${query}`)).status).toBe(404);
      }
      expect((await req(bob, `/api/inboxes/${id}`, "PATCH", { favorite: false })).status).toBe(404);
      expect((await req(bob, `/api/inboxes/${id}`, "DELETE")).status).toBe(404);
    }
    for (const id of ["private-message", "missing"]) {
      expect((await req(bob, `/api/messages/${id}`)).status).toBe(404);
      expect((await req(bob, `/api/messages/${id}`, "PATCH", { isRead: false })).status).toBe(404);
      expect((await req(bob, `/api/messages/${id}`, "DELETE")).status).toBe(404);
    }
    expect((await list(alice))[0]).toMatchObject({
      favorite: true,
      unreadCount: 0,
      messageCount: 1,
    });
    const own = await create(owner, "owner-private");
    await seed(own.id, "owner-message");
    for (const user of [alice, bob]) {
      expect((await req(user, `/api/inboxes/${own.id}/messages?q=needle`)).status).toBe(404);
      expect((await req(user, "/api/messages/owner-message")).status).toBe(404);
      expect((await req(user, `/api/inboxes/${own.id}`, "DELETE")).status).toBe(404);
      expect((await req(user, "/api/messages/owner-message", "DELETE")).status).toBe(404);
      expect((await req(user, `/api/inboxes/${own.id}`, "PATCH", { favorite: true })).status).toBe(
        404,
      );
      expect(
        (await req(user, "/api/messages/owner-message", "PATCH", { isRead: true })).status,
      ).toBe(404);
    }
  });

  it("allows owner inspection reads but denies all mutations of member resources", async () => {
    const alice = await member("alice");
    const inbox = await create(alice, "inspect");
    await seed(inbox.id, "inspect-message");
    expect((await req(owner, "/api/messages/inspect-message")).status).toBe(200);
    for (const query of ["", "?q=needle"]) {
      expect((await req(owner, `/api/inboxes/${inbox.id}/messages${query}`)).status).toBe(200);
    }
    for (const user of [owner, await member("bob")]) {
      const suffix = `?userId=${alice.id}`;
      expect(
        (await req(user, `/api/inboxes/${inbox.id}${suffix}`, "PATCH", { favorite: true })).status,
      ).toBe(404);
      expect((await req(user, `/api/inboxes/${inbox.id}${suffix}`, "DELETE")).status).toBe(404);
      expect(
        (await req(user, `/api/messages/inspect-message${suffix}`, "PATCH", { isRead: true }))
          .status,
      ).toBe(404);
      expect((await req(user, `/api/messages/inspect-message${suffix}`, "DELETE")).status).toBe(
        404,
      );
    }
    expect((await list(alice))[0]).toMatchObject({
      favorite: false,
      unreadCount: 1,
      messageCount: 1,
    });
    expect(
      (await req(alice, "/api/messages/inspect-message", "PATCH", { isRead: true })).status,
    ).toBe(200);
    expect((await req(alice, "/api/messages/inspect-message", "DELETE")).status).toBe(200);
    expect((await req(alice, `/api/inboxes/${inbox.id}`, "DELETE")).status).toBe(200);
  });

  it("keeps forged cursors and literal searches inside the authorized parent across pages", async () => {
    const alice = await member("alice");
    const bob = await member("bob");
    const a = await create(alice, "pages-a");
    const b = await create(bob, "pages-b");
    const ids = Array.from({ length: 61 }, (_, i) => `a-${String(i).padStart(2, "0")}`).reverse();
    await bindings.DB.batch(
      ids.map((id) =>
        bindings.DB.prepare(
          "INSERT INTO messages VALUES (?, ?, 'sender', 'needle', 'body', 1000, ?, ?)",
        ).bind(id, a.id, now() + 1000, id),
      ),
    );
    await seed(b.id, "secret-b");
    for (const reader of [alice, owner]) {
      let cursor: string | null = null;
      const seen: string[] = [];
      for (let index = 0; index < 3; index++) {
        const response = await req(
          reader,
          `/api/inboxes/${a.id}/messages?q=needle${cursor ? `&cursor=${cursor}` : ""}`,
        );
        expect(response.status).toBe(200);
        const page = (await response.json()) as Page;
        seen.push(...page.messages.map((m) => m.id));
        cursor = page.nextCursor;
      }
      expect(seen).toEqual(ids);
      expect(cursor).toBeNull();
    }
    const forged = btoa(JSON.stringify([2000, "secret-b"])).replace(/=+$/, "");
    const page = (await (
      await req(alice, `/api/inboxes/${a.id}/messages?cursor=${forged}`)
    ).json()) as Page;
    expect(page.messages).toHaveLength(30);
    expect(page.messages.every((m) => m.id.startsWith("a-"))).toBe(true);
    const injection = (await (
      await req(alice, `/api/inboxes/${a.id}/messages?q=${encodeURIComponent("' OR 1=1 --")}`)
    ).json()) as Page;
    expect(injection.messages).toEqual([]);
  });

  it("has exactly one winner for concurrent cross-user normalized address creation", async () => {
    const alice = await member("alice");
    const bob = await member("bob");
    const users = [alice, bob, owner];
    const responses = await Promise.all(
      users.map((user, i) =>
        req(user, "/api/inboxes", "POST", { localPart: i === 1 ? "RACE" : "race" }),
      ),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    for (const response of responses.filter((r) => r.status !== 201)) await duplicate(response);
    const winner = users[responses.findIndex((r) => r.status === 201)];
    const rows = await list(winner);
    expect(rows).toHaveLength(1);
    expect(
      await bindings.DB.prepare("SELECT user_id FROM inbox_owners WHERE inbox_id = ?")
        .bind(rows[0].id)
        .first("user_id"),
    ).toBe(winner.id);
    expect(
      await bindings.DB.prepare(
        "SELECT user_id FROM address_claims WHERE address = 'race@example.com'",
      ).first("user_id"),
    ).toBe(winner.id);
    for (const user of users)
      await duplicate(await req(user, "/api/inboxes", "POST", { localPart: "race" }));
  });

  it("retains claims after deletion: only the same user can recreate, even against owner", async () => {
    const alice = await member("alice");
    const bob = await member("bob");
    const inbox = await create(alice, "reserved-forever");
    await seed(inbox.id, "old-mail");
    expect((await req(alice, `/api/inboxes/${inbox.id}`, "DELETE")).status).toBe(200);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM inbox_owners").first("n")).toBe(0);
    for (const other of [owner, bob])
      await duplicate(await req(other, "/api/inboxes", "POST", { localPart: "RESERVED-FOREVER" }));
    const recreated = await create(alice, "reserved-forever");
    expect(recreated.id).not.toBe(inbox.id);
    expect(recreated.messageCount).toBe(0);
    expect((await req(alice, "/api/messages/old-mail")).status).toBe(404);
  });

  it("enforces the global quota atomically without reserving rejected new addresses", async () => {
    const alice = await member("alice");
    const bob = await member("bob");
    await bindings.DB.prepare(`WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n < 99)
      INSERT INTO inboxes SELECT 'quota-'||n, 'quota-'||n||'@example.com', 1 FROM nums`).run();
    const candidates = [alice, bob, owner, alice, bob];
    const responses = await Promise.all(
      candidates.map((user, i) =>
        req(user, "/api/inboxes", "POST", { localPart: `quota-race-${i}` }),
      ),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    for (const response of responses.filter((r) => r.status !== 201)) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "INBOX_LIMIT" } });
    }
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM inboxes").first("n")).toBe(100);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM address_claims").first("n")).toBe(
      1,
    );
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM inbox_owners").first("n")).toBe(1);
    const loser = responses.findIndex((r) => r.status === 409);
    await req(owner, "/api/inboxes/quota-1", "DELETE");
    await create(candidates[loser], `quota-race-${loser}`);
  });

  it("rolls back the entire creation batch if the ownership write fails", async () => {
    // Real SQLite failure injection verifies the transaction, not mocked calls.
    await bindings.DB.prepare(`CREATE TRIGGER reject_test_mapping BEFORE INSERT ON inbox_owners
      BEGIN SELECT RAISE(ABORT, 'synthetic mapping failure'); END`).run();
    try {
      expect((await req(owner, "/api/inboxes", "POST", { localPart: "rollback" })).status).toBe(
        500,
      );
      for (const table of ["inboxes", "inbox_owners", "address_claims"]) {
        expect(await bindings.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n")).toBe(0);
      }
    } finally {
      await bindings.DB.prepare("DROP TRIGGER reject_test_mapping").run();
    }
    await create(owner, "rollback");
  });

  it("retains JSON and Origin guards for member requests and rejects forged mutation fields", async () => {
    const alice = await member("alice");
    const inbox = await create(alice, "guards");
    await seed(inbox.id, "guard-message");
    for (const field of ["owner", "role", "userId"]) {
      const forged = { [field]: "owner" };
      expect(
        (await req(alice, "/api/inboxes", "POST", { localPart: "forged", ...forged })).status,
      ).toBe(400);
      expect(
        (await req(alice, `/api/inboxes/${inbox.id}`, "PATCH", { favorite: true, ...forged }))
          .status,
      ).toBe(400);
      expect(
        (await req(alice, "/api/messages/guard-message", "PATCH", { isRead: true, ...forged }))
          .status,
      ).toBe(400);
    }
    for (const [requestOrigin, contentType, status] of [
      ["https://other.example", "application/json", 403],
      [origin, "text/plain", 415],
    ] as const) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`${origin}/api/inboxes/${inbox.id}`, {
          method: "PATCH",
          headers: { origin: requestOrigin, cookie: alice.cookie, "content-type": contentType },
          body: JSON.stringify({ favorite: true }),
        }),
        bindings,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(status);
    }
    expect((await list(alice))[0]).toMatchObject({ favorite: false, unreadCount: 1 });
  });

  it("delivers only to existing member inboxes and never recreates an inbox from its claim", async () => {
    const alice = await member("alice");
    const bob = await member("bob");
    const inbox = await create(alice, "delivery");
    const deliver = async () => {
      const bytes = new TextEncoder().encode(
        "From: sender@example.com\r\nSubject: Member mail\r\nContent-Type: text/plain\r\n\r\nSynthetic mail",
      );
      const rejected: string[] = [];
      const ctx = createExecutionContext();
      await worker.email(
        {
          to: inbox.address,
          from: "sender@example.com",
          rawSize: bytes.byteLength,
          raw: new Response(bytes).body,
          setReject: (reason: string) => rejected.push(reason),
        } as unknown as ForwardableEmailMessage,
        bindings,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return rejected;
    };
    expect(await deliver()).toEqual([]);
    expect((await list(alice))[0]).toMatchObject({ messageCount: 1, unreadCount: 1 });
    expect(await list(bob)).toEqual([]);
    expect(await list(owner)).toEqual([]);
    expect((await req(alice, `/api/inboxes/${inbox.id}`, "DELETE")).status).toBe(200);
    expect(await deliver()).toHaveLength(1);
    expect(await list(alice)).toEqual([]);
    await duplicate(await req(bob, "/api/inboxes", "POST", { localPart: "delivery" }));
  });
});
