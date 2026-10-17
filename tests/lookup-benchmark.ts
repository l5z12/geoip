import { DatabaseStore, lookup } from "../src/database";
import { PAGE_BYTES } from "../src/manifest";
import { dataset, fakeBucket } from "./fixtures";

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

async function measure(name: string, operation: () => Promise<unknown>) {
  const calls = fake.calls.length;
  const start = performance.now();
  await operation();
  console.log(
    `${name}: ${(performance.now() - start).toFixed(1)} ms, ${fake.calls.length - calls} R2 reads`,
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
