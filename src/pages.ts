import { Buffer } from "node:buffer";
import { PAGE_BYTES, type DatabaseFile } from "./manifest";
import type { ByteSource } from "./mmdb";

const CACHE_BYTES = 32 * 1024 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 8;

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
      const object = await this.bucket.get(file.key, { range: { offset, length } });
      if (!object) throw new PageUnavailable();
      // R2Object.size is the full object's size, even for a ranged response.
      if (object.size !== file.bytes) {
        await object.body.cancel();
        throw new PageUnavailable();
      }
      const data = await object.arrayBuffer();
      if (data.byteLength !== length) throw new PageUnavailable();
      const hash = Buffer.from(await crypto.subtle.digest("SHA-256", data)).toString("hex");
      if (hash !== file.pageSha256[index]) throw new PageUnavailable();
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
    } catch {
      throw new PageUnavailable();
    } finally {
      this.release();
    }
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
