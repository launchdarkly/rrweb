---
"rrweb": patch
---

Fix the stylesheet resync re-sending the wrong rules after the `insertRule` patch was displaced. It assumed missed rules were appended and re-sent the sheet's tail, but libraries that order rules by component (styled-components) insert mid-sheet, so replays got duplicated rules and lost the new ones. The resync now replaces the replayer's copy of any sheet whose rule count changed.
