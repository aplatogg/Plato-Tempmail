import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Env } from "../src/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

it("adds constrained default-member roles without altering existing account credentials or ownership", async () => {
  const upgrade = bindings.TEST_MIGRATIONS.filter((m) => m.name.startsWith("0006_"));
  expect(upgrade).toHaveLength(1);
  await applyD1Migrations(
    bindings.DB,
    bindings.TEST_MIGRATIONS.filter((m) => m.name < "0006"),
  );
  await bindings.DB.prepare(
    "INSERT INTO users VALUES ('existing', 'existing', 'unchanged', 3, 123)",
  ).run();
  await bindings.DB.prepare(
    "INSERT INTO inboxes VALUES ('existing-box', 'existing@example.com', 123)",
  ).run();
  await bindings.DB.prepare("INSERT INTO inbox_owners VALUES ('existing-box', 'existing')").run();
  const before = await bindings.DB.prepare("SELECT * FROM users").first();
  await applyD1Migrations(bindings.DB, upgrade);
  expect(await bindings.DB.prepare("SELECT * FROM users").first()).toEqual({
    ...before,
    role_mask: 1,
  });
  expect(await bindings.DB.prepare("SELECT * FROM inbox_owners").first()).toEqual({
    inbox_id: "existing-box",
    user_id: "existing",
  });
  for (const invalid of [0, -1, 16, 1.5, "bad", null]) {
    await expect(
      bindings.DB.prepare("UPDATE users SET role_mask = ?").bind(invalid).run(),
    ).rejects.toThrow();
  }
  expect(await bindings.DB.prepare("SELECT * FROM users").first()).toEqual({
    ...before,
    role_mask: 1,
  });
});
