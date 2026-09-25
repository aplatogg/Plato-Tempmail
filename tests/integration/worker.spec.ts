import { pbkdf2Sync } from "node:crypto";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { expect, test } from "@playwright/test";
import { createTestHarness } from "wrangler";
import type { Env } from "../../src/types";

test("real Worker assets, cookie auth, MIME ingestion and cross-device mailbox", async ({
  page,
  browser,
}) => {
  const salt = "00112233445566778899aabbccddeeff";
  const digest = Array.from(
    pbkdf2Sync("admin", Buffer.from(salt, "hex"), 100_000, 32, "sha256"),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const workerOptions = {
    configPath: "./wrangler.jsonc",
    vars: {
      PUBLIC_ORIGIN: "https://mail.example.com",
      ADMIN_USERNAME: "admin",
      MAIL_DOMAIN: "example.com",
      MESSAGE_RETENTION_DAYS: "7",
    },
    secrets: { AUTH_PASSWORD_HASH: `pbkdf2-sha256$100000$${salt}$${digest}` },
  };
  const server = createTestHarness({ workers: [workerOptions] });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const other = await browser.newContext();
  try {
    const { url } = await server.listen();
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(url.hostname);
    workerOptions.vars.PUBLIC_ORIGIN = url.origin;
    await server.update({ workers: [workerOptions] });
    const handle = server.getWorker<Env>();
    const bindings = await handle.getEnv();
    // Use Cloudflare's parser: splitting on semicolons corrupts migration trigger bodies.
    for (const migration of await readD1Migrations("migrations")) {
      await bindings.DB.batch(migration.queries.map((sql) => bindings.DB.prepare(sql)));
    }

    await page.goto(url.href);
    await page.getByLabel("Nama pengguna", { exact: true }).fill("admin");
    await page.getByLabel("Kata sandi", { exact: true }).fill("admin");
    await page.getByRole("button", { name: "Masuk", exact: true }).click();
    await expect(page.locator("#workspace")).toBeVisible();
    const cookies = await page.context().cookies();
    expect(
      cookies.some(
        (cookie) =>
          cookie.name === "plato_session" && cookie.httpOnly && cookie.sameSite === "Strict",
      ),
    ).toBe(true);
    await page.locator("#new-inbox").click();
    await page.locator("#local-part").fill("browser-check");
    await page.locator("#create-submit").click();
    await expect(page.locator("#selected-address")).toHaveText("browser-check@example.com");

    await handle.email({
      from: "sender@example.net",
      to: "browser-check@example.com",
      raw: "From: sender@example.net\r\nTo: browser-check@example.com\r\nMessage-ID: <browser-check@example.net>\r\nDate: Wed, 23 Sep 2026 12:00:00 +0000\r\nSubject: Browser code\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYour verification code: 782345\n<img src=x onerror=alert(1)>",
    });
    await page.locator("#refresh-messages").click();
    await page.getByRole("button", { name: /Browser code/ }).click();
    await expect(page.locator("#message-body")).toContainText("Your verification code: 782345");
    await expect(page.locator("#message-body img")).toHaveCount(0);
    await expect(page.locator("#message-body")).toContainText("<img src=x onerror=alert(1)>");
    await expect(page.locator("#otp-candidates")).toContainText("782345");
    await expect
      .poll(() => bindings.DB.prepare("SELECT is_read FROM message_read_state").first("is_read"))
      .toBe(1);
    await page.locator("#toggle-read").click();
    await expect
      .poll(() => bindings.DB.prepare("SELECT is_read FROM message_read_state").first("is_read"))
      .toBe(0);

    const secondPage = await other.newPage();
    await secondPage.goto(url.href);
    await secondPage.getByLabel("Nama pengguna", { exact: true }).fill("admin");
    await secondPage.getByLabel("Kata sandi", { exact: true }).fill("admin");
    await secondPage.getByRole("button", { name: "Masuk", exact: true }).click();
    await expect(secondPage.locator("#inbox-list")).toContainText("browser-check@example.com");
    const star = secondPage.getByRole("button", {
      name: "Favorit browser-check@example.com",
      exact: true,
    });
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() => bindings.DB.prepare("SELECT favorite FROM inbox_favorites").first("favorite"))
      .toBe(1);
    const crossSession = await page.request.get(new URL("/api/inboxes", url).href);
    expect(await crossSession.json()).toMatchObject({
      inboxes: [{ favorite: true, unreadCount: 1 }],
    });

    if (await page.locator("#back-messages").isVisible())
      await page.locator("#back-messages").click();
    await page.locator("#message-search").fill("no-match-here");
    await page.locator("#message-search").press("Enter");
    await expect(page.locator("#message-list .message-item")).toHaveCount(0);
    await page.locator("#message-search").fill("782345");
    await page.locator("#message-search").press("Enter");
    await page.getByRole("button", { name: /Browser code/ }).click();
    await expect(page.locator("#message-body")).toContainText("782345");

    await page.locator("#delete-message").click();
    await page.locator("#confirm-delete").click();
    await expect
      .poll(() => bindings.DB.prepare("SELECT COUNT(*) AS n FROM messages").first("n"))
      .toBe(0);
    // Real MIME -> D1 -> authenticated API -> reader for HTML-only verification content.
    const remoteRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("example.net")) remoteRequests.push(request.url());
    });
    await handle.email({
      from: "sender@example.net",
      to: "browser-check@example.com",
      raw: [
        "From: sender@example.net",
        "To: browser-check@example.com",
        "Message-ID: <html-verification@example.net>",
        "Date: Wed, 23 Sep 2026 12:01:00 +0000",
        "Subject: HTML verification",
        "MIME-Version: 1.0",
        'Content-Type: multipart/alternative; boundary="verify"',
        "",
        "--verify",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Please open the HTML version of this email.",
        "--verify",
        "Content-Type: text/html; charset=utf-8",
        "",
        '<p>Verification code: <b>654321</b></p><a href="https://verify.example.net/confirm?token=synthetic&amp;source=mail">Confirm</a><img src="https://track.example.net/pixel"><script>window.mailExecuted=true</script>',
        "--verify--",
      ].join("\r\n"),
    });
    if (await page.locator("#back-messages").isVisible())
      await page.locator("#back-messages").click();
    await page.locator("#message-search").fill("654321");
    await page.locator("#message-search").press("Enter");
    await page.getByRole("button", { name: /HTML verification/ }).click();
    await expect(page.locator("#message-body")).toContainText("Verification code: 654321");
    await expect(page.locator("#message-body")).toContainText(
      "https://verify.example.net/confirm?token=synthetic&source=mail",
    );
    await expect(page.locator("#message-body")).not.toContainText("Please open the HTML version");
    await expect(page.locator("#message-body img, #message-body script")).toHaveCount(0);
    await expect(page.locator("#otp-candidates")).toContainText("654321");
    expect(remoteRequests).toEqual([]);
    await page.locator("#delete-message").click();
    await page.locator("#confirm-delete").click();
    await expect
      .poll(() => bindings.DB.prepare("SELECT COUNT(*) AS n FROM messages").first("n"))
      .toBe(0);
    if (await page.locator("#back-messages").isVisible())
      await page.locator("#back-messages").click();
    await page.locator("#delete-inbox").click();
    await page.locator("#confirm-delete").click();
    await expect
      .poll(() => bindings.DB.prepare("SELECT COUNT(*) AS n FROM inboxes").first("n"))
      .toBe(0);

    await secondPage.locator("#account-settings").click();
    await secondPage.locator("#current-password").fill("admin");
    await secondPage.locator("#new-password").fill("Fresh-local-password-782345");
    await secondPage.locator("#confirm-password").fill("Fresh-local-password-782345");
    await secondPage.locator("#password-submit").click();
    await expect(secondPage.locator("#login-success")).toBeVisible();
    expect((await page.request.get(new URL("/api/inboxes", url).href)).status()).toBe(401);
    expect((await secondPage.request.get(new URL("/api/inboxes", url).href)).status()).toBe(401);
    await page.reload();
    await page.getByLabel("Nama pengguna", { exact: true }).fill("admin");
    await page.getByLabel("Kata sandi", { exact: true }).fill("Fresh-local-password-782345");
    await page.getByRole("button", { name: "Masuk", exact: true }).click();
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#workspace a[href='https://github.com/aplatogg']")).toBeVisible();
    const logoutResponse = page.waitForResponse(
      (response) =>
        response.url() === new URL("/api/auth/logout", url).href &&
        response.request().method() === "POST",
    );
    await page.locator("#logout").click();
    const response = await logoutResponse;
    expect(response.status()).toBe(200);
    await response.finished();
    await expect(page.locator("#login")).toBeVisible();
    expect((await page.request.get(new URL("/api/inboxes", url).href)).status()).toBe(401);
    expect(errors).toEqual([]);
  } finally {
    await other.close();
    await server.close();
  }
});
