import type { Context } from "hono";
import { principal, validRoleMask } from "./roles";
import { ApiError, configurationError, hex, readJson, sha256 } from "./security";
import type { AppBindings, AppConfig, AuthConfig, Env, Principal } from "./types";

const SESSION_SECONDS = 86_400;
const RATE_SECONDS = 900;
const ITERATIONS = 100_000;

function parseVerifier(verifier: unknown) {
  // Strict fixed parameters also prevent a malformed secret causing unbounded KDF work.
  const match =
    typeof verifier === "string" &&
    /^pbkdf2-sha256\$100000\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(verifier);
  if (!match) return configurationError();
  const decode = (value: string) =>
    Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
  return {
    salt: decode(match[1]),
    digest: decode(match[2]),
  };
}

export async function readAuthConfig(env: Env, config: AppConfig): Promise<AuthConfig> {
  // A persisted password is never a fallback for missing/invalid deployment secrets.
  parseVerifier(env.AUTH_PASSWORD_HASH);
  const bootstrap = env.AUTH_PASSWORD_HASH as string;
  const bootstrapFingerprint = await sha256(bootstrap);
  const row = await env.DB.prepare(
    "SELECT bootstrap_fingerprint, password_verifier, revision FROM app_credentials WHERE singleton = 1",
  ).first<{ bootstrap_fingerprint: string; password_verifier: string; revision: number }>();
  const revision = row?.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || (row && revision === 0)) {
    return configurationError();
  }
  const verifier =
    row?.bootstrap_fingerprint === bootstrapFingerprint ? row.password_verifier : bootstrap;
  return {
    verifier,
    ...parseVerifier(verifier),
    bootstrapFingerprint,
    revision,
    roleMask: 8,
    // Keep pre-migration sessions valid until credentials actually change.
    credentialVersion: await sha256(
      JSON.stringify(
        revision === 0
          ? [config.origin, config.username, verifier]
          : [config.origin, config.username, bootstrapFingerprint, verifier, revision],
      ),
    ),
  };
}

async function derivePassword(password: string, salt: Uint8Array<ArrayBuffer>) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    material,
    256,
  );
}

export function credentialConflict(): never {
  throw new ApiError(409, "CREDENTIALS_CHANGED", "Credentials changed. Log in again.");
}

function cookieName(config: AppConfig): string {
  return config.secure ? "__Host-plato_session" : "plato_session";
}

function getToken(request: Request, config: AppConfig): string | null {
  const name = `${cookieName(config)}=`;
  const parts = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name));
  if (parts.length !== 1) return null;
  const token = parts[0].slice(name.length);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

function cookie(config: AppConfig, token: string, maxAge: number): string {
  return `${cookieName(config)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secure ? "; Secure" : ""}`;
}

function publicSession(config: AppConfig, user: Principal) {
  return {
    user,
    mailDomain: config.mailDomain,
    retentionDays: config.retentionDays,
  };
}

interface MemberRow {
  id: string;
  username: string;
  password_verifier: string;
  revision: number;
  role_mask: number;
}

async function memberAuth(
  row: MemberRow,
  ownerAuth: AuthConfig,
  config: AppConfig,
): Promise<AuthConfig | null> {
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.id) ||
    !/^[a-z0-9][a-z0-9_-]{2,31}$/.test(row.username) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !validRoleMask(row.role_mask)
  )
    return null;
  let parsed: ReturnType<typeof parseVerifier>;
  try {
    parsed = parseVerifier(row.password_verifier);
  } catch {
    return null;
  }
  return {
    ...parsed,
    verifier: row.password_verifier,
    revision: row.revision,
    roleMask: row.role_mask,
    bootstrapFingerprint: ownerAuth.bootstrapFingerprint,
    credentialVersion: await sha256(
      JSON.stringify([
        "plato:member-session:v2",
        row.id,
        row.role_mask,
        row.revision,
        row.password_verifier,
        ownerAuth.bootstrapFingerprint,
        config.origin,
      ]),
    ),
  };
}

export function validNewPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 5 && value.length <= 1024 && !!value.trim();
}

