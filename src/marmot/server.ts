import type { NostrEvent } from "applesauce-core/helpers/event";
import { npubEncode } from "applesauce-core/helpers/pointers";
import type { EventStore } from "applesauce-core/event-store";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";

import type {
  ForkTreeNodeView,
  GroupRumorHistory,
  MarmotClient,
  MarmotGroup,
  Unsubscribable,
} from "@internet-privacy/marmot-ts/client";
import {
  createApplicationMessageIntent,
  createInboxRelayListEvent,
  createNip65RelayListEvent,
  deserializeApplicationData,
  GROUP_EVENT_KIND,
} from "@internet-privacy/marmot-ts";
import type { GenericKeyValueStore } from "@internet-privacy/marmot-ts/utils";
import {
  deserializeClientState,
  getCredentialPubkey,
  serializeClientState,
} from "@internet-privacy/marmot-ts/core";
import {
  contentTypes,
  defaultProposalTypes,
  getCredentialFromLeafIndex,
  selfRemoveProposalType,
  wireformats,
} from "@internet-privacy/marmot-ts/mls";
import type {
  ClientState,
  LeafIndex,
  ProposalOrRef,
} from "@internet-privacy/marmot-ts/mls";

import createDebug from "debug";

import type { Directory } from "../helpers/discovery.js";
import { encryptApplicationMessageAt } from "../helpers/fork-send.js";
import type { RelayPool } from "../helpers/relay-pool.js";
import {
  branchTagFor,
  buildReactionRumor,
  CHAT_MESSAGE_KIND,
  emojiForTag,
} from "../helpers/reaction.js";

const log = createDebug("tunnels:server");

/** The kind-0 display name the server publishes so peers can recognise it. */
const PROFILE_NAME = "tunnels — group history debugger";

/** Minimal signer shape (applesauce `EventSigner`) the server needs. */
type Signer = {
  getPublicKey(): Promise<string> | string;
  signEvent(draft: any): Promise<NostrEvent> | NostrEvent;
};

/**
 * Where an application message was decrypted: the MLS epoch number and the
 * fork-tree node tag (hex of the state's confirmation tag) of the exact state it
 * decrypted at. The tag pins the message to a single branch — two same-epoch
 * forks have distinct tags — so the UI can attribute messages per fork, not just
 * per epoch number.
 */
export interface MessageMeta {
  /** MLS epoch the message decrypted at. */
  epoch: number;
  /** Fork-tree node tag (hex confirmation tag), or `""` for legacy rows. */
  tag: string;
}

/** A single proposal carried by a commit, summarized for the debugger UI. */
export interface ProposalSummary {
  /** Human label: `add`, `remove`, `update`, `self_remove`, `by reference`, … */
  type: string;
  /** True when the commit referenced a previously-published proposal by hash. */
  byReference: boolean;
  /** A resolvable target pubkey (added/removed/updated member), when known. */
  pubkey?: string;
  /** Extra free-text detail (leaf index, reference hash prefix, …). */
  detail?: string;
}

/** Commit-level detail for one fork-tree node (epoch), for the per-epoch page. */
export interface EpochDetail {
  /** The fork-tree node, or `undefined` if the tag is unknown to this group. */
  node?: ForkTreeNodeView;
  /** The committer's MLS leaf index in the parent epoch, when known. */
  committerLeaf?: number;
  /** The committer's nostr pubkey, resolved from the parent epoch's roster. */
  committerPubkey?: string;
  /** The proposals the commit applied (empty for a bare self-update commit). */
  proposals: ProposalSummary[];
  /** Whether the commit message was available and decoded (public-message). */
  commitDecoded: boolean;
}

export interface TunnelServerOptions {
  client: MarmotClient;
  pool: RelayPool;
  directory: Directory;
  eventStore: EventStore;
  signer: Signer;
  pubkey: string;
  /** NIP-65 outbox relays (kind 10002): profile, relay lists, KeyPackage. */
  outboxRelays: string[];
  /** Welcome-inbox relays (kind 10050): where invites are watched + delivered. */
  inboxRelays: string[];
  /** Sidecar index of where (epoch + fork node) each app message decrypted. */
  metaStore: GenericKeyValueStore<MessageMeta>;
  /** Durable archive of raw kind-445 events, keyed `${groupHex}:${eventId}`. */
  eventArchive: GenericKeyValueStore<NostrEvent>;
  /**
   * Dedup index of chat messages already reacted to (value = the emoji sent),
   * keyed `${groupHex}:${rumorId}`. Makes "react once ever" survive restarts.
   */
  reactedStore: GenericKeyValueStore<string>;
  /**
   * First-seen receive time (unix seconds) per kind-445 event, keyed
   * `${groupHex}:${eventId}`. Lets the UI show the created_at→received gap.
   */
  receivedStore: GenericKeyValueStore<number>;
  /** Join time (unix seconds) per group, keyed by group hex. */
  joinedStore: GenericKeyValueStore<number>;
  /**
   * Our advancing per-epoch sender state (serialized {@link ClientState}), keyed
   * `${groupHex}:${tag}`. Persists the sender-ratchet generation across restarts
   * so fork-targeted reactions never reuse a generation.
   */
  forkSendStore: GenericKeyValueStore<Uint8Array>;
  /**
   * Optional inactivity TTL in hours. When set (> 0), groups idle for at least
   * this long are periodically purged from local storage. Unset = retain forever.
   */
  groupTtlHours?: number;
  /** Teardown hook (closes the SQLite connection). */
  dispose?: () => void;
}

