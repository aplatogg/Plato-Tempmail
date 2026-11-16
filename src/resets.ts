import type { Context } from "hono";
import { recordAudit, requestIp } from "./audit";
import { passwordVerifier, throttle, validNewPassword } from "./auth";
import { ApiError, hex, readJson, sha256 } from "./security";
import type { AppBindings, Env } from "./types";

const RESET_SECONDS = 1800;
// One delivered link per account per window; inside it, a new request neither
// sends mail nor invalidates the link the owner already has.
const RESET_COOLDOWN_SECONDS = 600;
// Existing and unknown accounts must answer in the same window, so the endpoint
// cannot be used to test whether a username is registered.
const RESET_MIN_RESPONSE_MS = 400;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

async function dropToken(env: Env, tokenHash: string): Promise<void> {
  await env.DB.prepare("DELETE FROM password_resets WHERE token_hash = ?").bind(tokenHash).run();
}

/**
 * Requests a reset link. The response is identical whether or not the account
 * exists, and the token is written before the email is attempted so a failed
 * send cannot leave a valid token behind.
 */
export async function forgotPassword(c: Context<AppBindings>): Promise<Response> {
  const body = await readJson(c.req.raw, 8192);
  if (
    Object.keys(body).some((key) => key !== "username") ||
    typeof body.username !== "string" ||
    body.username.length < 1 ||
    body.username.length > 64
  ) {
    throw new ApiError(400, "INVALID_INPUT", "Provide a username within the allowed length.");
  }
  const started = Date.now();
  const finish = async () => {
    const remaining = RESET_MIN_RESPONSE_MS - (Date.now() - started);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    return c.json({ ok: true }, 202);
  };
  const now = Math.floor(Date.now() / 1000);
  await throttle(c, now, "reset");
  const config = c.get("config");
  const owner = body.username.toLowerCase() === config.username.toLowerCase();
  const account = owner
    ? { id: "owner" as const, username: config.username }
    : await c.env.DB.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE")
        .bind(body.username)
        .first<{ id: string; username: string }>();
  const latest = await c.env.DB.prepare(
    "SELECT created_at FROM password_resets WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(account?.id ?? "")
    .first<{ created_at: number }>();
  if (!account) return await finish();
  if (latest && now - latest.created_at < RESET_COOLDOWN_SECONDS) return await finish();

  const token = hex(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  const tokenHash = await sha256(token);
  const expiresAt = now + RESET_SECONDS;
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL").bind(
      account.id,
    ),
    c.env.DB.prepare(
      `INSERT INTO password_resets (token_hash, user_id, username, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(tokenHash, account.id, account.username, now, expiresAt),
  ]);

  const binding = c.env.RESET_EMAIL;
  const recipient = c.env.RESET_EMAIL_TO;
  if (!binding || !recipient) {
    await dropToken(c.env, tokenHash);
    return await finish();
  }
  const link = `${config.origin}/?reset=${token}`;
  // Delivery happens after the response: an existing account must not answer
  // measurably slower than an unknown one.
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await binding.send({
          from: `no-reply@${config.mailDomain}`,
          to: recipient,
          subject: "Reset kata sandi Haldgoff Mail",
          text: [
            `Permintaan reset kata sandi untuk akun "${account.username}".`,
            "",
            "Buka tautan berikut dalam 30 menit. Tautan hanya bisa dipakai sekali:",
            link,
            "",
            "Abaikan email ini jika bukan Anda yang meminta.",
          ].join("\n"),
        });
      } catch (error) {
        await dropToken(c.env, tokenHash);
        const code =
          typeof error === "object" && error && "code" in error ? String(error.code) : null;
        const message =
          typeof error === "object" && error && "message" in error
            ? String(error.message).slice(0, 120)
            : null;
        console.error(JSON.stringify({ event: "reset_email_failed", code, message }));
      }
    })(),
  );
  return await finish();
}
/**
 * Consumes a one-time token and writes the new password verifier. The token
 * consumption and the credential write share one D1 batch, so a replayed or
 * expired token can never reach the password update.
 */
export async function resetPassword(c: Context<AppBindings>): Promise<Response> {
  const body = await readJson(c.req.raw, 16_384);
  if (
    Object.keys(body).some((key) => key !== "token" && key !== "password") ||
    typeof body.token !== "string" ||
    !TOKEN_PATTERN.test(body.token) ||
    !validNewPassword(body.password)
  ) {
    throw new ApiError(
      400,
      "INVALID_INPUT",
      "Provide the reset token and a nonblank password of 5-1024 characters.",
    );
  }
  const now = Math.floor(Date.now() / 1000);
  await throttle(c, now, "reset");
  const tokenHash = await sha256(body.token);
  const account = await c.env.DB.prepare(
    `SELECT user_id, username FROM password_resets
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
  )
    .bind(tokenHash, now)
    .first<{ user_id: string; username: string }>();
  if (!account) {
    throw new ApiError(400, "INVALID_TOKEN", "Tautan reset tidak valid atau sudah kedaluwarsa.");
  }

  const verifier = await passwordVerifier(body.password);
  const auth = c.get("auth");
  const credentialWrite =
    account.user_id === "owner"
      ? c.env.DB.prepare(
          `INSERT INTO app_credentials (singleton, bootstrap_fingerprint, password_verifier, revision)
           SELECT 1, ?, ?, COALESCE((SELECT revision FROM app_credentials WHERE singleton = 1), 0) + 1
           WHERE EXISTS (SELECT 1 FROM password_resets WHERE token_hash = ? AND used_at = ?)
           ON CONFLICT(singleton) DO UPDATE SET
             bootstrap_fingerprint = excluded.bootstrap_fingerprint,
             password_verifier = excluded.password_verifier,
             revision = excluded.revision`,
        ).bind(auth.bootstrapFingerprint, verifier, tokenHash, now)
      : c.env.DB.prepare(
          `UPDATE users SET password_verifier = ?, revision = revision + 1
           WHERE id = ? AND revision < 9007199254740991
             AND EXISTS (SELECT 1 FROM password_resets WHERE token_hash = ? AND used_at = ?)`,
        ).bind(verifier, account.user_id, tokenHash, now);

  const [consumed] = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE password_resets SET used_at = ?
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
    ).bind(now, tokenHash, now),
    credentialWrite,
    c.env.DB.prepare("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL").bind(
      account.user_id,
    ),
  ]);
  if (!consumed.meta.changes) {
    throw new ApiError(400, "INVALID_TOKEN", "Tautan reset tidak valid atau sudah kedaluwarsa.");
  }
  await recordAudit(c.env.DB, {
    actorId: account.user_id,
    actorUsername: account.username,
    action: "auth.password_reset",
    targetId: account.user_id,
    targetUsername: account.username,
    ip: requestIp(c),
    now,
  });
  return c.json({ ok: true, username: account.username });
}

export async function cleanupResets(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM password_resets WHERE expires_at <= ?")
    .bind(Math.floor(Date.now() / 1000))
    .run();
}
