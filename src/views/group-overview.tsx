import type { FC } from "hono/jsx";

import type { NostrEvent } from "applesauce-core/helpers/event";

import type {
  MarmotGroup,
  ForkTreeView,
} from "@internet-privacy/marmot-ts/client";

import type { ForkSummary } from "../helpers/fork-stats.js";
import { formatDuration, formatTime, hexShort } from "../helpers/format.js";
import { groupName } from "../marmot/server.js";
import { Author } from "./author.js";
import { ForkGraph } from "./fork-graph.js";
import { Layout } from "./layout.js";

export interface GroupOverviewProps {
  npub: string;
  viewer?: string;
  group: MarmotGroup;
  view: ForkTreeView;
  /** Application-message count keyed by node tag (for the graph annotations). */
  countByTag: Map<string, number>;
  /** Per-fork participant progress. */
  forks: ForkSummary[];
  /**
   * Raw kind-445 events received but not yet decrypted into the fork tree (the
   * engine's ingestion pool). Healthy state is empty; lingering entries are
   * undecryptable events and point at a bug.
   */
  pending: NostrEvent[];
  /** First-seen receive time (unix seconds) per pending event id. */
  receivedAt: Record<string, number>;
  /**
   * When (unix seconds) the server joined this group, or `undefined` if unknown.
   * Pending events created before this predate our membership — unreadable.
   */
  joinedAt?: number;
  nameFor: (pubkey: string) => string;
}

/**
 * Per-group page: group metadata, the clickable fork-history epoch tree (each
 * node annotated with its application-message count and linking to its own epoch
 * page), and a per-fork breakdown of which members have sent messages on each
 * branch and how far down it they have progressed.
 */
