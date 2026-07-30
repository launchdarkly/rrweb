/**
 * Builds the minimal HTML shell that hosts the embedded replayer inside the
 * sandboxed iframe.
 *
 * Intended usage: serve this document from a DEDICATED origin that is
 * cross-site to the embedding app (so it never receives app cookies), and
 * point an iframe at it with `sandbox="allow-scripts allow-same-origin"`. The
 * isolation comes from the origin boundary: everything the replayer does runs
 * with no app cookies, no same-origin access to app APIs, and no reach into the
 * parent window. The parent origin to trust is passed at runtime via the
 * iframe's `parentOrigin` query parameter, which the host bootstrap reads.
 *
 * `allow-same-origin` is REQUIRED, which is why an opaque-origin
 * (`allow-scripts`-only) deployment is not possible: nested browsing contexts
 * inherit the sandbox flags, so inside an opaque-origin document every child
 * iframe lands in a fresh opaque origin of its own and its `contentDocument`
 * is unreachable — and the `Replayer` rebuilds the recorded DOM into exactly
 * such a child iframe (see `createSandboxedIframe` in rrweb-snapshot).
 * Corollary: NEVER serve this document from the app's own origin — with
 * `allow-same-origin` the frame would then be same-origin with the app, which
 * removes the boundary this mode exists to create.
 *
 * The `<meta>` CSP below governs the realm the replayer itself runs in, not just
 * the rebuilt-DOM child document. `script-src` names only the host bundle and
 * omits `unsafe-eval`, so the replay realm loads no other script and compiles
 * no code from strings — defense in depth on top of the origin isolation.
 *
 * Integration notes:
 * - This package ships no prebuilt host bundle: `scriptUrl` must point at a
 *   consumer-built module that calls `startEmbeddedReplayerHost()`.
 * - Module scripts are CORS-gated: if `scriptUrl` is not same-origin with the
 *   host document, its server must send `Access-Control-Allow-Origin` for the
 *   host origin or the host silently never boots.
 */

export interface HostDocumentOptions {
  /** Absolute URL of the built host bundle (the module that calls `startEmbeddedReplayerHost`). */
  scriptUrl: string;
  /** Optional absolute URL of the rrweb replay stylesheet. */
  styleUrl?: string;
  /** Extra values appended to `style-src` (e.g. proxied stylesheet origins). */
  extraStyleSources?: string[];
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "'self'";
  }
}

export function buildHostDocument(options: HostDocumentOptions): string {
  const scriptOrigin = originOf(options.scriptUrl);
  const styleSources = [
    "'unsafe-inline'",
    scriptOrigin,
    ...(options.extraStyleSources ?? []),
  ].join(' ');

  // Strict where it counts (no script beyond our bundle, no eval, no workers,
  // no outbound connections), permissive for visual assets (fidelity).
  const csp = [
    `default-src 'none'`,
    `script-src ${scriptOrigin}`,
    `style-src ${styleSources}`,
    `img-src * data: blob:`,
    `font-src * data:`,
    `media-src * data: blob:`,
    `frame-src *`,
    `connect-src 'none'`,
    `worker-src 'none'`,
  ].join('; ');

  const styleTag = options.styleUrl
    ? `<link rel="stylesheet" href="${escapeAttr(options.styleUrl)}">`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#fff}</style>
${styleTag}
<script type="module" src="${escapeAttr(options.scriptUrl)}"></script>
</head>
<body></body>
</html>`;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
