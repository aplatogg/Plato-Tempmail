import { type BrowserContext, expect, type Page, test } from "@playwright/test";

declare const window: {
  fetch: typeof fetch;
  innerWidth: number;
  dispatchEvent(event: Event): boolean;
};
declare const document: {
  documentElement: { scrollWidth: number };
  dispatchEvent(event: Event): boolean;
};
interface HTMLButtonElement {
  click(): void;
}

const owner = {
  id: "owner",
  username: "operator",
  role: "owner",
  roles: ["owner"],
  createdAt: null,
};
const member = {
  id: "member-1",
  username: "alice",
  role: "user",
  roles: ["member"],
  createdAt: 1790164800,
};
const assignableRoles = ["member", "dev", "admin", "owner"];
const secret = "member-password-123";
const box = (id: string) => ({
  id,
  address: `${id}@example.com`,
  createdAt: 1790164800,
  messageCount: 1,
  unreadCount: 1,
  favorite: false,
  latestArrival: 1,
});
const mail = (id: string) => ({
  id: `${id}-message`,
  inboxId: id,
  subject: `Pesan ${id}`,
  from: "sender@example.org",
  preview: "Private preview",
  body: `Private body ${id}`,
  isRead: false,
  receivedAt: 1790164800,
  expiresAt: 1790769600,
});

async function setup(page: Page, role = "owner") {
  const data = {
    user:
      role === "owner"
        ? owner
        : {
            ...member,
            roles: role === "legacy" ? undefined : member.roles,
            role: role === "legacy" ? undefined : role,
          },
    users: [owner, member] as Array<{
      id: string;
      username: string;
      role: string;
      roles: string[];
      createdAt: number | null;
    }>,
    calls: [] as string[],
    headers: [] as { path: string; principal: string | undefined }[],
    creates: [] as unknown[],
    resets: [] as unknown[],
    arrival: 1,
  };
  // Exercise application epoch checks even if a transport cannot honor cancellation.
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => original(input, { ...init, signal: undefined });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    data.calls.push(`${method} ${path}${url.search}`);
    data.headers.push({ path, principal: request.headers()["x-plato-user"] });
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (path === "/api/auth/session" || path === "/api/auth/login")
      return reply({ user: data.user, mailDomain: "example.com", retentionDays: 7 });
    if (path === "/api/auth/logout") return reply({ ok: true });
    if (path === "/api/admin/users") {
      if (method === "GET") return reply({ users: data.users, assignableRoles });
      const body = request.postDataJSON();
      data.creates.push(body);
      const user = { ...member, id: "member-2", username: body.username, roles: body.roles };
      data.users.push(user);
      return reply({ user }, 201);
    }
    if (path === "/api/admin/users/member-1/password") {
      data.resets.push(request.postDataJSON());
      return reply({ ok: true });
    }
    if (path === "/api/inboxes") {
      if (method === "POST") return reply({ inbox: box(request.postDataJSON().localPart) }, 201);
      const id =
        url.searchParams.has("userId") || data.user.role !== "owner" ? "member-box" : "own-box";
      return reply({ inboxes: [{ ...box(id), latestArrival: data.arrival }] });
    }
    if (method === "PATCH" || method === "DELETE") return reply({ ok: true });
    if (path.endsWith("/messages"))
      return reply({ messages: [mail(path.split("/")[3])], nextCursor: null });
    if (path.startsWith("/api/messages/"))
      return reply({ message: mail(path.split("/")[3].replace(/-message$/, "")) });
    return reply({ error: { code: "NOT_FOUND", message: "Tidak ditemukan." } }, 404);
  });
  return data;
}
async function manage(page: Page) {
  await page.getByRole("button", { name: "Kelola pengguna", exact: true }).click();
  await expect(page.locator("#users-list")).toContainText("alice");
}
async function inspect(page: Page) {
  await manage(page);
  await page.getByRole("button", { name: "Lihat inbox alice", exact: true }).click();
  await expect(page.locator("#inspection-banner")).toContainText("alice");
}
async function openBox(page: Page, id = "member-box") {
  await page
    .getByRole("button", { name: `Buka kotak masuk ${id}@example.com`, exact: true })
    .click();
}
async function createFields(page: Page, username = "bob") {
  await page.locator("#user-username").fill(username);
  await page.locator("#user-password").fill(secret);
}
async function heldResponse(page: Page, pattern: string, json: unknown, method = "GET") {
  let release = () => {};
  let started = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Keep interception installed while another request may still be held. A
  // times:1 handler can remove page interception mid-flight when context routes
  // are also active. Hold only the first matching method, then fall through.
  await page.route(pattern, async (route) => {
    if (started || route.request().method() !== method) return route.fallback();
    started = true;
    await held;
    await route.fulfill({ json });
  });
  return {
    started: () => started,
    release: async () => {
      const response = page.waitForResponse(
        (r) => r.request().method() === method && r.url().includes(pattern.replaceAll("**", "")),
      );
      release();
      await (await response).finished();
      // Drain the application response continuations before negative assertions.
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
    },
  };
}

