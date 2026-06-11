/**
 * @vitest-environment jsdom
 */
import { vi } from 'vitest';
import { polyfillWebGLGlobals } from '../utils';
polyfillWebGLGlobals();

import canvas2DMutation from '../../src/replay/canvas/2d';
import type { Replayer } from '../../src/replay';

let canvas: HTMLCanvasElement;
describe('canvas2DMutation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    canvas = document.createElement('canvas');
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('should execute all mutations after args are parsed', async () => {
    let resolve: (value: unknown) => void;
    const promise = new Promise((r) => {
      resolve = r;
    });
    // hold direct references: the fork wraps ctx.drawImage on first use
    // (wrapCanvasContextDrawImage), replacing the property with a wrapper
    const clearRectSpy = vi.fn();
    const drawImageSpy = vi.fn();
    const context = {
      clearRect: clearRectSpy,
      drawImage: drawImageSpy,
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(canvas, 'getContext').mockImplementation(() => {
      return context;
    });

    const createImageBitmapMock = vi.fn(() => {
      return new Promise((r) => {
        setTimeout(r, 1000);
      });
    });

    (global as any).createImageBitmap = createImageBitmapMock;

    const mutation = canvas2DMutation({
      event: {} as Parameters<Replayer['applyIncremental']>[0],
      mutations: [
        {
          property: 'clearRect',
          args: [0, 0, 1000, 1000],
        },
        {
          property: 'drawImage',
          args: [
            {
              rr_type: 'ImageBitmap',
              args: [],
            },
            0,
            0,
          ],
        },
      ],
      target: canvas,
      imageMap: new Map(),
      errorHandler: () => {},
    });

    await vi.advanceTimersByTimeAsync(100);

    await expect(createImageBitmapMock).toHaveBeenCalled();

    expect(clearRectSpy).not.toBeCalled();
    expect(drawImageSpy).not.toBeCalled();

    await vi.advanceTimersByTimeAsync(1000);

    await mutation;

    expect(clearRectSpy).toHaveBeenCalledWith(0, 0, 1000, 1000);
    expect(drawImageSpy).toHaveBeenCalled();
  });
});