export async function passwordVerifier(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await derivePassword(password, salt);
  return `pbkdf2-sha256$${ITERATIONS}$${hex(salt)}$${hex(new Uint8Array(digest))}`;
}

// Internal SQL fragments contain no request data. All values stay bound parameters.
// Reuse this predicate inside mutations, not just in middleware, to close logout/reset races.
export function freshSession(c: Context<AppBindings>) {
  const auth = c.get("auth");
  const user = c.get("user");
  const owner = user.id === "owner";
  return {
    sql: `EXISTS (SELECT 1 FROM sessions s LEFT JOIN session_users su ON su.token_hash = s.token_hash
      WHERE s.token_hash = ? AND s.credential_version = ? AND s.expires_at > unixepoch()
      AND ${owner ? "(su.user_id = 'owner' OR su.token_hash IS NULL)" : "su.user_id = ?"})
      AND ${
        owner
          ? "COALESCE((SELECT revision FROM app_credentials WHERE singleton = 1), 0) = ?"
          : "EXISTS (SELECT 1 FROM users WHERE id = ? AND revision = ? AND password_verifier = ? AND role_mask = ?)"
      }`,
    values: owner
      ? [c.get("sessionHash"), auth.credentialVersion, auth.revision]
      : [
          c.get("sessionHash"),
          auth.credentialVersion,
          user.id,
          user.id,
          auth.revision,
          auth.verifier,
          auth.roleMask,
        ],
  };
}

async function consumeBucket(
  db: D1Database,
  key: string,
  limit: number,
  now: number,
  purpose: "login" | "password" = "login",
): Promise<void> {
  // Reserve an attempt with a single atomic write; SELECT-then-UPDATE races on parallel requests.
  const accepted = await db
    .prepare(`
    INSERT INTO rate_limits (key, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END,
      expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
    WHERE expires_at <= ? OR attempts < ?
    RETURNING attempts
  `)
    .bind(key, now + RATE_SECONDS, now, now, now, limit)
    .first();
  if (!accepted) {
    const expires = await db
      .prepare("SELECT expires_at FROM rate_limits WHERE key = ?")
      .bind(key)
      .first<number>("expires_at");
    const retryAfter = Math.max(1, Math.min(RATE_SECONDS, (expires ?? now + RATE_SECONDS) - now));
    throw new ApiError(
      429,
      "RATE_LIMITED",
      `Too many ${purpose === "login" ? "login" : "password change"} attempts. Try again later.`,
      {
        "Retry-After": String(retryAfter),
      },
    );
  }
}

async function throttle(
  c: Context<AppBindings>,
  now: number,
  purpose: "login" | "password" = "login",
): Promise<void> {
  // Only the Cloudflare edge header is used; X-Forwarded-For is never trusted.
  const client = c.req.header("cf-connecting-ip") ?? "unknown";
  const anchor = purpose === "login" ? c.get("auth").verifier : c.get("auth").bootstrapFingerprint;
  const key = `${purpose}:ip:${await sha256(`${anchor}\0${client}`)}`;
  await consumeBucket(c.env.DB, key, 5, now, purpose);
  // An already-blocked IP cannot consume the global budget repeatedly.
  await consumeBucket(c.env.DB, `${purpose}:global`, 100, now, purpose);
}

