<p align="center">
  <img src="assets/sol-pi-hero.png" width="100%" alt="SoL-Pi: Scaling Auto-Research Loops for Efficient Agent Harnesses" />
</p>

# ⚡ SoL-Pi: Scaling Auto-Research Loops for Efficient Agent Harnesses

<p align="center">
  <a href="https://arxiv.org/abs/2609.20519"><img src="https://img.shields.io/badge/arXiv-2609.20519-B31B1B?logo=arxiv&amp;logoColor=white" alt="arXiv: 2609.20519" /></a>
  <a href="#getting-started"><img src="https://img.shields.io/badge/Getting%20Started-Install-76B900" alt="Getting Started" /></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Docs-Configuration-555555" alt="Configuration" /></a>
  <a href="https://nvlabs.github.io/SoL-Pi/"><img src="https://img.shields.io/badge/Blog-SoL--Pi-76B900" alt="SoL-Pi Blog" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
</p>

> [!NOTE]
> This repository contains the open-source version of SoL-Pi, a standalone extension for [Pi](https://github.com/earendil-works/pi). It is not an official distribution of Pi.
>
> SoL-Pi is under active development to support pi-v1 and the latest model checkpoints.

> [!IMPORTANT]
> **This fork ([yczheng-hit/SoL-Pi](https://github.com/yczheng-hit/SoL-Pi)) adds Live Compact**, an experimental, opt-in high-retention context mode, on its `main` branch. Upstream [NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi) does not include it. See [Changes in this fork](#changes-in-this-fork) and [Live Compact](#live-compact-experimental).

## 📰 News

- **2026-10-14** — Released the [SoL-Pi Skill](examples/sol-pi-skill/README.md) example: use SoL-Pi as a skill from Claude Code (`/sol-pi`) or Codex (`$sol-pi`). The current task is handed to SoL-Pi with the host conversation as context, runs in the background, and its result is reported back to the session.
- **2026-10-13** — Released the [SoL-Pi Visual](examples/solpi-visual/README.md) example for 3D scene reconstruction in Blender. On this task, it lowers the cost per scene by **37%** compared with Codex, with 13% fewer model calls. See the example for visual scores and scene comparisons.

## 💡 TL;DR

**Spend less without making the agent do less useful work.**

SoL-Pi is a standalone extension for Pi that packages four reusable efficiency mechanisms discovered through scaled auto-research loops. It reduces repeated model turns, context replay, oversized observations, and unnecessary long-log reading while preserving the work and evidence an agent needs to finish a task.

SoL-Pi installs on top of an unmodified Pi release. Every mechanism is opt-in and disabled by default.

## Introduction

Long-running coding agents accumulate repeated work. A file edit is often followed by a predictable validation command. Large tool results are replayed long after their first use. Completed subtasks remain in active context, and a frontier model may spend a full request reading a log when only a few lines affect the next decision.

SoL-Pi grew out of a broader question from our auto-research work: before scaling agent loops, can agents first make the harness itself more efficient? The search focused on constrained efficiency: reducing token traffic, inference work, and agent turns without stopping early, skipping verification, or hiding evidence.

The standalone release contains four mechanisms that survived that process. They operate at different parts of the harness and compose through Pi's public extension APIs.

## What SoL-Pi Adds

| Area | Mechanism | What changes |
|---|---|---|
| Tools | **Action Fusion** | An edit or write can run its follow-up validation command in the same tool call. |
| Observations | **ObservationPack** | Repeated large text results become stable handles with exact paged recall. |
| Delegation | **Evidence-Preserving Reducer** | Long diagnostic logs become compact receipts only when every retained quotation matches the archived source. |
| Context | **Online Context Compact** | Completed plan steps become candidate points for Pi's native compaction, subject to economic and window-pressure checks; after a successful compaction, Pi continues the task in a new turn. |
| Context (experimental, this fork) | **Live Compact** | Long sessions stay near configured context levels (default 70–80% of the window): only as many older large tool results as needed become verbatim head/tail cards with exact recall, instead of a deep native summary. |

The mechanisms share four rules:

- **No Pi patches.** SoL-Pi imports public Pi APIs and does not vendor the Pi source tree.
- **Explicit opt-in.** A missing configuration leaves every mechanism disabled.
- **Preserve evidence.** Original observations remain available locally, and reducer failures leave the original result unchanged.
- **Use Pi's runtime choices.** Authentication, provider URLs, and the main model remain under Pi's control.

## Changes in this fork

The upstream base is `2195680` (NVlabs/SoL-Pi `main`). Every change is on this fork's `main` branch. With `liveCompact` absent or disabled, every upstream mechanism behaves as before.

**Live Compact (new, experimental, opt-in)**

The new mechanism lives in `src/sol-pi/extensions/live-compact/`:

- **Pressure-driven condensing.** Nothing happens below the start level. At each completed turn, Live Compact estimates the next request's input, calibrated against provider usage. When the context is over the ceiling, or the next turn would carry it over, the oldest eligible tool results are condensed until the context is back at the target.
- **Persisted through Pi's public boundary.** Cards are `context_edit` session entries written at Pi's `turn_end` boundary, which needs Pi 0.87 or newer. Pi's own compaction threshold, forks, tree navigation, and resumed sessions see the same condensed context, and raw entries are never modified.
- **Recall.** The original is archived before its card is written. `obs_recall` returns the original page by page; when the archive is missing, as after a fork or a moved session, it rebuilds the original from the branch history.
- **Protection.** These stay verbatim:
  - the most recent complete tool rounds (default 3);
  - user and assistant text;
  - error results;
  - results with images or mixed content;
  - recall output;
  - reducer receipts;
  - results whose tool call cannot be found.
- **Safe levels.** The levels stay under both the safe input limit and Pi's own compaction threshold, so Pi's deep native compaction does not run first.
- **Configuration.** Levels, protection, and excerpt sizes are set in `liveCompact` in `sol-pi.json`. The runtime loader and the CLI preflight share one schema, in `src/sol-pi/live-compact-config.mjs`. `/live-compact` shows the current state.

**Other changes**

- **Pi version.** The development dependency moved from Pi 1.3.0 to Pi 1.5.2, because Pi 1.3.0 pins `undici` 8.10.2, which has a high-severity advisory. Pi 1.5.2 joins the tested set and is the documented install default.
- **Existing mechanisms.** ObservationPack gained a `legacyProjection` option, and Online Context Compact gained an `economicCompaction` option. Live Compact switches both off: ObservationPack then only archives and serves `obs_recall`, and Online Context Compact stops price-driven compaction. On Pi older than 0.87, Live Compact is not registered and both keep their standard behavior.
- **Action Fusion tool activation.** Action Fusion no longer re-activates an `edit` or `write` tool that another extension turned off before it registered its replacements, for example pi-hashline-edit-pro, which uses anchored edit tools, or pi-openai-codex-compat, which uses `apply_patch`. With a tool allowlist such as `--tools`, re-registering a tool used to activate it again. Tools that were active still get `then_run`.
- **Action Fusion ownership notice.** Pi keeps the first registration of a tool name in extension load order. When an extension loaded earlier provides `edit` or `write`, such as pi-cc-extensions' rich-diff `write`, Action Fusion's tool never takes effect. At the first prompt Action Fusion now names that extension once and points to the fix: load SoL-Pi first, or set `actionFusion: false`.
- **Preflight.** `scripts/check-sol-pi-config.mjs` validates `liveCompact` and accepts `--require-live-compact`. The new `sol-pi.live-compact.example.json` gives a ready Live Compact profile.
- **Tests.** Two existing tests depended on the environment and were fixed: one on the checkout path, one on Pi 1.5's renderer theme. New tests cover the config schema, the pure policy, real Pi `AgentSession` runs, and a real CLI startup.

Live Compact does not do these yet:

- **Admission check before each request.** A single very large paste or tool batch is not intercepted before it is sent.
- **Bounded prefix summaries.** When condensing tool results is not enough, Pi's native compaction still runs, with a warning.
- **Background summaries.**

The design and the status of each stage are in [docs/live-compact-plan.md](docs/live-compact-plan.md), and the configuration spec is in [docs/live-compact-config-plan.md](docs/live-compact-config-plan.md).

## Technical Details and Core Insights

Read the [SoL-Pi blog](https://nvlabs.github.io/SoL-Pi/) for a deeper look at the technical details, design rationale, and core insights behind SoL-Pi, including how auto-research led to the four efficiency mechanisms and how they work.

## Paper

Read our paper: [SoL-Pi: Recursively Scaling Auto-Research Loops for Efficient Agent Harness](https://arxiv.org/abs/2609.20519).

## Getting Started

### Requirements

- Node.js 22.19 or newer
- npm
- `@earendil-works/pi-coding-agent` 0.84.2 or newer; tested with 0.84.2, 1.0.4, 1.3.0, and 1.5.2. Install 1.5.2: a fresh install of Pi 1.0.x or 1.1.0 now fails to start, because those releases do not pin their internal packages. Other versions are untested: `scripts/check-pi-compat.mjs` warns on them, and `--strict` fails.

### Install

Install the latest tested Pi release:

```bash
npm install --global @earendil-works/pi-coding-agent@1.5.2
```

Pi 0.84.2 remains supported and tested; install `@earendil-works/pi-coding-agent@0.84.2` instead to stay on it. Live Compact needs Pi 0.87 or newer, and 1.5.2 is the tested version.

Then install SoL-Pi directly from [NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi):

```bash
pi install git:github.com/NVlabs/SoL-Pi
```

To install it only for the current project, use the project-local scope:

```bash
pi install git:github.com/NVlabs/SoL-Pi --local --approve
```

### Configure

SoL-Pi uses a single effective configuration. With the official Pi distribution, it looks for a `sol-pi.json` file in the following locations, in order:

1. `.pi/sol-pi.json` in the current project, if the project is trusted and the file exists;
2. `~/.pi/agent/sol-pi.json` otherwise.

If neither file exists, SoL-Pi uses its built-in defaults. The project-level configuration takes precedence over the user-level configuration; the two files are not merged.

The following conservative configuration enables only the two local mechanisms that make no additional model calls and do not stop an active run:

```json
{
  "version": 1,
  "actionFusion": true,
  "observationPack": true,
  "evidencePreservingReducer": false,
  "onlineContextCompact": false,
  "cacheWriteReadRatio": 12.5
}
```

Enable additional mechanisms only after reviewing their configuration and security implications. SoL-Pi uses no dedicated environment variables; feature flags, the reducer provider/model route, and the compaction ratio are configured in `sol-pi.json`. See [sol-pi.example.json](sol-pi.example.json) for a template listing every key.

For the complete schema, see [Configuration](docs/configuration.md). Coding agents and automated environments should follow the canonical [agent installation and configuration protocol](agents-install.md), which describes an all-enabled configuration checked with `scripts/check-sol-pi-config.mjs --require-all-enabled`.

### Live Compact (experimental)

Live Compact is only in this fork. Install SoL-Pi from the fork instead of upstream:

```bash
pi install git:github.com/yczheng-hit/SoL-Pi                     # user-wide
pi install git:github.com/yczheng-hit/SoL-Pi --local --approve   # current project only
```

To pin an exact revision, append `@<commit>` to the source. A local checkout of the fork also works: `pi install /absolute/path/to/SoL-Pi`.

Configure it by copying [`sol-pi.live-compact.example.json`](sol-pi.live-compact.example.json) to the effective `sol-pi.json`. Then validate the file and confirm that Pi registers the mechanism, without sending a prompt:

```bash
node scripts/check-sol-pi-config.mjs --config /absolute/path/to/effective/sol-pi.json --require-live-compact
printf '{"id":"commands","type":"get_commands"}\n' | pi --offline --approve --no-session --mode rpc
```

The second command must list `live-compact`. Restart Pi after changing the file. In a session, `/live-compact` shows the levels, the context before and after the last boundary, and any shortfall.

These rules apply:

- Live Compact requires `observationPack: true` and `evidencePreservingReducer: false`.
- It is therefore a different profile from the all-enabled installation.
- Thresholds are fractions of the model window; `0.7` means 70%.

Coding agents should follow the `live-compact` profile of the [agent installation and configuration protocol](agents-install.md). Every field and the current limits are described in [Live Compact](docs/configuration.md#live-compact-experimental).

### Pi 1.x and codemode

SoL-Pi is tested with Pi 0.84.2, 1.0.4, 1.3.0, and 1.5.2. All four mechanisms work with Pi codemode in both `codemode.mode: "on"` and `"only"`. In `"only"` mode, the model reaches bash, edit, and write through codemode scripts, and Evidence-Preserving Reducer skips script calls, so it has no effect there. See [Codemode](docs/compatibility.md#codemode) for per-mechanism behavior.

To check the Pi that will load SoL-Pi, install the checkout's dependencies, then run the check from the checkout; `--strict` also fails on an untested Pi version. Without `npm ci`, the check cannot load TypeScript, prints a warning, and fails under `--strict` even on a tested Pi:

```bash
npm ci --ignore-scripts
node scripts/check-pi-compat.mjs --pi-root "$(npm root -g)/@earendil-works/pi-coding-agent"
```

## Storage and Security

ObservationPack and Evidence-Preserving Reducer store session-specific archives under:

```text
<session-directory>/sol-pi/<session-id>/
├── observation-pack/
└── evidence-preserving-reducer/
```

They archive eligible source material in this directory. The archived copies remain local and are not automatically deleted when the Pi session ends. Live Compact keeps its originals in `observation-pack/`. It also writes a decision log without tool content to `live-compact/ledger.jsonl` in the same directory.

With `pi --no-session` or `SessionManager.inMemory()`, Pi provides no session directory. SoL-Pi instead creates a private directory named `sol-pi-<session-id>-<random>/` under the operating system's temporary directory. ObservationPack and Evidence-Preserving Reducer share this directory for the lifetime of the loaded extension. These modes disable Pi's session-log persistence; SoL-Pi still writes archive files for exact recall. Temporary archives are also retained after the session or worker exits so callers can read referenced evidence. Their eventual cleanup follows the host's temporary-file policy or the caller's cleanup, and they are not guaranteed to survive system cleanup or support session recovery.

Online Context Compact stores its state in Pi's session log. After a successful compaction, it starts a new turn and automatically continues the active task; after a failed compaction, it continues the task without compacting and reports the error. Cancelling the compaction or exiting Pi does not trigger automatic continuation.

Evidence-Preserving Reducer may send eligible diagnostic-log content to its configured reducer model using Pi-managed authentication. Review [SECURITY.md](SECURITY.md) before enabling it. Do not enable remote reduction for logs that must remain local.

## Documentation

| Document | Purpose |
|---|---|
| [Configuration](docs/configuration.md) | Config search order, schema, defaults, and trust behavior |
| [Compatibility](docs/compatibility.md) | Supported Pi APIs and standalone integration details |
| [Security](SECURITY.md) | Local storage, remote reduction, and sensitive behavior |
| [Agent installation](agents-install.md) | Reproducible installation and validation procedure for the `all-enabled` and `live-compact` profiles |
| [Live Compact plan](docs/live-compact-plan.md) | Live Compact design, Pi event-order findings, staged plan, and implementation record |
| [Live Compact configuration spec](docs/live-compact-config-plan.md) | Full `liveCompact` schema, including fields reserved for later stages |
| [Development handoff](docs/development-handoff.md) | Status and next steps for continuing this fork |

## Development

Install from the lockfile and run the complete source checks:

```bash
npm ci --ignore-scripts
npm run check
npm audit --audit-level=high
npm run check:pi
```

`npm run check` covers TypeScript, the complete test suite, and package inspection. `npm run check:pi` runs `scripts/check-pi-compat.mjs` against the development dependency; pass `-- --strict` to fail on warnings, or `-- --pi-root <dir>` to check another Pi installation. The development dependency set is pinned to Pi 1.5.2. To check another tested Pi version, install its four Pi packages over the development dependency (for 1.0.4 also `pi-codemode`, `pi-mcp` and `chord` at 1.0.4) and rerun the checks; runtime Pi packages remain peer dependencies so Pi owns their installation and upgrades.

## Project Status

SoL-Pi is developed and maintained by NVIDIA as a standalone extension for Pi.

We welcome tested, Pi-compatible extension PRs that improve token efficiency and reduce token cost. Our team will help benchmark contributions, publish results on a regular reporting cycle, and credit authors of accepted PRs as Contributors. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Acknowledgements

SoL-Pi builds on the public extension interfaces provided by [Pi](https://github.com/earendil-works/pi). Pi remains an independent upstream project and is not vendored into this repository.

## License

SoL-Pi is released under the [MIT License](LICENSE).

## Star History

<a href="https://www.star-history.com/?repos=NVlabs%2FSoL-Pi&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/NVlabs/SoL-Pi/star-history/star-history-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/NVlabs/SoL-Pi/star-history/star-history-light.svg" />
    <img alt="SoL-Pi star history chart" src="https://raw.githubusercontent.com/NVlabs/SoL-Pi/star-history/star-history-light.svg" width="100%" />
  </picture>
</a>
