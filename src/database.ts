import { DATABASE_KINDS, SOURCES, type DatabaseKind } from "./manifest";
import { networkCidr, type ParsedIp } from "./ip";
import {
  addressKey,
  D1_SCHEMA_VERSION,
  LOOKUP_SQL,
  STATUS_SQL,
  type LookupRow,
  type ReleaseMetadata,
} from "./d1-schema";

export class DatabaseUnavailable extends Error {
  constructor() {
    super("GeoIP databases are not available. Please try again later.");
  }
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function readMetadata(
  rows: LookupRow[],
  expectedVersion?: string,
  now = Date.now(),
): ReleaseMetadata {
  const metadata = rows.filter((row) => row.kind === -1);
  if (metadata.length !== 1) throw new DatabaseUnavailable();
  const value = object(JSON.parse(metadata[0]!.data));
  const builds = object(value?.builds);
  if (
    !value ||
    value.schemaVersion !== D1_SCHEMA_VERSION ||
    typeof value.version !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.version) ||
    (expectedVersion && value.version !== expectedVersion) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !builds ||
    !DATABASE_KINDS.every((kind) => {
      const build = builds[kind];
      const age = typeof build === "string" ? now - Date.parse(build) : NaN;
      return age >= -2 * 86400000 && age <= 30 * 86400000;
    })
  )
    throw new DatabaseUnavailable();
  return value as ReleaseMetadata;
}
async function query(db: D1Database, sql: string, params: (string | number)[], version?: string) {
  // Each request owns its session. A replica can contain the previous slot's
  // data during rollout: verify the release and retry the primary.
  for (const constraint of ["first-unconstrained", "first-primary"] as const) {
    try {
      const result = await db
        .withSession(constraint)
        .prepare(sql)
        .bind(...params)
        .all<LookupRow>();
      if (!result.success) throw new DatabaseUnavailable();
      const metadata = readMetadata(result.results, version);
      return { rows: result.results, metadata };
    } catch {
      if (constraint === "first-primary") throw new DatabaseUnavailable();
    }
  }
  throw new DatabaseUnavailable();
}
function info(metadata: ReleaseMetadata) {
  return {
    version: metadata.version,
    updatedAt: metadata.updatedAt,
    builds: metadata.builds,
    stale: false,
    sources: SOURCES,
  };
}
export async function status(db: D1Database, version?: string) {
  const { metadata } = await query(db, STATUS_SQL, [], version);
  return { status: "ok", database: info(metadata) };
}
const regions = new Intl.DisplayNames(["en"], { type: "region" });
export function lookupResult(address: ParsedIp, rows: LookupRow[], metadata: ReleaseMetadata) {
  const records: Record<DatabaseKind, Record<string, unknown> | null> = {
    country: null,
    city: null,
    asn: null,
  };
  const network: Record<DatabaseKind, string | null> = { country: null, city: null, asn: null };
  for (const row of rows) {
    if (row.kind === -1) continue;
    const kind = DATABASE_KINDS[row.kind];
    const record = object(JSON.parse(row.data));
    if (!kind || !record || records[kind] !== null || row.prefix === null)
      throw new DatabaseUnavailable();
    records[kind] = record;
    network[kind] = networkCidr(address.ip, row.prefix);
  }
  const countryRecord = object(records.country?.country);
  const code = countryRecord?.iso_code;
  const name = object(countryRecord?.names)?.en;
  const country =
    typeof code === "string" && /^[A-Z]{2}$/.test(code)
      ? { code, name: typeof name === "string" ? name : regions.of(code) || code }
      : null;
  const number = records.asn?.autonomous_system_number;
  const organization = records.asn?.autonomous_system_organization;
  const asn =
    typeof number === "number" && Number.isSafeInteger(number) && number > 0
      ? { number, name: typeof organization === "string" ? organization : "" }
      : null;
  return { ...address, country, asn, network, records, database: info(metadata) };
}
export async function lookup(address: ParsedIp, db: D1Database, version?: string) {
  const { rows, metadata } = await query(
    db,
    LOOKUP_SQL,
    [address.version, addressKey(address.ip)],
    version,
  );
  try {
    return lookupResult(address, rows, metadata);
  } catch {
    throw new DatabaseUnavailable();
  }
}
