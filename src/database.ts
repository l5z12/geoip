import { AsyncMmdb } from "./mmdb";
import { PageCache } from "./pages";
import {
  databaseInfo,
  DATABASE_KINDS,
  MANIFEST_KEY,
  MAX_MANIFEST_BYTES,
  parseManifest,
  type Manifest,
  type DatabaseKind,
} from "./manifest";
import { networkCidr, type ParsedIp } from "./ip";

const RECHECK_MS = 5 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const EDITIONS: Record<DatabaseKind, string> = {
  country: "GeoLite2-Country",
  city: "GeoLite2-City",
  asn: "GeoLite2-ASN",
};

export interface Snapshot {
  manifest: Manifest;
  readers: Record<DatabaseKind, AsyncMmdb>;
}

export class DatabaseUnavailable extends Error {
  constructor() {
    super("GeoIP databases are not available. Please try again later.");
  }
}

export async function readManifest(bucket: R2Bucket): Promise<Manifest> {
  const object = await bucket.get(MANIFEST_KEY);
  if (!object) throw new Error("Database manifest is missing");
  if (object.size > MAX_MANIFEST_BYTES) {
    await object.body.cancel();
    throw new Error("Database manifest is too large");
  }
  return parseManifest(await object.json());
}

export function isFresh(manifest: Manifest, now: number): boolean {
  return DATABASE_KINDS.every((kind) => {
    const age = now - Date.parse(manifest.files[kind].buildEpoch);
    return age <= MAX_AGE_MS && age >= -2 * 24 * 60 * 60 * 1000;
  });
}

const pageCaches = new WeakMap<R2Bucket, PageCache>();
function pageCache(bucket: R2Bucket): PageCache {
  let cache = pageCaches.get(bucket);
  if (!cache) {
    cache = new PageCache(bucket);
    pageCaches.set(bucket, cache);
  }
  return cache;
}

export async function loadSnapshot(bucket: R2Bucket, manifest: Manifest): Promise<Snapshot> {
  const cache = pageCache(bucket);
  const readers = {} as Snapshot["readers"];
  // These files are independent. Drain every read even if one fails, so a
  // failed load cannot leave R2 work running after its request has completed.
  const opened = await Promise.allSettled(
    DATABASE_KINDS.map(async (kind) => {
      const file = manifest.files[kind];
      const reader = await AsyncMmdb.open(cache.source(file));
      if (
        reader.metadata.ipVersion !== 6 ||
        reader.metadata.databaseType !== EDITIONS[kind] ||
        reader.metadata.buildEpoch !== file.buildEpoch
      ) {
        throw new Error("Database metadata mismatch");
      }
      return reader;
    }),
  );
  for (const [index, result] of opened.entries()) {
    if (result.status === "rejected") throw result.reason;
    readers[DATABASE_KINDS[index]!] = result.value;
  }
  return { manifest, readers };
}

/** Only metadata/readers are retained per generation; all share one bounded page cache. */
export class DatabaseStore {
  private snapshot?: Snapshot;
  private pending?: Promise<void>;
  private nextCheck = 0;
  private refreshFailed = false;

  constructor(
    private bucket: R2Bucket,
    private clock: () => number = Date.now,
    private loader = loadSnapshot,
  ) {}

  async get(
    context?: Pick<ExecutionContext, "waitUntil">,
  ): Promise<{ snapshot: Snapshot; stale: boolean }> {
    if (this.clock() >= this.nextCheck) {
      if (!this.pending)
        this.pending = this.refresh().finally(() => {
          this.pending = undefined;
        });
      // Only a validated, unexpired snapshot may bypass the refresh. Keep the
      // refresh alive with this request's context, never a retained context.
      if (context && this.snapshot && isFresh(this.snapshot.manifest, this.clock())) {
        context.waitUntil(this.pending);
      } else {
        await this.pending;
      }
    }
    if (!this.snapshot || !isFresh(this.snapshot.manifest, this.clock()))
      throw new DatabaseUnavailable();
    return { snapshot: this.snapshot, stale: this.refreshFailed };
  }

  private async refresh(): Promise<void> {
    try {
      const manifest = await readManifest(this.bucket);
      if (!isFresh(manifest, this.clock())) throw new Error("Database build is out of date");
      if (this.snapshot?.manifest.version !== manifest.version)
        this.snapshot = await this.loader(this.bucket, manifest);
      this.refreshFailed = false;
      this.nextCheck = this.clock() + RECHECK_MS;
    } catch {
      // Do not log lookup addresses or untrusted error details.
      this.refreshFailed = true;
      this.nextCheck = this.clock() + RETRY_MS;
    }
  }
}

const stores = new WeakMap<R2Bucket, DatabaseStore>();
export function getStore(bucket: R2Bucket): DatabaseStore {
  let store = stores.get(bucket);
  if (!store) {
    store = new DatabaseStore(bucket);
    stores.set(bucket, store);
  }
  return store;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
const regions = new Intl.DisplayNames(["en"], { type: "region" });

export async function lookup(address: ParsedIp, snapshot: Snapshot, stale = false) {
  const matches = await Promise.all(
    DATABASE_KINDS.map((kind) => snapshot.readers[kind].getWithPrefixLength(address.ip)),
  );
  const records = Object.fromEntries(
    DATABASE_KINDS.map((kind, i) => [kind, matches[i]![0]]),
  ) as Record<DatabaseKind, Record<string, unknown> | null>;
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
  return {
    ...address,
    country,
    asn,
    network: Object.fromEntries(
      DATABASE_KINDS.map((kind, i) => [
        kind,
        records[kind] ? networkCidr(address.ip, matches[i]![1]) : null,
      ]),
    ),
    // Original, complete MaxMind records: no language, field, or trait whitelist.
    records,
    database: databaseInfo(snapshot.manifest, stale),
  };
}
