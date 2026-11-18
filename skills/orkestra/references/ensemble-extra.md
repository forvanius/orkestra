# Ensemble rows used only sometimes

Read when you are at the plan stage (Advisors) or briefing the Designer or a Section lead.

| Role | How | When |
|---|---|---|
| Advisors | `codex exec -m ${user_config.codex_model} -c model_reasoning_effort=medium -s read-only -o <job dir>/consult-codex.md - < consult.txt` and `subagent_type: "orkestra:advisor"` | Plan stage only (Flow 3). ≤10 lines each; the conductor decides. |
| Designer ("Gusto") | `subagent_type: "orkestra:designer"` (mid model), `MODE: concept|spec|visual-check` | `design` parts: image concepts via Codex (every batch user-approved, sent to the user unopened), design specs, visual acceptance. No code logic. |
| Section lead | `subagent_type: "orkestra:section-lead"` (mid model) | Large jobs only (Flow 2). Runs a group of Codex parts; counts toward the 2–3 parallel Claude agents. |

**Every `codex exec` above runs as `node "${CLAUDE_SKILL_DIR}/guarded.js" codex --minutes 25 -- codex exec …`**: it won't start near the plan's quota (exit 4: re-route or tell the user) and stops at the limit (exit 124: split the part or raise the limit with a reason).
