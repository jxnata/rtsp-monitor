/** Expand IPv4 CIDR or single IP into host addresses. */

function ipToInt(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  let n = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`Invalid IPv4 address: ${ip}`);
    }
    n = ((n << 8) + octet) >>> 0;
  }
  return n;
}

function intToIp(n: number): string {
  return [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ].join(".");
}

function parseCidr(cidr: string): { network: number; prefix: number } {
  const trimmed = cidr.trim();
  if (!trimmed.includes("/")) {
    const ip = ipToInt(trimmed);
    return { network: ip, prefix: 32 };
  }

  const [addr, prefixStr] = trimmed.split("/");
  if (!addr || prefixStr === undefined) {
    throw new Error(`Invalid CIDR: ${cidr}`);
  }
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid CIDR prefix: ${cidr}`);
  }

  const ip = ipToInt(addr);
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  return { network: (ip & mask) >>> 0, prefix };
}

function hostBounds(network: number, prefix: number): { start: number; end: number } {
  const hostBits = 32 - prefix;
  const size = 2 ** hostBits;
  if (prefix >= 31) {
    return { start: network, end: (network + size - 1) >>> 0 };
  }
  return { start: (network + 1) >>> 0, end: (network + size - 2) >>> 0 };
}

/**
 * Expand a CIDR (or bare IP) to host IPs.
 * For /31 and /32 returns all addresses in the block.
 * For larger networks excludes network and broadcast addresses.
 */
export function expandCidr(cidr: string): string[] {
  return [...iterateCidr(cidr)];
}

/** Iterate host IPs in a CIDR without allocating the full list. */
export function* iterateCidr(cidr: string): Generator<string> {
  const { network, prefix } = parseCidr(cidr);
  const { start, end } = hostBounds(network, prefix);
  for (let n = start; n <= end; n = (n + 1) >>> 0) {
    yield intToIp(n);
    if (n === 0xffffffff) break;
  }
}

/** Count host IPs in a single CIDR. */
export function countCidr(cidr: string): number {
  const { network, prefix } = parseCidr(cidr);
  const { start, end } = hostBounds(network, prefix);
  if (end < start) return 0;
  return end - start + 1;
}

/** Count hosts across ranges (sum; overlaps are rare and not worth a giant Set). */
export function countRanges(ranges: string[]): number {
  let total = 0;
  for (const range of ranges) {
    total += countCidr(range);
  }
  return total;
}

/**
 * Iterate multiple ranges without allocating the full IP list.
 * `skip` jumps ahead efficiently (for resume) without walking each IP.
 */
export function* iterateRanges(ranges: string[], skip = 0): Generator<string> {
  let remaining = Math.max(0, skip);
  for (const range of ranges) {
    const { network, prefix } = parseCidr(range);
    const { start, end } = hostBounds(network, prefix);
    const count = end < start ? 0 : end - start + 1;
    if (remaining >= count) {
      remaining -= count;
      continue;
    }
    let n = (start + remaining) >>> 0;
    remaining = 0;
    for (; n <= end; n = (n + 1) >>> 0) {
      yield intToIp(n);
      if (n === 0xffffffff) break;
    }
  }
}

/** Expand multiple ranges into a list (only for small ranges). */
export function expandRanges(ranges: string[]): string[] {
  return [...iterateRanges(ranges)];
}

export function isValidIpv4(ip: string): boolean {
  try {
    ipToInt(ip);
    return true;
  } catch {
    return false;
  }
}
