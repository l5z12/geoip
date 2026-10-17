import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { dataset } from "./fixtures";

// Run separately from unit tests: uses the real workerd runtime and a synthetic
// in-memory R2 database, never the production bucket or licensed MaxMind data.
const runtime = new Miniflare(convertV4MiniflareOptions({
  name: "geoip",
  modules: true,
  scriptPath: "dist/index.js",
  compatibilityDate: "2026-08-01",
  compatibilityFlags: ["nodejs_compat"],
  r2Buckets: ["GEOIP_DB"],
  serviceBindings: { ASSETS: async () => new Response("fixture assets") },
}));

try {
  const bucket = await runtime.getR2Bucket("GEOIP_DB");
  const data = dataset();
  for (const kind of ["country", "city", "asn"] as const) await bucket.put(data.manifest.files[kind].key, data[kind]);
  await bucket.put("manifest.json", JSON.stringify(data.manifest));
  // Concurrent cold requests exercise shared initialization in workerd, where
  // promises and streams have request ownership rules absent from unit tests.
  await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    const ip = index % 2 ? "1.1.1.1" : "2606:4700:4700::1111";
    const response = await runtime.dispatchFetch(`https://geoip.example/api/lookup?ip=${encodeURIComponent(ip)}`);
    const result = await response.json() as { country?: { code: string }; asn?: { number: number }; records?: { city?: { future_field?: { retained?: boolean } } } };
    if (response.status !== 200 || result.country?.code !== "US" || result.asn?.number !== 13335 || result.records?.city?.future_field?.retained !== true) {
      throw new Error(`workerd lookup failed (HTTP ${response.status})`);
    }
  }));
  const invalid = await runtime.dispatchFetch("https://geoip.example/api/lookup?ip=127.0.0.1");
  if (invalid.status !== 400) throw new Error("workerd accepted a private IP");
  console.log("workerd smoke test passed: concurrent cold requests, ranged R2, complete City/Country/ASN records, IPv4, IPv6, and validation");
} finally {
  await runtime.dispose();
}
