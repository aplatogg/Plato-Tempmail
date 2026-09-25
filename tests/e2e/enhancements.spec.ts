import { expect, type Page, test } from "@playwright/test";

declare const document: { dispatchEvent(event: Event): boolean };
declare const window: { fetch: typeof fetch; dispatchEvent(event: Event): boolean };
declare function getComputedStyle(node: unknown): { backgroundColor: string };
interface HTMLFormElement {
  requestSubmit(): void;
}

const session = {
  user: { id: "owner", username: "operator", role: "owner" },
  mailDomain: "example.com",
  retentionDays: 7,
};
const now = 1790164800;
const mail = (id = "a1", inboxId = "a") => ({
  id,
  inboxId,
  from: "Tim <tim@example.org>",
  subject: `Pesan ${id}`,
  preview: "Verifikasi",
  body: "Kode OTP: 123456. Verification code: 654321.\nTracking 987654321. Tahun 2026.\nIsi lengkap tetap ada.",
  receivedAt: now,
  expiresAt: now + 604800,
  isRead: false,
});
async function setup(page: Page, authenticated = true) {
  const data = {
    authenticated,
    calls: [] as string[],
    passwords: [] as unknown[],
    patches: [] as unknown[],
    inboxes: [
      {
        id: "a",
        address: "alpha@example.com",
        createdAt: now,
        messageCount: 2,
        favorite: false,
        unreadCount: 2,
        latestMessageId: "a1" as string | null,
        latestArrival: 2,
      },
      {
        id: "b",
        address: "beta@example.com",
        createdAt: now,
        messageCount: 1,
        favorite: false,
        unreadCount: 1,
        latestMessageId: "b1" as string | null,
        latestArrival: 3,
      },
    ],
    messages: [mail(), mail("a2")],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    data.calls.push(`${method} ${path}${url.search}`);
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (path === "/api/auth/login") {
      data.authenticated = true;
      return reply(session);
    }
    if (path === "/api/auth/logout") {
      data.authenticated = false;
      return reply({ ok: true });
    }
    if (!data.authenticated)
      return reply({ error: { code: "UNAUTHORIZED", message: "Silakan masuk." } }, 401);
    if (path === "/api/auth/session") return reply(session);
    if (path === "/api/auth/password") {
      const body = request.postDataJSON();
      data.passwords.push(body);
      if (body.currentPassword !== "old-password")
        return reply(
          { error: { code: "INVALID_CREDENTIALS", message: "Kata sandi saat ini salah." } },
          401,
        );
      data.authenticated = false;
      return reply({ ok: true });
    }
    if (path === "/api/inboxes") return reply({ inboxes: data.inboxes });
    if (method === "PATCH") {
      const body = request.postDataJSON();
      data.patches.push({ path, ...body });
      if (path.startsWith("/api/inboxes/")) {
        const item = data.inboxes.find((i) => path.endsWith(`/${i.id}`));
        if (item) item.favorite = body.favorite;
      } else {
        const item = data.messages.find((i) => path.endsWith(`/${i.id}`));
        if (item) item.isRead = body.isRead;
        data.inboxes[0].unreadCount = data.messages.filter((i) => !i.isRead).length;
      }
      return reply({ ok: true });
    }
    if (path.endsWith("/messages")) {
      const q = url.searchParams.get("q");
      return reply({
        messages: q === "none" ? [] : [data.messages[url.searchParams.has("cursor") ? 1 : 0]],
        nextCursor: q === "none" || url.searchParams.has("cursor") ? null : "opaque+/=?",
      });
    }
    if (path.startsWith("/api/messages/"))
      return reply({ message: data.messages.find((i) => path.endsWith(`/${i.id}`)) });
    return reply({ error: { code: "NOT_FOUND", message: "Tidak ditemukan." } }, 404);
  });
  return data;
}
async function openInbox(page: Page) {
  await page
    .getByRole("button", { name: "Buka kotak masuk alpha@example.com", exact: true })
    .click();
}
async function passwords(page: Page, current = "old-password", next = "new-password-123") {
  await page.locator("#current-password").fill(current);
  await page.locator("#new-password").fill(next);
  await page.locator("#confirm-password").fill(next);
}
async function back(page: Page) {
  if (await page.locator("#back-messages").isVisible())
    await page.locator("#back-messages").click();
  if (await page.locator("#back-inboxes").isVisible()) await page.locator("#back-inboxes").click();
}

