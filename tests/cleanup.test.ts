import { expect, test } from "vitest";
import { cleanupDatabases } from "../src/cleanup";
import { dataset, fakeBucket } from "./fixtures";

test("cleanup paginates, keeps active/recent/unrelated objects, deletes only obsolete versions", async () => {
  const now = Date.now();
  const data = dataset();
  const fake = fakeBucket(data);
  const old = new Date(now - 31 * 86400000);
  const obsolete = `versions/${"a".repeat(64)}/country.mmdb`;
  const recent = `versions/${"b".repeat(64)}/asn.mmdb`;
  const deleted: string[][] = [];
  const cursors: (string | undefined)[] = [];
  fake.bucket.list = (async (options: R2ListOptions) => {
    cursors.push(options.cursor);
    return options.cursor ? {
      objects: [{ key: recent, uploaded: new Date(now) }], truncated: false,
    } : {
      objects: [{ key: obsolete, uploaded: old }, { key: data.manifest.files.country.key, uploaded: old }, { key: "versions/other-data", uploaded: old }],
      truncated: true, cursor: "page2",
    };
  }) as R2Bucket["list"];
  fake.bucket.delete = (async (keys: string[]) => { deleted.push(keys); }) as R2Bucket["delete"];
  await cleanupDatabases(fake.bucket, now);
  expect(deleted).toEqual([[obsolete]]);
  expect(cursors).toEqual([undefined, "page2"]);
});

test("cleanup fails closed when active manifest is missing", async () => {
  const fake = fakeBucket();
  fake.objects.clear();
  fake.bucket.list = (async () => ({ objects: [], delimitedPrefixes: [], truncated: false })) as R2Bucket["list"];
  await expect(cleanupDatabases(fake.bucket)).rejects.toThrow("missing");
});
