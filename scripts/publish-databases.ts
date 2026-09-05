import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DATABASE_KINDS, MAX_MANIFEST_BYTES, parseManifest, type DatabaseKind, type Manifest } from "../src/manifest";
import { bucketName, credentials, DATA_DIR, pageDigests, runMain, SafeError, sha256, validateDatabase, versionFor } from "./shared";

export function publishMode(args: string[]): "--local" | "--remote" {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--local" && args[0] !== "--remote")) throw new SafeError("Usage: bun scripts/publish-databases.ts [--local|--remote]");
  return args[0] === "--local" ? "--local" : "--remote";
}
export async function validateLocal(dataDir = DATA_DIR): Promise<Manifest> {
  const path = new URL("manifest.json", dataDir);
  if ((await stat(path)).size > MAX_MANIFEST_BYTES) throw new SafeError("Manifest too large");
  let manifest: Manifest;
  try { manifest = parseManifest(JSON.parse(await readFile(path, "utf8"))); }
  catch { throw new SafeError("Invalid local manifest; run db:download first"); }
  for (const kind of DATABASE_KINDS) {
    const path = new URL(`${kind}.mmdb`, dataDir);
    const file = manifest.files[kind];
    if ((await stat(path)).size !== file.bytes) throw new SafeError(`${kind} database size differs from manifest`);
    const bytes = await readFile(path);
    const pages = pageDigests(bytes);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256 ||
        pages.length !== file.pageSha256.length || pages.some((hash, index) => hash !== file.pageSha256[index]) ||
        validateDatabase(kind, bytes) !== file.buildEpoch) throw new SafeError(`${kind} database differs from manifest`);
  }
  if (manifest.version !== versionFor(Object.fromEntries(DATABASE_KINDS.map(k => [k, manifest.files[k].sha256])) as Record<DatabaseKind, string>) ||
      manifest.updatedAt !== new Date(Math.max(...DATABASE_KINDS.map(k => Date.parse(manifest.files[k].buildEpoch)))).toISOString()) throw new SafeError("Manifest version or update time differs from database builds");
  return manifest;
}
export function publicationPlan(manifest: Manifest): { key: string; file: string }[] {
  return [
    ...DATABASE_KINDS.map(kind => ({ key: manifest.files[kind].key, file: `${kind}.mmdb` })),
    { key: `versions/${manifest.version}/manifest.json`, file: "manifest.json" },
    { key: "manifest.json", file: "manifest.json" },
  ];
}
export async function main(): Promise<void> {
  const mode = publishMode(process.argv.slice(2));
  const bucket = await bucketName();
  if (mode === "--remote") credentials(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
  const manifest = await validateLocal();
  for (const item of publicationPlan(manifest)) {
    const child = Bun.spawn(["bun", "x", "wrangler", "r2", "object", "put", `${bucket}/${item.key}`, "--file", fileURLToPath(new URL(item.file, DATA_DIR)), mode], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), stdout: "ignore", stderr: "ignore",
    });
    if (await child.exited !== 0) throw new SafeError(`R2 upload failed for ${item.key}; active manifest was not advanced unless its final upload succeeded`);
  }
  console.log(`Published ${manifest.version} (${mode.slice(2)}); active manifest written last`);
}
if (import.meta.main) await runMain(main);
