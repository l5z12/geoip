import { readManifest } from "./database";

const RETENTION_MS = 29 * 24 * 60 * 60 * 1000;

/** Remove superseded generations; never touch the active manifest or other keys. */
export async function cleanupDatabases(bucket: R2Bucket, now = Date.now()): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "versions/", limit: 1000, cursor });
    // Read the active pointer again per page. A missing/invalid pointer aborts
    // cleanup rather than risking deletion of a recoverable database.
    const manifest = await readManifest(bucket);
    const activePrefix = `versions/${manifest.version}/`;
    const keys = page.objects
      .filter((object) => /^versions\/[a-f0-9]{64}\/(country\.mmdb|city\.mmdb|asn\.mmdb|manifest\.json)$/.test(object.key) &&
        !object.key.startsWith(activePrefix) && object.uploaded.getTime() < now - RETENTION_MS)
      .map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
