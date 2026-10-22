import { Buffer } from "node:buffer";
import ipaddr from "ipaddr.js";
import { sha256, versionFor } from "../scripts/shared";
import { DATABASE_KINDS, PAGE_BYTES, type DatabaseKind, type Manifest } from "../src/manifest";

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// A tiny, synthetic MMDB with one search node and a record on each branch.
// No licensed database or network download is needed to run the test suite.
function encode(value: unknown): Buffer {
  function header(type: number, size: number) {
    if (size < 29) return Buffer.from([(type << 5) | size]);
    if (size < 285) return Buffer.from([(type << 5) | 29, size - 29]);
    throw new Error("Fixture value too large");
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([header(2, bytes.length), bytes]);
  }
  if (typeof value === "number" && (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value);
    return Buffer.concat([header(3, 8), bytes]);
  }
  if (typeof value === "number") {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return Buffer.concat([header(6, 4), bytes]);
  }
  if (typeof value === "boolean") return Buffer.from([value ? 1 : 0, 7]);
  if (Array.isArray(value))
    return Buffer.concat([Buffer.from([value.length, 4]), ...value.map(encode)]);
  const pairs = Object.entries(value as Record<string, unknown>);
  return Buffer.concat([
    header(7, pairs.length),
    ...pairs.flatMap(([k, v]) => [encode(k), encode(v)]),
  ]);
}

export function mmdb(
  kind: DatabaseKind,
  epoch = Math.floor(Date.now() / 1000),
  record?: unknown,
  paddingBytes = 0,
  scattered = false,
): Buffer {
  const data =
    record ??
    (kind === "asn"
      ? { autonomous_system_number: 13335, autonomous_system_organization: "Fixture Network" }
      : {
          country: { iso_code: "US", names: { en: "United States" } },
          ...(kind === "city"
            ? {
                city: { names: { en: "Test City", fr: "Ville test" }, geoname_id: 42 },
                subdivisions: [{ iso_code: "VA", names: { en: "Virginia" } }],
                location: {
                  latitude: 38,
                  longitude: 77,
                  accuracy_radius: 100,
                  time_zone: "America/New_York",
                },
                postal: { code: "20101" },
                traits: { is_anycast: true },
                future_field: { retained: true },
              }
            : {}),
        });
  return Buffer.concat([
    Buffer.from([0, 0, 17, 0, 0, 17]),
    Buffer.alloc(16),
    scattered ? scatter(data) : encode(data),
    Buffer.alloc(paddingBytes),
    Buffer.from("abcdef4d61784d696e642e636f6d", "hex"),
    encode({
      node_count: 1,
      record_size: 24,
      ip_version: 6,
      database_type: { country: "GeoLite2-Country", city: "GeoLite2-City", asn: "GeoLite2-ASN" }[
        kind
      ],
      build_epoch: epoch,
      binary_format_major_version: 2,
      binary_format_minor_version: 0,
      description: {},
    }),
  ]);
}

// A map whose values live on independent pages, as in real MMDB pointer graphs.
// This exposes serial pointer reads that tiny inline fixtures cannot measure.
function scatter(data: unknown): Buffer {
  const entries = Object.entries(data as Record<string, unknown>);
  const bytes = Buffer.alloc((entries.length + 1) * PAGE_BYTES);
  const fields = [Buffer.from([0xe0 | entries.length])];
  for (const [index, [key, value]] of entries.entries()) {
    const target = (index + 1) * PAGE_BYTES;
    const pointer = Buffer.alloc(5);
    pointer[0] = 0x38;
    pointer.writeUInt32BE(target, 1);
    fields.push(encode(key), pointer);
    bytes.set(encode(value), target);
  }
  bytes.set(Buffer.concat(fields));
  return bytes;
}

/** `aliases` are IPv6 prefixes pointed at the IPv4 root, as MaxMind does for
 * Teredo (2001::/32) and 6to4 (2002::/16). */
