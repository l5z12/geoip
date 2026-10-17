import { Buffer } from "node:buffer";
import { expect, test } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { PAGE_BYTES, type DatabaseFile } from "../src/manifest";
import { PageCache } from "../src/pages";
import { sha256 } from "../scripts/shared";
import { fakeBucket, fakeEdgePages, gate } from "./fixtures";

function fixture(fullPages = 2, beforeGet?: (key: string) => Promise<void>) {
  const bytes = Buffer.concat([
    ...Array.from({ length: fullPages }, (_, index) => Buffer.alloc(PAGE_BYTES, (index + 1) * 11)),
    Buffer.alloc(19, 33),
  ]);
  const file: DatabaseFile = {
    key: "pages.mmdb",
    bytes: bytes.length,
    sha256: sha256(bytes),
    buildEpoch: new Date().toISOString(),
    pageSha256: Array.from({ length: fullPages + 1 }, (_, index) =>
      sha256(bytes.subarray(index * PAGE_BYTES, (index + 1) * PAGE_BYTES)),
    ),
  };
  const fake = fakeBucket(undefined, beforeGet);
  fake.objects.set(file.key, bytes);
  return { ...fake, file, bytes };
}

test("page source reads across boundaries, verifies partial final pages and deduplicates requests", async () => {
  const f = fixture();
  const cache = new PageCache(f.bucket);
  const source = cache.source(f.file);
  const results = await Promise.all(
    Array.from({ length: 10 }, () => source.read(PAGE_BYTES - 2, 4)),
  );
  for (const result of results) expect([...result]).toEqual([11, 11, 22, 22]);
  expect(f.calls.length).toBe(2);
  expect([...(await source.read(PAGE_BYTES * 2 + 17, 2))]).toEqual([33, 33]);
  expect(cache.cachedBytes).toBe(f.bytes.length);
  expect(
    Buffer.from(await source.read(PAGE_BYTES - 3, PAGE_BYTES + 22)).equals(
      f.bytes.subarray(PAGE_BYTES - 3),
    ),
  ).toBe(true);
  expect(await source.read(f.file.bytes, 0)).toHaveLength(0);
  expect(f.calls).toHaveLength(3);
  await expect(source.read(-1, 1)).rejects.toThrow("bounds");
  await expect(source.read(f.file.bytes, 1)).rejects.toThrow("bounds");
  await expect(source.read(0, 2 * 1024 * 1024)).rejects.toThrow("bounds");
});

test("a boundary-spanning read starts both page downloads before either finishes", async () => {
  const reads = gate();
  const f = fixture(2, () => reads.promise);
  const pending = new PageCache(f.bucket).source(f.file).read(PAGE_BYTES - 2, 4);
  try {
    await sleep(0);
    expect(f.calls).toHaveLength(2);
  } finally {
    reads.release();
    expect([...(await pending)]).toEqual([11, 11, 22, 22]);
  }
});

test("parallel page reads retain the shared eight-download limit", async () => {
  const reads = gate();
  const f = fixture(12, () => reads.promise);
  const cache = new PageCache(f.bucket, PAGE_BYTES * 2);
  const pending = Promise.all(Array.from({ length: 12 }, (_, index) => cache.page(f.file, index)));
  try {
    await sleep(0);
    expect(f.calls).toHaveLength(8);
  } finally {
    reads.release();
    await pending;
  }
  expect(f.calls).toHaveLength(12);
  expect(cache.cachedBytes).toBeLessThanOrEqual(PAGE_BYTES * 2);
});

test("LRU cache stays within its cap across datasets/generations", async () => {
  const f = fixture();
  const cache = new PageCache(f.bucket, PAGE_BYTES);
  await cache.page(f.file, 0);
  await cache.page(f.file, 1);
  expect(cache.cachedBytes).toBe(PAGE_BYTES);
  await cache.page(f.file, 0);
  expect(f.calls.length).toBe(3);
  await cache.page(f.file, 2);
  expect(cache.cachedBytes).toBe(19);
});