function deferred() {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

for (const intent of ["selection", "search", "automatic read"])
  test(`U1 pending favorite preserves ${intent} intent`, async ({ page }) => {
    await page.clock.install();
    const data = await setup(page);
    const favorite = deferred();
    let started = false;
    await page.route("**/api/inboxes/b", async (route) => {
      started = true;
      await favorite.held;
      return route.fallback();
    });
    await page.route("**/api/inboxes/b/messages", (route) =>
      route.fulfill({ json: { messages: [mail("b1", "b")], nextCursor: null } }),
    );
    await page.goto("/");
    await openInbox(page);
    await expect(page.locator(".message-item")).toHaveCount(1);
    await back(page);
    await page.getByRole("button", { name: "Favorit beta@example.com", exact: true }).click();
    await expect.poll(() => started).toBe(true);
    try {
      if (intent === "selection") {
        await page
          .getByRole("button", { name: "Buka kotak masuk beta@example.com", exact: true })
          .click();
        await expect(page.getByRole("button", { name: "Baca Pesan b1" })).toBeVisible();
      } else {
        await openInbox(page);
        if (intent === "search") {
          await page.locator("#message-search").fill("synthetic needle");
          await page.clock.fastForward(400);
          await expect
            .poll(() => data.calls.filter((call) => call.includes("q=")))
            .toEqual(["GET /api/inboxes/a/messages?q=synthetic+needle"]);
          await expect(page.locator(".message-item")).toHaveCount(1);
        } else {
          await page.locator(".message-item").click();
          await expect(page.locator("#message-body")).toHaveText(mail().body);
          await expect
            .poll(() => data.patches)
            .toEqual([{ path: "/api/messages/a1", isRead: true }]);
          await expect(page.locator("#toggle-read")).toHaveText("Tandai belum dibaca");
          await expect(page.locator("#toggle-read")).toBeEnabled();
        }
      }
    } finally {
      favorite.release();
    }
    await expect(page.locator("#notice")).toContainText("ditambahkan ke favorit");
    await back(page);
    await expect(
      page.getByRole("button", { name: "Favorit beta@example.com", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  });

test("U2 failed inbox deletion makes an interrupted reader retryable", async ({ page }) => {
  await setup(page);
  const detail = deferred();
  let started = false;
  await page.route(
    "**/api/messages/a1",
    async (route) => {
      started = true;
      await detail.held;
      return route.fallback();
    },
    { times: 1 },
  );
  await page.route("**/api/inboxes/a", (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: "BUSY", message: "Synthetic deletion failure." } },
    }),
  );
  await page.goto("/");
  await openInbox(page);
  await page.locator(".message-item").click();
  await expect.poll(() => started).toBe(true);
  await expect(page.locator("#reader-state")).toContainText("Memuat");
  if (await page.locator("#back-messages").isVisible())
    await page.locator("#back-messages").click();
  await page.locator("#delete-inbox").click();
  await page.locator("#confirm-delete").click();
  await expect(page.locator("#delete-error")).toContainText("Synthetic deletion failure");
  await page.locator("#cancel-delete").click();
  // Mobile navigation hides the reader; inspect its actual hidden attribute without reopening.
  try {
    await expect(page.locator("#retry-reader")).not.toHaveAttribute("hidden", "");
    await expect(page.locator("#reader-state")).toContainText("Pemuatan terhenti");
  } finally {
    detail.release();
  }
  // Invoke the existing retry control, including when its mobile pane is hidden.
  await page.locator("#retry-reader").dispatchEvent("click");
  await expect(page.locator("#message-body")).toHaveText(mail().body);
  await expect(page.locator("#retry-reader")).toBeHidden();
});

for (const first of ["patch", "detail"])
  test(`U3 same-message reopen reconciles pending read mutation when ${first} finishes first`, async ({
    page,
  }) => {
    const data = await setup(page);
    data.messages[0].isRead = true;
    const snapshot = { ...data.messages[0] };
    const patch = deferred();
    const detail = deferred();
    let patchStarted = false;
    let detailStarted = false;
    await page.goto("/");
    await openInbox(page);
    await page.locator(".message-item").click();
    await expect(page.locator("#toggle-read")).toHaveText("Tandai belum dibaca");
    await page.route("**/api/messages/a1", async (route) => {
      if (route.request().method() === "PATCH") {
        patchStarted = true;
        await patch.held;
        return route.fallback();
      }
      detailStarted = true;
      await detail.held;
      return route.fulfill({ json: { message: snapshot } });
    });
    await page.locator("#toggle-read").click();
    await expect.poll(() => patchStarted).toBe(true);
    if (await page.locator("#back-messages").isVisible())
      await page.locator("#back-messages").click();
    await page.locator(".message-item").click();
    await expect.poll(() => detailStarted).toBe(true);
    try {
      if (first === "detail") {
        detail.release();
        await expect(page.locator("#message-body")).toHaveText(snapshot.body);
        await expect(page.locator("#toggle-read")).toBeDisabled();
      }
      patch.release();
      await expect.poll(() => data.messages[0].isRead).toBe(false);
      await expect(page.locator(".message-item")).toHaveClass(/is-unread/);
      detail.release();
      await expect(page.locator("#message-body")).toHaveText(snapshot.body);
      await expect(page.locator("#toggle-read")).toBeEnabled();
      await expect(page.locator("#toggle-read")).toHaveText("Tandai dibaca");
      expect(data.patches).toEqual([{ path: "/api/messages/a1", isRead: false }]);
    } finally {
      patch.release();
      detail.release();
    }
  });

test("U1 failed favorite retains the latest inbox and search scope", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => original(input, { ...init, signal: undefined });
  });
  const data = await setup(page);
  const favorite = deferred();
  const oldSearch = deferred();
  let searchStarted = false;
  await page.route("**/api/inboxes/b", async (route) => {
    await favorite.held;
    return route.fulfill({
      status: 503,
      json: { error: { code: "BUSY", message: "Synthetic favorite failure." } },
    });
  });
  await page.route("**/api/inboxes/a/messages?q=old", async (route) => {
    searchStarted = true;
    await oldSearch.held;
    return route.fulfill({ json: { messages: [mail("stale")], nextCursor: null } });
  });
  await page.route("**/api/inboxes/b/messages**", (route) =>
    route.fulfill({ json: { messages: [mail("b1", "b")], nextCursor: null } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Favorit beta@example.com", exact: true }).click();
  await openInbox(page);
  await page.locator("#message-search").fill("old");
  await page.locator("#message-search").press("Enter");
  await expect.poll(() => searchStarted).toBe(true);
  await back(page);
  await page.getByRole("button", { name: "Buka kotak masuk beta@example.com" }).click();
  await page.locator("#message-search").fill("current");
  await page.locator("#message-search").press("Enter");
  await expect(page.getByRole("button", { name: "Baca Pesan b1" })).toBeVisible();
  const response = page.waitForResponse("**/api/inboxes/a/messages?q=old");
  oldSearch.release();
  await (await response).finished();
  favorite.release();
  await expect(page.locator("#notice")).toContainText("Synthetic favorite failure");
  await expect(page.locator("#selected-address")).toHaveText(data.inboxes[1].address);
  await expect(page.locator("#message-search")).toHaveValue("current");
  await expect(page.locator(".message-summary")).toHaveText("Pesan b1");
  await expect(page.locator("#refresh-messages")).toBeEnabled();
});

test("U1 stale favorite completion cannot release a newer session mutation", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => original(input, { ...init, signal: undefined });
  });
  await setup(page);
  const oldFavorite = deferred();
  const newFavorite = deferred();
  let attempts = 0;
  await page.route("**/api/inboxes/b", async (route) => {
    const attempt = ++attempts;
    expect(route.request().headers()["x-plato-user"]).toBe("owner");
    await (attempt === 1 ? oldFavorite.held : newFavorite.held);
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const button = page.getByRole("button", { name: "Favorit beta@example.com", exact: true });
  await button.click();
  await expect.poll(() => attempts).toBe(1);
  await page.locator("#logout").click();
  await expect(page.locator("#login-submit")).toBeEnabled();
  await page.locator("#username").fill("synthetic-operator");
  await page.locator("#password").fill("synthetic-password");
  await page.locator("#login-submit").click();
  await button.click();
  await expect.poll(() => attempts).toBe(2);
  const response = page.waitForResponse("**/api/inboxes/b");
  oldFavorite.release();
  await (await response).finished();
  await openInbox(page);
  await expect(page.locator(".message-item")).toHaveCount(1);
  await page.locator(".message-item").click();
  await expect(page.locator("#toggle-read")).toHaveText("Tandai belum dibaca");
  await expect(page.locator("#delete-message")).toBeDisabled();
  await expect(page.locator("#notice")).toBeHidden();
  newFavorite.release();
  await expect(page.locator("#delete-message")).toBeEnabled();
  await expect(page.locator("#notice")).toContainText("ditambahkan ke favorit");
});

