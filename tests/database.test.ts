import { expect, test } from "vitest";
import { DatabaseUnavailable, lookup, status } from "../src/database";
import { addressKey, LOOKUP_SQL } from "../src/d1-schema";
import { parseManifest } from "../src/manifest";
import { parseIp } from "../src/ip";
import { d1Fixture } from "./d1-fixture";
import { dataset } from "./fixtures";

test("fresh and repeated dual-stack lookups each make one indexed D1 request", async () => {
  const db = await d1Fixture();
  for (const ip of ["1.1.1.1", "2606:4700::1111", "8.8.8.8"]) {
    const result = await lookup(parseIp(ip), db.binding, db.data.manifest.version);
    expect(result.country?.code).toBe("US");
    expect(result.asn?.number).toBe(13335);
    expect(result.records.city?.future_field).toEqual({ retained: true });
    expect(result.records.city?.traits).toEqual({ is_anycast: true });
    expect(result.network.city).toBe(ip.includes(":") ? "::/1" : "0.0.0.0/0");
  }
  expect(db.calls).toHaveLength(3);
  expect(db.calls.every((call) => call.constraint === "first-unconstrained")).toBe(true);
  const plan = db.sql.prepare("EXPLAIN QUERY PLAN " + LOOKUP_SQL).all(4, addressKey("1.1.1.1"));
  const details = plan.map((row) => String(row.detail)).join("\n");
  expect(details.match(/SEARCH ranges USING PRIMARY KEY/g)).toHaveLength(3);
  expect(details).not.toContain("SCAN ranges");
  expect(details).not.toContain("USE TEMP B-TREE");
});

test("IPv4/IPv6 predecessor seeks check the end and preserve gaps and exact boundaries", async () => {
  const db = await d1Fixture();
  db.sql.exec("DELETE FROM ranges");
  const record = db.sql.prepare("SELECT id FROM records ORDER BY id LIMIT 1").get()!.id;
  const insert = db.sql.prepare("INSERT INTO ranges VALUES (0, ?, ?, ?, ?, ?)");
  insert.run(4, addressKey("8.8.8.0"), addressKey("8.8.8.255"), 24, record!);
  insert.run(4, addressKey("9.9.9.9"), addressKey("9.9.9.9"), 32, record!);
  insert.run(6, addressKey("2606:4700::"), addressKey("2606:4700::ffff"), 112, record!);
  insert.run(6, addressKey("2606:4700:0:1::"), addressKey("2606:4700:0:1::"), 128, record!);
  for (const ip of [
    "8.8.8.0",
    "8.8.8.255",
    "9.9.9.9",
    "2606:4700::",
    "2606:4700::ffff",
    "2606:4700:0:1::",
  ])
    expect((await lookup(parseIp(ip), db.binding)).country?.code).toBe("US");
  for (const ip of [
    "1.1.1.1",
    "8.8.9.0",
    "9.9.9.10",
    "2606:46ff:ffff:ffff:ffff:ffff:ffff:ffff",
    "2606:4700::1:0",
    "2606:4700:0:1::1",
  ])
    expect((await lookup(parseIp(ip), db.binding)).records).toEqual({
      country: null,
      city: null,
      asn: null,
    });
});

test("sparse records retain unknown location and arbitrary original fields", async () => {
  const data = dataset(undefined, {
    country: { registered_country: { iso_code: "US" } },
    city: { traits: { is_anycast: true } },
    asn: {},
  });
  const db = await d1Fixture(data);
  const result = await lookup(parseIp("1.1.1.1"), db.binding);
  expect(result.country).toBeNull();
  expect(result.asn).toBeNull();
  expect(result.records.country).toEqual({ registered_country: { iso_code: "US" } });
  expect(result.records.city).toEqual({ traits: { is_anycast: true } });
});

test("lagging or unavailable replicas retry the primary without serving an old slot", async () => {
  for (const failure of ["stale", "fail"] as const) {
    const db = await d1Fixture();
    db.replica[failure] = true;
    const result = await lookup(parseIp("1.1.1.1"), db.binding, db.data.manifest.version);
    expect(result.database.version).toBe(db.data.manifest.version);
    expect(db.calls.map((call) => call.constraint)).toEqual([
      "first-unconstrained",
      "first-primary",
    ]);
  }
});

test("missing, unready, expired, mismatched and malformed releases fail closed", async () => {
  for (const mutation of [
    "DELETE FROM metadata",
    "UPDATE metadata SET ready = 0",
    "UPDATE metadata SET data = '{}'",
    "UPDATE metadata SET data = 'broken'",
  ]) {
    const db = await d1Fixture();
    db.sql.exec(mutation);
    await expect(lookup(parseIp("1.1.1.1"), db.binding)).rejects.toBeInstanceOf(
      DatabaseUnavailable,
    );
    await expect(status(db.binding)).rejects.toBeInstanceOf(DatabaseUnavailable);
  }
  const old = await d1Fixture(dataset(Math.floor(Date.now() / 1000) - 31 * 86400));
  await expect(status(old.binding)).rejects.toBeInstanceOf(DatabaseUnavailable);
  const future = await d1Fixture(dataset(Math.floor(Date.now() / 1000) + 3 * 86400));
  await expect(status(future.binding)).rejects.toBeInstanceOf(DatabaseUnavailable);
  const db = await d1Fixture();
  await expect(lookup(parseIp("1.1.1.1"), db.binding, "b".repeat(64))).rejects.toBeInstanceOf(
    DatabaseUnavailable,
  );
});

test("archive manifests reject invalid schema, keys and sizes", () => {
  const { manifest } = dataset();
  expect(parseManifest(manifest)).toEqual(manifest);
  expect(() => parseManifest({ ...manifest, schemaVersion: 1 })).toThrow();
  for (const changes of [{ key: "wrong" }, { bytes: -1 }, { searchTreeSize: 1e9 }]) {
    expect(() =>
      parseManifest({
        ...manifest,
        files: { ...manifest.files, city: { ...manifest.files.city, ...changes } },
      }),
    ).toThrow();
  }
});
