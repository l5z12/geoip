import { expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Reader } from "mmdb-lib";
import { mkdir, mkdtemp, readFile, rm, unlink, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  addDatabase,
  buildD1,
  capacityLimit,
  exportSql,
  fullImport,
  localLookup,
  patchImport,
  rowLimit,
  sqlValue,
  startsBlock,
  BLOCK_MAX_RANGES,
  PROBES,
  RESET_SQL,
  type BuildStats,
} from "./build-d1";
import {
  acquireLease,
  activate,
  chooseSlot,
  Cloudflare,
  MAX_BASE_AGE_MS,
  MismatchError,
  patchBase,
  readyRelease,
  releaseLease,
  validateRemote,
} from "./d1-release";
import { D1_SCHEMA, releaseMetadata } from "../src/d1-schema";
import { DATABASE_KINDS } from "../src/manifest";
import { dataset, treeMmdb } from "../tests/fixtures";

test.each([24, 28, 32] as const)(
  "%i-bit MMDB traversal agrees with the independent reader across boundaries, blocks and gaps",
  async (width) => {
    const bytes = treeMmdb(
      width,
      ["8.8.8.0/24", "9.9.9.9/32", "2606:4700::/112", "2606:4700:0:1::/128", "2001:4860::/32"],
      ["2001::/32", "2002::/16"],
    );
    const reference = new Reader(bytes);
    // The fixture really aliases 6to4 and Teredo to the IPv4 tree.
    expect(reference.get("2002:808:808::")).toEqual(reference.get("8.8.8.8"));
    expect(reference.get("2001:0:909:909::")).toEqual(reference.get("9.9.9.9"));
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(D1_SCHEMA);
      await addDatabase(db, 0, bytes, 2);
      expect(db.prepare("SELECT COUNT(*) AS n FROM records").get()!.n).toBe(1);
      // IPv4 [8.8.8.0, 9.9.9.9]; IPv6 [2001:4860::, 2606:4700::] and [2606:4700:0:1::].
      expect(
        db
          .prepare("SELECT family, json_array_length(data) AS n FROM blocks ORDER BY family, start")
          .all(),
      ).toEqual([
        { family: 4, n: 2 },
        { family: 6, n: 2 },
        { family: 6, n: 1 },
      ]);
      for (const ip of [
        "8.8.7.255",
        "8.8.8.0",
        "8.8.8.255",
        "8.8.9.0",
        "9.9.9.8",
        "9.9.9.9",
        "9.9.9.10",
        "2001:4860::",
        "2001:4860:ffff:ffff:ffff:ffff:ffff:ffff",
        "2001:4861::",
        "2606:46ff:ffff:ffff:ffff:ffff:ffff:ffff",
        "2606:4700::",
        "2606:4700::ffff",
        "2606:4700::1:0",
        "2606:4700:0:1::",
        "2606:4700:0:1::1",
      ]) {
        const [record, prefix] = reference.getWithPrefixLength(ip);
        const result = localLookup(db, ip)[0];
        expect(result ? JSON.parse(result.data) : null, ip).toEqual(record);
        if (record) expect(result?.prefix, ip).toBe(prefix);
      }
      for (const ip of ["2002:808:808::", "2001:0:909:909::"])
        expect(localLookup(db, ip), ip).toEqual([]);
    } finally {
      db.close();
    }
  },
);

test("SQL export round-trips arbitrary strings with bounded statements and no transactions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "geoip-d1-export-"));
  const db = new DatabaseSync(":memory:"),
    restored = new DatabaseSync(":memory:");
  let files: string[] = [];
  try {
    db.exec(D1_SCHEMA);
    const insert = db.prepare("INSERT INTO records VALUES (?, ?)");
    for (let i = 0; i < 1500; i++)
      insert.run(i, JSON.stringify({ name: "O'Brien;\n中文😀".repeat(30), i }));
    files = await exportSql(db, pathToFileURL(dir + "/"));
    const sql = await readFile(files[0]!, "utf8");
    expect(sql).not.toMatch(/BEGIN|COMMIT/);
    for (const statement of sql.trim().split("\n"))
      expect(Buffer.byteLength(statement)).toBeLessThan(90_001);
    restored.exec(sql);
    expect(restored.prepare("SELECT * FROM records").all()).toEqual(
      db.prepare("SELECT * FROM records").all(),
    );
    expect(sqlValue("'")).toBe("''''");
    expect(() => sqlValue(NaN)).toThrow();
  } finally {
    db.close();
    restored.close();
    for (const file of files) await unlink(file);
    await rmdir(dir);
  }
});

