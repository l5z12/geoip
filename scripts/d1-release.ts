import { readFile, writeFile } from "node:fs/promises";
import {
  D1_SCHEMA_VERSION,
  LOOKUP_SQL,
  STATUS_SQL,
  addressKey,
  type LookupRow,
  type ReleaseMetadata,
} from "../src/d1-schema";
import { readMetadata } from "../src/database";
import { CHECKSUM_SQL, PROBES, type BuildStats, type Checksum } from "./build-d1";
import { SafeError } from "./shared";

export const RELEASE_CONFIG = new URL("../.wrangler-release.json", import.meta.url);
export const RELEASE_STATE = new URL("../.data/release.json", import.meta.url);
export interface D1Info {
  uuid: string;
  name: string;
}
export interface ProjectConfig {
  name: string;
  d1_databases: { binding: string; database_name: string; database_id?: string }[];
  vars?: Record<string, string>;
  [key: string]: unknown;
}
export async function projectConfig(): Promise<ProjectConfig> {
  const config = JSON.parse(
    await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ) as ProjectConfig;
  if (
    !/^[a-z0-9-]+$/.test(config.name) ||
    config.d1_databases?.length !== 1 ||
    config.d1_databases[0]?.binding !== "GEOIP_LOOKUP"
  )
    throw new SafeError("Configure one GEOIP_LOOKUP D1 binding in wrangler.jsonc");
  return config;
}