test("owner creates member with strict JSON and resets only member password", async ({ page }) => {
  const data = await setup(page);
  await page.goto("/");
  await manage(page);
  await expect(page.getByRole("button", { name: "Reset kata sandi operator" })).toHaveCount(0);
  await expect(page.locator("#user-password")).toHaveAttribute("type", "password");
  await createFields(page, "  Bob_24  ");
  await page.locator("#user-password").fill("abcde");
  await page.locator("#user-create-submit").click();
  await expect(page.locator("#users-list")).toContainText("bob_24");
  expect(data.creates).toEqual([{ username: "bob_24", password: "abcde", roles: ["member"] }]);
  await expect(page.locator("#user-password")).toHaveValue("");
  await page.getByRole("button", { name: "Reset kata sandi alice", exact: true }).click();
  await expect(page.locator("#reset-user-password")).toHaveAttribute("type", "password");
  await expect(page.locator("#reset-user-help")).toContainText("alice");
  await page.locator("#reset-user-password").fill("four");
  await page.locator("#reset-user-submit").click();
  await expect(page.locator("#reset-user-error")).toContainText("5–1024");
  expect(data.resets).toEqual([]);
  await page.locator("#reset-user-password").fill("vwxyz");
  await page.locator("#reset-user-submit").click();
  await expect(page.locator("#reset-user-dialog")).toBeHidden();
  await expect(page.locator("#reset-user-password")).toHaveValue("");
  expect(data.resets).toEqual([{ password: "vwxyz" }]);
  await expect(page.locator("#workspace")).toBeVisible();
  expect(data.calls).not.toContain("POST /api/auth/password");
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("owner inspection is labeled read-only and returning restores own mutations", async ({
  page,
}) => {
  const data = await setup(page);
  await page.goto("/");
  await openBox(page, "own-box");
  await page.locator(".message-item").click();
  await expect(page.locator("#message-body")).toHaveText("Private body own-box");
  await inspect(page);
  await expect(page.locator("#message-body")).toBeEmpty();
  await expect(page.locator("#inspection-banner")).toContainText("Hanya baca");
  await expect(page.locator("#new-inbox")).toBeHidden();
  await expect(page.locator(".favorite")).toHaveCount(0);
  await expect(page.locator("#inbox-list")).not.toContainText("own-box");
  await openBox(page);
  await expect(page.locator("#delete-inbox")).toBeHidden();
  await page.locator(".message-item").click();
  await expect(page.locator("#message-body")).toHaveText("Private body member-box");
  await expect(page.locator("#delete-message")).toBeHidden();
  await expect(page.locator("#toggle-read")).toBeHidden();
  // Hidden controls remain guarded if activated programmatically.
  for (const id of ["new-inbox", "delete-inbox", "delete-message", "toggle-read"])
    await page.locator(`#${id}`).evaluate((button: HTMLButtonElement) => button.click());
  expect(data.calls.filter((c) => /^(POST|PATCH|DELETE).*member-box/.test(c))).toEqual([]);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.getByRole("button", { name: "Kembali ke inbox saya", exact: true }).click();
  await expect(page.locator("#inspection-banner")).toBeHidden();
  await expect(page.locator("#message-body")).toBeEmpty();
  await expect(page.locator("#new-inbox")).toBeVisible();
  await expect(page.locator("#inbox-list")).toContainText("own-box");
  expect(data.calls).toContain("GET /api/inboxes?userId=member-1");
  expect(data.calls.at(-1)).toBe("GET /api/inboxes");
  await manage(page);
  await page.getByRole("button", { name: "Lihat inbox operator", exact: true }).click();
  await expect(page.locator("#inspection-banner")).toBeHidden();
  expect(data.calls).not.toContain("GET /api/inboxes?userId=owner");
});

for (const role of ["user", "legacy"])
  test(`${role} session cannot expose administration or another inbox`, async ({ page }) => {
    const data = await setup(page, role);
    await page.goto("/?userId=owner");
    await expect(page.locator("#inbox-list")).toContainText("member-box");
    await expect(page.locator("#manage-users")).toBeHidden();
    await expect(page.locator("#inspection-banner")).toBeHidden();
    if (role === "user")
      await expect(
        page.getByText(
          "Owner dapat membaca inbox Anda. Admin tanpa peran Owner tidak dapat mengakses inbox pengguna lain.",
          { exact: true },
        ),
      ).toBeVisible();
    await page.locator("#manage-users").evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator("#users-dialog")).toBeHidden();
    expect(data.calls.some((c) => c.includes("/admin/") || c.includes("userId="))).toBe(false);
    await expect(page.locator("#new-inbox")).toBeVisible();
  });

test("admin validation, collision recovery, list retry and member limit", async ({ page }) => {
  const data = await setup(page);
  await page.route(
    "**/api/admin/users",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: "BUSY", message: "Daftar belum tersedia." } },
      }),
    { times: 1 },
  );
  await page.goto("/");
  await page.locator("#manage-users").click();
  await expect(page.locator("#users-error")).toHaveText("Daftar belum tersedia.");
  await page.locator("#retry-users").click();
  await expect(page.locator("#users-list")).toContainText("alice");
  for (const username of ["ab", "-invalid", "bad.name", "operator", "x".repeat(33)]) {
    await createFields(page, username);
    await page.locator("#user-create-submit").click();
    await expect(page.locator("#user-create-error")).not.toBeEmpty();
  }
  for (const password of ["four", "     "]) {
    await createFields(page);
    await page.locator("#user-password").fill(password);
    await page.locator("#user-create-submit").click();
    await expect(page.locator("#user-create-error")).not.toBeEmpty();
  }
  expect(data.creates).toEqual([]);
  await page.route(
    "**/api/admin/users",
    (route) =>
      route.fulfill({
        status: 409,
        json: { error: { code: "USERNAME_EXISTS", message: "Nama pengguna sudah digunakan." } },
      }),
    { times: 1 },
  );
  await createFields(page, "alice");
  await page.locator("#user-create-submit").click();
  await expect(page.locator("#user-create-error")).toContainText("sudah digunakan");
  await createFields(page, "bob");
  await page.locator("#user-create-submit").click();
  await expect(page.locator("#users-list")).toContainText("bob");
  data.users = [
    owner,
    ...Array.from({ length: 100 }, (_, i) => ({ ...member, id: `m${i}`, username: `member${i}` })),
  ];
  await page.locator("#close-users").click();
  await page.locator("#manage-users").click();
  await expect(page.locator("#users-count")).toContainText("100/100");
  await expect(page.locator("#user-create-submit")).toBeDisabled();
});

