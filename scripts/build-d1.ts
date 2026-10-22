import { DatabaseSync } from "node:sqlite";
import { readFile, open, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AsyncMmdb } from "../src/mmdb";
import { DATABASE_KINDS, type Manifest } from "../src/manifest";
import {
  addressKey,
  D1_SCHEMA,
  LOOKUP_SQL,
  releaseMetadata,
  type LookupRow,
} from "../src/d1-schema";
import { mmdbRanges } from "./mmdb-ranges";
import { DATA_DIR, SafeError } from "./shared";

export const PROBES = [
  "1.1.1.1",
  "8.8.8.8",
  "9.9.9.9",
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
  "2620:fe::fe",
];
// Schema version 1 stored one `ranges` row per leaf; drop it so a reused slot
// does not keep paying for that storage.
export const RESET_SQL =
  "DROP TABLE IF EXISTS metadata; DROP TABLE IF EXISTS ranges; DROP TABLE IF EXISTS blocks; DROP TABLE IF EXISTS records;";
export const COUNTS_SQL =
  "SELECT (SELECT COUNT(*) FROM blocks) AS blocks, (SELECT COUNT(*) FROM records) AS records";
export const BLOCK_RANGES = 64;
export interface BuildStats {
  ranges: number;
  blocks: number;
  records: number;
  bytes: number;
  files: string[];
  probes: LookupRow[][];
}

export function capacityLimit(value = process.env.D1_MAX_BYTES): number {
  const max = value ? Number(value) : 500_000_000;
  if (!Number.isSafeInteger(max) || max <= 0 || max > 10_000_000_000)
    throw new SafeError("D1_MAX_BYTES must be an integer from 1 to 10000000000");
  return max;
}

/** Rows one import may write. The default keeps a daily import for a 31-day
 * month (46.5M rows) inside the Workers Paid allowance of 50M rows written. */
export function rowLimit(value = process.env.D1_MAX_ROWS): number {
  const max = value ? Number(value) : 1_500_000;
  if (!Number.isSafeInteger(max) || max <= 0 || max > 100_000_000)
    throw new SafeError("D1_MAX_ROWS must be an integer from 1 to 100000000");
  return max;
}

export async function addDatabase(
  db: DatabaseSync,
  kind: number,
  bytes: Buffer,
  blockRanges = BLOCK_RANGES,
) {
  const reader = await AsyncMmdb.open({
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, offset + length),
  });
  const insertRecord = db.prepare("INSERT INTO records VALUES (?, ?)");
  const insertBlock = db.prepare("INSERT INTO blocks VALUES (?, ?, ?, ?)");
  // Ranges arrive sorted by start within each family, IPv4 first.
  let block: [string, string, number, number][] = [],
    blockFamily = 0;
  function flush() {
    if (block.length) insertBlock.run(kind, blockFamily, block[0]![0], JSON.stringify(block));
    block = [];
  }
  const seen = new Set<number>();
  let count = 0;
  db.exec("BEGIN");
  try {
    for (const range of mmdbRanges(bytes, reader.metadata)) {
      const id = kind * 0x100000000 + range.pointer;
      if (!seen.has(range.pointer)) {
        insertRecord.run(id, JSON.stringify(await reader.record(range.pointer)));
        seen.add(range.pointer);
      }
      if (range.family !== blockFamily || block.length >= blockRanges) flush();
      blockFamily = range.family;
      block.push([range.start, range.end, range.prefix, id]);
      if (++count % 50_000 === 0) db.exec("COMMIT; BEGIN");
    }
    flush();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return reader;
}

export function localLookup(db: DatabaseSync, ip: string): LookupRow[] {
  return db
    .prepare(LOOKUP_SQL)
    .all(ip.includes(":") ? 6 : 4, addressKey(ip)) as unknown as LookupRow[];
}

export function sqlValue(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string") return "'" + value.replaceAll("'", "''") + "'";
  throw new SafeError("Unexpected SQL export value");
}

