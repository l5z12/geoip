import { Buffer } from "node:buffer";
import { expect, test } from "bun:test";
import { PAGE_BYTES, type DatabaseFile } from "../src/manifest";
import { PageCache } from "../src/pages";
import { sha256 } from "../scripts/shared";
import { fakeBucket } from "./fixtures";

function fixture() {
  const bytes = Buffer.concat([Buffer.alloc(PAGE_BYTES, 11), Buffer.alloc(PAGE_BYTES, 22), Buffer.alloc(19, 33)]);
  const file: DatabaseFile = {
    key: "pages.mmdb", bytes: bytes.length, sha256: sha256(bytes), buildEpoch: new Date().toISOString(),
    pageSha256: [sha256(bytes.subarray(0, PAGE_BYTES)), sha256(bytes.subarray(PAGE_BYTES, PAGE_BYTES * 2)), sha256(bytes.subarray(PAGE_BYTES * 2))],
  };
  const fake = fakeBucket();
  fake.objects.set(file.key, bytes);
  return { ...fake, file, bytes };
}

test("page source reads across boundaries, verifies partial final pages and deduplicates requests", async () => {
  const f = fixture();
  const cache = new PageCache(f.bucket);
  const source = cache.source(f.file);
  const results = await Promise.all(Array.from({ length: 10 }, () => source.read(PAGE_BYTES - 2, 4)));
  for (const result of results) expect([...result]).toEqual([11, 11, 22, 22]);
  expect(f.calls.length).toBe(2);
  expect([...await source.read(PAGE_BYTES * 2 + 17, 2)]).toEqual([33, 33]);
  expect(cache.cachedBytes).toBe(f.bytes.length);
  await expect(source.read(-1, 1)).rejects.toThrow("bounds");
  await expect(source.read(f.file.bytes, 1)).rejects.toThrow("bounds");
  await expect(source.read(0, 2 * 1024 * 1024)).rejects.toThrow("bounds");
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