test("address conflict is exact and clears when choosing another address", async ({ page }) => {
  await setup(page, "user");
  await page.goto("/");
  await page.locator("#new-inbox").click();
  await page.locator("#local-part").fill("reserved-for-other-user");
  await page.route(
    "**/api/inboxes",
    (route) =>
      route.fulfill({
        status: 409,
        json: {
          error: {
            code: "ADDRESS_EXISTS",
            message: "Email sudah digunakan. Silakan gunakan email lain.",
          },
        },
      }),
    { times: 1 },
  );
  await page.locator("#create-submit").click();
  await expect(page.locator("#create-error")).toHaveText(
    "Email sudah digunakan. Silakan gunakan email lain.",
  );
  await page.locator("#local-part").fill("my-new-address");
  await expect(page.locator("#create-error")).toBeHidden();
  await page.locator("#create-submit").click();
  await expect(page.locator("#selected-address")).toHaveText("my-new-address@example.com");
});

test("admin dialogs wipe passwords on keyboard close and stay within viewport", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/");
  await page.locator("#manage-users").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#user-username")).toBeFocused();
  await createFields(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#user-password")).toHaveValue("");
  await expect(page.locator("#manage-users")).toBeFocused();
  await manage(page);
  await page.getByRole("button", { name: "Reset kata sandi alice", exact: true }).click();
  await page.locator("#reset-user-password").fill(secret);
  await page.keyboard.press("Escape");
  await expect(page.locator("#reset-user-password")).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Reset kata sandi alice", exact: true }),
  ).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const bounds = await page.locator("#users-dialog").boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(
    page.viewportSize()?.width ?? 0,
  );
});