export const GroupOverview: FC<GroupOverviewProps> = ({
  npub,
  viewer,
  group,
  view,
  countByTag,
  forks,
  pending,
  receivedAt,
  joinedAt,
  nameFor,
}) => {
  const info = group.info;

  // Pending events newest-first, with a divider marking when the server was
  // invited: rows below it were created before we joined and can never decrypt.
  const orderedPending = [...pending].sort(
    (a, b) => b.created_at - a.created_at,
  );
  const joinDivider = (
    <tr class="join-divider">
      <td colspan={4}>
        server invited {joinedAt != null ? formatTime(joinedAt) : "time unknown"}{" "}
        · everything below is unreadable ↓
      </td>
    </tr>
  );
  const pendingRows: unknown[] = [];
  // Suppress the divider entirely when the join time is unknown (nothing to mark).
  let dividerPlaced = joinedAt == null;
  for (const event of orderedPending) {
    // Newest-first: the divider drops in just before the first pre-join event.
    if (!dividerPlaced && event.created_at < joinedAt!) {
      pendingRows.push(joinDivider);
      dividerPlaced = true;
    }
    const received = receivedAt[event.id];
    const preJoin = joinedAt != null && event.created_at < joinedAt;
    pendingRows.push(
      <tr class={preJoin ? "pre-join" : undefined}>
        <td class="mono" title={event.id}>
          {hexShort(event.id)}
        </td>
        <td>{formatTime(event.created_at)}</td>
        <td>{received != null ? formatTime(received) : "—"}</td>
        <td class="num">
          {received != null ? formatDuration(received - event.created_at) : "—"}
        </td>
      </tr>,
    );
  }
  // No pre-join event was hit — every event is after the invite, so the join
  // boundary sits at the very bottom, below them all.
  if (!dividerPlaced) pendingRows.push(joinDivider);

  return (
    <Layout
      title={`tunnels — ${groupName(group)}`}
      npub={npub}
      viewer={viewer}
      wide
    >
      <p>
        <a href="/">← all groups</a>
        {" · "}
        <a href={`/${group.idStr}/timeline`}>conversations timeline →</a>
      </p>

      <section class="panel">
        <h2>{groupName(group)}</h2>
        <div class="meta">
          <div>
            <span class="k">id</span>
            <span class="mono">{group.idStr}</span>
          </div>
          <div>
            <span class="k">epoch</span>
            {info.mls.epochNumber}
          </div>
          <div>
            <span class="k">members</span>
            {info.members.count}
          </div>
          <div>
            <span class="k">cipher suite</span>
            {info.mls.cipherSuiteName ?? info.mls.cipherSuite}
          </div>
          <div>
            <span class="k">convergence</span>
            {group.convergenceStatus}
          </div>
          <div>
            <span class="k">nodes / heads</span>
            {view.nodes.length} / {view.tips.length}
          </div>
        </div>
      </section>

      <section class="panel">
        <h2>Fork history — {view.nodes.length} epochs</h2>
        <p class="hint">
          Each node is one MLS epoch. Click a node to see its application
          messages, the proposals its commit carried, and who committed it.
        </p>
        <ForkGraph view={view} groupId={group.idStr} countByTag={countByTag} />
      </section>

      <section class="panel">
        <h2>Participants by fork ({forks.length})</h2>
        <p class="hint">
          For each fork head, the members who have sent application messages on
          that branch and the furthest epoch each reached — i.e. where everyone
          sits across the forks and how far along each one they have progressed.
        </p>
        {forks.length === 0 ? (
          <div class="empty">No forks recorded yet.</div>
        ) : (
          forks.map((fork) => (
            <div class="fork-card">
              <div class="fork-hdr">
                <a class="mono" href={`/${group.idStr}/${fork.tag}`}>
                  {fork.tag.slice(0, 12)}
                </a>
                <span class="pill">epoch {fork.epoch}</span>
                {fork.isCanonicalTip ? (
                  <span class="pill canon">canonical (live)</span>
                ) : (
                  <span class="pill tip">abandoned fork</span>
                )}
                <span class="fork-total">{fork.totalMessages} msg</span>
              </div>
              {fork.participants.length === 0 ? (
                <div class="empty">No application messages on this branch.</div>
              ) : (
                <table class="heads">
                  <thead>
                    <tr>
                      <th>member</th>
                      <th>last epoch on fork</th>
                      <th>messages</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fork.participants.map((p) => (
                      <tr>
                        <td>
                          <Author pubkey={p.pubkey} nameFor={nameFor} />
                        </td>
                        <td>
                          {p.lastEpoch}
                          {p.lastEpoch === fork.epoch ? (
                            <span class="pill canon caught-up">caught up</span>
                          ) : (
                            <span class="pill behind">
                              {fork.epoch - p.lastEpoch} behind
                            </span>
                          )}
                        </td>
                        <td>{p.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))
        )}
      </section>

      <section class="panel">
        <h2>
          Pending events
          {pending.length > 0 ? (
            <span class="pill danger">{pending.length} undecrypted</span>
          ) : (
            <span class="pill tip">none</span>
          )}
        </h2>
        <p class="hint">
          Kind-445 group events received from relays (and the durable archive)
          that have <strong>not</strong> yet decrypted/processed into the fork
          tree above — the engine's ingestion pool. They are retried as the tree
          grows, so this is normally empty. Events created before the server was
          invited (above the marker) predate our membership and can never be
          decrypted; anything else that lingers points at a decode/convergence
          bug. <strong>created</strong> is the sender's timestamp;{" "}
          <strong>received</strong> is when this server first saw the event, and
          <strong> Δ</strong> the gap between them.
        </p>
        {pending.length === 0 ? (
          <div class="empty">
            Every received event decrypted into the tree — no gaps.
          </div>
        ) : (
          <table class="heads pending">
            <thead>
              <tr>
                <th>event id</th>
                <th>created</th>
                <th>received</th>
                <th class="num">Δ</th>
              </tr>
            </thead>
            <tbody>{pendingRows}</tbody>
          </table>
        )}
      </section>
    </Layout>
  );
};
