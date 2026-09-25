import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import PostalMime from "postal-mime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupMessages, receiveEmail } from "../src/email";
import type { Env } from "../src/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const address = "known@example.com";
const maxBytes = 2 * 1024 * 1024;
const now = 1_800_000_000;
const encoder = new TextEncoder();

function mime(body = "Hello world", headers = "Content-Type: text/plain; charset=utf-8") {
  return `From: Untrusted Header <spoof@example.net>\r\nTo: ignored@example.net\r\nSubject: Test subject\r\nMessage-ID: <same@example.net>\r\nMIME-Version: 1.0\r\n${headers}\r\n\r\n${body}`;
}

function incoming(
  content: string | Uint8Array = mime(),
  options: {
    to?: string;
    from?: string;
    rawSize?: number;
    chunks?: Uint8Array[];
    beforeRead?: () => Promise<void>;
  } = {},
) {
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  const chunks = options.chunks ?? [bytes];
  const rejected: string[] = [];
  let index = 0;
  const cancel = vi.fn();
  const raw = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (index === 0) await options.beforeRead?.();
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else controller.close();
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const message = {
    from: options.from ?? "envelope@example.net",
    to: options.to ?? address,
    rawSize: options.rawSize ?? bytes.byteLength,
    raw,
    headers: new Headers(),
    setReject(reason: string) {
      rejected.push(reason);
    },
    forward: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage;
  return { message, rejected, cancel };
}

async function count() {
  return bindings.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<number>("n");
}

async function seedMessages(total: number, expiresAt = now + 1000) {
  await bindings.DB.prepare(
    `WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM nums WHERE n < ?)
     INSERT INTO messages (id, inbox_id, from_address, subject, body, received_at, expires_at, raw_digest)
     SELECT 'seed-' || n, 'inbox-1', '', '', '', ?, ?, 'digest-' || n FROM nums`,
  )
    .bind(total, now - 100, expiresAt)
    .run();
}

beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000 + 999);
  await bindings.DB.batch([
    bindings.DB.prepare("DELETE FROM messages"),
    bindings.DB.prepare("DELETE FROM inboxes"),
  ]);
  await bindings.DB.prepare("INSERT INTO inboxes VALUES ('inbox-1', ?, ?)")
    .bind(address, now)
    .run();
});

afterEach(() => vi.restoreAllMocks());

