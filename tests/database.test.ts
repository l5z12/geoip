import { Buffer } from "node:buffer";
import { expect, test } from "bun:test";
import { AsyncMmdb } from "../src/mmdb";
import { DATABASE_KINDS } from "../src/manifest";
import { DatabaseStore, loadSnapshot, lookup } from "../src/database";
import { MAX_DATABASE_BYTES, parseManifest } from "../src/manifest";
import { validateDatabase } from "../scripts/shared";
import { dataset, fakeBucket, mmdb } from "./fixtures";

test("synthetic MMDBs pass real reader, downloader and lookup validation", async () => {
  const data = dataset();
  for (const kind of DATABASE_KINDS) expect(validateDatabase(kind, data[kind])).toBe(data.manifest.updatedAt);
  const { bucket } = fakeBucket(data);
  const snapshot = await loadSnapshot(bucket, data.manifest);
  for (const address of [{ ip: "8.8.8.8", version: 4 as const }, { ip: "2606:4700::1", version: 6 as const }]) {
    const result = await lookup(address, snapshot);
    expect(result.country?.code).toBe("US");
    expect(result.asn?.number).toBe(13335);
    expect(result.database.sources[0]?.name).toContain("MaxMind");
  }
  const full = await lookup({ ip: "8.8.8.8", version: 4 }, snapshot);
  expect(full.records.city?.future_field).toEqual({ retained: true });
  expect(full.records.city?.traits).toEqual({ is_anycast: true });
  expect(full.records.city?.city).toEqual({ geoname_id: 42, names: { en: "Test City", fr: "Ville test" } });
  async function reader(kind: "country" | "asn", value: unknown) {
    const data = mmdb(kind, undefined, value);
    return AsyncMmdb.open({ size: data.length, read: async (offset, length) => data.subarray(offset, offset + length) });
  }
  snapshot.readers.country = await reader("country", { registered_country: { iso_code: "US" } });
  snapshot.readers.asn = await reader("asn", {});
  const missing = await lookup({ ip: "8.8.8.8", version: 4 }, snapshot);
  expect(missing.country).toBeNull();
  expect(missing.asn).toBeNull();
  expect(missing.records.country).toEqual({ registered_country: { iso_code: "US" } });
});

test("sparse anycast-style records validate and remain location-unknown at runtime", async () => {
  for (const record of [{}, { registered_country: { iso_code: "US" } }, { traits: { is_anycast: true } }]) {
    const data = dataset(undefined, { country: record, city: record });
    for (const kind of DATABASE_KINDS) expect(validateDatabase(kind, data[kind])).toBe(data.manifest.updatedAt);
    const snapshot = await loadSnapshot(fakeBucket(data).bucket, data.manifest);
    for (const address of [{ ip: "1.1.1.1", version: 4 as const }, { ip: "2606:4700:4700::1111", version: 6 as const }]) {
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
    { schemaVersion: 3 }, { version: "../bad" }, { updatedAt: "yesterday" },
    { files: { ...good.files, country: { ...good.files.country, key: "manifest.json" } } },
    { files: { ...good.files, country: { ...good.files.country, bytes: MAX_DATABASE_BYTES } } },
  ]) expect(() => parseManifest({ ...good, ...change })).toThrow();
});

test("concurrent requests share one load, cached reads do not hit R2", async () => {
  const fake = fakeBucket();
  const store = new DatabaseStore(fake.bucket);
  const results = await Promise.all(Array.from({ length: 20 }, () => store.get()));
  expect(new Set(results.map(r => r.snapshot)).size).toBe(1);
  expect(fake.calls.length).toBe(4);
  await store.get();
  expect(fake.calls.length).toBe(4);
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
  await expect(new DatabaseStore(fakeBucket(expired).bucket).get()).rejects.toThrow("not available");
});
