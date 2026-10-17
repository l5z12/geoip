import { MANIFEST_KEY, MAX_MANIFEST_BYTES, parseManifest, type Manifest } from "./manifest";

export async function readManifest(bucket: R2Bucket): Promise<Manifest> {
  const object = await bucket.get(MANIFEST_KEY);
  if (!object) throw new Error("Database manifest is missing");
  if (object.size > MAX_MANIFEST_BYTES) {
    await object.body.cancel();
    throw new Error("Database manifest is too large");
  }
  return parseManifest(await object.json());
}
