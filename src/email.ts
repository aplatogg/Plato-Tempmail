import { convert } from "html-to-text";
import PostalMime from "postal-mime";
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

export async function receiveEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
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
  const inbox = await env.DB.prepare("SELECT id FROM inboxes WHERE address = ?")
    .bind(recipient)
    .first<{ id: string }>();
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
    body = (
      parsed.text ??
      convert((parsed.html ?? "").slice(0, MAX_RAW_BYTES), {
        wordwrap: false,
        limits: { maxInputLength: MAX_RAW_BYTES, maxDepth: 64, maxChildNodes: 10_000 },
        selectors: [
          { selector: "a", options: { ignoreHref: true } },
          ...["img", "script", "style", "iframe", "object", "embed"].map((selector) => ({
            selector,
            format: "skip",
          })),
        ],
      })
    ).slice(0, MAX_BODY_CHARS);
    subject = (parsed.subject ?? "").slice(0, 500);
  } catch (error) {
    // Do not expose parser diagnostics or include D1 operations in this catch.
    message.setReject(error instanceof InvalidMail ? error.message : "Invalid email content.");
    return;
  }

  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)));
  const now = Math.floor(Date.now() / 1000);
  const inserted = await env.DB.prepare(
    `INSERT INTO messages
       (id, inbox_id, from_address, subject, body, received_at, expires_at, raw_digest)
     SELECT ?, inboxes.id, ?, ?, ?, ?, ?, ? FROM inboxes
     WHERE inboxes.id = ? AND inboxes.address = ?
       AND (SELECT COUNT(*) FROM messages WHERE inbox_id = inboxes.id AND expires_at > ?) < ?
     ON CONFLICT(inbox_id, raw_digest) DO NOTHING
     RETURNING id`,
  )
    .bind(
      crypto.randomUUID(),
      message.from.slice(0, 320),
      subject,
      body,
      now,
      now + config.retentionDays * 86400,
      digest,
      inbox.id,
      recipient,
      now,
      MAX_MESSAGES,
    )
    .first<{ id: string }>();
  if (inserted) return;

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

export async function cleanupMessages(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM messages WHERE expires_at <= ?")
    .bind(Math.floor(Date.now() / 1000))
    .run();
}