/** Stream bounded statements/files; D1 imports cannot contain BEGIN/COMMIT. */
export async function exportSql(db: DatabaseSync, dir: URL): Promise<string[]> {
  const files: string[] = [];
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let bytes = 0,
    buffer = "";
  async function flush() {
    if (buffer) {
      await file!.writeFile(buffer);
      buffer = "";
    }
  }
  async function write(sql: string) {
    const size = Buffer.byteLength(sql);
    if (size > 90_000) throw new SafeError("A record exceeds the D1 SQL statement limit");
    if (!file || bytes + size > 64 * 1024 * 1024) {
      if (file) {
        await flush();
        await file.close();
      }
      const path = fileURLToPath(new URL(`d1-${files.length}.sql`, dir));
      file = await open(path, "w");
      files.push(path);
      bytes = 0;
    }
    buffer += sql + "\n";
    bytes += size + 1;
    if (buffer.length >= 1024 * 1024) await flush();
  }
  try {
    for (const statement of (RESET_SQL + D1_SCHEMA).split(";").filter((sql) => sql.trim()))
      await write(statement.replace(/\s+/g, " ").trim() + ";");
    for (const table of ["records", "blocks", "metadata"]) {
      const head = `INSERT INTO ${table} VALUES `;
      let statement = head,
        size = Buffer.byteLength(head),
        count = 0;
      for (const row of db.prepare(`SELECT * FROM ${table}`).iterate()) {
        const tuple = "(" + Object.values(row).map(sqlValue).join(",") + ")";
        const length = Buffer.byteLength(tuple) + 1;
        if (count && (size + length > 80_000 || count >= 500)) {
          await write(statement + ";");
          statement = head;
          size = Buffer.byteLength(head);
          count = 0;
        }
        statement += (count ? "," : "") + tuple;
        size += length;
        count++;
      }
      if (count) await write(statement + ";");
    }
    await flush();
  } finally {
    await file?.close();
  }
  return files;
}

export async function buildD1(
  manifest: Manifest,
  dir = DATA_DIR,
  maxBytes = capacityLimit(),
  maxRows = rowLimit(),
): Promise<BuildStats> {
  const path = fileURLToPath(new URL("lookup.sqlite", dir));
  const db = new DatabaseSync(path);
  try {
    db.exec(RESET_SQL + "VACUUM;" + D1_SCHEMA);
    db.prepare("INSERT INTO metadata VALUES (1, ?, 0)").run(
      JSON.stringify(releaseMetadata(manifest)),
    );
    for (const [index, kind] of DATABASE_KINDS.entries()) {
      const reader = await addDatabase(db, index, await readFile(new URL(`${kind}.mmdb`, dir)));
      for (const ip of PROBES) {
        const [record, prefix] = await reader.getWithPrefixLength(ip);
        const actual = localLookup(db, ip).find((row) => row.kind === index);
        if (
          JSON.stringify(record) !== (actual?.data ?? "null") ||
          (record && actual?.prefix !== prefix)
        )
          throw new SafeError(`D1 conversion failed ${kind} lookup validation`);
      }
      console.log(`Converted ${kind} to indexed D1 ranges`);
      if ((await stat(path)).size > maxBytes)
        throw new SafeError(
          "D1 build exceeds D1_MAX_BYTES; check your account limit before increasing it",
        );
    }
    const counts = db.prepare(COUNTS_SQL).get() as { blocks: number; records: number };
    const { ranges } = db
      .prepare("SELECT COALESCE(SUM(json_array_length(data)), 0) AS ranges FROM blocks")
      .get() as { ranges: number };
    const bytes = (await stat(path)).size;
    if (!counts.blocks || !counts.records || bytes > maxBytes)
      throw new SafeError("D1 build is empty or exceeds capacity");
    const rows = counts.blocks + counts.records + 1;
    if (rows > maxRows)
      throw new SafeError(
        `D1 build would write ${rows} rows, above D1_MAX_ROWS=${maxRows}; D1 bills every imported row`,
      );
    const probes = PROBES.map((ip) => localLookup(db, ip));
    const files = await exportSql(db, dir);
    console.log(
      `D1 build: ${ranges} ranges in ${counts.blocks} blocks, ${counts.records} records, ${rows} rows written per import, ${bytes} bytes, ${files.length} import files`,
    );
    return { ranges, ...counts, bytes, files, probes };
  } finally {
    db.close();
  }
}
