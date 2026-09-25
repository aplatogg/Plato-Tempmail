import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMain } from "./cli.mjs";
import { hashPassword } from "./password-hash.mjs";

export async function bootstrapLocal(directory = process.cwd()) {
  const verifier = await hashPassword("admin");
  const content = [
    "# Local test credentials only. Never upload this file as production secrets.",
    "PUBLIC_ORIGIN=http://127.0.0.1:8787",
    "ADMIN_USERNAME=admin",
    `AUTH_PASSWORD_HASH=${verifier}`,
    "",
  ].join("\n");
  const file = join(directory, ".dev.vars");
  // wx is atomic exclusive creation; it also refuses existing symlinks and concurrent writers.
  await writeFile(file, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return file;
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("No command-line arguments are supported.");
    await bootstrapLocal();
    process.stderr.write("Created .dev.vars for local admin/admin at http://127.0.0.1:8787.\n");
  } catch (error) {
    process.stderr.write(
      error.code === "EEXIST"
        ? ".dev.vars already exists; nothing was overwritten.\n"
        : "Local bootstrap failed; check the directory and file permissions.\n",
    );
    process.exitCode = 1;
  }
}
