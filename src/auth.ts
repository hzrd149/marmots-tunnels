import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { Context, MiddlewareHandler } from "hono";

import {
  decodeToken,
  tokenExp,
  verifyToken,
  type VerifyOptions,
} from "./helpers/web-token.js";

/** Session cookie name holding the Base64URL-encoded NIP-WT. */
const COOKIE = "nwt";

/** Make `c.get("viewer")` typed across the app once auth has run. */
declare module "hono" {
  interface ContextVariableMap {
    /** Authenticated viewer pubkey (hex), set by {@link Auth.requireAuth}. */
    viewer?: string;
  }
}

export interface AuthOptions {
  /** Whether the gate is active (i.e. a non-empty whitelist was configured). */
  enabled: boolean;
  /** This server's npub — tokens are bound to it via their `aud` tag. */
  audience: string;
  /** Allowed viewer pubkeys (hex). */
  whitelist: ReadonlySet<string>;
  /** Maximum accepted session length, in seconds. */
  sessionSeconds: number;
}

/** Current unix time in seconds. */
const now = () => Math.floor(Date.now() / 1000);

/** Is the original request HTTPS? Honours a reverse proxy's `x-forwarded-proto`. */
function isHttps(c: Context): boolean {
  const forwarded = c.req.header("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]!.trim() === "https";
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Verify the request's session cookie, returning the viewer pubkey or `null`. */
function viewerFromCookie(c: Context, opts: AuthOptions): string | null {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const event = decodeToken(token);
  if (!event) return null;
  const verify: VerifyOptions = {
    audience: opts.audience,
    whitelist: opts.whitelist,
    now: now(),
    maxSessionSeconds: opts.sessionSeconds,
  };
  const result = verifyToken(event, verify);
  return result.ok ? result.pubkey : null;
}

/**
 * The HTTP gate. Bundles the {@link AuthOptions} into a middleware plus the
 * login/logout route handlers, so the cookie name, audience, and whitelist are
 * configured in exactly one place.
 */
export class Auth {
  constructor(private readonly opts: AuthOptions) {}

  /** True when the gate is on (a whitelist was configured). */
  get enabled(): boolean {
    return this.opts.enabled;
  }

  /** Resolve the authenticated viewer for a request, or `null`. */
  viewer(c: Context): string | null {
    if (!this.opts.enabled) return null;
    return viewerFromCookie(c, this.opts);
  }

  /**
   * Gate every route except `/login` and `/logout`. When the gate is off this is
   * a no-op. A valid cookie sets `c.var.viewer` and continues; otherwise GET
   * requests are redirected to the login page (preserving where they were
   * headed) and everything else gets a `401`.
   */
  requireAuth(): MiddlewareHandler {
    return async (c, next) => {
      if (!this.opts.enabled) return next();
      const path = c.req.path;
      if (path === "/login" || path === "/logout") return next();

      const viewer = viewerFromCookie(c, this.opts);
      if (viewer) {
        c.set("viewer", viewer);
        return next();
      }

      // Stale/absent cookie — clear it so the browser stops resending garbage.
      deleteCookie(c, COOKIE, { path: "/" });
      if (c.req.method === "GET") {
        const search = new URL(c.req.url).search;
        const target = encodeURIComponent(path + search);
        return c.redirect(`/login?next=${target}`);
      }
      return c.json({ ok: false, reason: "authentication required" }, 401);
    };
  }

  /**
   * `POST /login`: validate a signed NIP-WT from the request body and, on
   * success, store it in an HttpOnly session cookie scoped to its own expiry.
   */
  async login(c: Context): Promise<Response> {
    if (!this.opts.enabled) return c.json({ ok: true });

    const body = (await c.req.json().catch(() => null)) as {
      token?: unknown;
    } | null;
    const token = body?.token;
    if (typeof token !== "string")
      return c.json({ ok: false, reason: "missing token" }, 400);

    const event = decodeToken(token);
    const result = event
      ? verifyToken(event, {
          audience: this.opts.audience,
          whitelist: this.opts.whitelist,
          now: now(),
          maxSessionSeconds: this.opts.sessionSeconds,
        })
      : ({ ok: false, reason: "malformed token" } as const);
    if (!result.ok) return c.json(result, 401);

    const maxAge = Math.max(0, tokenExp(event!) - now());
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: isHttps(c),
      maxAge,
    });
    return c.json({ ok: true });
  }

  /** `GET /logout`: drop the session cookie and return to the login page. */
  logout(c: Context): Response {
    deleteCookie(c, COOKIE, { path: "/" });
    return c.redirect("/login");
  }
}
