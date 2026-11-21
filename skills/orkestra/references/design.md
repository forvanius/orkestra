# Design parts — read when a part's domain is `design`

The designer (`orkestra:designer`, "Gusto") owns art direction, concepts, design specs and visual acceptance. It writes no code logic; wiring an approved asset or building an approved spec is a separate `code` part for a worker or Codex.

## Pick the mode
| Mode | When | Output |
|---|---|---|
| `concept` | pictures help the decision: characters, scenes, illustrations, icons, a screen's mood, a logo, a game asset | 2–4 genuinely different images (Codex image generation) + `concepts.md` (idea, where it fits, risk, the designer's pick) |
| `spec` | pictures don't: flows, layout, tokens, UI states, copy hierarchy, motion, a layout fix | a written spec with exact values (`DESIGN.md` section, design note, or HTML mock if allowed): the designer writes the structure, Codex drafts the look, the designer checks it |
| `visual-check` | a built screen or asset against the approved concept/spec | defects with location and fix; at most 2 rounds |

Not everything visual needs images. A token change or a misaligned label is `spec` or plain `code`.

## Brief the designer
- `MODE:` one of the three.
- The image count the user approved (concept). Every generation batch is user-approved; never let the designer pick the count.
- `spec` briefs carry the same guarded line: the designer uses it once for the visual half. A token change or a one-label fix needs no Codex call — say so in the brief.
- The full guarded line for image generation: `node "${CLAUDE_SKILL_DIR}/guarded.js" codex --minutes 25 -- codex exec -m ${user_config.codex_model_design} --skip-git-repo-check -s workspace-write [-i ref.png …] - < prompt.txt`. If `codex_model_design` is empty, use `${user_config.codex_model}`. Agent files can't expand `${CLAUDE_SKILL_DIR}`, so write the resolved path.
- Supply the CONSTRAINTS CHECKLIST and RUN ENVIRONMENT for the designer to include in Codex briefs.
- Its write surface, split in two. Working files — raw generations, Codex prompts and logs, reference captures, rejected rounds — go to the job dir (`<repo>/.orkestra/<job>/design/`, git-ignored), so nothing is left untracked in the repo. Only what the project keeps goes under the project's docs: the chosen concept(s), `concepts.md`, and a reference an acceptance note cites. In one pilot job, `_ham/` folders and `tur4` references piled up untracked in `docs/` because the brief named a docs folder only.
- If the asset shows something that already exists in the product (the game's hero, a mascot, a UI screen), name the reference to use: a model render, a screenshot or concept art. The first test job's character only matched the game once a Blender render of the in-game model was the reference.
- Revision rounds the user drives (B2 → B5 in the first test job) are not the 2-round tuning ceiling; the ceiling is for the designer judging alone. Pass the user's words on with numbers where they are vague ("halve the pattern" → "about 12 motifs").

## Keep the original request in sight
A new direction the user opens mid-job ("now make the background richer") is a new part with its own acceptance, not a replacement for the open one. Put it in the lane matrix, keep the original part's state on the board, and in every report to the user name what is still open from the first request ("the title A+C build is still waiting for you"). In one pilot job, five rounds went into the menu background while the title and button the job was opened for stayed unbuilt.

## After concepts
The conductor doesn't open the images: send `concepts.md` and the images to the user as they are. The user picks; record it on the board as a decision. If the open question was a visual direction in a design note, the concepts go with the note so the user approves from something concrete. Then a `code` part wires the pick in, with a before/after comparison, and a `visual-check` closes it. A part that builds the look of a screen goes to Codex (Routing); the designer's `visual-check` is its other-vendor acceptance, on top of the code review.
