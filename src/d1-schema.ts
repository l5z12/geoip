import ipaddr from "ipaddr.js";
import { DATABASE_KINDS, databaseInfo, type Manifest } from "./manifest";

// Bump when the SQL layout or conversion semantics change. Identical MaxMind
// releases must still be rebuilt when the converter changes.
export const D1_SCHEMA_VERSION = 1;
export const D1_SCHEMA = `
CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL, ready INTEGER NOT NULL CHECK(ready IN (0,1)));
CREATE TABLE records (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE ranges (
  kind INTEGER NOT NULL, family INTEGER NOT NULL, start TEXT NOT NULL COLLATE BINARY,
  end TEXT NOT NULL COLLATE BINARY, prefix INTEGER NOT NULL, record_id INTEGER NOT NULL,
  PRIMARY KEY (kind, family, start)
) WITHOUT ROWID;
`;

export const STATUS_SQL =
  "SELECT -1 AS kind, NULL AS prefix, data FROM metadata WHERE id = 1 AND ready = 1";

// MMDB leaves are disjoint. Seek the nearest preceding start, then check its
// end *after* LIMIT 1, so gaps never cause a backwards scan through the table.
export const LOOKUP_SQL = `${STATUS_SQL}\nUNION ALL\n${DATABASE_KINDS.map(
  (_, kind) => `
SELECT ${kind} AS kind, hit.prefix, records.data FROM (
  SELECT end, prefix, record_id FROM ranges
  WHERE kind = ${kind} AND family = ?1 AND start <= ?2
  ORDER BY start DESC LIMIT 1
) AS hit JOIN records ON records.id = hit.record_id WHERE hit.end >= ?2
`,
).join("\nUNION ALL\n")}`;

export function addressKey(ip: string): string {
  return ipaddr
    .parse(ip)
    .toByteArray()
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function releaseMetadata(manifest: Manifest) {
  const { version, updatedAt, builds } = databaseInfo(manifest);
  return { schemaVersion: D1_SCHEMA_VERSION, version, updatedAt, builds };
}
export type ReleaseMetadata = ReturnType<typeof releaseMetadata>;
export interface LookupRow {
  kind: number;
  prefix: number | null;
  data: string;
}
