import * as fs from 'fs';
import * as path from 'path';
import type * as puppeteer from 'puppeteer';
import { vi } from 'vitest';
import type { recordOptions } from '../../src/types';
import {
  listenerHandler,
  eventWithTime,
  EventType,
  IncrementalSource,
  styleSheetRuleData,
} from '@rrweb/types';
import { launchPuppeteer } from '../utils';

interface ISuite {
  code: string;
  browser: puppeteer.Browser;
  page: puppeteer.Page;
  events: eventWithTime[];
}

interface IWindow extends Window {
  rrweb: {
    record: (
      options: recordOptions<eventWithTime>,
    ) => listenerHandler | undefined;
  };
  emit: (e: eventWithTime) => undefined;
}

const setup = function (this: ISuite): ISuite {
  const ctx = {} as ISuite;

  beforeAll(async () => {
    ctx.browser = await launchPuppeteer();
    const bundlePath = path.resolve(__dirname, '../../dist/rrweb.umd.cjs');
    ctx.code = fs.readFileSync(bundlePath, 'utf8');
  });

  beforeEach(async () => {
    ctx.page = await ctx.browser.newPage();
    await ctx.page.goto('about:blank');
    await ctx.page.setContent('<!DOCTYPE html><html><body></body></html>');
    await ctx.page.evaluate(ctx.code);
    ctx.events = [];
    await ctx.page.exposeFunction('emit', (e: eventWithTime) => {
      if (e.type === EventType.DomContentLoaded || e.type === EventType.Load) {
        return;
      }
      ctx.events.push(e);
    });
    ctx.page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
  });

  afterEach(async () => {
    await ctx.page.close();
  });

  afterAll(async () => {
    await ctx.browser.close();
  });

  return ctx;
};

const addedRules = (events: eventWithTime[]) =>
  events
    .filter(
      (e) =>
        e.type === EventType.IncrementalSnapshot &&
        e.data.source === IncrementalSource.StyleSheetRule,
    )
    .flatMap((e) => (e.data as styleSheetRuleData).adds ?? [])
    .map((add) => add.rule);

/**
 * A CSS-in-JS library's `<style>` element holds no text, so the rules it writes
 * through `insertRule` only reach the replayer via our CSSOM patch. Other
 * scripts on the page patch the same methods and reinstall what they captured
 * when they tear down, which silently unhooks us -- so recording has to notice
 * and recover rather than trusting the patch to stay put.
 */
describe('stylesheet resync', function (this: ISuite) {
  vi.setConfig({ testTimeout: 20_000 });

  const ctx: ISuite = setup.call(this);

  it('re-sends rules inserted while the insertRule patch was displaced', async () => {
    await ctx.page.evaluate(() => {
      const { record } = (window as unknown as IWindow).rrweb;
      // A third party script that loaded before us captures the pristine
      // implementation, the way Hotjar and friends do.
      const pristine = CSSStyleSheet.prototype.insertRule;

      record({
        emit: (window as unknown as IWindow).emit,
        styleSheetResyncInterval: 50,
      });

      const styleElement = document.createElement('style');
      document.head.appendChild(styleElement);
      const sheet = styleElement.sheet as CSSStyleSheet;

      // Let the element get serialized and a healthy resync tick run, so the
      // recorder has a known starting point for this sheet.
      setTimeout(() => {
        // ...and now the third party tears down, restoring what it captured and
        // dropping our patch on the floor.
        CSSStyleSheet.prototype.insertRule = pristine;
        sheet.insertRule('body { color: rgb(1, 2, 3); }', 0);
      }, 200);
    });

    await ctx.page.waitForTimeout(600);

    expect(addedRules(ctx.events)).toContain('body { color: rgb(1, 2, 3); }');
  });

  it('records rules again once the patch has been reinstated', async () => {
    await ctx.page.evaluate(() => {
      const { record } = (window as unknown as IWindow).rrweb;
      const pristine = CSSStyleSheet.prototype.insertRule;

      record({
        emit: (window as unknown as IWindow).emit,
        styleSheetResyncInterval: 50,
      });

      const styleElement = document.createElement('style');
      document.head.appendChild(styleElement);
      const sheet = styleElement.sheet as CSSStyleSheet;

      setTimeout(() => {
        CSSStyleSheet.prototype.insertRule = pristine;
      }, 200);
      // Long after the resync has had a chance to notice and repatch.
      setTimeout(() => {
        sheet.insertRule('body { color: rgb(4, 5, 6); }', 0);
      }, 450);
    });

    await ctx.page.waitForTimeout(700);

    expect(addedRules(ctx.events)).toContain('body { color: rgb(4, 5, 6); }');
  });

  it('leaves the recording alone when nothing displaces the patch', async () => {
    await ctx.page.evaluate(() => {
      const { record } = (window as unknown as IWindow).rrweb;
      record({
        emit: (window as unknown as IWindow).emit,
        styleSheetResyncInterval: 50,
      });

      const styleElement = document.createElement('style');
      document.head.appendChild(styleElement);
      const sheet = styleElement.sheet as CSSStyleSheet;
      setTimeout(() => {
        sheet.insertRule('body { color: rgb(7, 8, 9); }', 0);
      }, 200);
    });

    await ctx.page.waitForTimeout(600);

    // Exactly once: reported by the patch, not duplicated by the resync.
    expect(
      addedRules(ctx.events).filter(
        (rule) => rule === 'body { color: rgb(7, 8, 9); }',
      ),
    ).toHaveLength(1);
  });

  it('does not discard another script"s patch when recording stops', async () => {
    const result = await ctx.page.evaluate(() => {
      const { record } = (window as unknown as IWindow).rrweb;
      const native = CSSStyleSheet.prototype.insertRule;

      const stop = record({
        emit: (window as unknown as IWindow).emit,
        styleSheetResyncInterval: 0,
      });

      // A script that loads after us wraps our patch, so it depends on us
      // leaving the prototype alone unless we are still the installed layer.
      const ours = CSSStyleSheet.prototype.insertRule;
      const theirs = function (
        this: CSSStyleSheet,
        rule: string,
        index?: number,
      ) {
        return ours.apply(this, [rule, index] as [string, number | undefined]);
      };
      CSSStyleSheet.prototype.insertRule = theirs;

      stop?.();

      return {
        theirPatchSurvived: CSSStyleSheet.prototype.insertRule === theirs,
        restoredToNative: CSSStyleSheet.prototype.insertRule === native,
      };
    });

    expect(result.theirPatchSurvived).toBe(true);
    expect(result.restoredToNative).toBe(false);
  });

  it('still restores the native methods when it is the only patch', async () => {
    const result = await ctx.page.evaluate(() => {
      const { record } = (window as unknown as IWindow).rrweb;
      const native = CSSStyleSheet.prototype.insertRule;
      const nativeDelete = CSSStyleSheet.prototype.deleteRule;

      const stop = record({
        emit: (window as unknown as IWindow).emit,
        styleSheetResyncInterval: 0,
      });
      const patched = CSSStyleSheet.prototype.insertRule !== native;
      stop?.();

      return {
        patched,
        insertRestored: CSSStyleSheet.prototype.insertRule === native,
        deleteRestored: CSSStyleSheet.prototype.deleteRule === nativeDelete,
      };
    });

    expect(result.patched).toBe(true);
    expect(result.insertRestored).toBe(true);
    expect(result.deleteRestored).toBe(true);
  });
});
