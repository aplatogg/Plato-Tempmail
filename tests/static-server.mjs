import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

// Intentionally serves only the three public assets. APIs belong to Playwright mocks.
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
createServer(async (request, response) => {
  response.setHeader("Content-Security-Policy", csp);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  const path = new URL(request.url, "http://127.0.0.1:8788").pathname;
  if (path === "/__ready") {
    response.end("ready");
    return;
  }
  const asset = assets.get(path);
  if (!asset || !["GET", "HEAD"].includes(request.method)) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const content = await readFile(new URL(`../public/${asset[0]}`, import.meta.url));
    response.writeHead(200, { "Content-Type": asset[1] });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(8788, "127.0.0.1");
