import { expect, test } from "vitest";
import { Buffer } from "node:buffer";
import { AsyncMmdb, type ByteSource } from "../src/mmdb";
import { mmdb } from "./fixtures";

const marker = Buffer.from("abcdef4d61784d696e642e636f6d", "hex");
function header(type: number, size: number): Uint8Array {
  const code = size < 29 ? size : size < 285 ? 29 : size < 65821 ? 30 : 31;
  const extra = size < 29 ? [] : size < 285 ? [size - 29] : size < 65821
    ? [(size - 285) >>> 8, (size - 285) & 255]
    : [(size - 65821) >>> 16, ((size - 65821) >>> 8) & 255, (size - 65821) & 255];
  return Uint8Array.from([type < 8 ? (type << 5) | code : code, ...(type < 8 ? [] : [type - 7]), ...extra]);
}
function field(type: number, bytes: Uint8Array) { return Buffer.concat([header(type, bytes.length), bytes]); }
function str(value: string) { return field(2, Buffer.from(value)); }
function integer(value: number) { const b = Buffer.alloc(4); b.writeUInt32BE(value); return field(6, b); }
function map(entries: Record<string, Uint8Array>) {
  return Buffer.concat([header(7, Object.keys(entries).length), ...Object.entries(entries).flatMap(([k, v]) => [str(k), v])]);
}
function fixture(data: Uint8Array, width: 24 | 28 | 32 = 24, version = 4, left = 17, right = left) {
  const tree = Buffer.alloc(width / 4);
  if (width === 28) {
    tree.writeUIntBE(left & 0xffffff, 0, 3); tree[3] = ((left >>> 24) << 4) | (right >>> 24);
    tree.writeUIntBE(right & 0xffffff, 4, 3);
  } else { tree.writeUIntBE(left, 0, width / 8); tree.writeUIntBE(right, width / 8, width / 8); }
  return Buffer.concat([tree, Buffer.alloc(16), data, marker, map({ node_count: integer(1), record_size: integer(width),
    ip_version: integer(version), database_type: str("GeoLite2-City"), build_epoch: integer(1700000000), binary_format_major_version: integer(2) })]);
}
function source(bytes: Uint8Array, pageSize = 17): ByteSource & { calls: [number, number][] } {
  const calls: [number, number][] = [];
  return { size: bytes.length, calls, async read(offset, length) {
    calls.push([offset, length]);
    // Assemble independently sliced tiny pages, including values straddling a page boundary.
    const result = new Uint8Array(length);
    for (let pos = offset; pos < offset + length;) {
      const end = Math.min(offset + length, (Math.floor(pos / pageSize) + 1) * pageSize);
      result.set(bytes.subarray(pos, end), pos - offset); pos = end;
    }
    return result;
  } };
}

test("existing synthetic country/ASN databases and lazy IPv4 initialization", async () => {
  for (const kind of ["country", "asn"] as const) {
    const input = source(mmdb(kind, 1700000000));
    const reader = await AsyncMmdb.open(input);
    // Opening reads the tail and separator only; metadata fields reuse the tail.
    expect(input.calls).toHaveLength(2);
    expect(reader.metadata.databaseType).toBe(kind === "country" ? "GeoLite2-Country" : "GeoLite2-ASN");
    expect(reader.metadata.buildEpoch).toBe("2023-11-14T22:13:20.000Z");
    expect(input.calls.filter(([offset, length]) => offset === 0 && length === 6)).toHaveLength(0);
    const a = await reader.getWithPrefixLength("1.2.3.4");
    const b = await reader.getWithPrefixLength("2001:db8::1");
    expect(a[0]).toEqual(b[0]); expect(a[1]).toBe(0); expect(b[1]).toBe(1);
    await reader.getWithPrefixLength("8.8.8.8");
    expect(input.calls.filter(([offset, length]) => offset === 0 && length === 6)).toHaveLength(2);
  }
});

test("all value types survive JSON without filtering arbitrary keys", async () => {
  const double = Buffer.alloc(8); double.writeDoubleBE(-123.125);
  const float = Buffer.alloc(4); float.writeFloatBE(1.25);
  const record = map({ unicode: str("\uFEFF東京 🗺"), double: field(3, double), float: field(15, float),
    signed: field(8, Buffer.from("fffffffe", "hex")), short: field(5, Uint8Array.of(255, 255)),
    zero: field(6, new Uint8Array()), big64: field(9, Buffer.from("ffffffffffffffff", "hex")),
    big128: field(10, Buffer.alloc(16, 255)), small64: field(9, Uint8Array.of(42)),
    bytes: field(4, Uint8Array.of(0, 1, 255)), array: Buffer.concat([header(11, 3), header(14, 0), header(14, 1), map({ nested: str("yes") })]),
    ["__proto__"]: str("safe"), $type: str("future"), long: str("x".repeat(300)) });
  const reader = await AsyncMmdb.open(source(fixture(record)));
  const [value, prefix] = await reader.getWithPrefixLength("8.8.8.8");
  expect(prefix).toBe(1);
  expect(JSON.parse(JSON.stringify(value))).toEqual({ unicode: "\uFEFF東京 🗺", double: -123.125, float: 1.25,
    signed: -2, short: 65535, zero: 0, big64: "18446744073709551615", big128: "340282366920938463463374607431768211455",
    small64: 42, bytes: { $type: "bytes", base64: "AAH/" }, array: [false, true, { nested: "yes" }],
    ["__proto__"]: "safe", $type: "future", long: "x".repeat(300) });
});

