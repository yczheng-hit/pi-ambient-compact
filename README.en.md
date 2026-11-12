<p align="center">
  <img src="assets/sol-pi-hero.png" width="100%" alt="pi-ambient-compact: Ambient Context Compaction for Pi" />
</p>

# 🌊 pi-ambient-compact: Ambient Golden-Band Context Compaction for Pi

<p align="center">
  <a href="README.md">中文</a> · <strong>English</strong> · <a href="docs/configuration.md">Configuration</a> · <a href="docs/compatibility.md">Compatibility</a> · <a href="agents-install.md">AI Install Protocol</a> · <a href="LICENSE">MIT License</a>
</p>

> [!NOTE]
> **`pi-ambient-compact`** is a standalone context-management and tool-efficiency extension for [Pi](https://github.com/earendil-works/pi).
> It synthesizes and evolves the core ideas of two reference projects:
> - **[NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi)** ([arXiv:2609.20519](https://arxiv.org/abs/2609.20519)): provides a zero-patch public Pi extension architecture, content-addressed archival with paged recall (`ObservationPack` / `obs_recall`), online compaction lifecycle coordination (`Online Context Compact`), mutation-validation fusion (`Action Fusion`), and the `Evidence-Preserving Reducer`.
> - **[Tranquillitatis-Lab/dsh-live-compact](https://github.com/Tranquillitatis-Lab/dsh-live-compact)**: provides turn-boundary water-level pressure maintenance, protection of recent complete tool rounds, paired tool-call/result boundary integrity, and the archive-before-replace safety invariant.

---

## 💡 Core Philosophy: High-Fidelity Floor, Hard Ceiling, and Ambient Maintenance in the 30%–70% Golden Band

In multi-hour coding, debugging, and scheduled monitoring sessions, conventional context management tends to fall into one of two extremes: either waiting until 95%+ to run native full compaction—**"shaving the context bald"** down to a ~20K token tail and losing early constraints, negative findings, and decision history—or mutating history on every turn and destroying prompt-cache hit rates.

Prioritizing **AI Performance (constraint & evidence fidelity) > User Experience >> Token Cost**, **`pi-ambient-compact`** keeps long-running sessions inside the **30%–70% golden working band**:

1. **🛡️ High-Fidelity Floor (Never "Shave Bald")**
   - **Verbatim protection of active context**: every user prompt and constraint, system instructions, the most recent N complete tool rounds (default 3; parallel calls in one turn stay grouped), error/non-text tool results, and the latest assistant answer always remain verbatim.
   - **Summary + Verification Dual-Model Quality Gate**: a `summary` route (configurable to a fast long-context model such as DeepSeek Flash) selects completed historical segments and drafts summaries; a `verification` route (configurable to a strong checker such as Gemini or Claude) audits each summary against its `<original>` messages. Any summary that drops failures, alters paths/numbers/versions, turns an attempt into a completed result, or repeats prompt-injection instructions from tool output is rejected and regenerated once—or left verbatim if verification still fails.
   - **100% Content-Addressed Archival & Lossless Recall**: before any replacement is committed, the exact original is archived by SHA-256. The model can page through the verbatim original at any time via `context_recall` (for summarized history segments) and `obs_recall` (for condensed tool outputs), with automatic self-healing reconstruction from the session branch across forks.
2. **🚧 Hard Ceiling (Never Overflow or Deadlock)**
   - **Dynamic Real-Token Calibration**: calibrates character-to-token estimates against real provider `usage` (correcting ~2x estimation drift on Chinese and JSON-heavy transcripts), reserves output tokens and safety margin to compute `safeInputLimit`, and stays below Pi's native compaction threshold.
   - **Multi-Layer Admission & Anti-Deadlock Guards**: crossing the urgent ceiling (default 80%) bypasses cooldown and minimum-savings gates; an oversized user input triggers an immediate maintenance cycle before admission; transient 429/5xx errors retry with backoff (5s → 15s) inside a cycle and become eligible for retry every 2 minutes above the urgent ceiling or immediately upon changing model routes—preventing any deadlock between input blocking and growth-based backoff.
3. **🌊 Ambient Maintenance in the 30%–70% Golden Band**
   - **Zero intervention below the start threshold (e.g. 70%)**: history remains strictly append-only, preserving 100% of provider prompt-cache prefixes.
   - **One consolidated batch at the boundary**: once context reaches ~70%, a maintenance cycle runs at `turn_end` or `agent_before_settle`, bringing context back to the **30%–50%** golden band in one crash-safe batch and entering cooldown (default 12 requests) so subsequent turns continue to append cleanly.

---

## 📊 Comparison with the Two Reference Projects

| Dimension | NVlabs/SoL-Pi (Upstream Base) | dsh-live-compact (Reference) | **pi-ambient-compact (This Project)** |
|---|---|---|---|
| **Primary Goal** | Reduce token cost and repeated tool turns | Condense old tool outputs by water levels to avoid overflow | **AI performance first**: high-fidelity ambient maintenance in the **30%–70% golden band** |
| **Trigger Mechanism** | `update_plan` step completion boundary + `cacheWriteReadRatio` economic check | Post-turn water-level check on tool outputs | **Dual-boundary water-level state machine** (`turn_end` + `agent_before_settle`) + request cooldown + minimum-savings gate |
| **Compaction Scope & Granularity** | `ObservationPack` replaces >10KiB tool outputs after 2 sends; `OCC` triggers Pi's full native compaction | Condenses old `toolResult` messages only; does not compact verbose `assistant` turns or repeated monitoring loops | **Global segment-level (Episodes + Tool Rounds) + tool-level dual strategies**: summarizes completed episodes, tool-round runs, or large tool results |
| **Floor Protection (No "Bald Shave")** | Native compaction keeps only a ~20K token tail by default | Protects recent N tool rounds, without semantic cross-turn selection | **Retains all user turns + recent N complete tool rounds + error diagnostics + latest answer**, targeting **30%–50%** |
| **Ceiling Protection (No Overflow)** | Relies on Pi's native threshold and overflow recovery | Falls back to native compaction when tool condensing is insufficient | **Real-usage token calibration + output reserve + oversized-input immediate cycle/rejection + safe mid-run pause + 2-min urgent retry** |
| **AI Quality Gate** | `EPR` checks verbatim quotes on single logs; session compaction has no separate verifier | No dual-model generation/verification loop | **Independent `Summary` + `Verification` model routes**, auditing summaries against `<original>` with bounded regeneration |
| **Crash Safety & Atomicity** | Single replacement or single native compaction entry | Internal session log transactions and backup rollback | **Prefix-safe ordered batches** (omit `toolResult` → omit `assistant` → replace content) + batch markers + in-memory & next-boundary recovery |
| **Archival & Lossless Recall** | `obs_recall` (single tool output only) | Local file backup of tool outputs | **`context_recall` (full summarized message segments) + `obs_recall` (tool outputs)**, with branch self-healing when files are missing |
| **Interactive Settings & Sync** | Static `sol-pi.json` requiring Pi restart | CLI flags and static config | **`/ambient-compact` interactive TUI settings pane** (`/codex-settings` UX): search, model pickers, water levels, session overrides `~`, `.settings-lock` atomic save, and **cross-session hot reload** |
| **Tool Ecosystem Compatibility** | `Action Fusion` re-registration at `session_start` could re-activate disabled tools under an allowlist | Requires custom backend or harness patches | **100% public Pi extension APIs (zero patches)**: preserves disabled state for `pi-hashline-edit-pro` / `apply_patch` and warns when shadowed by `pi-cc-extensions` |

---

## 🧩 Features & Architecture

All mechanisms ship in the standalone `pi-ambient-compact` package and compose through Pi's public extension APIs:

| Module | Strategy / Tool / Command | Description |
|---|---|---|
| **Ambient Compact (`dynamic-ai`)** | `/ambient-compact` (alias `/live-compact`), `context_recall` | **Global AI Selective Compaction (Recommended)**: maintains context in the 30%–70% golden band by indexing completed episodes and tool-round runs, generating and verifying summaries through `summary` + `verification` routes, and archiving originals for `context_recall`. |
| **Ambient Compact (`local-tools`)** | `/ambient-compact` (alias `/live-compact`), `obs_recall` | **Zero-Model Local Condensing**: replaces the oldest >10KiB pure-text successful tool outputs with deterministic head+tail excerpt cards (default 8KiB) when pressure crosses the ceiling. |
| **ObservationPack** | `obs_recall` | Content-addressed archive and paged recall for large text tool outputs; hands projection control to Ambient Compact when enabled while keeping `obs_recall` active. |
| **Online Context Compact** | `update_plan` | Registers `update_plan` for structured working plans; disables price-driven native compaction when Ambient Compact is active. |
| **Action Fusion** | `edit` / `write` (`then_run`) | Adds optional `then_run` validation commands to `edit` and `write`, preserving tool activation states set by `pi-hashline-edit-pro` or `pi-openai-codex-compat` (`apply_patch`). |
| **Evidence-Preserving Reducer** | `delegate_Read` / `delegate_Bash` | Reduces long diagnostic logs into quote-verified receipts in legacy mode (mutually exclusive with `liveCompact.enabled: true`). |

---

## 🖥️ Usage & Interactive TUI Settings Pane

### 1. Interactive TUI Settings Pane (`/ambient-compact`)

In Pi TUI mode, run **`/ambient-compact`** (or `/ambient-compact settings`, alias `/live-compact`) to open the interactive settings pane modeled after `/codex-settings`:

- **Instant search**: type to filter settings by label, key, or description.
- **Configurable fields**:
  - **Compaction strategy**: switch between `dynamic-ai` and `local-tools`;
  - **Summary model / Verification model**: pick from all models registered in Pi's `modelRegistry`, choose `Working model`, or enter a custom `<provider>/<model>` route;
  - **Start threshold / Target level / Urgent ceiling**: choose presets (`30%`, `40%`, `50%`, `60%`, `70%`, `80%`, etc.) or enter a custom percentage (`0 < target ≤ start < ceiling < 100`);
  - **Protection & maintenance budgets**: adjust `Keep recent tool rounds` (default 3), `Min cycle savings` (default 10%), `Cooldown requests` (default 12), `Retry growth after failure` (default 5%), `Max model calls per cycle` (default 4), and timeouts.
- **Drafts (`*`), Session Overrides (`~`), and Cross-Session Hot Reload (`Ctrl+S`)**:
  - Edits stay as drafts (`*`) until applied or saved;
  - **Apply to session**: applies changes to the active session (`~`) without touching `sol-pi.json`;
  - **Ctrl+S** or **Save and close**: acquires `.settings-lock`, verifies SHA-256 conflict hashes, atomically writes `~/.pi/agent/sol-pi.json` (or trusted `.pi/sol-pi.json`), and applies immediately—**other running Pi sessions automatically hot-reload the saved file on their next cycle** while keeping their own session overrides;
  - **Run maintenance now**: triggers a maintenance cycle directly inside the pane;
  - **F1** (**Details, errors, and save target**): shows water levels, active routes, last cycle report, and the save target path;
  - **Esc**: cancels a field editor or discards unapplied drafts and closes the pane.

### 2. Slash Subcommands

| Command | Effect |
|---|---|
| `/ambient-compact` or `/ambient-compact settings` | Open the interactive TUI settings pane (prints status in non-TUI modes) |
| `/ambient-compact status` | Show current water levels, effective model routes and sources, and the last maintenance cycle |
| `/ambient-compact now` | Run an immediate maintenance cycle, bypassing cooldown, backoff, and minimum-savings checks |
| `/ambient-compact model` | Show effective `summary` and `verification` routes and their sources (`session` / `global` / `startup`) |
| `/ambient-compact model summary <provider>/<model>` | Override the summary model for the current session only (use `verification` for the checker) |
| `/ambient-compact model summary default` | Clear the current session's model override |
| `/ambient-compact model summary <provider>/<model> --global` | Validate and atomically write the route to `sol-pi.json`; other running sessions hot-reload it on their next cycle |

---

## 🤖 AI Agent Installation Guide Index

Coding agents (**Codex, Claude Code, Pi**) installing, configuring, or validating this repository must follow the canonical [agent installation and configuration protocol](agents-install.md) (indexed by root [`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md)):

1. **Read [`agents-install.md`](agents-install.md) completely** before running commands.
2. **Runtime requirements**: Node.js `>=22.19.0` and a tested Pi release (`1.5.2` default, `1.3.0`, `1.0.4`, or `0.84.2` floor; Ambient Compact requires `>=0.87.0`):
   ```bash
   npm install --global @earendil-works/pi-coding-agent@1.5.2
   ```
3. **Validate the checkout (Phase 1)**:
   ```bash
   npm ci --ignore-scripts
   npm run check
   npm audit --audit-level=high
   node scripts/check-pi-compat.mjs --strict
   npx vitest run tests/all-mechanisms.test.ts
   ```
4. **Install into Pi (Phase 2)**:
   ```bash
   pi install "/absolute/path/to/pi-ambient-compact" --approve
   pi list --approve
   ```
5. **Configure and validate `sol-pi.json` (Phase 3 & Phase 4)**:
   - For Ambient Compact (`live-compact` profile):
     ```bash
     node scripts/check-sol-pi-config.mjs --config ~/.pi/agent/sol-pi.json --require-live-compact
     ```
   - For the upstream four-mechanism (`all-enabled`) profile (`cacheWriteReadRatio` defaults to `12.5`, checked with `scripts/check-sol-pi-config.mjs --require-all-enabled`):
     ```bash
     node scripts/check-sol-pi-config.mjs --config ~/.pi/agent/sol-pi.json --require-all-enabled
     ```
   - See [Configuration](docs/configuration.md) and [Codemode compatibility](docs/compatibility.md#codemode).

## 📄 License

Released under the [MIT License](LICENSE).
