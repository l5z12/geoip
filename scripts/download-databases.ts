import { Buffer } from "node:buffer";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
import { DATABASE_KINDS, MAX_DATABASE_BYTES, MAX_MANIFEST_BYTES, parseManifest, type DatabaseKind, type Manifest } from "../src/manifest";
import { credentials, DATA_DIR, EDITIONS, pageDigests, runMain, SafeError, sha256, validateDatabase, versionFor } from "./shared";

export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 384 * 1024 * 1024;

// Parse regular ustar entries only; never materialize archive paths, symlinks, or devices.
export function extractArchive(archive: Buffer, edition: string): { database: Buffer; notices: Record<string, Buffer> } {
  if (archive.length > MAX_ARCHIVE_BYTES) throw new SafeError("Archive exceeds compressed size limit");
  let tar: Buffer;
  try { tar = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES }); }
  catch { throw new SafeError("Invalid gzip archive or expanded size limit exceeded"); }
  let database: Buffer | undefined;
  const notices: Record<string, Buffer> = {};
  let offset = 0;
  const text = (b: Uint8Array) => new TextDecoder().decode(b).split("\0", 1)[0]!;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset).every(b => b === 0)) throw new SafeError("Invalid tar end marker");
      if (!database) throw new SafeError("Archive missing expected MMDB");
      return { database, notices };
    }
    const octal = (b: Buffer) => {
      const value = text(b).trim();
      if (!/^[0-7]+$/.test(value)) throw new SafeError("Invalid tar numeric field");
      return Number.parseInt(value, 8);
    };
    const checksum = header.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0);
    if (checksum !== octal(header.subarray(148, 156))) throw new SafeError("Invalid tar checksum");
    const prefix = text(header.subarray(345, 500));
    const name = (prefix ? prefix + "/" : "") + text(header.subarray(0, 100));
    if (!name || name.startsWith("/") || name.includes("\\") || name.includes(":") || name.split("/").some(p => p === ".." || p === ".")) throw new SafeError("Unsafe archive path");
    const size = octal(header.subarray(124, 136));
    const type = header[156];
    if (type !== 0 && type !== 48 && type !== 53) throw new SafeError("Unsupported archive entry type");
    if (type === 53 && size !== 0) throw new SafeError("Invalid archive directory");
    const end = offset + 512 + size;
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > tar.length) throw new SafeError("Truncated tar entry");
    if (type !== 53) {
      const base = name.split("/").at(-1)!;
      const content = tar.subarray(offset + 512, end);
      if (base === `${edition}.mmdb`) {
        if (database || !size || size > MAX_DATABASE_BYTES) throw new SafeError("Duplicate or oversized MMDB entry");
        database = Buffer.from(content);
      } else if (/^(LICENSE|COPYRIGHT)(\.txt)?$/i.test(base)) {
        if (size > 256 * 1024 || notices[base]) throw new SafeError("Invalid license notice entry");
        notices[base] = Buffer.from(content);
      }
    }
    offset = next;
  }
  throw new SafeError("Truncated tar archive");
}

