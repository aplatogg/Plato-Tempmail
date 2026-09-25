import { expect, type Page, test } from "@playwright/test";

// Browser callbacks run in Chromium. Keep their ambient types module-local so
// lib.dom does not replace Cloudflare's extended SubtleCrypto in the worker tests.
declare const document: {
  documentElement: { scrollWidth: number };
  dispatchEvent(event: Event): boolean;
};
declare const window: { innerWidth: number; fetch: typeof fetch };
declare function requestAnimationFrame(callback: () => void): number;
interface HTMLInputElement {
  selectionStart: number | null;
  selectionEnd: number | null;
}
interface HTMLFormElement {
  requestSubmit(): void;
}

const session = {
  user: { id: "owner", username: "operator", role: "owner" },
  mailDomain: "example.com",
  retentionDays: 7,
};
const now = 1790164800;
const inbox = (id: string, address: string) => ({
  id,
  address,
  createdAt: now,
  messageCount: 2,
  favorite: false,
  unreadCount: 0,
  latestMessageId: `${id}1` as string | null,
  latestArrival: id === "a" ? 2 : 4,
});
const message = (id: string, inboxId = "a") => ({
  id,
  inboxId,
  from: "Tim Produk <tim@example.org>",
  subject: `Pesan ${id}`,
  preview: "Kabar terbaru untuk Anda",
  body: `Isi lengkap ${id}\nBaris kedua.`,
  receivedAt: now,
  expiresAt: now + 604800,
  isRead: true,
});

async function mockApi(page: Page, authenticated = true) {
  const data = {
    authenticated,
    inboxes: [inbox("a", "alpha@example.com"), inbox("b", "beta@example.com")],
    creates: [] as unknown[],
    deletes: [] as string[],
    calls: [] as string[],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    data.calls.push(`${method} ${path}${url.search}`);
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === "/api/auth/login") {
      if (request.postDataJSON().password !== "correct")
        return reply(
          {
            error: { code: "INVALID_CREDENTIALS", message: "Nama pengguna atau kata sandi salah." },
          },
          401,
        );
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
    if (path === "/api/inboxes" && method === "GET") return reply({ inboxes: data.inboxes });
    if (path === "/api/inboxes" && method === "POST") {
      const body = request.postDataJSON();
      data.creates.push(body);
      const created = {
        ...inbox(`new${data.creates.length}`, `${body.localPart || "acak123"}@example.com`),
        messageCount: 0,
        latestMessageId: null,
        latestArrival: 0,
      };
      data.inboxes.push(created);
      return reply({ inbox: created }, 201);
    }
    if (method === "DELETE") {
      data.deletes.push(path);
      data.inboxes = data.inboxes.filter((item) => path !== `/api/inboxes/${item.id}`);
      return reply({ ok: true });
    }
    if (method === "PATCH") {
      const item = data.inboxes.find((item) => path === `/api/inboxes/${item.id}`);
      if (item) item.favorite = request.postDataJSON().favorite;
      return reply({ ok: true });
    }
    if (path.match(/^\/api\/inboxes\/[^/]+\/messages$/)) {
      const id = path.split("/")[3];
      return reply({
        messages: id.startsWith("new")
          ? []
          : [message(url.searchParams.has("cursor") ? `${id}2` : `${id}1`, id)],
        nextCursor: url.searchParams.has("cursor") || id.startsWith("new") ? null : "opaque+/=?",
      });
    }
    if (path.startsWith("/api/messages/")) {
      const id = path.split("/")[3];
      return reply({ message: message(id, id[0]) });
    }
    return reply({ error: { code: "NOT_FOUND", message: "Tidak ditemukan." } }, 404);
  });
  return data;
}

async function openInbox(page: Page, name = "alpha@example.com") {
  await page.getByRole("button", { name: `Buka kotak masuk ${name}`, exact: true }).click();
}

async function backToInboxes(page: Page) {
  const readerBack = page.getByRole("button", { name: "Kembali ke pesan", exact: true });
  if (await readerBack.isVisible()) await readerBack.click();
  const listBack = page.getByRole("button", { name: "Kembali ke kotak masuk", exact: true });
  if (await listBack.isVisible()) await listBack.click();
}

