import { DatabaseStore, loadSnapshot, lookup } from "../src/database";
import { PAGE_BYTES } from "../src/manifest";
import { PageCache } from "../src/pages";
import { dataset, fakeBucket, fakeEdgePages } from "./fixtures";

// Synthetic R2 round trips, not a prediction of production latency. Padding
// places metadata across two pages, separate from the tree/data separator.
const delayMs = 100;
const data = dataset(undefined, {}, PAGE_BYTES * 3);
const fake = fakeBucket(data, () => new Promise((resolve) => setTimeout(resolve, delayMs)));
let now = Date.now();
const store = new DatabaseStore(fake.bucket, () => now);
const background: Promise<unknown>[] = [];
const context = {
  waitUntil(promise: Promise<unknown>) {
    background.push(promise);
  },
};

async function measure(name: string, operation: () => Promise<unknown>, bucket = fake) {
  const calls = bucket.calls.length;
  const start = performance.now();
  await operation();
  console.log(
    `${name}: ${(performance.now() - start).toFixed(1)} ms, ${bucket.calls.length - calls} R2 reads`,
  );
}

console.log(`Synthetic benchmark: ${delayMs} ms per R2 read; three paged MMDB fixtures`);
const get = () => store.get(context);
await measure("Cold status/database initialization", get);
await measure("Warm IPv4 lookup", async () =>
  lookup({ ip: "1.1.1.1", version: 4 }, (await get()).snapshot),
);
await measure("Warm IPv6 lookup", async () =>
  lookup({ ip: "2606:4700:4700::1111", version: 6 }, (await get()).snapshot),
);
now += 300_001;
await measure("Lookup when manifest recheck is due", async () =>
  lookup({ ip: "1.1.1.1", version: 4 }, (await get()).snapshot),
);
await Promise.all(background);

console.log("\nScattered record fields; in-memory edge-cache simulation (not edge latency):");
const scattered = dataset(undefined, {}, 0, true);
const bucket = fakeBucket(scattered, () => new Promise((resolve) => setTimeout(resolve, delayMs)));
const { edge } = fakeEdgePages();
function newIsolate() {
  const cache = new PageCache(bucket.bucket, undefined, edge);
  return new DatabaseStore(bucket.bucket, Date.now, (bucket, manifest) =>
    loadSnapshot(bucket, manifest, cache),
  );
}
let isolate = newIsolate();
await measure(
  "Cold IPv4 lookup with empty caches",
  async () => lookup({ ip: "1.1.1.1", version: 4 }, (await isolate.get()).snapshot),
  bucket,
);
isolate = newIsolate();
await measure(
  "Cold isolate reusing verified edge pages",
  async () => lookup({ ip: "1.1.1.1", version: 4 }, (await isolate.get()).snapshot),
  bucket,
);
await measure(
  "Warm scattered IPv6 lookup",
  async () => lookup({ ip: "2606:4700:4700::1111", version: 6 }, (await isolate.get()).snapshot),
  bucket,
);