test("full build validates probes, reports size, and exports an unready release", async () => {
  const dir = await mkdtemp(join(tmpdir(), "geoip-d1-build-"));
  const url = pathToFileURL(dir + "/"),
    data = dataset();
  let files: string[] = [];
  try {
    for (const kind of DATABASE_KINDS) await writeFile(new URL(`${kind}.mmdb`, url), data[kind]);
    const build = await buildD1(data.manifest, url);
    expect(build.ranges).toBe(6);
    expect(build.blocks).toBe(6);
    expect(build.records).toBe(3);
    expect(build.bytes).toBeGreaterThan(0);
    ({ files } = await fullImport(build, url));
    const restored = new DatabaseSync(":memory:");
    try {
      for (const file of files) restored.exec(await readFile(file, "utf8"));
      expect(restored.prepare("SELECT ready, patch_from FROM metadata").get()).toEqual({
        ready: 0,
        patch_from: null,
      });
    } finally {
      restored.close();
    }
    await expect(buildD1(data.manifest, url, 1)).rejects.toThrow("D1_MAX_BYTES");
    // 6 blocks + 3 records + the metadata insert and its `ready` UPDATE.
    await expect(fullImport(build, url, 10)).rejects.toThrow(
      "D1 import would write 11 rows, above D1_MAX_ROWS=10",
    );
  } finally {
    for (const file of files) await unlink(file);
    for (const kind of DATABASE_KINDS) await unlink(new URL(`${kind}.mmdb`, url));
    await unlink(new URL("lookup.sqlite", url));
    await rmdir(dir);
  }
  expect(capacityLimit("500000000")).toBe(500000000);
  for (const value of ["0", "-1", "10000000001", "NaN"])
    expect(() => capacityLimit(value)).toThrow();
  expect(rowLimit("")).toBe(1_500_000);
  expect(rowLimit("250000")).toBe(250000);
  for (const value of ["0", "-1", "100000001", "1.5", "NaN"])
    expect(() => rowLimit(value)).toThrow();
});

test("an inserted or removed range moves only nearby block boundaries", () => {
  const key = (value: number) => (0x08000000 + value).toString(16).padStart(8, "0");
  function boundaries(starts: string[]) {
    const result: string[] = [];
    let length = 0;
    for (const start of starts) {
      if (!result.length || startsBlock(start, length)) {
        result.push(start);
        length = 0;
      }
      length++;
    }
    return result;
  }
  const starts = Array.from({ length: 20_000 }, (_, i) => key(i * 4));
  const before = boundaries(starts);
  // About 64 ranges per block, as with the previous fixed-size blocks.
  expect(starts.length / before.length).toBeGreaterThan(48);
  expect(starts.length / before.length).toBeLessThan(80);
  for (const edited of [
    [...starts.slice(0, 7_000), key(27_998), ...starts.slice(7_000)],
    [...starts.slice(0, 7_000), ...starts.slice(7_001)],
  ]) {
    const after = boundaries(edited);
    const moved =
      before.filter((start) => !after.includes(start)).length +
      after.filter((start) => !before.includes(start)).length;
    expect(moved).toBeLessThanOrEqual(4);
  }
  expect(startsBlock(key(0), BLOCK_MAX_RANGES)).toBe(true);
});

