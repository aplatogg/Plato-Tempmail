import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pbkdf2Sync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// Deliberately synthetic resource identifiers; no account or database is contacted.
const oldId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const newId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherOldId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const hashPattern = /^pbkdf2-sha256\$100000\$([a-f0-9]{32})\$([a-f0-9]{64})$/;

async function tooling(name) {
  const module = await import(`../scripts/${name}.mjs`).catch((error) => {
    if (error.code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  });
  assert.ok(module, `${name} tooling must be implemented`);
  return module;
}

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), "plato-tempmail-tooling-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function verifyHash(hash, password) {
  const match = hashPattern.exec(hash);
  assert.ok(match, "fixed PBKDF2 format");
  assert.equal(
    match[2],
    pbkdf2Sync(password, Buffer.from(match[1], "hex"), 100_000, 32, "sha256").toString("hex"),
  );
}

function run(name, options = {}) {
  return spawnSync(
    process.execPath,
    [join(root, "scripts", `${name}.mjs`), ...(options.args ?? [])],
    {
      cwd: options.cwd ?? root,
      input: options.input ?? "",
      encoding: "utf8",
      timeout: 10_000,
      env: options.env ?? process.env,
    },
  );
}

function config() {
  return {
    name: "plato-tempmail",
    account_id: "a".repeat(32),
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: "mail.project.test", custom_domain: true }],
    d1_databases: [{ binding: "DB", database_name: "plato-tempmail-db", database_id: newId }],
    vars: {
      APP_NAME: "Plato-Tempmail",
      PUBLIC_ORIGIN: "https://mail.project.test",
      MAIL_DOMAIN: "project.test",
      ADMIN_USERNAME: "admin",
      MESSAGE_RETENTION_DAYS: "7",
    },
  };
}

test("hash matches independent PBKDF2 and generates a fresh 16-byte salt", async () => {
  const { hashPassword } = await tooling("password-hash");
  const first = await hashPassword("admin");
  const second = await hashPassword("admin");
  verifyHash(first, "admin");
  verifyHash(second, "admin");
  assert.notEqual(first.split("$")[2], second.split("$")[2]);
});

test("Unicode, decomposed characters, BOM, and boundary spaces are preserved", async () => {
  const { hashPassword, readPassword } = await tooling("password-hash");
  const password = " \uFEFFsandi🔑日本e\u0301 ";
  const bytes = Buffer.from(`${password}\r\n`);
  const input = Readable.from([...bytes].map((byte) => Buffer.from([byte])));
  assert.equal(await readPassword(input), password);
  verifyHash(await hashPassword(password), password);
});

test("accepts exactly 1024 UTF-16 code units, including astral characters", async () => {
  const { hashPassword } = await tooling("password-hash");
  verifyHash(await hashPassword("🔑".repeat(512)), "🔑".repeat(512));
});

test("rejects blank and over-limit passwords without disclosing the input", async () => {
  const { hashPassword } = await tooling("password-hash");
  for (const password of ["", " \t ", "x".repeat(1025), "🔑".repeat(513)]) {
    await assert.rejects(() => hashPassword(password), /blank|1024/i);
  }
});

test("bounded stdin rejects excess bytes before EOF and releases listeners", async () => {
  const { readPassword } = await tooling("password-hash");
  const input = new PassThrough();
  const result = readPassword(input);
  input.write(Buffer.alloc(4099, 120));
  await assert.rejects(result, /limit|long|1024/i);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("end"), 0);
  input.destroy();
});

test("stdin rejects malformed UTF-8, multiple lines and propagates stream errors", async () => {
  const { readPassword } = await tooling("password-hash");
  for (const input of [Buffer.from([0xc3, 0x28]), Buffer.from("one\ntwo\n")]) {
    await assert.rejects(() => readPassword(Readable.from([input])), /UTF-8|line/i);
  }
  const input = new PassThrough();
  const result = readPassword(input);
  input.destroy(new Error("stream failed"));
  await assert.rejects(result);
});

function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  const modes = [];
  input.setRawMode = (value) => {
    input.isRaw = value;
    modes.push(value);
  };
  let output = "";
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  return { input, stderr, modes, output: () => output };
}

test("TTY is hidden, handles split Unicode/backspace, and restores terminal mode", async () => {
  const { readPassword } = await tooling("password-hash");
  const tty = terminal();
  const result = readPassword(tty.input, tty.stderr);
  for (const byte of Buffer.from("秘密🔑\x7fZ\r")) tty.input.write(Buffer.from([byte]));
  assert.equal(await result, "秘密Z");
  assert.deepEqual(tty.modes, [true, false]);
  assert.doesNotMatch(tty.output(), /秘密|🔑|Z/);
  assert.equal(tty.input.listenerCount("data"), 0);
  tty.input.destroy();
});