describe("MIME ingestion", () => {
  it("stores decoded mail for an existing case-normalized envelope recipient", async () => {
    const raw = mime();
    const item = incoming(raw, { to: "KNOWN@EXAMPLE.COM" });
    await receiveEmail(item.message, bindings);
    expect(item.rejected).toEqual([]);
    const row = await bindings.DB.prepare("SELECT * FROM messages").first();
    expect(row).toMatchObject({
      inbox_id: "inbox-1",
      from_address: "envelope@example.net",
      subject: "Test subject",
      body: "Hello world\n",
      received_at: now,
      expires_at: now + 7 * 86400,
    });
    expect(row?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(raw))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(row?.raw_digest).toBe(digest);
    expect(item.message.forward).not.toHaveBeenCalled();
    expect(item.message.reply).not.toHaveBeenCalled();
  });

  it.each([
    "unknown@example.com",
    "known@sub.example.com",
    "known@example.com.attacker.invalid",
    "known@other.invalid",
    "known@@example.com",
    " known@example.com",
    "known@example.com\r\n",
    "",
  ])("rejects unavailable or invalid recipient %j without creating inboxes", async (to) => {
    const item = incoming(mime(), { to });
    await receiveEmail(item.message, bindings);
    expect(item.rejected).toHaveLength(1);
    expect(item.rejected[0]).toMatch(/recipient/i);
    expect(await count()).toBe(0);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM inboxes").first("n")).toBe(1);
  });

  it("rejects wrong-domain delivery even when that address exists in D1", async () => {
    await bindings.DB.prepare(
      "INSERT INTO inboxes VALUES ('foreign', 'known@other.invalid', 0)",
    ).run();
    const item = incoming(mime(), { to: "known@other.invalid" });
    await receiveEmail(item.message, bindings);
    expect(item.rejected).toHaveLength(1);
    expect(await count()).toBe(0);
  });

  it.each([
    ["base64", "SGVsbG8g4pyT", "Hello ✓"],
    ["quoted-printable", "caf=C3=A9=20line=\r\ncontinued", "café linecontinued\n"],
  ])("decodes real %s MIME bodies", async (encoding, body, expected) => {
    const item = incoming(
      mime(
        body,
        `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: ${encoding}`,
      ),
    );
    await receiveEmail(item.message, bindings);
    expect(item.rejected).toEqual([]);
    expect(await bindings.DB.prepare("SELECT body FROM messages").first("body")).toBe(expected);
  });

  it("decodes an encoded and folded subject", async () => {
    const item = incoming(
      mime().replace(
        "Subject: Test subject",
        "Subject: =?UTF-8?Q?caf=C3=A9?=\r\n =?UTF-8?Q?_mail?=",
      ),
    );
    await receiveEmail(item.message, bindings);
    expect(await bindings.DB.prepare("SELECT subject FROM messages").first("subject")).toBe(
      "café mail",
    );
  });

  it("uses readable HTML over the plain alternative and discards real MIME attachments", async () => {
    const body = [
      "--outer",
      'Content-Type: multipart/alternative; boundary="inner"',
      "",
      "--inner",
      "Content-Type: text/plain",
      "",
      "Preferred plain text",
      "--inner",
      "Content-Type: text/html",
      "",
      "<p>HTML alternative</p>",
      "--inner--",
      "--outer",
      "Content-Type: text/plain",
      'Content-Disposition: attachment; filename="secret.txt"',
      "Content-Transfer-Encoding: base64",
      "",
      "U0VDUkVUIEFUVEFDSE1FTlQ=",
      "--outer--",
    ].join("\r\n");
    const item = incoming(mime(body, 'Content-Type: multipart/mixed; boundary="outer"'));
    await receiveEmail(item.message, bindings);
    const row = await bindings.DB.prepare("SELECT * FROM messages").first();
    expect(row?.body).toBe("HTML alternative");
    expect(JSON.stringify(row)).not.toContain("SECRET ATTACHMENT");
    expect(JSON.stringify(row)).not.toContain("secret.txt");
    expect(JSON.stringify(row)).not.toContain("Preferred plain text");
  });

  it.each(["base64", "quoted-printable"])(
    "extracts verification content and URLs from a %s HTML alternative instead of the placeholder",
    async (encoding) => {
      const html =
        '<p>Your code: <strong>782345</strong></p><a href="https://verify.example.net/confirm?token=synthetic&amp;source=mail">Verify email</a>';
      const encoded = encoding === "base64" ? btoa(html) : html.replaceAll("=", "=3D");
      const body = [
        "--alternative",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Please open the HTML version of this email.",
        "--alternative",
        "Content-Type: text/html; charset=utf-8",
        `Content-Transfer-Encoding: ${encoding}`,
        "",
        encoded,
        "--alternative--",
      ].join("\r\n");
      const item = incoming(
        mime(body, 'Content-Type: multipart/alternative; boundary="alternative"'),
      );
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("network forbidden"));
      await receiveEmail(item.message, bindings);
      expect(item.rejected).toEqual([]);
      const stored = await bindings.DB.prepare("SELECT body FROM messages").first<string>("body");
      expect(stored).toContain("Your code: 782345");
      expect(stored).toContain(
        "Verify email [https://verify.example.net/confirm?token=synthetic&source=mail]",
      );
      expect(stored).not.toContain("Please open the HTML version");
      expect(stored).not.toContain("<strong>");
      expect(network).not.toHaveBeenCalled();
    },
  );

  it.each([
    "",
    "   ",
    '<img src="https://remote.invalid/pixel">',
    "<script>hidden()</script><style>hidden{}</style>",
  ])(
    "falls back to the original plain alternative when converted HTML is empty: %j",
    async (html) => {
      const body = [
        "--alternative",
        "Content-Type: text/plain",
        "",
        "Plain fallback 654321",
        "--alternative",
        "Content-Type: text/html",
        "",
        html,
        "--alternative--",
      ].join("\r\n");
      const item = incoming(
        mime(body, 'Content-Type: multipart/alternative; boundary="alternative"'),
      );
      await receiveEmail(item.message, bindings);
      expect(item.rejected).toEqual([]);
      expect(await bindings.DB.prepare("SELECT body FROM messages").first("body")).toBe(
        "Plain fallback 654321\n",
      );
    },
  );

  it("preserves only HTTP(S) anchor destinations as inert text, including malformed HTML", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const item = incoming(
      mime(
        '<p>Code 543210<a href="HTTPS://verify.example.net/token">Uppercase</a><a href="http://verify.example.net/token">HTTP</a><a href="javascript:alert(1)">Script</a><a href="data:text/html,active">Data</a><a href="//remote.invalid/path">Relative</a><img src="https://remote.invalid/pixel">',
        "Content-Type: text/html",
      ),
    );
    await receiveEmail(item.message, bindings);
    expect(item.rejected).toEqual([]);
    const stored = await bindings.DB.prepare("SELECT body FROM messages").first<string>("body");
    expect(stored).toContain("543210");
    expect(stored).toContain("HTTPS://verify.example.net/token");
    expect(stored).toContain("http://verify.example.net/token");
    expect(stored).not.toMatch(/javascript:|data:text|remote\.invalid|<a|<img/);
    expect(network).not.toHaveBeenCalled();
  });

  it("converts actual HTML to inert text without fetching resources or retaining executable markup", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const item = incoming(
      mime(
        '<html><head><style>HIDDEN_STYLE</style></head><body><p>Hello &amp; welcome</p><script>SECRET_SCRIPT()</script><a href="javascript:alert(1)">Read this</a><img src="https://remote.invalid/pixel" onerror="alert(2)"><iframe src="https://remote.invalid/frame">HIDDEN_FRAME</iframe></body></html>',
        "Content-Type: text/html; charset=utf-8",
      ),
    );
    await receiveEmail(item.message, bindings);
    expect(item.rejected).toEqual([]);
    expect(await bindings.DB.prepare("SELECT body FROM messages").first("body")).toBe(
      "Hello & welcome\n\nRead this",
    );
    expect(network).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3, 4, 5, 6])("M1 preserves code and identical URL case in h%i", async (level) => {
    const url = "https://verify.example.net/Confirm?token=aB7xQ9";
    const item = incoming(
      mime(
        `<h${level}>Code aB7xQ9</h${level}><h${level}><a href="${url}">${url}</a></h${level}>`,
        "Content-Type: text/html",
      ),
    );
    await receiveEmail(item.message, bindings);
    expect(item.rejected).toEqual([]);
    const stored = await bindings.DB.prepare("SELECT body FROM messages").first<string>("body");
    expect(stored).toContain("Code aB7xQ9");
    expect(stored).toContain(url);
    expect(stored).not.toContain("AB7XQ9");
  });

  it.each([
    "<body><p>Company footer</p></body>",
    "<html><head><title>Hidden title</title><style>hidden{}</style></head><body><p>Company footer</p></body></html>",
  ])("M2 preserves separate inline mixed content outside the HTML body: %s", async (html) => {
    const body = [
      "--mixed",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Your code: aB7xQ9",
      "--mixed",
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
      "--mixed--",
    ].join("\r\n");
    const item = incoming(mime(body, 'Content-Type: multipart/mixed; boundary="mixed"'));
    await receiveEmail(item.message, bindings);
    expect(item.rejected).toEqual([]);
    const stored = await bindings.DB.prepare("SELECT body FROM messages").first<string>("body");
    expect(stored).toContain("Your code: aB7xQ9");
    expect(stored).toContain("Company footer");
    expect(stored).not.toMatch(/Hidden title|hidden\{\}|<body|<div/);
  });

  it.each(["I", "i"])(
    "M3 preserves usable plaintext when %s list conversion fails",
    async (type) => {
      const body = [
        "--alternative",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Recovery code: aB7xQ9",
        "--alternative",
        "Content-Type: text/html; charset=utf-8",
        "",
        `<ol type="${type}" start="10000"><li>Recovery code: aB7xQ9</li></ol>`,
        "--alternative--",
      ].join("\r\n");
      const item = incoming(
        mime(body, 'Content-Type: multipart/alternative; boundary="alternative"'),
      );
      await receiveEmail(item.message, bindings);
      expect(item.rejected).toEqual([]);
      expect(await bindings.DB.prepare("SELECT body FROM messages").first("body")).toBe(
        "Recovery code: aB7xQ9\n",
      );
    },
  );

  it("caps stored decoded body, subject, and envelope sender", async () => {
    const item = incoming(
      mime("x".repeat(90_000)).replace("Subject: Test subject", `Subject: ${"s".repeat(600)}`),
      { from: "f".repeat(400) },
    );
    await receiveEmail(item.message, bindings);
    const row = await bindings.DB.prepare("SELECT * FROM messages").first();
    expect(row?.body).toBe("x".repeat(80_000));
    expect(row?.subject).toBe("s".repeat(500));
    expect(row?.from_address).toBe("f".repeat(320));
  });

  it("caps converted HTML text too", async () => {
    const item = incoming(mime(`<p>${"x".repeat(90_000)}</p>`, "Content-Type: text/html"));
    await receiveEmail(item.message, bindings);
    expect(await bindings.DB.prepare("SELECT body FROM messages").first("body")).toBe(
      "x".repeat(80_000),
    );
  });

  it.each([-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, maxBytes + 1])(
    "rejects invalid or excessive reported rawSize %s before consuming MIME",
    async (rawSize) => {
      const parse = vi.spyOn(PostalMime, "parse");
      const read = vi.fn(async () => {});
      const item = incoming(mime(), { rawSize, beforeRead: read });
      await receiveEmail(item.message, bindings);
      expect(item.rejected).toHaveLength(1);
      expect(read).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
      expect(await count()).toBe(0);
    },
  );

  it("accepts exactly 2 MiB of actual bytes", async () => {
    const prefix = mime("");
    const item = incoming(prefix + "x".repeat(maxBytes - encoder.encode(prefix).length));
    await receiveEmail(item.message, bindings);
    expect(item.rejected).toEqual([]);
    expect(await count()).toBe(1);
  });

  it("counts actual stream bytes across chunks despite an understated rawSize", async () => {
    const parse = vi.spyOn(PostalMime, "parse");
    const prefix = encoder.encode(mime(""));
    const item = incoming("", {
      rawSize: 10,
      chunks: [
        prefix,
        new Uint8Array(maxBytes - prefix.length),
        new Uint8Array([1]),
        new Uint8Array([2]),
      ],
    });
    await receiveEmail(item.message, bindings);
    expect(item.rejected).toHaveLength(1);
    expect(item.rejected[0]).toMatch(/size|large|2 MiB/i);
    expect(item.cancel).toHaveBeenCalled();
    expect(item.message.raw.locked).toBe(false);
    expect(parse).not.toHaveBeenCalled();
    expect(await count()).toBe(0);
  });

  it("hashes raw bytes without lossy UTF-8 conversion", async () => {
    const prefix = encoder.encode(mime(""));
    for (const byte of [0xfe, 0xff]) {
      const raw = new Uint8Array(prefix.length + 1);
      raw.set(prefix);
      raw[prefix.length] = byte;
      await receiveEmail(incoming(raw).message, bindings);
    }
    expect(await count()).toBe(2);
  });

  it.each(["", "not a MIME message", `X-Oversized: ${"s".repeat(70_000)}\r\n\r\nprivate body`])(
    "bounds rejection of malformed MIME/parser errors (%#)",
    async (raw) => {
      const item = incoming(raw, { rawSize: Math.max(1, raw.length) });
      await receiveEmail(item.message, bindings);
      expect(item.rejected).toHaveLength(1);
      expect(item.rejected[0].length).toBeLessThan(160);
      expect(item.rejected[0]).not.toContain("private body");
      expect(await count()).toBe(0);
    },
  );

  it("rejects failed input streams without retaining partial content", async () => {
    const item = incoming(mime(), {
      beforeRead: async () => {
        throw new Error("private stream detail");
      },
    });
    await receiveEmail(item.message, bindings);
    expect(item.rejected).toHaveLength(1);
    expect(item.rejected[0]).not.toContain("private stream detail");
    expect(await count()).toBe(0);
  });
});

