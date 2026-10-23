import { readFile, stat, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildD1, fullImport, patchImport, type BuildStats } from "./build-d1";
import {
  acquireLease,
  activate,
  Cloudflare,
  chooseSlot,
  copySlot,
  MismatchError,
  patchable,
  projectConfig,
  readyRelease,
  releaseLease,
  RELEASE_CONFIG,
  RELEASE_STATE,
  validateRemote,
  writeReleaseConfig,
  type D1Info,
} from "./d1-release";
import type { PreparedRelease } from "./deploy";
import {
  DATABASE_KINDS,
  MAX_MANIFEST_BYTES,
  parseManifest,
  type DatabaseKind,
  type Manifest,
} from "../src/manifest";
import {
  bucketName,
  credentials,
  DATA_DIR,
  pageDigests,
  runMain,
  SafeError,
  sha256,
  searchTreeSize,
  validateDatabase,
  versionFor,
} from "./shared";

export function publishMode(args: string[]): "--local" | "--remote" {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--local" && args[0] !== "--remote"))
    throw new SafeError("Usage: pnpm run db:publish [--local|--remote]");
  return args[0] === "--local" ? "--local" : "--remote";
}
export async function validateLocal(dataDir = DATA_DIR): Promise<Manifest> {
  const path = new URL("manifest.json", dataDir);
  if ((await stat(path)).size > MAX_MANIFEST_BYTES) throw new SafeError("Manifest too large");
  let manifest: Manifest;
  try {
    manifest = parseManifest(JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw new SafeError("Invalid local manifest; run db:download first");
  }
  for (const kind of DATABASE_KINDS) {
    const path = new URL(`${kind}.mmdb`, dataDir);
    const file = manifest.files[kind];
    if ((await stat(path)).size !== file.bytes)
      throw new SafeError(`${kind} database size differs from manifest`);
    const bytes = await readFile(path);
    const pages = pageDigests(bytes);
    if (
      bytes.length !== file.bytes ||
      (file.searchTreeSize !== undefined && file.searchTreeSize !== searchTreeSize(bytes)) ||
      sha256(bytes) !== file.sha256 ||
      pages.length !== file.pageSha256.length ||
      pages.some((hash, index) => hash !== file.pageSha256[index]) ||
      validateDatabase(kind, bytes) !== file.buildEpoch
    )
      throw new SafeError(`${kind} database differs from manifest`);
  }
  if (
    manifest.version !==
      versionFor(
        Object.fromEntries(DATABASE_KINDS.map((k) => [k, manifest.files[k].sha256])) as Record<
          DatabaseKind,
          string
        >,
      ) ||
    manifest.updatedAt !==
      new Date(
        Math.max(...DATABASE_KINDS.map((k) => Date.parse(manifest.files[k].buildEpoch))),
      ).toISOString()
  )
    throw new SafeError("Manifest version or update time differs from database builds");
  return manifest;
}
/** The versioned archive is uploaded before D1 is touched, so every release
 * that can go live is recoverable from R2. The archive pointer goes last,
 * after D1 validation. */
export function publicationPlan(manifest: Manifest) {
  return {
    archive: [
      ...DATABASE_KINDS.map((kind) => ({ key: manifest.files[kind].key, file: `${kind}.mmdb` })),
      { key: `versions/${manifest.version}/manifest.json`, file: "manifest.json" },
    ],
    pointer: { key: "manifest.json", file: "manifest.json" },
  };
}
export async function runWrangler(args: string[]): Promise<boolean> {
  // Launch the installed CLI with Node directly: no shell or platform-specific
  // pnpm shim, and paths/arguments containing spaces stay intact on Windows.
  const require = createRequire(import.meta.url);
  const packageUrl = pathToFileURL(require.resolve("wrangler/package.json"));
  const { bin } = require("wrangler/package.json") as { bin: { wrangler: string } };
  const wrangler = fileURLToPath(new URL(bin.wrangler, packageUrl));
  return new Promise<boolean>((resolve) => {
    const child = spawn(process.execPath, [wrangler, ...args], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}
const SLOT_COPY = new URL("slot.sqlite", DATA_DIR);
/** Diff against a copy of the slot's actual rows. Returns undefined when only
 * a full import can bring the slot up to date. */
async function slotPatch(api: Cloudflare, id: string, build: BuildStats) {
  if (!(await patchable(api, id))) {
    console.log("Inactive D1 slot does not have this schema's tables; importing in full");
    return undefined;
  }
  console.log("Copying the inactive D1 slot to diff against");
  return patchImport(build, await copySlot(api, id, fileURLToPath(SLOT_COPY)));
}
/** Bring the leased inactive slot to `build`, patching when possible, and mark
 * it ready only once its rows match the build. */
async function stageSlot(
  api: Cloudflare,
  target: D1Info,
  existing: boolean,
  lease: string,
  build: BuildStats,
  version: string,
) {
  const importFiles = async (files: string[]) => {
    for (const [index, file] of files.entries()) {
      // Renewing first stops a publisher whose lease expired and was taken.
      await acquireLease(api, target.uuid, lease);
      console.log(`Importing D1 file ${index + 1}/${files.length} into ${target.name}`);
      if (
        !(await runWrangler([
          "d1",
          "execute",
          "GEOIP_LOOKUP",
          "--config",
          fileURLToPath(RELEASE_CONFIG),
          "--remote",
          "--file",
          file,
          "--yes",
        ]))
      )
        throw new SafeError("Staging D1 import failed; live binding was not changed");
    }
  };
  const patch = existing ? await slotPatch(api, target.uuid, build) : undefined;
  await importFiles((patch ?? (await fullImport(build))).files);
  try {
    await validateRemote(api, target.uuid, build);
  } catch (error) {
    if (!patch || !(error instanceof MismatchError)) throw error;
    // The slot changed after it was copied; rebuild it.
    console.log("Patched D1 differs from the new build; importing in full");
    await importFiles((await fullImport(build)).files);
    await validateRemote(api, target.uuid, build);
  }
  await activate(api, target.uuid, lease);
  if (!(await readyRelease(api, target.uuid, version)))
    throw new SafeError("D1 release validation failed");
}
export async function main(): Promise<void> {
  const mode = publishMode(process.argv.slice(2));
  // Never leave an old deployment receipt usable after a failed new build.
  await rm(RELEASE_STATE, { force: true });
  const bucket = await bucketName();
  const manifest = await validateLocal();
  const config = await projectConfig();
  let prepared: PreparedRelease | undefined;
  let release: (() => Promise<void>) | undefined;
  const plan = publicationPlan(manifest);
  async function upload(items: { key: string; file: string }[]) {
    for (const item of items) {
      const succeeded = await runWrangler([
        "r2",
        "object",
        "put",
        `${bucket}/${item.key}`,
        "--file",
        fileURLToPath(new URL(item.file, DATA_DIR)),
        mode,
      ]);
      if (!succeeded)
        throw new SafeError(
          `R2 upload failed for ${item.key}; active manifest was not advanced unless its final upload succeeded`,
        );
    }
  }
  try {
    await upload(plan.archive);
    if (mode === "--local") {
      const { files } = await fullImport(await buildD1(manifest));
      for (const file of files) {
        if (
          !(await runWrangler([
            "d1",
            "execute",
            "GEOIP_LOOKUP",
            "--local",
            "--file",
            file,
            "--yes",
          ]))
        )
          throw new SafeError("Local D1 import failed");
      }
      if (
        !(await runWrangler([
          "d1",
          "execute",
          "GEOIP_LOOKUP",
          "--local",
          "--command",
          "UPDATE metadata SET ready = 1 WHERE id = 1",
          "--yes",
        ]))
      )
        throw new SafeError("Local D1 activation failed");
    } else {
      const [token, account] = credentials(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
      const api = new Cloudflare(account!, token!);
      const active = await api.activeDatabase(config.name);
      const databases = await api.databases();
      const slot = chooseSlot(config.name, databases, active);
      let target: D1Info;
      let lease: string | undefined;
      if (active && (await readyRelease(api, active, manifest.version))) {
        target = databases.find((db) => db.uuid === active)!;
        console.log("D1 already contains this validated release; skipping import");
      } else {
        const build = await buildD1(manifest);
        target = slot.existing ?? (await api.create(slot.name));
        await api.call(`d1/database/${encodeURIComponent(target.uuid)}`, "PUT", {
          read_replication: { mode: "auto" },
        });
        if (target.uuid === active || (await api.activeDatabase(config.name)) !== active)
          throw new SafeError("Live binding changed; refusing to import into D1");
        await writeReleaseConfig(config, target, manifest.version);
        const owner = randomUUID(),
          id = target.uuid;
        await acquireLease(api, id, owner);
        lease = owner;
        release = () => releaseLease(api, id, owner);
        // Deploy keeps the lease until its slot is live, so another publisher
        // may have made this slot live just before we took the lease; once we
        // hold it, the binding cannot move here.
        if ((await api.activeDatabase(config.name)) !== active)
          throw new SafeError("Live binding changed; refusing to import into D1");
        await stageSlot(api, target, !!slot.existing, owner, build, manifest.version);
      }
      prepared = {
        account: account!,
        worker: config.name,
        previous: active,
        database: target,
        version: manifest.version,
        configHash: sha256(JSON.stringify(config)),
        ...(lease ? { lease } : {}),
      };
    }
    await upload([plan.pointer]);
    if (prepared) await writeFile(RELEASE_STATE, JSON.stringify(prepared) + "\n");
  } catch (error) {
    // Let the next publisher in now rather than when the lease expires. On
    // success the lease passes to deploy through the receipt.
    await release?.().catch(() => undefined);
    throw error;
  }
  console.log(
    `Prepared ${manifest.version} (${mode.slice(2)}): D1 validated, original MMDBs archived in R2${prepared ? "; run deploy to switch the live binding" : ""}`,
  );
}
if (import.meta.main) await runMain(main);
