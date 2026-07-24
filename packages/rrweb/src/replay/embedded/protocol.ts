/**
 * Wire protocol for running the rrweb `Replayer` inside an isolated iframe and
 * driving it from a parent page over `postMessage`.
 *
 * Motivation (SEC-8885): today the `Replayer` runs in the host page and rebuilds
 * the recorded DOM downward into a child iframe. Canvas replay reconstructs
 * command arguments via `new window[rr_type](...)` in that host realm, so a
 * poisoned `Promise(Function("code"))` executes as first-party JS on the app
 * origin. Relocating the `Replayer` *into* a cookieless, cross-origin iframe
 * moves every bit of untrusted-data handling out of the privileged origin: even
 * if attacker JS runs, it runs somewhere with no app cookies, no same-origin API
 * access, and no reach into the parent window.
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
 *    client checks `event.source` identity against its iframe's `contentWindow`
 *    (a sandboxed opaque-origin iframe reports `event.origin === "null"`, so
 *    origin-string matching is not usable on the client side).
 */

import type { playerConfig } from '../../types';
import type { eventWithTime } from '@rrweb/types';

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
  | { type: 'init'; events: eventWithTime[]; config?: SerializableReplayerConfig; autoplay?: boolean }
  | { type: 'play'; timeOffset?: number }
  | { type: 'pause'; timeOffset?: number }
  | { type: 'resume'; timeOffset?: number }
  | { type: 'setConfig'; config: SerializableReplayerConfig }
  | { type: 'replaceEvents'; events: eventWithTime[] }
  | { type: 'addEvent'; event: eventWithTime }
  | { type: 'enableInteract' }
  | { type: 'disableInteract' }
  | { type: 'destroy' }
  | { type: 'request'; id: number; method: HostRequestMethod };

/** Getter RPCs the parent can await a reply to. */
export type HostRequestMethod =
  | 'getMetaData'
  | 'getCurrentTime'
  | 'getActivityIntervals';

/* -------------------------------------------------------------------------- */
/* Host -> Parent (events / telemetry / replies)                              */
/* -------------------------------------------------------------------------- */

export type HostMessage =
  /** Host script booted and the message listener is installed (pre-init). */
  | { type: 'ready' }
  /** `Replayer` constructed; carries its (serializable) metadata. */
  | { type: 'initialized'; metadata: PlayerMetaDataLike }
  /** A forwarded `Replayer` event (`replayer.on(...)`). Payload is optional and always plain data. */
  | { type: 'replayer-event'; event: string; payload?: SerializablePayload }
  /** Periodic current-time push while playing, so the parent scrubber can track without sync getters. */
  | { type: 'time'; currentTime: number }
  /** Reply to a `request` command. */
  | { type: 'response'; id: number; ok: true; data: SerializablePayload }
  | { type: 'response'; id: number; ok: false; error: string }
  /** Host-side failure surfaced for logging. */
  | { type: 'error'; message: string };

export type PlayerMetaDataLike = {
  startTime: number;
  endTime: number;
  totalTime: number;
};

/** Anything that survives structured clone; kept loose on purpose. */
export type SerializablePayload = unknown;

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
