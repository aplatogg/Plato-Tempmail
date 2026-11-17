import { convert } from "html-to-text";
import PostalMime from "postal-mime";
import { notifyUser } from "./push";
import { hex, readConfig } from "./security";
import type { Env } from "./types";

const MAX_RAW_BYTES = 2 * 1024 * 1024;
const MAX_BODY_CHARS = 80_000;
const MAX_MESSAGES = 500;

class InvalidMail extends Error {}

async function readRaw(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new InvalidMail("Invalid email content.");
      size += value.byteLength;
      if (size > MAX_RAW_BYTES) {
        // Stop consuming immediately; the reported rawSize is not a trusted bound.
        await reader.cancel().catch(() => {});
        throw new InvalidMail("Email exceeds the 2 MiB size limit.");
      }
      chunks.push(value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) throw new InvalidMail("Invalid email content.");
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

export async function receiveEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx?: ExecutionContext,
): Promise<void> {
  // Configuration and storage failures must escape so delivery can be retried.
  const config = readConfig(env);
  const recipient = typeof message.to === "string" ? message.to.toLowerCase() : "";
  if (
    recipient.length > 320 ||
    !/^[^\s@<>]+@[^\s@<>]+$/.test(recipient) ||
    recipient.split("@")[1] !== config.mailDomain
  ) {
    message.setReject("Recipient is unavailable.");
    return;
  }
  const inbox = await env.DB.prepare(
    "SELECT id, webhook_url AS webhookUrl FROM inboxes WHERE address = ?",
  )
    .bind(recipient)
    .first<{ id: string; webhookUrl: string | null }>();
  if (!inbox) {
    message.setReject("Recipient is unavailable.");
    return;
  }
  if (
    !Number.isSafeInteger(message.rawSize) ||
    message.rawSize <= 0 ||
    message.rawSize > MAX_RAW_BYTES
  ) {
    message.setReject("Invalid email size; maximum is 2 MiB.");
    return;
  }
  if (typeof message.from !== "string" || /[\r\n\0]/.test(message.from)) {
    message.setReject("Invalid envelope sender.");
    return;
  }

  let raw: Uint8Array<ArrayBuffer>;
  let body: string;
  let subject: string;
  let html: string | null = null;
  let attachments: { name: string; type: string; size: number }[] = [];
  let fromName: string | null = null;
  try {
    raw = await readRaw(message.raw);
    const parsed = await PostalMime.parse(raw, {
      maxHeadersSize: 64 * 1024,
      maxNestingDepth: 32,
      forceRfc822Attachments: true,
    });
    if (!parsed.headers.some((header) => /^[!-9;-~]+$/.test(header.key))) {
      throw new InvalidMail("Invalid email content.");
    }
    // The converter only traverses a parsed DOM; links/resources are never fetched.
    let htmlText = "";
    try {
      if (parsed.html) {
        htmlText = convert(parsed.html.slice(0, MAX_RAW_BYTES), {
          wordwrap: false,
          // PostalMime can combine inline mixed parts outside a nested <body>.
          baseElements: { selectors: [] },
          limits: { maxInputLength: MAX_RAW_BYTES, maxDepth: 64, maxChildNodes: 10_000 },
          selectors: [
            ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
              selector,
              options: { uppercase: false },
            })),
            { selector: "a", options: { ignoreHref: true } },
            ...["http", "https"].map((scheme) => ({
              selector: `a[href^="${scheme}://" i]`,
              format: "anchor",
              options: {
                ignoreHref: false,
                hideLinkHrefIfSameAsText: true,
                linkBrackets: ["[", "]"],
              },
            })),
            ...["head", "img", "script", "style", "iframe", "object", "embed"].map((selector) => ({
              selector,
              format: "skip",
            })),
          ],
        });
      }
    } catch {
      // A display formatter failure must not reject a usable plain alternative.
      // MIME validation above and retryable storage failures below stay separate.
      if (!parsed.text?.trim()) throw new InvalidMail("Invalid email content.");
    }
    // Some senders supply only an HTML-viewing notice in the plain alternative.
    // Keep readable HTML content as inert text; fall back for empty/image-only HTML.
    body = (htmlText.trim() ? htmlText : (parsed.text ?? "")).slice(0, MAX_BODY_CHARS);
    subject = (parsed.subject ?? "").slice(0, 500);
    // The display name from the From header. Envelope data carries only the address.
    fromName = (parsed.from?.name ?? "").trim().slice(0, 120) || null;
    html = parsed.html ? parsed.html.slice(0, 120_000) : null;
    attachments = (parsed.attachments ?? []).slice(0, 20).map((item) => ({
      name: (item.filename ?? "lampiran").slice(0, 200),
      type: (item.mimeType ?? "application/octet-stream").slice(0, 120),
      size:
        typeof item.content === "string"
          ? item.content.length
          : ((item.content as ArrayBuffer | Uint8Array | undefined)?.byteLength ?? 0),
    }));
  } catch (error) {
    // Do not expose parser diagnostics or include D1 operations in this catch.
    message.setReject(error instanceof InvalidMail ? error.message : "Invalid email content.");
    return;
  }

  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)));

  const now = Math.floor(Date.now() / 1000);
  // Retention is per plan, resolved from the inbox owner's role mask in the same
  // statement: Celestial/Cosmos/Astral 30 days (bits 2|4|8), Stardust 14 (32),
  // Voyager/Quark 7. Unmapped legacy inboxes belong to the owner (mask 8 -> 30).
  const inserted = await env.DB.prepare(
    `INSERT INTO messages
       (id, inbox_id, from_address, from_name, subject, body, html, attachments, received_at, expires_at, raw_digest)
     SELECT ?, i.id, ?, ?, ?, ?, ?, ?, ?, ? + 86400 * (
       CASE
         WHEN (COALESCE(u.role_mask, 8) & 14) <> 0 THEN 30
         WHEN (COALESCE(u.role_mask, 8) & 32) <> 0 THEN 14
         ELSE 7
       END), ? FROM inboxes i
     LEFT JOIN inbox_owners o ON o.inbox_id = i.id
     LEFT JOIN users u ON u.id = COALESCE(o.user_id, 'owner')
     WHERE i.id = ? AND i.address = ?
       AND (SELECT COUNT(*) FROM messages WHERE inbox_id = i.id AND expires_at > ?) < ?
     ON CONFLICT(inbox_id, raw_digest) DO NOTHING
     RETURNING id`,
  )
    .bind(
      crypto.randomUUID(),
      message.from.slice(0, 320),
      fromName,
      subject,
      body,
      html,
      attachments.length ? JSON.stringify(attachments) : null,
      now,
      now,
      digest,
      inbox.id,
      recipient,
      now,
      MAX_MESSAGES,
    )
    .first<{ id: string }>();
  if (inserted) {
    // Background notification: the browser only hears about mail while a tab is
    // open, so the device is told through Web Push instead. Best-effort, and never
    // allowed to fail the delivery that is already stored.
    const owner = await env.DB.prepare(`SELECT COALESCE(o.user_id, 'owner') AS userId
      FROM inboxes i LEFT JOIN inbox_owners o ON o.inbox_id = i.id WHERE i.id = ?`)
      .bind(inbox.id)
      .first<{ userId: string }>();
    if (owner?.userId) {
      const push = notifyUser(env, owner.userId, {
        title: fromName ?? recipient,
        body: subject || "(tanpa subjek)",
        inbox: recipient,
        from: message.from.slice(0, 320),
      }).catch(() => {
        // A push failure must never surface as a mail failure.
      });
      if (ctx) ctx.waitUntil(push);
      else await push;
    }
    if (inbox.webhookUrl) {
      const payload = {
        inbox: recipient,
        from: message.from.slice(0, 320),
        subject,
        preview: body.slice(0, 300),
        receivedAt: now,
        attachments: attachments.length,
      };
      const request = deliverWebhook(inbox.webhookUrl, payload);
      if (ctx) ctx.waitUntil(request);
      else await request;
    }
    return;
  }

  // Count + insert is one atomic statement. Only the precise digest conflict is
  // ignored, not FK/other storage errors. A duplicate also succeeds at full quota.
  const duplicate = await env.DB.prepare(
    `SELECT messages.id FROM messages JOIN inboxes ON inboxes.id = messages.inbox_id
     WHERE inboxes.id = ? AND inboxes.address = ? AND messages.raw_digest = ?`,
  )
    .bind(inbox.id, recipient, digest)
    .first<{ id: string }>();
  if (!duplicate) message.setReject("Recipient is unavailable or inbox is full.");
}

async function deliverWebhook(url: string, payload: Record<string, unknown>): Promise<void> {
  // Best-effort: a slow or dead endpoint must not delay message storage.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", "user-agent": "Haldgoff-Mail/1.0" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // A validated public URL must not become a private target through a redirect.
    if (response.status >= 300 && response.status < 400) {
      console.error(JSON.stringify({ event: "webhook_redirect_rejected" }));
    }
  } catch {
    console.error(JSON.stringify({ event: "webhook_failed" }));
  } finally {
    clearTimeout(timer);
  }
}

export async function cleanupMessages(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM messages WHERE expires_at <= ?")
    .bind(Math.floor(Date.now() / 1000))
    .run();
}
