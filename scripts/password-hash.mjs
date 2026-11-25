import { pbkdf2, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { isMain } from "./cli.mjs";

const derive = promisify(pbkdf2);
const MAX_LENGTH = 1024;
const MAX_INPUT_BYTES = 4098;

function validatePassword(password) {
  if (typeof password !== "string" || !password.trim()) {
    throw new Error("Password must not be blank.");
  }
  // Match the application's JS string.length limit; do not normalize Unicode or trim secrets.
  if (password.length > MAX_LENGTH) throw new Error("Password exceeds 1024 UTF-16 code units.");
  if (/[\r\n]/u.test(password)) throw new Error("Password must be a single line.");
  return password;
}

export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const material = Buffer.from(password, "utf8");
  try {
    const digest = await derive(material, salt, 100_000, 32, "sha256");
    return `pbkdf2-sha256$100000$${salt.toString("hex")}$${digest.toString("hex")}`;
  } finally {
    material.fill(0);
  }
}

export function readPassword(input = process.stdin, output = process.stderr) {
  return new Promise((resolve, reject) => {
    const tty = Boolean(input.isTTY);
    const previousRaw = Boolean(input.isRaw);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let text = "";
    let bytes = 0;
    let finished = false;
    let rawEnabled = false;

    function finish(error, password) {
      if (finished) return;
      finished = true;
      input.pause();
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      input.removeListener("close", onClose);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      try {
        if (rawEnabled) input.setRawMode(previousRaw);
        if (tty) output.write("\n");
      } catch {
        error ??= new Error("Could not restore terminal mode.");
      }
      text = "";
      if (error) reject(error);
      else resolve(password);
    }

    function onError() {
      finish(new Error("Could not read password input."));
    }

    function onClose() {
      finish(new Error("Password input closed before completion."));
    }

    function onSignal() {
      finish(new Error("Password input cancelled."));
    }

    function onEnd() {
      if (tty) return finish(new Error("Password input ended before Enter."));
      try {
        text += decoder.decode();
        // A pipe may append exactly one LF or CRLF. Other whitespace is part of the password.
        finish(null, validatePassword(text.replace(/\r?\n$/u, "")));
      } catch (error) {
        finish(error instanceof TypeError ? new Error("Input must be valid UTF-8.") : error);
      }
    }

    function onData(chunk) {
      try {
        const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        bytes += data.byteLength;
        // Bound input before decoding/accumulation, including pasted input and pipes without EOF.
        if (bytes > MAX_INPUT_BYTES) throw new Error("Password input exceeds the byte limit.");
        const decoded = decoder.decode(data, { stream: true });
        if (!tty) {
          text += decoded;
          return;
        }
        for (const character of decoded) {
          if (character === "\x03" || character === "\x04") return onSignal();
          if (character === "\r" || character === "\n") {
            return finish(null, validatePassword(text));
          }
          if (character === "\x7f" || character === "\b") {
            text = Array.from(text).slice(0, -1).join("");
          } else if (character === "\x15") {
            text = "";
          } else if (character < " " || character === "\x1b") {
            throw new Error("Unsupported terminal control key; retry using text and Backspace.");
          } else {
            text += character;
          }
          if (text.length > MAX_LENGTH) throw new Error("Password exceeds 1024 UTF-16 code units.");
        }
      } catch (error) {
        finish(error instanceof TypeError ? new Error("Input must be valid UTF-8.") : error);
      }
    }

    try {
      if (tty) {
        if (typeof input.setRawMode !== "function")
          throw new Error("Hidden TTY input unavailable.");
        input.setRawMode(true);
        rawEnabled = true;
        output.write("Password (hidden): ");
      }
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("error", onError);
      input.once("close", onClose);
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      input.resume();
    } catch {
      finish(new Error("Could not initialize hidden password input."));
    }
  });
}

if (isMain(import.meta.url)) {
  try {
    // No arguments or environment-variable password sources: neither is a secret-input channel.
    if (process.argv.length !== 2)
      throw new Error("Use hidden TTY input or a UTF-8 stdin pipe only.");
    const password = await readPassword();
    process.stdout.write(`${await hashPassword(password)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