test("login validates credentials and logs out without persistent browser storage", async ({
  page,
}) => {
  const data = await mockApi(page, false);
  await page.goto("/");
  await page.getByLabel("Nama pengguna").fill("operator");
  await page.getByLabel("Kata sandi", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("salah");
  await page.getByLabel("Kata sandi", { exact: true }).fill("correct");
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Buka kotak masuk alpha@example.com" }),
  ).toBeVisible();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  await page.getByRole("button", { name: "Keluar", exact: true }).click();
  await expect(page.getByLabel("Kata sandi", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Kata sandi", { exact: true })).toHaveValue("");
  expect(data.authenticated).toBe(false);
});

test("search, read, opaque pagination and mobile back navigation", async ({ page, isMobile }) => {
  const data = await mockApi(page);
  await page.goto("/");
  await page.getByLabel("Cari kotak masuk").fill("beta");
  await expect(
    page.getByRole("button", { name: "Buka kotak masuk alpha@example.com" }),
  ).toHaveCount(0);
  await page.getByLabel("Cari kotak masuk").fill("");
  await openInbox(page);
  await page.getByRole("button", { name: "Muat pesan lainnya" }).click();
  await expect(page.getByRole("button", { name: /Baca Pesan a2/ })).toBeVisible();
  expect(data.calls.some((call) => call.includes("cursor=opaque%2B%2F%3D%3F"))).toBe(true);
  await page.getByRole("button", { name: /Baca Pesan a1/ }).click();
  await expect(page.locator("#message-body")).toHaveText("Isi lengkap a1\nBaris kedua.");
  await expect(page.locator("#message-received")).toContainText("2026");
  if (isMobile) {
    await page.getByRole("button", { name: "Kembali ke pesan", exact: true }).click();
    await expect(page.getByRole("button", { name: /Baca Pesan a2/ })).toBeVisible();
    await page.getByRole("button", { name: "Kembali ke kotak masuk", exact: true }).click();
  } else {
    await expect(page.getByLabel("Cari kotak masuk")).toBeVisible();
    await expect(page.getByRole("button", { name: /Baca Pesan a2/ })).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("custom and random inbox creation with local-part normalization and reserved names", async ({
  page,
}) => {
  const data = await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Kotak masuk baru", exact: true }).click();
  for (const invalid of [
    "Admin",
    "postmaster",
    "abuse",
    "security",
    "mailer-daemon",
    "noreply",
    "no-reply",
    "bad.name",
    "-name",
  ]) {
    await page.getByLabel("Nama alamat (opsional)").fill(invalid);
    await page.getByRole("button", { name: "Buat alamat", exact: true }).click();
    await expect(page.locator("#create-error")).not.toBeEmpty();
  }
  expect(data.creates).toHaveLength(0);
  await page.getByLabel("Nama alamat (opsional)").fill("  Proyek_24  ");
  await page.getByRole("button", { name: "Buat alamat", exact: true }).click();
  await expect(page.locator("#selected-address")).toHaveText("proyek_24@example.com");
  expect(data.creates).toEqual([{ localPart: "proyek_24" }]);
  await expect(page.locator("#messages-state")).toContainText("Belum ada pesan");
  await backToInboxes(page);
  await page.getByRole("button", { name: "Kotak masuk baru", exact: true }).click();
  await page.getByRole("button", { name: "Buat alamat", exact: true }).click();
  await expect(page.locator("#selected-address")).toHaveText("acak123@example.com");
  expect(data.creates).toEqual([{ localPart: "proyek_24" }, {}]);
});

test("copy falls back to a selectable address when Clipboard API is denied", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
    }),
  );
  await mockApi(page);
  await page.goto("/");
  await openInbox(page);
  await page.getByRole("button", { name: "Salin alamat", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Salin alamat" })).toBeVisible();
  await expect(page.getByLabel("Alamat untuk disalin")).toHaveValue("alpha@example.com");
  expect(
    await page
      .getByLabel("Alamat untuk disalin")
      .evaluate(
        (input: HTMLInputElement) => (input.selectionEnd ?? 0) - (input.selectionStart ?? 0),
      ),
  ).toBe("alpha@example.com".length);
});

test("deletion requires confirmation and supports cancel for messages and inboxes", async ({
  page,
}) => {
  const data = await mockApi(page);
  await page.goto("/");
  await openInbox(page);
  await page.getByRole("button", { name: /Baca Pesan a1/ }).click();
  await page.getByRole("button", { name: "Hapus pesan", exact: true }).click();
  await page.getByRole("button", { name: "Batal", exact: true }).click();
  expect(data.deletes).toHaveLength(0);
  await page.getByRole("button", { name: "Hapus pesan", exact: true }).click();
  await page.getByRole("button", { name: "Ya, hapus", exact: true }).click();
  await expect(page.getByRole("button", { name: /Baca Pesan a1/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Hapus kotak masuk", exact: true }).click();
  await page.getByRole("button", { name: "Batal", exact: true }).click();
  await page.getByRole("button", { name: "Hapus kotak masuk", exact: true }).click();
  await page.getByRole("button", { name: "Ya, hapus", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Buka kotak masuk alpha@example.com" }),
  ).toHaveCount(0);
  expect(data.deletes).toEqual(["/api/messages/a1", "/api/inboxes/a"]);
});

test("email fields are inert text and strict CSP blocks inline code", async ({ page }) => {
  await mockApi(page);
  const hostile = '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>';
  await page.route("**/api/messages/a1", (route) =>
    route.fulfill({
      json: { message: { ...message("a1"), from: hostile, subject: hostile, body: hostile } },
    }),
  );
  await page.goto("/");
  await openInbox(page);
  await page.getByRole("button", { name: /Baca Pesan a1/ }).click();
  await expect(page.locator("#message-body")).toHaveText(hostile);
  await expect(page.locator("#message-subject")).toHaveText(hostile);
  await expect(page.locator("#message-from")).toHaveText(hostile);
  await expect(page.locator("#reader img, #reader script, [style], script:not([src])")).toHaveCount(
    0,
  );
  expect(await page.evaluate(() => "pwned" in window)).toBe(false);
  const policy = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  expect(policy).toContain("script-src 'self'");
  expect(policy).not.toContain("unsafe-inline");
});

test("loading, error retry, empty inbox and no search results", async ({ page }) => {
  const data = await mockApi(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/api/inboxes",
    async (route) => {
      await held;
      await route.fulfill({
        status: 503,
        json: { error: { code: "UNAVAILABLE", message: "Layanan sedang sibuk." } },
      });
    },
    { times: 1 },
  );
  await page.goto("/");
  await expect(page.locator("#inboxes-state")).toContainText("Memuat");
  release();
  await expect(page.locator("#inboxes-state")).toContainText("Layanan sedang sibuk");
  await page.getByRole("button", { name: "Coba lagi kotak masuk" }).click();
  await expect(
    page.getByRole("button", { name: "Buka kotak masuk alpha@example.com" }),
  ).toBeVisible();
  await page.getByLabel("Cari kotak masuk").fill("tidak-ada");
  await expect(page.locator("#inboxes-state")).toContainText("Tidak ada hasil");
  data.inboxes = [];
  await page.reload();
  await expect(page.locator("#inboxes-state")).toContainText("Belum ada kotak masuk");
});

test("late inbox responses cannot replace the newly selected inbox", async ({ page }) => {
  await mockApi(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/inboxes/a/messages", async (route) => {
    await held;
    await route.fulfill({ json: { messages: [message("old")], nextCursor: null } });
  });
  await page.goto("/");
  await openInbox(page);
  await backToInboxes(page);
  await openInbox(page, "beta@example.com");
  await expect(page.getByRole("button", { name: /Baca Pesan b1/ })).toBeVisible();
  release();
  await expect(page.locator("#selected-address")).toHaveText("beta@example.com");
  await expect(page.getByRole("button", { name: /Baca Pesan old/ })).toHaveCount(0);
});

test("late message detail and logout responses cannot restore private content", async ({
  page,
}) => {
  await mockApi(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/messages/a1", async (route) => {
    await held;
    await route.fulfill({ json: { message: message("a1") } });
  });
  await page.goto("/");
  await openInbox(page);
  await page.getByRole("button", { name: /Baca Pesan a1/ }).click();
  await expect(page.locator("#reader-state")).toContainText("Memuat");
  await page.getByRole("button", { name: "Keluar", exact: true }).click();
  release();
  await expect(page.getByLabel("Nama pengguna")).toBeVisible();
  await expect(page.locator("#message-body")).toBeEmpty();
  await expect(page.locator("#workspace")).toBeHidden();
});

test("duplicate creation is blocked while a mutation is pending", async ({ page }) => {
  const data = await mockApi(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/inboxes", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await held;
    return route.fallback();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Kotak masuk baru", exact: true }).click();
  await page.getByRole("button", { name: "Buat alamat", exact: true }).click();
  await expect(page.locator("#create-submit")).toBeDisabled();
  await page.locator("#create-form").evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  release();
  await expect(page.locator("#selected-address")).toHaveText("acak123@example.com");
  expect(data.creates).toHaveLength(1);
});

test("polls every 30 seconds only while visible and stops after logout", async ({ page }) => {
  await page.clock.install();
  const data = await mockApi(page);
  await page.goto("/");
  await openInbox(page);
  await expect(page.getByRole("button", { name: /Baca Pesan a1/ })).toBeVisible();
  const count = () => data.calls.filter((call) => call === "GET /api/inboxes/a/messages").length;
  const before = count();
  await page.clock.fastForward(29000);
  expect(count()).toBe(before);
  await page.clock.fastForward(1000);
  await expect.poll(count).toBe(before + 1);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenCount = data.calls.length;
  await page.clock.fastForward(90000);
  expect(data.calls.length).toBe(hiddenCount);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.getByRole("button", { name: "Keluar", exact: true }).click();
  await expect(page.getByLabel("Nama pengguna")).toBeVisible();
  const loggedOut = data.calls.length;
  await page.clock.fastForward(90000);
  expect(data.calls.length).toBe(loggedOut);
});

test("expired session clears private content and asks for login", async ({ page }) => {
  const data = await mockApi(page);
  await page.goto("/");
  await openInbox(page);
  await expect(page.getByRole("button", { name: /Baca Pesan a1/ })).toBeVisible();
  data.authenticated = false;
  await page.getByRole("button", { name: "Segarkan pesan", exact: true }).click();
  await expect(page.getByLabel("Nama pengguna")).toBeVisible();
  await expect(page.locator("#inbox-list")).toBeEmpty();
});

test("message list and detail failures offer working retries", async ({ page }) => {
  await mockApi(page);
  await page.route(
    "**/api/inboxes/a/messages",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: "BUSY", message: "Pesan belum dapat dimuat." } },
      }),
    { times: 1 },
  );
  await page.goto("/");
  await openInbox(page);
  await expect(page.locator("#messages-state")).toContainText("Pesan belum dapat dimuat");
  await page.getByRole("button", { name: "Coba lagi pesan", exact: true }).click();
  await page.route(
    "**/api/messages/a1",
    (route) =>
      route.fulfill({
        status: 404,
        json: { error: { code: "NOT_FOUND", message: "Pesan tidak ditemukan." } },
      }),
    { times: 1 },
  );
  await page.getByRole("button", { name: /Baca Pesan a1/ }).click();
  await expect(page.locator("#reader-state")).toContainText("Pesan tidak ditemukan");
  await page.getByRole("button", { name: "Coba lagi isi pesan", exact: true }).click();
  await expect(page.locator("#message-body")).toContainText("Isi lengkap a1");
});

test("pagination retry requests the failed cursor and retains earlier pages", async ({ page }) => {
  const data = await mockApi(page);
  await page.goto("/");
  await openInbox(page);
  await page.route(
    "**/api/inboxes/a/messages?*",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: "BUSY", message: "Coba lagi nanti." } },
      }),
    { times: 1 },
  );
  await page.getByRole("button", { name: "Muat pesan lainnya" }).click();
  await expect(page.locator("#messages-state")).toContainText("Coba lagi nanti");
  await page.getByRole("button", { name: "Coba lagi pesan", exact: true }).click();
  await expect(page.getByRole("button", { name: /Baca Pesan a2/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Baca Pesan a1/ })).toBeVisible();
  expect(data.calls.at(-1)).toContain("cursor=opaque%2B%2F%3D%3F");
});