test("U2 failed deletion does not replace a newer same-message reader request", async ({
  page,
}) => {
  await setup(page);
  const deletion = deferred();
  const detail = deferred();
  let details = 0;
  let deleting = false;
  await page.route("**/api/messages/a1", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    details++;
    await detail.held;
    return route.fallback();
  });
  await page.route("**/api/inboxes/a", async (route) => {
    deleting = true;
    await deletion.held;
    return route.fulfill({
      status: 503,
      json: { error: { code: "BUSY", message: "Synthetic deletion failure." } },
    });
  });
  await page.goto("/");
  await openInbox(page);
  await page.locator(".message-item").click();
  await expect.poll(() => details).toBe(1);
  if (await page.locator("#back-messages").isVisible())
    await page.locator("#back-messages").click();
  await page.locator("#delete-inbox").click();
  await page.locator("#confirm-delete").click();
  await expect.poll(() => deleting).toBe(true);
  // Exercise supersession under the modal through the real DOM event handler.
  // The message identity is unchanged, but the new request owns the reader.
  await page.locator(".message-item").dispatchEvent("click");
  await expect.poll(() => details).toBe(2);
  deletion.release();
  await expect(page.locator("#delete-error")).toContainText("Synthetic deletion failure");
  await page.locator("#cancel-delete").click();
  await expect(page.locator("#reader-state")).toContainText("Memuat");
  await expect(page.locator("#retry-reader")).toHaveAttribute("hidden", "");
  detail.release();
  await expect(page.locator("#message-body")).toHaveText(mail().body);
});

test("U3 later detail remains authoritative after a completed local read change", async ({
  page,
}) => {
  const data = await setup(page);
  await page.goto("/");
  await openInbox(page);
  await page.locator(".message-item").click();
  await expect(page.locator("#toggle-read")).toHaveText("Tandai belum dibaca");
  await page.locator("#toggle-read").click();
  await expect(page.locator("#toggle-read")).toHaveText("Tandai dibaca");
  // A different session changed the server state after our local PATCH.
  data.messages[0].isRead = true;
  if (await page.locator("#back-messages").isVisible())
    await page.locator("#back-messages").click();
  await page.locator(".message-item").click();
  await expect(page.locator("#toggle-read")).toHaveText("Tandai belum dibaca");
  expect(data.patches).toEqual([
    { path: "/api/messages/a1", isRead: true },
    { path: "/api/messages/a1", isRead: false },
  ]);
});

