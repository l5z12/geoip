import { expect, test } from "vitest";
import worker, { type Env } from "../src/index";
import { fakeBucket } from "./fixtures";

function environment(): Env {
  return {
    GEOIP_DB: fakeBucket().bucket,
    ASSETS: {
      fetch: async () => new Response("static page", { headers: { "Content-Type": "text/html" } }),
    } as unknown as Fetcher,
  };
}
const req = (path: string, init?: RequestInit) => new Request(`https://geoip.example${path}`, init);

test("explicit dual-stack lookups return JSON with CORS and no shared caching", async () => {
  const env = environment();
  for (const ip of ["1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    const response = await worker.fetch(req(`/api/lookup?ip=${encodeURIComponent(ip)}`), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Server-Timing")).toMatch(
      /^database;dur=\d+\.\d, lookup;dur=\d+\.\d$/,
    );
    expect(response.headers.get("Access-Control-Expose-Headers")).toBe("Server-Timing");
    expect(((await response.json()) as { country: { code: string } }).country.code).toBe("US");
  }
});

test("caller IP trusts edge headers only and is not exposed through CORS", async () => {
  const env = environment();
  const response = await worker.fetch(
    req("/api/lookup", {
      headers: {
        "CF-Connecting-IP": "240.1.1.1",
        "CF-Connecting-IPv6": "2606:4700::1111",
        "X-Forwarded-For": "8.8.8.8",
      },
    }),
    env,
  );
  expect(response.status).toBe(200);
  expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  expect(response.headers.has("Access-Control-Expose-Headers")).toBe(false);
  expect(((await response.json()) as { ip: string }).ip).toBe("2606:4700::1111");
  const missing = await worker.fetch(
    req("/api/lookup", { headers: { "X-Forwarded-For": "8.8.8.8" } }),
    env,
  );
  expect(missing.status).toBe(400);
  expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
    "CLIENT_IP_UNAVAILABLE",
  );
});

test("empty, repeated, invalid and nonpublic query values return 400 before loading data", async () => {
  const fake = fakeBucket();
  const env = { ...environment(), GEOIP_DB: fake.bucket };
  for (const query of ["ip=", "ip=1.1.1.1&ip=8.8.8.8", "ip=hostname", "ip=127.0.0.1"]) {
    expect((await worker.fetch(req(`/api/lookup?${query}`), env)).status).toBe(400);
  }
  expect(fake.calls).toHaveLength(0);
});

test("status, HEAD, OPTIONS, unsupported methods and unknown endpoints", async () => {
  const env = environment();
  const status = await worker.fetch(req("/api/status"), env);
  expect(status.headers.get("Server-Timing")).toMatch(/^database;dur=\d+\.\d$/);
  expect(((await status.json()) as { status: string }).status).toBe("ok");
  const head = await worker.fetch(req("/api/lookup?ip=1.1.1.1", { method: "HEAD" }), env);
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  const options = await worker.fetch(req("/api/lookup?ip=1.1.1.1", { method: "OPTIONS" }), env);
  expect(options.status).toBe(204);
  expect(options.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  const post = await worker.fetch(req("/api/lookup", { method: "POST" }), env);
  expect(post.status).toBe(405);
  expect(post.headers.get("Allow")).toContain("GET");
  expect((await worker.fetch(req("/api/unknown"), env)).status).toBe(404);
});

test("missing databases are a retryable 503; static pages remain available", async () => {
  const fake = fakeBucket();
  fake.objects.clear();
  const env = { ...environment(), GEOIP_DB: fake.bucket };
  const response = await worker.fetch(req("/api/lookup?ip=1.1.1.1"), env);
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("30");
  const page = await worker.fetch(req("/"), env);
  expect(await page.text()).toBe("static page");
  expect(page.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
  expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
});
