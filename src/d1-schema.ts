import ipaddr from "ipaddr.js";
import { DATABASE_KINDS, databaseInfo, type Manifest } from "./manifest";

// Bump when the SQL layout or conversion semantics change. Identical MaxMind
// releases must still be rebuilt when the converter changes.
export const D1_SCHEMA_VERSION = 2;
// D1 bills every inserted row. Each block row holds a run of consecutive ranges
// as a JSON array of [start, end, prefix, record_id], so a full import writes
// far fewer rows than one row per MMDB leaf.
export const D1_SCHEMA = `
CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL, ready INTEGER NOT NULL CHECK(ready IN (0,1)));
CREATE TABLE records (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE blocks (
  kind INTEGER NOT NULL, family INTEGER NOT NULL, start TEXT NOT NULL COLLATE BINARY,
  data TEXT NOT NULL,
  PRIMARY KEY (kind, family, start)
) WITHOUT ROWID;
`;

export const STATUS_SQL =
  "SELECT -1 AS kind, NULL AS prefix, data FROM metadata WHERE id = 1 AND ready = 1";

// Seek the nearest preceding block start without scanning backwards through
// gaps. MMDB leaves are disjoint, so at most one range in that block contains
// the address. CROSS JOIN keeps records as the inner loop of a rowid search.
export const LOOKUP_SQL = `${STATUS_SQL}\nUNION ALL\n${DATABASE_KINDS.map(
  (_, kind) => `
SELECT ${kind} AS kind, item.value ->> 2 AS prefix, records.data FROM (
  SELECT data FROM blocks
  WHERE kind = ${kind} AND family = ?1 AND start <= ?2
  ORDER BY start DESC LIMIT 1
) AS block CROSS JOIN json_each(block.data) AS item CROSS JOIN records
WHERE item.value ->> 0 <= ?2 AND item.value ->> 1 >= ?2 AND records.id = item.value ->> 3
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
