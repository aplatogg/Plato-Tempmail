import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const origin = "https://mail.example.com";
let client = 0;

async function request(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${origin}${path}`, init), { ...bindings }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function call(method: string, path: string, cookie: string, body?: unknown) {
  return request(path, {
    method,
    headers: {
      origin,
      cookie,
      "cf-connecting-ip": `192.0.2.${++client}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function owner() {
  const response = await call("POST", "/api/auth/login", "", {
    username: "admin",
    password: "admin",
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function inbox(cookie: string, localPart = "box") {
  const response = await call("POST", "/api/inboxes", cookie, { localPart });
  expect(response.status).toBe(201);
  return ((await response.json()) as { inbox: { id: string; address: string } }).inbox;
}

beforeAll(() => applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS));

beforeEach(async () => {
  client = 0;
  await bindings.DB.batch([
    bindings.DB.prepare("DELETE FROM sessions"),
    bindings.DB.prepare("DELETE FROM inboxes"),
    bindings.DB.prepare("DELETE FROM address_claims"),
    bindings.DB.prepare("DELETE FROM rate_limits"),
    bindings.DB.prepare("DELETE FROM users"),
    bindings.DB.prepare("DELETE FROM app_credentials"),
  ]);
});

describe("message filters and bulk actions", () => {
  it("filters unread, marks all read and deletes all", async () => {
    const cookie = await owner();
    const box = await inbox(cookie);
    const now = Math.floor(Date.now() / 1000);
    for (const [index, read] of [0, 1, 0].entries()) {
      await bindings.DB.prepare(
        `INSERT INTO messages (id, inbox_id, from_address, subject, body, received_at, expires_at, raw_digest)
         VALUES (?, ?, 'a@b.test', ?, 'body', ?, ?, ?)`,
      )
        .bind(`m-${index}`, box.id, `subject ${index}`, now + index, now + 3600, `d-${index}`)
        .run();
      if (read)
        await bindings.DB.prepare(
          "INSERT INTO message_read_state (message_id, is_read) VALUES (?, 1)",
        )
          .bind(`m-${index}`)
          .run();
    }

    const unread = await call("GET", `/api/inboxes/${box.id}/messages?filter=unread`, cookie);
    expect(unread.status).toBe(200);
    expect(((await unread.json()) as { messages: unknown[] }).messages).toHaveLength(2);

    expect((await call("POST", `/api/inboxes/${box.id}/read-all`, cookie, {})).status).toBe(200);
    const afterRead = await call("GET", `/api/inboxes/${box.id}/messages?filter=unread`, cookie);
    expect(((await afterRead.json()) as { messages: unknown[] }).messages).toHaveLength(0);

    const cleared = await call("DELETE", `/api/inboxes/${box.id}/messages`, cookie);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ok: true, deleted: 3 });
    const empty = await call("GET", `/api/inboxes/${box.id}/messages`, cookie);
    expect(((await empty.json()) as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it("rejects an unknown filter", async () => {
    const cookie = await owner();
    const box = await inbox(cookie);
    expect((await call("GET", `/api/inboxes/${box.id}/messages?filter=weird`, cookie)).status).toBe(
      400,
    );
  });
});

describe("message extras", () => {
  it("returns html and attachment metadata in the detail response", async () => {
    const cookie = await owner();
    const box = await inbox(cookie);
    const now = Math.floor(Date.now() / 1000);
    const attachments = JSON.stringify([
      { name: "invoice.pdf", type: "application/pdf", size: 2048 },
    ]);
    await bindings.DB.prepare(
      `INSERT INTO messages (id, inbox_id, from_address, subject, body, html, attachments, received_at, expires_at, raw_digest)
       VALUES ('detail-1', ?, 'billing@test', 'Invoice', 'plain body', '<p>html body</p>', ?, ?, ?, 'd1')`,
    )
      .bind(box.id, attachments, now, now + 3600)
      .run();
    const response = await call("GET", "/api/messages/detail-1", cookie);
    expect(response.status).toBe(200);
    const { message } = (await response.json()) as {
      message: { html: string; attachments: { name: string; size: number }[] };
    };
    expect(message.html).toContain("html body");
    expect(message.attachments[0]).toEqual({
      name: "invoice.pdf",
      type: "application/pdf",
      size: 2048,
    });
  });
});

describe("inbox forwarding", () => {
  it("stores, exposes and clears a public https webhook", async () => {
    const cookie = await owner();
    const box = await inbox(cookie);

    const saved = await call("PUT", `/api/inboxes/${box.id}/webhook`, cookie, {
      url: "https://hooks.example.com/plato",
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true, webhook: true });

    const listed = await call("GET", "/api/inboxes", cookie);
    const { inboxes } = (await listed.json()) as { inboxes: { webhookUrl: string }[] };
    expect(inboxes[0]?.webhookUrl).toBe("https://hooks.example.com/plato");

    for (const url of [
      "http://hooks.example.com/x",
      "https://localhost/x",
      "https://10.0.0.1/x",
      "https://127-0-0-1.sslip.io/x",
      "https://[64:ff9b::7f00:1]/x",
    ]) {
      const response = await call("PUT", `/api/inboxes/${box.id}/webhook`, cookie, { url });
      expect(response.status).toBe(400);
    }

    const cleared = await call("PUT", `/api/inboxes/${box.id}/webhook`, cookie, { url: null });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ok: true, webhook: false });
  });
});