test("a patch turns the slot's release into the new build and is safe to rerun", async () => {
  const dir = await mkdtemp(join(tmpdir(), "geoip-d1-patch-"));
  const url = pathToFileURL(dir + "/"),
    baseUrl = new URL("base/", url),
    epoch = Math.floor(Date.now() / 1000);
  const asn = (number: number) => ({
    autonomous_system_number: number,
    autonomous_system_organization: `Network ${number}`,
  });
  const before = dataset(epoch, { asn: asn(64512) }),
    after = dataset(epoch, { asn: asn(64513) });
  const restored = new DatabaseSync(":memory:");
  try {
    await mkdir(baseUrl);
    for (const kind of DATABASE_KINDS) {
      await writeFile(new URL(`${kind}.mmdb`, baseUrl), before[kind]);
      await writeFile(new URL(`${kind}.mmdb`, url), after[kind]);
    }
    const base = await buildD1(before.manifest, baseUrl);
    const build = await buildD1(after.manifest, url);
    for (const file of (await fullImport(base, baseUrl)).files)
      restored.exec(await readFile(file, "utf8"));
    restored.exec("UPDATE metadata SET ready = 1");
    const patch = (await patchImport(build, base, before.manifest.version, url))!;
    // The ASN record is replaced and its IPv4 and IPv6 blocks rewritten; the
    // Country and City rows are untouched although their MMDB files differ.
    expect(patch.rows).toBe(1 + 1 + 2 + 2);
    expect(patch.from).toBe(before.manifest.version);
    const expected = new DatabaseSync(build.path, { readOnly: true });
    try {
      // The second pass reruns a patch over its own result, as after an
      // interrupted import.
      for (let pass = 0; pass < 2; pass++) {
        for (const file of patch.files) restored.exec(await readFile(file, "utf8"));
        for (const query of [
          "SELECT * FROM records ORDER BY id",
          "SELECT * FROM blocks ORDER BY kind, family, start",
        ])
          expect(restored.prepare(query).all()).toEqual(expected.prepare(query).all());
        expect(restored.prepare("SELECT data, ready, patch_from FROM metadata").get()).toEqual({
          data: expected.prepare("SELECT data FROM metadata").get()!.data,
          ready: 0,
          patch_from: before.manifest.version,
        });
      }
    } finally {
      expected.close();
    }
    await expect(patchImport(build, base, before.manifest.version, url, 5)).rejects.toThrow(
      "D1 import would write 6 rows, above D1_MAX_ROWS=5",
    );
    // When every record changes, a full import writes fewer rows.
    const unrelated = dataset(epoch, {
      country: { country: { iso_code: "CA" } },
      city: { country: { iso_code: "CA" } },
      asn: asn(64514),
    });
    for (const kind of DATABASE_KINDS)
      await writeFile(new URL(`${kind}.mmdb`, baseUrl), unrelated[kind]);
    const other = await buildD1(unrelated.manifest, baseUrl);
    expect(await patchImport(build, other, unrelated.manifest.version, url)).toBeUndefined();
  } finally {
    restored.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** A control API client whose D1 queries run against local SQLite. */
function sqliteApi(db: DatabaseSync) {
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    const { sql, params } = JSON.parse(init!.body as string);
    try {
      const results = db.prepare(sql).all(...params);
      return Response.json({ success: true, result: [{ success: true, results }] });
    } catch {
      return Response.json({ success: false }, { status: 400 });
    }
  });
  return { api: new Cloudflare("account", "secret", request), request };
}

test("only a ready slot or an interrupted patch toward the same release is patched", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const { api, request } = sqliteApi(db);
    const data = dataset();
    const metadata = JSON.stringify(releaseMetadata(data.manifest));
    const [from, other] = ["b".repeat(64), "c".repeat(64)];
    // A new slot has no tables.
    expect(await patchBase(api, "inactive", other)).toBeUndefined();
    db.exec(D1_SCHEMA);
    const set = (data: string, ready: number, patchFrom: string | null) =>
      db.prepare("INSERT OR REPLACE INTO metadata VALUES (1, ?, ?, ?)").run(data, ready, patchFrom);
    set(metadata, 1, null);
    expect(await patchBase(api, "inactive", other)).toBe(data.manifest.version);
    // Archives are pruned 29 days after upload, and a build dated 2 days ahead
    // makes its upload look that much younger.
    const built = Date.parse(data.manifest.updatedAt);
    expect(await patchBase(api, "inactive", other, built + 25 * 86400000)).toBe(
      data.manifest.version,
    );
    expect(MAX_BASE_AGE_MS + 2 * 86400000).toBeLessThan(29 * 86400000);
    expect(await patchBase(api, "inactive", other, built + MAX_BASE_AGE_MS)).toBeUndefined();
    set(metadata, 0, from);
    expect(await patchBase(api, "inactive", data.manifest.version)).toBe(from);
    expect(await patchBase(api, "inactive", other)).toBeUndefined();
    set(metadata, 0, null);
    expect(await patchBase(api, "inactive", data.manifest.version)).toBeUndefined();
    set("not json", 1, null);
    expect(await patchBase(api, "inactive", other)).toBeUndefined();
    db.exec("DROP TABLE blocks");
    expect(await patchBase(api, "inactive", other)).toBeUndefined();
    // Schema 2 metadata has no patch_from column.
    db.exec(RESET_SQL + D1_SCHEMA.replace(", patch_from TEXT", ""));
    db.prepare("INSERT INTO metadata VALUES (1, ?, 1)").run(
      JSON.stringify({ ...releaseMetadata(data.manifest), schemaVersion: 2 }),
    );
    expect(await patchBase(api, "inactive", other)).toBeUndefined();
    // An API failure is not a reason to import in full.
    request.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(patchBase(api, "inactive", other)).rejects.toThrow("HTTP 503");
  } finally {
    db.close();
  }
});

