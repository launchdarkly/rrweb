import { decode } from 'base64-arraybuffer';
import type { Replayer } from '../';
import type { CanvasArg, SerializedCanvasArg } from '@rrweb/types';

// TODO: add ability to wipe this list
type GLVarMap = Map<string, any[]>;
const webGLVarMap: Map<
  CanvasRenderingContext2D | WebGLRenderingContext | WebGL2RenderingContext,
  GLVarMap
> = new Map();
export function variableListFor(
  ctx:
    | CanvasRenderingContext2D
    | WebGLRenderingContext
    | WebGL2RenderingContext,
  ctor: string,
) {
  let contextMap = webGLVarMap.get(ctx);
  if (!contextMap) {
    contextMap = new Map();
    webGLVarMap.set(ctx, contextMap);
  }
  if (!contextMap.has(ctor)) {
    contextMap.set(ctor, []);
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return contextMap.get(ctor) as any[];
}

/**
 * The `rr_type` values that the canvas recorder rebuilds by calling a
 * constructor of that name — see `record/observers/canvas/serialize-args.ts`
 * for the matching serialization. A recording is untrusted input at replay
 * time, so `rr_type` is matched against this set rather than resolved as an
 * arbitrary global.
 */
const canvasArgConstructors = new Set([
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'DataView',
  'ImageData',
  // normally serialized as base64, but reachable in `args` form through
  // recordings made by older clients and through nested `DataView` args.
  'ArrayBuffer',
  // wraps nested args in recordings made by older clients — see the
  // `preloadAllImages` tests for the shape.
  'Array',
]);

export function isSerializedArg(arg: unknown): arg is SerializedCanvasArg {
  return Boolean(arg && typeof arg === 'object' && 'rr_type' in arg);
}

export function deserializeArg(
  imageMap: Replayer['imageMap'],
  ctx:
    | CanvasRenderingContext2D
    | WebGLRenderingContext
    | WebGL2RenderingContext
    | null,
  preload?: {
    isUnchanged: boolean;
  },
): (arg: CanvasArg) => Promise<any> {
  return async (arg: CanvasArg): Promise<any> => {
    if (arg && typeof arg === 'object' && 'rr_type' in arg) {
      if (preload) preload.isUnchanged = false;
      if (arg.rr_type === 'ImageBitmap' && 'args' in arg) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const args = await deserializeArg(imageMap, ctx, preload)(arg.args);
        // eslint-disable-next-line prefer-spread
        return await createImageBitmap.apply(null, args);
      } else if ('index' in arg) {
        if (preload || ctx === null) return arg; // we are preloading, ctx is unknown
        const { rr_type: name, index } = arg;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return variableListFor(ctx, name)[index];
      } else if ('args' in arg) {
        const { rr_type: name, args } = arg;
        if (!canvasArgConstructors.has(name)) {
          console.warn(
            `[replayer] refusing to construct canvas arg of unknown type: ${name}`,
          );
          return null;
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const ctor = window[name as keyof Window];

        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
        return new ctor(
          ...(await Promise.all(
            args.map(deserializeArg(imageMap, ctx, preload)),
          )),
        );
      } else if ('base64' in arg) {
        return decode(arg.base64);
      } else if ('src' in arg) {
        const image = imageMap.get(arg.src);
        if (image) {
          return image;
        } else {
          const image = new Image();
          image.src = arg.src;
          imageMap.set(arg.src, image);
          return image;
        }
      } else if ('data' in arg && arg.rr_type === 'Blob') {
        const blobContents = await Promise.all(
          arg.data.map(deserializeArg(imageMap, ctx, preload)),
        );
        const blob = new Blob(blobContents, {
          type: arg.type,
        });
        return blob;
      }
    } else if (Array.isArray(arg)) {
      const result = await Promise.all(
        arg.map(deserializeArg(imageMap, ctx, preload)),
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return result;
    }
    return arg;
  };
}
