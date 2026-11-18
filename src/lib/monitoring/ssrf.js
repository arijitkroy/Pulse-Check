import dns from "node:dns/promises";
import net from "node:net";
import { Agent } from "undici";

export function isBlockedAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && ["0", "2"].includes(address.split(".")[2])) ||
      (a === 198 && b === 51 && address.split(".")[2] === "100") ||
      (a === 203 && b === 0 && address.split(".")[2] === "113") ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }

  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    return (
      value === "::" ||
      value === "::1" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      /^fe[89ab]/.test(value) ||
      value.startsWith("::ffff:") ||
      value.startsWith("2001:db8:") ||
      value.startsWith("2001:0:") ||
      value.startsWith("2002:") ||
      !/^[23][0-9a-f]{3}:/.test(value)
    );
  }

  return true;
}

async function resolvePublicAddresses(hostname, signal) {
  const lookup = net.isIP(hostname)
    ? Promise.resolve([{ address: hostname, family: net.isIP(hostname) }])
    : dns.lookup(hostname, { all: true, verbatim: true });
  const addresses = signal ? await abortable(lookup, signal) : await lookup;

  if (
    !addresses.length ||
    addresses.some(({ address }) => isBlockedAddress(address))
  ) {
    throw new Error("URL resolves to a non-public address");
  }
  return addresses;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted)
      return reject(new DOMException("Aborted", "AbortError"));
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export async function assertPublicUrl(raw, signal) {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Only public HTTP(S) URLs are allowed");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal"
  ) {
    throw new Error("Private host is not allowed");
  }
  await resolvePublicAddresses(hostname, signal);
  return url;
}

// Validate the actual socket lookup too, closing the gap between preflight DNS
// validation and the lookup performed when the HTTP connection is established.
export function createSafeDispatcher() {
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        resolvePublicAddresses(hostname)
          .then((records) => {
            const eligible = options.family
              ? records.filter((record) => record.family === options.family)
              : records;
            if (!eligible.length)
              throw new Error("No public address for requested IP family");
            if (options.all) callback(null, eligible);
            else callback(null, eligible[0].address, eligible[0].family);
          })
          .catch(callback);
      },
    },
  });
}
