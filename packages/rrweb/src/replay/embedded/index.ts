/**
 * Origin-isolated replay: run the rrweb `Replayer` inside a cookieless,
 * cross-origin (sandboxed opaque-origin) iframe and drive it from the parent
 * over `postMessage`. See ./protocol.ts for the rationale (SEC-8885).
 *
 * - `EmbeddedReplayerHost` / `startEmbeddedReplayerHost`: run inside the iframe.
 * - `EmbeddedReplayerClient`: run in the parent to control the host.
 * - `buildHostDocument`: HTML shell for the sandboxed iframe.
 */

export {
  EmbeddedReplayerHost,
  startEmbeddedReplayerHost,
  type EmbeddedReplayerHostOptions,
} from './host';
export {
  EmbeddedReplayerClient,
  type EmbeddedReplayerClientOptions,
} from './client';
export { buildHostDocument, type HostDocumentOptions } from './host-document';
export {
  RRWEB_EMBEDDED_CHANNEL,
  RRWEB_EMBEDDED_PROTOCOL_VERSION,
  SERIALIZABLE_CONFIG_KEYS,
  pickSerializableConfig,
  isEnvelope,
  wrap,
  type SerializableReplayerConfig,
  type SerializableConfigKey,
  type HostCommand,
  type HostMessage,
  type HostRequestMethod,
  type PlayerMetaDataLike,
  type Envelope,
} from './protocol';