test("account dialog keyboard cancel clears secrets and restores focus", async ({ page }) => {
  await setup(page);
  await page.goto("/");
  await page.locator("#account-settings").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#current-password")).toBeFocused();
  await passwords(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#account-settings")).toBeFocused();
  for (const id of ["current-password", "new-password", "confirm-password"])
    await expect(page.locator(`#${id}`)).toHaveValue("");
});

test("password validation, wrong current 401 stays signed in, success returns login without logout", async ({
  page,
}) => {
  const data = await setup(page);
  await page.goto("/");
  await page.locator("#account-settings").click();
  for (const invalid of ["four", "     ", "old-password"]) {
    await passwords(page, "old-password", invalid);
    await page.locator("#password-submit").click();
    await expect(page.locator("#password-error")).not.toBeEmpty();
  }
  await passwords(page);
  await page.locator("#confirm-password").fill("different");
  await page.locator("#password-submit").click();
  expect(data.passwords).toHaveLength(0);
  await passwords(page, "wrong");
  await page.locator("#password-submit").click();
  await expect(page.locator("#password-error")).toContainText("salah");
  await expect(page.locator("#workspace")).toBeVisible();
  await passwords(page, "old-password", "abcde");
  await page.locator("#password-submit").click();
  await expect(page.locator("#login")).toBeVisible();
  expect(data.passwords.at(-1)).toEqual({ currentPassword: "old-password", newPassword: "abcde" });
  await expect(page.locator("#login-success")).toContainText("berhasil");
  expect(data.calls).not.toContain("POST /api/auth/logout");
  for (const id of ["current-password", "new-password", "confirm-password"])
    await expect(page.locator(`#${id}`)).toHaveValue("");
});

test("password duplicate submission and 429 cooldown survive cancel and reopening", async ({
  page,
}) => {
  await page.clock.install();
  await setup(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  await page.route("**/api/auth/password", async (route) => {
    attempts++;
    await held;
    await route.fulfill({
      status: 429,
      headers: { "Retry-After": "3" },
      json: { error: { code: "RATE_LIMITED", message: "Terlalu banyak percobaan." } },
    });
  });
  await page.goto("/");
  await page.locator("#account-settings").click();
  await passwords(page);
  await page.locator("#password-submit").click();
  await expect(page.locator("#password-submit")).toBeDisabled();
  await page.locator("#password-form").evaluate((f: HTMLFormElement) => f.requestSubmit());
  await page.keyboard.press("Escape");
  await expect(page.locator("#password-dialog")).toBeVisible();
  release();
  await expect(page.locator("#password-retry")).toContainText("3 detik");
  await page.locator("#cancel-password").click();
  await page.locator("#account-settings").click();
  await expect(page.locator("#password-submit")).toBeDisabled();
  await page.clock.fastForward(3100);
  await expect(page.locator("#password-submit")).toBeEnabled();
  expect(attempts).toBe(1);
});

for (const header of ["3", "http-date", "invalid"])
  test(`login Retry-After ${header} countdown never retries credentials`, async ({ page }) => {
    await page.clock.install({ time: new Date("2026-09-23T12:00:00Z") });
    await setup(page, false);
    let attempts = 0;
    await page.route("**/api/auth/login", (route) => {
      attempts++;
      return route.fulfill({
        status: 429,
        headers: {
          "Retry-After": header === "http-date" ? "Wed, 23 Sep 2026 12:00:03 GMT" : header,
        },
        json: { error: { code: "RATE_LIMITED", message: "Terlalu banyak percobaan." } },
      });
    });
    await page.goto("/");
    await page.locator("#username").fill("operator");
    await page.locator("#password").fill("secret");
    await page.locator("#login-submit").click();
    await expect(page.locator("#login-retry")).toContainText("detik");
    await expect(page.locator("#login-submit")).toBeDisabled();
    await page.clock.fastForward(header === "invalid" ? 61000 : 3100);
    await expect(page.locator("#login-submit")).toBeEnabled();
    expect(attempts).toBe(1);
    await expect(page.locator("#password")).toHaveValue("");
  });

test("unread detail PATCH and explicit unread action synchronize inbox count", async ({ page }) => {
  const data = await setup(page);
  await page.goto("/");
  await expect(page.locator("#inbox-list")).toContainText("2 belum dibaca");
  await openInbox(page);
  await expect(page.locator(".message-item").first()).toHaveClass(/is-unread/);
  expect(data.patches).toHaveLength(0);
  await page.locator(".message-item").first().click();
  await expect(page.locator("#toggle-read")).toHaveText("Tandai belum dibaca");
  await expect.poll(() => data.patches).toEqual([{ path: "/api/messages/a1", isRead: true }]);
  await page.locator("#toggle-read").click();
  await expect(page.locator("#toggle-read")).toHaveText("Tandai dibaca");
  await back(page);
  await expect(page.locator("#inbox-list")).toContainText("2 belum dibaca");
});

test("stale detail never marks read after selection changes even with ignored abort", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => original(input, { ...init, signal: undefined });
  });
  const data = await setup(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/messages/a1", async (route) => {
    await held;
    await route.fulfill({ json: { message: mail() } });
  });
  await page.goto("/");
  await openInbox(page);
  await page.locator("#load-more").click();
  await page.getByRole("button", { name: "Baca Pesan a1" }).click();
  if (await page.locator("#back-messages").isVisible())
    await page.locator("#back-messages").click();
  await page.getByRole("button", { name: "Baca Pesan a2" }).click();
  await expect(page.locator("#toggle-read")).toHaveText("Tandai belum dibaca");
  const response = page.waitForResponse("**/api/messages/a1");
  release();
  await response;
  await expect(page.locator("#message-subject")).toHaveText("Pesan a2");
  expect(data.patches).toEqual([{ path: "/api/messages/a2", isRead: true }]);
});

