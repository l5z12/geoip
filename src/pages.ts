import { Buffer } from "node:buffer";
import { PAGE_BYTES, type DatabaseFile } from "./manifest";
import type { ByteSource } from "./mmdb";

const CACHE_BYTES = 32 * 1024 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 8;

export interface PageStorage {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

export interface EdgePages {
  origin: string;
  open(): Promise<PageStorage>;
}

export class PageUnavailable extends Error {
  constructor() {
    super("Database page is unavailable or failed integrity validation");
  }
}

/** Bounded LRU shared by all datasets and generations in an isolate. */
export class PageCache {
  private entries = new Map<string, Uint8Array>();
  private pending = new Map<string, Promise<Uint8Array>>();
  private bytes = 0;
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private bucket: R2Bucket,
    private capacity = CACHE_BYTES,
    private edge?: EdgePages,
  ) {}

  private async acquire(): Promise<void> {
    if (this.active < MAX_IN_FLIGHT) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  async page(file: DatabaseFile, index: number): Promise<Uint8Array> {
    const key = `${file.sha256}:${index}`;
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.download(file, index).finally(() => {
        this.pending.delete(key);
      });
      this.pending.set(key, pending);
    }
    return pending;
  }

  private async download(file: DatabaseFile, index: number): Promise<Uint8Array> {
    const offset = index * PAGE_BYTES;
    const length = Math.min(PAGE_BYTES, file.bytes - offset);
    if (!Number.isSafeInteger(index) || index < 0 || length <= 0 || !file.pageSha256[index])
      throw new PageUnavailable();
    await this.acquire();
    try {
      const key = `${this.edge?.origin}/__geoip_pages/${file.sha256}/${PAGE_BYTES}/${index}`;
      // A named Cache API cache keeps verified pages across isolate restarts.
      // It contains database bytes only, never lookup addresses or responses.
      let storage: PageStorage | undefined;
      try {
        storage = await this.edge?.open();
        const response = await storage?.match(key);
        if (response) {
          if (
            response.status === 200 &&
            response.headers.get("Content-Length") === String(length)
          ) {
            const data = await response.arrayBuffer();
            if (await this.valid(data, length, file.pageSha256[index]!))
              return this.remember(file, index, data);
          } else {
            await response.body?.cancel();
          }
        }
      } catch {
        // An unavailable, evicted, or corrupt edge entry is only a cache miss.
      }
      const object = await this.bucket.get(file.key, { range: { offset, length } });
      if (!object) throw new PageUnavailable();
      // R2Object.size is the full object's size, even for a ranged response.
      if (object.size !== file.bytes) {
        await object.body.cancel();
        throw new PageUnavailable();
      }
      const data = await object.arrayBuffer();
      if (!(await this.valid(data, length, file.pageSha256[index]!))) throw new PageUnavailable();
      if (storage) {
        try {
          // Await the small cache write so no request context or unfinished I/O
          // is retained by the shared reader. Cache failure never fails a lookup.
          await storage.put(
            key,
            new Response(data, {
              headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(length),
                "Cache-Control": "public, max-age=86400, immutable",
              },
            }),
          );
        } catch {
          // R2 remains authoritative when the edge cache is unavailable.
        }
      }
      return this.remember(file, index, data);
    } catch {
      throw new PageUnavailable();
    } finally {
      this.release();
    }
  }

  private async valid(data: ArrayBuffer, length: number, expectedHash: string): Promise<boolean> {
    if (data.byteLength !== length) return false;
    return (
      Buffer.from(await crypto.subtle.digest("SHA-256", data)).toString("hex") === expectedHash
    );
  }

  private remember(file: DatabaseFile, index: number, data: ArrayBuffer): Uint8Array {
    const bytes = new Uint8Array(data);
    if (bytes.byteLength <= this.capacity) {
      while (this.bytes + bytes.byteLength > this.capacity) {
        const oldest = this.entries.entries().next().value;
        if (!oldest) break;
        this.entries.delete(oldest[0]);
        this.bytes -= oldest[1].byteLength;
      }
      this.entries.set(`${file.sha256}:${index}`, bytes);
      this.bytes += bytes.byteLength;
    }
    return bytes;
  }

  source(file: DatabaseFile): ByteSource {
    return {
      size: file.bytes,
      read: async (offset, length) => {
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(length) ||
          offset < 0 ||
          length < 0 ||
          length > MAX_READ_BYTES ||
          offset + length > file.bytes
        ) {
          throw new Error("Database read is outside allowed bounds");
        }
        if (length === 0) return new Uint8Array();
        const first = Math.floor(offset / PAGE_BYTES);
        const last = Math.floor((offset + length - 1) / PAGE_BYTES);
        if (first === last) {
          const page = await this.page(file, first);
          return page.subarray(offset % PAGE_BYTES, (offset % PAGE_BYTES) + length);
        }
        // Metadata and straddling values need multiple known pages. Fetch them
        // together under the shared download limit instead of serial round trips.
        const pages = await Promise.allSettled(
          Array.from({ length: last - first + 1 }, (_, index) => this.page(file, first + index)),
        );
        const output = new Uint8Array(length);
        for (const [index, result] of pages.entries()) {
          if (result.status === "rejected") throw result.reason;
          const position = (first + index) * PAGE_BYTES;
          const start = Math.max(offset - position, 0);
          const end = Math.min(offset + length - position, result.value.length);
          output.set(result.value.subarray(start, end), Math.max(position - offset, 0));
        }
        return output;
      },
    };
  }

  get cachedBytes(): number {
    return this.bytes;
  }
}
