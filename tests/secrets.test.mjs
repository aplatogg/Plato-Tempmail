// Guards the public repository against committing live credentials.
// Runs on node:test (npm run test:tooling) and reads the git index, so it fails
// the build the moment a real account id, database id, API token or owner mailbox
// is staged or committed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Only tracked files are published, so only they matter. Ignored files such as
// .dev.vars and wrangler.local.jsonc are the operator's own deploy config.
function tracked() {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "buffer" });
  assert.equal(result.status, 0, "git ls-files failed; this guard needs a checkout");
  return result.stdout.toString("utf8").split("\u0000").filter(Boolean);
}

const PATTERNS = [
  // Cloudflare account ids and D1 database ids that are not obvious placeholders.
  {
    name: "cloudflare account id",
    re: /\b[0-9a-f]{32}\b/g,
    allow: (m) => /^(0+|0*1|00112233445566778899aabbccddeeff)$/.test(m),
  },
  {
    name: "d1 database id",
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
    allow: (m) => /^(.)\1{7}-/.test(m) || /^00112233-/.test(m),
  },
  // Live tokens and keys.
  { name: "cloudflare api token", re: /\bcfut_[A-Za-z0-9]{20,}/g },
  {
    name: "plato api key",
    re: /\bhvk_[0-9a-f]{12}_[0-9a-f]{16,}/g,
    allow: (m) => /^hvk_0{12}_0+$/.test(m),
  },
  // A committed local password hash.
  { name: "password verifier", re: /pbkdf2-sha256\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}/g },
];

test("no live credentials are tracked", () => {
  const findings = [];
  for (const path of tracked()) {
    let text;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue; // binary asset
    }
    if (text.includes("\u0000")) continue;
    for (const { name, re, allow } of PATTERNS) {
      for (const match of text.matchAll(re)) {
        if (allow && allow(match[0])) continue;
        findings.push(`${path}: ${name} -> ${match[0].slice(0, 12)}…`);
      }
    }
  }
  assert.deepEqual(findings, [], `tracked credentials found:\n${findings.join("\n")}`);
});

test("deploy configs stay untracked", () => {
  const trackedSet = new Set(tracked());
  for (const forbidden of [
    ".dev.vars",
    "wrangler.local.jsonc",
    "wrangler.staging.jsonc",
    "wrangler.dev.jsonc",
    ".owner-password.txt",
  ]) {
    assert.equal(trackedSet.has(forbidden), false, `${forbidden} must never be tracked`);
  }
});
