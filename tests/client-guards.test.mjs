// Static guard for the browser bundle. The app ships a strict CSP
// (connect-src 'self'), so a data: URL can never be fetched: decoding audio or
// anything else must read the bytes it already holds.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const app = readFileSync(join(root, "public/app.js"), "utf8");
const html = readFileSync(join(root, "public/index.html"), "utf8");

test("the client never fetches a data: URL", () => {
  const offenders = [...app.matchAll(/fetch\(\s*[`"']data:/g)].map((m) => m[0]);
  assert.deepEqual(offenders, [], "connect-src 'self' blocks data: URLs; read the bytes directly");
});

test("the client never fetches a blob: URL", () => {
  const offenders = [...app.matchAll(/fetch\(\s*[`"']blob:/g)].map((m) => m[0]);
  assert.deepEqual(offenders, [], "blob: URLs are outside connect-src 'self'");
});

test("no inline script is injected by the shell", () => {
  // The CSP has no script-src 'unsafe-inline'; a stray inline block would be dropped.
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g)].filter(
    (m) => m[0].replace(/<script[^>]*>|<\/script>/g, "").trim().length > 0,
  );
  assert.deepEqual(
    inline.map((m) => m[0].slice(0, 40)),
    [],
  );
});
