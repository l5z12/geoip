import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Reader } from "mmdb-lib";
import { DATABASE_KINDS, MAX_DATABASE_BYTES, PAGE_BYTES, type DatabaseKind } from "../src/manifest";

export const DATA_DIR = new URL("../.data/", import.meta.url);
export const EDITIONS = { country: "GeoLite2-Country", city: "GeoLite2-City", asn: "GeoLite2-ASN" } as const;
export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export function pageDigests(bytes: Uint8Array): string[] {
  const pages: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += PAGE_BYTES) pages.push(sha256(bytes.subarray(offset, offset + PAGE_BYTES)));
  return pages;
}
// Hash lowercase hex digests in DATABASE_KINDS order, without separators.
export const versionFor = (digests: Record<DatabaseKind, string>) => sha256(DATABASE_KINDS.map(k => digests[k]).join(""));

export function validateDatabase(kind: DatabaseKind, bytes: Buffer, now = Date.now()): string {
  if (!bytes.length || bytes.length > MAX_DATABASE_BYTES) throw new SafeError(`Invalid ${kind} database size`);
  try {
    const reader = new Reader(bytes);
    const metadata = reader.metadata;
    const build = metadata.buildEpoch.getTime();
    if (metadata.databaseType !== EDITIONS[kind] || metadata.ipVersion !== 6 ||
        metadata.binaryFormatMajorVersion !== 2 || !Number.isFinite(build) ||
        now - build > 30 * 86400000 || build - now > 2 * 86400000) {
      throw new Error("metadata");
    }
    for (const ip of ["1.1.1.1", "8.8.8.8", "9.9.9.9", "2606:4700:4700::1111", "2001:4860:4860::8888", "2620:fe::fe"]) {
      const record = reader.get(ip) as unknown as Record<string, unknown> | null;
      if (!record) throw new Error("missing record");
      if (kind === "country" || kind === "city") {
        const country = record.country as { iso_code?: unknown } | undefined;
        if (typeof country?.iso_code !== "string" || !/^[A-Z]{2}$/.test(country.iso_code)) throw new Error("country schema");
        if (kind === "city") {
          const location = record.location as { latitude?: unknown; longitude?: unknown } | undefined;
          if (typeof location?.latitude !== "number" || !Number.isFinite(location.latitude) || Math.abs(location.latitude) > 90 ||
              typeof location.longitude !== "number" || !Number.isFinite(location.longitude) || Math.abs(location.longitude) > 180) throw new Error("city location schema");
        }
      } else if (!Number.isSafeInteger(record.autonomous_system_number) ||
                 (record.autonomous_system_number as number) <= 0 ||
                 typeof record.autonomous_system_organization !== "string" ||
                 !record.autonomous_system_organization.trim()) throw new Error("ASN schema");
    }
    return metadata.buildEpoch.toISOString();
  } catch {
    throw new SafeError(`${kind} MMDB failed metadata, freshness, or public dual-stack record validation`);
  }
}

export async function bucketName(): Promise<string> {
  let config: { r2_buckets?: { binding?: string; bucket_name?: string }[] };
  try { config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")); }
  catch { throw new SafeError("wrangler.jsonc must contain valid plain JSON"); }
  if (!config || !Array.isArray(config.r2_buckets) || config.r2_buckets.some(b => !b || typeof b !== "object")) throw new SafeError("Invalid r2_buckets in wrangler.jsonc");
  const matches = config.r2_buckets.filter(b => b.binding === "GEOIP_DB");
  const name = matches[0]?.bucket_name;
  if (matches.length !== 1 || typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) {
    throw new SafeError("Configure exactly one GEOIP_DB binding with a valid R2 bucket_name");
  }
  return name;
}

export function credentials(names: string[]): string[] {
  return names.map(name => {
    const value = process.env[name]?.trim();
    if (!value) throw new SafeError(`Missing required environment variable ${name}`);
    return value;
  });
}

export async function runMain(main: () => Promise<void>): Promise<void> {
  try { await main(); } catch (error) {
    // Only application-authored messages are safe; dependency errors can contain URLs/secrets.
    console.error(error instanceof SafeError ? error.message : "Operation failed. Check configuration, credentials, network, and database validity.");
    process.exitCode = 1;
  }
}
export class SafeError extends Error {}
