import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { dataset } from "./fixtures";

// Run separately from unit tests: uses the real workerd runtime and a synthetic
// in-memory R2 database, never the production bucket or licensed MaxMind data.
const options = {
  name: "geoip",
  modules: true,
  scriptPath: "dist/index.js",
  compatibilityDate: "2026-08-01",
  compatibilityFlags: ["nodejs_compat"],
  r2Buckets: ["GEOIP_DB"],
  serviceBindings: { ASSETS: async () => new Response("fixture assets") },
};
const runtime = new Miniflare(convertV4MiniflareOptions(options));

try {
  const bucket = await runtime.getR2Bucket("GEOIP_DB");
  const data = dataset(undefined, {}, 0, true);
  for (const kind of ["country", "city", "asn"] as const)
    await bucket.put(data.manifest.files[kind].key, data[kind]);
  await bucket.put("manifest.json", JSON.stringify(data.manifest));
  // Concurrent cold requests exercise shared initialization in workerd, where
  // promises and streams have request ownership rules absent from unit tests.
  await Promise.all(
    Array.from({ length: 12 }, async (_, index) => {
      const ip = index % 2 ? "1.1.1.1" : "2606:4700:4700::1111";
      const response = await runtime.dispatchFetch(
        `https://geoip.example/api/lookup?ip=${encodeURIComponent(ip)}`,
      );
      const result = (await response.json()) as {
        country?: { code: string };
        asn?: { number: number };
        records?: { city?: { future_field?: { retained?: boolean } } };
      };
      if (
        response.status !== 200 ||
        !response.headers.get("Server-Timing")?.includes("lookup;dur=") ||
        result.country?.code !== "US" ||
        result.asn?.number !== 13335 ||
        result.records?.city?.future_field?.retained !== true
      ) {
        throw new Error(`workerd lookup failed (HTTP ${response.status})`);
      }
    }),
  );
  const invalid = await runtime.dispatchFetch("https://geoip.example/api/lookup?ip=127.0.0.1");
  if (invalid.status !== 400) throw new Error("workerd accepted a private IP");

  const pageCache = await (await runtime.getCaches()).open("geoip-mmdb-pages-v1");
  const pageKey = `https://geoip.example/__geoip_pages/${data.manifest.files.city.sha256}/262144/0`;
  const cached = await pageCache.match(pageKey);
  if (!cached || (await cached.arrayBuffer()).byteLength !== 262144)
    throw new Error("workerd did not persist a verified database page in the named cache");
  const internal = await runtime.dispatchFetch(pageKey);
  if ((await internal.text()) !== "fixture assets")
    throw new Error("internal page cache was exposed as a public route");

  // Reset the Worker isolate, keep the edge cache, and remove local R2 MMDBs.
  // A successful lookup must now come from verified edge pages, not process memory.
  for (const kind of ["country", "city", "asn"] as const)
    await bucket.delete(data.manifest.files[kind].key);
  await runtime.setOptions(
    convertV4MiniflareOptions({ ...options, bindings: { TEST_GENERATION: "2" } }),
  );
  const restarted = await runtime.dispatchFetch("https://geoip.example/api/lookup?ip=1.1.1.1");
  const restored = (await restarted.json()) as {
    records?: { city?: { future_field?: { retained?: boolean } } };
  };
  if (restarted.status !== 200 || !restored.records?.city?.future_field?.retained)
    throw new Error("cold isolate could not reuse verified edge pages");
  console.log(
    "workerd smoke test passed: concurrent scattered reads, complete records, IPv4/IPv6, validation, timing headers, private named cache, and cache reuse after isolate restart without R2 MMDBs",
  );
} finally {
  await runtime.dispose();
}
