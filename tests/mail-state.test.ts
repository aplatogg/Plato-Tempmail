import {
  applyD1Migrations,
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const origin = "https://mail.example.com";
let cookie = "";
const now = () => Math.floor(Date.now() / 1000);
interface Inbox {
  id: string;
  favorite: boolean;
  messageCount: number;
  unreadCount: number;
  latestMessageId: string | null;
  latestArrival: number;
}
interface Arrival {
  sequence: number;
  message_id: string;
}
let backfilledArrivals: Arrival[] = [];
interface Page {
  messages: { id: string; isRead: boolean; preview: string; body?: string }[];
  nextCursor: string | null;
}
async function raw(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(origin + path, init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function req(path: string, method = "GET", body?: unknown, session = cookie) {
  return raw(path, {
    method,
    headers: { origin, cookie: session, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function login() {
  const response = await req(
    "/api/auth/login",
    "POST",
    { username: "admin", password: "admin" },
    "",
  );
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}
async function create(localPart = "state") {
  const response = await req("/api/inboxes", "POST", { localPart });
  expect(response.status).toBe(201);
  return ((await response.json()) as { inbox: Inbox }).inbox;
}
async function inboxes(session = cookie) {
  const response = await req("/api/inboxes", "GET", undefined, session);
  expect(response.status).toBe(200);
  return ((await response.json()) as { inboxes: Inbox[] }).inboxes;
}
async function page(id: string, query = "", session = cookie): Promise<Page> {
  const response = await req(`/api/inboxes/${id}/messages${query}`, "GET", undefined, session);
  expect(response.status).toBe(200);
  return (await response.json()) as Page;
}
async function seed(
  inbox: string,
  id = "message-a",
  fields: {
    from?: string;
    subject?: string;
    body?: string;
    received?: number;
    expires?: number;
  } = {},
) {
  // Deliberately positional: migration must preserve existing ingestion/fixture compatibility.
  await bindings.DB.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(
      id,
      inbox,
      fields.from ?? "sender@example.com",
      fields.subject ?? "subject",
      fields.body ?? "body",
      fields.received ?? 1000,
      fields.expires ?? now() + 1000,
      id,
    )
    .run();
}
async function patch(path: string, body: unknown, session = cookie) {
  const response = await req(path, "PATCH", body, session);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
}
async function stateCounts() {
  return {
    favorites: await bindings.DB.prepare("SELECT COUNT(*) AS n FROM inbox_favorites").first("n"),
    reads: await bindings.DB.prepare("SELECT COUNT(*) AS n FROM message_read_state").first("n"),
  };
}
beforeAll(async () => {
  // This suite's isolated local D1 starts at the pre-state schema, with existing mail.
  await applyD1Migrations(
    bindings.DB,
    bindings.TEST_MIGRATIONS.filter((migration) => migration.name < "0003"),
  );
  await bindings.DB.prepare(
    "INSERT INTO inboxes VALUES ('legacy-backfill', 'backfill@example.com', 1)",
  ).run();
  for (const [id, received] of [
    ["legacy-z", 200],
    ["legacy-b", 100],
    ["legacy-a", 100],
  ] as const) {
    await seed("legacy-backfill", id, { received });
  }
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  // Allow RED to report the missing table as a test assertion rather than a failed suite hook.
  const table = await bindings.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_arrivals'",
  ).first();
  if (table)
    backfilledArrivals = (
      await bindings.DB.prepare(
        "SELECT sequence, message_id FROM message_arrivals ORDER BY sequence",
      ).all<Arrival>()
    ).results;
});
beforeEach(async () => {
  await bindings.DB.batch(
    [
      "DELETE FROM messages",
      "DELETE FROM inboxes",
      "DELETE FROM address_claims",
      "DELETE FROM sessions",
      "DELETE FROM rate_limits",
    ].map((sql) => bindings.DB.prepare(sql)),
  );
  cookie = await login();
});

describe("persistent mailbox state", () => {
  it("defaults create and legacy positional rows to unfavorited/unread with numeric counts", async () => {
    const inbox = await create();
    expect(inbox).toMatchObject({
      favorite: false,
      messageCount: 0,
      unreadCount: 0,
      latestMessageId: null,
    });
    await bindings.DB.prepare(
      "INSERT INTO inboxes VALUES ('legacy', 'legacy@example.com', 1)",
    ).run();
    await seed("legacy", "legacy-message");
    expect((await inboxes()).find((row) => row.id === "legacy")).toMatchObject({
      favorite: false,
      messageCount: 1,
      unreadCount: 1,
      latestMessageId: "legacy-message",
    });
    expect((await page("legacy")).messages[0].isRead).toBe(false);
    expect(await (await req("/api/messages/legacy-message")).json()).toMatchObject({
      message: { isRead: false },
    });
    expect(await stateCounts()).toEqual({ favorites: 0, reads: 0 });
  });

  it("persists idempotent read/unread and favorite setters across two sessions without GET mutations", async () => {
    const inbox = await create();
    await seed(inbox.id);
    const second = await login();
    expect(second).not.toBe(cookie);
    for (const value of [true, true, false, false]) {
      await patch(`/api/inboxes/${inbox.id}`, { favorite: value });
      await patch("/api/messages/message-a", { isRead: value });
      const before = await stateCounts();
      expect((await inboxes(second))[0]).toMatchObject({
        favorite: value,
        unreadCount: value ? 0 : 1,
      });
      expect((await page(inbox.id, "", second)).messages[0].isRead).toBe(value);
      expect(
        await (await req("/api/messages/message-a", "GET", undefined, second)).json(),
      ).toMatchObject({ message: { isRead: value } });
      expect(await stateCounts()).toEqual(before);
    }
    await patch("/api/messages/message-a", { isRead: true }, second);
    expect((await page(inbox.id)).messages[0].isRead).toBe(true);
    await seed(inbox.id, "new-message");
    expect((await page(inbox.id)).messages.find((row) => row.id === "new-message")?.isRead).toBe(
      false,
    );
  });

  it("sorts favorites first and retains created_at DESC, id DESC within each group", async () => {
    for (const [id, created] of [
      ["a", 10],
      ["b", 10],
      ["c", 20],
      ["d", 20],
    ] as const) {
      await bindings.DB.prepare("INSERT INTO inboxes VALUES (?, ?, ?)")
        .bind(id, `${id}@example.com`, created)
        .run();
    }
    await patch("/api/inboxes/a", { favorite: true });
    await patch("/api/inboxes/b", { favorite: true });
    expect((await inboxes()).map((row) => row.id)).toEqual(["b", "a", "d", "c"]);
    await patch("/api/inboxes/a", { favorite: false });
    expect((await inboxes()).map((row) => row.id)).toEqual(["b", "d", "c", "a"]);
  });

  it("recomputes counts/latest after read, unread, delete and expiry with stable message ties", async () => {
    const inbox = await create();
    await seed(inbox.id, "a", { received: 10 });
    await seed(inbox.id, "b", { received: 20 });
    await seed(inbox.id, "c", { received: 20 });
    await seed(inbox.id, "expired", { received: 30, expires: now() });
    expect((await inboxes())[0]).toMatchObject({
      messageCount: 3,
      unreadCount: 3,
      latestMessageId: "c",
    });
    await patch("/api/messages/c", { isRead: true });
    expect((await inboxes())[0].unreadCount).toBe(2);
    await patch("/api/messages/c", { isRead: false });
    expect((await inboxes())[0].unreadCount).toBe(3);
    await patch("/api/messages/b", { isRead: true });
    expect((await req("/api/messages/b", "DELETE")).status).toBe(200);
    expect((await inboxes())[0]).toMatchObject({
      messageCount: 2,
      unreadCount: 2,
      latestMessageId: "c",
    });
    expect((await req("/api/messages/c", "DELETE")).status).toBe(200);
    expect((await inboxes())[0]).toMatchObject({
      messageCount: 1,
      unreadCount: 1,
      latestMessageId: "a",
    });
    await bindings.DB.prepare("UPDATE messages SET expires_at = 1 WHERE id = 'a'").run();
    expect((await inboxes())[0]).toMatchObject({
      messageCount: 0,
      unreadCount: 0,
      latestMessageId: null,
    });
    expect((await page(inbox.id)).messages).toEqual([]);
  });

  it("returns 404 for absent inbox/message setters and expired message setters/detail", async () => {
    const inbox = await create();
    await seed(inbox.id, "expired", { expires: now() });
    for (const value of [true, false]) {
      expect((await req("/api/inboxes/missing", "PATCH", { favorite: value })).status).toBe(404);
      for (const id of ["missing", "expired"]) {
        expect((await req(`/api/messages/${id}`, "PATCH", { isRead: value })).status).toBe(404);
        expect((await req(`/api/messages/${id}`)).status).toBe(404);
      }
    }
    expect(await stateCounts()).toEqual({ favorites: 0, reads: 0 });
  });

  it("cascades state on message/inbox deletion and scheduled expiry cleanup", async () => {
    const inbox = await create();
    await seed(inbox.id, "a");
    await seed(inbox.id, "b");
    await patch(`/api/inboxes/${inbox.id}`, { favorite: true });
    await patch("/api/messages/a", { isRead: true });
    await patch("/api/messages/b", { isRead: true });
    expect(await stateCounts()).toEqual({ favorites: 1, reads: 2 });
    await req("/api/messages/a", "DELETE");
    expect(await stateCounts()).toEqual({ favorites: 1, reads: 1 });
    await bindings.DB.prepare("UPDATE messages SET expires_at = 1").run();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), bindings, ctx);
    await waitOnExecutionContext(ctx);
    expect(await stateCounts()).toEqual({ favorites: 1, reads: 0 });
    await seed(inbox.id, "c");
    await patch("/api/messages/c", { isRead: true });
    await req(`/api/inboxes/${inbox.id}`, "DELETE");
    expect(await stateCounts()).toEqual({ favorites: 0, reads: 0 });
  });

  it("stores only constrained state metadata with cascading foreign keys", async () => {
    for (const [table, key, flag, parent] of [
      ["inbox_favorites", "inbox_id", "favorite", "inboxes"],
      ["message_read_state", "message_id", "is_read", "messages"],
    ]) {
      const columns = await bindings.DB.prepare(`PRAGMA table_info(${table})`).all<{
        name: string;
      }>();
      expect(columns.results.map((column) => column.name)).toEqual([key, flag]);
      const foreignKeys = await bindings.DB.prepare(`PRAGMA foreign_key_list(${table})`).all();
      expect(foreignKeys.results).toContainEqual(
        expect.objectContaining({ table: parent, from: key, to: "id", on_delete: "CASCADE" }),
      );
      await expect(
        bindings.DB.prepare(`INSERT INTO ${table} VALUES ('missing', 1)`).run(),
      ).rejects.toThrow();
    }
    const inbox = await create();
    await seed(inbox.id);
    await expect(
      bindings.DB.prepare("INSERT INTO inbox_favorites VALUES (?, 2)").bind(inbox.id).run(),
    ).rejects.toThrow();
    await expect(
      bindings.DB.prepare("INSERT INTO message_read_state VALUES ('message-a', -1)").run(),
    ).rejects.toThrow();
  });

  it("does not update existing read state once the message expires", async () => {
    const inbox = await create();
    await seed(inbox.id);
    await patch("/api/messages/message-a", { isRead: true });
    await bindings.DB.prepare("UPDATE messages SET expires_at = 1").run();
    expect((await req("/api/messages/message-a", "PATCH", { isRead: false })).status).toBe(404);
    expect(
      await bindings.DB.prepare(
        "SELECT is_read FROM message_read_state WHERE message_id = 'message-a'",
      ).first("is_read"),
    ).toBe(1);
    expect((await inboxes())[0].unreadCount).toBe(0);
  });

  describe.each([
    ["inboxes", "favorite"],
    ["messages", "isRead"],
  ] as const)("%s input/middleware", (resource, field) => {
    it.each(
      [
        undefined,
        null,
        [],
        {},
        { value: true },
        { [field]: true, extra: 1 },
        ...[0, 1, "true", null, [], {}].map((value) => ({ [field]: value })),
      ].map((body) => ({ body })),
    )("rejects invalid body $body", async ({ body }) => {
      const inbox = await create();
      await seed(inbox.id);
      const id = resource === "inboxes" ? inbox.id : "message-a";
      expect((await req(`/api/${resource}/${id}`, "PATCH", body)).status).toBe(400);
    });
    it("reuses authentication, Origin, JSON media type and actual byte limits", async () => {
      const inbox = await create();
      await seed(inbox.id);
      const path = `/api/${resource}/${resource === "inboxes" ? inbox.id : "message-a"}`;
      const body = JSON.stringify({ [field]: true });
      expect((await req(path, "PATCH", { [field]: true }, "")).status).toBe(401);
      for (const requestOrigin of [undefined, "https://other.example"]) {
        const headers: Record<string, string> = { cookie, "content-type": "application/json" };
        if (requestOrigin) headers.origin = requestOrigin;
        expect((await raw(path, { method: "PATCH", headers, body })).status).toBe(403);
      }
      expect(
        (
          await raw(path, {
            method: "PATCH",
            headers: { cookie, origin, "content-type": "text/plain" },
            body,
          })
        ).status,
      ).toBe(415);
      expect(
        (
          await raw(path, {
            method: "PATCH",
            headers: { cookie, origin, "content-type": "application/json" },
            body: "{",
          })
        ).status,
      ).toBe(400);
      expect((await req(path, "PATCH", { [field]: true, padding: "x".repeat(4096) })).status).toBe(
        413,
      );
      expect(await stateCounts()).toEqual({ favorites: 0, reads: 0 });
    });
  });
});

describe("literal inbox search", () => {
  it.each(["from", "subject", "body"] as const)(
    "matches %s ASCII case-insensitively within only the selected inbox",
    async (field) => {
      const inbox = await create();
      const other = await create("other");
      await seed(inbox.id, "match", { [field]: "prefix NeEdLe suffix" });
      await seed(inbox.id, "unmatched");
      await seed(other.id, "other", { [field]: "needle" });
      await seed(inbox.id, "expired", { [field]: "needle", expires: 1 });
      expect((await page(inbox.id, "?q=needle")).messages.map((row) => row.id)).toEqual(["match"]);
    },
  );
  it.each(["%", "_", "'", "' OR 1=1 --", "\\"])("treats %s as literal text", async (needle) => {
    const inbox = await create();
    await seed(inbox.id, "match", { body: `prefix ${needle} suffix` });
    await seed(inbox.id, "unmatched");
    expect(
      (await page(inbox.id, `?q=${encodeURIComponent(needle)}`)).messages.map((row) => row.id),
    ).toEqual(["match"]);
  });
  it("handles empty/whitespace queries as no filter and accepts exactly 200 characters", async () => {
    const inbox = await create();
    await seed(inbox.id, "match", { body: "x".repeat(200) });
    const unfiltered = await page(inbox.id);
    expect(await page(inbox.id, "?q=")).toEqual(unfiltered);
    expect(await page(inbox.id, "?q=%20%09%20")).toEqual(unfiltered);
    expect(await page(inbox.id, `?q=${"x".repeat(200)}`)).toEqual(unfiltered);
  });
  it.each([`q=${"x".repeat(201)}`, `q=${"%20".repeat(201)}`, "q=%00", "q=one&q=two"])(
    "rejects invalid or oversized query %s",
    async (query) => {
      const inbox = await create();
      expect((await req(`/api/inboxes/${inbox.id}/messages?${query}`)).status).toBe(400);
    },
  );
  it("paginates matching rows in timestamp/id order in pages of 30 without gaps or leaks", async () => {
    const inbox = await create();
    const other = await create("other");
    const expected = Array.from(
      { length: 61 },
      (_, i) => `m-${String(i).padStart(2, "0")}`,
    ).reverse();
    await bindings.DB.batch(
      expected.map((id, i) =>
        bindings.DB.prepare(
          "INSERT INTO messages VALUES (?, ?, 'sender', 'match', 'body', ?, ?, ?)",
        ).bind(id, inbox.id, 1000 + Math.floor((60 - i) / 20), now() + 1000, id),
      ),
    );
    await seed(inbox.id, "unmatched", { received: 2000 });
    await seed(inbox.id, "expired", { subject: "match", received: 2000, expires: 1 });
    await seed(other.id, "other", { subject: "match", received: 2000 });
    await patch("/api/messages/m-60", { isRead: true });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let index = 0; index < 3; index++) {
      const result = await page(
        inbox.id,
        `?q=match${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(result.messages).toHaveLength(index < 2 ? 30 : 1);
      if (index === 0) expect(result.messages[0].isRead).toBe(true);
      for (const message of result.messages) {
        expect(typeof message.isRead).toBe("boolean");
        expect(message.body).toBeUndefined();
        seen.push(message.id);
      }
      cursor = result.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(expected);
    expect((await req(`/api/inboxes/${inbox.id}/messages?q=match&cursor=%%%`)).status).toBe(400);
  });
  it("requires authentication and permitted Origin for search", async () => {
    const inbox = await create();
    const path = `/api/inboxes/${inbox.id}/messages?q=secret`;
    expect((await req(path, "GET", undefined, "")).status).toBe(401);
    expect((await raw(path, { headers: { cookie, origin: "https://other.example" } })).status).toBe(
      403,
    );
  });
});

describe("arrival notification watermark", () => {
  async function arrivals() {
    return (
      await bindings.DB.prepare(
        "SELECT sequence, message_id FROM message_arrivals ORDER BY sequence",
      ).all<Arrival>()
    ).results;
  }
  async function latest(id: string) {
    const inbox = (await inboxes()).find((row) => row.id === id);
    expect(inbox).toBeDefined();
    expect(typeof inbox?.latestArrival).toBe("number");
    return inbox?.latestArrival as number;
  }

  it("backfills pre-migration positional messages deterministically by received_at ASC, id ASC", () => {
    expect(backfilledArrivals).toEqual([
      { sequence: 1, message_id: "legacy-a" },
      { sequence: 2, message_id: "legacy-b" },
      { sequence: 3, message_id: "legacy-z" },
    ]);
  });

  it("starts at zero and increases only on arrival, not GET/read/favorite or deletion", async () => {
    const inbox = await create();
    expect(inbox.latestArrival).toBe(0);
    expect(await latest(inbox.id)).toBe(0);
    await seed(inbox.id, "a", { received: 100 });
    const first = await latest(inbox.id);
    expect(first).toBeGreaterThan(0);
    await seed(inbox.id, "z", { received: 100 });
    const second = await latest(inbox.id);
    expect(second).toBeGreaterThan(first);
    await seed(inbox.id, "middle", { received: 50 });
    const third = await latest(inbox.id);
    expect(third).toBeGreaterThan(second);
    expect((await inboxes())[0].latestMessageId).toBe("z");
    const before = await arrivals();
    for (const value of [true, false]) {
      await patch("/api/messages/z", { isRead: value });
      await patch(`/api/inboxes/${inbox.id}`, { favorite: value });
      await page(inbox.id);
      await req("/api/messages/z");
      expect(await latest(inbox.id)).toBe(third);
    }
    expect(await arrivals()).toEqual(before);
    expect((await req("/api/messages/a", "DELETE")).status).toBe(200);
    expect(await latest(inbox.id)).toBe(third);
    expect((await req("/api/messages/middle", "DELETE")).status).toBe(200);
    expect(await latest(inbox.id)).toBe(second);
    expect((await req("/api/messages/z", "DELETE")).status).toBe(200);
    expect(await latest(inbox.id)).toBe(0);
  });

  it("never reuses the highest deleted sequence, even for the same ID and received_at", async () => {
    const inbox = await create();
    await seed(inbox.id, "older");
    const older = await latest(inbox.id);
    await seed(inbox.id, "newer");
    const highest = await latest(inbox.id);
    expect(highest).toBeGreaterThan(older);
    await req("/api/messages/newer", "DELETE");
    expect(await latest(inbox.id)).toBe(older);
    await seed(inbox.id, "newer");
    const reinserted = await latest(inbox.id);
    expect(reinserted).toBeGreaterThan(highest);
    await req("/api/messages/newer", "DELETE");
    await req("/api/messages/older", "DELETE");
    expect(await latest(inbox.id)).toBe(0);
    await seed(inbox.id, "newer");
    expect(await latest(inbox.id)).toBeGreaterThan(reinserted);
  });

  it("excludes expired and other-inbox arrivals and cascades through scheduled cleanup", async () => {
    const inbox = await create();
    const other = await create("other-arrival");
    await seed(inbox.id, "live");
    const live = await latest(inbox.id);
    await seed(inbox.id, "expired", { expires: now() });
    await seed(other.id, "other");
    expect(await latest(inbox.id)).toBe(live);
    expect(await latest(other.id)).toBeGreaterThan(live);
    const highest = await latest(other.id);
    await bindings.DB.prepare(
      "UPDATE messages SET expires_at = 1 WHERE id IN ('live', 'other')",
    ).run();
    expect(await latest(inbox.id)).toBe(0);
    expect(await latest(other.id)).toBe(0);
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), bindings, ctx);
    await waitOnExecutionContext(ctx);
    expect(await arrivals()).toEqual([]);
    await seed(inbox.id, "after-cleanup");
    expect(await latest(inbox.id)).toBeGreaterThan(highest);
  });

  it("does not assign arrivals to raw_digest conflicts ignored by SQL", async () => {
    const inbox = await create();
    await seed(inbox.id, "original");
    const before = await arrivals();
    const watermark = await latest(inbox.id);
    for (const sql of [
      "INSERT OR IGNORE INTO messages VALUES ('duplicate', ?, '', '', '', 1000, ?, 'original')",
      "INSERT INTO messages VALUES ('duplicate', ?, '', '', '', 1000, ?, 'original') ON CONFLICT(inbox_id, raw_digest) DO NOTHING",
    ]) {
      await bindings.DB.prepare(sql)
        .bind(inbox.id, now() + 1000)
        .run();
    }
    expect(await arrivals()).toEqual(before);
    expect(await latest(inbox.id)).toBe(watermark);
    expect((await inboxes())[0].messageCount).toBe(1);
    await seed(inbox.id, "fresh");
    expect(await latest(inbox.id)).toBe(watermark + 1);
  });

  it("assigns one arrival for synthetic email redelivery through the Worker", async () => {
    const inbox = await create("arrival-email");
    const deliver = async () => {
      const bytes = new TextEncoder().encode(
        "From: sender@example.com\r\nSubject: Arrival\r\nContent-Type: text/plain\r\n\r\nSynthetic fixture",
      );
      const rejected: string[] = [];
      const ctx = createExecutionContext();
      await worker.email(
        {
          to: "arrival-email@example.com",
          from: "sender@example.com",
          rawSize: bytes.byteLength,
          raw: new Response(bytes).body,
          setReject: (reason: string) => rejected.push(reason),
        } as unknown as ForwardableEmailMessage,
        bindings,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(rejected).toEqual([]);
    };
    await deliver();
    const first = await latest(inbox.id);
    expect(first).toBeGreaterThan(0);
    await deliver();
    expect(await latest(inbox.id)).toBe(first);
    expect(await arrivals()).toHaveLength(1);
    expect((await inboxes())[0].messageCount).toBe(1);
  });

  it("keeps arrival metadata unique and FK-cascaded on inbox deletion", async () => {
    const columns = await bindings.DB.prepare("PRAGMA table_info(message_arrivals)").all<{
      name: string;
    }>();
    expect(columns.results.map((column) => column.name)).toEqual(["sequence", "message_id"]);
    const inbox = await create();
    await seed(inbox.id);
    expect(await arrivals()).toHaveLength(1);
    await expect(
      bindings.DB.prepare("INSERT INTO message_arrivals (message_id) VALUES ('missing')").run(),
    ).rejects.toThrow();
    await expect(
      bindings.DB.prepare("INSERT INTO message_arrivals (message_id) VALUES ('message-a')").run(),
    ).rejects.toThrow();
    await expect(
      bindings.DB.prepare("INSERT INTO message_arrivals (message_id) VALUES (NULL)").run(),
    ).rejects.toThrow();
    expect((await req(`/api/inboxes/${inbox.id}`, "DELETE")).status).toBe(200);
    expect(await arrivals()).toEqual([]);
  });
});