export function treeMmdb(
  recordSize: 24 | 28 | 32,
  networks: string[],
  aliases: string[] = [],
): Buffer {
  type Node = [number | "empty" | "record", number | "empty" | "record"];
  const nodes: Node[] = [["empty", "empty"]];
  function place(network: string, value: number | "record") {
    const [ip, prefix] = network.split("/");
    const address = ipaddr.parse(ip!);
    const bytes = address.toByteArray();
    const bits = bytes.flatMap((byte) =>
      Array.from({ length: 8 }, (_, i) => (byte >>> (7 - i)) & 1),
    );
    if (bytes.length === 4) bits.unshift(...Array<number>(96).fill(0));
    const depth = Number(prefix) + (bytes.length === 4 ? 96 : 0);
    let node = 0;
    for (let i = 0; i < depth; i++) {
      const bit = bits[i]! as 0 | 1;
      if (i === depth - 1) {
        nodes[node]![bit] = value;
        break;
      }
      if (nodes[node]![bit] === "empty") {
        nodes[node]![bit] = nodes.length;
        nodes.push(["empty", "empty"]);
      }
      const next = nodes[node]![bit];
      if (typeof next !== "number") throw new Error("Overlapping fixture prefixes");
      node = next;
    }
  }
  for (const network of networks) place(network, "record");
  let ipv4 = 0;
  for (let i = 0; aliases.length && i < 96; i++) {
    const next = nodes[ipv4]![0];
    if (typeof next !== "number") throw new Error("Aliases require an IPv4 subtree");
    ipv4 = next;
  }
  for (const alias of aliases) place(alias, ipv4);
  const tree = Buffer.alloc((nodes.length * recordSize) / 4);
  function write(offset: number, value: number, length: number) {
    for (let i = length - 1; i >= 0; i--) {
      tree[offset + i] = value & 255;
      value = Math.floor(value / 256);
    }
  }
  for (const [index, node] of nodes.entries()) {
    const [left, right] = node.map((value) =>
      value === "empty" ? nodes.length : value === "record" ? nodes.length + 16 : value,
    ) as [number, number];
    const offset = (index * recordSize) / 4;
    if (recordSize === 28) {
      write(offset, left, 3);
      write(offset + 4, right, 3);
      tree[offset + 3] = Math.floor(left / 0x1000000) * 16 + Math.floor(right / 0x1000000);
    } else {
      write(offset, left, recordSize / 8);
      write(offset + recordSize / 8, right, recordSize / 8);
    }
  }
  return Buffer.concat([
    tree,
    Buffer.alloc(16),
    encode({ country: { iso_code: "US" }, arbitrary: ["中文", "O'Brien", true] }),
    Buffer.from("abcdef4d61784d696e642e636f6d", "hex"),
    encode({
      node_count: nodes.length,
      record_size: recordSize,
      ip_version: 6,
      database_type: "GeoLite2-Country",
      build_epoch: Math.floor(Date.now() / 1000),
      binary_format_major_version: 2,
    }),
  ]);
}

export function dataset(
  epoch = Math.floor(Date.now() / 1000),
  records: Partial<Record<DatabaseKind, unknown>> = {},
  paddingBytes = 0,
  scattered = false,
) {
  const country = mmdb("country", epoch, records.country, paddingBytes, scattered);
  const city = mmdb("city", epoch, records.city, paddingBytes, scattered);
  const asn = mmdb("asn", epoch, records.asn, paddingBytes, scattered);
  const files = { country, city, asn };
  const version = versionFor({ country: sha256(country), city: sha256(city), asn: sha256(asn) });
  const date = new Date(epoch * 1000).toISOString();
  const manifest: Manifest = {
    schemaVersion: 2,
    version,
    updatedAt: date,
    files: Object.fromEntries(
      DATABASE_KINDS.map((kind) => [
        kind,
        {
          key: `versions/${version}/${kind}.mmdb`,
          bytes: files[kind].length,
          sha256: sha256(files[kind]),
          pageSha256: Array.from({ length: Math.ceil(files[kind].length / PAGE_BYTES) }, (_, i) =>
            sha256(files[kind].subarray(i * PAGE_BYTES, (i + 1) * PAGE_BYTES)),
          ),
          buildEpoch: date,
          searchTreeSize: 6,
        },
      ]),
    ) as Manifest["files"],
  };
  return { country, city, asn, manifest };
}

export function fakeBucket(
  data = dataset(),
  beforeGet?: (key: string, offset?: number, length?: number) => Promise<void>,
) {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  const ranges: { key: string; offset?: number; length?: number }[] = [];
  function install(next: ReturnType<typeof dataset>) {
    objects.set("manifest.json", Buffer.from(JSON.stringify(next.manifest)));
    for (const kind of DATABASE_KINDS) objects.set(next.manifest.files[kind].key, next[kind]);
  }
  install(data);
  const bucket = {
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      calls.push(key);
      ranges.push({ key, ...options?.range });
      await beforeGet?.(key, options?.range?.offset, options?.range?.length);
      const bytes = objects.get(key);
      if (!bytes) return null;
      const range = options?.range;
      const body = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
      return {
        size: bytes.length,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        }),
        async json() {
          return JSON.parse(body.toString());
        },
        async arrayBuffer() {
          return Uint8Array.from(body).buffer;
        },
      };
    },
  } as unknown as R2Bucket;
  return { bucket, objects, calls, ranges, install };
}
