// Track pending image loads per context to allow cancellation
const pendingImageLoads = new Map<
  CanvasRenderingContext2D,
  { cancelled: boolean }
>();

// Track which contexts have been wrapped
const wrappedContexts = new WeakSet<CanvasRenderingContext2D>();

function isHTMLImageElement(img: unknown): img is HTMLImageElement {
  return (
    img !== null &&
    typeof img === 'object' &&
    'complete' in img &&
    'naturalWidth' in img &&
    'naturalHeight' in img &&
    'src' in img &&
    'onload' in img
  );
}

/**
 * Wraps the drawImage method on a canvas context to track image loading
 * and cancel previous pending draws when a new one is called.
 * This prevents race conditions where an earlier drawImage with a slow-loading
 * image might overwrite a later drawImage that completed first.
 */
export function wrapCanvasContextDrawImage(
  ctx: CanvasRenderingContext2D,
): void {
  if (wrappedContexts.has(ctx)) {
    return; // Already wrapped
  }

  wrappedContexts.add(ctx);
  const originalDrawImage = ctx.drawImage.bind(ctx);

  // Override drawImage with our wrapper that handles image loading
  // Note: drawImage can accept string (dataURL) as first argument, but TypeScript types don't reflect this
  ctx.drawImage = function (
    image: CanvasImageSource | string,
    ...args: number[]
  ): void {
    // Cancel any pending image load for this context
    const pending = pendingImageLoads.get(ctx);
    if (pending) {
      pending.cancelled = true;
    }

    // Helper to draw the image with proper arguments
    const drawImageWithArgs = () => {
      // Use spread operator - drawImage accepts 2, 4, or 8 numeric arguments
      // If only 2 args provided (dx, dy), add width/height to use natural image dimensions
      if (args.length === 2 && isHTMLImageElement(image)) {
        args.push(image.naturalWidth || image.width, image.naturalHeight || image.height);
      }
      (originalDrawImage as any)(image, ...args);
    };

    // If the image is an HTMLImageElement and not yet loaded, wait for it
    // Strings (dataURLs) and other image sources don't need loading
    // Use property check instead of instanceof to work across iframes
    if (isHTMLImageElement(image) && !image.complete) {
      const loadState = { cancelled: false };
      pendingImageLoads.set(ctx, loadState);

      // Wait for image to load, but check if cancelled
      const onLoad = () => {
        if (!loadState.cancelled) {
          pendingImageLoads.delete(ctx);
          drawImageWithArgs();
        }
      };

      const onError = () => {
        if (!loadState.cancelled) {
          pendingImageLoads.delete(ctx);
          // Even if image fails to load, we should still try to draw it
          // to maintain consistency with original behavior
          try {
            drawImageWithArgs();
          } catch (e) {
            // Ignore errors from failed image loads
          }
        }
      };

      // Wait for load
      image.onload = onLoad;
      image.onerror = onError;
    } else {
      // Image is ready (not an HTMLImageElement or already loaded), draw immediately
      // Handle string (dataURL) and other image sources
      // Use spread operator - drawImage accepts 2, 4, or 8 numeric arguments
      drawImageWithArgs();
    }
  };
}