for (const kind of ["inboxes", "messages", "detail", "search"])
  test(`pending ${kind} response cannot repaint after scope switch`, async ({ page }) => {
    await setup(page);
    await page.goto("/");
    await expect(page.locator("#inbox-list")).toContainText("own-box");
    const path =
      kind === "inboxes"
        ? "**/api/inboxes"
        : kind === "detail"
          ? "**/api/messages/own-box-message"
          : `**/api/inboxes/own-box/messages${kind === "search" ? "?q=old" : ""}`;
    if (kind === "detail" || kind === "search") await openBox(page, "own-box");
    const pending = await heldResponse(
      page,
      path,
      kind === "inboxes"
        ? { inboxes: [box("stale-box")] }
        : kind === "detail"
          ? { message: mail("own-box") }
          : { messages: [mail("stale-box")], nextCursor: "stale" },
    );
    if (kind === "inboxes") await page.locator("#refresh-inboxes").click();
    else if (kind === "messages") await openBox(page, "own-box");
    else if (kind === "detail") await page.locator(".message-item").click();
    else {
      await page.locator("#message-search").fill("old");
      await page.locator("#message-search").press("Enter");
    }
    await expect.poll(pending.started).toBe(true);
    await inspect(page);
    await expect(page.locator("#inbox-list")).toContainText("member-box");
    await pending.release();
    await expect(page.locator("#inbox-list")).not.toContainText("stale-box");
    await expect(page.locator("#message-list")).toBeEmpty();
    await expect(page.locator("#message-body")).toBeEmpty();
    await expect(page.locator("#message-search")).toHaveValue("");
    await expect(page.locator("#load-more")).toBeHidden();
  });

for (const action of ["list", "create", "reset"])
  for (const destination of ["logout", "switch"])
    test(`stale admin ${action} after ${destination} cannot repaint or retain passwords`, async ({
      page,
    }) => {
      const data = await setup(page);
      await page.goto("/");
      if (action !== "list") await manage(page);
      const path =
        action === "reset" ? "**/api/admin/users/member-1/password" : "**/api/admin/users";
      const pending = await heldResponse(
        page,
        path,
        action === "list"
          ? { users: [{ ...member, username: "stale-user" }], assignableRoles }
          : action === "create"
            ? { user: { ...member, username: "stale-user", password: secret } }
            : { ok: true },
        action === "list" ? "GET" : "POST",
      );
      if (action === "list") await page.locator("#manage-users").click();
      else if (action === "create") {
        await createFields(page);
        await page.locator("#user-create-submit").click();
      } else {
        await page.getByRole("button", { name: "Reset kata sandi alice", exact: true }).click();
        await page.locator("#reset-user-password").fill(secret);
        await page.locator("#reset-user-submit").click();
      }
      await expect.poll(pending.started).toBe(true);
      // Logout must also work when invoked during a modal operation/session expiry.
      if (destination === "logout") {
        await page.locator("#logout").evaluate((button: HTMLButtonElement) => button.click());
        await expect(page.locator("#login")).toBeVisible();
        data.user = member;
        await page.locator("#username").fill("alice");
        await page.locator("#password").fill(secret);
        await page.locator("#login-submit").click();
      } else {
        if (action === "reset") await page.locator("#close-reset-user").click();
        await page.locator("#close-users").click();
        await inspect(page);
      }
      await pending.release();
      await expect(page.locator("#users-list")).toBeEmpty();
      await expect(page.locator("#user-password")).toHaveValue("");
      await expect(page.locator("#reset-user-password")).toHaveValue("");
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      await expect(page.locator("#notice")).toBeHidden();
      await expect(page.locator("body")).not.toContainText("stale-user");
    });

test("inspection suppresses notifications and returning establishes a fresh own baseline", async ({
  page,
}) => {
  await page.clock.install();
  await page.addInitScript(() => {
    localStorage.setItem("plato.notifications", "true");
    Object.assign(globalThis, { shown: 0 });
    class FakeNotification {
      static permission = "granted";
      constructor() {
        const g = globalThis as unknown as { shown: number };
        g.shown++;
      }
      close() {}
    }
    Object.assign(globalThis, { Notification: FakeNotification });
  });
  const data = await setup(page);
  await page.goto("/");
  await inspect(page);
  data.arrival = 50;
  await page.clock.fastForward(30000);
  await expect(page.locator("#refresh-inboxes")).toBeEnabled();
  expect(await page.evaluate(() => (globalThis as unknown as { shown: number }).shown)).toBe(0);
  await page.locator("#return-own-inboxes").click();
  await expect(page.locator("#inbox-list")).toContainText("own-box");
  expect(await page.evaluate(() => (globalThis as unknown as { shown: number }).shown)).toBe(0);
  data.arrival = 51;
  await page.clock.fastForward(30000);
  await expect
    .poll(() => page.evaluate(() => (globalThis as unknown as { shown: number }).shown))
    .toBe(1);
});

