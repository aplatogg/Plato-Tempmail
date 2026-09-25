import { readFile } from "node:fs/promises";
import ts from "typescript";
import { isMain } from "./cli.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value) => typeof value === "string" && UUID.test(value) && value !== ZERO_UUID;

function validHostname(value) {
  if (typeof value !== "string" || value.length > 253) return false;
  const labels = value.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) &&
    /[a-z]/i.test(labels.at(-1)) &&
    !/(^|\.)example\.com$/i.test(value)
  );
}

function httpsOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    // Exact comparison also rejects URL-parser normalization, trailing delimiters and whitespace.
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      value === url.origin &&
      validHostname(url.hostname)
      ? url
      : null;
  } catch {
    return null;
  }
}

export function validateConfig(config, { oldDatabaseIds = [] } = {}) {
  const errors = [];
  const warnings = [
    "Offline local configuration check only; only explicitly supplied old database IDs are compared.",
    "Live secrets not verified. D1 existence, ownership and new provisioning are not verified.",
    "DNS, Email Routing, deployment and SMTP delivery are not verified.",
  ];
  const check = (condition, message) => {
    if (!condition) errors.push(message);
  };
  const baselineValid = Array.isArray(oldDatabaseIds) && oldDatabaseIds.every(validId);
  check(
    baselineValid,
    "Optional --old-db-id values must each be a nonzero database UUID (repeatable).",
  );
  const oldIds = new Set(baselineValid ? oldDatabaseIds.map((id) => id.toLowerCase()) : []);
  const c = record(config) ? config : {};
  check(c.name === "plato-tempmail", "Worker name must be plato-tempmail.");
  check(
    typeof c.account_id === "string" &&
      /^[0-9a-f]{32}$/i.test(c.account_id) &&
      c.account_id !== "0".repeat(32),
    "Replace account_id with your nonzero 32-hex Cloudflare account ID.",
  );
  check(c.workers_dev === false, "workers_dev must be false.");
  check(c.preview_urls === false, "preview_urls must be false.");
  const route = Array.isArray(c.routes) && c.routes.length === 1 ? c.routes[0] : null;
  check(
    record(route) && validHostname(route.pattern) && route.custom_domain === true,
    "Use exactly one custom-domain route with a configured hostname (not example.com).",
  );
  check(c.route === undefined, "Remove the alternative singular route field.");
  check(
    c.env === undefined || (record(c.env) && Object.keys(c.env).length === 0),
    "Named environment overrides are not covered by this preflight; use the reviewed root config.",
  );
  const vars = record(c.vars) ? c.vars : {};
  const origin = httpsOrigin(vars.PUBLIC_ORIGIN);
  check(
    origin !== null && record(route) && origin.hostname === route.pattern,
    "PUBLIC_ORIGIN must be an exact HTTPS origin matching the custom-domain hostname, without credentials, path, query or hash.",
  );
  check(
    validHostname(vars.MAIL_DOMAIN),
    "MAIL_DOMAIN must be a configured hostname (not example.com).",
  );
  check(vars.APP_NAME === "Plato-Tempmail", "APP_NAME must be Plato-Tempmail.");
  check(vars.MESSAGE_RETENTION_DAYS === "7", "MESSAGE_RETENTION_DAYS must be 7 for this release.");
  check(
    typeof vars.ADMIN_USERNAME === "string" && /^[a-zA-Z0-9_.-]{1,64}$/.test(vars.ADMIN_USERNAME),
    "ADMIN_USERNAME must be a valid configured username.",
  );
  check(
    !Object.keys(vars).some((key) => /password|passwd|pwd|secret|token|credential|key/i.test(key)),
    "Remove passwords, password hashes and secrets from vars; use Wrangler secret put.",
  );
  const databases = Array.isArray(c.d1_databases) ? c.d1_databases : [];
  check(databases.length === 1, "Configure exactly one dedicated D1 database binding.");
  const db = record(databases[0]) ? databases[0] : {};
  check(db.binding === "DB", "D1 binding must be DB.");
  check(db.database_name === "plato-tempmail-db", "D1 database_name must be plato-tempmail-db.");
  check(validId(db.database_id), "Replace the placeholder database_id with the new D1 UUID.");
  for (const database of databases) {
    if (!record(database)) continue;
    for (const key of ["database_id", "preview_database_id"]) {
      if (database[key] === undefined) continue;
      check(validId(database[key]), "D1 identifiers must be non-placeholder UUIDs.");
      check(
        typeof database[key] === "string" && !oldIds.has(database[key].toLowerCase()),
        "D1 identifier reuses a previous database; provision a separate plato-tempmail-db.",
      );
    }
    check(database.remote !== true, "Remove remote: true from the local D1 binding config.");
  }
  return { ok: errors.length === 0, errors, warnings, secretsVerified: false };
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const oldDatabaseIds = [];
    let file = "wrangler.jsonc";
    for (let i = 0; i < args.length; i += 2) {
      if (!args[i + 1] || !["--old-db-id", "--config"].includes(args[i])) {
        throw new Error("arguments");
      }
      if (args[i] === "--old-db-id") oldDatabaseIds.push(args[i + 1]);
      else file = args[i + 1];
    }
    // TypeScript is already a direct dev dependency and parses JSONC without evaluating code.
    const parsed = ts.parseConfigFileTextToJson(file, await readFile(file, "utf8"));
    if (parsed.error) throw new Error("parse");
    const result = validateConfig(parsed.config, { oldDatabaseIds });
    for (const warning of result.warnings) process.stdout.write(`${warning}\n`);
    for (const error of result.errors) process.stderr.write(`FAIL: ${error}\n`);
    if (result.ok)
      process.stdout.write("Local preflight passed. This is not a deployment check.\n");
    else process.exitCode = 1;
  } catch {
    // Parser diagnostics may contain secret values: never echo raw config or exceptions.
    process.stderr.write(
      "Preflight failed: check local JSONC and arguments. Usage: node scripts/preflight.mjs " +
        "[--config wrangler.jsonc] [--old-db-id UUID ...]\n",
    );
    process.exitCode = 1;
  }
}
