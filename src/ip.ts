import ipaddr from "ipaddr.js";

export class IpError extends Error {
  constructor(public code: "INVALID_IP" | "NON_PUBLIC_IP", message: string) {
    super(message);
  }
}

export interface ParsedIp {
  ip: string;
  version: 4 | 6;
}

export function parseIp(input: string): ParsedIp {
  const text = input.trim();
  const invalid = () => new IpError("INVALID_IP", "Enter a valid IPv4 or IPv6 address, without a port, CIDR suffix, or zone ID.");
  if (!text || text.length > 45 || !/^[0-9a-fA-F:.]+$/.test(text)) throw invalid();
  if (!text.includes(":")) {
    if (!ipaddr.IPv4.isValidFourPartDecimal(text)) throw invalid();
  } else if (text.includes(".")) {
    if (!ipaddr.IPv4.isValidFourPartDecimal(text.slice(text.lastIndexOf(":") + 1))) throw invalid();
  }
  if (!ipaddr.isValid(text)) throw invalid();
  let address = ipaddr.parse(text);
  if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) {
    address = address.toIPv4Address();
  }
  const version = address.kind() === "ipv4" ? 4 : 6;
  // AS112 and AMT are globally routed despite having named special ranges.
  const publicRanges = ["unicast", "as112", "as112v6", "amt"];
  if (!publicRanges.includes(address.range()) ||
      (address instanceof ipaddr.IPv6 && !address.match(ipaddr.IPv6.parse("2000::"), 3))) {
    throw new IpError("NON_PUBLIC_IP", "Only public, globally routable IP addresses can be looked up.");
  }
  return { ip: address.toString(), version };
}

export function networkCidr(ip: string, prefixLength: number): string {
  const address = ipaddr.parse(ip);
  const bytes = address.toByteArray();
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > bytes.length * 8) {
    throw new Error("Invalid database prefix length");
  }
  const network = bytes.map((byte, index) => {
    const bits = Math.max(0, Math.min(8, prefixLength - index * 8));
    return byte & (0xff << (8 - bits));
  });
  return `${ipaddr.fromByteArray(network).toString()}/${prefixLength}`;
}
