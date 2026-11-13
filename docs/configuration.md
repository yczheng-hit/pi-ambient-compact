# Configuration

SoL-Pi reads one effective JSON configuration file at extension startup. It uses Pi's public `CONFIG_DIR_NAME` and `getAgentDir()` APIs rather than assuming fixed directories.

## Search order

1. `<working-directory>/<Pi config directory>/sol-pi.json`, only after Pi marks the project trusted
2. `<Pi agent directory>/sol-pi.json`
3. Built-in defaults when neither file exists

For the official Pi distribution, the first two locations normally resolve to `.pi/sol-pi.json` and `~/.pi/agent/sol-pi.json`.

The project file replaces the global file. SoL-Pi does not merge them.

## Schema

```json
{
  "version": 1,
  "actionFusion": false,
  "observationPack": false,
  "evidencePreservingReducer": false,
  "evidencePreservingReducerProvider": "provider-id",
  "evidencePreservingReducerModel": "model-id",
  "onlineContextCompact": false,
  "cacheWriteReadRatio": 12.5
}
```

The optional `liveCompact` object configures the experimental high-retention mode described under [Live Compact](#live-compact-experimental); it defaults to disabled. Feature keys may be omitted and then default to `false`. `cacheWriteReadRatio` may be omitted and then defaults to `12.5`; when present it must be a finite non-negative number, and `0` explicitly means that a cache write adds no cost relative to a cache read. `evidencePreservingReducerProvider` and `evidencePreservingReducerModel` may be omitted and then use the built-in reducer route; when present each must be a non-empty string. Unknown keys, unsupported versions, malformed JSON, non-boolean feature values, invalid ratios, and invalid reducer model fields stop extension loading with a direct error.

For the managed all-enabled installation described in the [agent installation and configuration protocol](../agents-install.md), validate the effective file before starting Pi:

```bash
node scripts/check-sol-pi-config.mjs \
  --config /absolute/path/to/effective/sol-pi.json \
  --require-all-enabled
```

This preflight does not make every valid SoL-Pi configuration all-enabled. Without `--require-all-enabled`, omitted feature keys retain their normal `false` defaults. The managed workflow uses the flag because its acceptance criterion is that all four mechanisms are active.

## Feature behavior

- `actionFusion`: registers SoL-Pi replacements for Pi's `edit` and `write` tools.
- `observationPack`: registers `obs_recall` and a provider-context projection handler.
- `evidencePreservingReducer`: registers a `tool_result` handler and delegates long diagnostic-log reduction to the configured reducer provider/model.
- `evidencePreservingReducerProvider`: provider namespace used to resolve the reducer model through Pi's model registry.
- `evidencePreservingReducerModel`: model id used for Evidence-Preserving Reducer.
- `onlineContextCompact`: registers `update_plan` and boundary-driven native compaction after the other SoL-Pi context transformers. On Pi 1.x, `update_plan` is declared to the model only and cannot be called from codemode scripts.
- `cacheWriteReadRatio`: supplies the single economic decision ratio used by Online Context Compact.
- `liveCompact.enabled`: keeps long sessions near configured context levels by condensing older large tool results under context pressure; see [Live Compact](#live-compact-experimental). When enabled, ObservationPack stops its request-count projection and Online Context Compact stops its price-driven compaction.

## Evidence-Preserving Reducer runtime inputs

The release entry supplies the run label and session-derived storage. It uses one configurable model route:

- **Reducer provider/model** — from `evidencePreservingReducerProvider` and `evidencePreservingReducerModel` in the effective `sol-pi.json`. If omitted, SoL-Pi uses its built-in reducer route. SoL-Pi resolves that model through Pi's model registry and still relies on Pi-managed authentication; do not put credentials in `sol-pi.json`.

## Online Context Compact runtime inputs

The release entry uses these runtime inputs:

- **Context window** — from `ExtensionContext.getContextUsage()`, used for window-pressure protection.
- **Compaction settings** — on Pi 1.x, the retained tail and the window-protection reserve follow Pi's effective `compaction.keepRecentTokens` and `compaction.reserveTokens`, including a `compaction.modelOverrides["<provider>/<id>"]` entry for the current model. Pi 0.84.2 does not expose its settings to extensions, so SoL-Pi uses Pi's defaults of 20,000 and 16,384 tokens there.
- **Cache write/read ratio** — from `cacheWriteReadRatio` in the effective `sol-pi.json`. The value remains fixed for the session and is not recomputed when the model changes. It drives one runtime decision and is not a cost report.

The configured ratio stays fixed for the loaded extension. The mechanism stores its current plan, progress summaries, request horizon, context growth, and compaction debt as versioned custom entries in Pi's session log. After a successful compaction it sends one hidden, generic message with `triggerTurn: true`, which starts a new turn and asks the assistant to continue the current plan, preserving existing step IDs when updating progress. Newly introduced completed steps are recorded as history and do not create completion boundaries. Economic compaction has a two-provider-request cooldown; context-window protection can override it. Known native refusals and incomplete-summary token-cap failures are recorded as skips, resume the task, and block plan-only compaction retries until successful non-plan tool work or new user input. If the compaction fails for any other non-cancellation reason, it sends a hidden message that tells the assistant to continue from the current plan, then reports the error. Print and JSON modes finish that continuation in the same Pi invocation, so callers do not need to resume the session or inject `Continue working`. Cancelling the compaction or exiting Pi does not schedule an automatic continuation. The mechanism creates no separate Online Context Compact files. The programmatic factory accepts an explicit retained-tail value, which overrides Pi's setting.

## Live Compact (experimental)

Live Compact is a high-retention mode for long sessions where retaining useful history matters more than token cost. Below the start level it changes nothing. At each completed turn it estimates the next request's input, calibrated against the provider's reported usage. When the context is over the ceiling, or the next turn's expected growth would carry it over, Live Compact condenses the oldest eligible tool results, only as many as needed to return to the target level.

A condensed result becomes a card with verbatim head and tail excerpts, its size, and its SHA-256. Its `obs_recall` id returns the archived original page by page. Each result is archived before its card is written. If archiving fails, the original stays in context.

Cards are written as `context_edit` session entries through Pi's public `turn_end` boundary. Pi's own compaction threshold, forks, tree navigation, and resumed sessions therefore see the same condensed context. Raw session entries are never modified. When a card's archive is missing, `obs_recall` rebuilds it from the matching raw tool result on the current branch, after checking the id and hash. This covers a fork or clone, which has a new session id and therefore a new runtime directory, and a session moved without its runtime directory.

Requirements:

- Pi 0.87 or newer, checked at startup. On older Pi, Live Compact is not registered: ObservationPack and Online Context Compact keep their standard behavior, and a warning says so.
- `observationPack: true` (archive and `obs_recall`).
- `evidencePreservingReducer: false`. The reducer shrinks tool results regardless of context pressure, so the two cannot be combined yet.
- `onlineContextCompact` is optional. If it is enabled, `update_plan` keeps working, but price-driven compaction stays off.

```json
{
  "version": 1,
  "observationPack": true,
  "onlineContextCompact": true,
  "liveCompact": {
    "enabled": true,
    "thresholds": { "startRatio": 0.7, "targetRatio": 0.7, "ceilingRatio": 0.8 },
    "protection": { "keepRecentToolRounds": 3, "minFullRequests": 2 },
    "observation": { "minBytes": 10240, "excerptTargetBytes": 8192 }
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `thresholds.startRatio` | `0.7` | Share of the model window where maintenance starts. |
| `thresholds.targetRatio` | `0.7` | Level a reduction returns to. |
| `thresholds.ceilingRatio` | `0.8` | Soft ceiling; a reduction starts when the context is over it or the next turn is expected to cross it. |
| `protection.keepRecentToolRounds` | `3` | Most recent complete tool rounds kept verbatim; parallel calls from one assistant message count as one round. |
| `protection.minFullRequests` | `2` | Assistant responses that must have seen a result in full before it may be condensed. |
| `observation.minBytes` | `10240` | Only successful text results larger than this many UTF-8 bytes are eligible. |
| `observation.excerptTargetBytes` | `8192` | Verbatim head and tail excerpt budget per card. |
| `limits.maxCandidatesPerPass` | `8` | Most results condensed at one boundary. |
| `limits.batchBudgetMs` | `50` | Cooperative time budget for one boundary's condensing. |
| `budget.extraReserveTokens` | `0` | Extra input reserve on top of the automatic output reserve and margin. |

Ratios are fractions (`0.7` is 70%) and must satisfy `0 < targetRatio <= startRatio < ceilingRatio < 1`. The safe input limit is the model window minus an output reserve (the model's `maxTokens`, at most 32,768 tokens and at most a quarter of the window), minus a 2% margin, minus `extraReserveTokens`. When Pi's auto-compaction is on, the levels must also stay under Pi's own compaction threshold, which is the window minus Pi's effective `compaction.reserveTokens` minus the same margin. Otherwise Pi's native compaction would run first, which matters for windows under about 82K tokens with Pi's default 16,384 reserve. If the configured ceiling exceeds the lower of the two limits, all levels are scaled down proportionally, and `/ambient-compact` says which limit applied. Right after Live Compact writes cards, Pi checks its own uncalibrated estimate instead of the provider's usage, so Live Compact keeps condensing eligible results until that estimate also fits under Pi's threshold. Unknown keys and invalid values are fatal, in both the runtime loader and `scripts/check-sol-pi-config.mjs`, which share one schema. The full schema, including the `summary`, `verification`, `background`, and remaining `limits` fields reserved for later stages, is in `docs/ambient-compact-config-plan.md` in the SoL-Pi repository.

These results are never condensed:

- user and assistant text;
- error results;
- results containing images or mixed content;
- `obs_recall` output;
- Evidence-Preserving Reducer receipts;
- results whose tool call cannot be found;
- results already edited.

If protected content alone exceeds the ceiling, Live Compact keeps it verbatim and records the shortfall. It does not cut into protected content.

Current limits of this build:

- No per-request admission check. A single very large paste or tool batch is not intercepted before it is sent.
- No bounded prefix summaries. When local condensing cannot keep the context below Pi's own compaction threshold, Pi's native compaction still runs, and Live Compact shows a warning.
- `summary` and `verification` routes are validated but not used yet.
- `background.enabled: true` is rejected.

To validate a Live Compact profile, run `node scripts/check-sol-pi-config.mjs --config <file> --require-live-compact`. It fails unless `liveCompact.enabled` is `true`, and it cannot be combined with `--require-all-enabled`. [`sol-pi.live-compact.example.json`](../sol-pi.live-compact.example.json) is a ready profile.

`/ambient-compact` shows the current levels, the context before and after the last boundary, condensed counts, calibration, and any shortfall. Decisions are logged without tool content to `live-compact/ledger.jsonl` under SoL-Pi's session-derived runtime directory. Configuration is read at extension startup; restart Pi after changing it. Condensed cards already in the session keep their content, and new settings apply to later decisions.

### dynamic-ai strategy (experimental)

`"strategy": "dynamic-ai"` replaces tool-result condensing with global maintenance cycles driven by an AI planner. It is opt-in. Without `strategy`, Live Compact keeps the `local-tools` behavior above. The design and its verification are in `docs/ambient-compact-dynamic-plan.md` in the SoL-Pi repository. It has passed automated tests only; comparisons against real providers (stage G4) are still pending.

```json
{
  "version": 1,
  "observationPack": true,
  "onlineContextCompact": true,
  "liveCompact": {
    "enabled": true,
    "strategy": "dynamic-ai",
    "thresholds": { "startRatio": 0.7, "targetRatio": 0.5, "ceilingRatio": 0.8 },
    "summary": { "provider": "nvidia-inference", "model": "nvidia/deepseek-ai/eccn-deepseek-v4.1-flash-1017" }
  }
}
```

A cycle runs at a completed turn (`turn_end`) or at the end of a run (`agent_before_settle`) when all of these hold:

- the context is at or above `startRatio`;
- the cooldown since the last cycle has passed;
- after a failed or unprofitable cycle, the context has grown by `retryGrowthRatio` of the window;
- the candidate segments can plausibly reclaim at least `minSavingsRatio` of the window.

At or above `ceilingRatio`, the cooldown and minimum-savings rules no longer apply, but the backoff after a failure still does.

A cycle runs these steps:

1. **Index.** It splits the projected context into whole earlier episodes (everything that answered a user turn) and runs of complete tool rounds. These stay verbatim:
   - user turns;
   - system messages;
   - already edited messages;
   - rounds with an error result, non-text content, unpaired calls, or a failed assistant message;
   - the most recent `protection.keepRecentToolRounds` tool rounds;
   - the latest answer.
2. **Plan.** It sends the candidates, oldest first, to the summary route. The planner returns which segments to summarize, with a summary for each, as JSON. It never returns the context to keep.
3. **Verify.** The verification route checks each summary against its original. A summary fails if it contradicts the original or invents facts. It also fails if it drops failures, errors, or unresolved issues, turns attempts into completed work, or repeats instructions found in tool output. Failed summaries are regenerated once with the problems listed, within `maintenance.maxCallsPerCycle` (a normal cycle makes 2 calls) and `limits.maxRegenerations`. Only verified summaries are used.
4. **Commit.** It archives each segment's raw messages, applies the edits to a copy of the context, and rejects the cycle if any tool pairing would break. When the result reclaims enough, it commits one batch through `context_edit`. A summary is held in the first assistant message of an episode, or in the first tool result of a run of rounds. Every summary starts with a fixed header that names its archive id, recallable with the `context_recall` tool. A cycle's outcome is recorded in the session, so cooldown and backoff survive restarts.

| Field | Default | Meaning |
|---|---|---|
| `strategy` | `"local-tools"` | `"dynamic-ai"` selects this strategy. |
| `thresholds.targetRatio` | `0.5` for dynamic-ai | Reclaim target of a cycle. It is a target, not a quota: a cycle may stop above it when nothing else is safe to summarize. An explicit value is kept. |
| `maintenance.minSavingsRatio` | `0.1` | Least reclaim worth a normal cycle, as a share of the window. |
| `maintenance.cooldownRequests` | `12` | Assistant responses between cycles. |
| `maintenance.retryGrowthRatio` | `0.05` | Growth, as a share of the window, needed after a failed or unprofitable cycle before another one. |
| `maintenance.maxCallsPerCycle` | `4` | Model calls per cycle, including verification and regeneration. |
| `maintenance.timeoutMs` | `300000` | Time limit for one cycle's model calls. |
| `summary` / `verification` | working model | `provider` and `model` of the route, set together. An unknown route fails the cycle; there is no fallback to another provider. |

Safety does not depend on a cycle succeeding:

- **Mid-run pause.** In the middle of a run, if the context is still above the safe input limit after any cycle, Live Compact stops the run with `ctx.abort()` instead of sending the request, and shows a warning.
- **Oversized input.** An input that would not fit first gets an immediate maintenance cycle. If it still does not fit, it is not sent; shorten it, or run `/compact`.
- **Pi's own compaction.** Live Compact cancels Pi's threshold compaction while the request fits the safe limit. Overflow recovery and manual `/compact` are unchanged. If another extension that compacts loads before SoL-Pi, such as pi-compaction-guidance, that extension still does its work before the cancel.
- **Interrupted batches.** A batch cut short by a crash or I/O failure is completed at the next boundary. The request before that boundary already carries the remaining edits, applied in memory.
- **No lock at the limit.** At or above `ceilingRatio`, a failed cycle is retried after two minutes without waiting for growth, and at once after the summary or verification model changes. `/ambient-compact now` runs a cycle immediately. Pi's built-in `/compact` stays available in every state.

The summary and verification routes receive the selected history segments, with Pi-managed authentication. Choose routes whose provider may see that history.

Not yet covered:

- comparisons on real providers;
- replay of signed reasoning blocks through real providers and proxies;
- merging scheduler wake-up messages, which are user messages and stay verbatim;
- layered summaries for routes whose window cannot hold the candidates. Candidates that do not fit are left out.

Model calls are bounded. The candidate pool is capped at 150,000 real tokens, and both the pool and the route window are measured in real tokens, using the session's calibration against provider usage, so a route is never sent more than its window holds. A rate limit, overload, 5xx error, or timeout is retried twice within the cycle, after 5 and 15 seconds.

**Interactive TUI settings pane and commands.** In TUI mode, `/ambient-compact` (with no arguments) or `/ambient-compact settings` opens an interactive settings pane with the same interaction contract as `/codex-settings`:

- **Enter** changes the selected value or opens its picker/input editor (model routes from `ctx.modelRegistry` or custom `provider/model`, water-level percentages, protection counts, maintenance cooldown/savings/timeouts, and observation sizes). It never implicitly saves.
- **Space** activates a result or inserts a space when search has focus.
- **Tab / Shift+Tab** move between search, results, and action controls.
- **F1** (or **Details, errors, and save target**) opens scrollable runtime status, levels, last cycle details, setting source, and the exact save target.
- Edits remain drafts (`*`) until explicitly applied or saved.
- **Apply to session** applies drafts (`~`) to the current session and stores them as a session state entry without modifying configuration files.
- **Ctrl+S** saves to `sol-pi.json` (using a `.settings-lock` file and conflict hashes) and applies changes without closing.
- **Save and close** saves and applies changes, then closes on success. Other running Pi sessions automatically hot-reload the saved `sol-pi.json` on their next turn/cycle while preserving their own session overrides.
- **Run maintenance now** executes a maintenance cycle directly from the menu.
- **Escape** cancels a field editor or discards unapplied drafts and closes the menu.

Subcommands remain available in both TUI and non-TUI modes:

| Command | Effect |
|---|---|
| `/ambient-compact` or `/ambient-compact settings` | Open the interactive TUI settings pane (in non-TUI mode, `/ambient-compact` prints status). |
| `/ambient-compact status` | Levels, the routes in effect and where each comes from, the last boundary, and the last cycle. |
| `/ambient-compact now` | Run a cycle immediately, without the cooldown, backoff, or minimum-savings checks. It needs no boundary: the batch applies to the next request and is persisted at the following boundary. |
| `/ambient-compact model` | Show the summary and verification routes in effect. |
| `/ambient-compact model summary <provider>/<model>` | Use that model for summaries in this session only. Use `verification` for the checker. The model id may contain slashes, for example `nvidia-inference/nvidia/deepseek-ai/eccn-deepseek-v4.1-flash-1017`. |
| `/ambient-compact model summary default` | Clear this session's override. |
| `... --global` | Write the route, or with `default` remove it, in the effective `sol-pi.json`. The whole file is validated first and then replaced atomically; other settings and route options are kept. |

A model that Pi has not registered is refused and nothing changes. For each setting, a session override takes precedence over the global/project default in `sol-pi.json`, which takes precedence over the configuration loaded at startup. The global/project file is re-read whenever its content changes on disk, so a saved change made in one session applies to every running session from its next cycle, without a restart. If the file becomes invalid, the last valid settings stay in use and `/ambient-compact` reports the error.
`/ambient-compact` shows the levels, the last boundary, and the last cycle. Cycles are logged without message content to `live-compact/ledger.jsonl`.

## Pi integration

SoL-Pi reads no dedicated environment variables. Evidence-Preserving Reducer resolves its configured reducer provider/model through `ExtensionContext.modelRegistry` and uses Pi-managed authentication. If the configured reducer model is unavailable or the nested model call fails, the original tool result continues unchanged.

SoL-Pi does not configure shell paths, command prefixes, storage paths, run IDs, provider URLs, reasoning levels, timeouts, or per-mechanism enable flags through environment variables. Apart from the EPR reducer provider/model route in `sol-pi.json`, model selection remains with Pi. Action Fusion uses Pi's built-in Bash execution, with `shellPath` and `shellCommandPrefix` inherited from Pi's file-backed settings at extension startup. Global settings apply everywhere; project settings override them only after project trust. Malformed settings stop initialization rather than silently selecting a different shell. Persistent artifacts are derived from Pi's session directory and session ID.

For native Windows with Git for Windows installed outside the default directories, configure its Bash executable in Pi's `settings.json` (not `sol-pi.json`), for example:

```json
{
  "shellPath": "D:/Tools/Git/bin/bash.exe"
}
```

Replace that example path with your actual Git Bash installation. `then_run.command` remains a Bash command even if the model's ordinary command tool is PowerShell; Git Bash is a native Windows program and does not require WSL. Do not point `shellPath` at `powershell.exe`, because the built-in Bash tool invokes it with Bash arguments. Restart the extension after changing shell settings.

This bridge reads file-backed settings, not SDK/CLI-only in-memory overrides. Embedded runtimes can pass explicit `bashOptions` to `createActionFusionExtension`; programmatic execution overrides remain supported.

## Trust

A project-local config can enable file mutation, shell execution, local archival, and remote diagnostic-log reduction. SoL-Pi waits for Pi's `session_start` context and ignores the project file unless `ctx.isProjectTrusted()` is true. Prefer the global file when you want one personal configuration across trusted projects.
