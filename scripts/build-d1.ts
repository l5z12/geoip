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
import { DATA_DIR, SafeError, sha256 } from "./shared";

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
// One scan per table. Block hashes and record ids both derive from row
// content, so matching sums show every row matches, not just the row counts.
export const CHECKSUM_SQL =
  "SELECT b.blocks, b.blockHash, r.records, r.recordHash FROM (SELECT COUNT(*) AS blocks, COALESCE(SUM(hash), 0) AS blockHash FROM blocks) AS b, (SELECT COUNT(*) AS records, COALESCE(SUM(id % 4294967296), 0) AS recordHash FROM records) AS r";
export interface Checksum {
  blocks: number;
  blockHash: number;
  records: number;
  recordHash: number;
}
// Block boundaries are content-defined: once a block holds BLOCK_MIN_RANGES,
// a range whose start hashes to a cut point (1 in BLOCK_CUT_ODDS) opens the
// next one, about 64 ranges per block on average. Inserting or removing a range
// moves only nearby boundaries, so a patch rewrites the blocks around each
// change instead of every later block, as fixed-size runs would.
export const BLOCK_MIN_RANGES = 32;
export const BLOCK_CUT_ODDS = 32;
export const BLOCK_MAX_RANGES = 256;
export interface BuildStats extends Checksum {
  ranges: number;
  bytes: number;
  path: string;
  probes: LookupRow[][];
}
export interface D1Import {
  files: string[];
  rows: number;
  /** Release the slot must hold before a patch; absent for a full import. */
  from?: string;
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

export function isCutPoint(start: string): boolean {
  // FNV-1a with the murmur3 finalizer: cheap, deterministic, and well mixed.
  let hash = 0x811c9dc5;
  for (let i = 0; i < start.length; i++) hash = Math.imul(hash ^ start.charCodeAt(i), 0x01000193);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return ((hash ^ (hash >>> 16)) >>> 0) % BLOCK_CUT_ODDS === 0;
}

/** Whether a range starting at `start` opens a new block after `length` ranges. */
export function startsBlock(start: string, length: number, maxRanges = BLOCK_MAX_RANGES) {
  return length >= maxRanges || (length >= BLOCK_MIN_RANGES && isCutPoint(start));
}

export async function addDatabase(
  db: DatabaseSync,
  kind: number,
  bytes: Buffer,
  maxRanges = BLOCK_MAX_RANGES,
) {
  const reader = await AsyncMmdb.open({
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, offset + length),
  });
  const insertRecord = db.prepare("INSERT INTO records VALUES (?, ?)");
  const findRecord = db.prepare("SELECT data FROM records WHERE id = ?");
  const insertBlock = db.prepare("INSERT INTO blocks VALUES (?, ?, ?, ?, ?)");
  // Ranges arrive sorted by start within each family, IPv4 first.
  let block: [string, string, number, number][] = [],
    blockFamily = 0;
  function flush() {
    if (block.length) {
      const data = JSON.stringify(block);
      insertBlock.run(
        kind,
        blockFamily,
        block[0]![0],
        parseInt(sha256(data).slice(0, 8), 16),
        data,
      );
    }
    block = [];
  }
  // Ids hash the record content rather than its MMDB offset, which shifts on
  // every rebuild, so unchanged records and the blocks citing them stay equal.
  async function recordId(pointer: number): Promise<number> {
    const data = JSON.stringify(await reader.record(pointer));
    for (let hash = parseInt(sha256(data).slice(0, 12), 16); ; hash = (hash + 1) % 2 ** 48) {
      // Probe past a 48-bit collision; equal content shares one row.
      const id = kind * 2 ** 48 + hash;
      const existing = findRecord.get(id) as { data: string } | undefined;
      if (!existing) insertRecord.run(id, data);
      if (!existing || existing.data === data) return id;
    }
  }
  const ids = new Map<number, number>();
  let count = 0;
  db.exec("BEGIN");
  try {
    for (const range of mmdbRanges(bytes, reader.metadata)) {
      let id = ids.get(range.pointer);
      if (id === undefined) ids.set(range.pointer, (id = await recordId(range.pointer)));
      if (range.family !== blockFamily || startsBlock(range.start, block.length, maxRanges))
        flush();
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
  if (value === null) return "NULL";
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string") return "'" + value.replaceAll("'", "''") + "'";
  throw new SafeError("Unexpected SQL export value");
}

function* tuples(db: DatabaseSync, query: string, params: (string | number)[] = []) {
  for (const row of db.prepare(query).iterate(...params))
    yield "(" + Object.values(row).map(sqlValue).join(",") + ")";
}

function* column(db: DatabaseSync, query: string, params: (string | number)[] = []) {
  for (const row of db.prepare(query).iterate(...params)) yield sqlValue(Object.values(row)[0]);
}

/** Stream bounded statements/files; D1 imports cannot contain BEGIN/COMMIT. */
function sqlFiles(dir: URL, name: string) {
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
      const path = fileURLToPath(new URL(`${name}-${files.length}.sql`, dir));
      file = await open(path, "w");
      files.push(path);
      bytes = 0;
    }
    buffer += sql + "\n";
    bytes += size + 1;
    if (buffer.length >= 1024 * 1024) await flush();
  }
  /** Join `head value,value... tail;` statements of at most 80 KB and 500 rows. */
  async function batch(head: string, values: Iterable<string>, tail = "") {
    const empty = Buffer.byteLength(head + tail) + 1;
    let statement = head,
      size = empty,
      count = 0;
    for (const value of values) {
      const length = Buffer.byteLength(value) + 1;
      if (count && (size + length > 80_000 || count >= 500)) {
        await write(statement + tail + ";");
        statement = head;
        size = empty;
        count = 0;
      }
      statement += (count ? "," : "") + value;
      size += length;
      count++;
    }
    if (count) await write(statement + tail + ";");
  }
  return { files, write, batch, flush, close: async () => file?.close() };
}