// Shared server-side principal stands in for the cookie shared by both pages. The
// optional header mirrors requireSession: reject mismatch without revoking B.
async function sharedAuth(context: BrowserContext) {
  const data = {
    user: owner as typeof owner | typeof member | null,
    mutations: [] as string[],
    calls: [] as { path: string; principal: string | undefined }[],
  };
  await context.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => original(input, { ...init, signal: undefined });
  });
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const principal = request.headers()["x-plato-user"];
    data.calls.push({ path, principal });
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    const session = () => ({ user: data.user, mailDomain: "example.com", retentionDays: 7 });
    if (path === "/api/auth/login") {
      data.user = request.postDataJSON().username === "alice" ? member : owner;
      return reply(session());
    }
    if (!data.user)
      return reply({ error: { code: "UNAUTHORIZED", message: "Silakan masuk." } }, 401);
    if (path === "/api/auth/session") return reply(session());
    if (principal && principal !== data.user.id)
      return reply(
        { error: { code: "SESSION_CHANGED", message: "Sesi berubah. Silakan masuk kembali." } },
        401,
      );
    if (path === "/api/auth/logout" || path === "/api/auth/password") {
      data.user = null;
      return reply({ ok: true });
    }
    if (path === "/api/admin/users") return reply({ users: [owner, member], assignableRoles });
    if (path.endsWith("/password")) return reply({ ok: true });
    const id = data.user.id === "owner" ? "own-box" : "member-box";
    if (request.method() !== "GET") {
      data.mutations.push(`${data.user.id} ${request.method()} ${path}`);
      return reply(path === "/api/inboxes" ? { inbox: box("new-box") } : { ok: true });
    }
    if (path === "/api/inboxes") return reply({ inboxes: [box(id)] });
    if (path.endsWith("/messages"))
      return reply({ messages: [{ ...mail(id), isRead: true }], nextCursor: null });
    return reply({ message: { ...mail(id), isRead: true } });
  });
  return data;
}
async function fillSelfPassword(page: Page) {
  await page.locator("#current-password").fill("old-password");
  await page.locator("#new-password").fill(secret);
  await page.locator("#confirm-password").fill(secret);
}
async function privateCleared(page: Page) {
  await expect(page.locator("#message-body")).toBeEmpty();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  for (const id of [
    "password",
    "current-password",
    "new-password",
    "confirm-password",
    "user-password",
    "reset-user-password",
  ])
    await expect(page.locator(`#${id}`)).toHaveValue("");
}

for (const transport of ["broadcast", "storage"])
  test(`auth sync ${transport} clears another tab before resync and discards held A responses after login B`, async ({
    page,
    context,
  }) => {
    if (transport === "storage")
      await context.addInitScript(() => {
        Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined });
      });
    else
      await context.addInitScript(() => {
        // Prove BroadcastChannel independently of the storage transport.
        Object.getPrototypeOf(localStorage).setItem = () => {
          throw new Error("Storage unavailable");
        };
      });
    const data = await sharedAuth(context);
    await page.goto("/");
    const other = await context.newPage();
    await other.goto("/");
    await openBox(other, "own-box");
    await other.locator(".message-item").click();
    await expect(other.locator("#message-body")).toHaveText("Private body own-box");
    const pendingInbox = await heldResponse(other, "**/api/inboxes", { inboxes: [box("stale-A")] });
    await other.locator("#refresh-inboxes").evaluate((button: HTMLButtonElement) => button.click());
    await expect.poll(pendingInbox.started).toBe(true);
    await other.locator("#account-settings").click();
    await fillSelfPassword(other);
    const pendingSession = await heldResponse(other, "**/api/auth/session", {
      user: owner,
      mailDomain: "example.com",
      retentionDays: 7,
    });
    await page.locator("#logout").click();
    await expect(other.locator("#workspace")).toBeHidden();
    await privateCleared(other);
    await expect(other.locator("#inbox-list")).toBeEmpty();
    await expect.poll(pendingSession.started).toBe(true);
    await page.locator("#username").fill("alice");
    await page.locator("#password").fill(secret);
    await page.locator("#login-submit").click();
    await expect(other.locator("#account-name")).toHaveText("alice");
    await expect(other.locator("#inbox-list")).toContainText("member-box");
    await pendingSession.release();
    await pendingInbox.release();
    await expect(other.locator("#account-name")).toHaveText("alice");
    await expect(other.locator("#inbox-list")).not.toContainText("stale-A");
    await expect(other.locator("#manage-users")).toBeHidden();
    expect(data.user?.id).toBe("member-1");
    expect(data.calls.filter((call) => call.path === "/api/auth/session").length).toBeLessThan(10);
    expect(await other.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([
      0, 0,
    ]);
  });

