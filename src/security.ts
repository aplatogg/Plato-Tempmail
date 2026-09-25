import type { AppConfig, Env } from "./types";

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 503;

export class ApiError extends Error {
  constructor(
    public readonly status: ErrorStatus,
    public readonly code: string,
    message: string,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function configurationError(): never {
  throw new ApiError(503, "NOT_CONFIGURED", "Service configuration is unavailable.");
}

export function readConfig(env: Env): AppConfig {
  let url: URL;
  try {
    url = new URL(env.PUBLIC_ORIGIN);
  } catch {
    return configurationError();
  }
  const secure = url.protocol === "https:";
  const local =
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!secure && !local) || url.origin !== env.PUBLIC_ORIGIN || url.username || url.password) {
    return configurationError();
  }
  if (
    typeof env.ADMIN_USERNAME !== "string" ||
    !/^[a-zA-Z0-9_.-]{1,64}$/.test(env.ADMIN_USERNAME)
  ) {
    return configurationError();
  }
  const domain = env.MAIL_DOMAIN;
  if (
    typeof domain !== "string" ||
    domain.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
  ) {
    return configurationError();
  }
  if (!/^(?:[1-9]|[12][0-9]|30)$/.test(env.MESSAGE_RETENTION_DAYS)) return configurationError();
  return {
    origin: url.origin,
    secure,
    username: env.ADMIN_USERNAME,
    mailDomain: domain,
    retentionDays: Number(env.MESSAGE_RETENTION_DAYS),
  };
}

export function checkOrigin(request: Request, config: AppConfig): void {
  const origin = request.headers.get("origin");
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (
    new URL(request.url).origin !== config.origin ||
    (origin !== null && origin !== config.origin) ||
    (mutation && origin !== config.origin)
  ) {
    throw new ApiError(403, "ORIGIN_REJECTED", "Request origin is not allowed.");
  }
}

export function secureResponse(response: Response, request: Request): Response {
  const result = new Response(response.body, response);
  result.headers.set("Cache-Control", "no-store");
  result.headers.set("X-Content-Type-Options", "nosniff");
  result.headers.set("X-Frame-Options", "DENY");
  result.headers.set("Referrer-Policy", "no-referrer");
  result.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  result.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  if (new URL(request.url).protocol === "https:") {
    // Do not impose a transport policy on unrelated subdomains.
    result.headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  return result;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256(value: string): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  );
}

export async function readJson(
  request: Request,
  maxBytes = 4096,
): Promise<Record<string, unknown>> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  ) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json.");
  }
  const length = request.headers.get("content-length");
  if (length && Number(length) > maxBytes)
    throw new ApiError(413, "BODY_TOO_LARGE", "Request body is too large.");
  if (!request.body) throw new ApiError(400, "INVALID_JSON", "A JSON object is required.");

  // Check actual bytes, not only Content-Length: chunked bodies are attacker-controlled.
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "BODY_TOO_LARGE", "Request body is too large.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ApiError(400, "INVALID_JSON", "A JSON object is required.");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_JSON", "A valid UTF-8 JSON object is required.");
  } finally {
    reader.releaseLock();
  }
}