test("poll refresh removes vanished messages and updates existing previews", async ({ page }) => {
  await page.clock.install();
  await mockApi(page);
  await page.goto("/");
  await openInbox(page);
  await expect(page.getByRole("button", { name: /Baca Pesan a1/ })).toBeVisible();
  await page.route("**/api/inboxes/a/messages", (route) =>
    route.fulfill({
      json: { messages: [{ ...message("a1"), preview: "Pratinjau diperbarui" }], nextCursor: null },
    }),
  );
  await page.clock.fastForward(30000);
  await expect(page.locator("#message-list")).toContainText("Pratinjau diperbarui");
  await page.route("**/api/inboxes/a/messages", (route) =>
    route.fulfill({ json: { messages: [], nextCursor: null } }),
  );
  await page.clock.fastForward(30000);
  await expect(page.getByRole("button", { name: /Baca Pesan a1/ })).toHaveCount(0);
  await expect(page.locator("#messages-state")).toContainText("Belum ada pesan");
});

test("mutation errors retain the form or item and permit a deliberate retry", async ({ page }) => {
  const data = await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Kotak masuk baru", exact: true }).click();
  await page.getByLabel("Nama alamat (opsional)").fill("nama");
  await page.route(
    "**/api/inboxes",
    (route) =>
      route.fulfill({
        status: 409,
        json: { error: { code: "CONFLICT", message: "Alamat sudah digunakan." } },
      }),
    { times: 1 },
  );
  await page.getByRole("button", { name: "Buat alamat", exact: true }).click();
  await expect(page.locator("#create-error")).toContainText("Alamat sudah digunakan");
  await expect(page.getByLabel("Nama alamat (opsional)")).toHaveValue("nama");
  await page.getByRole("button", { name: "Buat alamat", exact: true }).click();
  await expect(page.locator("#selected-address")).toHaveText("nama@example.com");
  await page.route(
    "**/api/inboxes/new1",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: "BUSY", message: "Penghapusan gagal." } },
      }),
    { times: 1 },
  );
  await page.getByRole("button", { name: "Hapus kotak masuk", exact: true }).click();
  await page.getByRole("button", { name: "Ya, hapus", exact: true }).click();
  await expect(page.locator("#delete-error")).toContainText("Penghapusan gagal");
  expect(data.deletes).toHaveLength(0);
  await page.getByRole("button", { name: "Ya, hapus", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(data.deletes).toEqual(["/api/inboxes/new1"]);
});