for (const event of ["focus", "visibility"])
  test(`auth sync ${event} revalidates the shared principal without relying on a signal`, async ({
    page,
    context,
  }) => {
    const data = await sharedAuth(context);
    await page.goto("/");
    await openBox(page, "own-box");
    await page.locator(".message-item").click();
    await page.locator("#account-settings").click();
    await fillSelfPassword(page);
    data.user = member;
    await page.evaluate((event) => {
      if (event === "focus") window.dispatchEvent(new Event("focus"));
      else {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      }
    }, event);
    await expect(page.locator("#account-name")).toHaveText("alice");
    await privateCleared(page);
    await expect(page.locator("#inbox-list")).toContainText("member-box");
    expect(
      data.calls
        .filter((call) => call.path === "/api/auth/session")
        .every((call) => call.principal === undefined),
    ).toBe(true);
  });

test("principal header binds a stale view mutation to A and never mutates as shared-cookie B", async ({
  page,
  context,
}) => {
  const data = await sharedAuth(context);
  await page.goto("/");
  await expect(page.locator("#inbox-list")).toContainText("own-box");
  await page.locator("#new-inbox").click();
  await page.locator("#local-part").fill("stale-action");
  // No signal or focus event: the request header is the remaining protection.
  data.user = member;
  await page.locator("#create-submit").click();
  await expect(page.locator("#login")).toBeVisible();
  expect(data.mutations).toEqual([]);
  expect(data.user?.id).toBe("member-1");
  await privateCleared(page);
  expect(data.calls.at(-1)).toEqual({ path: "/api/inboxes", principal: "owner" });
});

test("principal header accompanies private reads admin and logout but not login or session probes", async ({
  page,
}) => {
  const data = await setup(page);
  await page.goto("/");
  await manage(page);
  await createFields(page);
  await page.locator("#user-create-submit").click();
  await expect(page.locator("#user-password")).toHaveValue("");
  await page.getByRole("button", { name: "Reset kata sandi alice", exact: true }).click();
  await page.locator("#reset-user-password").fill(secret);
  await page.locator("#reset-user-submit").click();
  await expect(page.locator("#reset-user-dialog")).toBeHidden();
  await page.getByRole("button", { name: "Lihat inbox alice", exact: true }).click();
  await openBox(page);
  await page.locator(".message-item").click();
  await expect(page.locator("#message-body")).not.toBeEmpty();
  await page.locator("#return-own-inboxes").click();
  await page.locator(".favorite").click();
  await openBox(page, "own-box");
  await page.locator(".message-item").click();
  await expect(page.locator("#toggle-read")).toBeEnabled();
  await page.locator("#account-settings").click();
  await fillSelfPassword(page);
  await page.locator("#password-submit").click();
  await expect(page.locator("#password-error")).toBeVisible();
  await page.locator("#cancel-password").click();
  await page.locator("#logout").click();
  await page.locator("#username").fill("operator");
  await page.locator("#password").fill(secret);
  await page.locator("#login-submit").click();
  await expect(page.locator("#workspace")).toBeVisible();
  for (const call of data.headers)
    expect(call.principal, call.path).toBe(
      ["/api/auth/session", "/api/auth/login"].includes(call.path) ? undefined : "owner",
    );
  expect(data.headers.some((call) => call.path === "/api/auth/logout")).toBe(true);
  expect(data.headers.some((call) => call.path === "/api/auth/password")).toBe(true);
});

