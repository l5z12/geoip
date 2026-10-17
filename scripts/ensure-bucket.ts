import { bucketName, credentials, runMain, SafeError } from "./shared";

export async function ensureBucket(
  account: string,
  token: string,
  bucket: string,
  request: typeof fetch = fetch,
): Promise<void> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/r2/buckets`;
  const call = async (url: string, method = "GET") => {
    try {
      return await request(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ name: bucket }) } : {}),
      });
    } catch {
      throw new SafeError("Cloudflare bucket API request failed");
    }
  };
  const exists = async (response: Response) => {
    if (!response.ok) return false;
    try {
      const body = (await response.json()) as { success?: boolean; result?: { name?: string } };
      return body.success === true && body.result?.name === bucket;
    } catch {
      return false;
    }
  };
  const url = `${base}/${encodeURIComponent(bucket)}`;
  const initial = await call(url);
  if (await exists(initial)) return;
  if (initial.status !== 404)
    throw new SafeError(
      `Cloudflare bucket lookup failed (HTTP ${initial.status}); refusing to create`,
    );
  const created = await call(base, "POST");
  if (!created.ok && created.status !== 409)
    throw new SafeError(`Cloudflare bucket creation failed (HTTP ${created.status})`);
  // Confirm even a successful creation and never blindly swallow a conflict.
  if (!(await exists(await call(url))))
    throw new SafeError("Cloudflare bucket creation could not be confirmed");
}
export async function main(): Promise<void> {
  const bucket = await bucketName();
  const [token, account] = credentials(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
  await ensureBucket(account!, token!, bucket);
  console.log(`R2 bucket ready: ${bucket}`);
}
if (import.meta.main) await runMain(main);