export async function downloadArchive(kind: DatabaseKind, authorization: string): Promise<Buffer> {
  const url = `https://download.maxmind.com/geoip/databases/${EDITIONS[kind]}/download?suffix=tar.gz`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    const started = Date.now();
    let failure = "network request failed";
    console.log(`[${kind}] Downloading ${EDITIONS[kind]} (attempt ${attempt + 1}/3)`);
    try {
      // Native fetch strips Authorization when following cross-origin redirects.
      const response = await fetch(url, { headers: { Authorization: authorization }, signal: controller.signal });
      // Never log headers, response bodies, or URLs (redirects can contain signed credentials).
      console.log(`[${kind}] Download response: HTTP ${response.status}, redirected=${response.redirected}`);
      failure = `HTTP ${response.status}${!response.body ? ", missing response body" : ""}`;
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new SafeError("MaxMind authentication or download entitlement failed");
        throw new Error("download status");
      }
      if (Number(response.headers.get("content-length")) > MAX_ARCHIVE_BYTES) {
        await response.body.cancel();
        throw new SafeError("MaxMind archive exceeds compressed size limit");
      }
      failure = "response body read failed";
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > MAX_ARCHIVE_BYTES) throw new SafeError("MaxMind archive exceeds compressed size limit");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      console.log(`[${kind}] Download complete: ${length} compressed bytes in ${Date.now() - started} ms`);
      return Buffer.concat(chunks, length);
    } catch (error) {
      if (error instanceof SafeError) throw error;
      if (controller.signal.aborted) failure = "120-second timeout";
      console.warn(`[${kind}] Download attempt ${attempt + 1}/3 failed: ${failure}${attempt < 2 ? `; retrying in ${1000 * 2 ** attempt} ms` : ""}`);
      if (attempt === 2) throw new SafeError(`Unable to download ${EDITIONS[kind]} after three bounded attempts: ${failure}`);
    } finally { clearTimeout(timer); }
    await sleep(1000 * 2 ** attempt);
  }
  throw new SafeError("Download failed");
}

export async function main(): Promise<void> {
  const [account, key] = credentials(["MAXMIND_ACCOUNT_ID", "MAXMIND_LICENSE_KEY"]);
  const authorization = `Basic ${Buffer.from(`${account}:${key}`).toString("base64")}`;
  const results = {} as Record<DatabaseKind, ReturnType<typeof extractArchive> & { buildEpoch: string; sha256: string; pageSha256: string[] }>;
  let total = 0;
  for (const kind of DATABASE_KINDS) {
    const archive = await downloadArchive(kind, authorization);
    console.log(`[${kind}] Extracting ${EDITIONS[kind]} archive`);
    const extracted = extractArchive(archive, EDITIONS[kind]);
    console.log(`[${kind}] Extracted ${extracted.database.length} MMDB bytes and ${Object.keys(extracted.notices).length} license notices; validating`);
    total += extracted.database.length;
    if (total > MAX_DATABASE_BYTES) throw new SafeError("Combined MMDB size exceeds 512 MiB storage safety budget");
    results[kind] = { ...extracted, buildEpoch: validateDatabase(kind, extracted.database), sha256: sha256(extracted.database), pageSha256: pageDigests(extracted.database) };
  }
  const version = versionFor(Object.fromEntries(DATABASE_KINDS.map(k => [k, results[k].sha256])) as Record<DatabaseKind, string>);
  const manifest: Manifest = {
    schemaVersion: 2, version,
    updatedAt: new Date(Math.max(...DATABASE_KINDS.map(k => Date.parse(results[k].buildEpoch)))).toISOString(),
    files: Object.fromEntries(DATABASE_KINDS.map(k => [k, {
      key: `versions/${version}/${k}.mmdb`, bytes: results[k].database.length,
      sha256: results[k].sha256, pageSha256: results[k].pageSha256, buildEpoch: results[k].buildEpoch,
    }])) as Manifest["files"],
  };
  parseManifest(manifest);
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  if (Buffer.byteLength(manifestJson) > MAX_MANIFEST_BYTES) throw new SafeError("Manifest exceeds size limit");
  await mkdir(DATA_DIR, { recursive: true });
  for (const kind of DATABASE_KINDS) {
    await writeFile(new URL(`${kind}.mmdb.tmp`, DATA_DIR), results[kind].database);
    await rename(new URL(`${kind}.mmdb.tmp`, DATA_DIR), new URL(`${kind}.mmdb`, DATA_DIR));
    const noticeDir = new URL(`licenses/${EDITIONS[kind]}/`, DATA_DIR);
    await mkdir(noticeDir, { recursive: true });
    for (const [name, bytes] of Object.entries(results[kind].notices)) await writeFile(new URL(name, noticeDir), bytes);
  }
  await writeFile(new URL("manifest.json.tmp", DATA_DIR), manifestJson);
  await rename(new URL("manifest.json.tmp", DATA_DIR), new URL("manifest.json", DATA_DIR));
  console.log(`Validated MaxMind databases: ${version}`);
}
if (import.meta.main) await runMain(main);