/** How often the inactivity sweep runs (capped to the TTL for short TTLs). */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Headless driver for an omniscient group observer. Unlike a chat client it
 * never commits or rotates leaves — it never changes group state — so it never
 * disturbs the fork tree it watches. Its job is to be invited into groups,
 * follow every kind-445 event, and let the {@link MarmotClient} (configured for
 * infinite retention) record the full fork history so the web UI can render it.
 *
 * It is *not* fully silent: it reacts to every chat message it decrypts with a
 * kind-7 emoji whose glyph is a deterministic function of the *branch* the
 * message's fork node belongs to ({@link branchTagFor} → {@link emojiForTag}).
 * The emoji is constant along a lineage — a plain commit advancing the epoch
 * keeps it — and changes only when a real fork splits off a new branch. A
 * reaction is a pure MLS application message — it never commits or advances the
 * epoch — so the fork-tree contract still holds. The reaction both confirms the
 * debugger received the message and makes a client-side fork *visible*: once a
 * client diverges, the server sees its later messages on a new branch, so their
 * emoji changes while the pre-fork messages keep the old one. Each reaction is
 * encrypted against the exact epoch the message decrypted at — not the server's
 * canonical state — so a client on a fork the server is not following can still
 * decrypt the reaction (see {@link #sendReactionAt}).
 *
 * The lifecycle: publish a discoverable identity + KeyPackage so peers can
 * invite us, restore + connect every known group, auto-accept every joinable
 * invite, and keep an up-to-date map of loaded groups for the HTTP layer.
 */
export class TunnelServer {
  readonly #client: MarmotClient;
  readonly #pool: RelayPool;
  readonly #directory: Directory;
  readonly #eventStore: EventStore;
  readonly #signer: Signer;
  readonly #pubkey: string;
  readonly #outboxRelays: string[];
  readonly #inboxRelays: string[];
  readonly #relays: string[];
  readonly #metaStore: GenericKeyValueStore<MessageMeta>;
  readonly #eventArchive: GenericKeyValueStore<NostrEvent>;
  readonly #reactedStore: GenericKeyValueStore<string>;
  readonly #receivedStore: GenericKeyValueStore<number>;
  readonly #joinedStore: GenericKeyValueStore<number>;
  readonly #forkSendStore: GenericKeyValueStore<Uint8Array>;
  readonly #groupTtlHours?: number;
  readonly #dispose?: () => void;

  readonly #groups = new Map<string, MarmotGroup>();
  /** Newest kind-445 `created_at` (unix seconds) seen per group — its activity. */
  readonly #lastActive = new Map<string, number>();
  /** Live kind-445 subscriptions, one per followed group. */
  readonly #connections = new Map<string, Unsubscribable>();
  /** Invite rumor ids we've already attempted, so we don't re-join on re-yield. */
  readonly #handledInvites = new Set<string>();
  /** Profile-name cache for member pubkeys (kind 0), populated lazily. */
  readonly #names = new Map<string, string>();
  /** In-memory mirror of the message-meta index, keyed `${groupHex}:${rumorId}`. */
  readonly #metaCache = new Map<string, MessageMeta>();
  /** Rumor keys (`${groupHex}:${rumorId}`) already reacted to — restart-loaded. */
  readonly #reactedCache = new Set<string>();
  /** First-seen receive time (unix s) per `${groupHex}:${eventId}` — restart-loaded. */
  readonly #receivedCache = new Map<string, number>();
  /** Join time (unix s) per group hex, cached lazily from `#joinedStore`. */
  readonly #joinedCache = new Map<string, number>();
  /** Live advancing sender state per `${groupHex}:${tag}` for fork-targeted sends. */
  readonly #forkSendState = new Map<string, ClientState>();
  /** Per-epoch send serializer (promise chain) keyed `${groupHex}:${tag}`. */
  readonly #forkSendChain = new Map<string, Promise<unknown>>();
  /** Ids of kind-445 events we published, to skip ingesting our own echoes. */
  readonly #sentEventIds = new Set<string>();

  #stopped = false;
  #inviteConnection?: Unsubscribable;
  #sweepTimer?: ReturnType<typeof setInterval>;

  constructor(options: TunnelServerOptions) {
    this.#client = options.client;
    this.#pool = options.pool;
    this.#directory = options.directory;
    this.#eventStore = options.eventStore;
    this.#signer = options.signer;
    this.#pubkey = options.pubkey;
    this.#outboxRelays = options.outboxRelays;
    this.#inboxRelays = options.inboxRelays;
    this.#relays = [
      ...new Set([...options.outboxRelays, ...options.inboxRelays]),
    ];
    this.#metaStore = options.metaStore;
    this.#eventArchive = options.eventArchive;
    this.#reactedStore = options.reactedStore;
    this.#receivedStore = options.receivedStore;
    this.#joinedStore = options.joinedStore;
    this.#forkSendStore = options.forkSendStore;
    this.#groupTtlHours = options.groupTtlHours;
    this.#dispose = options.dispose;
  }

  get pubkey(): string {
    return this.#pubkey;
  }

  get npub(): string {
    return npubEncode(this.#pubkey);
  }

  get relays(): string[] {
    return this.#relays;
  }

  get outboxRelays(): string[] {
    return this.#outboxRelays;
  }

  get inboxRelays(): string[] {
    return this.#inboxRelays;
  }

  // --- lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    await this.#publishIdentity();
    await this.#refreshKeyPackage();

    // #trackGroups follows the library's loaded-group set and connects each
    // group's kind-445 subscription (existing + future-joined), draining ingest
    // ourselves so we can capture the epoch each application message decrypts
    // at. invites.listen subscribes for gift-wraps on our inbox relays.
    this.#inviteConnection = await this.#client.invites.listen(
      this.#inboxRelays,
    );

    void this.#trackGroups();
    void this.#autoAcceptInvites();

    if (this.#groupTtlHours) {
      log("inactivity TTL: purging groups idle for > %dh", this.#groupTtlHours);
      // Sweep no less often than the TTL itself, so a short TTL still fires.
      const every = Math.min(
        SWEEP_INTERVAL_MS,
        this.#groupTtlHours * 3_600_000,
      );
      this.#sweepTimer = setInterval(() => void this.#sweepExpired(), every);
      this.#sweepTimer.unref?.();
    }

    log("ready as %s on %o", this.npub, this.#relays);
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#inviteConnection?.unsubscribe();
    for (const sub of this.#connections.values()) sub.unsubscribe();
    this.#connections.clear();
    this.#eventStore.dispose();
    this.#pool.close();
    this.#dispose?.();
  }

  // --- queries (consumed by the HTTP layer) ----------------------------------

  /** Every group the server is currently following, in load order. */
  groups(): MarmotGroup[] {
    return [...this.#groups.values()];
  }

  /** A single followed group by hex id, or undefined. */
  group(idStr: string): MarmotGroup | undefined {
    return this.#groups.get(idStr);
  }

  /**
   * The newest kind-445 event `created_at` (unix seconds) seen for a group — its
   * "last active" time across all activity (commits + messages + proposals), or
   * `0` if nothing has been ingested for it yet. Used to order the group list
   * (most-recently-active first) and to drive inactivity expiry.
   */
  lastActive(idStr: string): number {
    return this.#lastActive.get(idStr) ?? 0;
  }

  /**
   * A human label for a member pubkey: the cached kind-0 display name if known,
   * else a short npub. Triggers a background profile fetch (via the shared
   * event store loader) so a later render can show the name.
   */
  nameFor(pubkey: string): string {
    const cached = this.#names.get(pubkey);
    if (cached) return cached;
    void this.#directory
      .profile(pubkey, this.#relays)
      .then((profile) => {
        const name = profile?.name?.trim() || profile?.display_name?.trim();
        if (name) this.#names.set(pubkey, name);
      })
      .catch(() => {});
    return npubShort(pubkey);
  }

  // --- internals -------------------------------------------------------------

  /**
   * Publish a discoverable identity on every start: a kind-0 profile, a NIP-65
   * (kind 10002) outbox list advertising the outbox relays, and a kind-10050
   * inbox list advertising the inbox relays. All three are announced to the
   * outbox relays — where peers read them to discover the server's KeyPackage
   * and learn where to deliver a Welcome. Without these, the server can't be
   * invited.
   */
  async #publishIdentity(): Promise<void> {
    const profile = await this.#signer.signEvent({
      kind: 0,
      content: JSON.stringify({
        name: PROFILE_NAME,
        about:
          "Follows and decrypts the full fork history of every group it joins.",
      }),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    await this.#pool.publish(this.#outboxRelays, profile);
    this.#eventStore.add(profile);

    const outbox = await this.#signer.signEvent(
      createNip65RelayListEvent({
        pubkey: this.#pubkey,
        relays: this.#outboxRelays,
      }),
    );
    await this.#pool.publish(this.#outboxRelays, outbox);
    this.#eventStore.add(outbox);

    const inbox = await this.#signer.signEvent(
      createInboxRelayListEvent({
        pubkey: this.#pubkey,
        relays: this.#inboxRelays,
      }),
    );
    await this.#pool.publish(this.#outboxRelays, inbox);
    this.#eventStore.add(inbox);

    log(
      "published identity — outbox %o · inbox %o",
      this.#outboxRelays,
      this.#inboxRelays,
    );
  }

  /**
   * Publish a fresh KeyPackage to the outbox relays on every start: rotate the
   * current one if we already hold a KeyPackage (replacing the advertised
   * material so a relay restart or rotation can't strand us with a stale,
   * consumed package), otherwise create the first one. Either way a peer
   * fetching our outbox finds an unused KeyPackage to invite us with.
   */
  async #refreshKeyPackage(): Promise<void> {
    const list = await this.#client.keyPackages.list();
    const current =
      list.find((pkg) => !pkg.used && pkg.identifier === "tunnels") ??
      list.find((pkg) => !pkg.used) ??
      list[0];

    if (current) {
      const rotated = await this.#client.keyPackages.rotate(
        current.keyPackageRef,
        { relays: this.#outboxRelays },
      );
      log("rotated KeyPackage → %s", hex(rotated.keyPackageRef));
    } else {
      const created = await this.#client.keyPackages.create({
        relays: this.#outboxRelays,
      });
      log("created KeyPackage %s", hex(created.keyPackageRef));
    }
  }

  /**
   * Follow the library's loaded-group set (initial snapshot + every change) and
   * keep our subscriptions in lockstep: connect freshly-loaded/joined groups,
   * drop ones that left. This is the single source that connects both restored
   * groups (the initial yield is `loadAll()`) and newly-joined ones.
   */
  async #trackGroups(): Promise<void> {
    try {
      for await (const groups of this.#client.groups.watch()) {
        if (this.#stopped) break;
        const live = new Set(groups.map((g) => g.idStr));
        for (const group of groups) this.#track(group);
        for (const id of [...this.#groups.keys()]) {
          if (!live.has(id)) this.#untrack(id);
        }
      }
    } catch (err) {
      if (!this.#stopped) log("group tracking error: %O", err);
    }
  }

  #track(group: MarmotGroup): void {
    if (this.#groups.has(group.idStr)) return;
    this.#groups.set(group.idStr, group);
    log("following group %s (%s)", group.idStr.slice(0, 8), groupName(group));
    void this.#connect(group);
  }

  #untrack(idStr: string): void {
    this.#groups.delete(idStr);
    this.#lastActive.delete(idStr);
    this.#connections.get(idStr)?.unsubscribe();
    this.#connections.delete(idStr);
  }

  /**
   * Purge groups with no kind-445 activity within the configured TTL. A group is
   * only eligible once it has a recorded last-active time (> 0), so groups whose
   * archive replay is still in flight on startup are never purged prematurely.
   */
  async #sweepExpired(): Promise<void> {
    if (this.#stopped || !this.#groupTtlHours) return;
    const cutoff = Math.floor(Date.now() / 1000) - this.#groupTtlHours * 3600;
    const stale = [...this.#groups.keys()].filter((id) => {
      const seen = this.#lastActive.get(id);
      return seen !== undefined && seen < cutoff;
    });
    for (const id of stale) {
      log(
        "purging idle group %s (last active %s)",
        id.slice(0, 8),
        this.#lastActive.get(id),
      );
      await this.#purgeGroup(id);
    }
  }

  /**
   * Remove every trace of a group from local storage. `client.groups.destroy`
   * purges the library-owned state (group state, rewind history, rumor history)
   * *without publishing anything* — so the passive-observer contract holds — and
   * its `destroyed` event drives `#untrack` via the watch loop. We then clear the
   * tunnels-owned sidecars the library doesn't know about: the raw-event archive,
   * the message-meta index, the reacted-message dedup index, the receive-time
   * index, and the per-epoch sender-state index (all keyed `${groupHex}:`), plus
   * this group's join-time row.
   */
  async #purgeGroup(idStr: string): Promise<void> {
    try {
      await this.#client.groups.destroy(idStr);
    } catch (err) {
      log("purge: destroy failed for %s: %O", idStr, err);
      return; // leave the sidecars intact so a retry can finish the job
    }
    this.#untrack(idStr);
    await this.#clearPrefixed(this.#eventArchive, `${idStr}:`);
    await this.#clearPrefixed(this.#metaStore, `${idStr}:`);
    await this.#clearPrefixed(this.#reactedStore, `${idStr}:`);
    await this.#clearPrefixed(this.#receivedStore, `${idStr}:`);
    await this.#clearPrefixed(this.#forkSendStore, `${idStr}:`);
    await this.#joinedStore.removeItem(idStr).catch(() => {});
    this.#joinedCache.delete(idStr);
    for (const cache of [
      this.#metaCache,
      this.#receivedCache,
      this.#forkSendState,
      this.#forkSendChain,
    ]) {
      for (const key of [...cache.keys()]) {
        if (key.startsWith(`${idStr}:`)) cache.delete(key);
      }
    }
    for (const key of [...this.#reactedCache]) {
      if (key.startsWith(`${idStr}:`)) this.#reactedCache.delete(key);
    }
  }

  /** Remove every row in a store whose key starts with `prefix`. */
  async #clearPrefixed(
    store: GenericKeyValueStore<unknown>,
    prefix: string,
  ): Promise<void> {
    const keys = (await store.keys()).filter((key) => key.startsWith(prefix));
    await Promise.all(keys.map((key) => store.removeItem(key).catch(() => {})));
  }

  /**
   * Subscribe a group to its kind-445 events (backfill, then live) and drain
   * ingest ourselves, recording where every application message decrypted so the
   * UI can place it on its fork node (the stored rumor carries no epoch/tag).
   *
   * `processed` application messages are on the selected (canonical) branch — the
   * library already persists their rumor, so we only record their meta. The
   * engine also surfaces messages that decrypt **only on a losing/non-canonical
   * branch** as `invalidated`, each now carrying the fork node (`tag`/`epoch`) it
   * decrypted against; the library does *not* store those, so we persist the
   * rumor ourselves and record its meta. Together they give the full fork view.
   */
  async #connect(group: MarmotGroup): Promise<void> {
    if (this.#connections.has(group.idStr) || this.#stopped) return;
    const groupIdHex = group.info.nostr.groupIdHex;
    const relays = group.relays?.length ? group.relays : this.#relays;
    if (!groupIdHex || !relays.length) {
      log("connect: group %s has no routing/relays — skipping", group.idStr);
      return;
    }
    const filter = { kinds: [GROUP_EVENT_KIND], "#h": [groupIdHex] };

    const seen = new Set<string>();
    const history = group.history as unknown as GroupRumorHistory | undefined;
    const drain = async (events: NostrEvent[]): Promise<void> => {
      // Skip the echoes of reactions we published ourselves: they carry no new
      // information and would otherwise re-enter ingest (and possibly the pending
      // pool). Persisted dedup isn't needed — on restart they replay once, the
      // same as any other archived event.
      const fresh = events.filter(
        (event) => !seen.has(event.id) && !this.#sentEventIds.has(event.id),
      );
      for (const event of fresh) seen.add(event.id);
      if (!fresh.length) return;
      // Archive every event before processing it, so the durable store is a
      // superset of whatever relays still serve (idempotent upsert by id), and
      // advance the group's last-active time from the newest event seen.
      let newest = this.#lastActive.get(group.idStr) ?? 0;
      const now = Math.floor(Date.now() / 1000);
      for (const event of fresh) {
        const key = `${group.idStr}:${event.id}`;
        void this.#eventArchive.setItem(key, event).catch(() => {});
        // Stamp the first time we ever saw this event, and only the first time —
        // the cache is warmed from the store on connect, so a restart's archive
        // replay keeps the original receive time instead of resetting it to now.
        if (!this.#receivedCache.has(key)) {
          this.#receivedCache.set(key, now);
          void this.#receivedStore.setItem(key, now).catch(() => {});
        }
        if (event.created_at > newest) newest = event.created_at;
      }
      this.#lastActive.set(group.idStr, newest);
      try {
        for await (const result of group.ingest(fresh)) {
          if (
            result.kind === "processed" &&
            result.result.kind === "applicationMessage"
          ) {
            const state = result.result.newState;
            // An application message never changes group state, so newState's
            // confirmation tag is the fork-tree node it decrypted at.
            const tag = Buffer.from(state.confirmationTag).toString("hex");
            this.#recordMessageMeta(group.idStr, result.result.message, {
              epoch: Number(state.groupContext.epoch),
              tag,
            });
            void this.#maybeReact(group, result.result.message, tag);
          } else if (
            result.kind === "invalidated" &&
            result.payload !== undefined &&
            result.tag !== undefined &&
            result.epoch !== undefined
          ) {
            // Decrypted only on a losing branch — the library never stores it, so
            // save the rumor ourselves and pin it to the fork node it belongs to.
            try {
              const rumor = deserializeApplicationData(result.payload);
              await history?.saveRumor(rumor);
              this.#recordMessageMeta(group.idStr, result.payload, {
                epoch: result.epoch,
                tag: result.tag,
              });
              void this.#maybeReact(group, rumor, result.tag);
            } catch {
              // not a NIP-59 rumor payload (or history unavailable) — skip
            }
          }
        }
      } catch (err) {
        log("connect: ingest failed for %s: %O", group.idStr, err);
      }
    };

    // Warm the reacted-message dedup cache and the first-seen receive times from
    // their persisted indexes *before* any event can be drained, so a restart's
    // archive replay (or an early live event) neither re-reacts to anything we've
    // already reacted to nor resets an event's original receive time.
    await Promise.all([
      this.#loadReactedKeys(group.idStr),
      this.#loadReceivedTimes(group.idStr),
    ]);

    // Register the live subscription first (so nothing is missed), then drain in
    // two batches: our durable event archive — so the full history survives even
    // if relays have pruned it — then a relay backfill for anything new since the
    // last run. Both batches share `seen`, so an event in both is processed once.
    const sub = this.#pool
      .subscription(relays, filter)
      .subscribe({ next: (event) => void drain([event]) });
    this.#connections.set(group.idStr, sub);
    if (this.#stopped) {
      sub.unsubscribe();
      this.#connections.delete(group.idStr);
      return;
    }
    await drain(await this.#loadArchivedEvents(group.idStr));
    await drain(await this.#pool.request(relays, filter));
  }

  /**
   * Every kind-445 event previously archived for a group, newest first (so a
   * replay resolves the same way a fresh backfill would). Reads the durable
   * `events` store, which is a superset of whatever relays still serve.
   */
  async #loadArchivedEvents(groupIdStr: string): Promise<NostrEvent[]> {
    const prefix = `${groupIdStr}:`;
    const keys = (await this.#eventArchive.keys()).filter((key) =>
      key.startsWith(prefix),
    );
    const events = await Promise.all(
      keys.map((key) => this.#eventArchive.getItem(key)),
    );
    return events
      .filter((event): event is NostrEvent => event != null)
      .sort((a, b) => b.created_at - a.created_at);
  }

  /** Load a group's already-reacted rumor keys into the in-memory dedup cache. */
  async #loadReactedKeys(groupIdStr: string): Promise<void> {
    const prefix = `${groupIdStr}:`;
    const keys = (await this.#reactedStore.keys()).filter((key) =>
      key.startsWith(prefix),
    );
    for (const key of keys) this.#reactedCache.add(key);
  }

  /** Load a group's persisted first-seen receive times into the cache. */
  async #loadReceivedTimes(groupIdStr: string): Promise<void> {
    const prefix = `${groupIdStr}:`;
    const keys = (await this.#receivedStore.keys()).filter((key) =>
      key.startsWith(prefix),
    );
    await Promise.all(
      keys.map(async (key) => {
        const at = await this.#receivedStore.getItem(key);
        if (at != null) this.#receivedCache.set(key, at);
      }),
    );
  }

  /**
   * The first-seen receive time (unix seconds) for each of `eventIds` in one
   * group, keyed by event id. Reads the in-memory cache first, falling back to
   * the persisted index for events seen in an earlier run; ids never seen are
   * simply absent from the result.
   */
  async receivedAtFor(
    groupIdStr: string,
    eventIds: string[],
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    await Promise.all(
      eventIds.map(async (id) => {
        const key = `${groupIdStr}:${id}`;
        let at = this.#receivedCache.get(key);
        if (at == null) {
          const stored = await this.#receivedStore.getItem(key);
          if (stored != null) at = stored;
        }
        if (at != null) {
          this.#receivedCache.set(key, at);
          out[id] = at;
        }
      }),
    );
    return out;
  }

  /**
   * When (unix seconds) this server joined a group, or `undefined` if unknown
   * (e.g. a group joined before join-time tracking existed). Events created
   * before this are from before we were added, so this observer can never
   * decrypt them.
   */
  async joinedAt(groupIdStr: string): Promise<number | undefined> {
    let at = this.#joinedCache.get(groupIdStr);
    if (at == null) {
      const stored = await this.#joinedStore.getItem(groupIdStr);
      if (stored != null) {
        at = stored;
        this.#joinedCache.set(groupIdStr, at);
      }
    }
    return at;
  }

  /**
   * React to a freshly-decrypted chat message with a branch-derived emoji,
   * exactly once ever. The emoji is a deterministic function of the *branch* the
   * message's fork node belongs to ({@link branchTagFor}) — not its epoch — so
   * the emoji is constant along a lineage and changes only when a real fork
   * splits off a new branch. Any client able to read the reaction therefore sees
   * a consistent per-branch marker, and a client-side fork surfaces as its later
   * messages picking up a new emoji.
   *
   * Only kind-9 chat rumors are reacted to (never our own reactions, never
   * non-chat rumors — which also avoids any react-to-our-own-reaction loop). The
   * dedup key is claimed synchronously so concurrent drains don't double-react,
   * and persisted on success so a restart's archive replay stays quiet.
   *
   * Crucially the reaction is encrypted against the *exact epoch* the message
   * decrypted at ({@link #sendReactionAt}), not the server's canonical state — so
   * clients sitting on a fork the server is not following can still decrypt it. It
   * remains a pure MLS application message: it never commits or advances the
   * epoch, so the fork-tree the debugger watches is undisturbed.
   */
  async #maybeReact(
    group: MarmotGroup,
    source: Uint8Array | Rumor,
    tag: string,
  ): Promise<void> {
    let target: Rumor;
    try {
      target =
        source instanceof Uint8Array
          ? deserializeApplicationData(source)
          : source;
    } catch {
      return; // not a NIP-59 rumor payload
    }
    if (target.kind !== CHAT_MESSAGE_KIND) return; // only chat messages
    if (target.pubkey === this.#pubkey) return; // never react to ourselves

    const key = `${group.idStr}:${target.id}`;
    if (this.#reactedCache.has(key)) return;
    this.#reactedCache.add(key); // claim before the await so we react once

    // Resolve the branch (stable along a lineage) the message's epoch sits on,
    // then pick that branch's emoji — so per-epoch commits keep one emoji and a
    // new fork is what introduces a new one.
    const branch = branchTagFor(group.forkTreeView(), tag);
    const emoji = emojiForTag(branch);
    try {
      const reaction = buildReactionRumor({
        pubkey: this.#pubkey,
        target,
        emoji,
      });
      await this.#sendReactionAt(group, reaction, tag);
      await this.#reactedStore.setItem(key, emoji).catch(() => {});
      log(
        "reacted %s to %s on %s (epoch %s, branch %s)",
        emoji,
        target.id.slice(0, 8),
        group.idStr.slice(0, 8),
        tag.slice(0, 8),
        branch ? branch.slice(0, 8) : "—",
      );
    } catch (err) {
      this.#reactedCache.delete(key); // let a later sighting retry
      log("react failed for %s: %O", target.id.slice(0, 8), err);
    }
  }

  /**
   * Publish `reaction` as an MLS application message encrypted against the epoch
   * identified by fork-node `tag` — the epoch the message it reacts to decrypted
   * at — so any client currently on that fork can read it, even when the server's
   * own canonical branch has diverged elsewhere.
   *
   * Encrypting consumes a sender-ratchet generation, so we keep our own advancing
   * copy of that epoch's state (in {@link #forkSendState}, persisted to
   * {@link #forkSendStore}) rather than the engine's snapshot, and never reuse a
   * generation. All sends for one epoch are serialized through
   * {@link #withEpochLock} so two concurrent reactions can't both encrypt from the
   * same generation. The state is advanced and persisted *before* publishing: a
   * failed publish then leaves a harmless generation gap (receivers tolerate it),
   * whereas the reverse could reuse a generation after a crash.
   */
  async #sendReactionAt(
    group: MarmotGroup,
    reaction: Rumor,
    tag: string,
  ): Promise<void> {
    const key = `${group.idStr}:${tag}`;
    const payload = createApplicationMessageIntent(reaction).payload;
    const relays = group.relays?.length ? group.relays : this.#relays;

    await this.#withEpochLock(key, async () => {
      const state = await this.#epochSendState(group, key, tag);
      if (!state) throw new Error(`no sender state retained for epoch ${tag}`);

      const { event, newState } = await encryptApplicationMessageAt({
        ciphersuite: group.ciphersuite,
        state,
        payload,
      });

      // Advance + persist the generation before publishing (gap-over-reuse), and
      // record the event id so we skip ingesting our own echo.
      this.#forkSendState.set(key, newState);
      await this.#forkSendStore
        .setItem(key, serializeClientState(newState))
        .catch(() => {});
      this.#sentEventIds.add(event.id);
      await this.#pool.publish(relays, event);
    });
  }

  /**
   * The current advancing sender state for one epoch: the live in-memory copy if
   * we've already sent at it this run, else the persisted advanced state from an
   * earlier run, else a fresh snapshot of the epoch from the fork tree (the first
   * send starts from the engine's pristine post-commit state). `undefined` if the
   * epoch retains no snapshot (e.g. we were never a member at it).
   */
  async #epochSendState(
    group: MarmotGroup,
    key: string,
    tag: string,
  ): Promise<ClientState | undefined> {
    const live = this.#forkSendState.get(key);
    if (live) return live;
    const stored = await this.#forkSendStore.getItem(key);
    if (stored != null) {
      const restored = deserializeClientState(stored);
      this.#forkSendState.set(key, restored);
      return restored;
    }
    const fresh = await group.forkTree.stateAt(tag);
    if (fresh) this.#forkSendState.set(key, fresh);
    return fresh;
  }

  /** Run `fn` after any in-flight send for `key`, serializing sends per epoch. */
  #withEpochLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#forkSendChain.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // Keep a non-throwing tail so the next waiter chains cleanly off this one.
    this.#forkSendChain.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * Persist where an application message decrypted (epoch + fork node), keyed by
   * its rumor id. The payload is the raw application data; deserializing it
   * yields the same rumor id the history store keys by, so the UI can join them.
   */
  #recordMessageMeta(
    groupIdStr: string,
    payload: Uint8Array,
    meta: MessageMeta,
  ): void {
    let rumorId: string;
    try {
      rumorId = deserializeApplicationData(payload).id;
    } catch {
      return; // not a rumor payload (e.g. a non-NIP-59 application message)
    }
    const key = `${groupIdStr}:${rumorId}`;
    const prev = this.#metaCache.get(key);
    if (prev && prev.epoch === meta.epoch && prev.tag === meta.tag) return;
    this.#metaCache.set(key, meta);
    void this.#metaStore.setItem(key, meta).catch(() => {});
  }

  /**
   * Where each of `rumorIds` decrypted (epoch + fork node tag), for one group.
   * Reads the in-memory mirror first, falling back to the persisted index for
   * messages captured in an earlier run. Legacy rows that stored a bare epoch
   * number are normalized to a tagless {@link MessageMeta}.
   */
  async messageMetaFor(
    groupIdStr: string,
    rumorIds: string[],
  ): Promise<Record<string, MessageMeta>> {
    const out: Record<string, MessageMeta> = {};
    await Promise.all(
      rumorIds.map(async (id) => {
        const key = `${groupIdStr}:${id}`;
        let meta = this.#metaCache.get(key);
        if (!meta) {
          const stored = await this.#metaStore.getItem(key);
          if (stored != null) meta = normalizeMeta(stored);
        }
        if (meta) {
          this.#metaCache.set(key, meta);
          out[id] = meta;
        }
      }),
    );
    return out;
  }

  /**
   * Resolve commit-level detail for one fork-tree node (epoch): who created the
   * commit and which proposals it applied. The committer leaf and any removed
   * leaf are resolved against the *parent* epoch's roster (the tree the commit
   * was applied to). Best-effort — anything undecodable is simply omitted.
   */
  async epochDetail(group: MarmotGroup, tag: string): Promise<EpochDetail> {
    const node = group.forkTreeView().nodes.find((n) => n.tag === tag);
    if (!node) return { proposals: [], commitDecoded: false };

    let parentState: ClientState | undefined;
    if (node.parentTag) {
      try {
        parentState = await group.forkTree.stateAt(node.parentTag);
      } catch {
        parentState = undefined;
      }
    }

    const committerLeaf = node.commit?.senderLeafIndex;
    const committerPubkey =
      committerLeaf !== undefined && parentState
        ? leafPubkey(parentState, committerLeaf)
        : undefined;

    const proposals: ProposalSummary[] = [];
    let commitDecoded = false;
    try {
      const message = await group.forkTree.commitMessageOf(tag);
      if (
        message?.wireformat === wireformats.mls_public_message &&
        message.publicMessage.content.contentType === contentTypes.commit
      ) {
        commitDecoded = true;
        for (const por of message.publicMessage.content.commit.proposals)
          proposals.push(summarizeProposal(por, parentState));
      }
    } catch {
      // commit bytes unavailable (e.g. root) or undecodable — leave empty.
    }

    return { node, committerLeaf, committerPubkey, proposals, commitDecoded };
  }

  /**
   * Resolve the committer pubkey for each of `tags` (fork-tree nodes), keyed by
   * tag. Each is read from the *parent* epoch's roster (the tree the commit was
   * applied to) at the commit's sender leaf — the same resolution
   * {@link epochDetail} does, but committer-only and batched, so the timeline can
   * label every stop's commit without decoding proposals. Root nodes (no commit)
   * and anything undecodable are simply omitted.
   */
  async committersByTag(
    group: MarmotGroup,
    tags: string[],
  ): Promise<Record<string, string>> {
    const nodes = group.forkTreeView().nodes;
    const byTag = new Map(nodes.map((n) => [n.tag, n]));
    const out: Record<string, string> = {};
    await Promise.all(
      [...new Set(tags)].map(async (tag) => {
        const node = byTag.get(tag);
        const leaf = node?.commit?.senderLeafIndex;
        if (!node?.parentTag || leaf === undefined) return;
        try {
          const parentState = await group.forkTree.stateAt(node.parentTag);
          const pubkey = parentState && leafPubkey(parentState, leaf);
          if (pubkey) out[tag] = pubkey;
        } catch {
          // parent state unavailable or undecodable — omit this committer.
        }
      }),
    );
    return out;
  }

  /**
   * Auto-accept every joinable invite. The server is a passive observer, so it
   * joins from the Welcome but never performs the MIP-02 self-update — that
   * would push it onto its own fork and disturb the group it is here to watch.
   */
  async #autoAcceptInvites(): Promise<void> {
    try {
      for await (const entries of this.#client.watchInvites()) {
        if (this.#stopped) break;
        for (const entry of entries) {
          if (!entry.joinable) continue;
          if (this.#handledInvites.has(entry.invite.id)) continue;
          this.#handledInvites.add(entry.invite.id);
          await this.#join(entry.invite);
        }
      }
    } catch (err) {
      if (!this.#stopped) log("invite watch error: %O", err);
    }
  }

  async #join(invite: { id: string }): Promise<void> {
    try {
      const { group } = await this.#client.joinGroupFromWelcome({
        welcomeRumor: invite as any,
      });
      await this.#client.invites.markAsRead(invite.id);
      // Record when we joined so the UI can flag events created before we were
      // added — those predate our membership and can never decrypt. Only stamp
      // the first join; a re-yield of the same group keeps the original time.
      if (!(await this.joinedAt(group.idStr))) {
        const at = Math.floor(Date.now() / 1000);
        this.#joinedCache.set(group.idStr, at);
        void this.#joinedStore.setItem(group.idStr, at).catch(() => {});
      }
      this.#track(group);
      log("joined group %s (%s)", group.idStr.slice(0, 8), groupName(group));
    } catch (err) {
      // Re-allow a retry on the next yield (e.g. KeyPackage not yet stored).
      this.#handledInvites.delete(invite.id);
      log("failed to join invite %s: %O", invite.id, err);
    }
  }
}

