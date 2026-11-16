import {
  applyD1Migrations,
  createExecutionContext,
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

async function req(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const ctx = createExecutionContext();
  const result = await worker.fetch(
    new Request(origin + path, {
      method,
      headers: { origin, cookie, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return result;
}

/** Calls /api/v1 the way a bot does: no cookie, no Origin, only the bearer key. */
async function bot(path: string, method = "GET", body?: unknown, token = "") {
  const ctx = createExecutionContext();
  const result = await worker.fetch(
    new Request(origin + path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return result;
}

async function mintKey(name = "bot"): Promise<{ id: string; token: string }> {
  const response = await req("/api/keys", "POST", { name });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; token: string };
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
      "DELETE FROM api_keys",
    ].map((sql) => bindings.DB.prepare(sql)),
  );
  const response = await req("/api/auth/login", "POST", {
    username: "admin",
    password: "admin",
  });
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
});

describe("api keys", () => {
  it("authenticates /api/v1 without a cookie or an origin header", async () => {
    const { token } = await mintKey();
    const me = await bot("/api/v1/me", "GET", undefined, token);
    expect(me.status).toBe(200);
    const body = (await me.json()) as { username: string; mailDomain: string };
    expect(body.username).toBe("admin");
    expect(body.mailDomain).toBe("example.com");
  });

  it("rejects a missing or unknown key", async () => {
    expect((await bot("/api/v1/me")).status).toBe(401);
    const unknown = await bot("/api/v1/me", "GET", undefined, "hvk_000000000000_" + "0".repeat(48));
    expect(unknown.status).toBe(401);
  });

  it("creates one inbox and a bulk batch with the key", async () => {
    const { token } = await mintKey();
    const one = await bot("/api/v1/inboxes", "POST", { localPart: "solo" }, token);
    expect(one.status).toBe(201);
    expect((await one.json())).toMatchObject({ inbox: { address: "solo@example.com" } });

    const bulk = await bot("/api/v1/inboxes/bulk", "POST", { count: 3, prefix: "run" }, token);
    expect(bulk.status).toBe(201);
    const batch = (await bulk.json()) as { created: { inbox: { address: string } }[]; failed: unknown[] };
    expect(batch.created).toHaveLength(3);
    expect(batch.failed).toHaveLength(0);
    // A prefix is the caller's text; the server only appends digits. No dash,
    // no underscore, no hex code.
    for (const item of batch.created) expect(item.inbox.address).toMatch(/^run\d{2,3}@example\.com$/);
  });

  it("generates human-shaped addresses when no prefix is given", async () => {
    const { token } = await mintKey();
    const bulk = await bot("/api/v1/inboxes/bulk", "POST", { count: 5 }, token);
    expect(bulk.status).toBe(201);
    const batch = (await bulk.json()) as { created: { inbox: { address: string } }[] };
    expect(batch.created).toHaveLength(5);
    const seen = new Set<string>();
    for (const item of batch.created) {
      const local = item.inbox.address.split("@")[0];
      expect(local).toMatch(/^[a-z]+\d{1,2}$/); // letters then a number
      expect(local).not.toMatch(/[-_]/);
      seen.add(local);
    }
    expect(seen.size).toBe(5);
  });

  it("creates exactly the requested addresses via localParts", async () => {
    const { token } = await mintKey();
    const wanted = ["titikwiduri54", "kurirpaket55"];
    const bulk = await bot("/api/v1/inboxes/bulk", "POST", { localParts: wanted }, token);
    expect(bulk.status).toBe(201);
    const batch = (await bulk.json()) as { created: { inbox: { address: string } }[] };
    expect(batch.created.map((item) => item.inbox.address)).toEqual([
      "titikwiduri54@example.com",
      "kurirpaket55@example.com",
    ]);
  });

  it("accepts single-create aliases name and address", async () => {
    const { token } = await mintKey();
    const byName = await bot("/api/v1/inboxes", "POST", { name: "budi_santoso" }, token);
    expect(byName.status).toBe(201);
    expect(((await byName.json()) as { inbox: { address: string } }).inbox.address).toBe(
      "budi_santoso@example.com",
    );

    const byAddress = await bot(
      "/api/v1/inboxes",
      "POST",
      { address: "umarsantoso24@example.com" },
      token,
    );
    expect(byAddress.status).toBe(201);
    expect(((await byAddress.json()) as { inbox: { address: string } }).inbox.address).toBe(
      "umarsantoso24@example.com",
    );

    const wrongDomain = await bot(
      "/api/v1/inboxes",
      "POST",
      { address: "someone@other.test" },
      token,
    );
    expect(wrongDomain.status).toBe(400);
  });

  it("reads message list and body with the key", async () => {
    const { token } = await mintKey();
    const created = await bot("/api/v1/inboxes", "POST", { localPart: "reader" }, token);
    const inbox = ((await created.json()) as { inbox: { id: string } }).inbox;
    await bindings.DB.prepare(`INSERT INTO messages
      (id, inbox_id, from_address, subject, body, received_at, expires_at, raw_digest)
      VALUES ('m1', ?, 'otp@service.test', 'Kode OTP', 'Kode verifikasi: 918273', 1000, 9999999999, 'digest-1')`)
      .bind(inbox.id)
      .run();

    const list = await bot(`/api/v1/inboxes/${inbox.id}/messages`, "GET", undefined, token);
    expect(list.status).toBe(200);
    const page = (await list.json()) as { messages: { id: string; subject: string; isRead: boolean }[] };
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({ subject: "Kode OTP", isRead: false });

    const detail = await bot(`/api/v1/messages/${page.messages[0].id}`, "GET", undefined, token);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { message: { body: string } };
    expect(body.message.body).toContain("918273");
  });

  it("retires a key when it is revoked", async () => {
    const { id, token } = await mintKey();
    expect((await bot("/api/v1/me", "GET", undefined, token)).status).toBe(200);
    const revoked = await req(`/api/keys/${id}`, "DELETE");
    expect(revoked.status).toBe(200);
    expect((await bot("/api/v1/me", "GET", undefined, token)).status).toBe(401);
  });

  it("retires every key when the password changes", async () => {
    const { token } = await mintKey();
    const changed = await req("/api/auth/password", "POST", {
      currentPassword: "admin",
      newPassword: "another-secret",
    });
    expect(changed.status).toBe(200);
    expect((await bot("/api/v1/me", "GET", undefined, token)).status).toBe(401);
  });
});