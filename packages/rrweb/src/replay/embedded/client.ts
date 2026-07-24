/**
 * `EmbeddedReplayerClient` — runs in the PARENT page and drives an
 * `EmbeddedReplayerHost` living in an isolated iframe, over `postMessage`.
 *
 * It mirrors the subset of the `Replayer` API the viewer actually needs
 * (playback control + an `on(...)` event surface + async getters), so callers
 * can treat it much like a local `Replayer` without any same-origin access to
 * the replay document.
 *
 * Peer authentication: the client identifies host messages by `event.source`
 * identity against the iframe's `contentWindow`. A sandboxed opaque-origin
 * iframe reports `event.origin === "null"`, so origin-string matching is not
 * usable here — source identity is the reliable check.
 */

import {
  isEnvelope,
  wrap,
  type HostCommand,
  type HostMessage,
  type HostRequestMethod,
  type PlayerMetaDataLike,
  type SerializableReplayerConfig,
} from './protocol';
import type { eventWithTime } from '@rrweb/types';

export interface EmbeddedReplayerClientOptions {
  /**
   * Target origin used when posting to the iframe. For a sandboxed
   * opaque-origin host this must be "*" (an opaque frame's origin is "null",
   * which cannot be named as a targetOrigin). Only replay data — never app
   * secrets — is ever posted, so "*" is acceptable. When the host is served
   * from a dedicated named origin, pass that origin for a tighter target.
   */
  hostOrigin?: string;
}

type Listener = (payload?: unknown) => void;

export class EmbeddedReplayerClient {
  private readonly iframe: HTMLIFrameElement;
  private readonly hostOrigin: string;

  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private nextRequestId = 1;

  private metadata: PlayerMetaDataLike | null = null;
  private lastCurrentTime = 0;
  private ready = false;
  private readyResolvers: Array<() => void> = [];
  private disposed = false;

  constructor(iframe: HTMLIFrameElement, options: EmbeddedReplayerClientOptions = {}) {
    this.iframe = iframe;
    this.hostOrigin = options.hostOrigin ?? '*';
    window.addEventListener('message', this.onMessage);
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
      this.pending.forEach((p) => p.reject(new Error('client destroyed')));
      this.pending.clear();
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

  /** Best-effort last-known current time (pushed by the host while playing). */
  getCurrentTime(): number {
    return this.lastCurrentTime;
  }

  getMetaData(): Promise<PlayerMetaDataLike> {
    if (this.metadata) return Promise.resolve(this.metadata);
    return this.request('getMetaData') as Promise<PlayerMetaDataLike>;
  }

  getActivityIntervals(): Promise<unknown> {
    return this.request('getActivityIntervals');
  }

  requestCurrentTime(): Promise<number> {
    return this.request('getCurrentTime') as Promise<number>;
  }

  /* --- internals -------------------------------------------------------- */

  private request(method: HostRequestMethod): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type: 'request', id, method });
    });
  }

  private send(command: HostCommand): void {
    const target = this.iframe.contentWindow;
    if (!target) return;
    target.postMessage(wrap(command), this.hostOrigin);
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
        this.readyResolvers.forEach((r) => r());
        this.readyResolvers = [];
        return;
      case 'initialized':
        this.metadata = message.metadata;
        this.emit('initialized', message.metadata);
        return;
      case 'replayer-event':
        this.emit(message.event, message.payload);
        return;
      case 'time':
        this.lastCurrentTime = message.currentTime;
        this.emit('time', message.currentTime);
        return;
      case 'response': {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.data);
        else pending.reject(new Error(message.error));
        return;
      }
      case 'error':
        this.emit('error', message.message);
        return;
    }
  }

  private emit(event: string, payload?: unknown): void {
    this.listeners.get(event)?.forEach((listener) => listener(payload));
  }
}
