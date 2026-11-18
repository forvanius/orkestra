# Closing a job — read when a trigger in Flow 8 holds

Run only the parts whose trigger holds. No trigger → skip, and write nothing about it on the board.

## Final review — 2+ parts wrote code
Parts can each be right and still not fit together. Once they are merged, one review of the whole job: `review_package.js <job dir> final <start> HEAD`, the reviewer from the vendor that wrote less of it, result `review-final.json`, pointed at Global constraints, Review focus and the `polish` items. Findings → one fix brief with the whole list, one scoped re-review, no second wave. What is left goes to the user with a Ruling.

## Smoke and present — the job changed something the user opens or runs
A screen, a page, a game scene, a CLI, a document or deck. A refactor, a config change or a library with tests has nothing to present: skip both and delete the board's Close section.

**Smoke.** Parts pass their own tests and still break the product. The board's Close section names one command that starts the real thing and walks its main path, exit 0 = pass. Write it at Plan, with the acceptance; if the repo has none, a `code` part writes it and is reviewed like any other. The verifier runs it once on the merged HEAD through `HEAVY RUNS`. Red → one fix brief to the writer of the failing part and one re-run; red again → the user, with the output. Record `cmd` and exit code in the Close section.

**Present.** The user closes the job by trying it, so hand over something to try, not a summary. The same verifier call:
- starts the product and captures the changed screens at desktop and mobile width into the job dir (documents and decks: the pages);
- writes `present.md` there: how to open it (one command or URL), 3–5 things to try taken from the acceptance list, what is known to be unfinished (`skipped`, open `polish`, Rulings).

Give the verifier the acceptance list and the open items in its brief; it cannot read your context. A preview deploy runs only if the repo's `AGENTS.md` names the command — publishing is the user's standing decision, never the conductor's.

Send `present.md` and the captures to the user unopened. What the user says back goes on the board under Decisions; anything about taste that will hold next time goes to `DESIGN.md` or `AGENTS.md`, so the next job starts closer.

Captures are not acceptance: a visual defect the user reports is a `visual-check` for the designer, then a fix part.