export class Cloudflare {
  constructor(
    readonly account: string,
    private token: string,
    private request: typeof fetch = fetch,
  ) {}
  async call<T>(
    path: string,
    method = "GET",
    body?: unknown,
    allowMissing = false,
  ): Promise<T | undefined> {
    let response: Response;
    try {
      response = await this.request(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.account)}/${path}`,
        {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(60000),
          headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
    } catch {
      throw new SafeError("Cloudflare API request failed");
    }
    if (allowMissing && response.status === 404) return undefined;
    if (!response.ok) throw new SafeError(`Cloudflare API failed (HTTP ${response.status})`);
    const value = (await response.json()) as { success?: boolean; result?: T };
    if (value.success !== true || value.result === undefined)
      throw new SafeError("Cloudflare API operation failed");
    return value.result;
  }
  async activeDatabase(worker: string): Promise<string | undefined> {
    const settings = await this.call<{ bindings: { name: string; type: string; id?: string }[] }>(
      `workers/scripts/${encodeURIComponent(worker)}/settings`,
      "GET",
      undefined,
      true,
    );
    if (!settings) return undefined;
    if (!Array.isArray(settings.bindings))
      throw new SafeError("Could not identify live Worker bindings");
    const binding = settings.bindings.find((binding) => binding.name === "GEOIP_LOOKUP");
    if (binding && (binding.type !== "d1" || !binding.id))
      throw new SafeError("Unexpected live GEOIP_LOOKUP binding");
    return binding?.id;
  }
  async databases(): Promise<D1Info[]> {
    const all: D1Info[] = [];
    for (let page = 1; ; page++) {
      const result = await this.call<D1Info[]>(`d1/database?per_page=100&page=${page}`);
      if (!Array.isArray(result)) throw new SafeError("Invalid D1 database listing");
      all.push(...result);
      if (result.length < 100) return all;
    }
  }
  async create(name: string): Promise<D1Info> {
    const db = await this.call<D1Info>("d1/database", "POST", {
      name,
      primary_location_hint: "apac",
      read_replication: { mode: "auto" },
    });
    if (!db?.uuid || db.name !== name) throw new SafeError("D1 creation could not be confirmed");
    return db;
  }
  async query<T>(id: string, sql: string, params: (string | number)[] = []): Promise<T[]> {
    const result = await this.call<{ success: boolean; results: T[] }[]>(
      `d1/database/${encodeURIComponent(id)}/query`,
      "POST",
      { sql, params },
    );
    if (result?.length !== 1 || !result[0]?.success || !Array.isArray(result[0].results))
      throw new SafeError("D1 query failed");
    return result[0].results;
  }
}

export function chooseSlot(
  worker: string,
  databases: D1Info[],
  active?: string,
): { name: string; existing?: D1Info } {
  const a = `${worker}-lookup-a`,
    b = `${worker}-lookup-b`;
  const current = databases.find((db) => db.uuid === active);
  if (active && (!current || ![a, b].includes(current.name)))
    throw new SafeError("Live D1 is not a managed lookup slot; refusing to overwrite any database");
  const name = current?.name === a ? b : a;
  const matches = databases.filter((db) => db.name === name);
  if (matches.length > 1) throw new SafeError("Ambiguous D1 lookup slot");
  return { name, existing: matches[0] };
}

export async function writeReleaseConfig(config: ProjectConfig, db: D1Info, version: string) {
  await writeFile(
    RELEASE_CONFIG,
    JSON.stringify(
      {
        ...config,
        d1_databases: [{ binding: "GEOIP_LOOKUP", database_name: db.name, database_id: db.uuid }],
        vars: { ...config.vars, GEOIP_VERSION: version },
      },
      null,
      2,
    ) + "\n",
  );
}

/** The slot's rows differ from the build; other validation errors are operational. */
export class MismatchError extends SafeError {}

export async function validateRemote(api: Cloudflare, id: string, build: BuildStats) {
  const [sum] = await api.query<Checksum>(id, CHECKSUM_SQL);
  if (sum?.blocks !== build.blocks || sum?.records !== build.records)
    throw new MismatchError("D1 imported row counts differ from the validated build");
  if (sum.blockHash !== build.blockHash || sum.recordHash !== build.recordHash)
    throw new MismatchError("D1 imported row contents differ from the validated build");
  for (const [index, ip] of PROBES.entries()) {
    const rows = await api.query<LookupRow>(id, LOOKUP_SQL, [
      ip.includes(":") ? 6 : 4,
      addressKey(ip),
    ]);
    const normalize = (rows: LookupRow[]) =>
      JSON.stringify(
        rows
          .filter((row) => row.kind !== -1)
          .map(({ kind, prefix, data }) => [kind, prefix, data])
          .sort((a, b) => Number(a[0]) - Number(b[0])),
      );
    if (normalize(rows) !== normalize(build.probes[index]!))
      throw new MismatchError("D1 imported records differ from the validated build");
  }
}

// Archive cleanup prunes superseded releases 29 days after upload, and a
// release is uploaded after its newest build; older ones are rebuilt in full.
const MAX_BASE_AGE_MS = 28 * 24 * 60 * 60 * 1000;

/** The release an inactive slot can be patched from: its ready release, or the
 * base of an interrupted patch toward `version`. Undefined means import in
 * full; API failures throw rather than trigger a needless full import. */
export async function patchBase(
  api: Cloudflare,
  id: string,
  version: string,
  now = Date.now(),
): Promise<string | undefined> {
  // Check the tables first so that every later query error is operational.
  const tables = await api.query<{ name: string }>(
    id,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('metadata', 'blocks', 'records')",
  );
  if (tables.length !== 3) return undefined;
  // `*` also reads schema 2 metadata, which has no patch_from column.
  const [row] = await api.query<{ data: string; ready: number; patch_from?: string | null }>(
    id,
    "SELECT * FROM metadata WHERE id = 1",
  );
  let metadata: Partial<ReleaseMetadata> | undefined;
  try {
    metadata = row && JSON.parse(row.data);
  } catch {
    return undefined;
  }
  if (
    metadata?.schemaVersion !== D1_SCHEMA_VERSION ||
    !(now - Date.parse(metadata.updatedAt ?? "") < MAX_BASE_AGE_MS)
  )
    return undefined;
  const from =
    row!.ready === 1 ? metadata.version : metadata.version === version ? row!.patch_from : null;
  return typeof from === "string" && /^[a-f0-9]{64}$/.test(from) ? from : undefined;
}

// A publisher leases the inactive slot from its first write until deploy, so
// CI and local publishers cannot interleave SQL in one slot. Full imports drop
// only the release tables, so the lease survives them. An abandoned lease
// expires after the CI job timeout.
const LEASE_MS = 2 * 60 * 60 * 1000;
export async function acquireLease(api: Cloudflare, id: string, owner: string, now = Date.now()) {
  await api.query(
    id,
    "CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id = 1), owner TEXT NOT NULL, expires INTEGER NOT NULL)",
  );
  // One atomic statement: take a free or expired lease, or renew our own.
  const held = await api.query(
    id,
    "INSERT INTO lease VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires = excluded.expires WHERE lease.owner = excluded.owner OR lease.expires < ? RETURNING owner",
    [owner, now + LEASE_MS, now],
  );
  if (held.length !== 1)
    throw new SafeError(
      "Another publisher holds the inactive D1 slot; retry after it finishes or its lease expires",
    );
}
export async function releaseLease(api: Cloudflare, id: string, owner: string) {
  await api.query(id, "DELETE FROM lease WHERE owner = ?", [owner]);
}
/** Mark the slot ready, but only while this publisher still holds its lease. */
export async function activate(api: Cloudflare, id: string, owner: string) {
  const rows = await api.query(
    id,
    "UPDATE metadata SET ready = 1, patch_from = NULL WHERE id = 1 AND EXISTS (SELECT 1 FROM lease WHERE owner = ?) RETURNING id",
    [owner],
  );
  if (rows.length !== 1) throw new SafeError("Lost the D1 slot lease before activation");
}

export async function readyRelease(api: Cloudflare, id: string, version: string): Promise<boolean> {
  // A brand-new slot may not have a metadata table yet. Only a verified ready
  // release permits skipping an import; any failure takes the staging path.
  try {
    const metadata = readMetadata(await api.query<LookupRow>(id, STATUS_SQL), version);
    return metadata.schemaVersion === D1_SCHEMA_VERSION;
  } catch {
    return false;
  }
}
