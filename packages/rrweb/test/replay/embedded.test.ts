// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isEnvelope,
  pickSerializableConfig,
  wrap,
  RRWEB_EMBEDDED_CHANNEL,
  RRWEB_EMBEDDED_PROTOCOL_VERSION,
  type HostMessage,
} from '../../src/replay/embedded/protocol';
import { EmbeddedReplayerClient } from '../../src/replay/embedded/client';
import { EmbeddedReplayerHost } from '../../src/replay/embedded/host';

describe('embedded replay protocol', () => {
  describe('isEnvelope', () => {
    it('accepts a well-formed envelope', () => {
      expect(isEnvelope(wrap({ type: 'ready' }))).toBe(true);
    });

    it('rejects wrong channel / version / shape', () => {
      expect(isEnvelope(null)).toBe(false);
      expect(isEnvelope({})).toBe(false);
      expect(
        isEnvelope({
          channel: 'other',
          version: 1,
          message: { type: 'ready' },
        }),
      ).toBe(false);
      expect(
        isEnvelope({
          channel: RRWEB_EMBEDDED_CHANNEL,
          version: 999,
          message: { type: 'ready' },
        }),
      ).toBe(false);
      // message without a string `type`
      expect(
        isEnvelope({
          channel: RRWEB_EMBEDDED_CHANNEL,
          version: RRWEB_EMBEDDED_PROTOCOL_VERSION,
          message: {},
        }),
      ).toBe(false);
    });
  });

  describe('pickSerializableConfig', () => {
    it('keeps allowlisted data keys', () => {
      const out = pickSerializableConfig({
        speed: 2,
        skipInactive: true,
        UNSAFE_replayCanvas: false,
        cspContent: "script-src 'none'",
      });
      expect(out).toEqual({
        speed: 2,
        skipInactive: true,
        UNSAFE_replayCanvas: false,
        cspContent: "script-src 'none'",
      });
    });

    it('drops functions, DOM-ish values, and unknown keys', () => {
      const out = pickSerializableConfig({
        speed: 1,
        root: { nodeType: 1 }, // not allowlisted -> dropped
        unpackFn: () => 'x', // function -> dropped
        logger: { log: () => undefined }, // not allowlisted -> dropped
        plugins: [() => undefined], // not allowlisted -> dropped
        somethingElse: 'nope', // unknown -> dropped
      });
      expect(out).toEqual({ speed: 1 });
      expect('root' in out).toBe(false);
      expect('unpackFn' in out).toBe(false);
    });

    it('returns {} for non-objects', () => {
      expect(pickSerializableConfig(undefined)).toEqual({});
      expect(pickSerializableConfig('nope')).toEqual({});
    });
  });
});

