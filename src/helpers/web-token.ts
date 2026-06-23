import { verifyEvent } from "applesauce-core/helpers/event";
import type { NostrEvent } from "applesauce-core/helpers/event";

/**
 * Nostr Web Token (NIP-WT) verification — pure, no HTTP/Hono dependency.
 *
 * A token is an ordinary signed Nostr event of {@link NWT_KIND} (27519), signed
 * by the *viewer's* key. It carries an `aud` tag binding it to a specific server
 * and an `exp` tag with the session expiry. We transport it Base64URL-encoded in
 * a session cookie; verification is stateless (the cookie is self-verifying), so
 * there is no server-side session store.
 */

/** NIP-WT event kind (references RFC-7519 / JWT). */
export const NWT_KIND = 27519;

/** Allowed clock skew, in seconds, when comparing timestamps (per the spec). */
const CLOCK_SKEW = 60;

/** The outcome of verifying a token: `pubkey` on success, `reason` on failure. */
export type TokenResult =
  | { ok: true; pubkey: string }
  | { ok: false; reason: string };

export interface VerifyOptions {
  /** This server's npub — the token's `aud` tag must match it exactly. */
  audience: string;
  /** Set of allowed viewer pubkeys (hex). The token's `pubkey` must be in it. */
  whitelist: ReadonlySet<string>;
  /** Current time in unix seconds (injected so callers/tests control it). */
  now: number;
  /** Reject tokens whose `exp` is further out than this many seconds from now. */
  maxSessionSeconds: number;
}

/** Read the single value of the first `name` tag, or `undefined`. */
function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/**
 * Decode a Base64URL token string into a Nostr event. Returns `null` for
 * anything that isn't valid base64url-encoded JSON with the basic event shape.
 */
export function decodeToken(token: string): NostrEvent | null {
  try {
    const json = Buffer.from(token, "base64url").toString("utf8");
    const event = JSON.parse(json);
    if (
      event &&
      typeof event === "object" &&
      typeof event.id === "string" &&
      typeof event.pubkey === "string" &&
      typeof event.sig === "string" &&
      typeof event.kind === "number" &&
      Array.isArray(event.tags)
    ) {
      return event as NostrEvent;
    }
    return null;
  } catch {
    return null;
  }
}

/** Encode a Nostr event as a Base64URL (no-padding) token string. */
export function encodeToken(event: NostrEvent): string {
  return Buffer.from(JSON.stringify(event), "utf8").toString("base64url");
}

/** The token's `exp` (unix seconds), or `0` if missing/unparseable. */
export function tokenExp(event: NostrEvent): number {
  const exp = Number(tagValue(event, "exp"));
  return Number.isFinite(exp) ? exp : 0;
}

/**
 * Verify a decoded NIP-WT event against this server: signature, kind, audience,
 * expiry window, and whitelist membership. The checks mirror the spec's verifier
 * requirements plus our application-defined trust rule (the whitelist).
 */
export function verifyToken(
  event: NostrEvent,
  opts: VerifyOptions,
): TokenResult {
  if (event.kind !== NWT_KIND) return { ok: false, reason: "wrong token kind" };

  // id + signature. nostr-tools `verifyEvent` returns false (or throws) on a bad
  // event; treat either as invalid.
  let valid = false;
  try {
    valid = verifyEvent(event);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "invalid signature" };

  if (tagValue(event, "aud") !== opts.audience)
    return { ok: false, reason: "token not issued for this server" };

  const exp = tokenExp(event);
  if (!exp) return { ok: false, reason: "token has no expiry" };
  if (exp <= opts.now - CLOCK_SKEW)
    return { ok: false, reason: "token expired" };
  if (exp > opts.now + opts.maxSessionSeconds + CLOCK_SKEW)
    return { ok: false, reason: "token lifetime too long" };

  const nbf = Number(tagValue(event, "nbf"));
  if (Number.isFinite(nbf) && nbf > opts.now + CLOCK_SKEW)
    return { ok: false, reason: "token not yet valid" };

  if (!opts.whitelist.has(event.pubkey))
    return { ok: false, reason: "npub is not on the whitelist" };

  return { ok: true, pubkey: event.pubkey };
}
