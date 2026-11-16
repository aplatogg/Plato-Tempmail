import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

it("serves only public application assets with security headers", async () => {
  let fetches = 0;
  const bindings = {
    ...env,
    ASSETS: {
      async fetch() {
        fetches++;
        return new Response("public asset", { headers: { "content-type": "text/html" } });
      },
    },
  } as unknown as Env;
  const response = await worker.fetch(
    new Request("https://mail.example.com/"),
    bindings,
    createExecutionContext(),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("public asset");
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  for (const path of ["/api/unknown", "/.dev.vars", "/.gitkeep", "/src/auth.ts"]) {
    expect(
      (
        await worker.fetch(
          new Request(`https://mail.example.com${path}`),
          bindings,
          createExecutionContext(),
        )
      ).status,
    ).toBe(404);
  }
  expect(fetches).toBe(1);
});
