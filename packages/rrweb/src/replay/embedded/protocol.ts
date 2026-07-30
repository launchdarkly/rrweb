/**
 * Wire protocol for running the rrweb `Replayer` inside an isolated iframe and
 * driving it from a parent page over `postMessage`.
 *
 * Motivation: a recorded session is untrusted input, and by default the
 * `Replayer` runs in the embedding page's own realm — so the whole replay path
 * operates with the embedding origin's privileges. This opt-in mode lets an
 * embedder relocate the `Replayer` into a separate, cross-site origin instead,
 * where it has no app cookies, no same-origin access to app APIs, and no reach
 * into the parent window. Purely additive: in-parent `Replayer` usage is
 * unchanged, and embedders who do not opt in are unaffected.
 *
 * This module defines the messages exchanged across that boundary. Two rules are
 * load-bearing and MUST hold for the isolation to be worth anything:
 *
 * 1. Every payload is plain, structured-cloneable DATA. Neither side ever sends
 *    a function, and neither side ever `eval`s / constructs anything from a
 *    message. The host constructs a `Replayer` from event data; it never turns
 *    message content into code.
 * 2. Both sides authenticate their peer before acting on a message. The host
 *    checks `event.origin` against the parent origin it was told to trust; the
 *    client checks `event.source` identity against its iframe's
 *    `contentWindow`, which holds regardless of the origin the host document
 *    is served from.
 */

import type { playerConfig } from '../../types';
import type {
  eventWithTime,
  playerMetaData,
  SessionInterval,
} from '@rrweb/types';

/** Namespaces our traffic so unrelated `postMessage` chatter is ignored. */
export const RRWEB_EMBEDDED_CHANNEL = 'rrweb-embedded' as const;

/** Bump on any breaking change to the message shapes below. */
export const RRWEB_EMBEDDED_PROTOCOL_VERSION = 1 as const;

/**
 * The subset of `playerConfig` that is safe to send across the boundary: plain
 * data only. `root` (a DOM node), `unpackFn`/`logger` (functions) and `plugins`
 * (functions) are deliberately excluded — the host supplies those locally and
 * never accepts them from a message. Keep this list in sync with the type below.
 */
export const SERIALIZABLE_CONFIG_KEYS = [
  'speed',
  'maxSpeed',
  'loadTimeout',
  'skipInactive',
  'inactivePeriodThreshold',
  'showWarning',
  'showDebug',
  'blockClass',
  'liveMode',
  'insertStyleRules',
  'triggerFocus',
  'UNSAFE_replayCanvas',
  'cspContent',
  'pauseAnimation',
  'mouseTail',
  'useVirtualDom',
  'inactiveThreshold',
  'inactiveSkipTime',
] as const;

export type SerializableConfigKey = (typeof SERIALIZABLE_CONFIG_KEYS)[number];

/** Data-only config the parent may hand the host. */
export type SerializableReplayerConfig = Partial<
  Pick<playerConfig, SerializableConfigKey>
>;

/**
 * Copy only allowlisted, data-only keys off an untrusted config-shaped value.
 * Anything else (including functions and DOM nodes) is dropped.
 */
export function pickSerializableConfig(
  config: unknown,
): SerializableReplayerConfig {
  const out: Record<string, unknown> = {};
  if (config && typeof config === 'object') {
    for (const key of SERIALIZABLE_CONFIG_KEYS) {
      const value = (config as Record<string, unknown>)[key];
      if (value !== undefined && typeof value !== 'function') {
        out[key] = value;
      }
    }
  }
  return out as SerializableReplayerConfig;
}

/* -------------------------------------------------------------------------- */
/* Parent -> Host (commands)                                                  */
/* -------------------------------------------------------------------------- */

export type HostCommand =
  /**
   * Handshake probe. The host answers with `ready`. Sent by the client on
   * construction so that a client attached to an already-booted host (whose
   * one-shot `ready` announcement it missed) still resolves `whenReady()`.
   */
  | { type: 'ping' }
  | {
      type: 'init';
      events: eventWithTime[];
      config?: SerializableReplayerConfig;
      autoplay?: boolean;
    }
  | { type: 'play'; timeOffset?: number }
  | { type: 'pause'; timeOffset?: number }
  | { type: 'resume'; timeOffset?: number }
  | { type: 'setConfig'; config: SerializableReplayerConfig }
  | { type: 'replaceEvents'; events: eventWithTime[] }
  | { type: 'addEvent'; event: eventWithTime }
  | { type: 'enableInteract' }
  | { type: 'disableInteract' }
  | { type: 'destroy' };

/* -------------------------------------------------------------------------- */
/* Host -> Parent (events / telemetry / replies)                              */
/* -------------------------------------------------------------------------- */

export type HostMessage =
  /** Host script booted and the message listener is installed (pre-init). */
  | { type: 'ready' }
  /**
   * `Replayer` constructed (or its events replaced). Carries the stable getters
   * the viewer needs — metadata and activity intervals — so the parent reads
   * them from cache instead of pulling them synchronously across the boundary.
   */
  | {
      type: 'initialized';
      metadata: playerMetaData;
      activityIntervals: SessionInterval[];
    }
  /** A forwarded `Replayer` event (`replayer.on(...)`). Payload is optional and always plain data. */
  | { type: 'replayer-event'; event: string; payload?: unknown }
  /** Periodic current-time push while playing, so the parent scrubber can track without sync getters. */
  | { type: 'time'; currentTime: number }
  /** Host-side failure surfaced for logging. */
  | { type: 'error'; message: string };

/* -------------------------------------------------------------------------- */
/* Envelope + guards                                                          */
/* -------------------------------------------------------------------------- */

export interface Envelope<T> {
  channel: typeof RRWEB_EMBEDDED_CHANNEL;
  version: typeof RRWEB_EMBEDDED_PROTOCOL_VERSION;
  message: T;
}

export function wrap<T>(message: T): Envelope<T> {
  return {
    channel: RRWEB_EMBEDDED_CHANNEL,
    version: RRWEB_EMBEDDED_PROTOCOL_VERSION,
    message,
  };
}

/**
 * Validate that an arbitrary `postMessage` datum is one of our envelopes on the
 * expected protocol version. Does not trust the sender — callers must still
 * authenticate origin/source before acting.
 */
export function isEnvelope<T = unknown>(data: unknown): data is Envelope<T> {
  if (!data || typeof data !== 'object') return false;
  const e = data as Partial<Envelope<T>>;
  return (
    e.channel === RRWEB_EMBEDDED_CHANNEL &&
    e.version === RRWEB_EMBEDDED_PROTOCOL_VERSION &&
    !!e.message &&
    typeof e.message === 'object' &&
    typeof (e.message as { type?: unknown }).type === 'string'
  );
}