test("logout failure keeps private data cleared and blocks login until retry completes", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");
  await openInbox(page);
  await page.route("**/api/auth/logout", (route) => route.abort(), { times: 1 });
  await page.getByRole("button", { name: "Keluar", exact: true }).click();
  await expect(page.locator("#login-error")).toContainText("Belum berhasil keluar");
  await expect(page.locator("#inbox-list")).toBeEmpty();
  await expect(page.getByRole("button", { name: "Masuk", exact: true })).toBeDisabled();
  await page.route(
    "**/api/auth/logout",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: "BUSY", message: "Server sedang sibuk." } },
      }),
    { times: 1 },
  );
  await page.getByRole("button", { name: "Coba lagi keluar", exact: true }).click();
  await expect(page.locator("#login-error")).toContainText("Server sedang sibuk");
  await expect(page.getByRole("button", { name: "Masuk", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Coba lagi keluar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Masuk", exact: true })).toBeEnabled();
});

test("logout 401 for an expired or revoked session returns to usable login", async ({ page }) => {
  const data = await mockApi(page);
  await page.goto("/");
  await openInbox(page);
  await page.getByRole("button", { name: /Baca Pesan a1/ }).click();
  await expect(page.locator("#message-body")).toContainText("Isi lengkap a1");
  data.authenticated = false;
  let attempts = 0;
  await page.route("**/api/auth/logout", (route) => {
    attempts += 1;
    return route.fulfill({
      status: 401,
      json: { error: { code: "UNAUTHORIZED", message: "Sesi tidak valid." } },
    });
  });
  await page.getByRole("button", { name: "Keluar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Masuk", exact: true })).toBeEnabled();
  await expect(page.locator("#retry-logout")).toBeHidden();
  await expect(page.locator("#login-error")).toBeHidden();
  await expect(page.locator("#login-error")).toBeEmpty();
  await expect(page.locator("#inbox-list")).toBeEmpty();
  await expect(page.locator("#message-body")).toBeEmpty();
  expect(attempts).toBe(1);
  await page.getByLabel("Nama pengguna").fill("operator");
  await page.getByLabel("Kata sandi", { exact: true }).fill("correct");
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Buka kotak masuk alpha@example.com" }),
  ).toBeVisible();
});

