import type { MmdbMetadata } from "../src/mmdb";

export interface MmdbRange {
  family: 4 | 6;
  start: string;
  end: string;
  prefix: number;
  pointer: number;
}

/** Enumerate disjoint leaf intervals, retaining original prefix lengths. */
export function* mmdbRanges(bytes: Uint8Array, metadata: MmdbMetadata): Generator<MmdbRange> {
  const { nodeCount, recordSize, ipVersion } = metadata;
  function uint(offset: number, length: number) {
    let result = 0;
    for (const byte of bytes.subarray(offset, offset + length)) result = result * 256 + byte;
    return result;
  }
  function branch(node: number, right: number) {
    const offset = (node * recordSize) / 4;
    if (recordSize === 28)
      return right
        ? (bytes[offset + 3]! & 15) * 0x1000000 + uint(offset + 4, 3)
        : (bytes[offset + 3]! >>> 4) * 0x1000000 + uint(offset, 3);
    return uint(offset + (right * recordSize) / 8, recordSize / 8);
  }
  let operations = 0;
  function* walk(
    node: number,
    family: 4 | 6,
    start: bigint,
    depth: number,
    prefix = depth,
  ): Generator<MmdbRange> {
    if (++operations > 50_000_000) throw new Error("MMDB traversal exceeds safety budget");
    if (node === nodeCount) return;
    const bits = family === 4 ? 32 : 128;
    if (node > nodeCount) {
      yield {
        family,
        start: start.toString(16).padStart(bits / 4, "0"),
        end: (start + (1n << BigInt(bits - depth)) - 1n).toString(16).padStart(bits / 4, "0"),
        prefix,
        pointer: node,
      };
      return;
    }
    if (depth >= bits) throw new Error("MMDB search path exceeds address width");
    yield* walk(branch(node, 0), family, start, depth + 1);
    yield* walk(branch(node, 1), family, start + (1n << BigInt(bits - depth - 1)), depth + 1);
  }
  let v4 = 0;
  if (ipVersion === 6) for (let bit = 0; bit < 96 && v4 < nodeCount; bit++) v4 = branch(v4, 0);
  yield* walk(v4, 4, 0n, 0);
  if (ipVersion === 6) {
    // parseIp accepts IPv6 only in 2000::/3. Exclude IPv4 aliases and other
    // rejected spaces instead of duplicating their entire trees into D1.
    let v6 = 0,
      prefix = 0;
    for (const bit of [0, 0, 1]) {
      if (v6 >= nodeCount) break;
      v6 = branch(v6, bit);
      prefix++;
    }
    yield* walk(v6, 6, 1n << 125n, 3, prefix);
  }
}
