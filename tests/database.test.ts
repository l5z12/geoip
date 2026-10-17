import { Buffer } from "node:buffer";
import { expect, test } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { AsyncMmdb } from "../src/mmdb";
import { DATABASE_KINDS, PAGE_BYTES } from "../src/manifest";
import { DatabaseStore, loadSnapshot, lookup } from "../src/database";
import { MAX_DATABASE_BYTES, parseManifest } from "../src/manifest";
import { validateDatabase } from "../scripts/shared";
import { dataset, fakeBucket, gate, mmdb } from "./fixtures";

test("synthetic MMDBs pass real reader, downloader and lookup validation", async () => {
  const data = dataset();
  for (const kind of DATABASE_KINDS)
    expect(validateDatabase(kind, data[kind])).toBe(data.manifest.updatedAt);
  const { bucket } = fakeBucket(data);
  const snapshot = await loadSnapshot(bucket, data.manifest);
  for (const address of [
    { ip: "8.8.8.8", version: 4 as const },
    { ip: "2606:4700::1", version: 6 as const },
  ]) {
    const result = await lookup(address, snapshot);
    expect(result.country?.code).toBe("US");
    expect(result.asn?.number).toBe(13335);
    expect(result.database.sources[0]?.name).toContain("MaxMind");
  }
  const full = await lookup({ ip: "8.8.8.8", version: 4 }, snapshot);
  expect(full.records.city?.future_field).toEqual({ retained: true });
  expect(full.records.city?.traits).toEqual({ is_anycast: true });
  expect(full.records.city?.city).toEqual({
    geoname_id: 42,
    names: { en: "Test City", fr: "Ville test" },
  });
  async function reader(kind: "country" | "asn", value: unknown) {
    const data = mmdb(kind, undefined, value);
    return AsyncMmdb.open({
      size: data.length,
      read: async (offset, length) => data.subarray(offset, offset + length),
    });
  }
  snapshot.readers.country = await reader("country", { registered_country: { iso_code: "US" } });
  snapshot.readers.asn = await reader("asn", {});
  const missing = await lookup({ ip: "8.8.8.8", version: 4 }, snapshot);
  expect(missing.country).toBeNull();
  expect(missing.asn).toBeNull();
  expect(missing.records.country).toEqual({ registered_country: { iso_code: "US" } });
});

test("sparse anycast-style records validate and remain location-unknown at runtime", async () => {
  for (const record of [
    {},
    { registered_country: { iso_code: "US" } },
    { traits: { is_anycast: true } },
  ]) {
    const data = dataset(undefined, { country: record, city: record });
    for (const kind of DATABASE_KINDS)
      expect(validateDatabase(kind, data[kind])).toBe(data.manifest.updatedAt);
    const snapshot = await loadSnapshot(fakeBucket(data).bucket, data.manifest);
    for (const address of [
      { ip: "1.1.1.1", version: 4 as const },
      { ip: "2606:4700:4700::1111", version: 6 as const },
    ]) {
      const result = await lookup(address, snapshot);
      expect(result.country).toBeNull();
      expect(result.records.country).toEqual(record);
      expect(result.records.city).toEqual(record);
      expect(result.asn?.number).toBe(13335);
    }
  }
});

test("manifests reject invalid keys, schemas and excessive memory", () => {
  const good = dataset().manifest;
  expect(parseManifest(good)).toEqual(good);
  for (const change of [
    { schemaVersion: 3 },
    { version: "../bad" },
    { updatedAt: "yesterday" },
    { files: { ...good.files, country: { ...good.files.country, key: "manifest.json" } } },
    { files: { ...good.files, country: { ...good.files.country, bytes: MAX_DATABASE_BYTES } } },
  ])
    expect(() => parseManifest({ ...good, ...change })).toThrow();
});

test("concurrent requests share one load, cached reads do not hit R2", async () => {
  const fake = fakeBucket();
  const store = new DatabaseStore(fake.bucket);
  const results = await Promise.all(Array.from({ length: 20 }, () => store.get()));
  expect(new Set(results.map((r) => r.snapshot)).size).toBe(1);
  expect(fake.calls.length).toBe(4);
  await store.get();
  expect(fake.calls.length).toBe(4);
});

test("cold initialization overlaps metadata reads across all three databases", async () => {
  const reads = gate();
  const data = dataset(undefined, {}, PAGE_BYTES * 3);
  const fake = fakeBucket(data, () => reads.promise);
  const pending = loadSnapshot(fake.bucket, data.manifest);
  try {
    await sleep(0);
    // Each metadata tail straddles two pages; all six requests must start
    // before any completes, rather than six sequential storage round trips.
    expect(fake.calls).toHaveLength(6);
    for (const kind of DATABASE_KINDS)
      expect(fake.calls.filter((key) => key === data.manifest.files[kind].key)).toHaveLength(2);
  } finally {
    reads.release();
    await pending;
  }
});

test("warm requests serve a validated snapshot while one background refresh switches generations", async () => {
  let now = Math.floor(Date.now() / 1000) * 1000;
  const old = dataset(now / 1000 - 3600);
  const refresh = gate();
  let hold = false;
  const fake = fakeBucket(old, async () => {
    if (hold) await refresh.promise;
  });
  const store = new DatabaseStore(fake.bucket, () => now);
  const first = await store.get();
  const next = dataset(now / 1000);
  fake.install(next);
  hold = true;
  now += 300_001;
  const background: Promise<unknown>[] = [];
  const context = {
    waitUntil(promise: Promise<unknown>) {
      background.push(promise);
    },
  };
  try {
    const response = await store.get(context);
    expect(response.snapshot).toBe(first.snapshot);
    expect(response.stale).toBe(false);
    expect((await store.get(context)).snapshot).toBe(first.snapshot);
    expect(background).toHaveLength(2);
    expect(background[0]).toBe(background[1]);
    expect(fake.calls.filter((key) => key === "manifest.json")).toHaveLength(2);
  } finally {
    refresh.release();
    await Promise.all(background);
  }
  expect((await store.get(context)).snapshot.manifest.version).toBe(next.manifest.version);
});