test("OTP candidates use explicit copy and generic fallback without losing full text", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
    }),
  );
  await setup(page);
  await page.goto("/");
  await openInbox(page);
  await page.locator(".message-item").first().click();
  await expect(page.locator("#otp-candidates button")).toHaveCount(2);
  await expect(page.locator("#copy-dialog")).toBeHidden();
  await expect(page.locator("#message-body")).toHaveText(mail().body);
  await page.getByRole("button", { name: "Salin kode 123456", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Salin kode OTP" })).toBeVisible();
  await expect(page.getByLabel("Kode OTP untuk disalin")).toHaveValue("123456");
  await page.keyboard.press("Escape");
  await expect(page.locator("#copy-value")).toHaveValue("");
});

test("favorite is persisted, sorted and synchronized by later polling", async ({ page }) => {
  await page.clock.install();
  const data = await setup(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Favorit beta@example.com", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Favorit beta@example.com", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".inbox-item").first()).toContainText("beta@");
  expect(data.patches).toContainEqual({ path: "/api/inboxes/b", favorite: true });
  data.inboxes[0].favorite = true;
  data.inboxes[1].favorite = false;
  data.inboxes[0].unreadCount = 8;
  await page.clock.fastForward(30000);
  await expect(page.locator(".inbox-item").first()).toContainText("alpha@");
  await expect(page.locator("#inbox-list")).toContainText("8 belum dibaca");
});

test("search debounces literal query, resets cursor and retries empty/error results", async ({
  page,
}) => {
  await page.clock.install();
  const data = await setup(page);
  await page.goto("/");
  await openInbox(page);
  await page.locator("#load-more").click();
  await expect(page.locator(".message-item")).toHaveCount(2);
  await page.locator("#message-search").fill("OTP %+_");
  expect(data.calls.filter((c) => c.includes("q="))).toHaveLength(0);
  await page.clock.fastForward(400);
  await expect
    .poll(() => data.calls.filter((c) => c.includes("q=")))
    .toEqual(["GET /api/inboxes/a/messages?q=OTP+%25%2B_"]);
  await expect(page.locator(".message-item")).toHaveCount(1);
  await page.locator("#load-more").click();
  await expect.poll(() => data.calls.at(-1)).toContain("cursor=opaque%2B%2F%3D%3F");
  await page.route(
    "**/api/inboxes/a/messages?q=none",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: "BUSY", message: "Pencarian gagal." } },
      }),
    { times: 1 },
  );
  await page.locator("#message-search").fill("none");
  await page.locator("#message-search").press("Enter");
  await expect(page.locator("#messages-state")).toContainText("Pencarian gagal");
  await page.locator("#retry-messages").click();
  await expect(page.locator("#messages-state")).toContainText("Tidak ada hasil");
});

test("late search response cannot replace current query even when abort is ignored", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => original(input, { ...init, signal: undefined });
  });
  await setup(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/inboxes/a/messages?q=old", async (route) => {
    await held;
    await route.fulfill({ json: { messages: [mail("stale")], nextCursor: "stale-cursor" } });
  });
  await page.goto("/");
  await openInbox(page);
  await page.locator("#message-search").fill("old");
  await page.locator("#message-search").press("Enter");
  await page.locator("#message-search").fill("none");
  await page.locator("#message-search").press("Enter");
  await expect(page.locator("#messages-state")).toContainText("Tidak ada hasil");
  const response = page.waitForResponse("**/api/inboxes/a/messages?q=old");
  release();
  await response;
  await expect(page.locator(".message-item")).toHaveCount(0);
  await expect(page.locator("#load-more")).toBeHidden();
});

test("refresh status distinguishes last success, failure, offline and hidden pause", async ({
  page,
}) => {
  await page.clock.install();
  await setup(page);
  await page.goto("/");
  await expect(page.locator("#refresh-status")).toContainText("Terakhir berhasil");
  await page.clock.fastForward(5000);
  await page.route(
    "**/api/inboxes",
    (route) =>
      route.fulfill({ status: 503, json: { error: { code: "BUSY", message: "Gagal memuat." } } }),
    { times: 1 },
  );
  await page.locator("#refresh-inboxes").click();
  await expect(page.locator("#refresh-status")).toContainText("Gagal");
  await expect(page.locator("#refresh-status")).toContainText("5 detik");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));
  });
  await expect(page.locator("#refresh-status")).toContainText("Offline");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("#refresh-status")).toContainText("Dijeda");
});

test("themes persist only nonsecret preferences and credit is visible in both views", async ({
  page,
}) => {
  await setup(page, false);
  await page.goto("/");
  const credit = page
    .getByRole("link", { name: "Created by github.com/aplatogg", exact: true })
    .filter({ visible: true });
  await expect(credit).toHaveAttribute("href", "https://github.com/aplatogg");
  await expect(credit).toHaveAttribute("rel", "noopener noreferrer");
  await expect(credit).toHaveAttribute("target", "_blank");
  await page.locator("#login-theme").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("#login-theme")).toHaveValue("dark");
  await page.locator("#username").fill("operator");
  await page.locator("#password").fill("secret-password");
  await page.locator("#login-submit").click();
  await expect(credit).toBeVisible();
  await expect(page.locator("#workspace-theme")).toHaveValue("dark");
  await page.locator("#account-settings").click();
  expect(
    await page
      .locator("#password-dialog")
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  ).not.toBe("rgb(255, 255, 255)");
  await page.keyboard.press("Escape");
  await page.locator("#workspace-theme").selectOption("system");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => [Object.entries(localStorage), sessionStorage.length])).toEqual([
    [["plato.theme", "system"]],
    0,
  ]);
});