describe("delivery integrity and quota", () => {
  it("acknowledges the same raw MIME once per inbox, including concurrent redelivery", async () => {
    const items = Array.from({ length: 8 }, () => incoming());
    await Promise.all(items.map((item) => receiveEmail(item.message, bindings)));
    expect(items.every((item) => item.rejected.length === 0)).toBe(true);
    expect(await count()).toBe(1);
    await bindings.DB.prepare(
      "INSERT INTO inboxes VALUES ('inbox-2', 'other@example.com', 0)",
    ).run();
    const other = incoming(mime(), { to: "other@example.com" });
    await receiveEmail(other.message, bindings);
    expect(other.rejected).toEqual([]);
    expect(await count()).toBe(2);
  });

  it("does not use Message-ID to deduplicate different raw MIME", async () => {
    await receiveEmail(incoming(mime("first")).message, bindings);
    await receiveEmail(incoming(mime("second")).message, bindings);
    expect(await count()).toBe(2);
  });

  it("rejects new mail at quota but acknowledges an existing duplicate without refreshing it", async () => {
    await receiveEmail(incoming().message, bindings);
    const original = await bindings.DB.prepare("SELECT * FROM messages").first();
    await seedMessages(499);
    const duplicate = incoming();
    const fresh = incoming(mime("new raw"));
    await receiveEmail(duplicate.message, bindings);
    await receiveEmail(fresh.message, bindings);
    expect(duplicate.rejected).toEqual([]);
    expect(fresh.rejected).toHaveLength(1);
    expect(fresh.rejected[0]).toMatch(/full|quota/i);
    expect(await count()).toBe(500);
    expect(
      await bindings.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(original?.id).first(),
    ).toEqual(original);
  });

  it("admits exactly one concurrent distinct delivery at the 500-message boundary", async () => {
    await seedMessages(499);
    const items = Array.from({ length: 10 }, (_, i) => incoming(mime(`unique ${i}`)));
    await Promise.all(items.map((item) => receiveEmail(item.message, bindings)));
    expect(items.filter((item) => item.rejected.length === 0)).toHaveLength(1);
    expect(items.filter((item) => item.rejected.length === 1)).toHaveLength(9);
    expect(await count()).toBe(500);
  });

  it("ignores expired messages at the exact expiry boundary when counting quota", async () => {
    await seedMessages(500, now);
    const item = incoming();
    await receiveEmail(item.message, bindings);
    expect(item.rejected).toEqual([]);
    expect(await count()).toBe(501);
  });

  it("does not silently acknowledge an inbox deleted during ingestion", async () => {
    const item = incoming(mime(), {
      beforeRead: async () => {
        await bindings.DB.prepare("DELETE FROM inboxes WHERE id = 'inbox-1'").run();
      },
    });
    await receiveEmail(item.message, bindings);
    expect(item.rejected).toHaveLength(1);
    expect(await count()).toBe(0);
  });

  it("does not deliver to a replacement inbox created at the same address during ingestion", async () => {
    const item = incoming(mime(), {
      beforeRead: async () => {
        await bindings.DB.batch([
          bindings.DB.prepare("DELETE FROM inboxes WHERE id = 'inbox-1'"),
          bindings.DB.prepare("INSERT INTO inboxes VALUES ('replacement', ?, 0)").bind(address),
        ]);
      },
    });
    await receiveEmail(item.message, bindings);
    expect(item.rejected).toHaveLength(1);
    expect(await count()).toBe(0);
  });
});

