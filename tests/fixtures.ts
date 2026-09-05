import { Buffer } from "node:buffer";
import { sha256, versionFor } from "../scripts/shared";
import { DATABASE_KINDS, PAGE_BYTES, type DatabaseKind, type Manifest } from "../src/manifest";

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
  if (typeof value === "number") {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return Buffer.concat([header(6, 4), bytes]);
  }
  if (typeof value === "boolean") return Buffer.from([value ? 1 : 0, 7]);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([value.length, 4]), ...value.map(encode)]);
  const pairs = Object.entries(value as Record<string, unknown>);
  return Buffer.concat([header(7, pairs.length), ...pairs.flatMap(([k, v]) => [encode(k), encode(v)])]);
}

export function mmdb(kind: DatabaseKind, epoch = Math.floor(Date.now() / 1000), record?: unknown): Buffer {
  const data = record ?? (kind === "asn"
    ? { autonomous_system_number: 13335, autonomous_system_organization: "Fixture Network" }
    : { country: { iso_code: "US", names: { en: "United States" } },
        ...(kind === "city" ? {
          city: { names: { en: "Test City", fr: "Ville test" }, geoname_id: 42 },
          subdivisions: [{ iso_code: "VA", names: { en: "Virginia" } }],
          location: { latitude: 38, longitude: 77, accuracy_radius: 100, time_zone: "America/New_York" },
          postal: { code: "20101" }, traits: { is_anycast: true }, future_field: { retained: true },
        } : {}),
      });
  return Buffer.concat([
    Buffer.from([0, 0, 17, 0, 0, 17]), Buffer.alloc(16), encode(data),
    Buffer.from("abcdef4d61784d696e642e636f6d", "hex"),
    encode({ node_count: 1, record_size: 24, ip_version: 6, database_type: { country: "GeoLite2-Country", city: "GeoLite2-City", asn: "GeoLite2-ASN" }[kind],
      build_epoch: epoch, binary_format_major_version: 2, binary_format_minor_version: 0, description: {} }),
  ]);
}

export function dataset(epoch = Math.floor(Date.now() / 1000)) {
  const country = mmdb("country", epoch);
  const city = mmdb("city", epoch);
  const asn = mmdb("asn", epoch);
  const files = { country, city, asn };
  const version = versionFor({ country: sha256(country), city: sha256(city), asn: sha256(asn) });
  const date = new Date(epoch * 1000).toISOString();
  const manifest: Manifest = {
    schemaVersion: 2, version, updatedAt: date,
    files: Object.fromEntries(DATABASE_KINDS.map(kind => [kind, {
      key: `versions/${version}/${kind}.mmdb`, bytes: files[kind].length, sha256: sha256(files[kind]),
      pageSha256: Array.from({ length: Math.ceil(files[kind].length / PAGE_BYTES) }, (_, i) => sha256(files[kind].subarray(i * PAGE_BYTES, (i + 1) * PAGE_BYTES))),
      buildEpoch: date,
    }])) as Manifest["files"],
  };
  return { country, city, asn, manifest };
}

export function fakeBucket(data = dataset()) {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  function install(next: ReturnType<typeof dataset>) {
    objects.set("manifest.json", Buffer.from(JSON.stringify(next.manifest)));
    for (const kind of DATABASE_KINDS) objects.set(next.manifest.files[kind].key, next[kind]);
  }
  install(data);
  const bucket = {
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      calls.push(key);
      const bytes = objects.get(key);
      if (!bytes) return null;
      const range = options?.range;
      const body = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
      return {
        size: bytes.length,
        body: new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }),
        async json() { return JSON.parse(body.toString()); },
        async arrayBuffer() { return Uint8Array.from(body).buffer; },
      };
    },
  } as unknown as R2Bucket;
  return { bucket, objects, calls, install };
}
