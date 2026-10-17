export const DATABASE_KINDS = ["country", "city", "asn"] as const;
export type DatabaseKind = (typeof DATABASE_KINDS)[number];
export const MANIFEST_KEY = "manifest.json";
// Files live in R2; the Worker only reads checksum-verified pages on demand.
export const PAGE_BYTES = 256 * 1024;
export const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const SOURCES = [
  {
    name: "GeoLite2 City, Country and ASN by MaxMind",
    url: "https://www.maxmind.com/",
    license: "GeoLite2 EULA / CC BY-SA 4.0",
  },
];

export interface DatabaseFile {
  key: string;
  bytes: number;
  sha256: string;
  pageSha256: string[];
  buildEpoch: string;
}

export interface Manifest {
  schemaVersion: 2;
  version: string;
  updatedAt: string;
  files: Record<DatabaseKind, DatabaseFile>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function parseManifest(value: unknown): Manifest {
  if (
    !record(value) ||
    value.schemaVersion !== 2 ||
    typeof value.version !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.version) ||
    !timestamp(value.updatedAt) ||
    !record(value.files)
  ) {
    throw new Error("Invalid database manifest");
  }
  let total = 0;
  for (const kind of DATABASE_KINDS) {
    const file = value.files[kind];
    if (
      !record(file) ||
      file.key !== `versions/${value.version}/${kind}.mmdb` ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Array.isArray(file.pageSha256) ||
      file.pageSha256.length !== Math.ceil(file.bytes / PAGE_BYTES) ||
      !file.pageSha256.every(
        (hash: unknown) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
      ) ||
      !timestamp(file.buildEpoch)
    ) {
      throw new Error(`Invalid ${kind} database descriptor`);
    }
    total += file.bytes;
  }
  if (total > MAX_DATABASE_BYTES) throw new Error("Databases exceed the storage safety budget");
  return value as unknown as Manifest;
}

export function databaseInfo(manifest: Manifest, stale = false) {
  return {
    version: manifest.version,
    updatedAt: manifest.updatedAt,
    builds: Object.fromEntries(
      DATABASE_KINDS.map((kind) => [kind, manifest.files[kind].buildEpoch]),
    ),
    stale,
    sources: SOURCES,
  };
}
