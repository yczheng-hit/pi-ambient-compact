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

Ratios are fractions (`0.7` is 70%) and must satisfy `0 < targetRatio <= startRatio < ceilingRatio < 1`. The safe input limit is the model window minus an output reserve (the model's `maxTokens`, at most 32,768 tokens and at most a quarter of the window), minus a 2% margin, minus `extraReserveTokens`. When Pi's auto-compaction is on, the levels must also stay under Pi's own compaction threshold, which is the window minus Pi's effective `compaction.reserveTokens` minus the same margin. Otherwise Pi's native compaction would run first, which matters for windows under about 82K tokens with Pi's default 16,384 reserve. If the configured ceiling exceeds the lower of the two limits, all levels are scaled down proportionally, and `/live-compact` says which limit applied. Right after Live Compact writes cards, Pi checks its own uncalibrated estimate instead of the provider's usage, so Live Compact keeps condensing eligible results until that estimate also fits under Pi's threshold. Unknown keys and invalid values are fatal, in both the runtime loader and `scripts/check-sol-pi-config.mjs`, which share one schema. The full schema, including the `summary`, `verification`, `background`, and remaining `limits` fields reserved for later stages, is in `docs/live-compact-config-plan.md` in the SoL-Pi repository.

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

`/live-compact` shows the current levels, the context before and after the last boundary, condensed counts, calibration, and any shortfall. Decisions are logged without tool content to `live-compact/ledger.jsonl` under SoL-Pi's session-derived runtime directory. Configuration is read at extension startup; restart Pi after changing it. Condensed cards already in the session keep their content, and new settings apply to later decisions.

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
