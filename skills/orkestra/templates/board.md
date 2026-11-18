# Board: <job>

Single source of truth for this job — required in every orkestra job. Only the conductor edits it (≤1 line per agent report).
A new session reads this file first, then only the reports of open parts.

## Design note (only for ambiguous jobs — needs user approval before any brief)
- Goal:
- Chosen approach:            Rejected alternative (one line):
- Out of scope:
- Acceptance (machine-checkable):
- Approved by user: no

## Global constraints (exact values that bind every part)
-

## Review focus (failures the plan's tests don't cover but a user would hit, most likely first)
-

## Lane matrix
| Part | parallel? (yes / after: X) | write surface | domain | risk | role | model | reviewer | acceptance (command) |
|---|---|---|---|---|---|---|---|---|
| A |  |  |  |  |  |  |  |  |

Domain is code, design, debug, docs, data or research; design parts go to `orkestra:designer` (concept / spec / visual-check), research to `orkestra:researcher` (result: `research.md` next to this board). Risk is low, medium or high; Haiku and the light Codex model take low-risk parts only.

## Consultation (design note, 3+ parts or critical work — before any brief)
- Consultation skipped (reason):

| Advisor | Point | Decision (accept/reject) | Why |
|---|---|---|---|
|  |  |  |  |

## Parts
| Part | owner | state (ready/running/in-review/blocked/merged) | files | acceptance | commit | evidence |
|---|---|---|---|---|---|---|
| A |  | ready |  |  |  |  |

Evidence: verifier result + `review=review-A.json` (the reviewer's result, next to this board). `node close_part.js board.md A --repo <repo> --review review-A.json --commit <sha>` gates the review, cherry-picks, marks A merged and checks it is on HEAD. No code to review → `review=skip: <reason>`, and tell the user.

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