for (const width of [24, 28, 32] as const) {
  test(`${width}-bit search records support both branches and IP families`, async () => {
    for (const version of [4, 6]) {
      const reader = await AsyncMmdb.open(source(fixture(map({ found: str("yes") }), width, version, 1, 17)));
      expect(await reader.getWithPrefixLength(version === 4 ? "1.1.1.1" : "::1")).toEqual([null, 1]);
      expect(await reader.getWithPrefixLength(version === 4 ? "200.1.1.1" : "ffff::1")).toEqual([{ found: "yes" }, 1]);
      if (version === 4) expect(await reader.getWithPrefixLength("::1")).toEqual([null, 0]);
    }
  });
}

for (const width of [1, 2, 3, 4]) {
  test(`packed ${width}-byte data pointer`, async () => {
    const target = [0, 513, 70000, 17000000, 128][width]!;
    const packed = target - [0, 0, 2048, 526336, 0][width]!;
    const pointer = Buffer.alloc(width + 1);
    pointer[0] = 0x20 | ((width - 1) << 3) | (width === 4 ? 7 : Math.floor(packed / 256 ** width));
    pointer.writeUIntBE(packed % 256 ** width, 1, width);
    const data = Buffer.alloc(target + 64);
    data.set(map({ pointed: pointer })); data.set(str("resolved"), target);
    const input = source(fixture(data));
    const reader = await AsyncMmdb.open(input);
    expect(await reader.getWithPrefixLength("1.1.1.1")).toEqual([{ pointed: "resolved" }, 1]);
    expect(Math.max(...input.calls.map(([, length]) => length))).toBeLessThanOrEqual(128 * 1024);
  });
}

test("malformed records reject cycles, sizes, types, roots and bounds", async () => {
  const cases = [Uint8Array.of(0x20, 0), Uint8Array.of(0x38, 255, 255, 255, 255),
    header(7, 10001), header(2, 1048577), field(3, Uint8Array.of(0)), header(14, 2),
    header(12, 0), field(5, Uint8Array.of(1, 2, 3)), str("not a map"),
    field(4, Uint8Array.of(1)), Uint8Array.of(0xe1, 0x41, 0x61)];
  for (const bytes of cases) {
    const reader = await AsyncMmdb.open(source(fixture(bytes)));
    await expect(reader.getWithPrefixLength("1.1.1.1")).rejects.toThrow();
  }
  for (const pointer of [2, 0xffffff]) {
    const reader = await AsyncMmdb.open(source(fixture(map({}), 24, 4, pointer)));
    await expect(reader.getWithPrefixLength("1.1.1.1")).rejects.toThrow();
  }
  let nested: Uint8Array = map({});
  for (let i = 0; i < 65; i++) nested = map({ n: nested });
  const deep = await AsyncMmdb.open(source(fixture(nested)));
  await expect(deep.getWithPrefixLength("1.1.1.1")).rejects.toThrow("complexity");
});

test("IPv4 in an IPv6 database skips precisely 96 zero bits", async () => {
  const count = 97;
  const tree = Buffer.alloc(count * 6);
  for (let i = 0; i < count; i++) {
    tree.writeUIntBE(i === 96 ? count + 16 : i + 1, i * 6, 3);
    tree.writeUIntBE(count, i * 6 + 3, 3);
  }
  const bytes = Buffer.concat([tree, Buffer.alloc(16), map({ v4: str("yes") }), marker,
    map({ node_count: integer(count), record_size: integer(24), ip_version: integer(6),
      database_type: str("GeoLite2-City"), build_epoch: integer(1), binary_format_major_version: integer(2) })]);
  const reader = await AsyncMmdb.open(source(bytes));
  expect(await reader.getWithPrefixLength("1.2.3.4")).toEqual([{ v4: "yes" }, 1]);
  expect(await reader.getWithPrefixLength("200.2.3.4")).toEqual([null, 1]);
  expect(await reader.getWithPrefixLength("::102:304")).toEqual([{ v4: "yes" }, 97]);
  expect(await reader.getWithPrefixLength("8000::1")).toEqual([null, 1]);
});

test("transient IPv4 subtree read failures can recover on the same reader", async () => {
  const input = source(mmdb("country", 1700000000));
  const original = input.read.bind(input);
  let failOnce = true;
  input.read = async (offset, length) => {
    if (offset === 0 && length === 6 && failOnce) { failOnce = false; throw new Error("temporary read failure"); }
    return original(offset, length);
  };
  const reader = await AsyncMmdb.open(input);
  await expect(reader.getWithPrefixLength("1.1.1.1")).rejects.toThrow("temporary");
  expect((await reader.getWithPrefixLength("1.1.1.1"))[0]?.country).toBeDefined();
});

test("zero-node database is empty", async () => {
  const bytes = Buffer.concat([Buffer.alloc(16), marker, map({ node_count: integer(0), record_size: integer(24),
    ip_version: integer(6), database_type: str("Empty"), build_epoch: integer(1), binary_format_major_version: integer(2) })]);
  const reader = await AsyncMmdb.open(source(bytes));
  expect(await reader.getWithPrefixLength("1.2.3.4")).toEqual([null, 0]);
  expect(await reader.getWithPrefixLength("::1")).toEqual([null, 0]);
});

test("metadata marker is required and the last marker is authoritative", async () => {
  await expect(AsyncMmdb.open(source(Buffer.alloc(100)))).rejects.toThrow("marker");
  const bytes = fixture(map({}));
  await expect(AsyncMmdb.open(source(Buffer.concat([bytes, marker, str("bad")])))).rejects.toThrow("metadata");
  const truncated = source(bytes); truncated.read = async () => new Uint8Array();
  await expect(AsyncMmdb.open(truncated)).rejects.toThrow("short");
});