test("a slot lease admits one publisher, survives full imports, and gates activation", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const { api } = sqliteApi(db);
    const now = Date.now();
    await acquireLease(api, "inactive", "a", now);
    await acquireLease(api, "inactive", "a", now + 1000);
    await expect(acquireLease(api, "inactive", "b", now + 1000)).rejects.toThrow(
      "Another publisher",
    );
    db.exec(RESET_SQL + D1_SCHEMA);
    db.exec("INSERT INTO metadata VALUES (1, '{}', 0, 'x')");
    await expect(acquireLease(api, "inactive", "b", now + 1000)).rejects.toThrow(
      "Another publisher",
    );
    // An abandoned lease expires.
    await acquireLease(api, "inactive", "b", now + 3 * 60 * 60 * 1000);
    await expect(activate(api, "inactive", "a")).rejects.toThrow("Lost");
    expect(db.prepare("SELECT ready FROM metadata").get()!.ready).toBe(0);
    await activate(api, "inactive", "b");
    expect(db.prepare("SELECT ready, patch_from FROM metadata").get()).toEqual({
      ready: 1,
      patch_from: null,
    });
    await releaseLease(api, "inactive", "a");
    await expect(acquireLease(api, "inactive", "a", now + 3 * 60 * 60 * 1000)).rejects.toThrow();
    await releaseLease(api, "inactive", "b");
    await acquireLease(api, "inactive", "a", now + 3 * 60 * 60 * 1000);
  } finally {
    db.close();
  }
});

test("slot selection never selects the live database or accepts an unmanaged live binding", () => {
  const databases = [
    { name: "geoip-lookup-a", uuid: "a" },
    { name: "geoip-lookup-b", uuid: "b" },
  ];
  expect(chooseSlot("geoip", databases).name).toBe("geoip-lookup-a");
  expect(chooseSlot("geoip", databases, "a").existing?.uuid).toBe("b");
  expect(chooseSlot("geoip", databases, "b").existing?.uuid).toBe("a");
  expect(() => chooseSlot("geoip", databases, "unknown")).toThrow();
  expect(() => chooseSlot("geoip", [...databases, databases[0]!], "b")).toThrow();
});

test("control API distinguishes a missing Worker from permission failures and checks bindings", async () => {
  const request = vi.fn<typeof fetch>();
  const api = new Cloudflare("account", "secret", request);
  request.mockResolvedValueOnce(new Response(null, { status: 404 }));
  expect(await api.activeDatabase("geoip")).toBeUndefined();
  request.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(api.activeDatabase("geoip")).rejects.toThrow("HTTP 403");
  request.mockResolvedValueOnce(
    Response.json({
      success: true,
      result: { bindings: [{ name: "GEOIP_LOOKUP", type: "d1", id: "a" }] },
    }),
  );
  expect(await api.activeDatabase("geoip")).toBe("a");
  request.mockResolvedValueOnce(
    Response.json({
      success: true,
      result: { bindings: [{ name: "GEOIP_LOOKUP", type: "r2_bucket" }] },
    }),
  );
  await expect(api.activeDatabase("geoip")).rejects.toThrow("Unexpected");
});

test("remote validation rejects partial imports and probe mismatches before activation", async () => {
  const request = vi.fn<typeof fetch>();
  const api = new Cloudflare("account", "secret", request);
  const sums = { blocks: 6, blockHash: 123, records: 3, recordHash: 456 };
  const build: BuildStats = {
    ranges: 6,
    ...sums,
    bytes: 1000,
    path: "",
    probes: PROBES.map(() => [{ kind: 0, prefix: 24, data: "{}" }]),
  };
  const result = (results: unknown[]) =>
    Response.json({ success: true, result: [{ success: true, results }] });
  request.mockResolvedValueOnce(result([{ ...sums, blocks: 5 }]));
  await expect(validateRemote(api, "inactive", build)).rejects.toThrow("row counts");
  // Equal counts with a stale row inside still differ by content.
  request.mockResolvedValueOnce(result([{ ...sums, blockHash: 124 }]));
  await expect(validateRemote(api, "inactive", build)).rejects.toThrow(MismatchError);
  request.mockResolvedValueOnce(result([sums]));
  request.mockResolvedValueOnce(result([]));
  await expect(validateRemote(api, "inactive", build)).rejects.toThrow("records differ");
  // Operational failures are not mismatches, so they never force a full import.
  request.mockResolvedValueOnce(new Response(null, { status: 502 }));
  const failure = await validateRemote(api, "inactive", build).catch((error) => error);
  expect(failure).not.toBeInstanceOf(MismatchError);
  const data = dataset();
  request.mockResolvedValueOnce(
    result([{ kind: -1, prefix: null, data: JSON.stringify(releaseMetadata(data.manifest)) }]),
  );
  expect(await readyRelease(api, "inactive", data.manifest.version)).toBe(true);
  request.mockResolvedValueOnce(result([]));
  expect(await readyRelease(api, "inactive", data.manifest.version)).toBe(false);
});
