import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { receiveEmail } from "../src/email";
import worker from "../src/index";
import { canUseApiKey, retentionDaysFor } from "../src/roles";
import type { Env, Principal } from "../src/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const origin = "https://mail.example.com";
const encoder = new TextEncoder();
const QUARK_ID = "11111111-1111-4111-8111-111111111111";
const STARDUST_ID = "22222222-2222-4222-8222-222222222222";

// Mirrors the app's verifier format so a member can actually log in.
async function verifier(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    key,
    256,
  );
  const hex = (bytes: Uint8Array) =>
    [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `pbkdf2-sha256$100000$${hex(salt)}$${hex(new Uint8Array(bits))}`;
}

async function call(path: string, method = "GET", body?: unknown, cookie = "") {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(origin + path, {
      method,
      headers: { origin, cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** Delivers one message to `to` through the real inbound path. */
async function deliver(to: string) {
  const raw = encoder.encode(
    `From: sender@example.net\r\nTo: ${to}\r\nSubject: Retensi\r\nMessage-ID: <${crypto.randomUUID()}@example.net>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nkode 123456`,
  );
  let sent = false;
  const message = {
    from: "sender@example.net",
    to,
    rawSize: raw.byteLength,
    raw: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(raw);
          } else {
            controller.close();
          }
        },
      },
      { highWaterMark: 0 },
    ),
    headers: new Headers(),
    setReject() {},
    forward() {},
    reply() {},
  } as unknown as ForwardableEmailMessage;
  const ctx = createExecutionContext();
  await receiveEmail(message, bindings, ctx);
  await waitOnExecutionContext(ctx);
}

async function inboxOwnedBy(address: string, userId: string) {
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO inboxes (id,address,created_at) VALUES (?,?,?)").bind(
      crypto.randomUUID(),
      address,
      1000,
    ),
    bindings.DB.prepare(
      "INSERT INTO inbox_owners (inbox_id,user_id) SELECT id,? FROM inboxes WHERE address = ?",
    ).bind(userId, address),
  ]);
}

async function retentionDays(address: string) {
  const row = await bindings.DB.prepare(
    "SELECT expires_at - received_at AS span FROM messages WHERE inbox_id = (SELECT id FROM inboxes WHERE address = ?)",
  )
    .bind(address)
    .first<{ span: number }>();
  return row ? Math.round(row.span / 86400) : null;
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
      "DELETE FROM inbox_owners",
      "DELETE FROM sessions",
      "DELETE FROM rate_limits",
      "DELETE FROM api_keys",
      "DELETE FROM users",
    ].map((sql) => bindings.DB.prepare(sql)),
  );
});

describe("retention per plan", () => {
  it("maps each role to its ceiling", () => {
    const p = (roles: Principal["roles"]): Principal => ({ id: "x", username: "x", role: "user", roles });
    expect(retentionDaysFor(p(["owner"]), 30)).toBe(30);
    expect(retentionDaysFor(p(["admin"]), 30)).toBe(30);
    expect(retentionDaysFor(p(["dev"]), 30)).toBe(30);
    expect(retentionDaysFor(p(["member_paid"]), 30)).toBe(14);
    expect(retentionDaysFor(p(["member"]), 30)).toBe(7);
    expect(retentionDaysFor(p(["peasant"]), 30)).toBe(7);
    // the highest role in a mixed account wins
    expect(retentionDaysFor(p(["member", "dev"]), 30)).toBe(30);
    // the plan wins over the env value; env only covers an account without a role
    expect(retentionDaysFor(p(["owner"]), 7)).toBe(30);
    expect(retentionDaysFor(p([]), 7)).toBe(7);
  });

  it("stores 30 days for an owner inbox, 14 for Stardust, 7 for Quark", async () => {
    await bindings.DB.prepare(
      "INSERT INTO users (id,username,password_verifier,revision,created_at,role_mask) VALUES (?,?,?,?,?,?)",
    )
      .bind(QUARK_ID, "quark1", "unused", 1, 1000, 16)
      .run();
    await bindings.DB.prepare(
      "INSERT INTO users (id,username,password_verifier,revision,created_at,role_mask) VALUES (?,?,?,?,?,?)",
    )
      .bind(STARDUST_ID, "dust1", "unused", 1, 1000, 32)
      .run();

    await inboxOwnedBy("own@example.com", "owner");
    await inboxOwnedBy("dust@example.com", STARDUST_ID);
    await inboxOwnedBy("quark@example.com", QUARK_ID);

    await deliver("own@example.com");
    await deliver("dust@example.com");
    await deliver("quark@example.com");

    expect(await retentionDays("own@example.com")).toBe(30);
    expect(await retentionDays("dust@example.com")).toBe(14);
    expect(await retentionDays("quark@example.com")).toBe(7);
  });
});

describe("api key eligibility", () => {
  it("allows every plan except Voyager and Quark", () => {
    const p = (roles: Principal["roles"]): Principal => ({ id: "x", username: "x", role: "user", roles });
    expect(canUseApiKey(p(["owner"]))).toBe(true);
    expect(canUseApiKey(p(["admin"]))).toBe(true);
    expect(canUseApiKey(p(["dev"]))).toBe(true);
    expect(canUseApiKey(p(["member_paid"]))).toBe(true);
    expect(canUseApiKey(p(["member"]))).toBe(false);
    expect(canUseApiKey(p(["peasant"]))).toBe(false);
  });

  it("refuses to mint a key for a Quark account", async () => {
    await bindings.DB.prepare(
      "INSERT INTO users (id,username,password_verifier,revision,created_at,role_mask) VALUES (?,?,?,?,?,?)",
    )
      .bind(QUARK_ID, "quark1", await verifier("quark-pass"), 1, 1000, 16)
      .run();

    const login = await call("/api/auth/login", "POST", {
      username: "quark1",
      password: "quark-pass",
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    const minted = await call("/api/keys", "POST", { name: "bot" }, cookie);
    expect(minted.status).toBe(403);
    expect(((await minted.json()) as { error: { code: string } }).error.code).toBe(
      "API_KEY_FORBIDDEN",
    );
  });
});