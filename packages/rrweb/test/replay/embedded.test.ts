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

describe('embedded replay protocol', () => {
  describe('isEnvelope', () => {
    it('accepts a well-formed envelope', () => {
      expect(isEnvelope(wrap({ type: 'ready' }))).toBe(true);
    });

    it('rejects wrong channel / version / shape', () => {
      expect(isEnvelope(null)).toBe(false);
      expect(isEnvelope({})).toBe(false);
      expect(
        isEnvelope({ channel: 'other', version: 1, message: { type: 'ready' } }),
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

  it('posts namespaced command envelopes', () => {
    const { client, posted } = makeClient();
    client.play(1234);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      channel: RRWEB_EMBEDDED_CHANNEL,
      version: RRWEB_EMBEDDED_PROTOCOL_VERSION,
      message: { type: 'play', timeOffset: 1234 },
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

  it('resolves RPC responses by id', async () => {
    const { client } = makeClient();
    const p = client.getActivityIntervals();
    deliver({ type: 'response', id: 1, ok: true, data: [{ start: 0 }] });
    await expect(p).resolves.toEqual([{ start: 0 }]);
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
