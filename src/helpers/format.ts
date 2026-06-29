import { npubEncode } from "applesauce-core/helpers/pointers";

/** Shorten a long hex/string id to `head…tail` for compact display. */
export function short(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Shorten a hex string id (alias of {@link short}). */
export function hexShort(value: string): string {
  return short(value);
}

/** Encode a pubkey as an npub and shorten it for display. */
export function npubShort(pubkey: string): string {
  try {
    return short(npubEncode(pubkey), 10, 6);
  } catch {
    return short(pubkey);
  }
}

/**
 * Derive a stable display color from a pubkey: `#` + its first 6 hex chars.
 * Pubkeys are 64-char lowercase hex, so this is always a valid CSS hex color.
 */
export function colorForPubkey(pubkey: string): string {
  return `#${pubkey.slice(0, 6)}`;
}

/** Format a unix-seconds timestamp as a local date-time string. */
export function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

/**
 * Format a signed duration in seconds as a compact `1h 2m`, `3.4s`, `0s`, … A
 * negative value keeps its sign (e.g. `-2m` when a received event predates its
 * own `created_at`, i.e. the sender's clock ran ahead).
 */
export function formatDuration(seconds: number): string {
  const sign = seconds < 0 ? "-" : "";
  const abs = Math.abs(seconds);
  if (abs < 60) return `${sign}${abs}s`;
  const parts: string[] = [];
  const units: [label: string, size: number][] = [
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ];
  let rest = abs;
  for (const [label, size] of units) {
    const value = Math.floor(rest / size);
    if (value > 0) parts.push(`${value}${label}`);
    rest %= size;
    if (parts.length === 2) break; // two units is plenty of precision
  }
  return sign + parts.join(" ");
}
