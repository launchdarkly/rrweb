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
} from './protocol';

export interface EmbeddedReplayerHostOptions {
  /**
   * The exact origin the parent page is served from (e.g.
   * "https://app.launchdarkly.com"). Messages from any other origin are
   * ignored. If omitted, it is read from the `parentOrigin` query parameter of
   * this iframe's URL; if that is also absent, the host ignores all messages
   * (and warns once on start).
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
  private readonly expectedParentOrigin: string | null;

  private replayer: Replayer | null = null;
  private playing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
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
    if (this.expectedParentOrigin === null) {
      console.warn(
        '[rrweb-embedded] no parentOrigin configured; all incoming messages will be ignored',
      );
    }
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
    // Authenticate the peer before acting on anything.
    if (event.source !== this.parentWindow) return;
    if (this.expectedParentOrigin === null) return;
    if (event.origin !== this.expectedParentOrigin) return;
    if (!isEnvelope<HostCommand>(event.data)) return;

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
        if (this.replayer) {
          this.replayer.replaceEvents(command.events);
          this.postInitialized(); // metadata/intervals may have changed
        }
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
    this.postInitialized();

    if (autoplay) {
      this.replayer.play(0);
      this.setPlaying(true);
    }
  }

  /** Push the stable getters (metadata, activity intervals) to the parent. */
  private postInitialized(): void {
    if (!this.replayer) return;
    this.post({
      type: 'initialized',
      metadata: this.replayer.getMetaData(),
      activityIntervals: this.replayer.getActivityIntervals(),
    });
  }

  private wireEvents(replayer: Replayer): void {
    // Forward every Replayer event by name; attach a payload only for the
    // curated events whose payloads are plain, structured-cloneable data.
    for (const name of Object.values(ReplayerEvents)) {
      replayer.on(name, (payload?: unknown) => {
        if (name === ReplayerEvents.Finish) this.setPlaying(false);
        this.post(
          PAYLOAD_EVENTS.has(name) && payload !== undefined
            ? { type: 'replayer-event', event: name, payload }
            : { type: 'replayer-event', event: name },
        );
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
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      if (this.replayer) {
        this.post({
          type: 'time',
          currentTime: this.replayer.getCurrentTime(),
        });
      }
    }, this.timeUpdateIntervalMs);
  }

  private stopTimePump(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private post(message: HostMessage): void {
    // Target the known parent origin when we have it; fall back to "*" only
    // before the origin is pinned (the `ready` handshake). We never send app
    // secrets over this channel — only replay telemetry — so "*" is acceptable
    // for that single pre-pinning message.
    this.parentWindow.postMessage(
      wrap(message),
      this.expectedParentOrigin ?? '*',
    );
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
