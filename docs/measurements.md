# Measurements

Real runs that shaped the rules, measured with `skills/orkestra/usage_sum.js` (Claude) and the
Codex CLI's own token report. Projects are anonymized: **Project A** is a Godot game, **Project B**
is a single-file HTML/JS web game. "Reads" are cache-read input tokens; they dominate cost because
every call re-reads the whole context.

## Before orkestra: all-Claude orchestration (Project A, "wave 3")
- 1,623 Claude calls, 355 M cache reads. **Conductor (Opus) 57% (204 M)**, 15 Sonnet workers 43% (151 M). Opus costs more per token, so the conductor's share of money was even larger.
- Each conductor call re-read ~300–340 K context: it looked at ~25 images itself and did merging, testing and debugging itself.
- Sonnet: well-defined code took 28–47 calls; a visual capture–look–adjust loop took 85–134 calls (one HUD job alone: 33 M).
- 5 parallel Sonnet agents → the session limit was hit 3 times and 4 agents stopped mid-way (restart waste). → rule 6: at most 2–3 parallel Claude agents.
- Codex read-only review: 9 of 13 reviews found real bugs. Codex code writing: 3/3 finished without spending Claude quota. → rule 2: Codex writes first.
- The previous wave: ~920 calls, 222 M reads (conductor 114 M).

## First pilot with the current ensemble (Project A)
- Merge + filter tool + capture tool + a 17-frame enemy in-game: 197 Claude calls, 23.7 M reads. Conductor 59% (14 M; planning + showing images to the user), Sonnet 6.1 M, Haiku 1.9 M. All code, image generation and 4 reviews on Codex; 3 of the reviews found real bugs. **~15× cheaper than wave 3.**
- What worked: sending images to the user without the conductor opening them; giving mechanical runs to Haiku.
- Trap: the Codex sandbox may not run Python (it created a venv and left it in the repo) → the verifier runs tests.

## Small jobs (Project B)
- One file, ~95 lines + test + doc: Codex 2 writes + 1 review (~170 K Codex tokens), Haiku verifier 2 runs (9 calls, 0.6 M), ~9 min wall clock. The conductor session read 16.6 M, but most of it was earlier hand-work in the same session; the orchestra part was ~15 conductor calls. The review found a real framing bug; red/green was proven by reverting the patch in the verifier. **Lesson: switching to orkestra in a long hand-worked session doesn't lower conductor cost — start fresh.**
- One file, ~150 lines + test + doc, fresh session: Codex 1 write (high, 148 K) + 1 review (high, 108 K, APPROVE, its own mutation tests red), Haiku 8 calls 0.57 M; conductor 16 calls 1.74 M; 12 min, one round. **A fresh session made the conductor ~10× cheaper.** Lesson: don't ask for red evidence by running the *old* file when new scenarios depend on new hooks — let the Codex reviewer do mutation testing.

## Visual work (Project B)
- Style guide + 3 painted frames + 2 UI rounds + implementation + 3 reviews: no Claude agents; Codex 7 writes/images + 3 reviews. Conductor 123 calls, 17.2 M (mostly waiting notices between user turns). Capturing frames with Playwright and sending them without opening worked; the Codex sandbox couldn't open a browser or Python, so overflow checks ran as a conductor script. Reviews found 2 real bugs. Lesson: painted concept frames drift in scale — ask for "true proportions" in briefs.
- 3D models (13 GLB + binding + smoke): Codex 2 parallel writes (it ran Blender headless in its sandbox and produced GLBs/previews; it could not run the smoke test) + 1 review. Haiku 4 calls 0.19 M. File ownership (A: only the Blender script; B: script + loader + smoke) made parallel work clean. Trap: a CRLF working copy — preserve existing line endings when editing by script.
- Effects + enemy redesign + docs: Codex 5 writes + 1 review (REVISE, 2 real bugs). The verifier's smoke run caught 2 more real bugs. Lesson: geometry tests Codex writes without a browser often fail on first real run — never trust a PASS without the smoke run. 3 parallel Codex writers with file ownership: no conflicts.

## Long worker loops (Project B)
- Worker loops took 16–79 min (one smoke run 2.5–7 min). Causes: tests written without a browser failing first, a full smoke run on every fix, flaky timing checks, two sessions running smoke at once and saturating the CPU (11 headless Chromes, software GL). → Rules: ~25 min limit in every worker brief; in fix rounds run only the failing section; full smoke once before commit; smoke at low priority, ≤3 parallel sections.

## Why sessions ended early and routing collapsed (46 sessions, 2026-10-29 to 11-09)
- A +150 K handoff limit fired at 220–230 K of context, after about 80–135 conductor calls, often 1–2 user requests. Sessions had run to 734 K without compaction, so this was the cost rule, not a full window.
- Growth averaged 1.1–1.9 K per call. Calls with almost no text still added a median of 352 tokens. About half of the growth has no matching transcript text; hidden thinking didn't explain it (correlation 0.05).
- In 7 clean runs, 264 of 479 conductor shell calls were file, log or diff reads (~14% of growth).
- The first three calls add 7–14 K of tool lists and skill text before any work.
- The guard fired in 14 sessions that never loaded the skill: 7 on a path match such as `onboard.md`, 7 continuations whose handoff sentence didn't reload the skill.
- 673 Codex calls against 144 worker and 91 verifier runs. All 519 M Codex tokens on one model. The audit couldn't see background Codex tokens.
- → 0.2.0: limit +250 K (finish the current request) and +400 K (stop), `close_part.js`, routing table, `orkestra:reviewer`, Codex tokens read from Codex's own files.

## Not yet measured
- Adapted from ECC: machine-checkable acceptance + FORBIDDEN list (anti-Goodhart), evidence-backed VERDICT (`checks`/`skipped`), lane matrix, board file, REVISE ceiling, double review for critical work.
- Adapted from superpowers: brief-compliance review (`spec.missing/extra`, separate from code quality) and an approved design note for ambiguous jobs.
- 0.2.0: whether `orkestra:reviewer` (Sonnet) finds as many real bugs as Codex reviews did, and how many parts fit in a session under the new limit.
- 0.4.0, adapted from superpowers 7.0.2: a board in the repo, a final whole-job review, scoped re-reviews from a diff file, `cannot_verify`, Rulings, interfaces in briefs. Measure what final reviews find that per-part reviews missed, and what scoped re-reviews save.
- 0.5.0, from the user's own working split (Codex for the look, Claude for structure): a researcher role, the look of user-facing parts routed to Codex, a smoke run and a presentation at close — each only on its trigger. Not run on a real job yet. Measure how often each trigger fires, what the smoke run catches that part tests missed, and whether `present.md` shortens the user's closing check.
- 0.3.1: balance between cost and quality (risk before cost in routing, a handoff quality check, decision reads). Measure how much rework a new session needs after a handoff and whether risky parts still came back REVISE.
- 0.3.0: section leads and the logistics scripts. Measure conductor calls per part with and without a section lead, how often the quota guard re-routed a part, and whether a section lead's report ever hid a failure the independent review then found.
- 0.2.1: plan consultation. Before it, the conductor set direction alone: only 25 of 673 Codex calls were read-only questions. Measure how often an advisor's point changed the plan, and what it cost.

If you run orkestra, please add your numbers (calls, reads per role, wall clock, real bugs found by review) in an issue or PR.
