import { Buffer } from "node:buffer";
import ipaddr from "ipaddr.js";

export interface ByteSource {
  readonly size: number;
  /** Returned bytes may be a view of shared cached data; callers must not mutate them. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface MmdbMetadata {
  databaseType: string;
  buildEpoch: string;
  ipVersion: 4 | 6;
  nodeCount: number;
  recordSize: 24 | 28 | 32;
  searchTreeSize: number;
}

const MARKER = Buffer.from("abcdef4d61784d696e642e636f6d", "hex");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const fail = (message: string): never => {
  throw new Error(`Invalid MMDB: ${message}`);
};
const uint = (bytes: Uint8Array): number => {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
};
class RawBytes {
  readonly $type = "bytes";
  readonly base64: string;
  constructor(bytes: Uint8Array) {
    this.base64 = Buffer.from(bytes).toString("base64");
  }
}
class RawMap {
  constructor(readonly entries: [unknown, unknown][]) {}
}
// Pointer failures are observed immediately, even while the inline record is
// still being scanned. The public decode operation drains all started reads.
class PendingValue {
  readonly result: Promise<PromiseSettledResult<unknown>>;
  constructor(promise: Promise<unknown>) {
    this.result = promise.then(
      (value) => ({ status: "fulfilled", value }),
      (reason: unknown) => ({ status: "rejected", reason }),
    );
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  !(value instanceof RawBytes);

async function read(
  source: ByteSource,
  offset: number,
  length: number,
  start = 0,
  end = source.size,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    offset < start ||
    offset > end - length
  )
    fail("offset or length out of bounds");
  const bytes = await source.read(offset, length);
  if (bytes.length !== length) fail("short source read");
  return bytes;
}

/** One decoder per record: neither pointer caches nor decoded records grow with database size. */
class Decoder {
  private operations = 0;
  private payloadBytes = 0;
  private readonly pending = new Set<Promise<PromiseSettledResult<unknown>>>();
  constructor(
    private source: ByteSource,
    private base: number,
    private end: number,
  ) {}
  private read(offset: number, size: number) {
    return read(this.source, offset, size, this.base, this.end);
  }
  async decode(position: number): Promise<[unknown, number]> {
    try {
      const [value, next] = await this.scan(position, []);
      return [await this.resolve(value), next];
    } finally {
      // A failed field must not leave its siblings doing I/O after the request.
      // A pending pointer can discover more pointers before it settles.
      while (this.pending.size) await Promise.all(this.pending);
    }
  }

