import type { FC } from "hono/jsx";

import { NWT_KIND } from "../helpers/web-token.js";
import { Layout } from "./layout.js";

/** Pinned window.nostr.js build (NIP-07 extension + NIP-46 remote-signer bridge). */
const WNJ_SRC = "https://cdn.jsdelivr.net/npm/window.nostr.js/dist/window.nostr.min.js";

/**
 * The client-side sign-in flow, emitted inline. Reads the server npub + session
 * length baked in by the server, asks `window.nostr` to sign a kind-27519 Nostr
 * Web Token bound to this server, Base64URL-encodes it, and POSTs it to `/login`
 * (which sets the HttpOnly session cookie). On success it follows `?next=`.
 */
function signInScript(npub: string, sessionSeconds: number): string {
  return `
(function () {
  var NPUB = ${JSON.stringify(npub)};
  var SESSION = ${sessionSeconds};
  var KIND = ${NWT_KIND};
  var next = new URLSearchParams(location.search).get("next") || "/";
  var btn = document.getElementById("signin");
  var status = document.getElementById("status");
  function b64url(obj) {
    var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
    return b64.replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }
  btn.addEventListener("click", async function () {
    status.textContent = "";
    if (!window.nostr) { status.textContent = "No Nostr signer available."; return; }
    btn.disabled = true;
    try {
      var now = Math.floor(Date.now() / 1000);
      var pubkey = await window.nostr.getPublicKey();
      var signed = await window.nostr.signEvent({
        kind: KIND,
        created_at: now,
        content: "",
        tags: [["aud", NPUB], ["iat", String(now)], ["exp", String(now + SESSION)]],
        pubkey: pubkey,
      });
      var res = await fetch("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: b64url(signed) }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (res.ok && data.ok) { location.href = next; return; }
      status.textContent = data.reason || "Login failed.";
    } catch (err) {
      status.textContent = (err && err.message) || "Signing was cancelled.";
    }
    btn.disabled = false;
  });
})();
`;
}

/** Configures window.nostr.js before it loads (must run first). */
const WNJ_CONFIG = `
window.wnjParams = {
  position: "bottom",
  startHidden: true,
  appMetadata: { name: "tunnels", url: location.origin },
};
`;

/**
 * The login gate. Shown when a `NOSTR_WHITELIST` is configured and the visitor
 * has no valid session. Sign-in is entirely client-side via `window.nostr`.
 */
export const LoginPage: FC<{ npub: string; sessionSeconds: number }> = ({
  npub,
  sessionSeconds,
}) => (
  <Layout title="tunnels — sign in" npub={npub}>
    <section class="panel">
      <h2>Sign in</h2>
      <p class="hint">
        Access to this observer is restricted. Sign in with your Nostr key to
        continue — only whitelisted npubs are allowed.
      </p>
      <button id="signin" class="btn" type="button">
        Sign in with Nostr
      </button>
      <div id="status" class="empty" style="padding:12px 0 0; text-align:left;" />
      <p class="hint" style="margin-top:14px;">
        Uses a browser extension (NIP-07) or remote signer (NIP-46) — nothing is
        installed and your key never leaves your signer.
      </p>
    </section>

    <script dangerouslySetInnerHTML={{ __html: WNJ_CONFIG }} />
    <script src={WNJ_SRC} />
    <script
      dangerouslySetInnerHTML={{
        __html: signInScript(npub, sessionSeconds),
      }}
    />
  </Layout>
);
