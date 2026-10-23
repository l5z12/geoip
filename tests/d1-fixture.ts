import { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";
import { D1_SCHEMA, releaseMetadata } from "../src/d1-schema";
import { addDatabase } from "../scripts/build-d1";
import { DATABASE_KINDS } from "../src/manifest";
import { dataset } from "./fixtures";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

export async function d1Fixture(data = dataset()) {
  const sql = new DatabaseSync(":memory:");
  databases.push(sql);
  sql.exec(D1_SCHEMA);
  for (const [index, kind] of DATABASE_KINDS.entries()) await addDatabase(sql, index, data[kind]);
  sql
    .prepare("INSERT INTO metadata VALUES (1, ?, 1)")
    .run(JSON.stringify(releaseMetadata(data.manifest)));
  const calls: { constraint: string; query: string; params: unknown[] }[] = [];
  const replica = { fail: false, stale: false };
  const binding = {
    withSession(constraint: string) {
      return {
        prepare(query: string) {
          return {
            bind(...params: (string | number)[]) {
              return {
                async all() {
                  calls.push({ constraint, query, params });
                  if (constraint === "first-unconstrained" && replica.fail)
                    throw new Error("Replica unavailable");
                  const results = sql.prepare(query).all(...params);
                  if (constraint === "first-unconstrained" && replica.stale) {
                    for (const row of results)
                      if (row.kind === -1) {
                        const metadata = JSON.parse(row.data as string);
                        metadata.version = "a".repeat(64);
                        row.data = JSON.stringify(metadata);
                      }
                  }
                  return { success: true, results };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { sql, binding, calls, data, replica };
}
