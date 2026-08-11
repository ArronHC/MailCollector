import dns from "node:dns";
import net, { type LookupFunction } from "node:net";
import { providers } from "./providers.js";

const blockedAddresses = new net.BlockList();
const knownProviderHosts = new Set(providers.filter((provider) => provider.host).map((provider) => provider.host.toLowerCase()));

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}

blockedAddresses.addAddress("::", "ipv6");
blockedAddresses.addAddress("::1", "ipv6");
for (const [network, prefix] of [
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

export function isPublicIpAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blockedAddresses.check(address, "ipv4");
  if (family === 6) return !address.toLowerCase().startsWith("::ffff:") && !blockedAddresses.check(address, "ipv6");
  return false;
}

export function isKnownProviderMailHost(hostname: string): boolean {
  return knownProviderHosts.has(hostname.trim().toLowerCase());
}

function assertAllowed(hostname: string, addresses: dns.LookupAddress[], allowPrivate: boolean, allowKnownProviderProxyDns: boolean): void {
  if (!addresses.length) throw new Error("IMAP 主机没有可用地址");
  const trustedProxyResolution = allowKnownProviderProxyDns && isKnownProviderMailHost(hostname);
  if (!allowPrivate && !trustedProxyResolution && addresses.some((item) => !isPublicIpAddress(item.address))) {
    throw new Error("不允许连接到本机、私网或保留地址");
  }
}

export async function assertAllowedMailHost(hostname: string, allowPrivate: boolean, allowKnownProviderProxyDns = false): Promise<void> {
  const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  assertAllowed(hostname, addresses, allowPrivate, allowKnownProviderProxyDns);
}

export function createMailHostLookup(allowPrivate: boolean, allowKnownProviderProxyDns = false): LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error, "", 0);
      try {
        assertAllowed(hostname, addresses, allowPrivate, allowKnownProviderProxyDns);
      } catch (lookupError) {
        return callback(lookupError as NodeJS.ErrnoException, "", 0);
      }

      if (options.all) return callback(null, addresses);
      const selected = addresses[0]!;
      callback(null, selected.address, selected.family);
    });
  };
}
