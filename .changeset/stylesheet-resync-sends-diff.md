---
"rrweb": patch
---

Make the stylesheet resync send only what the replayer is missing. It used to replace the replayer's whole copy of any sheet whose rule count changed after the `insertRule` patch was displaced, so on pages that keep displacing the patch every growing sheet was re-sent in full on each resync. The recorder now tracks which rule objects the replayer holds and sends only the missed inserts and deletes, in the right positions, whether the library appends rules (emotion) or inserts them mid-sheet (styled-components).