for (const status of [200, 401])
  test(`logout completion ${status} preserves password focus while typing`, async ({ page }) => {
    await setup(page);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/auth/logout", async (route) => {
      await held;
      await route.fulfill({
        status,
        json:
          status === 200
            ? { ok: true }
            : { error: { code: "UNAUTHORIZED", message: "Sesi berakhir." } },
      });
    });
    await page.goto("/");
    await expect(page.locator("#account-name")).toHaveText("operator");
    await page.locator("#logout").click();
    await expect(page.locator("#login")).toBeVisible();
    await expect(page.locator("#login-submit")).toBeDisabled();
    await page.locator("#username").fill("operator");
    await page.locator("#password").fill("member-");
    await expect(page.locator("#password")).toBeFocused();

    release();
    // Enabled means the logout finally has completed; no timing sleeps needed.
    await expect(page.locator("#login-submit")).toBeEnabled();
    // Continue typing into the active element, without refocusing the password.
    await page.keyboard.insertText("password-123");
    await expect(page.locator("#username")).toHaveValue("operator");
    await expect(page.locator("#password")).toHaveValue(secret);
    await expect(page.locator("#password")).toBeFocused();
    const login = page.waitForRequest("**/api/auth/login");
    await page.locator("#login-submit").click();
    expect((await login).postDataJSON()).toEqual({ username: "operator", password: secret });
    await expect(page.locator("#workspace")).toBeVisible();
  });

test("credential conflict CREDENTIALS_CHANGED clears private UI while generic 409 remains retryable", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/");
  await openBox(page, "own-box");
  await page.locator(".message-item").click();
  await expect(page.locator("#message-body")).not.toBeEmpty();
  await page.locator("#account-settings").click();
  for (const code of ["CONFLICT", "CREDENTIALS_CHANGED"]) {
    await page.route(
      "**/api/auth/password",
      (route) =>
        route.fulfill({
          status: 409,
          json: { error: { code, message: "Kredensial berubah. Silakan masuk kembali." } },
        }),
      { times: 1 },
    );
    await fillSelfPassword(page);
    await page.locator("#password-submit").click();
    if (code === "CONFLICT") {
      await expect(page.locator("#password-error")).toBeVisible();
      await expect(page.locator("#password-submit")).toBeEnabled();
      await expect(page.locator("#message-body")).not.toBeEmpty();
    }
  }
  await expect(page.locator("#login")).toBeVisible();
  await privateCleared(page);
  await expect(page.locator("#inbox-list")).toBeEmpty();
  await expect(page.locator("#login-error")).toContainText("Kredensial berubah");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#login")).toBeVisible();
});

test("auth sync self password success clears other tab but member reset keeps owner tabs signed in", async ({
  page,
  context,
}) => {
  await sharedAuth(context);
  await page.goto("/");
  const other = await context.newPage();
  await other.goto("/");
  await other.locator("#account-settings").click();
  await fillSelfPassword(other);
  await manage(page);
  await page.getByRole("button", { name: "Reset kata sandi alice", exact: true }).click();
  await page.locator("#reset-user-password").fill(secret);
  await page.locator("#reset-user-submit").click();
  await expect(page.locator("#reset-user-dialog")).toBeHidden();
  await expect(other.locator("#password-dialog")).toBeVisible();
  await expect(other.locator("#current-password")).toHaveValue("old-password");
  await page.locator("#close-users").click();
  await page.locator("#account-settings").click();
  await fillSelfPassword(page);
  await page.locator("#password-submit").click();
  await expect(other.locator("#login")).toBeVisible();
  await privateCleared(other);
});

test("auth sync wrong-current-password session probe detects a different principal instead of retaining A", async ({
  page,
  context,
}) => {
  const data = await sharedAuth(context);
  await page.goto("/");
  await page.locator("#account-settings").click();
  await fillSelfPassword(page);
  await page.route("**/api/auth/password", (route) => {
    data.user = member;
    return route.fulfill({
      status: 401,
      json: { error: { code: "INVALID_CREDENTIALS", message: "Kata sandi saat ini salah." } },
    });
  });
  await page.locator("#password-submit").click();
  await expect(page.locator("#account-name")).toHaveText("alice");
  await privateCleared(page);
});

