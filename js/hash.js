export function normalizeAddress(addr) {
  return (addr || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export function normalizeName(name) {
  return (name || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

// cyrb53 — fast, deterministic, non-cryptographic string hash.
// Good enough for a stable per-record id at this dataset size (~1,600 voters);
// it is not a security control.
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function voterId(normalizedAddress, normalizedName) {
  return cyrb53(`${normalizedAddress}|${normalizedName}`).toString(36);
}
