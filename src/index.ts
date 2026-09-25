import { Hono } from "hono";
import { adminRoutes } from "./admin";
import {
  changePassword,
  cleanupAuth,
  login,
  logout,
  readAuthConfig,
  requireSession,
  session,
} from "./auth";
import { diagnostics } from "./diagnostics";
import { cleanupMessages, receiveEmail } from "./email";
import { inboxRoutes, messageRoutes } from "./mailboxes";
import { canManageUsers, canViewDiagnostics } from "./roles";
import { ApiError, checkOrigin, readConfig, secureResponse } from "./security";
import type { AppBindings, Env } from "./types";

const app = new Hono<AppBindings>();

app.use("/api/*", async (c, next) => {
  const config = readConfig(c.env);
  checkOrigin(c.req.raw, config);
  c.set("config", config);
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

app.use("/api/auth/*", async (c, next) => {
  c.set("auth", await readAuthConfig(c.env, c.get("config")));
  await next();
});
app.post("/api/auth/login", login);
app.get("/api/auth/session", async (c) => {
  await requireSession(c);
  return session(c);
});
app.post("/api/auth/logout", async (c) => {
  await requireSession(c);
  return logout(c);
});
app.post("/api/auth/password", async (c) => {
  await requireSession(c);
  return changePassword(c);
});

app.use("/api/admin/users/*", async (c, next) => {
  c.set("auth", await readAuthConfig(c.env, c.get("config")));
  await requireSession(c);
  if (!canManageUsers(c.get("user")))
    throw new ApiError(403, "FORBIDDEN", "Admin or Owner access is required.");
  await next();
});
app.route("/api/admin/users", adminRoutes);

app.get("/api/dev/diagnostics", async (c) => {
  c.set("auth", await readAuthConfig(c.env, c.get("config")));
  await requireSession(c);
  if (!canViewDiagnostics(c.get("user")))
    throw new ApiError(403, "FORBIDDEN", "Dev or Owner access is required.");
  return diagnostics(c);
});

app.route("/api/inboxes", inboxRoutes);
app.route("/api/messages", messageRoutes);

app.get("*", async (c) => {
  if (["/", "/index.html", "/app.js", "/styles.css"].includes(c.req.path) && c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.notFound();
});

app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404));
app.onError((error, c) => {
  if (error instanceof ApiError) {
    for (const [name, value] of Object.entries(error.headers ?? {})) c.header(name, value);
    return c.json({ error: { code: error.code, message: error.message } }, error.status);
  }
  // Do not print thrown messages: database/parser errors can contain private content.
  console.error(JSON.stringify({ event: "request_failed", requestId: crypto.randomUUID() }));
  return c.json({ error: { code: "INTERNAL_ERROR", message: "An internal error occurred." } }, 500);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return secureResponse(await app.fetch(request, env, ctx), request);
  },
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    await receiveEmail(message, env);
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await cleanupAuth(env);
    await cleanupMessages(env);
  },
} satisfies ExportedHandler<Env>;
