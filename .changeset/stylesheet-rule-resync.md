---
"rrweb": minor
---

Recover CSS rules when another script displaces the `insertRule` patch.

Everything a CSS-in-JS library (emotion, styled-components, goober) adds at
runtime reached the replayer only through the monkey patch on
`CSSStyleSheet.prototype.insertRule`, because the `<style>` elements they own hold
no text and so have no other copy of their contents beyond the `_cssText` taken
when the element was serialized. Any other script that reinstalls a previously
captured `insertRule` — a session replay vendor tearing its own recorder down, or
a second copy of rrweb bundled into the same app — unhooks us silently, and the
replay is then frozen with whatever CSS existed at snapshot time. A production
session was observed keeping 734 of 2929 emotion rules that way, which rendered a
MUI-heavy UI completely unstyled.

Recording now periodically checks that its patch still runs (by inserting into a
throwaway constructed stylesheet, since function identity cannot distinguish a
wrapper that still calls through from one that replaced us), reinstalls it over
whatever displaced it, and re-sends the rules the replayer is missing. Controlled
by the new `styleSheetResyncInterval` record option, in milliseconds; `0` disables
it, default `2000`. The emitted events are ordinary `StyleSheetRule` mutations, so
existing replayers need no changes.

Teardown no longer restores these CSSOM methods unconditionally: it only unwinds
its own layer, so stopping a recorder can no longer blind another script that
patched on top of it.