export async function exportSql(db: DatabaseSync, dir: URL): Promise<string[]> {
  const sql = sqlFiles(dir, "d1");
  try {
    for (const statement of (RESET_SQL + D1_SCHEMA).split(";").filter((sql) => sql.trim()))
      await sql.write(statement.replace(/\s+/g, " ").trim() + ";");
    for (const table of ["records", "blocks", "metadata"])
      await sql.batch(`INSERT INTO ${table} VALUES `, tuples(db, `SELECT * FROM ${table}`));
    await sql.flush();
  } finally {
    await sql.close();
  }
  return sql.files;
}

function checkRows(rows: number, maxRows: number) {
  if (rows > maxRows)
    throw new SafeError(
      `D1 import would write ${rows} rows, above D1_MAX_ROWS=${maxRows}; D1 bills every imported row`,
    );
}

/** Every insert plus the metadata insert and the later `ready` UPDATE.
 * Resetting a reused slot drops whole tables; production bills showed that
 * DDL does not add a write per dropped row. */
export const fullRows = (build: BuildStats) => build.blocks + build.records + 2;

export async function fullImport(
  build: BuildStats,
  dir = DATA_DIR,
  maxRows = rowLimit(),
): Promise<D1Import> {
  const rows = fullRows(build);
  checkRows(rows, maxRows);
  const db = new DatabaseSync(build.path, { readOnly: true });
  try {
    const files = await exportSql(db, dir);
    console.log(`D1 full import: ${rows} rows written, ${files.length} import files`);
    return { files, rows };
  } finally {
    db.close();
  }
}

// Differences between this build (main) and the build of the slot's release
// (base). Upserts and deletes are idempotent, so rerunning an interrupted
// patch from the same base converges on the same rows.
const REMOVED_BLOCKS =
  "SELECT b.start FROM base.blocks AS b WHERE NOT EXISTS (SELECT 1 FROM main.blocks AS t WHERE t.kind = b.kind AND t.family = b.family AND t.start = b.start)";
const REMOVED_RECORDS =
  "SELECT b.id FROM base.records AS b WHERE NOT EXISTS (SELECT 1 FROM main.records AS t WHERE t.id = b.id)";
const CHANGED_RECORDS =
  "SELECT t.id, t.data FROM main.records AS t LEFT JOIN base.records AS b ON b.id = t.id WHERE b.data IS NOT t.data";
