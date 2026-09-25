import { pbkdf2Sync } from "node:crypto";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { expect, test } from "@playwright/test";
import { createTestHarness } from "wrangler";
import type { Env, Principal, Role } from "../../src/types";

test("local Worker multi-role API contract, role revocation and immutable bootstrap identity", async () => {
  const salt = "00112233445566778899aabbccddeeff";
  const digest = Array.from(
    pbkdf2Sync("admin", Buffer.from(salt, "hex"), 100_000, 32, "sha256"),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const workerOptions = {
    configPath: "./wrangler.jsonc",
    vars: {
      PUBLIC_ORIGIN: "http://127.0.0.1",
      ADMIN_USERNAME: "admin",
      APP_NAME: "Plato",
      MAIL_DOMAIN: "example.com",
      MESSAGE_RETENTION_DAYS: "7",
    },
    secrets: { AUTH_PASSWORD_HASH: `pbkdf2-sha256$100000$${salt}$${digest}` },
  };
  const server = createTestHarness({ workers: [workerOptions] });
  try {
    const { url } = await server.listen();
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(url.hostname);
    workerOptions.vars.PUBLIC_ORIGIN = url.origin;
    await server.update({ workers: [workerOptions] });
    const bindings = await server.getWorker<Env>().getEnv();
    for (const migration of await readD1Migrations("migrations")) {
      await bindings.DB.batch(migration.queries.map((sql) => bindings.DB.prepare(sql)));
    }
    let client = 0;
    const request = (
      path: string,
      token = "",
      body?: unknown,
      method = body === undefined ? "GET" : "POST",
    ) =>
      fetch(new URL(path, url), {
        method,
        redirect: "error",
        headers: {
          origin: url.origin,
          cookie: token,
          "content-type": "application/json",
          "cf-connecting-ip": `192.0.2.${++client}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const login = async (username: string, password: string) => {
      const response = await request("/api/auth/login", "", { username, password });
      expect(response.status).toBe(200);
      return response.headers.get("set-cookie")?.split(";")[0] ?? "";
    };
    const token = await login("admin", "admin");
    for (const [username, roles] of [
      ["manager", ["admin", "dev"]],
      ["otherowner", ["owner"]],
    ] as const) {
      const response = await request("/api/admin/users", token, {
        username,
        password: "local member password",
        roles,
      });
      expect(response.status).toBe(201);
    }
    const manager = await login("manager", "local member password");
    const other = await login("otherowner", "local member password");
    const directory = await request("/api/admin/users", manager);
    const listed = (await directory.json()) as {
      users: (Principal & { createdAt: number | null })[];
      assignableRoles: Role[];
    };
    expect(listed.assignableRoles).toEqual(["member", "dev"]);
    expect(listed.users[0]).toEqual({
      id: "owner",
      username: "admin",
      role: "owner",
      roles: ["owner"],
      createdAt: null,
    });
    const managerId = listed.users.find((user) => user.username === "manager")?.id;
    const otherId = listed.users.find((user) => user.username === "otherowner")?.id;
    expect(managerId).toEqual(expect.any(String));
    expect(otherId).toEqual(expect.any(String));
    expect(
      (await request(`/api/admin/users/${otherId}/password`, manager, { password: "forbidden" }))
        .status,
    ).toBe(403);
    expect(
      (await request("/api/admin/users/owner/password", other, { password: "forbidden" })).status,
    ).toBe(403);
    expect(
      (await request("/api/admin/users/owner/roles", other, { roles: ["member"] }, "PATCH")).status,
    ).toBe(403);
    expect(await (await request("/api/dev/diagnostics", manager)).json()).toEqual({
      ok: true,
      application: { name: "Plato", mailDomain: "example.com", retentionDays: 7 },
      database: { ok: true },
      counts: { users: 2, inboxes: 0, messages: 0 },
    });
    expect(
      (
        await request("/api/auth/password", other, {
          currentPassword: "local member password",
          newPassword: "changed stored owner",
        })
      ).status,
    ).toBe(200);
    expect(await bindings.DB.prepare("SELECT * FROM app_credentials").first()).toBeNull();
    expect((await request("/api/auth/session", token)).status).toBe(200);
    expect((await request("/api/auth/session", other)).status).toBe(401);
    expect(
      (await request(`/api/admin/users/${managerId}/roles`, token, { roles: ["member"] }, "PATCH"))
        .status,
    ).toBe(200);
    expect((await request("/api/dev/diagnostics", manager)).status).toBe(401);
    const member = await login("manager", "local member password");
    expect((await request("/api/dev/diagnostics", member)).status).toBe(403);
    expect((await request("/api/admin/users", member)).status).toBe(403);
    expect((await request("/api/inboxes", member, { localPart: "own-mail" })).status).toBe(201);
  } finally {
    await server.close();
  }
});