export async function login(c: Context<AppBindings>): Promise<Response> {
  // Allow JSON's six-byte escapes for all 1024 password and 64 username code units.
  const body = await readJson(c.req.raw, 8192);
  if (
    Object.keys(body).some((key) => key !== "username" && key !== "password") ||
    typeof body.username !== "string" ||
    body.username.length < 1 ||
    body.username.length > 64 ||
    typeof body.password !== "string" ||
    body.password.length < 1 ||
    body.password.length > 1024
  ) {
    throw new ApiError(
      400,
      "INVALID_INPUT",
      "Provide a username and password within the allowed lengths.",
    );
  }
  const now = Math.floor(Date.now() / 1000);
  await throttle(c, now);
  const config = c.get("config");
  const ownerAuth = c.get("auth");
  // Preserve the legacy owner's exact-case match. Never resolve its reserved spelling as a member.
  const isOwner = body.username === config.username;
  const row =
    !isOwner && body.username.toLowerCase() !== config.username.toLowerCase()
      ? await c.env.DB.prepare(
          "SELECT id, username, password_verifier, revision, role_mask FROM users WHERE username = ? COLLATE NOCASE",
        )
          .bind(body.username)
          .first<MemberRow>()
      : null;
  const resolved = row ? await memberAuth(row, ownerAuth, config) : null;
  const auth = isOwner ? ownerAuth : (resolved ?? ownerAuth);
  const candidate = await derivePassword(body.password, auth.salt);
  // Workers provides a native constant-time byte comparison. Always derive, even for wrong usernames.
  const passwordMatches = crypto.subtle.timingSafeEqual(candidate, auth.digest);
  if (!passwordMatches || (!isOwner && !resolved)) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Username or password is incorrect.");
  }
  const user: Principal =
    row && resolved
      ? principal(row.id, row.username, row.role_mask)
      : principal("owner", config.username, 8);

  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256(token);
  const previous = getToken(c.req.raw, config);
  const statements = [c.env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now)];
  const condition = isOwner
    ? "COALESCE((SELECT revision FROM app_credentials WHERE singleton = 1), 0) = ?"
    : "EXISTS (SELECT 1 FROM users WHERE id = ? AND revision = ? AND password_verifier = ? AND role_mask = ?)";
  const values = isOwner ? [auth.revision] : [user.id, auth.revision, auth.verifier, auth.roleMask];
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO sessions (token_hash, credential_version, created_at, expires_at)
       SELECT ?, ?, ?, ?
        WHERE ${condition}
       RETURNING token_hash`,
    ).bind(tokenHash, auth.credentialVersion, now, now + SESSION_SECONDS, ...values),
    c.env.DB.prepare(`INSERT INTO session_users (token_hash, user_id)
      SELECT token_hash, ? FROM sessions WHERE token_hash = ? RETURNING token_hash`).bind(
      user.id,
      tokenHash,
    ),
  );
  const mappingResultIndex = statements.length - 1;
  // A CAS miss is a successful zero-row transaction, not a rollback. Replace the
  // previous account's session only after the new session AND mapping exist.
  if (previous)
    statements.push(
      c.env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ? AND EXISTS (
        SELECT 1 FROM sessions s JOIN session_users su ON su.token_hash = s.token_hash
        WHERE s.token_hash = ? AND su.user_id = ? AND s.credential_version = ?
      )`).bind(await sha256(previous), tokenHash, user.id, auth.credentialVersion),
    );
  const results = await c.env.DB.batch(statements);
  if (!results[mappingResultIndex]?.results.length) credentialConflict();
  // Issue the cookie only after the D1 transaction commits; no client token can outlive a failed write.
  c.header("Set-Cookie", cookie(config, token, SESSION_SECONDS));
  return c.json(publicSession(config, user));
}