test("blocked preference storage remains usable", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(globalThis, "localStorage", {
      get() {
        throw new Error("blocked");
      },
    }),
  );
  await setup(page);
  await page.goto("/");
  await page.locator("#workspace-theme").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await openInbox(page);
});

test("OTP extraction excludes tracking IDs and years even near login words", async ({ page }) => {
  const data = await setup(page);
  data.messages[0].body =
    "123456 tracking ID for login. Login shipment reference 7654321. Login year 2026. OTP 123456789. Login abc123456. Kode verifikasi Anda: 4321. 87654321 is your verification code.";
  await page.goto("/");
  await openInbox(page);
  await page.locator(".message-item").first().click();
  await expect(page.locator("#otp-candidates button")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Salin kode 4321", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Salin kode 87654321", exact: true }),
  ).toBeVisible();
});

test("password 400 and 409 errors allow deliberate retry and UTF16 boundary passwords", async ({
  page,
}) => {
  const data = await setup(page);
  await page.goto("/");
  await page.locator("#account-settings").click();
  for (const status of [400, 409]) {
    await page.route(
      "**/api/auth/password",
      (route) =>
        route.fulfill({
          status,
          json: { error: { code: "CONFLICT", message: `Konflik ${status}.` } },
        }),
      { times: 1 },
    );
    await passwords(page);
    await page.locator("#password-submit").click();
    await expect(page.locator("#password-error")).toContainText(`Konflik ${status}`);
    await expect(page.locator("#password-submit")).toBeEnabled();
  }
  const boundary = "🔑".repeat(512);
  await passwords(page, "old-password", boundary);
  await page.locator("#password-submit").click();
  await expect(page.locator("#login-success")).toBeVisible();
  expect(data.passwords).toEqual([{ currentPassword: "old-password", newPassword: boundary }]);
});

test("account failure leaves interrupted reader with a usable retry", async ({ page }) => {
  await setup(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/api/messages/a1",
    async (route) => {
      await held;
      return route.fallback();
    },
    { times: 1 },
  );
  await page.goto("/");
  await openInbox(page);
  await page.locator(".message-item").first().click();
  await expect(page.locator("#reader-state")).toContainText("Memuat");
  await page.locator("#account-settings").click();
  await passwords(page, "wrong");
  await page.locator("#password-submit").click();
  await expect(page.locator("#password-error")).toContainText("salah");
  await expect(page.locator("#password-submit")).toBeEnabled();
  await page.locator("#cancel-password").click();
  release();
  await page.locator("#retry-reader").click();
  await expect(page.locator("#message-body")).toHaveText(mail().body);
});

async function notifications(page: Page, permission = "default", deferred = false) {
  await page.addInitScript(
    ({ permission, deferred }) => {
      const log = {
        requests: 0,
        shown: [] as string[],
        closed: 0,
        resolve: (_value: string) => {},
      };
      Object.assign(globalThis, { notificationLog: log });
      class FakeNotification {
        static permission = permission;
        static requestPermission() {
          log.requests++;
          if (deferred)
            return new Promise<string>((resolve) => {
              log.resolve = resolve;
            });
          FakeNotification.permission = "granted";
          return Promise.resolve("granted");
        }
        constructor(title: string, options: { body: string }) {
          log.shown.push(`${title} ${options.body}`);
        }
        close() {
          log.closed++;
        }
      }
      Object.assign(globalThis, { Notification: FakeNotification });
    },
    { permission, deferred },
  );
}
const notificationLog = (page: Page) =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          notificationLog: { requests: number; shown: string[]; closed: number };
        }
      ).notificationLog,
  );

test("read PATCH completion does not discard a new inbox list in flight", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => original(input, { ...init, signal: undefined });
  });
  await setup(page);
  let releaseRead = () => {};
  const heldRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let releaseList = () => {};
  const heldList = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  await page.route("**/api/messages/a1", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await heldRead;
    return route.fallback();
  });
  await page.route("**/api/inboxes/b/messages", async (route) => {
    await heldList;
    await route.fulfill({ json: { messages: [mail("b1", "b")], nextCursor: null } });
  });
  await page.goto("/");
  await openInbox(page);
  await page.locator(".message-item").first().click();
  await expect(page.locator("#toggle-read")).toBeDisabled();
  await back(page);
  await page
    .getByRole("button", { name: "Buka kotak masuk beta@example.com", exact: true })
    .click();
  await expect(page.locator("#messages-state")).toContainText("Memuat");
  const patched = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/messages/a1") && response.request().method() === "PATCH",
  );
  releaseRead();
  await patched;
  releaseList();
  await expect(page.getByRole("button", { name: "Baca Pesan b1" })).toBeVisible();
});

