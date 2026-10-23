import { DatabaseSync } from "node:sqlite";
import { D1_SCHEMA, LOOKUP_SQL } from "../src/d1-schema";
import { startsBlock } from "../scripts/build-d1";

const db = new DatabaseSync(":memory:");
try {
  db.exec(D1_SCHEMA);
  db.exec("INSERT INTO metadata VALUES (1, '{}', 1, NULL); INSERT INTO records VALUES (1, '{}')");
  const insert = db.prepare("INSERT INTO blocks VALUES (?, 4, ?, 0, ?)");
  db.exec("BEGIN");
  let block: [string, string, number, number][] = [],
    blocks = 0;
  function flush() {
    for (let kind = 0; kind < 3; kind++) insert.run(kind, block[0]![0], JSON.stringify(block));
    block = [];
    blocks++;
  }
  for (let value = 0; value < 250_000; value++) {
    const key = (0x08000000 + value * 2).toString(16).padStart(8, "0");
    if (startsBlock(key, block.length)) flush();
    block.push([key, key, 32, 1]);
  }
  flush();
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
        meanBlockRanges: Math.round(250_000 / blocks),
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
