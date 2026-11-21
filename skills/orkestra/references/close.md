# Closing a job — read when a trigger in Flow 8 holds

Run only the parts whose trigger holds. No trigger → skip, and write nothing about it on the board.

## Final review — 2+ parts wrote code
Once parts are merged, add a `final` integration part to the board so the package name matches a board part. Run `review_package.js <job dir> final <start> HEAD`. The vendor that wrote less reviews Global constraints, Review focus and the `polish` items in `review-final.json`. Findings → one Codex fix brief with the whole list and one scoped Claude re-review (`final-2`). What remains goes to the user with a Ruling. If the integration part writes no code, note the final review result on the board and close the part with `--no-code`.

## Smoke and present — the job changed something the user opens or runs
A screen, a page, a game scene, a CLI, a document or deck. A refactor, a config change or a library with tests has nothing to present: skip both and delete the board's Close section.

**Smoke.** Parts pass their own tests and still break the product. The board's Close section names one command that starts the real thing and walks its main path, exit 0 = pass. Write it at Plan with the acceptance. If the repo has none, a `code` part writes it and is reviewed like any other. Run it once on merged HEAD through `HEAVY RUNS`, by the verifier for short runs or by the conductor through `run_long.js` for runs >8 minutes. Red → one Codex fix brief for the failing part and one re-run. Red again → the user, with the output. Record `cmd` and exit code in Close.

**Present.** The user closes the job by trying it, so hand over something to try, not a summary. The same verifier call:
- starts the product and captures the changed screens at desktop and mobile width into the job dir (documents and decks: the pages);
- writes `present.md` there: how to open it (one command or URL), 3–5 things to try taken from the acceptance list, what is known to be unfinished (`skipped`, open `polish`, Rulings).

Give the verifier the acceptance list and the open items in its brief; it cannot read your context. A preview deploy runs only if the repo's `AGENTS.md` names the command — publishing is the user's standing decision, never the conductor's.

Send `present.md` and the captures to the user unopened. Record lasting taste choices in `DESIGN.md` or `AGENTS.md`.

## Real-world test

Use the agreed Where/how. Write a short Try-note in the board's Real-world test section and show it to the user. Say what to try, how to try it and what to report back. If the plan says none, leave the try-note empty. Record feedback under Decisions and add it as new board parts with acceptance.

Captures are not acceptance: a visual defect the user reports is a `visual-check` for the designer, then a fix part.
