# Database operations

Requires Bun 1.3.14. Run commands from the repository root.

- `bun run infra:ensure`: confirm/create the configured `GEOIP_DB` R2 bucket.
- `bun run db:update`: download official GeoLite2 Country, City and ASN archives, validate, then publish to remote R2.
- `bun run db:local`: download and publish into Wrangler's local R2 storage.

Download requires `MAXMIND_ACCOUNT_ID` and `MAXMIND_LICENSE_KEY` with GeoLite2 download entitlement. Remote operations require `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; no S3 credentials are used. Put all four in GitHub's protected `production` environment. CI never downloads databases or receives secrets. Do not commit `.data`, credentials, or database archives.

The downloader uses official MaxMind HTTPS endpoints with Basic authentication; native fetch removes Authorization on cross-origin redirects. Each of three attempts has a 120-second timeout. Each compressed archive is capped at 256 MiB and its decompressed tar at 384 MiB. Only regular entries/directories are accepted; archive paths are never extracted to disk. The combined validated MMDB files may not exceed 512 MiB of stored data. This is not a Worker RAM budget: the Worker reads checksum-verified 256 KiB pages through R2 range requests with a 32 MiB page cache. The offline scripts process full buffers. Metadata must identify the appropriate dual-stack GeoLite2 edition, be at most 30 days old, and not more than two days ahead. Multiple public IPv4/IPv6 records must match the expected schema without assuming geographic locations or ASN identities. City requires a country ISO code and finite, in-range latitude/longitude; city names are optional (including for anycast addresses).

Schema version 2 manifests contain whole-file SHA-256 and `pageSha256` for every 256 KiB page, including the short final page, and are capped at 256 KiB. Version = SHA-256 of the concatenated lowercase country, city and ASN MMDB SHA-256 hex digests, in that fixed order. `updatedAt` is the newest MMDB build time, never fetch time. Publishing rechecks page and whole-file hashes, schema, metadata, freshness, version, and timestamps. It uploads versioned databases, then their immutable manifest, then the active `manifest.json` last. Failed earlier uploads cannot advance the pointer. Do not run overlapping local publishers; production workflows share a non-cancelling concurrency group.

Original LICENSE/COPYRIGHT entries, when present, are retained under `.data/licenses/GeoLite2-{Country,City,ASN}/`. They are not uploaded as public assets. Read and comply with the [GeoLite2 EULA](https://www.maxmind.com/en/geolite2/eula) and [MaxMind GeoLite documentation](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data/) before downloading, distributing, or serving results. The download account's current agreement controls your use; local notices are not a substitute. Do not redistribute raw databases publicly.

Deployment on main ensures infrastructure, updates databases, then deploys the Worker. The daily 04:23 UTC workflow updates databases without redeploying; scheduled execution is disabled on fork repositories. The Worker's daily cron prunes superseded generations older than 29 days. Tests use synthetic archives and mocked HTTP; live authenticated downloads require operator credentials and are not part of CI.
