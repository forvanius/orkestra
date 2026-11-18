# Other instruments (Configure once row)

Read before routing a design part to Codex (Design Codex model row) or before using Claude Code (`claude -p`) or Google's CLI (`agy`/`gemini`) as a writer or reviewer.

| Setting | Default | Notes |
|---|---|---|
| Design Codex model (optional) | `${user_config.codex_model_design}` | Plugin option `codex_model_design`, for design parts (see Routing). Empty → `codex_model`. |
| Other instruments | — | Claude Code (`claude -p`) or Google's CLI (`agy` or `gemini`, model option: `${user_config.gemini_model}`; unproven as a reviewer) can write or review — recipes in `docs/instruments.md`. |

The design row of the Routing table, as it read before SKILL.md added the empty-model fallback (`codex_model_design` empty → `codex_model`, per the row above):

| Part | Model | Why |
|---|---|---|
| Design: concepts, images, 2D/3D model or asset tuning (meshes, sprites, CAD, Blender), a new look | Codex `medium`, `codex_model_design`; designer `visual-check` | Strongest eye where looks are made |