test("expired read update offers error and deliberate retry without changing unread state", async ({
  page,
}) => {
  const data = await setup(page);
  await page.route("**/api/messages/a1", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    return route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND", message: "Pesan kedaluwarsa." } },
    });
  });
  await page.goto("/");
  await openInbox(page);
  await page.locator(".message-item").first().click();
  await expect(page.locator("#read-error")).toContainText("kedaluwarsa");
  await expect(page.locator("#toggle-read")).toHaveText("Tandai dibaca");
  expect(data.messages[0].isRead).toBe(false);
  await page.locator("#toggle-read").click();
  await expect(page.locator("#read-error")).toContainText("belum tersimpan");
});

test("notifications do not flood on login, newly tracked inboxes or older arrivals", async ({
  page,
}) => {
  await page.clock.install();
  await notifications(page, "granted");
  await page.addInitScript(() => localStorage.setItem("plato.notifications", "true"));
  const data = await setup(page);
  await page.goto("/");
  await expect(page.locator("#inbox-count")).toHaveText("2");
  expect((await notificationLog(page)).shown).toHaveLength(0);
  data.inboxes.push({
    ...data.inboxes[0],
    id: "c",
    address: "new@example.com",
    latestMessageId: "c1",
    latestArrival: 4,
  });
  await page.clock.fastForward(30000);
  await expect(page.locator("#inbox-count")).toHaveText("3");
  expect((await notificationLog(page)).shown).toHaveLength(0);
  data.inboxes[0].latestMessageId = "a-new";
  data.inboxes[0].latestArrival = 5;
  await page.clock.fastForward(30000);
  await expect.poll(async () => (await notificationLog(page)).shown.length).toBe(1);
  data.inboxes[0].latestMessageId = "a1";
  data.inboxes[0].latestArrival = 2;
  await page.clock.fastForward(30000);
  expect((await notificationLog(page)).shown).toHaveLength(1);
  await page.locator("#logout").click();
  await page.locator("#username").fill("operator");
  await page.locator("#password").fill("secret");
  await page.locator("#login-submit").click();
  await expect(page.locator("#inbox-count")).toHaveText("3");
  expect((await notificationLog(page)).shown).toHaveLength(1);
});

test("notifications are explicit, generic, deduplicated and closed on logout", async ({ page }) => {
  await page.clock.install();
  await notifications(page);
  const data = await setup(page);
  await page.goto("/");
  await expect(page.locator("#notification-toggle")).toBeVisible();
  expect((await notificationLog(page)).requests).toBe(0);
  await page.locator("#notification-toggle").click();
  await expect(page.locator("#notification-toggle")).toHaveAttribute("aria-pressed", "true");
  expect((await notificationLog(page)).shown).toEqual([]);
  data.inboxes[0].latestMessageId = "new1";
  data.inboxes[0].latestArrival = 4;
  await page.clock.fastForward(30000);
  await expect.poll(async () => (await notificationLog(page)).shown.length).toBe(1);
  data.inboxes[0].unreadCount = 0;
  await page.clock.fastForward(30000);
  expect((await notificationLog(page)).shown).toEqual([
    "Plato-Tempmail Ada pesan baru. Buka aplikasi untuk membaca.",
  ]);
  await page.locator("#logout").click();
  await expect(page.locator("#login")).toBeVisible();
  expect((await notificationLog(page)).closed).toBe(1);
  await page.clock.fastForward(60000);
  expect((await notificationLog(page)).shown).toHaveLength(1);
});

test("notification permission resolving after logout cannot enable preference", async ({
  page,
}) => {
  await notifications(page, "default", true);
  await setup(page);
  await page.goto("/");
  await page.locator("#notification-toggle").click();
  await page.locator("#logout").click();
  await page.evaluate(() =>
    (
      globalThis as unknown as { notificationLog: { resolve(value: string): void } }
    ).notificationLog.resolve("granted"),
  );
  await expect(page.locator("#login")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("plato.notifications"))).toBeNull();
});

async function pollInboxSummaries(page: Page) {
  const response = page.waitForResponse("**/api/inboxes");
  await page.clock.fastForward(30000);
  await (await response).finished();
  await expect(page.locator("#refresh-inboxes")).toBeEnabled();
}

test("arrival watermark ignores deletion exposing an unseen older message and deduplicates new arrivals", async ({
  page,
}) => {
  await page.clock.install();
  await notifications(page, "granted");
  await page.addInitScript(() => localStorage.setItem("plato.notifications", "true"));
  const data = await setup(page);
  data.inboxes = [data.inboxes[0]];
  // Both messages have the same receivedAt; a1 arrived second, a2 first.
  await page.goto("/");
  await expect(page.locator("#inbox-count")).toHaveText("1");
  expect((await notificationLog(page)).shown).toHaveLength(0);
  data.messages = [data.messages[1]];
  Object.assign(data.inboxes[0], {
    latestMessageId: "a2",
    latestArrival: 1,
    messageCount: 1,
    unreadCount: 1,
  });
  await pollInboxSummaries(page);
  expect((await notificationLog(page)).shown).toHaveLength(0);

  data.messages.push(mail("a3"));
  Object.assign(data.inboxes[0], {
    latestMessageId: "a3",
    latestArrival: 3,
    messageCount: 2,
    unreadCount: 2,
  });
  await pollInboxSummaries(page);
  expect((await notificationLog(page)).shown).toHaveLength(1);
  await pollInboxSummaries(page);
  expect((await notificationLog(page)).shown).toHaveLength(1);
  data.messages.forEach((message) => {
    message.isRead = true;
  });
  data.inboxes[0].unreadCount = 0;
  await pollInboxSummaries(page);
  expect((await notificationLog(page)).shown).toHaveLength(1);
});

