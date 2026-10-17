# GeoIP

Cloudflare Worker for public IPv4/IPv6 lookups using **GeoLite2 City, Country, and ASN, with complete MaxMind records**. Uses Node.js and pnpm, MaxMind GeoLite2 databases downloaded **directly from MaxMind**, and private R2 storage. No mirrored data or external lookup service. The interface follows `d:\l5z12\l5z12`: a narrow document layout, monospace headings, quiet rules, and persistent Auto / Light / Dark themes.

## Deploy with GitHub Actions

1. Enable Cloudflare Workers and R2 in your account, and ensure `l5z12.dev` is an active Cloudflare zone in that same account. R2 may require billing setup; Workers/R2 usage charges and limits apply.
2. Create a MaxMind account, accept the [GeoLite2 terms](https://www.maxmind.com/en/geolite2/eula), and generate a license key with database download access. You need the **account ID as well as the key**. A web-services-only key without GeoLite2 download entitlement is not sufficient.
3. Add these GitHub Actions secrets (repository secrets or the `production` environment):

   | Secret                  | Value                                                                                                                                            |
   | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `MAXMIND_ACCOUNT_ID`    | MaxMind account ID                                                                                                                               |
   | `MAXMIND_LICENSE_KEY`   | MaxMind license/API key with download access                                                                                                     |
   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID                                                                                                                            |
   | `CLOUDFLARE_API_TOKEN`  | **Workers Scripts: Edit** and **Workers R2 Storage: Edit** for the account; **Zone: Read** and **Workers Routes: Edit** for the `l5z12.dev` zone |

   Enable the account's `workers.dev` subdomain in the Cloudflare dashboard if not already configured; it remains available alongside the custom domain. Do not paste credentials into code, issues, or workflow files.

4. Push this project to a GitHub repository's `main` branch (or run **Deploy** manually from that branch). Deployment validates the project, creates `geoip-databases` if missing, downloads and publishes all three databases, and deploys the `geoip` Worker at **https://geoip.l5z12.dev**. Wrangler also prints its `workers.dev` URL.

The Worker/bucket names and custom domain live in `wrangler.jsonc`. Deployment registers `geoip.l5z12.dev` as a Workers Custom Domain; Cloudflare manages its DNS record and TLS certificate. Do not create a CNAME pointing at `workers.dev`. If this hostname already has a conflicting DNS record or Worker binding, resolve that conflict before deployment. Allow time for DNS and certificate provisioning after the first deployment.

The bucket is dedicated to this application and should remain private: **do not enable an R2 public URL**.

### Automation

- **CI**: every push and pull request; frozen pnpm install, formatting check, typecheck, unit tests, bundle, and real `workerd` smoke test. No credentials or MaxMind downloads required.
- **Deploy**: pushes to `main` and manual dispatch; validates, provisions, publishes databases, then deploys.
- **Update databases**: daily at **04:23 UTC**, or manual dispatch; downloads directly from MaxMind and updates R2 without redeploying the Worker. Daily checks do not imply MaxMind publishes a new release daily.
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

Open `http://localhost:8787`. `db:local` downloads real MaxMind data, validates it, and publishes to Wrangler's **local** R2 emulator. Cloudflare credentials are not needed for this mode. Without databases the page still loads and the API returns a clear `503`. Caller-IP lookup may not be available locally; enter a public IP explicitly.

```sh
pnpm run check          # strict TypeScript
pnpm run format         # format source, configuration, and documentation
pnpm run format:check   # check formatting without changing files
pnpm run hooks:check    # run prek hooks against all tracked files
pnpm test               # deterministic unit tests; synthetic MMDB fixtures
pnpm run test:runtime   # bundle + real workerd/R2 lookup smoke test
pnpm run bench:lookup   # synthetic storage-latency benchmark (no network or credentials)
pnpm run db:download    # MaxMind -> .data/, validate all three databases
pnpm run db:publish     # .data/ -> remote R2 (Cloudflare credentials required)
pnpm run infra:ensure   # create/verify remote bucket
pnpm run deploy         # deploy code/assets only; publish databases first
```

Use **Node.js 24** (at least 24.10.0) and **pnpm 10.34.7**. The pnpm version is pinned in `package.json`; workflows use `.node-version` and `pnpm-lock.yaml`. Tests use Vitest; TypeScript scripts run on Node.js with tsx. Database scripts load `.env` when present, with existing environment variables taking precedence. `.env`, `.data`, local R2 state, database archives, and MMDBs are ignored by Git. No database artifacts are uploaded to GitHub. Local `.data/licenses/` retains notices provided by MaxMind archives.

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

Valid public addresses with no match return `200` with nullable fields. Invalid, private, reserved, documentation, and transition addresses return `400`; unavailable or expired databases return `503` with `Retry-After: 30`. Errors use `{ "error": { "code": "…", "message": "…" } }`. `/api/status` returns `status: "ok"` or `"degraded"` with the same database metadata, or `503` if no usable pair exists.

Only literal addresses are accepted, not hostnames, CIDR input, ports, zone IDs, or ambiguous/octal IPv4 notation. `GET`, `HEAD`, and `OPTIONS` are supported. Explicit-IP lookups and status allow public CORS; the caller-IP endpoint is same-origin to avoid exposing visitors' IPs to arbitrary websites. Responses use `Cache-Control: no-store`. Visitor addresses come only from Cloudflare's connecting-IP headers (including Pseudo IPv4's IPv6 header), never `X-Forwarded-For`.

## Storage, updates, and operations

MMDBs are **not bundled with the Worker or loaded whole into memory**. A paged MMDB reader traverses the original search trees and decodes complete records using private R2 range reads. A shared **32 MiB LRU cache** holds 256 KiB pages across all datasets and versions, with at most eight page downloads in flight. Each page is checked against its SHA-256 digest in the manifest. This supports the much larger City database within Workers' 128 MiB memory limit. Startup opens all three databases concurrently, and reads spanning page boundaries fetch their pages concurrently under the same download limit. Metadata is decoded from its already-fetched tail, and single-page reads use views of cached bytes without allocating a copy for each field.

The active manifest is checked at most every five minutes per isolate; concurrent loads are coalesced. Once a validated, unexpired snapshot is available, requests serve it immediately while the check runs through [`ctx.waitUntil()`](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil). New generations become active only after all three readers pass validation. Cold requests and requests whose snapshot has expired wait for validation; expired data is never served. `database.stale` reflects the last completed refresh. Cold lookups can still require multiple dependent R2 range reads; warm paths reuse cached pages. Use the Workers paid plan for CPU/subrequest headroom and benchmark latency/cost for your traffic.

`pnpm run bench:lookup` measures cold initialization, warm IPv4/IPv6 lookups, and a lookup during a scheduled refresh using synthetic multi-page MMDBs and a fixed 100 ms delay per storage read. It needs no credentials or licensed data. Its timings compare code paths under controlled latency; they are not production latency predictions.

Each update validates tar/gzip size bounds, archive structure, MMDB type, dual-stack sample records, and build freshness. Country/City probes allow missing geolocation (including for anycast IPs) and validate field types and coordinate ranges when present; missing geography is not database corruption. It calculates whole-file and per-page SHA-256 hashes, uploads a content-addressed generation under `versions/<sha256>/`, followed by an immutable version manifest, and **writes `manifest.json` last**. A failed pre-publication update leaves the old active pointer untouched. Worker refresh failures preserve the previous working generation and set `database.stale`; retries are throttled to 30 seconds. Data more than 30 days old is not served. Combined stored MMDB size is capped at 512 MiB; this is a storage/download safety bound, not a Worker memory allocation. Corrupt or unavailable pages return a retryable `503`.

All MMDB value types and 24-, 28-, and 32-bit search trees are supported. The reader enforces offset, nesting, container, and decode-operation bounds. Full feature support means exposing everything these databases actually contain, not inferring absent information. IP geolocation and coordinates are approximate (consider `location.accuracy_radius`), cannot identify an individual, and are not suitable for street-level location or emergency services.

No application IP logging, analytics, or third-party browser requests are implemented; Workers observability is disabled by default. Cloudflare or infrastructure you enable may still retain request metadata. The API is public and unauthenticated: add Cloudflare rate limiting/WAF rules as appropriate before exposing it to significant traffic. Monitor `/api/status`, GitHub jobs, R2 usage, and cron failures. Delete retained/local databases when required by your MaxMind agreement, including if access is terminated; automatic cleanup is not a substitute for reviewing license obligations.

### Rollback

Redeploy an earlier Worker commit for code rollback. For data rollback, while the desired validated generation remains in R2 and all builds are under 30 days old:

```sh
pnpm exec wrangler r2 object get geoip-databases/versions/VERSION/manifest.json --file .data/rollback.json --remote
# Inspect the manifest; confirm all three referenced MMDB objects still exist.
pnpm exec wrangler r2 object put geoip-databases/manifest.json --file .data/rollback.json --remote
```

Coordinate manual rollback with update jobs and the cleanup cron. Active isolates observe the pointer within five minutes. Do not commit rollback manifests containing licensed data; local artifacts remain ignored.

## Code license

Unless otherwise noted, the original project code—including the Worker, frontend, automation scripts, and tests—is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`). See [LICENSE](LICENSE) for the full terms.

MaxMind databases are **not** covered by this code license; they retain their own licensing terms. Third-party dependencies and any third-party notices retain their respective licenses.

When deploying a modified version for network use, provide users a prominent link to the corresponding source for the deployed version, including build and deployment scripts, as required by AGPL section 13. Do not include credentials or private database files in that source offer.

## Attribution

This product includes GeoLite2 data created by [MaxMind](https://www.maxmind.com/). Review the [GeoLite2 EULA](https://www.maxmind.com/en/geolite2/eula), [download instructions](https://dev.maxmind.com/geoip/updating-databases/), and notices distributed with your databases. MaxMind credentials are used only by download scripts, not deployed as Worker secrets or sent to visitors.
