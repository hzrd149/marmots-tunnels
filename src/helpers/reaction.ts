import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { getEventHash } from "applesauce-core/helpers/event";

import type { ForkTreeView } from "@internet-privacy/marmot-ts/client";

/** Kind of the chat rumors we react to (Marmot chat-message convention). */
export const CHAT_MESSAGE_KIND = 9;
/** Kind of the NIP-25 reaction rumors we emit. */
export const REACTION_KIND = 7;

/**
 * A palette of visually distinct emoji, one of which is deterministically
 * assigned to each *branch* (see {@link branchTagFor}). It is large enough that
 * two sibling branches (which always have distinct branch tags) land on the same
 * emoji only ~1/N of the time, so a new fork is almost always visible as a new
 * emoji. Index 0 is reserved for the tagless/legacy case so a real branch never
 * collides with "unknown branch".
 */
const PALETTE = [
  "🔮", "🦊", "🐙", "🦄", "🐝", "🦋", "🐬", "🦉",
  "🌵", "🍄", "🌻", "🍁", "⭐", "🌈", "🔥", "❄️",
  "🍎", "🍋", "🍇", "🍑", "🍉", "🥝", "🍒", "🥑",
  "⚡", "💧", "🌊", "🍀", "🌸", "🌙", "☀️", "🪐",
  "🎈", "🎲", "🎸", "🎺", "🚀", "🛸", "⛵", "🚂",
  "🐢", "🐳", "🦒", "🦓", "🦔", "🦦", "🐊", "🦜",
  "🌶️", "🧊", "🪁", "🎯", "🧩", "🔔", "💎", "🗝️",
  "🍯", "🫐", "🥥", "🌰", "🐞", "🦚", "🦩", "🐡",
] as const;

/**
 * Map a branch tag (from {@link branchTagFor}) to a stable emoji. Deterministic
 * across processes and restarts: the same branch tag always yields the same
 * emoji, so every client that can read the reaction sees a consistent per-branch
 * marker. The empty/legacy tag returns a fixed sentinel.
 */
export function emojiForTag(tag: string): string {
  if (!tag) return PALETTE[0];
  // FNV-1a over the hex string → an index into the palette (skipping index 0,
  // which is reserved for the empty tag).
  let hash = 0x811c9dc5;
  for (let i = 0; i < tag.length; i++) {
    hash ^= tag.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const idx = 1 + ((hash >>> 0) % (PALETTE.length - 1));
  return PALETTE[idx];
}

/**
 * Resolve the *branch* a fork-tree node belongs to, named by a single stable
 * tag. Walking from the node toward the root, the branch is named by the first
 * node whose parent has more than one child — the point where this branch split
 * off at a fork. A node with no forking ancestor belongs to the root branch
 * (named by the root tag).
 *
 * This is deliberately epoch-independent: every epoch along one un-forked
 * lineage resolves to the same branch tag, so the reaction emoji stays constant
 * as commits advance the epoch and changes only when a genuine fork introduces a
 * new branch. It is stable across restarts — it depends only on the parent chain
 * and per-node child *counts*, never on child ordering (which the engine does
 * not preserve across reloads) — and it changes a given node's branch at most
 * once, the moment that node's fork is first observed.
 */
export function branchTagFor(view: ForkTreeView, tag: string): string {
  const byTag = new Map(view.nodes.map((node) => [node.tag, node]));
  let node = byTag.get(tag);
  if (!node) return tag; // unknown node — fall back to its own identity
  while (node.parentTag !== undefined) {
    const parent = byTag.get(node.parentTag);
    if (!parent) break; // parent missing from the view — treat node as a root
    if (parent.childTags.length > 1) return node.tag; // split point: branch start
    node = parent;
  }
  return node.tag; // reached the root with no fork above — the root branch
}

/**
 * Build an unsigned kind-7 reaction rumor targeting `target` with `emoji`, its
 * `id` filled in. Mirrors NIP-25: an `e` tag pointing at the reacted message
 * (with its author), a `p` tag naming that author, and a `k` tag recording the
 * reacted-to kind. The `e`/`p` relay hint is empty because the rumor travels
 * over MLS, not a relay.
 */
export function buildReactionRumor(options: {
  pubkey: string;
  target: Rumor;
  emoji: string;
}): Rumor {
  const { pubkey, target, emoji } = options;
  const rumor: Rumor = {
    id: "",
    kind: REACTION_KIND,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    content: emoji,
    tags: [
      ["e", target.id, "", target.pubkey],
      ["p", target.pubkey],
      ["k", String(target.kind)],
    ],
  };
  rumor.id = getEventHash(rumor);
  return rumor;
}
