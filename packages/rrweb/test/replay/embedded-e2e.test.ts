/**
 * End-to-end coverage for the optional origin-isolated embedded replayer: boots
 * a real `EmbeddedReplayerHost` (and `Replayer`) inside a sandboxed cross-origin
 * iframe and drives it from a parent page on a different origin with a real
 * `EmbeddedReplayerClient` over `postMessage`.
 *
 * Deployment-shape note: the host runs with
 * `sandbox="allow-scripts allow-same-origin"` on a DEDICATED origin (here: a
 * second localhost port). `allow-same-origin` is required — without it the
 * host document gets an opaque origin, its nested browsing contexts inherit
 * the sandbox flags and land in fresh opaque origins of their own, and the
 * `Replayer`'s rebuild iframe becomes unreachable (`contentDocument` is null),
 * so replay cannot work at all. Isolation comes from the host origin being
 * cross-site to the app, not from origin opacity.
 */
import * as fs from 'fs';
import * as path from 'path';
import type * as puppeteer from 'puppeteer';
import { vi } from 'vitest';
import { startServer, getServerURL, launchPuppeteer, ISuite } from '../utils';
import rawEvents from '../events/hover';

describe('embedded replayer e2e', function (this: ISuite) {
  vi.setConfig({ testTimeout: 30_000 });

  let code: ISuite['code'];
  let browser: ISuite['browser'];
  let parentServer: ISuite['server'];
  let hostServer: ISuite['server'];
  let parentServerURL: string;
  let hostServerURL: string;
  let page: puppeteer.Page;

  // Stretch the fixture (~155ms) so playback runs long enough to observe the
  // current-time telemetry stream across several pump ticks.
  const events = rawEvents.map((e) => ({ ...e, timestamp: e.timestamp * 30 }));
  const eventsJson = JSON.stringify(events);

  beforeAll(async () => {
    // Two servers on different ports = two origins, so the host iframe is
    // genuinely cross-origin to the parent page, like the real deployment.
    parentServer = await startServer();
    hostServer = await startServer(3031);
    parentServerURL = getServerURL(parentServer);
    hostServerURL = getServerURL(hostServer);
    browser = await launchPuppeteer();
    const bundlePath = path.resolve(__dirname, '../../dist/rrweb.umd.cjs');
    code = fs.readFileSync(bundlePath, 'utf8');
  });

  afterEach(async () => {
    await page?.close();
  });

  afterAll(async () => {
    await browser.close();
    parentServer.close();
    hostServer.close();
  });

  /**
   * Load a parent page on origin A, embed the served host page from origin B
   * in a sandboxed iframe, and attach a client. Leaves `__client`, `__iframe`,
   * `__received`, and `__eventsJson` on the parent window for tests to drive.
   */
  async function bootEmbedded(): Promise<void> {
    page = await browser.newPage();
    await page.goto(`${parentServerURL}/html/`);
    await page.setContent(
      `<!DOCTYPE html><html><body><script>${code}</script></body></html>`,
    );
    await page.evaluate(
      (hostPageURL, evJson) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const w = window as any;
        w.__eventsJson = evJson;
        const iframe = document.createElement('iframe');
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        iframe.src =
          hostPageURL + '?parentOrigin=' + encodeURIComponent(location.origin);
        document.body.appendChild(iframe);
        w.__iframe = iframe;

        const received = {
          initializedCount: 0,
          metadata: null as unknown,
          times: [] as number[],
          replayerEvents: [] as string[],
          errors: [] as string[],
        };
        w.__received = received;

        const client = new w.rrweb.EmbeddedReplayerClient(iframe, {
          hostOrigin: new URL(hostPageURL).origin,
        });
        w.__client = client;
        client.on('initialized', (m: unknown) => {
          received.initializedCount += 1;
          received.metadata = m;
        });
        client.on('time', (t: number) => received.times.push(t));
        client.on('fullsnapshot-rebuilded', () =>
          received.replayerEvents.push('fullsnapshot-rebuilded'),
        );
        client.on('error', (message: string) => received.errors.push(message));
        /* eslint-enable @typescript-eslint/no-explicit-any */
      },
      `${hostServerURL}/html/embedded-host.html`,
      eventsJson,
    );
    // The host announces `ready` once the served host page boots.
    const ready = await page.evaluate(`
      Promise.race([
        window.__client.whenReady().then(() => 'ready'),
        new Promise((resolve) => setTimeout(() => resolve('timed out'), 15000)),
      ])
    `);
    if (ready !== 'ready') {
      throw new Error('embedded host never announced ready');
    }
  }

  it('completes the ready handshake, builds the replay cross-origin, and reports metadata', async () => {
    await bootEmbedded();

    const crossOriginBlocked = await page.evaluate(
      'window.__iframe.contentDocument === null',
    );
    // The parent must NOT be able to reach into the host document — removing
    // that reachability is the point of the isolation.
    expect(crossOriginBlocked).toBe(true);

    await page.evaluate(
      'window.__client.init(JSON.parse(window.__eventsJson), {}, false)',
    );
    await page.waitForFunction('window.__received.initializedCount > 0');
    await page.waitForFunction(
      'window.__received.replayerEvents.includes("fullsnapshot-rebuilded")',
    );

    const errors = (await page.evaluate(
      'window.__received.errors',
    )) as string[];
    expect(errors).toEqual([]);

    const metadata = (await page.evaluate('window.__received.metadata')) as {
      totalTime: number;
    };
    expect(metadata.totalTime).toBeGreaterThan(0);
    const cachedMetadata = await page.evaluate('window.__client.getMetaData()');
    expect(cachedMetadata).toEqual(metadata);
  });

  it('streams time updates while playing, including after a re-init while already playing', async () => {
    await bootEmbedded();

    await page.evaluate(
      'window.__client.init(JSON.parse(window.__eventsJson), {}, false)',
    );
    await page.waitForFunction('window.__received.initializedCount > 0');

    await page.evaluate('window.__client.play(0)');
    await page.waitForFunction('window.__received.times.length >= 3');

    // Re-init while the previous replayer is still playing. The host must
    // reset its playing state so the autoplay below restarts the time pump —
    // regression test for the pump dying after re-init.
    const before = (await page.evaluate(
      'window.__received.times.length',
    )) as number;
    await page.evaluate(
      'window.__client.init(JSON.parse(window.__eventsJson), {}, true)',
    );
    await page.waitForFunction('window.__received.initializedCount >= 2');
    await page.waitForFunction(
      `window.__received.times.length >= ${before + 3}`,
      { timeout: 10_000 },
    );
  });

  it('resolves whenReady for a client attached after the host booted', async () => {
    await bootEmbedded();

    // The first client consumed the boot-time `ready`. A second client on the
    // same long-lived iframe must still hand-shake (via its construction ping)
    // instead of hanging forever — regression test for the missed-`ready` race.
    const result = await page.evaluate(`
      (() => {
        const c2 = new window.rrweb.EmbeddedReplayerClient(window.__iframe);
        return Promise.race([
          c2.whenReady().then(() => 'ready'),
          new Promise((resolve) => setTimeout(() => resolve('timed out'), 5000)),
        ]);
      })()
    `);
    expect(result).toBe('ready');
  });
});
