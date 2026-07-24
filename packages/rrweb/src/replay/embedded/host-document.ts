/**
 * Builds the minimal HTML shell that hosts the embedded replayer inside the
 * sandboxed iframe.
 *
 * Intended usage (served-URL mode): serve this document at a static URL and
 * point an iframe at it with `sandbox="allow-scripts"` (NOTE: no
 * `allow-same-origin`). The sandbox attribute forces the document into an
 * opaque origin regardless of the URL it is served from, which is what makes it
 * cookieless and cross-site to the app — so escaped replay JS has no app
 * cookies, no same-origin API access, and no reach into the parent window. The
 * parent origin to trust is passed at runtime via the iframe's `parentOrigin`
 * query parameter, which the host bootstrap reads.
 *
 * The `<meta>` CSP below governs the realm the replayer ACTUALLY runs in (unlike
 * today's policy, which only covered the rebuilt-DOM child). `script-src` omits
 * `unsafe-eval`, which kills the `new Function(...)` canvas-deserializer path
 * (SEC-8885) even inside the sandbox — defense in depth on top of the origin
 * isolation itself.
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