const CHANGED_BLOCKS =
  "SELECT t.* FROM main.blocks AS t LEFT JOIN base.blocks AS b ON b.kind = t.kind AND b.family = t.family AND b.start = t.start WHERE b.data IS NOT t.data";

/** Patch a slot holding release `from`, whose local build is `base`, into
 * `build`. Returns undefined when a full import would write no more rows. */
export async function patchImport(
  build: BuildStats,
  base: BuildStats,
  from: string,
  dir = DATA_DIR,
  maxRows = rowLimit(),
): Promise<D1Import | undefined> {
  const db = new DatabaseSync(build.path, { readOnly: true });
  try {
    db.prepare("ATTACH DATABASE ? AS base").run(base.path);
    const count = (query: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM (${query})`).get() as { n: number }).n;
    // One write per changed row, the metadata UPDATE, and the later activation.
    const rows =
      count(REMOVED_BLOCKS) +
      count(REMOVED_RECORDS) +
      count(CHANGED_RECORDS) +
      count(CHANGED_BLOCKS) +
      2;
    console.log(`D1 patch from ${from}: ${rows} rows written (full import: ${fullRows(build)})`);
    if (rows >= fullRows(build)) return undefined;
    checkRows(rows, maxRows);
    const sql = sqlFiles(dir, "d1-patch");
    try {
      const { data } = db.prepare("SELECT data FROM main.metadata").get() as { data: string };
      // Unready first; a rerun finds `patch_from` and reapplies this patch.
      await sql.write(
        `UPDATE metadata SET data = ${sqlValue(data)}, ready = 0, patch_from = ${sqlValue(from)} WHERE id = 1;`,
      );
      for (const kind of DATABASE_KINDS.keys())
        for (const family of [4, 6])
          await sql.batch(
            `DELETE FROM blocks WHERE kind = ${kind} AND family = ${family} AND start IN (`,
            column(db, `${REMOVED_BLOCKS} AND b.kind = ? AND b.family = ?`, [kind, family]),
            ")",
          );
      await sql.batch("DELETE FROM records WHERE id IN (", column(db, REMOVED_RECORDS), ")");
      await sql.batch(
        "INSERT INTO records VALUES ",
        tuples(db, CHANGED_RECORDS),
        " ON CONFLICT(id) DO UPDATE SET data = excluded.data",
      );
      await sql.batch(
        "INSERT INTO blocks VALUES ",
        tuples(db, CHANGED_BLOCKS),
        " ON CONFLICT(kind, family, start) DO UPDATE SET hash = excluded.hash, data = excluded.data",
      );
      await sql.flush();
    } finally {
      await sql.close();
    }
    console.log(`D1 patch: ${sql.files.length} import files`);
    return { files: sql.files, rows, from };
  } finally {
    db.close();
  }
}

export async function buildD1(
  manifest: Manifest,
  dir = DATA_DIR,
  maxBytes = capacityLimit(),
): Promise<BuildStats> {
  const path = fileURLToPath(new URL("lookup.sqlite", dir));
  const db = new DatabaseSync(path);
  try {
    db.exec(RESET_SQL + "VACUUM;" + D1_SCHEMA);
    db.prepare("INSERT INTO metadata VALUES (1, ?, 0, NULL)").run(
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
    const checksum = { ...(db.prepare(CHECKSUM_SQL).get() as unknown as Checksum) };
    const { ranges } = db
      .prepare("SELECT COALESCE(SUM(json_array_length(data)), 0) AS ranges FROM blocks")
      .get() as { ranges: number };
    const bytes = (await stat(path)).size;
    if (!checksum.blocks || !checksum.records || bytes > maxBytes)
      throw new SafeError("D1 build is empty or exceeds capacity");
    const probes = PROBES.map((ip) => localLookup(db, ip));
    console.log(
      `D1 build: ${ranges} ranges in ${checksum.blocks} blocks, ${checksum.records} records, ${bytes} bytes`,
    );
    return { ranges, ...checksum, bytes, path, probes };
  } finally {
    db.close();
  }
}