export async function requireSession(c: Context<AppBindings>): Promise<void> {
  const token = getToken(c.req.raw, c.get("config"));
  if (!token) throw new ApiError(401, "UNAUTHENTICATED", "Login is required.");
  const tokenHash = await sha256(token);
  const session = await c.env.DB.prepare(`SELECT s.credential_version, su.user_id
    FROM sessions s LEFT JOIN session_users su ON su.token_hash = s.token_hash
    WHERE s.token_hash = ? AND s.expires_at > unixepoch()`)
    .bind(tokenHash)
    .first<{ credential_version: string; user_id: string | null }>();
  const unauthenticated = () => {
    throw new ApiError(401, "UNAUTHENTICATED", "Login is required.");
  };
  if (!session) return unauthenticated();
  const config = c.get("config");
  if (session.user_id === null || session.user_id === "owner") {
    if (session.credential_version !== c.get("auth").credentialVersion) return unauthenticated();
    c.set("user", principal("owner", config.username, 8));
  } else {
    const row = await c.env.DB.prepare(
      "SELECT id, username, password_verifier, revision, role_mask FROM users WHERE id = ?",
    )
      .bind(session.user_id)
      .first<MemberRow>();
    const auth = row ? await memberAuth(row, c.get("auth"), config) : null;
    if (!row || !auth || auth.credentialVersion !== session.credential_version)
      return unauthenticated();
    c.set("auth", auth);
    c.set("user", principal(row.id, row.username, row.role_mask));
  }
  c.set("sessionHash", tokenHash);
  const fresh = freshSession(c);
  if (
    !(await c.env.DB.prepare(`SELECT 1 WHERE ${fresh.sql}`)
      .bind(...fresh.values)
      .first())
  )
    return unauthenticated();
  const expectedUser = c.req.header("X-Plato-User");
  if (expectedUser !== undefined && expectedUser !== c.get("user").id) {
    // Another tab may have switched accounts. Reject the stale request without
    // revoking or clearing the newly authenticated account's cookie.
    throw new ApiError(401, "SESSION_CHANGED", "Session changed. Reload and try again.");
  }
}

export function session(c: Context<AppBindings>): Response {
  return c.json(publicSession(c.get("config"), c.get("user")));
}

export async function logout(c: Context<AppBindings>): Promise<Response> {
  await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(c.get("sessionHash"))
    .run();
  // A late response must not expire another tab's newer login cookie.
  // Server revocation makes this token unusable until login replaces it or it expires.
  return c.json({ ok: true });
}

export async function changePassword(c: Context<AppBindings>): Promise<Response> {
  // Two maximally JSON-escaped 1024-code-unit passwords require over 12 KiB.
  const body = await readJson(c.req.raw, 16_384);
  if (
    Object.keys(body).some((key) => key !== "currentPassword" && key !== "newPassword") ||
    typeof body.currentPassword !== "string" ||
    body.currentPassword.length < 1 ||
    body.currentPassword.length > 1024 ||
    !validNewPassword(body.newPassword) ||
    body.newPassword === body.currentPassword
  ) {
    throw new ApiError(
      400,
      "INVALID_INPUT",
      "Provide the current password and a different, nonblank new password of 5–1024 characters.",
    );
  }
  await throttle(c, Math.floor(Date.now() / 1000), "password");
  const auth = c.get("auth");
  const candidate = await derivePassword(body.currentPassword, auth.salt);
  if (!crypto.subtle.timingSafeEqual(candidate, auth.digest)) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Current password is incorrect.");
  }
  const verifier = await passwordVerifier(body.newPassword);
  if (!Number.isSafeInteger(auth.revision + 1)) return configurationError();
  const fresh = freshSession(c);
  // The SELECT is both a CAS and a fresh authorization check at the write boundary.
  // Migration triggers revoke only this principal's sessions in the same transaction.
  const [result] = await c.env.DB.batch([
    c.get("user").id !== "owner"
      ? c.env.DB.prepare(`UPDATE users SET password_verifier = ?, revision = revision + 1
          WHERE id = ? AND ${fresh.sql} RETURNING revision`).bind(
          verifier,
          c.get("user").id,
          ...fresh.values,
        )
      : c.env.DB.prepare(`INSERT INTO app_credentials
      (singleton, bootstrap_fingerprint, password_verifier, revision)
      SELECT 1, ?, ?, ?
      WHERE ${fresh.sql}
      ON CONFLICT(singleton) DO UPDATE SET
        bootstrap_fingerprint = excluded.bootstrap_fingerprint,
        password_verifier = excluded.password_verifier,
        revision = excluded.revision
      RETURNING revision`).bind(
          auth.bootstrapFingerprint,
          verifier,
          auth.revision + 1,
          ...fresh.values,
        ),
  ]);
  if (!result.results.length) credentialConflict();
  // Triggers already revoked these sessions. Keep this response cookie-neutral
  // so delayed delivery cannot overwrite a subsequent login in another tab.
  return c.json({ ok: true });
}

export async function cleanupAuth(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").bind(now),
  ]);
}
