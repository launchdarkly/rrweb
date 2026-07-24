---
"rrweb": minor
---

Add origin-isolated embedded replay (SEC-8885). New `EmbeddedReplayerHost` /
`startEmbeddedReplayerHost` run the `Replayer` inside a sandboxed, cookieless,
cross-origin iframe; `EmbeddedReplayerClient` drives it from the parent over a
typed, origin-authenticated `postMessage` bridge that only ever transfers data
(never functions/DOM, never `eval`). `buildHostDocument` emits the sandbox HTML
shell with a `<meta>` CSP whose `script-src` omits `unsafe-eval`. This relocates
all untrusted replay-data handling (including the canvas-argument deserializer)
out of the embedding app's privileged origin. Purely additive; existing
in-parent `Replayer` usage is unchanged.
