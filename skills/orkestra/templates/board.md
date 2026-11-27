# Board: <job>

Single source of truth for this job — required in every orkestra job. Only the conductor edits it (≤1 line per agent report).
A new session reads this file first, then only the reports of open parts.

## Working mode (ask the user once, before the first brief; a project's usual preference is only the suggested answer)
- Mode:
`auto` = run to the end, stop only for decisions that change design direction. `checkpoints` = the user approves the plan; after each merged part, 2–3 lines of progress and the open decisions, then wait. `ask` = ask at every decision. A one-word reply ("go on") answers that question only; only the user changes the mode.

## Research (design note or 3+ parts depending on anything outside the repo — before the design note)
- Discovery:
- Summary:
- Decision:

Discovery: `ran (research.txt[, research-codex.txt])` or `skipped — <reason>`. Summary: 3–5 lines from research.txt (indent continuation lines); stale/unconfirmed facts the plan needs go to the user. Decision: `build | reuse <x> | adapt <x> — why`; once discovery ran, `board_check.js` refuses the board until it is filled.

## Design note (only for ambiguous jobs — needs user approval before any brief)
- Goal:
- Chosen approach:            Rejected alternative (one line):
- Out of scope:
- Acceptance (machine-checkable):
- Approved by user: no

## Global constraints (exact values that bind every part)
-

## Budget
- Estimate: claude_reads=<N>M conductor=<N>M time=<N>h

## Real-world test
- Where/how:
- Try-note:

## Review focus (failures the plan's tests don't cover but a user would hit, most likely first)
-

## Lane matrix
| Part | parallel? (yes / after: X) | write surface | domain | risk | role | model | reviewer | acceptance (command) |
|---|---|---|---|---|---|---|---|---|
| A |  |  |  |  |  |  |  |  |

Domain is code, design, debug, docs, data or research; design parts go to `orkestra:designer` (concept / spec / visual-check), research to `orkestra:researcher` (result: `research.txt` next to this board). Risk is low, medium or high; Haiku and the light Codex model take low-risk parts only.

## Consultation (design note, 3+ parts or critical work — before any brief)
- Consultation skipped (reason):

| Advisor | Point | Decision (accept/reject) | Why |
|---|---|---|---|
|  |  |  |  |

## Parts
| Part | owner | state (ready/running/in-review/blocked/merged) | files | acceptance | commit | evidence |
|---|---|---|---|---|---|---|
| A |  | ready |  |  |  |  |

Evidence: verifier result + `review=review-A.json` (the reviewer's result, next to this board). `node close_part.js board.md A --repo <repo> --review review-A.json --commit <sha>` gates the review, cherry-picks, marks A merged and checks it is on HEAD. For a no-code part use `node close_part.js board.md A --repo <repo> --no-code "<reason>"` (commit `none`, evidence `review=skip: <reason>`) and tell the user. `next_parts.js board.md` lists parts awaiting a review-round decision under `needs_decision`.

## Close (only when the job changes something the user opens or runs — otherwise delete this section)
- Smoke (one command on the merged HEAD, exit 0 = pass):
- Smoke result (cmd, exit):
- Presented: present.md + captures sent to the user: no

## Next session (fill in before a handoff)
- Still open from the original request (name it in every report to the user):
- Next action:
- Open decisions:
- Read first:

## Decisions and open questions
Decisions made for the user: `Ruling: what — why — cost if wrong`. Reads a decision rests on: `read: file — why`.
-

## Orkestra notes
- (lessons for the next version)