describe("retention and infrastructure failures", () => {
  it.each([1, 30])("uses configured %i-day retention in epoch seconds", async (days) => {
    await receiveEmail(incoming().message, { ...bindings, MESSAGE_RETENTION_DAYS: String(days) });
    expect(await bindings.DB.prepare("SELECT expires_at FROM messages").first("expires_at")).toBe(
      now + days * 86400,
    );
  });

  it("cleans expires_at <= now while preserving live messages and inboxes", async () => {
    await seedMessages(3, now);
    await bindings.DB.prepare("UPDATE messages SET expires_at = ? WHERE id = 'seed-1'")
      .bind(now - 1)
      .run();
    await bindings.DB.prepare("UPDATE messages SET expires_at = ? WHERE id = 'seed-3'")
      .bind(now + 1)
      .run();
    await cleanupMessages(bindings);
    expect(await count()).toBe(1);
    expect(await bindings.DB.prepare("SELECT id FROM messages").first("id")).toBe("seed-3");
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM inboxes").first("n")).toBe(1);
  });

  it.each([
    { MAIL_DOMAIN: "" },
    { PUBLIC_ORIGIN: "" },
    { ADMIN_USERNAME: "" },
    { MESSAGE_RETENTION_DAYS: "0" },
    { MESSAGE_RETENTION_DAYS: "31" },
  ])(
    "throws on missing/invalid deployment config rather than permanently rejecting mail: %j",
    async (overrides) => {
      const item = incoming();
      await expect(receiveEmail(item.message, { ...bindings, ...overrides })).rejects.toThrow();
      expect(item.rejected).toEqual([]);
      expect(await count()).toBe(0);
    },
  );

  it("does not require the HTTP authentication secret for inbound mail", async () => {
    const item = incoming();
    await receiveEmail(item.message, { ...bindings, AUTH_PASSWORD_HASH: undefined });
    expect(item.rejected).toEqual([]);
    expect(await count()).toBe(1);
  });

  it("propagates D1 lookup failures without setReject", async () => {
    const item = incoming();
    const failure = new Error("database unavailable");
    const DB = {
      prepare() {
        throw failure;
      },
    } as unknown as D1Database;
    await expect(receiveEmail(item.message, { ...bindings, DB })).rejects.toBe(failure);
    expect(item.rejected).toEqual([]);
  });

  it("propagates real D1 insert failures without setReject", async () => {
    await bindings.DB.prepare(
      "CREATE TRIGGER email_insert_failure BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END",
    ).run();
    try {
      const item = incoming();
      await expect(receiveEmail(item.message, bindings)).rejects.toThrow();
      expect(item.rejected).toEqual([]);
      expect(await count()).toBe(0);
    } finally {
      await bindings.DB.prepare("DROP TRIGGER email_insert_failure").run();
    }
  });

  it("propagates real D1 cleanup failures", async () => {
    await seedMessages(1, now);
    await bindings.DB.prepare(
      "CREATE TRIGGER email_delete_failure BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END",
    ).run();
    try {
      await expect(cleanupMessages(bindings)).rejects.toThrow();
      expect(await count()).toBe(1);
    } finally {
      await bindings.DB.prepare("DROP TRIGGER email_delete_failure").run();
    }
  });
});
