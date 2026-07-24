/**
 * `EmbeddedReplayerHost` — runs INSIDE the isolated replay iframe.
 *
 * It receives the recorded events + a data-only config from the parent over
 * `postMessage`, constructs a normal rrweb `Replayer` in *this* realm (so all
 * untrusted-data handling — including canvas-argument deserialization — happens
 * here, not in the parent's privileged origin), forwards `Replayer` events back
 * to the parent, and applies playback commands.
 *
 * Security invariants (see ./protocol.ts):
 * - Only messages whose `event.origin` equals the trusted parent origin AND
 *   whose `event.source` is our parent window are acted on.
 * - Message content is only ever treated as data. Config is passed through
 *   `pickSerializableConfig`, so no function/DOM value from a message reaches
 *   the `Replayer`. Nothing is `eval`'d or constructed by name from a message.
 */

import { Replayer } from '../';
import { ReplayerEvents } from '@rrweb/types';
import type { eventWithTime } from '@rrweb/types';
import type { playerConfig } from '../../types';
import {
  isEnvelope,
  pickSerializableConfig,
  wrap,
  type HostCommand,
  type HostMessage,
  type HostRequestMethod,
} from './protocol';

export interface EmbeddedReplayerHostOptions {
  /**
   * The exact origin the parent page is served from (e.g.
   * "https://app.launchdarkly.com"). Messages from any other origin are
   * ignored. If omitted, it is read from the `parentOrigin` query parameter of
   * this iframe's URL; if that is also absent, the host pins the origin of the
   * first well-formed message it receives and warns.
   */
  expectedParentOrigin?: string;
  /** Element the `Replayer` renders into. Defaults to `document.body`. */
  root?: HTMLElement;
  /** Parent window to post back to. Defaults to `window.parent`. */
  parentWindow?: Window;
  /** How often (ms) to push current-time telemetry while playing. */
  timeUpdateIntervalMs?: number;
}

/** Events whose payload is small, plain data and useful to the parent UI. */
const PAYLOAD_EVENTS = new Set<string>([
  ReplayerEvents.Resize,
  ReplayerEvents.EventCast,
  ReplayerEvents.CustomEvent,
]);

export class EmbeddedReplayerHost {
  private readonly root: HTMLElement;
  private readonly parentWindow: Window;
  private readonly timeUpdateIntervalMs: number;
  private expectedParentOrigin: string | null;

  private replayer: Replayer | null = null;
  private playing = false;
  private rafHandle: number | null = null;
  private started = false;

  constructor(options: EmbeddedReplayerHostOptions = {}) {
    this.root = options.root ?? document.body;
    this.parentWindow = options.parentWindow ?? window.parent;
    this.timeUpdateIntervalMs = options.timeUpdateIntervalMs ?? 50;
    this.expectedParentOrigin =
      options.expectedParentOrigin ??
      new URLSearchParams(location.search).get('parentOrigin') ??
      null;
  }

  /** Install the message listener and announce readiness to the parent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    window.addEventListener('message', this.onMessage);
    this.post({ type: 'ready' });
  }

  /** Tear everything down (also invoked on a `destroy` command). */
  stop(): void {
    window.removeEventListener('message', this.onMessage);
    this.stopTimePump();
    this.replayer?.destroy();
    this.replayer = null;
    this.started = false;
  }

