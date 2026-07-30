---
"rrweb": minor
---

Add optional origin-isolated embedded replay. New `EmbeddedReplayerHost` /
`startEmbeddedReplayerHost` run the `Replayer` inside a sandboxed iframe served
from a separate, cross-site origin, and `EmbeddedReplayerClient` drives it from
the parent page over a typed, origin-authenticated `postMessage` bridge that
only ever transfers plain data (never functions or DOM nodes).
`buildHostDocument` emits the HTML shell for that iframe, including a `<meta>`
CSP that names only the host bundle in `script-src` and omits `unsafe-eval`.
Embedders who adopt this run replay outside their own origin, so the replay path
has no app cookies, no same-origin access to app APIs, and no reach into the
embedding page. Opt-in and purely additive: existing in-parent `Replayer` usage
is unchanged.
