/**
 * `EmbeddedReplayerClient` — runs in the PARENT page and drives an
 * `EmbeddedReplayerHost` living in an isolated iframe, over `postMessage`.
 *
 * It mirrors the subset of the `Replayer` API the viewer actually needs
 * (playback control + an `on(...)` event surface + cached getters), so callers
 * can treat it much like a local `Replayer` without any same-origin access to
 * the replay document.
 *
 * Peer authentication: the client identifies host messages by `event.source`
 * identity against the iframe's `contentWindow`. Source identity holds no
 * matter what origin the host document ends up on (it even survives the frame
 * navigating), so it is the robust check on this side of the boundary.
 */

import {
  isEnvelope,
  wrap,
  type HostCommand,
  type HostMessage,
  type ReplayAnchor,
  type SerializableReplayerConfig,
} from './protocol';
import type {
  eventWithTime,
  playerMetaData,
  SessionInterval,
} from '@rrweb/types';

export interface EmbeddedReplayerClientOptions {
  /**
   * Target origin used when posting to the iframe. Pass the dedicated host
   * origin (e.g. the origin `buildHostDocument`'s shell is served from) so
   * replay data can only be delivered to the document it is meant for. The
   * default is "*", which works before the host origin is known; only replay
   * data — never app secrets — is ever posted over this channel.
   */
  hostOrigin?: string;
}

type Listener = (payload?: unknown) => void;

/** Rendered geometry of the replay wrapper, as measured in the host realm. */
export interface ReplayDimensions {
  width: number;
  height: number;
  top: number;
  left: number;
}

export class EmbeddedReplayerClient {
  private readonly iframe: HTMLIFrameElement;
  private readonly hostOrigin: string;

  private readonly listeners = new Map<string, Set<Listener>>();

  private metadata: playerMetaData | null = null;
  private activityIntervals: SessionInterval[] = [];
  private dimensions: ReplayDimensions | null = null;
  private lastCurrentTime = 0;
  private ready = false;
  private readyResolvers: Array<() => void> = [];
  private disposed = false;
  /**
   * Commands issued before the host handshakes. A command posted while the
   * iframe is still on its initial `about:blank` (which carries the PARENT's
   * origin) is rejected by the browser as an origin mismatch and lost — the
   * viewer calls `setLayout` on mount, well before the host boots. Buffer until
   * `ready`, then flush; by then the frame is on the host origin.
   */
  private pending: HostCommand[] = [];

  constructor(
    iframe: HTMLIFrameElement,
    options: EmbeddedReplayerClientOptions = {},
  ) {
    this.iframe = iframe;
    this.hostOrigin = options.hostOrigin ?? '*';
    window.addEventListener('message', this.onMessage);
    // If the host booted before this client attached (e.g. a client re-created
    // on a long-lived iframe), its one-shot `ready` announcement is gone —
    // probe so it re-announces. Harmless when the iframe hasn't loaded yet:
    // the message lands on the placeholder document, which has no listener, and
    // the host's own boot-time `ready` arrives later.
    //
    // Targeted at "*" rather than hostOrigin on purpose: a freshly created
    // iframe is still on its initial about:blank document, which carries the
    // PARENT's origin, so a hostOrigin-targeted post would be refused and
    // logged as a console error on every attach. The probe carries no data
    // beyond its own type, so it is safe to leave the target open.
    this.probe();
  }