for (const code of ["SESSION_CHANGED", "CREDENTIALS_CHANGED"])
  test(`terminal logout retry ${code} releases failed-logout lock without revoking B`, async ({
    page,
    context,
  }) => {
    const data = await sharedAuth(context);
    let attempts = 0;
    const principals: Array<string | undefined> = [];
    await page.route("**/api/auth/logout", async (route) => {
      principals.push(route.request().headers()["x-plato-user"]);
      attempts++;
      if (attempts === 1)
        return route.fulfill({
          status: 503,
          json: { error: { code: "UNAVAILABLE", message: "Coba lagi." } },
        });
      if (attempts === 2 && code === "CREDENTIALS_CHANGED")
        return route.fulfill({
          status: 409,
          json: { error: { code, message: "Kredensial berubah. Silakan masuk kembali." } },
        });
      return route.fallback();
    });
    await page.goto("/");
    await expect(page.locator("#account-name")).toHaveText("operator");
    await page.locator("#logout").click();
    await expect(page.locator("#retry-logout")).toBeVisible();
    await expect(page.locator("#login-submit")).toBeDisabled();

    // The cookie/principal changes without a signal while A's logout needs a retry.
    data.user = member;
    await context.addCookies([
      { name: "test-session", value: "B", url: "http://127.0.0.1:8788", httpOnly: true },
    ]);
    await page.locator("#retry-logout").click();
    await expect(page.locator("#login-error")).toContainText("Silakan masuk kembali.");
    await expect(page.locator("#login-submit")).toBeEnabled();
    await expect(page.locator("#retry-logout")).toBeHidden();
    await privateCleared(page);
    expect(principals).toEqual(["owner", "owner"]);
    expect(data.user?.id).toBe("member-1");
    expect((await context.cookies()).find((cookie) => cookie.name === "test-session")?.value).toBe(
      "B",
    );

    // Terminal errors require deliberate login; focus must not silently restore B.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("#login")).toBeVisible();
    await page.locator("#username").fill("alice");
    await page.locator("#password").fill(secret);
    await page.locator("#login-submit").click();
    await expect(page.locator("#account-name")).toHaveText("alice");
    await expect(page.locator("#inbox-list")).toContainText("member-box");
    await page.locator("#logout").click();
    await expect(page.locator("#login-submit")).toBeEnabled();
    expect(principals).toEqual(["owner", "owner", "member-1"]);
  });

for (const code of ["SESSION_CHANGED", "CREDENTIALS_CHANGED", "success"])
  test(`late logout retry ${code} cannot unlock or replace newer B resync`, async ({
    page,
    context,
  }) => {
    const data = await sharedAuth(context);
    let attempts = 0;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/auth/logout", async (route) => {
      expect(route.request().headers()["x-plato-user"]).toBe("owner");
      attempts++;
      if (attempts === 1)
        return route.fulfill({
          status: 503,
          json: { error: { code: "UNAVAILABLE", message: "Coba lagi." } },
        });
      // Capture A's result before B logs in; response delivery is independently delayed.
      if (code === "success") data.user = null;
      await held;
      await route.fulfill({
        status: code === "success" ? 200 : code === "SESSION_CHANGED" ? 401 : 409,
        json: code === "success" ? { ok: true } : { error: { code, message: "Stale A error" } },
      });
    });
    await page.goto("/");
    await expect(page.locator("#account-name")).toHaveText("operator");
    await page.locator("#logout").click();
    await expect(page.locator("#retry-logout")).toBeEnabled();
    await page.locator("#retry-logout").click();
    await expect.poll(() => attempts).toBe(2);

    const pendingSession = await heldResponse(page, "**/api/auth/session", {
      user: member,
      mailDomain: "example.com",
      retentionDays: 7,
    });
    data.user = null;
    const other = await context.newPage();
    await other.goto("/");
    await expect(other.locator("#login-submit")).toBeEnabled();
    await other.locator("#username").fill("alice");
    await other.locator("#password").fill(secret);
    await other.locator("#login-submit").click();
    await expect(other.locator("#account-name")).toHaveText("alice");
    await expect.poll(pendingSession.started).toBe(true);
    await other.locator("#account-settings").click();
    await fillSelfPassword(other);

    const response = page.waitForResponse("**/api/auth/logout");
    release();
    await (await response).finished();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
    // A's finally must not clear the new auth operation's busy flag or emit a signal.
    await expect(page.locator("#login-submit")).toBeDisabled();
    await expect(page.locator("#login-error")).not.toContainText("Stale A error");
    await expect(other.locator("#password-dialog")).toBeVisible();
    await expect(other.locator("#current-password")).toHaveValue("old-password");
    await pendingSession.release();
    await expect(page.locator("#account-name")).toHaveText("alice");
    await expect(page.locator("#inbox-list")).toContainText("member-box");
    await expect(page.locator("#logout")).toBeEnabled();
    await expect(page.locator("#retry-logout")).toBeHidden();
    expect(data.user).toEqual(member);
  });
