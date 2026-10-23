# GeoIP

Cloudflare Worker for public IPv4/IPv6 lookups using **GeoLite2 City, Country, and ASN, with complete MaxMind records**. Uses Node.js and pnpm, MaxMind GeoLite2 databases downloaded **directly from MaxMind**, D1 for indexed lookups, and private R2 storage for original MMDB archives. No mirrored data or external lookup service. The interface follows `d:\l5z12\l5z12`: a narrow document layout, monospace headings, quiet rules, and persistent Auto / Light / Dark themes.

## Deploy with GitHub Actions

1. Enable Cloudflare Workers, D1, and R2 in your account, and ensure `l5z12.dev` is an active Cloudflare zone in that same account. R2 may require billing setup; Workers, D1, and R2 usage charges and limits apply.
2. Create a MaxMind account, accept the [GeoLite2 terms](https://www.maxmind.com/en/geolite2/eula), and generate a license key with database download access. You need the **account ID as well as the key**. A web-services-only key without GeoLite2 download entitlement is not sufficient.
3. Add these GitHub Actions secrets (repository secrets or the `production` environment):

   | Secret                  | Value                                                                                                                                                           |
   | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `MAXMIND_ACCOUNT_ID`    | MaxMind account ID                                                                                                                                              |
   | `MAXMIND_LICENSE_KEY`   | MaxMind license/API key with download access                                                                                                                    |
   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID                                                                                                                                           |
   | `CLOUDFLARE_API_TOKEN`  | **Workers Scripts: Edit**, **D1: Edit**, and **Workers R2 Storage: Edit** for the account; **Zone: Read** and **Workers Routes: Edit** for the `l5z12.dev` zone |

   Enable the account's `workers.dev` subdomain in the Cloudflare dashboard if not already configured; it remains available alongside the custom domain. Do not paste credentials into code, issues, or workflow files.

4. Push this project to a GitHub repository's `main` branch (or run **Deploy** manually from that branch). Deployment validates the project, creates `geoip-databases` if missing, downloads all three databases, imports and validates an inactive D1 slot, archives the originals in R2, and deploys the `geoip` Worker at **https://geoip.l5z12.dev**. The existing `workers.dev` route remains enabled.

The Worker/bucket names and custom domain live in `wrangler.jsonc`. Deployment registers `geoip.l5z12.dev` as a Workers Custom Domain; Cloudflare manages its DNS record and TLS certificate. Do not create a CNAME pointing at `workers.dev`. If this hostname already has a conflicting DNS record or Worker binding, resolve that conflict before deployment. Allow time for DNS and certificate provisioning after the first deployment.

The bucket is dedicated to this application and should remain private: **do not enable an R2 public URL**.

### Automation

- **CI**: every push and pull request; frozen pnpm install, formatting check, typecheck, unit tests, bundle, and real `workerd` smoke test. No credentials or MaxMind downloads required.
- **Deploy**: pushes to `main` and manual dispatch; validates, provisions, publishes databases, then deploys.
- **Update databases**: daily at **04:23 UTC**, or manual dispatch; downloads directly from MaxMind and imports a changed release into D1, archives it in R2, and redeploys the Worker to select the validated slot. An unchanged release skips the D1 import. Daily checks do not imply MaxMind publishes a new release daily.
- Deploy/update workflows share a non-cancelling concurrency group. Ensure the `production` environment permits unattended scheduled jobs. GitHub schedules can be delayed and public-repository schedules can be disabled after inactivity; monitor failed/missing runs and re-enable them if needed.
- A Worker cron at **06:37 UTC** removes superseded R2 generations older than 29 days, preserving the active generation. It is not the downloader; database updates run in GitHub Actions.

## Local development

```sh
pnpm install --frozen-lockfile
pnpm run hooks:install
cp .env.example .env
# Fill in MAXMIND_ACCOUNT_ID and MAXMIND_LICENSE_KEY in .env.
pnpm run db:local
pnpm run dev
```

Open `http://localhost:8787`. `db:local` downloads real MaxMind data, validates it, and imports into Wrangler's **local** D1 emulator and archives into its local R2 emulator. Cloudflare credentials are not needed for this mode. Without databases the page still loads and the API returns a clear `503`. Caller-IP lookup may not be available locally; enter a public IP explicitly.

```sh
pnpm run check          # strict TypeScript
pnpm run format         # format source, configuration, and documentation
pnpm run format:check   # check formatting without changing files
pnpm run hooks:check    # run prek hooks against all tracked files
pnpm test               # deterministic unit tests; synthetic MMDB fixtures
pnpm run test:runtime   # bundle + real workerd/D1 smoke test with empty R2
pnpm run bench:lookup   # indexed SQLite benchmark (excludes D1 network latency)
pnpm run db:download    # MaxMind -> .data/, validate all three databases
pnpm run db:publish     # .data/ -> inactive D1 + R2 archives; prepares deployment
pnpm run infra:ensure   # create/verify remote bucket
pnpm run deploy         # verify the prepared release and switch the Worker binding
```

Use **Node.js 24** (at least 24.10.0) and **pnpm 10.34.7**. The pnpm version is pinned in `package.json`; workflows use `.node-version` and `pnpm-lock.yaml`. Tests use Vitest; TypeScript scripts run on Node.js with tsx. Database scripts load `.env` when present, with existing environment variables taking precedence. `.env`, `.data`, `.wrangler-release.json`, local D1/R2 state, database archives, and MMDBs are ignored by Git. No database artifacts are uploaded to GitHub. Local `.data/licenses/` retains notices provided by MaxMind archives.

Prettier and prek are pinned development dependencies, so no global installation is needed. Run `pnpm run hooks:install` once per clone to enable the pre-commit hook. It formats changed text files with the project's Prettier version; if it changes a staged file, review and stage that file again before committing. CI and deployment use `pnpm run format:check` to reject formatting drift without rewriting files. `.prettierignore` excludes generated output, private data, and the pnpm lockfile. Git and Prettier use LF line endings; `wrangler.jsonc` is formatted as strict JSON because the database scripts parse it with `JSON.parse`.

## API

```sh
curl 'https://geoip.l5z12.dev/api/lookup?ip=1.1.1.1'
curl 'https://geoip.l5z12.dev/api/lookup?ip=2606%3A4700%3A4700%3A%3A1111'
curl 'https://geoip.l5z12.dev/api/lookup'   # caller's public IP
curl 'https://geoip.l5z12.dev/api/status'
```

Lookup responses contain:

- `ip`, `version` (`4` or `6`); IPv4-mapped IPv6 is normalized to IPv4.
- `country`: `{ code, name }` or `null`. The geolocated country, **not** the registration country.
- `asn`: `{ number, name }` or `null`.
- `network`: `{ country, city, asn }`, each a matching MMDB network in CIDR notation or `null`.
- **`records`: `{ country, city, asn }`**, containing each database's complete original record or `null`. There is no field whitelist: every available localized name, continent, GeoNames ID, country/registered/represented country, EU membership flag, city, subdivision, postal code, location (latitude, longitude, accuracy radius, metro code, timezone), ASN, organization, and trait is preserved. Optional and future fields pass through unchanged. The page includes a full-record inspector as well as summaries and copyable JSON.
- `database`: content-derived `version`, `updatedAt` (newest database build time, not fetch time), per-database `builds`, `stale`, and attribution `sources`.

Missing source fields remain absent; no data is invented. Country and City can report different countries, so their original records remain separate. Values beyond JavaScript's safe integer range are represented as decimal strings; MMDB binary values use `{ "$type": "bytes", "base64": "…" }` for lossless JSON. Paid GeoIP2 Enterprise, ISP, Anonymous IP, and other separately licensed datasets are not included by a GeoLite2 subscription or downloaded by this configuration.

Valid public addresses with no match return `200` with nullable fields. Invalid, private, reserved, documentation, and transition addresses return `400`; unavailable or expired databases return `503` with `Retry-After: 30`. Errors use `{ "error": { "code": "…", "message": "…" } }`. `/api/status` returns `status: "ok"` with the same database metadata, or `503` if the selected release is unavailable, incomplete, or expired. `database.stale` remains `false`; a failed update leaves the previous validated release selected until it expires.

Only literal addresses are accepted, not hostnames, CIDR input, ports, zone IDs, or ambiguous/octal IPv4 notation. `GET`, `HEAD`, and `OPTIONS` are supported. Explicit-IP lookups and status allow public CORS; the caller-IP endpoint is same-origin to avoid exposing visitors' IPs to arbitrary websites. Responses use `Cache-Control: no-store`. Visitor addresses come only from Cloudflare's connecting-IP headers (including Pseudo IPv4's IPv6 header), never `X-Forwarded-For`.

Successful responses include `Server-Timing`: `lookup` measures the D1 query and response assembly. Lookup `database` initialization is zero because no MMDB is opened; status uses `database` for its metadata query. Durations are milliseconds spent in the Worker, excluding the client's network round trip. Explicit-IP and status responses expose this header through CORS so external clients can inspect it.

## Storage, updates, and operations

The Worker uses **one D1 query per lookup** to fetch release metadata plus the complete Country, City, and ASN records. It does **zero R2 reads** during lookup or status requests. There is no per-IP result cache and fresh addresses use the same indexed path as repeated ones. The MMDB decoder runs only in CI/local import scripts and is absent from the Worker bundle.

CI converts each MMDB leaf into a disjoint address interval. IPv4 keys use eight hexadecimal digits; IPv6 keys use 32, preserving every bit without JavaScript integer rounding. Because D1 bills every written row, consecutive intervals of one family share a `blocks` row as a JSON array of `[start, end, prefix, record_id]`: 64 on average, 256 at most. Block boundaries are content-defined (a block of at least 32 intervals ends before an interval whose start hashes to a cut point), so adding or removing an interval moves only nearby boundaries. The `(kind, family, start)` primary key seeks the preceding block after `LIMIT 1`, and `json_each` checks that block's intervals, avoiding table scans for missing addresses. Records are stored once per distinct content and referenced by intervals; a record's id is a 48-bit hash of its JSON (probed on collision) rather than its MMDB offset, so unchanged records and the blocks that cite them stay identical between releases. Original prefix lengths and complete JSON records are retained. The importer includes all IPv4 ranges and the IPv6 `2000::/3` space accepted by the API. MaxMind aliases the IPv4 tree at `::ffff:0:0/96`, Teredo `2001::/32`, and 6to4 `2002::/16`; the API rejects those addresses, so no alias is imported.

[D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) is enabled automatically. Each request uses its own `first-unconstrained` session so it can read a nearby replica. The Worker checks both the expected content version and import schema version. If a replica is unavailable or still has the old slot contents, it retries the primary. An incomplete or expired release is never served. One query is one binding request, **not one billable row read**; D1 accounts for rows read by the query and index operations.

### Publication

1. Download directly from MaxMind. Validate archive bounds, edition, dual-stack probes, complete records, build freshness, and whole-file/page SHA-256 hashes. The combined original MMDB size remains capped at 512 MiB.
2. Archive the original MMDBs and the version manifest under `versions/<sha256>/` in private R2 before writing to D1. Every slot that becomes ready therefore has its release archived for the next patch to diff against. Rerunning after a failed upload simply uploads it again.
3. Read the live Worker's D1 binding. Use the other slot, `geoip-lookup-a` or `geoip-lookup-b`, creating it if needed. Reuse a ready active release when its data and schema versions already match. An unexpected live binding aborts publication. Before writing, take a two-hour lease on the slot (a `lease` row that full imports do not drop). Another publisher, from CI or a local run, stops instead of interleaving its SQL. The lease is renewed before every import file and passes to `pnpm run deploy`, which releases it after deploying. A failed publication releases it at once.
4. Build a local SQLite database with deduplicated records and indexed range blocks. Compare sample lookups with the original MMDBs and report range, block, and record counts and file size.
5. Patch the inactive slot when it holds a ready release of the current schema. CI downloads that release's archived MMDBs from R2, checks their hashes, rebuilds them locally, and diffs the two builds. The import writes only deleted, changed, and added `blocks` and `records` rows (as idempotent deletes and upserts), plus the metadata row. The slot is marked unready with `patch_from` first, so an interrupted patch is rerun from the same base. A full import runs instead in these cases: the slot is missing tables, uses an older schema, or holds a release built 28 or more days ago (whose archive may be pruned); the archive fails its hashes or cannot be rebuilt; or the patch would be no smaller than the full build. Cloudflare API and R2 download failures stop publishing instead, so a transient error never costs a full import. Stop if the import would write more than `D1_MAX_ROWS` rows. Export statements below 90 KB, at most 500 rows each, into files of at most 64 MiB. Imports do not contain explicit transactions.
6. Validate the imported rows against the local build, then mark the slot ready while the lease is still held. Validation compares row counts, whole-table checksums, and IPv4/IPv6 records. Each block stores a 32-bit hash of its JSON, and record ids hash their content, so the checksums cover every row, including rows a patch never touched. A patched slot whose rows differ is imported in full and validated again. The live binding stays unchanged throughout the import.
7. Write R2's `manifest.json` pointer last. R2 is the archive, not the live D1 selector.
8. Save an ignored deployment receipt only after D1 validation and R2 publication succeed. `pnpm run deploy` checks the account, configuration, live binding, and ready release before deploying with the selected D1 ID and expected version. Both workflows perform this step.

The two slots bound storage growth. Only the inactive slot is written; the previous release remains in the other slot until a subsequent update reuses it. Because slots alternate, each patch spans two releases: the inactive slot moves from the release before the live one to the new one. The slot lease stops a manual publication that overlaps CI. A job killed mid-run holds the slot until its lease expires, two hours later. Do not use gradual deployments with these reusable slots. Both workflows share the same serialization group. Import and archive failures leave the live Worker binding unchanged. Serving still depends on D1 availability and account-wide quotas; exhausting a quota can affect both slots. Monitor failed jobs because the selected data still expires after 30 days. A failed deployment should be checked in Cloudflare before retrying. Raw archive cleanup retains the newest archived generation and removes superseded R2 generations after 29 days.

### Capacity and validation

The importer defaults to a conservative **500,000,000-byte local build limit**. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) depend on your plan: Free allows 500 MB per database and paid allows up to 10 GB. If a real release exceeds the default, the job stops before importing. On an account with sufficient capacity, set the GitHub repository/environment variable `D1_MAX_BYTES` (or the local environment variable) to the permitted ceiling, at most `10000000000`. Budget for both slots and account-wide storage/write quotas. The [Free plan has a 100,000-row daily write allowance](https://developers.cloudflare.com/d1/platform/pricing/); a full GeoLite import can exceed that even when it fits the storage limit. Use the emitted row counts to plan capacity, and expect a paid plan for full dataset refreshes. Paid imports still count toward usage: Workers Paid includes 50 million rows written per month and bills each further million. GeoLite2 ASN is rebuilt daily, so most daily runs import a new release. A patch writes one row per changed block or record; a full import writes every row and runs only for a new slot, a schema change, a missing archive, or a failed patch. The first two updates after a `D1_SCHEMA_VERSION` change import each slot in full. Publishing stops before importing when one import would write more than `D1_MAX_ROWS` rows (default 1,500,000, which keeps a daily full import for a 31-day month within the included writes). Raise it, through the GitHub variable or local environment, only after budgeting for the extra writes. The logged SQLite size is a preflight estimate; D1 enforces its actual limits during import.

Tests cover 24-, 28-, and 32-bit MMDB trees, exact IPv4/IPv6 boundaries, gaps, original prefix lengths, sparse/full records, SQL escaping, indexed query plans, content-defined block boundaries, patch diffs and reruns, slot leases, checksum mismatches, failed import validation, unready/expired releases, and stale replica fallback. The runtime smoke test imports generated SQL into real workerd D1 and exercises concurrent cold lookups and isolate restarts with **empty R2**. `bench:lookup` measures 1,000 distinct local SQLite lookups across 750,000 synthetic ranges; it does not predict production D1 network latency. Licensed production database size and deployed latency must be measured during rollout.

The API remains public and unauthenticated. No application IP logging, analytics, or third-party browser requests are implemented; Workers observability remains disabled. Infrastructure may retain request metadata. Monitor `/api/status`, GitHub jobs, D1 quotas/latency, R2 usage, and cron failures. Retain and remove licensed data according to your MaxMind agreement.

### Rollback

A Worker version rollback can reuse the previous D1 slot only while that slot still contains the expected, unexpired release. Slots are reused on later updates, so older Worker versions are not permanent data backups. For data recovery, download the desired archived `manifest.json` and its three referenced MMDB objects into `.data/` as `manifest.json`, `country.mmdb`, `city.mmdb`, and `asn.mmdb`; then run `pnpm run db:publish` and `pnpm run deploy`. Publication revalidates hashes, metadata, and freshness before staging the archive into the inactive slot. Coordinate manual recovery with the update jobs. Changing R2's active manifest alone does not switch D1.

## Code license

Unless otherwise noted, the original project code—including the Worker, frontend, automation scripts, and tests—is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`). See [LICENSE](LICENSE) for the full terms.

MaxMind databases are **not** covered by this code license; they retain their own licensing terms. Third-party dependencies and any third-party notices retain their respective licenses.

When deploying a modified version for network use, provide users a prominent link to the corresponding source for the deployed version, including build and deployment scripts, as required by AGPL section 13. Do not include credentials or private database files in that source offer.

## Attribution

This product includes GeoLite2 data created by [MaxMind](https://www.maxmind.com/). Review the [GeoLite2 EULA](https://www.maxmind.com/en/geolite2/eula), [download instructions](https://dev.maxmind.com/geoip/updating-databases/), and notices distributed with your databases. MaxMind credentials are used only by download scripts, not deployed as Worker secrets or sent to visitors.
