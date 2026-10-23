import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dataset } from "./fixtures";
import { D1_SCHEMA, releaseMetadata } from "../src/d1-schema";
import { addDatabase, exportSql } from "../scripts/build-d1";
import { DATABASE_KINDS } from "../src/manifest";

const data = dataset(undefined, {}, 0, true);
const options = {
  name: "geoip",
  modules: true,
  scriptPath: "dist/index.js",
  compatibilityDate: "2026-08-01",
  compatibilityFlags: ["nodejs_compat"],
  r2Buckets: ["GEOIP_DB"],
  d1Databases: ["GEOIP_LOOKUP"],
  bindings: { GEOIP_VERSION: data.manifest.version },
  serviceBindings: { ASSETS: async () => new Response("fixture assets") },
};
const runtime = new Miniflare(convertV4MiniflareOptions(options));
const sql = new DatabaseSync(":memory:");
const directory = await mkdtemp(join(tmpdir(), "geoip-d1-smoke-"));
let files: string[] = [];
try {
  sql.exec(D1_SCHEMA);
  for (const [index, kind] of DATABASE_KINDS.entries()) await addDatabase(sql, index, data[kind]);
  sql
    .prepare("INSERT INTO metadata VALUES (1, ?, 0)")
    .run(JSON.stringify(releaseMetadata(data.manifest)));
  files = await exportSql(sql, pathToFileURL(directory + "/"));
  const d1 = await runtime.getD1Database("GEOIP_LOOKUP");
  for (const file of files) await d1.exec(await readFile(file, "utf8"));
  const unready = await runtime.dispatchFetch("https://geoip.example/api/lookup?ip=1.1.1.1");
  if (unready.status !== 503) throw new Error("workerd served an unready import");
  await d1.exec("UPDATE metadata SET ready = 1 WHERE id = 1");
  // R2 remains completely empty. Fresh, concurrent and restarted lookups must
  // all use D1, with no MMDB pages or per-IP cache involved.
  async function lookups() {
    await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const ip = index % 2 ? "1.1.1.1" : "2606:4700:4700::1111";
        const response = await runtime.dispatchFetch(
          "https://geoip.example/api/lookup?ip=" + encodeURIComponent(ip),
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
        )
          throw new Error("workerd D1 lookup failed: HTTP " + response.status);
      }),
    );
  }
  await lookups();
  const invalid = await runtime.dispatchFetch("https://geoip.example/api/lookup?ip=127.0.0.1");
  if (invalid.status !== 400) throw new Error("workerd accepted a private IP");
  await runtime.setOptions(
    convertV4MiniflareOptions({
      ...options,
      bindings: { ...options.bindings, TEST_GENERATION: "2" },
    }),
  );
  await lookups();
  const status = await runtime.dispatchFetch("https://geoip.example/api/status");
  if (status.status !== 200) throw new Error("workerd D1 status failed");
  console.log(
    "workerd passed: SQL import, unready release rejection, concurrent IPv4/IPv6 lookups, complete records, isolate restart, and empty R2",
  );
} finally {
  sql.close();
  await runtime.dispose();
  for (const file of files) await unlink(file);
  await rmdir(directory);
}
