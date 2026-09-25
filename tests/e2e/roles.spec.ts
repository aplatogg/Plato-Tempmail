import { expect, type Page, test } from "@playwright/test";

declare const window: { fetch: typeof fetch; dispatchEvent(event: Event): boolean };
interface HTMLButtonElement {
  click(): void;
}
interface HTMLFormElement {
  requestSubmit(): void;
}

const allRoles = ["member", "dev", "admin", "owner"];
const principal = (id: string, roles: string[], username = id) => ({
  id,
  username,
  roles,
  role: roles.includes("owner") ? "owner" : "user",
  createdAt: 1790164800,
});
const root = principal("owner", ["owner"], "operator");
const alice = principal("alice", ["member", "dev"]);
const admin = principal("admin-1", ["admin"], "manager");
const otherOwner = principal("owner-2", ["owner"], "second-owner");
const diagnostics = {
  ok: true,
  application: { name: "Plato-Tempmail", mailDomain: "example.com", retentionDays: 7 },
  database: { ok: true },
  counts: { users: 4, inboxes: 12, messages: 23 },
};

async function setup(page: Page, user = root) {
  const data = {
    user,
    users: [root, alice, admin, otherOwner],
    assignableRoles: user.roles.includes("owner") ? allRoles : ["member", "dev"],
    calls: [] as { path: string; method: string; body: unknown; principal?: string }[],
  };
  // Force epoch checks to protect the UI even when the transport ignores abort.
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => original(input, { ...init, signal: undefined });
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:8788") return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const request = route.request();
    const path = url.pathname;
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() : undefined;
    data.calls.push({ path, method, body, principal: request.headers()["x-plato-user"] });
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (path === "/api/auth/session" || path === "/api/auth/login")
      return reply({ user: data.user, mailDomain: "example.com", retentionDays: 7 });
    if (path === "/api/auth/logout") return reply({ ok: true });
    if (path === "/api/inboxes") return reply({ inboxes: [] });
    if (path === "/api/dev/diagnostics") return reply(diagnostics);
    if (path === "/api/admin/users") {
      if (method === "GET")
        return reply({ users: data.users, assignableRoles: data.assignableRoles });
      const created = principal("created", body.roles, body.username);
      data.users.push(created);
      return reply({ user: created }, 201);
    }
    if (path.endsWith("/roles") && method === "PATCH") {
      const target = data.users.find((item) => item.id === path.split("/")[4]);
      return reply({ user: { ...target, roles: body.roles } });
    }
    if (path.endsWith("/password")) return reply({ ok: true });
    return reply({ error: { code: "NOT_FOUND", message: "Unexpected mocked route" } }, 404);
  });
  return data;
}
async function manage(page: Page) {
  await page.locator("#manage-users").click();
  await expect(page.locator("#users-list")).toContainText("alice");
}
async function createFields(page: Page) {
  await page.locator("#user-username").fill("new-account");
  await page.locator("#user-password").fill("mock-password");
}
async function held(page: Page, path: string, json: unknown, method = "GET") {
  let release = () => {};
  let started = false;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${path}`, async (route) => {
    if (started || route.request().method() !== method) return route.fallback();
    started = true;
    await wait;
    await route.fulfill({ json });
  });
  return {
    started: () => started,
    release: async () => {
      const response = page.waitForResponse(`**${path}`);
      release();
      await (await response).finished();
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
    },
  };
}

test("stored Owner resetting its own password clears both tabs without replaying logout", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  const data = await setup(page, otherOwner);
  await setup(other, otherOwner);
  let revoked = false;
  await other.route("**/api/auth/session", async (route) => {
    if (!revoked) return route.fallback();
    return route.fulfill({
      status: 401,
      json: { error: { code: "UNAUTHENTICATED", message: "Login required" } },
    });
  });
  await page.route("**/api/admin/users/owner-2/password", async (route) => {
    revoked = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await other.goto("/");
  await manage(page);
  await manage(other);
  await page.getByRole("button", { name: "Reset kata sandi second-owner", exact: true }).click();
  await page.locator("#reset-user-password").fill("synthetic-replacement");
  await page.locator("#reset-user-form button[type=submit]").click();
  for (const tab of [page, other]) {
    await expect(tab.locator("#login")).toBeVisible();
    await expect(tab.locator("#users-dialog")).not.toBeVisible();
    await expect(tab.locator("#users-list")).toBeEmpty();
  }
  await expect(page.locator("#login-success")).toContainText("Kata sandi berhasil diubah");
  expect(data.calls.filter((call) => call.path === "/api/auth/logout")).toHaveLength(0);
});

test("creation defaults to Member and sends the canonical roles array", async ({ page }) => {
  const data = await setup(page);
  await page.goto("/");
  await manage(page);
  const roles = page.getByRole("group", { name: "Peran pengguna baru", exact: true });
  await expect(roles.getByRole("checkbox", { name: "Member", exact: true })).toBeChecked();
  await expect(roles.getByRole("checkbox", { checked: true })).toHaveCount(1);
  await createFields(page);
  await page.locator("#user-create-submit").click();
  await expect(page.locator("#user-create-status")).toContainText("berhasil");
  expect(
    data.calls.find((c) => c.method === "POST" && c.path === "/api/admin/users")?.body,
  ).toEqual({
    username: "new-account",
    password: "mock-password",
    roles: ["member"],
  });
});

test("creation supports multiple roles including additional Owner and rejects empty selection", async ({
  page,
}) => {
  const data = await setup(page);
  await page.goto("/");
  await manage(page);
  const roles = page.getByRole("group", { name: "Peran pengguna baru", exact: true });
  await roles.getByLabel("Member", { exact: true }).uncheck();
  await createFields(page);
  await page.locator("#user-create-submit").click();
  await expect(page.locator("#user-create-error")).toContainText("Pilih minimal satu peran");
  expect(data.calls.filter((c) => c.method === "POST")).toEqual([]);
  await roles.getByLabel("Dev", { exact: true }).check();
  await roles.getByLabel("Owner", { exact: true }).check();
  await page.locator("#user-create-submit").click();
  await expect(page.locator("#user-create-status")).toContainText("berhasil");
  const row = page
    .locator("#users-list li")
    .filter({ has: page.getByText("new-account", { exact: true }) });
  await expect(row.locator(".role-badge")).toHaveText(["Dev", "Owner"]);
  expect(data.calls.find((c) => c.method === "POST")?.body).toEqual({
    username: "new-account",
    password: "mock-password",
    roles: ["dev", "owner"],
  });
  await expect(roles.getByLabel("Member", { exact: true })).toBeChecked();
  await expect(roles.getByRole("checkbox", { checked: true })).toHaveCount(1);
});

test("role editing is accessible, validates selection, uses PATCH and renders returned badges", async ({
  page,
}) => {
  const data = await setup(page);
  await page.goto("/");
  await manage(page);
  const edit = page.getByRole("button", { name: "Ubah peran alice", exact: true });
  await edit.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Ubah peran pengguna", exact: true });
  const roles = dialog.getByRole("group", { name: "Peran pengguna", exact: true });
  const member = roles.getByLabel("Member", { exact: true });
  await expect(member).toBeFocused();
  await page.keyboard.press("Space");
  await roles.getByLabel("Dev", { exact: true }).uncheck();
  await page.locator("#role-submit").click();
  await expect(page.locator("#role-error")).toContainText("Pilih minimal satu peran");
  expect(data.calls.filter((c) => c.method === "PATCH")).toEqual([]);
  await roles.getByLabel("Admin", { exact: true }).check();
  await roles.getByLabel("Dev", { exact: true }).check();
  await page.locator("#role-submit").click();
  await expect(dialog).toBeHidden();
  const row = page
    .locator("#users-list li")
    .filter({ has: page.getByText("alice", { exact: true }) });
  await expect(row.locator(".role-badge")).toHaveText(["Dev", "Admin"]);
  expect(data.calls.find((c) => c.method === "PATCH")).toEqual({
    path: "/api/admin/users/alice/roles",
    method: "PATCH",
    body: { roles: ["dev", "admin"] },
    principal: "owner",
  });
  await page.getByRole("button", { name: "Ubah peran alice", exact: true }).click();
  const bounds = await dialog.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(
    page.viewportSize()?.width ?? 0,
  );
  await page.keyboard.press("Escape");
  await expect(edit).toBeFocused();
  await expect(page.locator("#edit-roles input")).toHaveCount(0);
});

test("PATCH accepts the frozen Principal payload without requiring list-only createdAt", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/admin/users/alice/roles", (route) =>
    route.fulfill({
      json: {
        user: { id: "alice", username: "alice", role: "user", roles: ["admin"] },
      },
    }),
  );
  await page.goto("/");
  await manage(page);
  await page.getByRole("button", { name: "Ubah peran alice", exact: true }).click();
  await page.locator("#role-submit").click();
  await expect(page.locator("#role-dialog")).toBeHidden();
  const row = page
    .locator("#users-list li")
    .filter({ has: page.getByText("alice", { exact: true }) });
  await expect(row.locator(".role-badge")).toHaveText(["Admin"]);
  await expect(row).toContainText("Dibuat");
});

test("root identity is protected while an additional Owner is editable and resettable by Owner", async ({
  page,
}) => {
  await setup(page, otherOwner);
  await page.goto("/");
  await manage(page);
  const rootRow = page
    .locator("#users-list li")
    .filter({ has: page.getByText("operator", { exact: true }) });
  await expect(rootRow).toContainText("Owner utama dilindungi");
  await expect(rootRow.getByRole("button", { name: /Ubah peran|Reset kata sandi/ })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Ubah peran second-owner", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reset kata sandi second-owner", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Lihat inbox operator", exact: true }).click();
  await expect(page.locator("#inspection-banner")).toContainText("operator");
  await expect(page.locator("#new-inbox")).toBeHidden();
});

test("Admin can manage Member/Dev only and receives no mailbox inspection controls", async ({
  page,
}) => {
  const data = await setup(page, admin);
  await page.goto("/");
  await manage(page);
  const roles = page.getByRole("group", { name: "Peran pengguna baru", exact: true });
  await expect(roles.getByRole("checkbox")).toHaveCount(2);
  await expect(roles.getByLabel("Member", { exact: true })).toBeChecked();
  await expect(roles.getByLabel("Dev", { exact: true })).toBeVisible();
  for (const name of ["operator", "manager", "second-owner"]) {
    await expect(page.getByRole("button", { name: `Ubah peran ${name}`, exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: `Reset kata sandi ${name}`, exact: true }),
    ).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: /Lihat inbox/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Ubah peran alice", exact: true }).click();
  await expect(page.locator("#edit-roles input")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await createFields(page);
  await roles.getByLabel("Dev", { exact: true }).check();
  await page.locator("#user-create-submit").click();
  await expect(page.locator("#user-create-status")).toContainText("berhasil");
  expect(data.calls.find((c) => c.method === "POST")?.body).toEqual({
    username: "new-account",
    password: "mock-password",
    roles: ["member", "dev"],
  });
});

test("assignableRoles is authoritative and missing choices fail closed", async ({ page }) => {
  const data = await setup(page);
  data.assignableRoles = ["member"];
  await page.goto("/");
  await manage(page);
  await expect(page.locator("#create-roles input")).toHaveCount(1);
  await page.locator("#close-users").click();
  await page.route("**/api/admin/users", (route) => route.fulfill({ json: { users: data.users } }));
  await page.locator("#manage-users").click();
  await expect(page.locator("#users-error")).toBeVisible();
  await expect(page.locator("#user-create-submit")).toBeDisabled();
});

for (const roles of [["member"], ["dev"], ["admin"], ["admin", "dev"], ["owner"]])
  test(`role union ${roles.join("+")} exposes only permitted panels`, async ({ page }) => {
    const data = await setup(page, principal("actor", roles));
    await page.goto("/");
    await expect(page.locator("#workspace")).toBeVisible();
    const canAdmin = roles.includes("admin") || roles.includes("owner");
    const canDev = roles.includes("dev") || roles.includes("owner");
    await expect(page.locator("#manage-users")).toBeVisible({ visible: canAdmin });
    await expect(page.locator("#open-diagnostics")).toBeVisible({ visible: canDev });
    await expect(page.locator("#new-inbox")).toBeVisible();
    await page.locator("#open-diagnostics").evaluate((button: HTMLButtonElement) => button.click());
    if (canDev) {
      await expect(page.locator("#diagnostics-data")).toContainText("Plato-Tempmail");
      await expect(page.locator("#diagnostics-data")).toContainText("23");
      expect(data.calls.find((c) => c.path === "/api/dev/diagnostics")?.principal).toBe("actor");
    } else {
      await expect(page.locator("#diagnostics-dialog")).toBeHidden();
      expect(data.calls.some((c) => c.path.includes("/dev/"))).toBe(false);
    }
  });

test("diagnostics renders only contract fields as text and sanitizes errors with retry", async ({
  page,
}) => {
  await setup(page, principal("developer", ["dev"]));
  await page.route("**/api/dev/diagnostics", (route) =>
    route.fulfill({
      json: {
        ...diagnostics,
        application: { ...diagnostics.application, name: "<img src=x onerror=alert(1)>" },
        body: "PRIVATE EMAIL BODY",
        token: "SECRET TOKEN",
        logs: "PRIVATE LOG",
      },
    }),
  );
  await page.goto("/");
  await page.locator("#open-diagnostics").click();
  await expect(page.locator("#diagnostics-data")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator("#diagnostics-data img")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("PRIVATE EMAIL BODY");
  await expect(page.locator("body")).not.toContainText("SECRET TOKEN");
  await expect(page.locator("body")).not.toContainText("PRIVATE LOG");
  await page.route(
    "**/api/dev/diagnostics",
    (route) => route.fulfill({ status: 503, json: { error: { message: "RAW STACK SECRET" } } }),
    { times: 1 },
  );
  await page.locator("#refresh-diagnostics").click();
  await expect(page.locator("#diagnostics-error")).toBeVisible();
  await expect(page.locator("#diagnostics-data")).toBeEmpty();
  await expect(page.locator("body")).not.toContainText("RAW STACK SECRET");
  await page.locator("#refresh-diagnostics").click();
  await expect(page.locator("#diagnostics-data")).toContainText("23");
  await page.keyboard.press("Escape");
  await expect(page.locator("#open-diagnostics")).toBeFocused();
  await expect(page.locator("#diagnostics-data")).toBeEmpty();
});

for (const legacy of ["owner", "user"])
  test(`legacy ${legacy} fallback only applies when roles is absent`, async ({ page }) => {
    const data = await setup(page, principal("legacy", ["member"]));
    Object.assign(data.user, { roles: undefined, role: legacy });
    await page.goto("/");
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#manage-users")).toBeVisible({ visible: legacy === "owner" });
    await expect(page.locator("#open-diagnostics")).toBeVisible({ visible: legacy === "owner" });
    Object.assign(data.user, { roles: ["member"], role: "owner" });
    await page.reload();
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#manage-users")).toBeHidden();
    await expect(page.locator("#open-diagnostics")).toBeHidden();
  });

test("successful own role change clears all private state and requires deliberate login", async ({
  page,
}) => {
  const data = await setup(page, otherOwner);
  await page.goto("/");
  await manage(page);
  await page.getByRole("button", { name: "Ubah peran second-owner", exact: true }).click();
  await page.locator("#edit-roles").getByLabel("Owner", { exact: true }).uncheck();
  await page.locator("#edit-roles").getByLabel("Dev", { exact: true }).check();
  await page.locator("#role-submit").click();
  await expect(page.locator("#login")).toBeVisible();
  await expect(page.locator("#login-success")).toContainText("Peran");
  await expect(page.locator("#users-list")).toBeEmpty();
  await expect(page.locator("#edit-roles input")).toHaveCount(0);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#login")).toBeVisible();
  expect(data.calls.filter((c) => c.path === "/api/auth/session")).toHaveLength(1);
});

test("session revalidation of changed roles logs out even when legacy role is unchanged", async ({
  page,
}) => {
  const data = await setup(page, principal("actor", ["admin", "dev"]));
  await page.goto("/");
  await manage(page);
  data.user = principal("actor", ["member"]);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#login")).toBeVisible();
  await expect(page.locator("#users-list")).toBeEmpty();
  await expect(page.locator("#open-diagnostics")).toBeHidden();
});

for (const code of ["FORBIDDEN", "SESSION_CHANGED", "CREDENTIALS_CHANGED"])
  test(`role update ${code} keeps retryable failures separate from terminal session errors`, async ({
    page,
  }) => {
    await setup(page);
    await page.route("**/api/admin/users/alice/roles", (route) =>
      route.fulfill({
        status: code === "FORBIDDEN" ? 403 : code === "SESSION_CHANGED" ? 401 : 409,
        json: { error: { code, message: "Peran berubah. Silakan masuk kembali." } },
      }),
    );
    await page.goto("/");
    await manage(page);
    await page.getByRole("button", { name: "Ubah peran alice", exact: true }).click();
    await page.locator("#role-submit").click();
    if (code === "FORBIDDEN") {
      await expect(page.locator("#role-error")).toBeVisible();
      await expect(page.locator("#role-submit")).toBeEnabled();
      await expect(page.locator("#workspace")).toBeVisible();
    } else {
      await expect(page.locator("#login")).toBeVisible();
      await expect(page.locator("#users-list")).toBeEmpty();
      await expect(page.locator("#edit-roles input")).toHaveCount(0);
    }
  });

for (const kind of ["diagnostics", "roles", "users"])
  for (const destination of ["logout", "switch"])
    test(`late ${kind} cannot restore private data after ${destination}`, async ({ page }) => {
      const data = await setup(page);
      await page.goto("/");
      if (kind === "roles") await manage(page);
      const path =
        kind === "diagnostics"
          ? "/api/dev/diagnostics"
          : kind === "roles"
            ? "/api/admin/users/alice/roles"
            : "/api/admin/users";
      const pending = await held(
        page,
        path,
        kind === "diagnostics"
          ? {
              ...diagnostics,
              application: { ...diagnostics.application, name: "STALE PRIVATE" },
            }
          : kind === "roles"
            ? { user: { ...alice, username: "STALE PRIVATE" } }
            : {
                users: [{ ...alice, username: "STALE PRIVATE" }],
                assignableRoles: allRoles,
              },
        kind === "roles" ? "PATCH" : "GET",
      );
      if (kind === "diagnostics") await page.locator("#open-diagnostics").click();
      else if (kind === "users") await page.locator("#manage-users").click();
      else {
        await page.getByRole("button", { name: "Ubah peran alice", exact: true }).click();
        await page.locator("#role-submit").click();
        await page.locator("#role-form").evaluate((form: HTMLFormElement) => form.requestSubmit());
      }
      await expect.poll(pending.started).toBe(true);
      if (destination === "logout") {
        await page.locator("#logout").evaluate((button: HTMLButtonElement) => button.click());
        await expect(page.locator("#login")).toBeVisible();
      } else {
        data.user = principal("member-b", ["member"]);
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(page.locator("#account-name")).toHaveText("member-b");
      }
      await pending.release();
      await expect(page.locator("#diagnostics-data")).toBeEmpty();
      await expect(page.locator("#users-list")).toBeEmpty();
      await expect(page.locator("#edit-roles input")).toHaveCount(0);
      await expect(page.locator("#create-roles input")).toHaveCount(0);
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("STALE PRIVATE");
    });
