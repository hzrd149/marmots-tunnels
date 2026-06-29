import type { NostrEvent } from "applesauce-core/helpers/event";

import { createGroupEvent } from "@internet-privacy/marmot-ts/core";
import { createApplicationMessage } from "@internet-privacy/marmot-ts/mls";
import type {
  AuthenticationService,
  CiphersuiteImpl,
  ClientState,
} from "@internet-privacy/marmot-ts/mls";

/**
 * `createApplicationMessage` only reads `context.cipherSuite` and
 * `context.clientConfig`; it never invokes `authService`. This stub exists
 * solely to satisfy the {@link MlsContext} type for our application-message-only
 * send path and is never called.
 */
const UNUSED_AUTH_SERVICE: AuthenticationService = {
  validateCredential: async () => true,
};

/**
 * Encrypt `payload` as an MLS application message against a *specific epoch*
 * `state` (not the group's canonical state) and wrap it into a kind-445 group
 * event ready to publish. The event's MLS ciphertext and its outer
 * exporter-secret encryption both key off `state`, so only clients currently at
 * that epoch/fork can decrypt it.
 *
 * Returns the event plus the advanced state: encrypting consumes a
 * sender-ratchet generation, so `newState` carries the moved-forward secret
 * tree. The caller MUST persist `newState` and use it as the input for the next
 * send at this epoch — re-encrypting from the same generation would make every
 * client past the first reject the message as a ratchet replay.
 */
export async function encryptApplicationMessageAt(options: {
  ciphersuite: CiphersuiteImpl;
  state: ClientState;
  payload: Uint8Array;
}): Promise<{ event: NostrEvent; newState: ClientState }> {
  const { ciphersuite, state, payload } = options;
  const { newState, message } = await createApplicationMessage({
    context: {
      cipherSuite: ciphersuite,
      authService: UNUSED_AUTH_SERVICE,
      externalPsks: {},
    },
    state,
    message: payload,
  });
  const event = await createGroupEvent({ message, state, ciphersuite });
  return { event, newState };
}