  private async resolve(value: unknown): Promise<unknown> {
    if (value instanceof PendingValue) {
      const result = await value.result;
      if (result.status === "rejected") throw result.reason;
      return this.resolve(result.value);
    }
    if (value instanceof RawMap) {
      const entries = await Promise.all(
        value.entries.map(async ([key, child]) => [
          await this.resolve(key),
          await this.resolve(child),
        ]),
      );
      const result: Record<string, unknown> = {};
      for (const [key, child] of entries) {
        if (typeof key !== "string") fail("map key is not a string");
        Object.defineProperty(result, key as string, {
          value: child,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    }
    if (Array.isArray(value)) return Promise.all(value.map((child) => this.resolve(child)));
    return value;
  }

  private async scan(position: number, ancestors: readonly number[]): Promise<[unknown, number]> {
    if (ancestors.length >= 64 || ++this.operations > 100_000)
      fail("decoding complexity limit exceeded");
    // Track each branch separately: sibling pointers may legitimately share a target.
    if (ancestors.includes(position)) fail("pointer cycle");
    const path = [...ancestors, position];
    let offset = position;
    const control = uint(await this.read(offset++, 1));
    let type = control >>> 5;
    if (type === 1) {
      const width = ((control >>> 3) & 3) + 1;
      const packed = uint(await this.read(offset, width));
      const target =
        this.base +
        packed +
        (width === 4 ? 0 : (control & 7) * 256 ** width) +
        [0, 0, 2048, 526336, 0][width]!;
      // Bound speculative branches as well as the page cache's I/O limit.
      if (this.pending.size >= 32) {
        const [value] = await this.scan(target, path);
        return [value, offset + width];
      }
      // The next inline field follows the pointer bytes, not its target.
      // Start the target now and continue scanning independent siblings.
      const value = new PendingValue(this.scan(target, path).then(([value]) => value));
      this.pending.add(value.result);
      void value.result.then(() => this.pending.delete(value.result));
      return [value, offset + width];
    }
    if (type === 0) {
      type = uint(await this.read(offset++, 1)) + 7;
      if (type < 8) fail("invalid extended type");
    }
    if (![2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15].includes(type)) fail(`unsupported type ${type}`);
    let size = control & 31;
    if (size >= 29) {
      const width = size - 28;
      size = [29, 285, 65821][width - 1]! + uint(await this.read(offset, width));
      offset += width;
    }
    if (type === 7 || type === 11) {
      if (size > 10_000) fail("container length limit exceeded");
      if (type === 11) {
        const values: unknown[] = [];
        for (let i = 0; i < size; i++) {
          const decoded = await this.scan(offset, path);
          values.push(decoded[0]);
          offset = decoded[1];
        }
        return [values, offset];
      }
      const values: [unknown, unknown][] = [];
      for (let i = 0; i < size; i++) {
        const [key, next] = await this.scan(offset, path);
        const decoded = await this.scan(next, path);
        values.push([key, decoded[0]]);
        offset = decoded[1];
      }
      return [new RawMap(values), offset];
    }
    if (type === 14) {
      if (size > 1) fail("invalid boolean size");
      return [size === 1, offset];
    }
    const maxSize: Record<number, number> = { 5: 2, 6: 4, 8: 4, 9: 8, 10: 16 };
    if (
      (type === 3 && size !== 8) ||
      (type === 15 && size !== 4) ||
      (maxSize[type] !== undefined && size > maxSize[type]!)
    )
      fail("invalid numeric size");
    if (size > 1024 * 1024) fail("payload length limit exceeded");
    this.payloadBytes += size;
    if (this.payloadBytes > 16 * 1024 * 1024) fail("record payload budget exceeded");
    const bytes = await this.read(offset, size);
    let value: unknown;
    switch (type) {
      case 2:
        value = utf8.decode(bytes);
        break;
      case 4:
        value = new RawBytes(bytes);
        break;
      case 3:
      case 15: {
        const buffer = Buffer.from(bytes);
        value = type === 3 ? buffer.readDoubleBE(0) : buffer.readFloatBE(0);
        if (!Number.isFinite(value)) fail("non-finite float");
        break;
      }
      case 9:
      case 10: {
        let integer = 0n;
        for (const byte of bytes) integer = integer * 256n + BigInt(byte);
        value = integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString();
        break;
      }
      default: {
        const integer = uint(bytes);
        value = type === 8 && size === 4 && integer >= 0x80000000 ? integer - 0x100000000 : integer;
      }
    }
    return [value, offset + size];
  }
}

export class AsyncMmdb {
  private ipv4Start?: Promise<number>;
  private constructor(
    private source: ByteSource,
    readonly metadata: Readonly<MmdbMetadata>,
    private dataEnd: number,
  ) {}

  static async open(source: ByteSource): Promise<AsyncMmdb> {
    if (!Number.isSafeInteger(source.size) || source.size < MARKER.length)
      fail("invalid database size");
    const tailStart = Math.max(0, source.size - 128 * 1024);
    const tail = Buffer.from(await read(source, tailStart, source.size - tailStart));
    const marker = tail.lastIndexOf(MARKER);
    if (marker < 0) fail("metadata marker missing");
    const dataEnd = tailStart + marker;
    const metadataStart = dataEnd + MARKER.length;
    // The complete metadata is already in the tail. Decode it locally so tiny
    // field reads cannot re-fetch pages evicted by other concurrent lookups.
    const metadataSource: ByteSource = {
      size: source.size,
      read: async (offset, length) =>
        tail.subarray(offset - tailStart, offset - tailStart + length),
    };
    const [raw] = await new Decoder(metadataSource, metadataStart, source.size).decode(
      metadataStart,
    );
    if (!object(raw)) fail("metadata is not a map");
    const m = raw as Record<string, unknown>;
    const nodeCount = m.node_count;
    const recordSize = m.record_size;
    const ipVersion = m.ip_version;
    if (typeof nodeCount !== "number" || !Number.isSafeInteger(nodeCount) || nodeCount < 0)
      fail("invalid node count");
    if (recordSize !== 24 && recordSize !== 28 && recordSize !== 32) fail("invalid record size");
    if (ipVersion !== 4 && ipVersion !== 6) fail("invalid IP version");
    if (typeof m.database_type !== "string" || !m.database_type) fail("invalid database type");
    if (m.binary_format_major_version !== 2) fail("unsupported format version");
    if (
      typeof m.build_epoch !== "number" ||
      !Number.isSafeInteger(m.build_epoch) ||
      m.build_epoch < 0
    )
      fail("invalid build epoch");
    const date = new Date((m.build_epoch as number) * 1000);
    if (!Number.isFinite(date.getTime())) fail("invalid build epoch");
    const searchTreeSize = ((nodeCount as number) * (recordSize as number)) / 4;
    if (!Number.isSafeInteger(searchTreeSize) || searchTreeSize + 16 > dataEnd)
      fail("search tree exceeds database bounds");
    if ((await read(source, searchTreeSize, 16)).some((byte) => byte !== 0))
      fail("invalid data separator");
    const metadata: MmdbMetadata = {
      databaseType: m.database_type as string,
      buildEpoch: date.toISOString(),
      ipVersion: ipVersion as 4 | 6,
      nodeCount: nodeCount as number,
      recordSize: recordSize as 24 | 28 | 32,
      searchTreeSize,
    };
    return new AsyncMmdb(source, Object.freeze(metadata), dataEnd);
  }

  private async branch(node: number, right: number): Promise<number> {
    const { nodeCount, recordSize, searchTreeSize } = this.metadata;
    if (!Number.isInteger(node) || node < 0 || node >= nodeCount) fail("invalid search node");
    const bytes = await read(
      this.source,
      (node * recordSize) / 4,
      recordSize / 4,
      0,
      searchTreeSize,
    );
    if (recordSize === 28)
      return right
        ? (bytes[3]! & 15) * 0x1000000 + uint(bytes.subarray(4, 7))
        : (bytes[3]! >>> 4) * 0x1000000 + uint(bytes.subarray(0, 3));
    const width = recordSize / 8;
    return uint(bytes.subarray(right * width, (right + 1) * width));
  }

  private async findIpv4Start(): Promise<number> {
    let node = 0;
    for (let bit = 0; bit < 96 && node < this.metadata.nodeCount; bit++)
      node = await this.branch(node, 0);
    return node;
  }

  async getWithPrefixLength(ip: string): Promise<[Record<string, unknown> | null, number]> {
    const address = ipaddr.parse(ip);
    const v4 = address.kind() === "ipv4";
    const { nodeCount, ipVersion, searchTreeSize } = this.metadata;
    if (!v4 && ipVersion === 4) return [null, 0];
    if (v4 && ipVersion === 6 && !this.ipv4Start) {
      this.ipv4Start = this.findIpv4Start().catch((error) => {
        // A transient page read failure must not poison this reader forever.
        this.ipv4Start = undefined;
        throw error;
      });
    }
    let node = v4 && ipVersion === 6 ? await this.ipv4Start! : 0;
    const bytes = address.toByteArray();
    let prefix = 0;
    while (node < nodeCount && prefix < bytes.length * 8) {
      node = await this.branch(node, (bytes[prefix >>> 3]! >>> (7 - (prefix & 7))) & 1);
      prefix++;
    }
    if (node === nodeCount) return [null, prefix];
    if (node < nodeCount) fail("search path exceeds address width");
    const offset = searchTreeSize + node - nodeCount;
    const [value] = await new Decoder(this.source, searchTreeSize + 16, this.dataEnd).decode(
      offset,
    );
    if (!object(value)) fail("record root is not a map");
    return [value as Record<string, unknown>, prefix];
  }
}
