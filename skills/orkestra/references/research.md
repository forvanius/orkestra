# Discovery — read before Plan on a job with a design note or 3+ parts

A plan built on a stale fact, or a part that rebuilds what a maintained library already does, costs a whole part. Discovery answers before the plan is fixed: is it already done, how do others do it, what is current, what fits this project.

## Trigger
- Runs when the job needs a design note or has 3+ parts, **and** the plan depends on something outside the repo: a library, service, API or platform, or a feature comparable products already have.
- Skip only with a reason on the board: `- Discovery: skipped — <why>` (e.g. "internal refactor, no outside dependency"). When it ran: `- Discovery: ran (research.txt[, research-codex.txt])`. A bug fix or a narrow change skips without a line.
- A single outside fact on a smaller job keeps the short form: one researcher, ≤5 questions, `MODE: facts`.

## Questions (`MODE: discovery`, ≤8 questions, 25 min)
Always ask the first four, worded for the job; add up to four job-specific ones.
1. **Already done?** Libraries, services or open-source projects that solve this or a large piece of it.
2. **How do others do it?** How 2–3 comparable products or projects handle the same feature.
3. **Current state:** current version and API of what the plan would use; recent breaking changes or deprecations.
4. **Known problems:** open issues, limits, security notices for the candidates.

Name the project's constraints in the brief (from AGENTS.md: language, runtime, "no dependencies", licence limits, platform), so the researcher can fill the fit columns. Never the project's name or private paths: the researcher must not search with them.

## Result: the candidates table
The researcher writes `research.txt` with the answers and this table. It states facts only; it never picks.

| Candidate | What it covers | Latest release (date) | Licence | Maintained (last release or commit, from the repo's releases/commits page) | Fits our constraints? (each one: yes/no + why) | Source + date |
|---|---|---|---|---|---|---|

- **Excluded short form:** a candidate that fails a hard constraint (e.g. "no dependencies" rules out every npm package) gets one row with `excluded by <constraint>` in the fit column and only name, what it covers and source; list a whole group in one row when it shares the reason. Full rows are for candidates that pass the hard constraints.
- **Maintenance:** read it from the repo's releases or commits page. A registry "modified" date is only a proxy: label it `registry modified`.
- **Live pages:** a page that shows the current state and carries no date (a main-branch file, a registry entry, "latest" docs) gets `fetched YYYY-MM-DD`. It counts as current, not `unconfirmed`, for the fact it shows.
- **Stale:** a source older than 12 months is marked `stale`. In a fast-moving area (AI/LLM tools, browser and mobile platforms, cloud pricing) the researcher may note that 12 months is already too old.
- `unconfirmed` = a dated fact whose date could not be found, or only third-party posts say it. A stale or unconfirmed fact the plan rests on goes to the user before the plan is approved.

## Two vendors for critical work
For `high` risk work, or when the build-vs-reuse choice decides most of the job, run the same questions twice without either seeing the other: `orkestra:researcher` and Codex with live web search (`codex --search exec … -s read-only -o <job dir>/research-codex.txt - < brief`, guarded like every Codex call; `--search` goes before `exec`, after it Codex exits with "unexpected argument"). Read-only Codex writes no file: its brief says "print research.txt as your final answer", and `-o` saves that answer. Its log shows each search as a `web search:` line. Where they disagree, write both on the board and say which source wins and why. Agreement from two vendors is the cheap check against a stale or wrong fact.

## After the result
- The conductor (not the researcher) decides build vs reuse and writes it on the board's **Research** section: 3–5 lines from the table, then `Decision: build | reuse <x> | adapt <x> — why`. Once Discovery says `ran`, `board_check.js` (and so every close) refuses an empty Decision. The design note's chosen approach and rejected alternative rest on it.
- Consultation reads the board, so advisors see the summary and may challenge the decision.
- Tell the user only what changes direction (e.g. "library X already does this — reuse instead of writing it"), unless the working mode is `ask`: then show the summary every time.
