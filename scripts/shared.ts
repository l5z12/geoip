import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Reader } from "mmdb-lib";
import { DATABASE_KINDS, MAX_DATABASE_BYTES, PAGE_BYTES, type DatabaseKind } from "../src/manifest";

export const DATA_DIR = new URL("../.data/", import.meta.url);
export const EDITIONS = {
  country: "GeoLite2-Country",
  city: "GeoLite2-City",
  asn: "GeoLite2-ASN",
} as const;
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export function pageDigests(bytes: Uint8Array): string[] {
  const pages: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += PAGE_BYTES)
    pages.push(sha256(bytes.subarray(offset, offset + PAGE_BYTES)));
  return pages;
}
// Hash lowercase hex digests in DATABASE_KINDS order, without separators.
export const versionFor = (digests: Record<DatabaseKind, string>) =>
  sha256(DATABASE_KINDS.map((k) => digests[k]).join(""));

// Describe malformed fields without dumping database strings or entire records.
function valueSummary(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return `string(length=${value.length})`;
  return Array.isArray(value) ? "array" : typeof value;
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateDatabase(kind: DatabaseKind, bytes: Buffer, now = Date.now()): string {
  if (!bytes.length || bytes.length > MAX_DATABASE_BYTES)
    throw new SafeError(`Invalid ${kind} database size: ${bytes.length} bytes`);
  function fail(reason: string): never {
    throw new SafeError(`${kind} MMDB failed ${reason}`);
  }
  let stage = "parsing";
  try {
    const reader = new Reader(bytes);
    stage = "metadata validation";
    const metadata = reader.metadata;
    if (metadata.databaseType !== EDITIONS[kind])
      fail(`metadata.databaseType: expected ${EDITIONS[kind]}`);
    if (metadata.ipVersion !== 6)
      fail(`metadata.ipVersion: expected 6, got ${valueSummary(metadata.ipVersion)}`);
    if (metadata.binaryFormatMajorVersion !== 2)
      fail(
        `metadata.binaryFormatMajorVersion: expected 2, got ${valueSummary(metadata.binaryFormatMajorVersion)}`,
      );
    const build = metadata.buildEpoch instanceof Date ? metadata.buildEpoch.getTime() : NaN;
    if (!Number.isFinite(build)) fail("metadata.buildEpoch: invalid timestamp");
    const buildEpoch = metadata.buildEpoch.toISOString();
    const ageDays = ((now - build) / 86400000).toFixed(2);
    const freshness = `build=${buildEpoch}, checkedAt=${new Date(now).toISOString()}, ageDays=${ageDays}`;
    if (now - build > 30 * 86400000) fail(`freshness: database older than 30 days (${freshness})`);
    if (build - now > 2 * 86400000)
      fail(`freshness: database more than 2 days in the future (${freshness})`);
    console.log(
      `[${kind}] MMDB metadata valid: edition=${EDITIONS[kind]}, ipVersion=6, format=2, bytes=${bytes.length}, ${freshness}`,
    );
    for (const ip of [
      "1.1.1.1",
      "8.8.8.8",
      "9.9.9.9",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "2620:fe::fe",
    ]) {
      stage = `record lookup for ${ip}`;
      const record: unknown = reader.get(ip);
      // MaxMind may omit geolocation entirely for anycast networks. A null lookup
      // is different from a decoder error, which must still reject the database.
      if (record === null) {
        if (kind === "asn") fail(`${stage}: missing record`);
        console.log(`[${kind}] Probe ${ip}: no geolocation record (allowed)`);
        continue;
      }
      stage = `record validation for ${ip}`;
      if (!isMap(record)) fail(`${stage}: expected a map (got ${valueSummary(record)})`);
      if (kind === "country" || kind === "city") {
        // Undefined/empty values are omitted in MaxMind records. Do not require
        // traits.is_anycast or substitute registered_country for a location.
        const country = record.country;
        if (country !== undefined && !isMap(country))
          fail(`${stage}: country must be a map (got ${valueSummary(country)})`);
        const code = country?.iso_code;
        if (code !== undefined && (typeof code !== "string" || !/^[A-Z]{2}$/.test(code))) {
          fail(
            `${stage}: country.iso_code must be two uppercase letters when present (got ${valueSummary(code)})`,
          );
        }
        console.log(
          `[${kind}] Probe ${ip}: country.iso_code ${code === undefined ? "absent (allowed)" : "valid"}`,
        );
        if (kind === "city") {
          const location = record.location;
          if (location !== undefined && !isMap(location))
            fail(`${stage}: location must be a map (got ${valueSummary(location)})`);
          const latitude = location?.latitude;
          const longitude = location?.longitude;
          if (
            latitude !== undefined &&
            (typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90)
          ) {
            fail(
              `${stage}: location.latitude must be finite and within [-90, 90] when present (got ${valueSummary(latitude)})`,
            );
          }
          if (
            longitude !== undefined &&
            (typeof longitude !== "number" ||
              !Number.isFinite(longitude) ||
              Math.abs(longitude) > 180)
          ) {
            fail(
              `${stage}: location.longitude must be finite and within [-180, 180] when present (got ${valueSummary(longitude)})`,
            );
          }
          console.log(
            `[${kind}] Probe ${ip}: latitude ${latitude === undefined ? "absent (allowed)" : "valid"}, longitude ${longitude === undefined ? "absent (allowed)" : "valid"}`,
          );
        }
      } else {
        if (
          !Number.isSafeInteger(record.autonomous_system_number) ||
          (record.autonomous_system_number as number) <= 0
        ) {
          fail(
            `${stage}: autonomous_system_number must be a positive safe integer (got ${valueSummary(record.autonomous_system_number)})`,
          );
        }
        if (
          typeof record.autonomous_system_organization !== "string" ||
          !record.autonomous_system_organization.trim()
        ) {
          fail(
            `${stage}: autonomous_system_organization must be a non-empty string (got ${valueSummary(record.autonomous_system_organization)})`,
          );
        }
      }
    }
    console.log(`[${kind}] All 6 public IPv4/IPv6 record probes passed`);
    return buildEpoch;
  } catch (error) {
    if (error instanceof SafeError) throw error;
    // Never include dependency messages, stack traces, or raw MMDB records.
    throw new SafeError(`${kind} MMDB failed ${stage}: parser/lookup error (details suppressed)`);
  }
}

export async function bucketName(): Promise<string> {
  let config: { r2_buckets?: { binding?: string; bucket_name?: string }[] };
  try {
    config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  } catch {
    throw new SafeError("wrangler.jsonc must contain valid plain JSON");
  }
  if (
    !config ||
    !Array.isArray(config.r2_buckets) ||
    config.r2_buckets.some((b) => !b || typeof b !== "object")
  )
    throw new SafeError("Invalid r2_buckets in wrangler.jsonc");
  const matches = config.r2_buckets.filter((b) => b.binding === "GEOIP_DB");
  const name = matches[0]?.bucket_name;
  if (
    matches.length !== 1 ||
    typeof name !== "string" ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)
  ) {
    throw new SafeError("Configure exactly one GEOIP_DB binding with a valid R2 bucket_name");
  }
  return name;
}

export function credentials(names: string[]): string[] {
  return names.map((name) => {
    const value = process.env[name]?.trim();
    if (!value) throw new SafeError(`Missing required environment variable ${name}`);
    return value;
  });
}

export async function runMain(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    // Only application-authored messages are safe; dependency errors can contain URLs/secrets.
    console.error(
      error instanceof SafeError
        ? error.message
        : "Operation failed. Check configuration, credentials, network, and database validity.",
    );
    process.exitCode = 1;
  }
}
export class SafeError extends Error {}