test("logout 401 on retry recovers after a successful server logout response is lost", async ({
  page,
}) => {
  const data = await mockApi(page);
  await page.goto("/");
  await openInbox(page);
  let attempts = 0;
  await page.route("**/api/auth/logout", (route) => {
    attempts += 1;
    if (data.authenticated) {
      // The server revoked the session, but its successful response never arrived.
      data.authenticated = false;
      return route.abort();
    }
    return route.fulfill({
      status: 401,
      json: { error: { code: "UNAUTHORIZED", message: "Sesi tidak valid." } },
    });
  });
  await page.getByRole("button", { name: "Keluar", exact: true }).click();
  await expect(page.locator("#login-error")).toContainText("Belum berhasil keluar");
  await expect(page.getByRole("button", { name: "Masuk", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Coba lagi keluar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Masuk", exact: true })).toBeEnabled();
  await expect(page.locator("#retry-logout")).toBeHidden();
  await expect(page.locator("#login-error")).toBeHidden();
  await expect(page.locator("#login-error")).toBeEmpty();
  await expect(page.locator("#inbox-list")).toBeEmpty();
  expect(attempts).toBe(2);
  await page.getByLabel("Nama pengguna").fill("operator");
  await page.getByLabel("Kata sandi", { exact: true }).fill("correct");
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Buka kotak masuk alpha@example.com" }),
  ).toBeVisible();
});

test("late detail from another inbox stays discarded even if transport ignores abort", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) =>
      original(
        input,
        String(input).includes("/messages/a1") ? { ...init, signal: undefined } : init,
      );
  });
  await mockApi(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/messages/a1", async (route) => {
    await held;
    await route.fulfill({ json: { message: message("a1") } });
  });
  await page.goto("/");
  await openInbox(page);
  await page.getByRole("button", { name: /Baca Pesan a1/ }).click();
  await backToInboxes(page);
  await openInbox(page, "beta@example.com");
  await page.getByRole("button", { name: /Baca Pesan b1/ }).click();
  await expect(page.locator("#message-body")).toContainText("Isi lengkap b1");
  const response = page.waitForResponse("**/api/messages/a1");
  release();
  await response;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator("#message-body")).toContainText("Isi lengkap b1");
});

