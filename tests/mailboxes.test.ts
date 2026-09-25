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
async function req(path: string, method = "GET", body?: unknown, session = cookie) {
  const ctx = createExecutionContext();
  const result = await worker.fetch(
    new Request(origin + path, {
      method,
      headers: { origin, cookie: session, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return result;
}
async function create(localPart = "known") {
  const response = await req("/api/inboxes", "POST", { localPart });
  expect(response.status).toBe(201);
  return ((await response.json()) as { inbox: { id: string; address: string } }).inbox;
}
async function seed(inbox: string, total = 1, expiresAt = Math.floor(Date.now() / 1000) + 1000) {
  await bindings.DB.prepare(`WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n < ?)
    INSERT INTO messages SELECT 'message-'||n, ?, 'sender@example.com', '<script>subject</script>', '<img src=x onerror=alert(1)>code 123456', 1000, ?, 'digest-'||n FROM nums`)
    .bind(total, inbox, expiresAt)
    .run();
}
beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
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
  const response = await req(
    "/api/auth/login",
    "POST",
    { username: "admin", password: "admin" },
    "",
  );
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
});

describe("private mailbox API", () => {
  it.each(["/api/inboxes", "/api/inboxes/anything/messages", "/api/messages/anything"])(
    "requires authentication on %s",
    async (path) => {
      expect((await req(path, "GET", undefined, "")).status).toBe(401);
    },
  );
  it("lists the same persistent inbox from another device", async () => {
    const inbox = await create("Custom_Name-12");
    expect(inbox.address).toBe("custom_name-12@example.com");
    const second = await req(
      "/api/auth/login",
      "POST",
      { username: "admin", password: "admin" },
      "",
    );
    const result = await req(
      "/api/inboxes",
      "GET",
      undefined,
      second.headers.get("set-cookie")?.split(";")[0],
    );
    expect(await result.json()).toMatchObject({
      inboxes: [{ id: inbox.id, address: inbox.address, messageCount: 0 }],
    });
  });
  it("generates different random addresses", async () => {
    const first = await create("");
    const second = await create("");
    expect(first.address).not.toBe(second.address);
    expect(first.address).toMatch(/^[a-z0-9][a-z0-9_-]{0,31}@example\.com$/);
  });
  it.each([
    "bad@other.test",
    "a.b",
    "../x",
    " has space",
    "admin",
    "postmaster",
    "ABUSE",
    "-start",
    "x".repeat(33),
  ])("rejects invalid/reserved name %s", async (localPart) => {
    expect((await req("/api/inboxes", "POST", { localPart })).status).toBe(400);
  });
  it.each([{ localPart: 42 }, { localPart: [] }, { localPart: "fine", role: "admin" }])(
    "rejects invalid fields %j",
    async (body) => {
      expect((await req("/api/inboxes", "POST", body)).status).toBe(400);
    },
  );
  it("rejects duplicate names without overwriting the inbox", async () => {
    const inbox = await create();
    expect((await req("/api/inboxes", "POST", { localPart: "KNOWN" })).status).toBe(409);
    expect(await bindings.DB.prepare("SELECT id FROM inboxes").first("id")).toBe(inbox.id);
  });
  it("atomically enforces the 100 inbox limit", async () => {
    await bindings.DB.prepare(`WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n < 99)
      INSERT INTO inboxes SELECT 'seed-'||n, 'seed-'||n||'@example.com', 1 FROM nums`).run();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        req("/api/inboxes", "POST", { localPart: `parallel-${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM inboxes").first("n")).toBe(100);
  });
  it("paginates tied timestamps without duplication and omits bodies from lists", async () => {
    const inbox = await create();
    await seed(inbox.id, 61);
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const response = await req(
        `/api/inboxes/${inbox.id}/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        messages: { id: string; body?: string; preview: string }[];
        nextCursor: string | null;
      };
      expect(result.messages).toHaveLength(page < 2 ? 30 : 1);
      for (const msg of result.messages) {
        expect(seen.has(msg.id)).toBe(false);
        seen.add(msg.id);
        expect(msg.body).toBeUndefined();
        expect(msg.preview.length).toBeLessThanOrEqual(160);
      }
      cursor = result.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(seen.size).toBe(61);
  });
  it("rejects invalid cursors", async () => {
    const inbox = await create();
    expect((await req(`/api/inboxes/${inbox.id}/messages?cursor=%%%`)).status).toBe(400);
    expect((await req(`/api/inboxes/${inbox.id}/messages?cursor=${"x".repeat(1000)}`)).status).toBe(
      400,
    );
  });
  it("hides expired messages from count/list/detail without awaiting cron", async () => {
    const inbox = await create();
    await seed(inbox.id, 1, 1);
    expect(await (await req("/api/inboxes")).json()).toMatchObject({
      inboxes: [{ messageCount: 0 }],
    });
    expect(await (await req(`/api/inboxes/${inbox.id}/messages`)).json()).toEqual({
      messages: [],
      nextCursor: null,
    });
    expect((await req("/api/messages/message-1")).status).toBe(404);
  });
  it("reads untrusted message as JSON text and permanently deletes it", async () => {
    const inbox = await create();
    await seed(inbox.id);
    const response = await req("/api/messages/message-1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      message: {
        id: "message-1",
        inboxId: inbox.id,
        from: "sender@example.com",
        body: "<img src=x onerror=alert(1)>code 123456",
      },
    });
    expect((await req("/api/messages/message-1", "DELETE")).status).toBe(200);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM messages").first("n")).toBe(0);
  });
  it("deleting an inbox cascades stored messages", async () => {
    const inbox = await create();
    await seed(inbox.id, 3);
    expect((await req(`/api/inboxes/${inbox.id}`, "DELETE")).status).toBe(200);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM messages").first("n")).toBe(0);
    expect((await req(`/api/inboxes/${inbox.id}/messages`)).status).toBe(404);
    expect((await req(`/api/inboxes/${inbox.id}`, "DELETE")).status).toBe(404);
  });
  it("receives mail through the exported Worker and exposes it only after login", async () => {
    const inbox = await create();
    const mime = new TextEncoder().encode(
      "From: sender@example.com\r\nSubject: Your code\r\nContent-Type: text/plain\r\n\r\nCode 456789",
    );
    const rejected: string[] = [];
    const ctx = createExecutionContext();
    await worker.email(
      {
        to: inbox.address,
        from: "sender@example.com",
        rawSize: mime.byteLength,
        raw: new Response(mime).body,
        setReject: (reason: string) => rejected.push(reason),
      } as unknown as ForwardableEmailMessage,
      bindings,
      ctx,
    );
    expect(rejected).toEqual([]);
    const result = (await (await req(`/api/inboxes/${inbox.id}/messages`)).json()) as {
      messages: { id: string; subject: string }[];
    };
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].subject).toBe("Your code");
    expect((await req(`/api/messages/${result.messages[0].id}`, "GET", undefined, "")).status).toBe(
      401,
    );
    await bindings.DB.prepare("UPDATE messages SET expires_at = 1").run();
    await worker.scheduled(createScheduledController(), bindings, ctx);
    await waitOnExecutionContext(ctx);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM messages").first("n")).toBe(0);
  });
});
