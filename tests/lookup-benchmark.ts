import { DatabaseSync } from "node:sqlite";
import { D1_SCHEMA, LOOKUP_SQL } from "../src/d1-schema";
import { BLOCK_RANGES } from "../scripts/build-d1";

const db = new DatabaseSync(":memory:");
try {
  db.exec(D1_SCHEMA);
  db.exec("INSERT INTO metadata VALUES (1, '{}', 1); INSERT INTO records VALUES (1, '{}')");
  const insert = db.prepare("INSERT INTO blocks VALUES (?, 4, ?, ?)");
  db.exec("BEGIN");
  for (let first = 0; first < 250_000; first += BLOCK_RANGES) {
    const block: [string, string, number, number][] = [];
    for (let value = first; value < Math.min(first + BLOCK_RANGES, 250_000); value++) {
      const key = (0x08000000 + value * 2).toString(16).padStart(8, "0");
      block.push([key, key, 32, 1]);
    }
    for (let kind = 0; kind < 3; kind++) insert.run(kind, block[0]![0], JSON.stringify(block));
  }
  db.exec("COMMIT");
  const query = db.prepare(LOOKUP_SQL),
    timings: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const key = (0x08000000 + ((i * 997) % 500_000)).toString(16).padStart(8, "0");
    const start = performance.now();
    query.all(4, key);
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        engine: "local SQLite (excludes D1 network latency)",
        ranges: 750000,
        blockRanges: BLOCK_RANGES,
        distinctLookups: 1000,
        medianMs: timings[500],
        p95Ms: timings[950],
        queryPlan: db
          .prepare("EXPLAIN QUERY PLAN " + LOOKUP_SQL)
          .all(4, "08000000")
          .map((row) => row.detail),
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
