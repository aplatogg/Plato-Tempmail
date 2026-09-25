import { pbkdf2Sync } from "node:crypto";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const salt = "00112233445566778899aabbccddeeff";
const digest = Array.from(
  pbkdf2Sync("admin", Buffer.from(salt, "hex"), 100_000, 32, "sha256"),
  (byte) => byte.toString(16).padStart(2, "0"),
).join("");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          PUBLIC_ORIGIN: "https://mail.example.com",
          ADMIN_USERNAME: "admin",
          MAIL_DOMAIN: "example.com",
          MESSAGE_RETENTION_DAYS: "7",
          AUTH_PASSWORD_HASH: `pbkdf2-sha256$100000$${salt}$${digest}`,
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    }),
  ],
  test: { include: ["tests/*.test.ts"], testTimeout: 20_000, hookTimeout: 30_000 },
});