test("background refresh failure reports stale, throttles retries and recovers", async () => {
  let now = Date.now();
  const fake = fakeBucket();
  const store = new DatabaseStore(fake.bucket, () => now);
  const first = await store.get();
  fake.objects.delete("manifest.json");
  now += 300_001;
  const background: Promise<unknown>[] = [];
  const context = {
    waitUntil(promise: Promise<unknown>) {
      background.push(promise);
    },
  };
  expect((await store.get(context)).snapshot).toBe(first.snapshot);
  await Promise.all(background);
  const calls = fake.calls.length;
  expect((await store.get(context)).stale).toBe(true);
  expect(fake.calls).toHaveLength(calls);
  fake.install(dataset());
  now += 30_001;
  await store.get(context);
  await Promise.all(background);
  expect((await store.get(context)).stale).toBe(false);
});

test("cold requests with a context still wait for validation", async () => {
  const reads = gate();
  const fake = fakeBucket(undefined, () => reads.promise);
  const store = new DatabaseStore(fake.bucket);
  const background: Promise<unknown>[] = [];
  let returned = false;
  const pending = store
    .get({
      waitUntil(promise) {
        background.push(promise);
      },
    })
    .then((result) => {
      returned = true;
      return result;
    });
  try {
    await sleep(0);
    expect(returned).toBe(false);
    expect(background).toHaveLength(0);
  } finally {
    reads.release();
    await pending;
  }
});

test("an expiring snapshot cannot bypass an already pending background refresh", async () => {
  let now = Math.floor(Date.now() / 1000) * 1000;
  const old = dataset(now / 1000 - 30 * 86400 + 600);
  const refresh = gate();
  let hold = false;
  const fake = fakeBucket(old, async () => {
    if (hold) await refresh.promise;
  });
  const store = new DatabaseStore(fake.bucket, () => now);
  await store.get();
  now += 300_001;
  hold = true;
  const background: Promise<unknown>[] = [];
  const context = {
    waitUntil(promise: Promise<unknown>) {
      background.push(promise);
    },
  };
  await store.get(context);
  now += 300_001;
  let returned = false;
  const expired = store.get(context).then(
    () => {
      returned = true;
    },
    () => {
      returned = true;
    },
  );
  try {
    await sleep(0);
    expect(returned).toBe(false);
    expect(background).toHaveLength(1);
  } finally {
    refresh.release();
    await Promise.all([...background, expired]);
  }
  await expect(store.get(context)).rejects.toThrow("not available");
});

test("bad refresh keeps old pair, throttles retries, then atomically switches both", async () => {
  let now = Math.floor(Date.now() / 1000) * 1000;
  const old = dataset(now / 1000 - 3600);
  const fake = fakeBucket(old);
  const store = new DatabaseStore(fake.bucket, () => now);
  expect((await store.get()).snapshot.manifest.version).toBe(old.manifest.version);
  const next = dataset(now / 1000);
  fake.install(next);
  fake.objects.set(next.manifest.files.asn.key, Buffer.alloc(next.asn.length));
  now += 300001;
  const stale = await store.get();
  expect(stale.stale).toBe(true);
  expect(stale.snapshot.manifest.version).toBe(old.manifest.version);
  const calls = fake.calls.length;
  await store.get();
  expect(fake.calls.length).toBe(calls);
  fake.install(next);
  now += 30001;
  const fresh = await store.get();
  expect(fresh.stale).toBe(false);
  expect(fresh.snapshot.manifest.version).toBe(next.manifest.version);
});

test("cold failures return unavailable and recover after retry interval", async () => {
  let now = Date.now();
  const fake = fakeBucket();
  fake.objects.delete("manifest.json");
  const store = new DatabaseStore(fake.bucket, () => now);
  await expect(store.get()).rejects.toThrow("not available");
  fake.install(dataset());
  await expect(store.get()).rejects.toThrow("not available");
  expect(fake.calls.length).toBe(1);
  now += 30001;
  expect((await store.get()).stale).toBe(false);
});

test("checksum, truncation, metadata and expiry are enforced", async () => {
  const data = dataset();
  const fake = fakeBucket(data);
  fake.objects.set(data.manifest.files.country.key, Buffer.alloc(data.country.length));
  await expect(loadSnapshot(fake.bucket, data.manifest)).rejects.toThrow("integrity");
  fake.objects.set(data.manifest.files.country.key, Buffer.alloc(3));
  await expect(loadSnapshot(fake.bucket, data.manifest)).rejects.toThrow("integrity");
  fake.install(data);
  const mismatch = structuredClone(data.manifest);
  mismatch.files.country.buildEpoch = "2000-01-01T00:00:00.000Z";
  await expect(loadSnapshot(fake.bucket, mismatch)).rejects.toThrow("metadata");
  const expired = dataset(Math.floor(Date.now() / 1000) - 31 * 86400);
  expect(() => validateDatabase("country", expired.country)).toThrow("freshness");
  await expect(new DatabaseStore(fakeBucket(expired).bucket).get()).rejects.toThrow(
    "not available",
  );
});
