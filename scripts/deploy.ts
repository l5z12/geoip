import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  Cloudflare,
  projectConfig,
  readyRelease,
  RELEASE_CONFIG,
  RELEASE_STATE,
  writeReleaseConfig,
  type D1Info,
} from "./d1-release";
import { runWrangler } from "./publish-databases";
import { credentials, runMain, SafeError, sha256 } from "./shared";

export interface PreparedRelease {
  account: string;
  worker: string;
  previous?: string;
  database: D1Info;
  version: string;
  configHash: string;
}
export async function main() {
  const [token, account] = credentials(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
  let release: PreparedRelease;
  try {
    release = JSON.parse(await readFile(RELEASE_STATE, "utf8"));
  } catch {
    throw new SafeError("Run db:publish successfully before deploying");
  }
  const config = await projectConfig();
  if (
    release.account !== account ||
    release.worker !== config.name ||
    release.configHash !== sha256(JSON.stringify(config))
  )
    throw new SafeError(
      "Prepared release does not match this account/configuration; run db:publish again",
    );
  const api = new Cloudflare(account!, token!);
  const active = await api.activeDatabase(config.name);
  if (active !== release.previous && active !== release.database.uuid)
    throw new SafeError("Live binding changed since preparation; run db:publish again");
  if (!(await readyRelease(api, release.database.uuid, release.version)))
    throw new SafeError("Prepared D1 release is not ready");
  await writeReleaseConfig(config, release.database, release.version);
  if (!(await runWrangler(["deploy", "--config", fileURLToPath(RELEASE_CONFIG)])))
    throw new SafeError("Worker deployment failed");
  console.log(`Deployed ${release.version} using ${release.database.name}`);
}
if (import.meta.main) await runMain(main);
