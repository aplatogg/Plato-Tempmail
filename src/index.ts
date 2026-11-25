import { Hono } from "hono";
import { adminRoutes, auditLog } from "./admin";
import { v1Routes } from "./api";
import { apiKeyRoutes } from "./apikeys";
import { cleanupAudit } from "./audit";
import {
  changePassword,
  cleanupAuth,
  listSessions,
  login,
  logout,
  readAuthConfig,
  requireSession,
  revokeOtherSessions,
  revokeSession,
  session,
} from "./auth";
import { diagnostics } from "./diagnostics";
import { cleanupMessages, receiveEmail } from "./email";
import { inboxRoutes, messageRoutes } from "./mailboxes";
import { pushRoutes } from "./push";
import { cleanupResets, forgotPassword, resetPassword } from "./resets";
import { canDeleteUsers, canManageUsers, canViewDiagnostics } from "./roles";
import { ApiError, checkOrigin, readConfig, secureResponse } from "./security";
import type { AppBindings, Env } from "./types";

const app = new Hono<AppBindings>();

app.use("/api/*", async (c, next) => {
  const config = readConfig(c.env);
  // A request carrying an API key is never cookie authenticated, so it is not
  // CSRF-prone and must be callable by bots that send no Origin header. /api/v1 is
  // key-only; the other paths keep the check when they arrive with a cookie.
  const keyed =
    /^Bearer\s/i.test(c.req.header("authorization") ?? "") || Boolean(c.req.header("x-api-key"));
  if (!keyed) checkOrigin(c.req.raw, config);
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
app.get("/api/auth/sessions", async (c) => {
  await requireSession(c);
  return listSessions(c);
});
app.delete("/api/auth/sessions/others", async (c) => {
  await requireSession(c);
  return revokeOtherSessions(c);
});
app.delete("/api/auth/sessions/:id", async (c) => {
  await requireSession(c);
  return revokeSession(c);
});
app.post("/api/auth/forgot", forgotPassword);
app.post("/api/auth/reset", resetPassword);

app.use("/api/admin/users/*", async (c, next) => {
  c.set("auth", await readAuthConfig(c.env, c.get("config")));
  await requireSession(c);
  const user = c.get("user");
  const method = c.req.method;
  // Dev may read the directory and delete an account, but nothing else here.
  const devDelete = canDeleteUsers(user) && (method === "GET" || method === "DELETE");
  if (!canManageUsers(user) && !devDelete)
    throw new ApiError(403, "FORBIDDEN", "Cosmos, Celestial, or Astral access is required.");
  await next();
});
app.route("/api/admin/users", adminRoutes);
app.get("/api/admin/audit", async (c) => {
  c.set("auth", await readAuthConfig(c.env, c.get("config")));
  await requireSession(c);
  return auditLog(c);
});

app.get("/api/dev/diagnostics", async (c) => {
  c.set("auth", await readAuthConfig(c.env, c.get("config")));
  await requireSession(c);
  if (!canViewDiagnostics(c.get("user")))
    throw new ApiError(403, "FORBIDDEN", "Astral or Celestial access is required.");
  return diagnostics(c);
});

app.route("/api/inboxes", inboxRoutes);
app.route("/api/messages", messageRoutes);
app.route("/api/keys", apiKeyRoutes);
app.route("/api/v1", v1Routes);
app.route("/api/push", pushRoutes);

const STATIC_PATHS = new Set([
  "/",
  "/index.html",
  "/app.js",
  "/styles.css",
  "/manifest.webmanifest",
  "/sw.js",
  "/favicon.png",
  "/favicon.svg",
  "/logo-mark.png",
]);

app.get("*", async (c) => {
  const path = c.req.path;
  if (
    (STATIC_PATHS.has(path) || path.startsWith("/fonts/") || path.startsWith("/icons/")) &&
    c.env.ASSETS
  ) {
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
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await receiveEmail(message, env, ctx);
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await cleanupAuth(env);
    await cleanupMessages(env);
    await cleanupResets(env);
    await cleanupAudit(env);
  },
} satisfies ExportedHandler<Env>;
