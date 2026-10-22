import { expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Reader } from "mmdb-lib";
import { mkdtemp, readFile, unlink, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  addDatabase,
  buildD1,
  capacityLimit,
  exportSql,
  localLookup,
  rowLimit,
  sqlValue,
  PROBES,
  type BuildStats,
} from "./build-d1";
import { chooseSlot, Cloudflare, readyRelease, validateRemote } from "./d1-release";
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
  let build: BuildStats | undefined;
  try {
    for (const kind of DATABASE_KINDS) await writeFile(new URL(`${kind}.mmdb`, url), data[kind]);
    build = await buildD1(data.manifest, url);
    expect(build.ranges).toBe(6);
    expect(build.blocks).toBe(6);
    expect(build.records).toBe(3);
    expect(build.bytes).toBeGreaterThan(0);
    const restored = new DatabaseSync(":memory:");
    try {
      for (const file of build.files) restored.exec(await readFile(file, "utf8"));
      expect(restored.prepare("SELECT ready FROM metadata").get()!.ready).toBe(0);
    } finally {
      restored.close();
    }
    await expect(buildD1(data.manifest, url, 1)).rejects.toThrow("D1_MAX_BYTES");
    // 6 blocks + 3 records + 1 metadata row.
    await expect(buildD1(data.manifest, url, undefined, 9)).rejects.toThrow(
      "D1 build would write 10 rows, above D1_MAX_ROWS=9",
    );
  } finally {
    for (const file of build?.files ?? []) await unlink(file);
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
  const build: BuildStats = {
    ranges: 6,
    blocks: 6,
    records: 3,
    bytes: 1000,
    files: [],
    probes: PROBES.map(() => [{ kind: 0, prefix: 24, data: "{}" }]),
  };
  const result = (results: unknown[]) =>
    Response.json({ success: true, result: [{ success: true, results }] });
  request.mockResolvedValueOnce(result([{ blocks: 5, records: 3 }]));
  await expect(validateRemote(api, "inactive", build)).rejects.toThrow("row counts");
  request.mockResolvedValueOnce(result([{ blocks: 6, records: 3 }]));
  request.mockResolvedValueOnce(result([]));
  await expect(validateRemote(api, "inactive", build)).rejects.toThrow("records differ");
  const data = dataset();
  request.mockResolvedValueOnce(
    result([{ kind: -1, prefix: null, data: JSON.stringify(releaseMetadata(data.manifest)) }]),
  );
  expect(await readyRelease(api, "inactive", data.manifest.version)).toBe(true);
  request.mockResolvedValueOnce(result([]));
  expect(await readyRelease(api, "inactive", data.manifest.version)).toBe(false);
});