test("arrival watermark stays at its maximum through empty and backward summaries", async ({
  page,
}) => {
  await page.clock.install();
  await notifications(page, "granted");
  await page.addInitScript(() => localStorage.setItem("plato.notifications", "true"));
  const data = await setup(page);
  data.inboxes = [data.inboxes[0]];
  await page.goto("/");
  await expect(page.locator("#inbox-count")).toHaveText("1");
  Object.assign(data.inboxes[0], {
    latestMessageId: null,
    latestArrival: 0,
    messageCount: 0,
    unreadCount: 0,
  });
  await pollInboxSummaries(page);
  expect((await notificationLog(page)).shown).toHaveLength(0);
  // A backward snapshot cannot lower the remembered maximum of 2.
  Object.assign(data.inboxes[0], {
    latestMessageId: "a2",
    latestArrival: 1,
    messageCount: 1,
    unreadCount: 1,
  });
  await pollInboxSummaries(page);
  expect((await notificationLog(page)).shown).toHaveLength(0);
  Object.assign(data.inboxes[0], { latestMessageId: "a-new", latestArrival: 3 });
  await pollInboxSummaries(page);
  expect((await notificationLog(page)).shown).toHaveLength(1);
  Object.assign(data.inboxes[0], {
    latestMessageId: null,
    latestArrival: 0,
    messageCount: 0,
    unreadCount: 0,
  });
  await pollInboxSummaries(page);
  Object.assign(data.inboxes[0], {
    latestMessageId: "unseen-older",
    latestArrival: 2,
    messageCount: 1,
  });
  await pollInboxSummaries(page);
  expect((await notificationLog(page)).shown).toHaveLength(1);
  Object.assign(data.inboxes[0], { latestMessageId: "next", latestArrival: 4 });
  await pollInboxSummaries(page);
  expect((await notificationLog(page)).shown).toHaveLength(2);
});

test("arrival watermark detects same-timestamp insertions even when latest message ID is unchanged", async ({
  page,
}) => {
  await page.clock.install();
  await notifications(page, "granted");
  await page.addInitScript(() => localStorage.setItem("plato.notifications", "true"));
  const data = await setup(page);
  await page.goto("/");
  await expect(page.locator("#inbox-count")).toHaveText("2");
  // The timestamp/ID ordering still chooses a1, but an inserted message has a higher sequence.
  data.messages.push(mail("a0"));
  data.inboxes[0].latestArrival = 4;
  data.inboxes[0].messageCount++;
  await pollInboxSummaries(page);
  expect((await notificationLog(page)).shown).toHaveLength(1);
  await pollInboxSummaries(page);
  expect((await notificationLog(page)).shown).toHaveLength(1);
});

test("arrival watermark never falls back to message IDs for missing or invalid sequence fields", async ({
  page,
}) => {
  await page.clock.install();
  await notifications(page, "granted");
  await page.addInitScript(() => localStorage.setItem("plato.notifications", "true"));
  const data = await setup(page);
  let latestArrival: unknown;
  let latestMessageId = "initial";
  await page.route("**/api/inboxes", (route) =>
    route.fulfill({
      json: {
        inboxes: [{ ...data.inboxes[0], latestMessageId, latestArrival }],
      },
    }),
  );
  await page.goto("/");
  await expect(page.locator("#inbox-count")).toHaveText("1");
  for (const value of [undefined, null, "9", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    latestArrival = value;
    latestMessageId = `changed-${String(value)}`;
    await pollInboxSummaries(page);
    expect((await notificationLog(page)).shown).toHaveLength(0);
  }
  latestArrival = 10;
  await pollInboxSummaries(page);
  expect((await notificationLog(page)).shown).toHaveLength(0);
  latestArrival = 11;
  await pollInboxSummaries(page);
  expect((await notificationLog(page)).shown).toHaveLength(1);
});

test("Plato branding and password dialog explain the current account session policy", async ({
  page,
}) => {
  const data = await setup(page);
  await page.goto("/");
  await expect(page).toHaveTitle("Plato-Tempmail — Kotak masuk Anda");
  await expect(page.locator("#workspace .brand-mark")).toHaveText("P");
  await page.locator("#account-settings").click();
  await expect(page.locator("#password-help")).toContainText(
    "Gunakan 5–1024 karakter, berbeda dari kata sandi saat ini",
  );
  await expect(page.locator("#password-help")).toContainText("semua sesi akun Anda akan keluar");
  await expect(page.locator("#password-help")).toContainText("Masuk kembali ke Plato-Tempmail");
  await page.keyboard.press("Escape");
  expect(data.passwords).toHaveLength(0);
});

for (const permission of ["denied", "unsupported"])
  test(`notifications ${permission} are explained without requesting permission`, async ({
    page,
  }) => {
    if (permission === "unsupported")
      await page.addInitScript(() =>
        Object.defineProperty(globalThis, "Notification", { value: undefined }),
      );
    else await notifications(page, permission);
    await setup(page);
    await page.goto("/");
    await expect(page.locator("#notification-toggle")).toBeDisabled();
    await expect(page.locator("#notification-status")).toContainText(
      permission === "denied" ? "ditolak" : "tidak mendukung",
    );
  });
