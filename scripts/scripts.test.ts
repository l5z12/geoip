import { Buffer } from "node:buffer";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { extractArchive, MAX_ARCHIVE_BYTES, MAX_EXPANDED_BYTES } from "./download-databases";
import { ensureBucket } from "./ensure-bucket";
import { publicationPlan, publishMode, validateLocal } from "./publish-databases";
import { EDITIONS, pageDigests, sha256, validateDatabase, versionFor } from "./shared";
import { DATABASE_KINDS, PAGE_BYTES, type Manifest } from "../src/manifest";
import { dataset, mmdb } from "../tests/fixtures";

function archive(entries: { name: string; bytes?: Buffer; type?: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const { name, bytes = Buffer.from("fixture"), type = "0" } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124, 12);
    header.fill(32, 148, 156);
    header.write(type, 156, 1);
    header.write("ustar\0", 257, 6);
    const sum = header.reduce((a: number, b: number) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

describe("bounded archive extraction", () => {
  test("extracts only expected MMDB and local license notices", () => {
    const result = extractArchive(archive([
      { name: "GeoLite2-Country_20260101/GeoLite2-Country.mmdb", bytes: Buffer.from("database") },
      { name: "GeoLite2-Country_20260101/LICENSE.txt", bytes: Buffer.from("license") },
      { name: "GeoLite2-Country_20260101/COPYRIGHT.txt", bytes: Buffer.from("copyright") },
    ]), "GeoLite2-Country");
    expect(result.database.toString()).toBe("database");
    expect(result.notices["LICENSE.txt"]!.toString()).toBe("license");
  });
  test("rejects traversal, absolute paths and links", () => {
    for (const name of ["../GeoLite2-Country.mmdb", "/GeoLite2-Country.mmdb", "C:/GeoLite2-Country.mmdb", "a\\GeoLite2-Country.mmdb"]) {
      expect(() => extractArchive(archive([{ name }]), "GeoLite2-Country")).toThrow();
    }
    expect(() => extractArchive(archive([{ name: "GeoLite2-Country.mmdb", type: "2" }]), "GeoLite2-Country")).toThrow();
  });
  test("rejects missing/duplicate database, malformed gzip, and decompression bomb", () => {
    expect(() => extractArchive(archive([{ name: "GeoLite2-ASN.mmdb" }]), "GeoLite2-Country")).toThrow();
    expect(() => extractArchive(archive([{ name: "GeoLite2-Country.mmdb" }, { name: "other/GeoLite2-Country.mmdb" }]), "GeoLite2-Country")).toThrow();
    expect(() => extractArchive(Buffer.from("bad"), "GeoLite2-Country")).toThrow();
    const member = gzipSync(Buffer.alloc(1024 * 1024));
    expect(() => extractArchive(Buffer.concat(Array.from({ length: 385 }, () => member)), "GeoLite2-Country")).toThrow();
  });
});

test("archive caps permit City and extraction retains its notices", () => {
  expect(MAX_ARCHIVE_BYTES).toBe(256 * 1024 * 1024);
  expect(MAX_EXPANDED_BYTES).toBe(384 * 1024 * 1024);
  for (const kind of DATABASE_KINDS) {
    const edition = EDITIONS[kind];
    const result = extractArchive(archive([
      { name: `${edition}/${edition}.mmdb`, bytes: Buffer.from(kind) },
      { name: `${edition}/COPYRIGHT.txt`, bytes: Buffer.from("notice") },
    ]), edition);
    expect(result.database.toString()).toBe(kind);
    expect(result.notices["COPYRIGHT.txt"]!.toString()).toBe("notice");
  }
});

test("page hashes include every full page and the short final page", () => {
  const bytes = Buffer.alloc(PAGE_BYTES * 2 + 17, 42);
  bytes[PAGE_BYTES] = 1;
  expect(pageDigests(bytes)).toEqual([
    sha256(bytes.subarray(0, PAGE_BYTES)), sha256(bytes.subarray(PAGE_BYTES, PAGE_BYTES * 2)), sha256(bytes.subarray(PAGE_BYTES * 2)),
  ]);
  expect(pageDigests(bytes.subarray(0, PAGE_BYTES))).toEqual([sha256(bytes.subarray(0, PAGE_BYTES))]);
});

test("City validates dual-stack country and coordinates without requiring a city name", () => {
  const epoch = Math.floor(Date.now() / 1000);
  const record = { country: { iso_code: "US" }, location: { latitude: 0, longitude: 0 } };
  expect(validateDatabase("city", mmdb("city", epoch, record))).toBe(new Date(epoch * 1000).toISOString());
  for (const bad of [
    { country: { iso_code: "US" } },
    { ...record, country: { iso_code: "bad" } },
    { ...record, location: { latitude: 91, longitude: 0 } },
    { ...record, location: { latitude: 0, longitude: 181 } },
    { ...record, location: { latitude: "0", longitude: 0 } },
  ]) expect(() => validateDatabase("city", mmdb("city", epoch, bad))).toThrow("city MMDB failed");
  expect(() => validateDatabase("city", mmdb("country", epoch, record))).toThrow();
  expect(() => validateDatabase("city", mmdb("city", epoch - 31 * 86400))).toThrow();
  expect(() => validateDatabase("city", mmdb("city", epoch + 3 * 86400))).toThrow();
});

test("publication revalidates three databases, pages, full hashes and manifest identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "geoip-publish-"));
  const dataDir = pathToFileURL(dir + "/");
  const data = dataset();
  try {
    for (const kind of DATABASE_KINDS) await writeFile(new URL(`${kind}.mmdb`, dataDir), data[kind]);
    const save = async (manifest: unknown) => writeFile(new URL("manifest.json", dataDir), JSON.stringify(manifest));
    await save(data.manifest);
    expect(await validateLocal(dataDir)).toEqual(data.manifest);
    const mutations: ((m: Manifest) => void)[] = [
      m => { m.files.city.pageSha256[0] = "0".repeat(64); },
      m => { m.files.city.sha256 = "0".repeat(64); },
      m => { m.files.city.buildEpoch = new Date(0).toISOString(); },
      m => { m.updatedAt = new Date(0).toISOString(); },
      m => { m.files.city.pageSha256 = []; },
      m => { m.version = "0".repeat(64); for (const k of DATABASE_KINDS) m.files[k].key = `versions/${m.version}/${k}.mmdb`; },
    ];
    for (const mutate of mutations) {
      const manifest = structuredClone(data.manifest);
      mutate(manifest);
      await save(manifest);
      await expect(validateLocal(dataDir)).rejects.toThrow();
    }
    await save({ ...data.manifest, schemaVersion: 1 });
    await expect(validateLocal(dataDir)).rejects.toThrow();
    await save(data.manifest);
    const corrupted = Buffer.from(data.city);
    corrupted[0] = corrupted[0]! ^ 1;
    await writeFile(new URL("city.mmdb", dataDir), corrupted);
    await expect(validateLocal(dataDir)).rejects.toThrow("city database differs");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("content-derived versions preserve ordered digests", () => {
  const country = sha256("country");
  const city = sha256("city");
  const asn = sha256("asn");
  expect(versionFor({ country, city, asn })).toBe(sha256(country + city + asn));
  expect(versionFor({ country, city, asn })).not.toBe(versionFor({ country: asn, city, asn: country }));
  expect(versionFor({ country, city, asn })).not.toBe(versionFor({ country, city: sha256("changed"), asn }));
});
test("malformed MMDB rejected without revealing lookup inputs", () => {
  expect(() => validateDatabase("country", Buffer.from("not MMDB"))).toThrow("country MMDB failed");
});
test("publication commits immutable manifest before active pointer", () => {
  const manifest = { version: "v", files: { country: { key: "versions/v/country.mmdb" }, city: { key: "versions/v/city.mmdb" }, asn: { key: "versions/v/asn.mmdb" } } } as Manifest;
  expect(publicationPlan(manifest).map(p => p.key)).toEqual([
    "versions/v/country.mmdb", "versions/v/city.mmdb", "versions/v/asn.mmdb", "versions/v/manifest.json", "manifest.json",
  ]);
  expect(publishMode([])).toBe("--remote");
  expect(publishMode(["--local"])).toBe("--local");
  expect(() => publishMode(["--local", "--remote"])).toThrow();
});

describe("Cloudflare bucket ensure", () => {
  const ok = () => Response.json({ success: true, result: { name: "geoip-databases" } });
  function mock(responses: Response[]) {
    const methods: string[] = [];
    const request = (async (_url: unknown, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    }) as typeof fetch;
    return { methods, request };
  }
  test("existing bucket does not create", async () => {
    const m = mock([ok()]);
    await ensureBucket("account", "token", "geoip-databases", m.request);
    expect(m.methods).toEqual(["GET"]);
  });
  test("404 creates, then verifies; conflict also requires verification", async () => {
    for (const response of [ok(), new Response(null, { status: 409 })]) {
      const m = mock([new Response(null, { status: 404 }), response, ok()]);
      await ensureBucket("account", "token", "geoip-databases", m.request);
      expect(m.methods).toEqual(["GET", "POST", "GET"]);
    }
  });
  test("authorization errors never trigger create", async () => {
    const m = mock([new Response(null, { status: 403 })]);
    await expect(ensureBucket("account", "token", "geoip-databases", m.request)).rejects.toThrow("refusing to create");
    expect(m.methods).toEqual(["GET"]);
  });
  test("unconfirmed conflict fails", async () => {
    const m = mock([new Response(null, { status: 404 }), new Response(null, { status: 409 }), new Response(null, { status: 404 })]);
    await expect(ensureBucket("account", "token", "geoip-databases", m.request)).rejects.toThrow("could not be confirmed");
  });
});
