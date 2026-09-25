import { pbkdf2Sync } from "node:crypto";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { expect, type Page, test } from "@playwright/test";
import { createTestHarness } from "wrangler";
import type { Env } from "../../src/types";

declare const window: { innerWidth: number };
declare const document: { documentElement: { scrollWidth: number } };

interface Inbox {
  id: string;
  address: string;
  favorite: boolean;
  messageCount: number;
  unreadCount: number;
}

async function inboxNavigation(page: Page) {
  if (await page.locator("#back-messages").isVisible())
    await page.locator("#back-messages").click();
  if (await page.locator("#back-inboxes").isVisible()) await page.locator("#back-inboxes").click();
}

test("real Worker multiuser isolation, read-only owner inspection and targeted password reset", async ({
  page: owner,
  browser,
}, testInfo) => {
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
      MAIL_DOMAIN: "example.com",
      MESSAGE_RETENTION_DAYS: "7",
    },
    secrets: { AUTH_PASSWORD_HASH: `pbkdf2-sha256$100000$${salt}$${digest}` },
  };
  const server = createTestHarness({ workers: [workerOptions] });
  const contexts = [];
  const errors: string[] = [];
  owner.on("pageerror", (error) => errors.push(`owner: ${error.message}`));
  const memberPassword = "Member-local-password-782345";
  const replacementPassword = "Replacement-local-password-945678";
  try {
    const { url } = await server.listen();
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(url.hostname);
    workerOptions.vars.PUBLIC_ORIGIN = url.origin;
    await server.update({ workers: [workerOptions] });
    const handle = server.getWorker<Env>();
    const bindings = await handle.getEnv();
    // Cloudflare's parser preserves complete SQL trigger bodies; never split on semicolons.
    for (const migration of await readD1Migrations("migrations")) {
      await bindings.DB.batch(migration.queries.map((sql) => bindings.DB.prepare(sql)));
    }

    // Only this ephemeral local harness receives simulated edge client headers.
    // Each context has its own cookie jar and <= 3 login attempts, without changing limits.
    await owner.context().setExtraHTTPHeaders({ "CF-Connecting-IP": "192.0.2.1" });
    const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = testInfo.project.use;
    for (const [index, label] of ["alice", "bob", "alice-second-session"].entries()) {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor,
        isMobile,
        hasTouch,
        userAgent,
        extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${index + 2}` },
      });
      contexts.push(context);
      context.on("page", (page) => {
        page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
      });
    }
    const [alice, bob, aliceOther] = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const pages = [owner, alice, bob, aliceOther];
    const request = (page: Page, path: string, method = "GET", data?: unknown) =>
      page.request.fetch(new URL(`/api${path}`, url).href, {
        method,
        headers: { Origin: url.origin },
        ...(data === undefined ? {} : { data }),
      });
    const inboxes = async (page: Page): Promise<Inbox[]> => {
      const response = await request(page, "/inboxes");
      expect(response.status()).toBe(200);
      return (await response.json()).inboxes;
    };
    const login = async (page: Page, username: string, password: string, status = 200) => {
      await page.getByLabel("Nama pengguna", { exact: true }).fill(username);
      await page.getByLabel("Kata sandi", { exact: true }).fill(password);
      const response = page.waitForResponse(
        (response) =>
          response.url() === new URL("/api/auth/login", url).href &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Masuk", exact: true }).click();
      expect((await response).status()).toBe(status);
      await expect(page.locator("#password")).toHaveValue("");
      if (status === 200) {
        await expect(page.locator("#workspace")).toBeVisible();
        await expect(page.locator("#account-name")).toHaveText(username);
        expect((await response).request().postDataJSON()).toEqual({ username, password });
      } else {
        await expect(page.locator("#login-error")).toBeVisible();
        await expect(page.locator("#workspace")).toBeHidden();
      }
    };
    const createInbox = async (page: Page, localPart: string) => {
      await inboxNavigation(page);
      await page.locator("#new-inbox").click();
      await page.locator("#local-part").fill(localPart);
      const response = page.waitForResponse(
        (response) =>
          response.url() === new URL("/api/inboxes", url).href &&
          response.request().method() === "POST",
      );
      await page.locator("#create-submit").click();
      expect((await response).status()).toBe(201);
      await expect(page.locator("#selected-address")).toHaveText(`${localPart}@example.com`);
      return (await (await response).json()).inbox as Inbox;
    };
    const deliver = async (address: string, subject: string, body: string) => {
      await handle.email({
        from: "sender@example.net",
        to: address,
        raw: [
          "From: sender@example.net",
          `To: ${address}`,
          `Message-ID: <${subject.replaceAll(" ", "-")}@example.net>`,
          `Subject: ${subject}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "",
          body,
        ].join("\r\n"),
      });
    };
    const notFound = async (page: Page, path: string, method = "GET", data?: unknown) => {
      const response = await request(page, path, method, data);
      expect(response.status(), `${method} ${path}`).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    };

    let ownerBox: Inbox;
    let aliceBox: Inbox;
    let bobBox: Inbox;
    let aliceId: string;
    let aliceMessageId: string;
    let ownerMessageId: string;
    await test.step("owner logs in and creates two members through the actual admin UI", async () => {
      await owner.goto(url.href);
      await expect(owner.locator("#login a[href='https://github.com/aplatogg']")).toBeVisible();
      await login(owner, "admin", "admin");
      await expect(owner.locator("#manage-users")).toBeVisible();
      await expect(owner.locator("#admin-disclosure")).toBeHidden();
      ownerBox = await createInbox(owner, "owner-private");
      await deliver(ownerBox.address, "Owner sentinel", "Owner inbox must survive scope changes.");
      await owner.locator("#refresh-messages").click();
      await owner.getByRole("button", { name: "Baca Owner sentinel", exact: true }).click();
      await expect(owner.locator("#message-body")).toContainText("Owner inbox must survive");
      const ownerMessages = await request(owner, `/inboxes/${ownerBox.id}/messages`);
      ownerMessageId = (await ownerMessages.json()).messages[0].id;
      await expect
        .poll(() =>
          bindings.DB.prepare("SELECT is_read FROM message_read_state WHERE message_id = ?")
            .bind(ownerMessageId)
            .first("is_read"),
        )
        .toBe(1);
      await owner.locator("#manage-users").click();
      await expect(owner.locator("#users-count")).toHaveText("0/100 akun tambahan");
      await expect(owner.getByRole("button", { name: "Reset kata sandi admin" })).toHaveCount(0);
      for (const username of ["alice", "bob"]) {
        await owner.locator("#user-username").fill(username);
        await owner.locator("#user-password").fill(memberPassword);
        const response = owner.waitForResponse(
          (response) =>
            response.url() === new URL("/api/admin/users", url).href &&
            response.request().method() === "POST",
        );
        await owner.locator("#user-create-submit").click();
        expect((await response).status()).toBe(201);
        const data = await (await response).json();
        expect(data.user).toMatchObject({ username, role: "user", roles: ["member"] });
        expect(Object.keys(data.user).sort()).toEqual([
          "createdAt",
          "id",
          "role",
          "roles",
          "username",
        ]);
        if (username === "alice") aliceId = data.user.id;
        await expect(owner.getByRole("button", { name: `Lihat inbox ${username}` })).toBeVisible();
        await expect(owner.locator("#user-password")).toHaveValue("");
      }
      await expect(owner.locator("#users-count")).toHaveText("2/100 akun tambahan");
      await owner.locator("#close-users").click();
      expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(2);
    });

    await test.step("independent member sessions create private inboxes and receive actual MIME mail", async () => {
      for (const [page, username] of [
        [alice, "alice"],
        [bob, "bob"],
        [aliceOther, "alice"],
      ] as const) {
        await page.goto(url.href);
        await login(page, username, memberPassword);
        await expect(page.locator("#manage-users")).toBeHidden();
        await expect(page.locator("#admin-disclosure")).toHaveText(
          "Owner dapat membaca inbox Anda. Admin tanpa peran Owner tidak dapat mengakses inbox pengguna lain.",
        );
        await expect(page.locator("#admin-disclosure")).toBeVisible();
        await expect(page.locator("#inspection-banner")).toBeHidden();
      }
      const cookies = await Promise.all(pages.map((page) => page.context().cookies()));
      const sessions = cookies.map((jar) => jar.find((cookie) => cookie.name === "plato_session"));
      for (const session of sessions)
        expect(session).toMatchObject({ httpOnly: true, sameSite: "Strict" });
      expect(new Set(sessions.map((session) => session?.value)).size).toBe(4);
      aliceBox = await createInbox(alice, "alice-private");
      bobBox = await createInbox(bob, "bob-private");
      await deliver(aliceBox.address, "Alice private code", "Alice-only verification code: 782345");
      await alice.locator("#refresh-messages").click();
      await expect(alice.getByRole("button", { name: "Baca Alice private code" })).toBeVisible();
      const messages = await request(alice, `/inboxes/${aliceBox.id}/messages`);
      expect(messages.status()).toBe(200);
      const data = await messages.json();
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0]).toMatchObject({ subject: "Alice private code", isRead: false });
      aliceMessageId = data.messages[0].id;
      for (const [page, box] of [
        [owner, ownerBox],
        [alice, aliceBox],
        [bob, bobBox],
      ] as const) {
        const list = await inboxes(page);
        expect(list.map((inbox) => inbox.id)).toEqual([box.id]);
      }
      await inboxNavigation(alice);
      await alice.getByRole("button", { name: `Favorit ${aliceBox.address}`, exact: true }).click();
      await expect(
        alice.getByRole("button", { name: `Favorit ${aliceBox.address}` }),
      ).toHaveAttribute("aria-pressed", "true");
      await bob.locator("#refresh-messages").click();
      await expect(bob.locator("#messages-state")).toContainText("Belum ada pesan");
      await bob.locator("#message-search").fill("782345");
      await bob.locator("#message-search").press("Enter");
      await expect(bob.locator("#messages-state")).toHaveText(
        "Tidak ada hasil untuk pencarian ini.",
      );
      await expect(bob.locator("#message-list .message-item")).toHaveCount(0);
      await expect(bob.locator("#message-body")).toBeEmpty();
      await expect(bob.locator("#inbox-list")).not.toContainText(aliceBox.address);
      await expect(bob.locator("#inbox-list")).not.toContainText(ownerBox.address);
      const search = await request(bob, `/inboxes/${bobBox.id}/messages?q=782345`);
      expect(search.status()).toBe(200);
      expect(await search.json()).toEqual({ messages: [], nextCursor: null });
    });

    await test.step("foreign identifiers return 404 and member administration remains forbidden", async () => {
      for (const [box, messageId] of [
        [aliceBox, aliceMessageId],
        [ownerBox, ownerMessageId],
      ] as const) {
        await notFound(bob, `/inboxes/${box.id}/messages`);
        await notFound(bob, `/inboxes/${box.id}/messages?q=782345`);
        await notFound(bob, `/messages/${messageId}`);
        await notFound(bob, `/messages/${messageId}`, "PATCH", { isRead: true });
        await notFound(bob, `/messages/${messageId}`, "DELETE");
        await notFound(bob, `/inboxes/${box.id}`, "PATCH", { favorite: false });
        await notFound(bob, `/inboxes/${box.id}`, "DELETE");
      }
      // The explicit user selector has its own documented 403 contract, unlike item IDs.
      for (const userId of [aliceId, "owner"])
        expect((await request(bob, `/inboxes?userId=${userId}`)).status()).toBe(403);
      expect((await request(bob, "/admin/users")).status()).toBe(403);
      expect(
        (
          await request(bob, "/admin/users", "POST", {
            username: "forbidden-member",
            password: memberPassword,
          })
        ).status(),
      ).toBe(403);
      expect(
        (
          await request(bob, `/admin/users/${aliceId}/password`, "POST", {
            password: replacementPassword,
          })
        ).status(),
      ).toBe(403);
      expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(2);
    });

    await test.step("cross-user address collision exposes the exact 409 message in the UI", async () => {
      await inboxNavigation(bob);
      await bob.locator("#new-inbox").click();
      await bob.locator("#local-part").fill("alice-private");
      const response = bob.waitForResponse(
        (response) =>
          response.url() === new URL("/api/inboxes", url).href &&
          response.request().method() === "POST",
      );
      await bob.locator("#create-submit").click();
      expect((await response).status()).toBe(409);
      expect(await (await response).json()).toEqual({
        error: {
          code: "ADDRESS_EXISTS",
          message: "Email sudah digunakan. Silakan gunakan email lain.",
        },
      });
      await expect(bob.locator("#create-error")).toHaveText(
        "Email sudah digunakan. Silakan gunakan email lain.",
      );
      await bob.locator("#cancel-create").click();
      expect((await inboxes(bob)).map((inbox) => inbox.id)).toEqual([bobBox.id]);
    });

    await test.step("Lihat inbox reads without mutations and returning preserves the owner's mailbox", async () => {
      const snapshot = () =>
        bindings.DB.prepare(`SELECT i.id, i.address, o.user_id, m.id AS message_id, m.body,
          COALESCE(r.is_read, 0) AS is_read, COALESCE(f.favorite, 0) AS favorite
          FROM inboxes i JOIN inbox_owners o ON o.inbox_id = i.id
          LEFT JOIN messages m ON m.inbox_id = i.id
          LEFT JOIN message_read_state r ON r.message_id = m.id
          LEFT JOIN inbox_favorites f ON f.inbox_id = i.id ORDER BY i.id, m.id`).all();
      const before = (await snapshot()).results;
      expect(before.find((row) => row.id === aliceBox.id)).toMatchObject({
        is_read: 0,
        favorite: 1,
        message_id: aliceMessageId,
      });
      const mutations: string[] = [];
      const trackMutation = (request: import("@playwright/test").Request) => {
        if (new URL(request.url()).pathname.startsWith("/api/") && request.method() !== "GET")
          mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
      };
      owner.on("request", trackMutation);
      await owner.locator("#manage-users").click();
      await owner.getByRole("button", { name: "Lihat inbox alice", exact: true }).click();
      await expect(owner.locator("#inspection-label")).toHaveText("Inbox alice · Hanya baca");
      await expect(owner.locator("#message-body")).toBeEmpty();
      await expect(owner.locator("#inbox-list")).toContainText(aliceBox.address);
      await expect(owner.locator("#inbox-list")).not.toContainText(ownerBox.address);
      await expect(owner.locator("#new-inbox")).toHaveJSProperty("hidden", true);
      await expect(owner.locator("#new-inbox")).toBeDisabled();
      await expect(owner.locator(".favorite")).toHaveCount(0);
      await owner.getByRole("button", { name: `Buka kotak masuk ${aliceBox.address}` }).click();
      await expect(owner.locator("#delete-inbox")).toHaveJSProperty("hidden", true);
      await expect(owner.locator("#delete-inbox")).toBeDisabled();
      await owner.getByRole("button", { name: "Baca Alice private code", exact: true }).click();
      await expect(owner.locator("#message-body")).toHaveText(
        "Alice-only verification code: 782345",
      );
      await expect(owner.locator("#delete-message")).toHaveJSProperty("hidden", true);
      await expect(owner.locator("#delete-message")).toBeDisabled();
      await expect(owner.locator("#toggle-read")).toHaveJSProperty("hidden", true);
      await expect(owner.locator("#toggle-read")).toBeDisabled();
      await owner.locator("#return-own-inboxes").click();
      await expect(owner.locator("#inspection-banner")).toBeHidden();
      await expect(owner.locator("#message-body")).toBeEmpty();
      await expect(owner.locator("#new-inbox")).toBeVisible();
      await expect(owner.locator("#inbox-list")).toContainText(ownerBox.address);
      await expect(owner.locator("#inbox-list")).not.toContainText(aliceBox.address);
      owner.off("request", trackMutation);
      expect(mutations).toEqual([]);
      // Read-only is enforced by the real API as well as hidden UI controls.
      await notFound(owner, `/messages/${aliceMessageId}`, "PATCH", { isRead: true });
      await notFound(owner, `/messages/${aliceMessageId}`, "DELETE");
      await notFound(owner, `/inboxes/${aliceBox.id}`, "PATCH", { favorite: false });
      await notFound(owner, `/inboxes/${aliceBox.id}`, "DELETE");
      expect((await snapshot()).results).toEqual(before);
      expect(await inboxes(owner)).toEqual([
        expect.objectContaining({ id: ownerBox.id, messageCount: 1, unreadCount: 0 }),
      ]);
      await owner.getByRole("button", { name: `Buka kotak masuk ${ownerBox.address}` }).click();
      await owner.getByRole("button", { name: "Baca Owner sentinel", exact: true }).click();
      await expect(owner.locator("#message-body")).toHaveText(
        "Owner inbox must survive scope changes.",
      );
      await expect(owner.locator("#toggle-read")).toBeEnabled();
      await expect(owner.locator("#delete-message")).toBeEnabled();
      await alice.getByRole("button", { name: `Buka kotak masuk ${aliceBox.address}` }).click();
      await alice.getByRole("button", { name: "Baca Alice private code", exact: true }).click();
      await expect(alice.locator("#message-body")).toHaveText(
        "Alice-only verification code: 782345",
      );
      await expect
        .poll(() =>
          bindings.DB.prepare("SELECT is_read FROM message_read_state WHERE message_id = ?")
            .bind(aliceMessageId)
            .first("is_read"),
        )
        .toBe(1);
    });

    await test.step("admin UI reset revokes both target sessions while owner and other member survive", async () => {
      for (const page of pages) expect((await request(page, "/auth/session")).status()).toBe(200);
      await owner.locator("#manage-users").click();
      await owner.getByRole("button", { name: "Reset kata sandi alice", exact: true }).click();
      await expect(owner.locator("#reset-user-help")).toContainText("alice");
      await owner.locator("#reset-user-password").fill("Cancel-local-password-123");
      await owner.locator("#close-reset-user").click();
      await expect(owner.locator("#reset-user-password")).toHaveValue("");
      await owner.getByRole("button", { name: "Reset kata sandi alice", exact: true }).click();
      await owner.locator("#reset-user-password").fill(replacementPassword);
      const response = owner.waitForResponse(
        (response) =>
          response.url() === new URL(`/api/admin/users/${aliceId}/password`, url).href &&
          response.request().method() === "POST",
      );
      await owner.locator("#reset-user-submit").click();
      expect((await response).status()).toBe(200);
      await expect(owner.locator("#reset-user-dialog")).toBeHidden();
      await expect(owner.locator("#reset-user-password")).toHaveValue("");
      await expect(owner.locator("#user-create-status")).toContainText("berhasil direset");
      await owner.locator("#close-users").click();
      for (const page of [alice, aliceOther]) {
        expect((await request(page, "/auth/session")).status()).toBe(401);
        expect((await request(page, "/inboxes")).status()).toBe(401);
        expect((await request(page, `/messages/${aliceMessageId}`)).status()).toBe(401);
        await page.reload();
        await expect(page.locator("#login")).toBeVisible();
        await expect(page.locator("#message-body")).toBeEmpty();
        await expect(page.locator("#inbox-list")).toBeEmpty();
      }
      for (const [page, box, username] of [
        [owner, ownerBox, "admin"],
        [bob, bobBox, "bob"],
      ] as const) {
        const session = await request(page, "/auth/session");
        expect(session.status()).toBe(200);
        expect(await session.json()).toMatchObject({ user: { username } });
        expect((await inboxes(page)).map((inbox) => inbox.id)).toEqual([box.id]);
        await page.reload();
        await expect(page.locator("#workspace")).toBeVisible();
        await expect(page.locator("#inbox-list")).toContainText(box.address);
      }
      await login(alice, "alice", memberPassword, 401);
      await login(alice, "alice", replacementPassword);
      await expect(alice.locator("#inbox-list")).toContainText(aliceBox.address);
      expect((await request(aliceOther, "/auth/session")).status()).toBe(401);
      expect((await inboxes(alice)).map((inbox) => inbox.id)).toEqual([aliceBox.id]);
      expect(
        await bindings.DB.prepare("SELECT revision FROM users WHERE id = ?")
          .bind(aliceId)
          .first("revision"),
      ).toBe(2);
      expect(
        await bindings.DB.prepare("SELECT revision FROM users WHERE username = 'bob'").first(
          "revision",
        ),
      ).toBe(1);
      const rates = await bindings.DB.prepare(
        "SELECT key, attempts FROM rate_limits WHERE key LIKE 'login:%'",
      ).all<{ key: string; attempts: number }>();
      expect(rates.results.find((row) => row.key === "login:global")?.attempts).toBe(6);
      const ipRates = rates.results.filter((row) => row.key.startsWith("login:ip:"));
      expect(ipRates).toHaveLength(4);
      for (const rate of ipRates) expect(rate.attempts).toBeLessThanOrEqual(5);
    });

    await test.step("password fields, credits, responsive layout and browser errors remain clean", async () => {
      for (const page of pages) {
        for (const field of await page.locator("input[type='password']").all())
          await expect(field).toHaveValue("");
        await expect(page.locator("a.credit:visible")).toHaveText("Created by github.com/aplatogg");
        await expect(page.locator("a.credit:visible")).toHaveAttribute(
          "href",
          "https://github.com/aplatogg",
        );
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      }
      expect(errors).toEqual([]);
    });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await server.close();
  }
});