test("corrupt, missing, or wrong-sized objects never enter the page cache", async () => {
  const f = fixture();
  const cache = new PageCache(f.bucket);
  f.objects.set(f.file.key, Buffer.alloc(f.file.bytes));
  await expect(cache.page(f.file, 0)).rejects.toThrow("integrity");
  expect(cache.cachedBytes).toBe(0);
  f.objects.delete(f.file.key);
  await expect(cache.page(f.file, 0)).rejects.toThrow("unavailable");
  f.objects.set(f.file.key, Buffer.alloc(3));
  await expect(cache.page(f.file, 0)).rejects.toThrow("integrity");
  f.objects.set(f.file.key, f.bytes);
  expect((await cache.page(f.file, 0))[0]).toBe(11);
});

test("verified edge pages survive an empty isolate cache without further R2 reads", async () => {
  const f = fixture();
  const { edge, entries } = fakeEdgePages();
  const first = new PageCache(f.bucket, PAGE_BYTES, edge);
  for (const index of [0, 1, 2]) await first.page(f.file, index);
  expect(f.calls).toHaveLength(3);
  const restarted = new PageCache(f.bucket, PAGE_BYTES, edge);
  for (const index of [0, 1, 2])
    expect(Buffer.from(await restarted.page(f.file, index))).toEqual(
      f.bytes.subarray(index * PAGE_BYTES, (index + 1) * PAGE_BYTES),
    );
  expect(f.calls).toHaveLength(3);
  expect(restarted.cachedBytes).toBeLessThanOrEqual(PAGE_BYTES);
  for (const [key, response] of entries) {
    expect(key).toContain(f.file.sha256);
    expect(key).not.toContain("ip=");
    expect(response.headers.get("Cache-Control")).toContain("max-age=86400");
  }
});

test("corrupt edge pages are revalidated and replaced from R2", async () => {
  const f = fixture();
  const { edge, entries } = fakeEdgePages();
  await new PageCache(f.bucket, PAGE_BYTES, edge).page(f.file, 0);
  const key = [...entries.keys()][0]!;
  for (const response of [
    new Response(Buffer.alloc(PAGE_BYTES), { headers: { "Content-Length": String(PAGE_BYTES) } }),
    new Response("short", { headers: { "Content-Length": String(PAGE_BYTES) } }),
    new Response("wrong-size", { headers: { "Content-Length": "10" } }),
  ]) {
    entries.set(key, response);
    expect((await new PageCache(f.bucket, PAGE_BYTES, edge).page(f.file, 0))[0]).toBe(11);
  }
  expect(f.calls).toHaveLength(4);
  expect(new Uint8Array(await entries.get(key)!.arrayBuffer())[0]).toBe(11);
});

test("edge cache failures are optional; corrupt R2 data still fails closed", async () => {
  const f = fixture();
  const { edge, storage } = fakeEdgePages();
  storage.match = async () => {
    throw new Error("cache unavailable");
  };
  storage.put = async () => {
    throw new Error("cache unavailable");
  };
  expect((await new PageCache(f.bucket, PAGE_BYTES, edge).page(f.file, 0))[0]).toBe(11);
  edge.open = async () => {
    throw new Error("cache unavailable");
  };
  expect((await new PageCache(f.bucket, PAGE_BYTES, edge).page(f.file, 0))[0]).toBe(11);
  f.objects.set(f.file.key, Buffer.alloc(f.file.bytes));
  await expect(new PageCache(f.bucket, PAGE_BYTES, edge).page(f.file, 0)).rejects.toThrow(
    "integrity",
  );
});

test("edge entries do not leak across database generations", async () => {
  const f = fixture();
  const { edge } = fakeEdgePages();
  await new PageCache(f.bucket, PAGE_BYTES, edge).page(f.file, 0);
  const bytes = Buffer.from(f.bytes);
  bytes.fill(44, 0, PAGE_BYTES);
  const next = {
    ...f.file,
    sha256: sha256(bytes),
    pageSha256: [sha256(bytes.subarray(0, PAGE_BYTES)), ...f.file.pageSha256.slice(1)],
  };
  f.objects.set(f.file.key, bytes);
  expect((await new PageCache(f.bucket, PAGE_BYTES, edge).page(next, 0))[0]).toBe(44);
  expect(f.calls).toHaveLength(2);
});