test("long hostile list fields wrap safely and keyboard dialogs restore focus", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockApi(page);
  const hostile = `<img src="x" onerror="alert(1)">${"panjang".repeat(30)}`;
  await page.route("**/api/inboxes/a/messages", (route) =>
    route.fulfill({
      json: {
        messages: [{ ...message("a1"), from: hostile, subject: hostile, preview: hostile }],
        nextCursor: null,
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Kotak masuk baru", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Nama alamat (opsional)")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Kotak masuk baru", exact: true })).toBeFocused();
  await openInbox(page);
  await expect(page.locator("#message-list .message-preview")).toHaveText(hostile);
  await expect(page.locator("#message-list img")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("mail-list.png"), fullPage: true });
  await page.locator(".message-item").click();
  await expect(page.locator("#message-body")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mail-reader.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("paginated polling stops before fetching another page when the tab becomes hidden", async ({
  page,
}) => {
  await page.clock.install();
  const data = await mockApi(page);
  await page.goto("/");
  await openInbox(page);
  await page.getByRole("button", { name: "Muat pesan lainnya" }).click();
  await expect(page.getByRole("button", { name: /Baca Pesan a2/ })).toBeVisible();
  let release: () => void = () => {};
  let started = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/inboxes/a/messages", async (route) => {
    started = true;
    await held;
    await route.fulfill({ json: { messages: [message("a1")], nextCursor: "opaque+/=?" } });
  });
  await page.clock.fastForward(30000);
  await expect.poll(() => started).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const response = page.waitForResponse("**/api/inboxes/a/messages");
  release();
  await response;
  await page.clock.resume();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(data.calls.filter((call) => call.includes("cursor=")).length).toBe(1);
  await expect(page.getByRole("button", { name: /Baca Pesan a2/ })).toBeVisible();
});
