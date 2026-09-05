import { cleanupDatabases } from "./cleanup";
import { DatabaseUnavailable, getStore, lookup } from "./database";
import { IpError, parseIp } from "./ip";
import { PageUnavailable } from "./pages";
import { databaseInfo } from "./manifest";

export interface Env {
  GEOIP_DB: R2Bucket;
  ASSETS: Fetcher;
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
};

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const response = Response.json(body, { status, headers });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function error(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname !== "/api/lookup" && url.pathname !== "/api/status") {
    return error("NOT_FOUND", "API endpoint not found.", 404);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Cache-Control": "no-store",
    } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = error("METHOD_NOT_ALLOWED", "Use GET for this endpoint.", 405);
    response.headers.set("Allow", "GET, HEAD, OPTIONS");
    return response;
  }
  try {
    if (url.pathname === "/api/status") {
      const { snapshot, stale } = await getStore(env.GEOIP_DB).get();
      return json({ status: stale ? "degraded" : "ok", database: databaseInfo(snapshot.manifest, stale) });
    }
    const values = url.searchParams.getAll("ip");
    if (values.length > 1) return error("INVALID_IP", "Supply only one IP address.", 400);
    // Cloudflare sets these headers at the edge. Never trust X-Forwarded-For.
    // CF-Connecting-IPv6 preserves the real visitor address with Pseudo IPv4 enabled.
    const input = values.length ? values[0]! :
      request.headers.get("CF-Connecting-IPv6") || request.headers.get("CF-Connecting-IP");
    if (!input) {
      return error("CLIENT_IP_UNAVAILABLE", "Your IP is unavailable here. Enter an IP address explicitly.", 400);
    }
    const address = parseIp(input);
    const { snapshot, stale } = await getStore(env.GEOIP_DB).get();
    return json(await lookup(address, snapshot, stale));
  } catch (cause) {
    if (cause instanceof IpError) return error(cause.code, cause.message, 400);
    if (cause instanceof DatabaseUnavailable || cause instanceof PageUnavailable) {
      const response = error("DATABASE_UNAVAILABLE", new DatabaseUnavailable().message, 503);
      response.headers.set("Retry-After", "30");
      return response;
    }
    return error("INTERNAL_ERROR", "The lookup could not be completed.", 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    if (isApi) {
      response = await api(request, env, url);
      // Explicit-address queries are public. Do not expose a visitor's IP to
      // arbitrary websites via CORS; that endpoint is intentionally same-origin.
      if (url.pathname === "/api/status" || url.searchParams.has("ip")) {
        response.headers.set("Access-Control-Allow-Origin", "*");
      }
    } else {
      response = await env.ASSETS.fetch(request);
    }
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await cleanupDatabases(env.GEOIP_DB);
  },
} satisfies ExportedHandler<Env>;