/** Best-effort group display name (falls back to a short hex id). */
export function groupName(group: MarmotGroup): string {
  const name =
    group.groupData?.name?.trim() || group.info.app.view?.name?.trim();
  return name || `group ${group.idStr.slice(0, 8)}`;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Coerce a stored value (legacy bare epoch number or object) to MessageMeta. */
function normalizeMeta(stored: MessageMeta | number): MessageMeta {
  return typeof stored === "number" ? { epoch: stored, tag: "" } : stored;
}

/** The nostr pubkey at `leafIndex` in a state's ratchet tree, or undefined. */
function leafPubkey(state: ClientState, leafIndex: number): string | undefined {
  try {
    return getCredentialPubkey(
      getCredentialFromLeafIndex(state.ratchetTree, leafIndex as LeafIndex),
    );
  } catch {
    return undefined;
  }
}

/** Summarize one proposal (inline or by-reference) carried by a commit. */
function summarizeProposal(
  por: ProposalOrRef,
  parentState: ClientState | undefined,
): ProposalSummary {
  if ("reference" in por) {
    return {
      type: "by reference",
      byReference: true,
      detail: Buffer.from(por.reference).toString("hex").slice(0, 16),
    };
  }
  // Narrow with the `in` operator: a value switch on `proposalType` can't
  // exclude ProposalCustom (its `proposalType` is a plain `number`).
  const p = por.proposal;
  if ("add" in p) {
    let pubkey: string | undefined;
    try {
      pubkey = getCredentialPubkey(p.add.keyPackage.leafNode.credential);
    } catch {
      pubkey = undefined;
    }
    return { type: "add", byReference: false, pubkey };
  }
  if ("remove" in p) {
    return {
      type: "remove",
      byReference: false,
      pubkey: parentState
        ? leafPubkey(parentState, p.remove.removed)
        : undefined,
      detail: `leaf ${p.remove.removed}`,
    };
  }
  if ("update" in p) {
    let pubkey: string | undefined;
    try {
      pubkey = getCredentialPubkey(p.update.leafNode.credential);
    } catch {
      pubkey = undefined;
    }
    return { type: "update", byReference: false, pubkey };
  }
  return { type: proposalTypeName(p.proposalType), byReference: false };
}

/** A human label for a keyless / custom proposal type value. */
function proposalTypeName(type: number): string {
  switch (type) {
    case defaultProposalTypes.psk:
      return "psk";
    case defaultProposalTypes.reinit:
      return "reinit";
    case defaultProposalTypes.external_init:
      return "external_init";
    case defaultProposalTypes.group_context_extensions:
      return "group_context_extensions";
    case selfRemoveProposalType:
      return "self_remove";
    default:
      return `type ${type}`;
  }
}

function npubShort(pubkey: string): string {
  try {
    const npub = npubEncode(pubkey);
    return `${npub.slice(0, 10)}…${npub.slice(-6)}`;
  } catch {
    return `${pubkey.slice(0, 8)}…`;
  }
}
