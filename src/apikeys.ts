import { Hono, type Context, type MiddlewareHandler } from "hono";
import { memberAuth, readAuthConfig, requireSession, type MemberRow } from "./auth";
import { canUseApiKey, principal } from "./roles";
import { ApiError, hex, readJson, sha256 } from "./security";
import type { AppBindings, AuthConfig, Principal } from "./types";

const now = () => Math.floor(Date.now() / 1000);
const MAX_KEYS = 20;
const TOKEN_SHAPE = /^hvk_[a-f0-9]{12}_[a-f0-9]{48}$/;

type KeyRow = {
  id: string;
  user_id: string;
  credential_version: string;
  last_used_at: number | null;
};

export function generateApiKey(): { token: string; prefix: string } {
  const prefix = hex(crypto.getRandomValues(new Uint8Array(6)));
  const body = hex(crypto.getRandomValues(new Uint8Array(24)));
  return { token: `hvk_${prefix}_${body}`, prefix };
}

function presentedToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header !== null) {
    const match = /^Bearer\s+(\S{10,200})$/.exec(header.trim());
    return match && TOKEN_SHAPE.test(match[1]) ? match[1] : null;
  }
  const direct = (request.headers.get("x-api-key") ?? "").trim();
  return TOKEN_SHAPE.test(direct) ? direct : null;
}

/**
 * Authenticates a request from an API key and fills the context the same way a
 * session does (user, auth, apiKey, sessionHash). Returns false when the request
 * carries no key-shaped credential, so callers can fall back to session auth.
 * Throws when a key is presented but is not usable.
 */
export async function authenticateApiKey(c: Context<AppBindings>): Promise<boolean> {
  const token = presentedToken(c.req.raw);
  if (!token) return false;
  const config = c.get("config");
  const ownerAuth = await readAuthConfig(c.env, config);
  const tokenHash = await sha256(token);
  const row = await c.env.DB.prepare(`SELECT id, user_id, credential_version, last_used_at
    FROM api_keys
    WHERE token_hash = ? AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > unixepoch())`)
    .bind(tokenHash)
    .first<KeyRow>();
  if (!row) throw new ApiError(401, "KEY_INVALID", "API key is invalid, revoked or expired.");

  let user: Principal;
  let auth: AuthConfig;
  if (row.user_id === "owner") {
    if (row.credential_version !== ownerAuth.credentialVersion) {
      throw new ApiError(401, "KEY_STALE", "This key predates a credential change. Create a new one.");
    }
    user = principal("owner", config.username, 8);
    auth = ownerAuth;
  } else {
    const member = await c.env.DB.prepare(
      "SELECT id, username, password_verifier, revision, role_mask FROM users WHERE id = ?",
    )
      .bind(row.user_id)
      .first<MemberRow>();
    const memberConfig = member ? await memberAuth(member, ownerAuth, config) : null;
    if (!member || !memberConfig) {
      throw new ApiError(401, "KEY_STALE", "The account this key belongs to no longer exists.");
    }
    if (memberConfig.credentialVersion !== row.credential_version) {
      throw new ApiError(401, "KEY_STALE", "This key predates a credential change. Create a new one.");
    }
    user = principal(member.id, member.username, member.role_mask);
    auth = memberConfig;
  }

// Voyager and Quark cannot hold keys, even if a key row survives a downgrade.
  if (!canUseApiKey(user)) {
    throw new ApiError(403, "API_KEY_FORBIDDEN", "Peran Voyager dan Quark tidak dapat memakai kunci API.");
  }

  c.set("user", user);
  c.set("auth", auth);
  c.set("apiKey", tokenHash);
  c.set("sessionHash", tokenHash);

  // Usage stamp, at most one write per hour per key so polling stays read-mostly.
  if (row.last_used_at === null || row.last_used_at < now() - 3600) {
    await c.env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(now(), row.id)
      .run();
  }
  return true;
}

export const requireApiKey: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!(await authenticateApiKey(c))) {
    throw new ApiError(401, "UNAUTHENTICATED", "Send Authorization: Bearer <api key>.");
  }
  await next();
};

// Key management is session-authenticated: a key cannot mint another key.
export const apiKeyRoutes = new Hono<AppBindings>();
apiKeyRoutes.use("*", async (c, next) => {
  c.set("auth", await readAuthConfig(c.env, c.get("config")));
  await requireSession(c);
  await next();
});

apiKeyRoutes.get("/", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT id, name, prefix, created_at, last_used_at, revoked_at
    FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`)
    .bind(c.get("user").id)
    .all<{ id: string; name: string; prefix: string; created_at: number; last_used_at: number | null; revoked_at: number | null }>();
  return c.json({ keys: rows.results ?? [] });
});

apiKeyRoutes.post("/", async (c) => {
  const body = await readJson(c.req.raw);
  if (Object.keys(body).some((key) => key !== "name") || typeof body.name !== "string") {
    throw new ApiError(400, "INVALID_INPUT", "body must be {\"name\": \"...\"}.");
  }
  const name = body.name.trim().slice(0, 60);
  if (!name) throw new ApiError(400, "INVALID_INPUT", "A key needs a name.");
  if (!canUseApiKey(c.get("user"))) {
    throw new ApiError(403, "API_KEY_FORBIDDEN", "Peran Voyager dan Quark tidak dapat membuat kunci API. Hubungi Celestial untuk upgrade.");
  }
  const userId = c.get("user").id;
  const active = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL",
  )
    .bind(userId)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_KEYS) {
    throw new ApiError(409, "KEY_LIMIT", `At most ${MAX_KEYS} active keys per account.`);
  }
  const { token, prefix } = generateApiKey();
  const id = crypto.randomUUID();
  const createdAt = now();
  await c.env.DB.prepare(`INSERT INTO api_keys
    (id, user_id, name, prefix, token_hash, credential_version, created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .bind(id, userId, name, prefix, await sha256(token), c.get("auth").credentialVersion, createdAt)
    .run();
  // The secret is returned once; only its hash is stored.
  return c.json({ id, name, prefix, token, createdAt }, 201);
});

apiKeyRoutes.delete("/:id", async (c) => {
  const result = await c.env.DB.prepare(
    "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
  )
    .bind(now(), c.req.param("id"), c.get("user").id)
    .run();
  if (!result.meta.changes) throw new ApiError(404, "NOT_FOUND", "Key not found.");
  return c.json({ ok: true });
});