test("TTY cancellation, EOF and oversized paste restore raw mode", async () => {
  const { readPassword } = await tooling("password-hash");
  for (const value of ["\x03", "\x04", "x".repeat(1025)]) {
    const tty = terminal();
    const result = readPassword(tty.input, tty.stderr);
    tty.input.write(value);
    await assert.rejects(result);
    assert.deepEqual(tty.modes, [true, false]);
    tty.input.destroy();
  }
  const tty = terminal();
  const result = readPassword(tty.input, tty.stderr);
  tty.input.end();
  await assert.rejects(result);
  assert.deepEqual(tty.modes, [true, false]);
});

test("password CLI prints only a hash on stdout for a pipe", () => {
  const result = run("password-hash", { input: "sandi🔑\r\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.split("\n").length, 2);
  verifyHash(result.stdout.trimEnd(), "sandi🔑");
});

test("password CLI never consumes CLI/env passwords or echoes invalid input", async () => {
  await tooling("password-hash");
  for (const options of [
    { args: ["--password", "do-not-echo-this"] },
    { env: { ...process.env, PASSWORD: "do-not-echo-this", AUTH_PASSWORD: "do-not-echo-this" } },
    { input: "do-not-echo-this\nsecond-line" },
    { input: "x".repeat(5000) },
  ]) {
    const result = run("password-hash", options);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /do-not-echo-this/);
  }
});

test("bootstrap writes only local vars, with a valid random-salt admin verifier", async (t) => {
  const { bootstrapLocal } = await tooling("bootstrap-local");
  const first = await temporary(t);
  const second = await temporary(t);
  await bootstrapLocal(first);
  await bootstrapLocal(second);
  const content = await readFile(join(first, ".dev.vars"), "utf8");
  assert.match(content, /^PUBLIC_ORIGIN=http:\/\/127\.0\.0\.1:8787$/m);
  assert.match(content, /^ADMIN_USERNAME=admin$/m);
  const verifier = /^AUTH_PASSWORD_HASH=(.+)$/m.exec(content)?.[1];
  verifyHash(verifier, "admin");
  assert.doesNotMatch(content, /^(?:PASSWORD|AUTH_PASSWORD|ADMIN_PASSWORD)=/m);
  assert.notEqual(content, await readFile(join(second, ".dev.vars"), "utf8"));
});

test("bootstrap refuses overwrite, including concurrent exclusive creation", async (t) => {
  const { bootstrapLocal } = await tooling("bootstrap-local");
  const directory = await temporary(t);
  const outcomes = await Promise.allSettled([bootstrapLocal(directory), bootstrapLocal(directory)]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const original = await readFile(join(directory, ".dev.vars"), "utf8");
  await assert.rejects(() => bootstrapLocal(directory), { code: "EEXIST" });
  assert.equal(await readFile(join(directory, ".dev.vars"), "utf8"), original);
});

test("bootstrap CLI works in temp only and preserves an existing production-origin file", async (t) => {
  const cwd = await temporary(t);
  const result = run("bootstrap-local", { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /pbkdf2-sha256\$/);
  const file = join(cwd, ".dev.vars");
  await writeFile(file, "PUBLIC_ORIGIN=https://mail.project.test\n");
  const again = run("bootstrap-local", { cwd });
  assert.equal(again.status, 1);
  assert.equal(await readFile(file, "utf8"), "PUBLIC_ORIGIN=https://mail.project.test\n");
});

test("preflight accepts configured public repository without an old-ID baseline", async () => {
  const { validateConfig } = await tooling("preflight");
  const result = validateConfig(config());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.secretsVerified, false);
  assert.match(result.warnings.join(" "), /offline|local/i);
});

test("preflight optionally compares old IDs and rejects malformed IDs and case-insensitive reuse", async () => {
  const { validateConfig } = await tooling("preflight");
  assert.equal(validateConfig(config(), { oldDatabaseIds: [] }).ok, true);
  assert.equal(validateConfig(config(), { oldDatabaseIds: [oldId, otherOldId] }).ok, true);
  for (const oldDatabaseIds of [
    null,
    "invalid",
    ["invalid"],
    [null],
    ["00000000-0000-0000-0000-000000000000"],
    [oldId, "invalid"],
  ]) {
    assert.equal(validateConfig(config(), { oldDatabaseIds }).ok, false);
  }
  assert.equal(validateConfig(config(), { oldDatabaseIds: [newId.toUpperCase()] }).ok, false);
  const candidate = config();
  candidate.d1_databases[0].preview_database_id = otherOldId.toUpperCase();
  assert.equal(validateConfig(candidate, { oldDatabaseIds: [oldId, otherOldId] }).ok, false);
});

test("preflight rejects wrong identities, placeholders, route/origin drift and plaintext vars", async () => {
  const { validateConfig } = await tooling("preflight");
  const changes = [
    (c) => {
      c.name = "other-worker";
    },
    (c) => {
      c.d1_databases[0].database_name = "other-db";
    },
    (c) => {
      c.d1_databases[0].binding = "OLD_DB";
    },
    (c) => {
      c.d1_databases[0].database_id = "00000000-0000-0000-0000-000000000000";
    },
    (c) => {
      c.d1_databases[0].database_id = "REPLACE_ME";
    },
    (c) => {
      c.d1_databases[0].database_id = oldId;
    },
    (c) => {
      c.d1_databases[0].preview_database_id = oldId;
    },
    (c) => {
      c.d1_databases.push({ ...c.d1_databases[0], database_id: oldId });
    },
    (c) => {
      c.d1_databases[0].remote = true;
    },
    (c) => {
      c.vars.PUBLIC_ORIGIN = "https://mail.project.test/";
    },
    (c) => {
      c.vars.PUBLIC_ORIGIN = "https://project.test";
    },
    (c) => {
      c.vars.PUBLIC_ORIGIN = "http://127.0.0.1:8787";
    },
    (c) => {
      c.vars.MAIL_DOMAIN = "not a hostname";
    },
    (c) => {
      c.vars.ADMIN_PASSWORD = "do-not-echo-this";
    },
    (c) => {
      c.vars.AUTH_PASSWORD_HASH = "do-not-echo-this";
    },
    (c) => {
      c.vars.MESSAGE_RETENTION_DAYS = "30";
    },
    (c) => {
      c.routes[0].pattern = "project.test";
    },
    (c) => {
      c.routes[0].custom_domain = false;
    },
    (c) => {
      c.workers_dev = true;
    },
    (c) => {
      c.preview_urls = true;
    },
    (c) => {
      c.env = { production: { vars: { ADMIN_PASSWORD: "do-not-echo-this" } } };
    },
    (c) => {
      c.route = "mail.project.test";
    },
    (c) => {
      c.vars.APP_NAME = "Other App";
    },
    (c) => {
      delete c.vars.APP_NAME;
    },
  ];
  for (const change of changes) {
    const candidate = config();
    change(candidate);
    const result = validateConfig(candidate, { oldDatabaseIds: [oldId] });
    assert.equal(result.ok, false, change.toString());
    assert.ok(result.errors.length > 0);
    assert.doesNotMatch(JSON.stringify(result), /do-not-echo-this/);
  }
});

test("preflight requires a nonzero 32-hex account ID", async () => {
  const { validateConfig } = await tooling("preflight");
  for (const account_id of [
    undefined,
    null,
    123,
    "",
    "REPLACE_WITH_YOUR_ACCOUNT_ID",
    "0".repeat(32),
    "a".repeat(31),
    "a".repeat(33),
    "g".repeat(32),
  ]) {
    assert.equal(validateConfig({ ...config(), account_id }).ok, false, String(account_id));
  }
  assert.equal(validateConfig({ ...config(), account_id: "A".repeat(32) }).ok, true);
});

test("preflight requires a literal HTTPS origin matching its sole custom-domain hostname", async () => {
  const { validateConfig } = await tooling("preflight");
  for (const origin of [
    undefined,
    null,
    42,
    "https://mail.project.test/",
    "https://mail.project.test/path",
    "https://mail.project.test?",
    "https://mail.project.test#",
    "https://user:pass@mail.project.test",
    "https://@mail.project.test",
    "http://mail.project.test",
    " https://mail.project.test",
    "https://mail.project.test\n",
    "https://MAIL.project.test",
    "https://mail.project.test:443",
    "https://mail.project.test/../",
    "https://mail.project.test\\path",
    "not a URL",
  ]) {
    const candidate = config();
    candidate.vars.PUBLIC_ORIGIN = origin;
    assert.equal(validateConfig(candidate).ok, false, String(origin));
  }
  for (const routes of [
    [],
    [null],
    [{ pattern: "*.project.test", custom_domain: true }],
    [{ pattern: "mail.project.test/*", custom_domain: true }],
    [...config().routes, ...config().routes],
  ]) {
    assert.equal(validateConfig({ ...config(), routes }).ok, false);
  }
  const candidate = config();
  candidate.vars.PUBLIC_ORIGIN = "https://mail.project.test:8443";
  assert.equal(validateConfig(candidate).ok, true, "an origin may include a nondefault HTTPS port");
});

test("preflight validates hostnames and rejects unconfigured example.com templates", async () => {
  const { validateConfig } = await tooling("preflight");
  for (const hostname of [
    undefined,
    null,
    42,
    "",
    "example.com",
    "mail.example.com",
    "EXAMPLE.COM",
    "localhost",
    "127.0.0.1",
    "[::1]",
    "https://project.test",
    "project.test/path",
    "project.test:443",
    "project.test.",
    "-mail.project.test",
    "mail-.project.test",
    "mail..project.test",
    "mail_project.test",
    `${"a".repeat(64)}.test`,
    `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`,
  ]) {
    const mail = config();
    mail.vars.MAIL_DOMAIN = hostname;
    assert.equal(validateConfig(mail).ok, false, `MAIL_DOMAIN: ${hostname}`);
    const web = config();
    web.routes[0].pattern = hostname;
    web.vars.PUBLIC_ORIGIN = `https://${hostname}`;
    assert.equal(validateConfig(web).ok, false, `route hostname: ${hostname}`);
  }
  for (const hostname of ["project.test", "mail.project.test"]) {
    const candidate = config();
    candidate.vars.MAIL_DOMAIN = hostname;
    candidate.routes[0].pattern = hostname;
    candidate.vars.PUBLIC_ORIGIN = `https://${hostname}`;
    assert.equal(validateConfig(candidate).ok, true);
  }
});

test("preflight rejects secret vars, invalid admin names and invalid preview UUIDs", async () => {
  const { validateConfig } = await tooling("preflight");
  for (const key of [
    "PASSWORD",
    "AUTH_PASSWORD_HASH",
    "passwd",
    "pwd",
    "SESSION_SECRET",
    "API_TOKEN",
    "API_KEY",
    "PRIVATE_KEY",
    "CREDENTIALS",
  ]) {
    const candidate = config();
    candidate.vars[key] = "do-not-echo-this";
    const result = validateConfig(candidate);
    assert.equal(result.ok, false, key);
    assert.doesNotMatch(JSON.stringify(result), /do-not-echo-this/);
  }
  for (const username of [undefined, null, "", "a b", "a".repeat(65)]) {
    const candidate = config();
    candidate.vars.ADMIN_USERNAME = username;
    assert.equal(validateConfig(candidate).ok, false);
  }
  for (const id of [null, "invalid", "00000000-0000-0000-0000-000000000000"]) {
    const candidate = config();
    candidate.d1_databases[0].preview_database_id = id;
    assert.equal(validateConfig(candidate).ok, false);
  }
});

test("preflight handles malformed config without crashing or exposing values", async () => {
  const { validateConfig } = await tooling("preflight");
  for (const candidate of [null, [], {}, { d1_databases: [null], vars: null, routes: [null] }]) {
    assert.equal(validateConfig(candidate, { oldDatabaseIds: [oldId] }).ok, false);
  }
});

test("preflight CLI reads JSONC locally, with clear limits and nonzero failures", async (t) => {
  const cwd = await temporary(t);
  const file = join(cwd, "wrangler.jsonc");
  const content = JSON.stringify(config(), null, 2).replace(/\n}$/, ",\n}");
  await writeFile(file, `// local fixture only\n${content}`);
  const result = run("preflight", { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /local|offline/i);
  assert.match(result.stdout, /secret.*not verified/i);
  const compared = run("preflight", {
    cwd,
    args: ["--config", file, "--old-db-id", oldId, "--old-db-id", otherOldId],
  });
  assert.equal(compared.status, 0, compared.stderr);
  for (const args of [
    ["--old-db-id", "invalid"],
    ["--old-db-id", newId.toUpperCase()],
    ["--old-db-id"],
    ["--config"],
  ]) {
    assert.equal(run("preflight", { cwd, args }).status, 1);
  }
  await writeFile(file, '{"vars":{"ADMIN_PASSWORD":"do-not-echo-this"},');
  const invalid = run("preflight", { cwd, args: ["--old-db-id", oldId] });
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /do-not-echo-this/);
  assert.equal(run("preflight", { cwd, args: ["--unknown"] }).status, 1);
});
