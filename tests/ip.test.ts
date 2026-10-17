import { expect, test } from "vitest";
import { networkCidr, parseIp } from "../src/ip";

test("normalizes strict IPv4, IPv6 and mapped IPv4", () => {
  expect(parseIp(" 1.1.1.1 ")).toEqual({ ip: "1.1.1.1", version: 4 });
  expect(parseIp("2606:4700:4700:0000:0:0:0:1111")).toEqual({
    ip: "2606:4700:4700::1111",
    version: 6,
  });
  expect(parseIp("::ffff:8.8.8.8")).toEqual({ ip: "8.8.8.8", version: 4 });
  expect(parseIp("::FFFF:808:808")).toEqual({ ip: "8.8.8.8", version: 4 });
});

test("rejects ambiguous or malformed addresses", () => {
  for (const ip of [
    "",
    "google.com",
    "1.1.1.1:443",
    "1.1.1.1/24",
    "[::1]",
    "fe80::1%eth0",
    "1.1.1",
    "01.1.1.1",
    "0x08080808",
    "134744072",
    "256.1.1.1",
    "1:::2",
    "::ffff:008.8.8.8",
    "1.1.1.1,8.8.8.8",
    "<script>",
  ]) {
    expect(() => parseIp(ip)).toThrow();
  }
});

test("rejects non-public and documentation/transition ranges including mapped private IPv4", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "240.0.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "198.18.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "3fff::1",
    "::ffff:192.168.0.1",
    "64:ff9b::808:808",
    "2002:808:808::1",
    "4000::1",
  ]) {
    expect(() => parseIp(ip)).toThrow("Only public");
  }
});

test("computes network boundaries for both families", () => {
  expect(networkCidr("8.8.8.8", 24)).toBe("8.8.8.0/24");
  expect(networkCidr("8.8.8.8", 0)).toBe("0.0.0.0/0");
  expect(networkCidr("8.8.8.8", 32)).toBe("8.8.8.8/32");
  expect(networkCidr("2606:4700:4700::1111", 48)).toBe("2606:4700:4700::/48");
  expect(networkCidr("2606:4700:4700::1111", 128)).toBe("2606:4700:4700::1111/128");
  expect(() => networkCidr("8.8.8.8", 33)).toThrow();
});