describe('EmbeddedReplayerClient', () => {
  afterEach(() => vi.restoreAllMocks());

  // iframe stand-in whose contentWindow is the real window, so the client's
  // `event.source === iframe.contentWindow` check passes for our synthetic events.
  function makeClient() {
    const iframe = { contentWindow: window } as unknown as HTMLIFrameElement;
    const posted: unknown[] = [];
    vi.spyOn(window, 'postMessage').mockImplementation((msg: unknown) => {
      posted.push(msg);
    });
    const client = new EmbeddedReplayerClient(iframe, { hostOrigin: '*' });
    return { client, posted };
  }

  function deliver(message: HostMessage, source: unknown = window) {
    const event = new MessageEvent('message', { data: wrap(message) });
    Object.defineProperty(event, 'source', { value: source });
    window.dispatchEvent(event);
  }

  it('probes the host with a ping on construction', () => {
    const { posted } = makeClient();
    // A client attached to an already-booted host missed the one-shot `ready`
    // announcement; the construction-time ping makes the host re-announce.
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      channel: RRWEB_EMBEDDED_CHANNEL,
      version: RRWEB_EMBEDDED_PROTOCOL_VERSION,
      message: { type: 'ping' },
    });
  });

  it('posts namespaced command envelopes', () => {
    const { client, posted } = makeClient();
    client.play(1234);
    expect(posted).toHaveLength(2); // [0] is the construction ping
    expect(posted[1]).toMatchObject({
      channel: RRWEB_EMBEDDED_CHANNEL,
      version: RRWEB_EMBEDDED_PROTOCOL_VERSION,
      message: { type: 'play', timeOffset: 1234 },
    });
  });

  it('sends layout intent, not styles, and defaults the anchor host-side', () => {
    const { client, posted } = makeClient();
    client.setLayout(0.5, 'top');
    expect(posted[1]).toMatchObject({
      message: { type: 'setLayout', scale: 0.5, anchor: 'top' },
    });

    // Anchor omitted: the host applies its own default rather than the client
    // inventing one, so both sides agree on exactly one default.
    client.setLayout(0.25);
    expect(posted[2]).toMatchObject({
      message: { type: 'setLayout', scale: 0.25 },
    });
    expect(
      (posted[2] as { message: Record<string, unknown> }).message.anchor,
    ).toBeUndefined();
  });

  it('caches reported dimensions and emits them', () => {
    const { client } = makeClient();
    expect(client.getDimensions()).toBeNull();
    const onDimensions = vi.fn();
    client.on('dimensions', onDimensions);

    deliver({
      type: 'dimensions',
      width: 452,
      height: 242,
      top: 119,
      left: 224,
    });

    expect(client.getDimensions()).toEqual({
      width: 452,
      height: 242,
      top: 119,
      left: 224,
    });
    expect(onDimensions).toHaveBeenCalledWith({
      width: 452,
      height: 242,
      top: 119,
      left: 224,
    });
  });

  it('resolves whenReady on the ready handshake', async () => {
    const { client } = makeClient();
    let resolved = false;
    const ready = client.whenReady().then(() => (resolved = true));
    expect(resolved).toBe(false);
    deliver({ type: 'ready' });
    await ready;
    expect(resolved).toBe(true);
  });

  it('forwards replayer events and time updates to on() listeners', () => {
    const { client } = makeClient();
    const onResize = vi.fn();
    const onTime = vi.fn();
    client.on('resize', onResize);
    client.on('time', onTime);

    deliver({
      type: 'replayer-event',
      event: 'resize',
      payload: { width: 800, height: 600 },
    });
    deliver({ type: 'time', currentTime: 4200 });

    expect(onResize).toHaveBeenCalledWith({ width: 800, height: 600 });
    expect(onTime).toHaveBeenCalledWith(4200);
    expect(client.getCurrentTime()).toBe(4200);
  });

  it('caches metadata and activity intervals from the initialized message', () => {
    const { client } = makeClient();
    expect(client.getMetaData()).toBeNull();
    expect(client.getActivityIntervals()).toEqual([]);

    deliver({
      type: 'initialized',
      metadata: { startTime: 0, endTime: 5000, totalTime: 5000 },
      activityIntervals: [
        { startTime: 0, endTime: 1000, duration: 1000, active: true },
      ],
    });

    expect(client.getMetaData()).toEqual({
      startTime: 0,
      endTime: 5000,
      totalTime: 5000,
    });
    expect(client.getActivityIntervals()).toHaveLength(1);
  });

  it('ignores messages from an untrusted source', () => {
    const { client } = makeClient();
    const onTime = vi.fn();
    client.on('time', onTime);
    // A message whose source is NOT the iframe's contentWindow must be ignored.
    deliver({ type: 'time', currentTime: 999 }, { fake: true });
    expect(onTime).not.toHaveBeenCalled();
    expect(client.getCurrentTime()).toBe(0);
  });
});

describe('EmbeddedReplayerHost', () => {
  const PARENT_ORIGIN = 'https://parent.example';

  // Stand-in for window.parent: captures what the host posts back.
  function makeHost() {
    const parentWindow = {
      postMessage: vi.fn(),
    } as unknown as Window;
    const host = new EmbeddedReplayerHost({
      expectedParentOrigin: PARENT_ORIGIN,
      parentWindow,
    });
    return {
      host,
      posted: parentWindow.postMessage as ReturnType<typeof vi.fn>,
      parentWindow,
    };
  }

  function deliverCommand(
    message: unknown,
    { origin = PARENT_ORIGIN, source }: { origin?: string; source: unknown },
  ) {
    const event = new MessageEvent('message', { data: wrap(message), origin });
    Object.defineProperty(event, 'source', { value: source });
    window.dispatchEvent(event);
  }

  it('announces ready on start and re-announces on ping', () => {
    const { host, posted, parentWindow } = makeHost();
    host.start();
    expect(posted).toHaveBeenCalledTimes(1);
    expect(posted.mock.calls[0][0]).toMatchObject({
      message: { type: 'ready' },
    });
    expect(posted.mock.calls[0][1]).toBe(PARENT_ORIGIN);

    // A late-attaching client probes with ping; the host must re-announce.
    deliverCommand({ type: 'ping' }, { source: parentWindow });
    expect(posted).toHaveBeenCalledTimes(2);
    expect(posted.mock.calls[1][0]).toMatchObject({
      message: { type: 'ready' },
    });
    host.stop();
  });

  it('ignores commands from the wrong origin', () => {
    const { host, posted, parentWindow } = makeHost();
    host.start();
    posted.mockClear();
    deliverCommand(
      { type: 'ping' },
      { origin: 'https://evil.example', source: parentWindow },
    );
    expect(posted).not.toHaveBeenCalled();
    host.stop();
  });

  it('ignores commands whose source is not the parent window', () => {
    const { host, posted } = makeHost();
    host.start();
    posted.mockClear();
    deliverCommand({ type: 'ping' }, { source: { fake: true } });
    expect(posted).not.toHaveBeenCalled();
    host.stop();
  });
});