  private onMessage = (event: MessageEvent): void => {
    // Authenticate the peer before looking at anything else.
    if (event.source !== this.parentWindow) return;
    if (!isEnvelope<HostCommand>(event.data)) return;
    if (this.expectedParentOrigin === null) {
      // No pre-declared parent: trust-on-first-message, then pin.
      this.expectedParentOrigin = event.origin;
      console.warn(
        `[rrweb-embedded] pinning parent origin to "${event.origin}" (no parentOrigin provided)`,
      );
    } else if (event.origin !== this.expectedParentOrigin) {
      return;
    }

    try {
      this.handle(event.data.message);
    } catch (err) {
      this.post({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  private handle(command: HostCommand): void {
    switch (command.type) {
      case 'init':
        this.init(command.events, command.config, command.autoplay);
        return;
      case 'play':
        this.replayer?.play(command.timeOffset ?? 0);
        this.setPlaying(true);
        return;
      case 'pause':
        this.replayer?.pause(command.timeOffset);
        this.setPlaying(false);
        return;
      case 'resume':
        this.replayer?.resume(command.timeOffset ?? 0);
        this.setPlaying(true);
        return;
      case 'setConfig':
        this.replayer?.setConfig(pickSerializableConfig(command.config));
        return;
      case 'replaceEvents':
        this.replayer?.replaceEvents(command.events);
        return;
      case 'addEvent':
        this.replayer?.addEvent(command.event);
        return;
      case 'enableInteract':
        this.replayer?.enableInteract();
        return;
      case 'disableInteract':
        this.replayer?.disableInteract();
        return;
      case 'destroy':
        this.stop();
        return;
      case 'request':
        this.reply(command.id, command.method);
        return;
    }
  }

  private init(
    events: eventWithTime[],
    config: unknown,
    autoplay?: boolean,
  ): void {
    if (this.replayer) {
      this.replayer.destroy();
      this.stopTimePump();
    }

    // Data-only config from the parent, plus locally-owned, non-transferable
    // options (the render root and a logger) that never come off the wire.
    const replayerConfig: Partial<playerConfig> = {
      ...pickSerializableConfig(config),
      root: this.root,
    };

    this.replayer = new Replayer(events, replayerConfig);
    this.wireEvents(this.replayer);

    this.post({ type: 'initialized', metadata: this.replayer.getMetaData() });

    if (autoplay) {
      this.replayer.play(0);
      this.setPlaying(true);
    }
  }

  private wireEvents(replayer: Replayer): void {
    // Forward every Replayer event by name; attach a payload only for the
    // curated, plainly-serializable ones. A DataCloneError (non-cloneable
    // payload) degrades to a name-only forward rather than dropping the event.
    for (const name of Object.values(ReplayerEvents)) {
      replayer.on(name, (payload?: unknown) => {
        if (name === ReplayerEvents.Finish) this.setPlaying(false);
        const withPayload =
          PAYLOAD_EVENTS.has(name) && payload !== undefined
            ? { type: 'replayer-event' as const, event: name, payload }
            : { type: 'replayer-event' as const, event: name };
        try {
          this.post(withPayload);
        } catch {
          this.post({ type: 'replayer-event', event: name });
        }
      });
    }
  }

  private reply(id: number, method: HostRequestMethod): void {
    if (!this.replayer) {
      this.post({ type: 'response', id, ok: false, error: 'no replayer' });
      return;
    }
    try {
      let data: unknown;
      if (method === 'getMetaData') data = this.replayer.getMetaData();
      else if (method === 'getCurrentTime') data = this.replayer.getCurrentTime();
      else data = this.replayer.getActivityIntervals();
      this.post({ type: 'response', id, ok: true, data });
    } catch (err) {
      this.post({
        type: 'response',
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /* --- current-time telemetry ------------------------------------------- */

  private setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    if (playing) this.startTimePump();
    else this.stopTimePump();
  }

  private startTimePump(): void {
    if (this.rafHandle !== null) return;
    let last = 0;
    const tick = (now: number): void => {
      if (!this.playing || !this.replayer) return;
      if (now - last >= this.timeUpdateIntervalMs) {
        last = now;
        this.post({ type: 'time', currentTime: this.replayer.getCurrentTime() });
      }
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private stopTimePump(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  private post(message: HostMessage): void {
    // Target the known parent origin when we have it; fall back to "*" only
    // before the origin is pinned (the `ready` handshake). We never send app
    // secrets over this channel — only replay telemetry — so "*" is acceptable
    // for that single pre-pinning message.
    this.parentWindow.postMessage(wrap(message), this.expectedParentOrigin ?? '*');
  }
}

/**
 * Convenience bootstrap for the iframe entry module: construct a host and start
 * it. The host reads its trusted parent origin from the `parentOrigin` query
 * parameter unless one is passed explicitly.
 */
export function startEmbeddedReplayerHost(
  options?: EmbeddedReplayerHostOptions,
): EmbeddedReplayerHost {
  const host = new EmbeddedReplayerHost(options);
  host.start();
  return host;
}