  /** Resolves once the host iframe has loaded and announced readiness. */
  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => this.readyResolvers.push(resolve));
  }

  /* --- commands --------------------------------------------------------- */

  init(
    events: eventWithTime[],
    config?: SerializableReplayerConfig,
    autoplay = false,
  ): void {
    this.send({ type: 'init', events, config, autoplay });
  }

  play(timeOffset?: number): void {
    this.send({ type: 'play', timeOffset });
  }

  pause(timeOffset?: number): void {
    this.send({ type: 'pause', timeOffset });
  }

  resume(timeOffset?: number): void {
    this.send({ type: 'resume', timeOffset });
  }

  setConfig(config: SerializableReplayerConfig): void {
    this.send({ type: 'setConfig', config });
  }

  /**
   * Scale and position the replay. Compute `scale` from your own container size
   * and the recorded viewport, as you would when driving a local `Replayer`;
   * the host applies it, since the wrapper element is not reachable from here.
   * The layout is retained across re-inits.
   */
  setLayout(scale: number, anchor?: ReplayAnchor): void {
    this.send({ type: 'setLayout', scale, anchor });
  }

  replaceEvents(events: eventWithTime[]): void {
    this.send({ type: 'replaceEvents', events });
  }

  addEvent(event: eventWithTime): void {
    this.send({ type: 'addEvent', event });
  }

  enableInteract(): void {
    this.send({ type: 'enableInteract' });
  }

  disableInteract(): void {
    this.send({ type: 'disableInteract' });
  }

  /** Tear down: destroys the host replayer and detaches the listener. */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.send({ type: 'destroy' });
    } finally {
      window.removeEventListener('message', this.onMessage);
      this.listeners.clear();
    }
  }

  /* --- event surface ---------------------------------------------------- */

  on(event: string, listener: Listener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  /* --- getters ---------------------------------------------------------- */

  // Cached getters mirroring the local Replayer's synchronous ones. Metadata
  // and activity intervals arrive on `initialized` (re-sent on replaceEvents);
  // current time is streamed by the host while playing.

  /** Last-known current time (pushed by the host while playing). */
  getCurrentTime(): number {
    return this.lastCurrentTime;
  }

  getMetaData(): playerMetaData | null {
    return this.metadata;
  }

  getActivityIntervals(): SessionInterval[] {
    return this.activityIntervals;
  }

  /**
   * Rendered geometry of the replay, in the host document's coordinate space —
   * the cross-origin stand-in for `replayer.wrapper.getBoundingClientRect()`.
   * Null until the host has reported it (listen for `'dimensions'`).
   */
  getDimensions(): ReplayDimensions | null {
    return this.dimensions;
  }

  /* --- internals -------------------------------------------------------- */

  private send(command: HostCommand): void {
    // Hold commands until the host is ready (see `pending`), so they aren't
    // posted at the host origin while the frame is still on about:blank.
    if (!this.ready) {
      this.pending.push(command);
      return;
    }
    this.postToHost(command);
  }

  private postToHost(command: HostCommand): void {
    const target = this.iframe.contentWindow;
    if (!target) return;
    target.postMessage(wrap(command), this.hostOrigin);
  }

  private flushPending(): void {
    const queued = this.pending;
    this.pending = [];
    queued.forEach((command) => this.postToHost(command));
  }

  /** Data-free handshake probe; see the note in the constructor. */
  private probe(): void {
    this.iframe.contentWindow?.postMessage(wrap({ type: 'ping' }), '*');
  }

  private onMessage = (event: MessageEvent): void => {
    if (event.source !== this.iframe.contentWindow) return;
    if (!isEnvelope<HostMessage>(event.data)) return;
    this.handle(event.data.message);
  };

  private handle(message: HostMessage): void {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.flushPending(); // deliver commands buffered before the handshake
        this.readyResolvers.forEach((r) => r());
        this.readyResolvers = [];
        return;
      case 'initialized':
        this.metadata = message.metadata;
        this.activityIntervals = message.activityIntervals;
        this.emit('initialized', message.metadata);
        return;
      case 'replayer-event':
        this.emit(message.event, message.payload);
        return;
      case 'time':
        this.lastCurrentTime = message.currentTime;
        this.emit('time', message.currentTime);
        return;
      case 'dimensions':
        this.dimensions = {
          width: message.width,
          height: message.height,
          top: message.top,
          left: message.left,
        };
        this.emit('dimensions', this.dimensions);
        return;
      case 'error':
        this.emit('error', message.message);
        return;
    }
  }

  private emit(event: string, payload?: unknown): void {
    this.listeners.get(event)?.forEach((listener) => listener(payload));
  }
}
