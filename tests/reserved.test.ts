import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { canClaimReserved, RESERVED, reservedCategory } from "../src/reserved";
import type { Env, Principal } from "../src/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const origin = "https://mail.example.com";
const encoder = new TextEncoder();
const VOYAGER_ID = "33333333-3333-4333-8333-333333333333";
const COSMOS_ID = "44444444-4444-4444-8444-444444444444";

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

async function session(username: string, password: string) {
  const login = await call("/api/auth/login", "POST", { username, password });
  expect(login.status).toBe(200);
  return login.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function makeUser(id: string, username: string, password: string, mask: number) {
  await bindings.DB.prepare(
    "INSERT INTO users (id,username,password_verifier,revision,created_at,role_mask) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, username, await verifier(password), 1, 1000, mask)
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
      "DELETE FROM inbox_owners",
      "DELETE FROM sessions",
      "DELETE FROM rate_limits",
      "DELETE FROM api_keys",
      "DELETE FROM users",
    ].map((sql) => bindings.DB.prepare(sql)),
  );
});

describe("reserved name catalogue", () => {
  it("groups every name by what it imitates", () => {
    expect(Object.keys(RESERVED).sort()).toEqual(["authority", "support", "system"]);
    for (const [category, names] of Object.entries(RESERVED)) {
      expect(names.length).toBeGreaterThan(5);
      for (const name of names) expect(reservedCategory(name)).toBe(category);
    }
    expect(reservedCategory("halfeast")).toBeNull();
  });

  it("only lets the owner principal claim one", () => {
    const p = (id: string, roles: Principal["roles"]): Principal => ({
      id,
      username: "x",
      role: id === "owner" ? "owner" : "user",
      roles,
    });
    expect(canClaimReserved(p("owner", ["owner"]))).toBe(true);
    expect(canClaimReserved(p("44444444-4444-4444-8444-444444444444", ["admin"]))).toBe(false);
    expect(canClaimReserved(p("33333333-3333-4333-8333-333333333333", ["member"]))).toBe(false);
  });
});

describe("reserved names in the API", () => {
  it("refuses a reserved inbox name for a Voyager", async () => {
    await makeUser(VOYAGER_ID, "voyager1", "voyager-pass", 1);
    const cookie = await session("voyager1", "voyager-pass");
    const response = await call("/api/inboxes", "POST", { localPart: "support" }, cookie);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("RESERVED_ADDRESS");
    expect(body.error.message).toContain("Celestial");
  });

  it("still lets that Voyager use an ordinary name", async () => {
    await makeUser(VOYAGER_ID, "voyager1", "voyager-pass", 1);
    const cookie = await session("voyager1", "voyager-pass");
    expect((await call("/api/inboxes", "POST", { localPart: "notreserved" }, cookie)).status).toBe(
      201,
    );
  });

  it("refuses a reserved username for a Cosmos member directory entry", async () => {
    await makeUser(COSMOS_ID, "cosmos1", "cosmos-pass", 4);
    const cookie = await session("cosmos1", "cosmos-pass");
    const response = await call(
      "/api/admin/users",
      "POST",
      { username: "postmaster", password: "some-password" },
      cookie,
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "RESERVED_ADDRESS",
    );
  });

  it("lets Celestial create a reserved username and inbox", async () => {
    const cookie = await session("admin", "admin");
    const user = await call(
      "/api/admin/users",
      "POST",
      { username: "postmaster", password: "some-password" },
      cookie,
    );
    expect(user.status).toBe(201);
    expect((await call("/api/inboxes", "POST", { localPart: "abuse" }, cookie)).status).toBe(201);
  });
});
