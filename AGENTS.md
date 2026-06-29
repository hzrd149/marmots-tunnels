# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> `CLAUDE.md` is a symlink to this file (`AGENTS.md`). Edit `AGENTS.md`.

## What this is

`tunnels` is a Marmot **group-history debugger**: a headless server with a single
MLS identity that gets invited into groups and then follows *everything*. It
configures the Marmot engine for infinite retention so it can decrypt and keep
**every fork** of every group it joins, and serves a Hono web UI that renders each
group's full history as a branching epoch tree / side-by-side timeline. See
`README.md` for the user-facing feature tour and the full env-var table.

## Commands

```sh
pnpm install         # also runs `prepare`: builds the workspace deps (ts-mls + marmot-ts)
pnpm dev             # tsx watch src/index.tsx → http://localhost:3000
pnpm build           # tsc → dist/
pnpm start           # node dist/index.js (run build first)
pnpm typecheck       # tsc --noEmit
```

- **No tests or linter at the app level.** Verification is `pnpm typecheck`. The
  test suite (`vitest`) and `prettier` live inside the `marmot-ts` submodule.
- **`marmot-ts` is a git submodule *and* a pnpm workspace package** (`marmot-ts/`,
  plus its own nested `marmot-ts/ts-mls`). After a fresh clone or submodule update,
  run `git submodule update --init --recursive` then `pnpm install` so `prepare`
  rebuilds `@internet-privacy/marmot-ts` — the app imports its compiled `dist/`,
  so stale or unbuilt submodule output causes confusing type/import errors.
- **Node 22.5+ required** (uses the built-in `node:sqlite` module). Developed on
  Node 24, where no flag is needed.

## Conventions worth knowing

- **ESM + NodeNext.** All relative imports use explicit `.js` extensions even from
  `.ts`/`.tsx` sources (e.g. `import { Auth } from "./auth.js"`). `verbatimModuleSyntax`
  is on, so use `import type` for type-only imports.
- **`marmot-ts` is consumed via subpath exports**, not a barrel: import from the
  narrowest entry — `@internet-privacy/marmot-ts` (top-level helpers/kinds),
  `/client`, `/mls`, `/core`, `/extra`, `/utils`. Match the import to the layer you
  need rather than reaching for the package root.
- **Views are server-rendered with `hono/jsx`** (`jsxImportSource: hono/jsx`), not
  React. `src/views/*.tsx` return JSX rendered to HTML strings by route handlers;
  there is no client-side framework. Global CSS lives inline in `views/layout.tsx`.

## Architecture

Three layers, wired top-down from `src/index.tsx`:

1. **`src/index.tsx` — HTTP layer.** Builds the Hono app and all routes (`/`,
   `/:groupId`, `/:groupId/timeline`, `/:groupId/:tag`, plus login/logout). Route
   handlers pull data off the `TunnelServer`, run it through the `helpers/` shapers,
   and render a `views/` component. Boots the server (`createServer` →
   `server.start()`) before serving.

2. **`src/marmot/setup.ts` — composition root.** `configFromEnv()` parses every
   `TUNNELS_*` / `NOSTR_*` env var; `createServer()` wires the whole stack: one
   `node:sqlite` `DatabaseSync` (each store = one table), an applesauce relay pool +
   event loader for discovery, and a `MarmotClient` deliberately configured to
   **retain and process everything** (`maxRewindCommits` / `appPayloadPastEpochLimit`
   and both ingestion-pool bounds set to `Infinity`). This infinite-retention config
   is the entire point of the project — don't "optimize" it away.

3. **`src/marmot/server.ts` — `TunnelServer`, the core engine.** The headless
   observer lifecycle: publishes a discoverable identity + fresh KeyPackage on every
   start, auto-accepts every joinable invite, tracks the library's loaded-group set,
   and for each group subscribes to its kind-445 events and **drains ingest itself**.
   Draining is where the magic happens: `processed` application messages are recorded
   with the fork-node tag they decrypted at; `invalidated` messages (decrypted only on
   a *losing* branch, which the library doesn't persist) are saved and pinned to their
   fork node too. This is what lets the UI attribute each message to a specific fork.

### Key behavioral contracts

- **Passive observer — with one deliberate exception.** The server never commits,
  self-updates, or rotates leaves, so it never disturbs the fork tree it watches.
  The *one* thing it sends is a kind-7 **reaction** to every chat message it decrypts
  (`helpers/reaction.ts`, `#maybeReact`), with an emoji that is a deterministic
  function of the message's *branch* (`branchTagFor` — the lineage, not the epoch),
  so the emoji is constant along a branch and a new fork is what introduces a new
  emoji — making client-side forks visible. A reaction is a pure MLS application
  message: it never advances the epoch, so the contract holds. Reactions are deduped
  ("react once ever") via the `reactions` table so a restart's archive replay stays
  quiet.
- **Relay-independence via the event archive.** Every raw kind-445 event is archived
  to the `events` table (keyed `${groupHex}:${eventId}`). On startup the server
  **replays the archive into the engine before backfilling from relays**, so full
  fork history is reconstructed from local state even after relays prune old events.

### Storage

All state is one SQLite DB at `$TUNNELS_DATA/state.db` (WAL mode). Each
`SqliteKeyValueStore` (`helpers/sqlite-store.ts`) owns one `(key, value)` table; its
JSON replacer/reviver tag-and-restore `Uint8Array` (base64) and `bigint`, since MLS
state doesn't round-trip through plain JSON. Tables: `groups`, `rewind`,
`keypackages`, `invites` (library-owned), and `messages`, `message_epochs`, `events`,
`reactions`, `received` (first-seen event receive times), `joined` (per-group join
times) (tunnels-owned sidecars). `PrefixedKeyValueStore` namespaces per-group
data inside a shared table by a `${groupHex}:` prefix. The identity key persists at
`$TUNNELS_DATA/identity.key` (unless `TUNNELS_SECRET` overrides it), so restarts keep
the same group memberships.

### Helpers & access control

- `helpers/discovery.ts` (`Directory`) — reads other accounts' relay lists + profiles
  from the shared applesauce `EventStore`, falling back to well-known `LOOKUP_RELAYS`.
- `helpers/relay-pool.ts` — adapts applesauce's pool to marmot-ts's
  `NostrNetworkInterface`; subscriptions use `reconnect/resubscribe: Infinity` so a
  transient disconnect never silently ends a group's subscription.
- `helpers/fork-stats.ts`, `helpers/timeline.ts` — shape `MarmotGroup` fork-tree views
  into the per-node stats and side-by-side columns the views render.
- **Optional Nostr-login gate** (`src/auth.ts`, `helpers/web-token.ts`): inactive by
  default. When `NOSTR_WHITELIST` is set, the UI is gated behind a signed NIP-WT
  (kind-27519) login stored in an HttpOnly session cookie.
