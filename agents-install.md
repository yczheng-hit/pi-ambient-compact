# SoL-Pi Agent Installation and Configuration Protocol

This is the canonical procedure for Codex, Claude Code, and other coding agents that install, configure, or validate SoL-Pi from a full source checkout. Follow the phases in order. Explicit user instructions take precedence. An extracted npm package is not a substitute for the checkout because it does not contain the test suite.

Installation and configuration are complete only when Pi remains unmodified, the repository checks pass, Pi lists the package, one effective `sol-pi.json` matches the selected configuration profile, and Pi starts without an extension error. With the default `all-enabled` profile, all four mechanisms are enabled. With the `live-compact` profile, Live Compact is enabled and Pi registers its `/live-compact` command.

## Rules

- Do not modify, patch, fork, or vendor upstream Pi. SoL-Pi must load as a standalone extension through Pi's public package interface.
- Use Node.js 22.19 or newer and a tested Pi release: `@earendil-works/pi-coding-agent@1.5.2` (latest tested, the default), `@earendil-works/pi-coding-agent@1.3.0` (tested), or `@earendil-works/pi-coding-agent@0.84.2` (supported floor). `@earendil-works/pi-coding-agent@1.0.4` is also tested, but do not install it or any other Pi 1.0.x or 1.1.0 release fresh: those releases do not pin their internal packages, so a fresh install now pairs them with newer ones and Pi fails to start. Treat any other Pi version as a compatibility change: `scripts/check-pi-compat.mjs --strict` rejects it, so use it only on explicit user direction and after the full suite passes against it.
- Do not clean, reset, switch, or overwrite unrelated repository changes.
- Do not print, log, commit, upload, or include any secret in a command line. Check only whether a credential is present.
- Keep SoL-Pi settings in `sol-pi.json`. The Evidence-Preserving Reducer provider/model route is a SoL-Pi setting; provider URLs, credentials, the main agent model, and shell behavior remain Pi settings.
- Keep persistent artifacts under Pi's session-derived `sol-pi/<session-id>/` root. For `--no-session` and in-memory sessions, use the automatic private directory under the system temporary directory; do not configure a separate storage path. Temporary archives remain after worker exit for callers to read, with cleanup managed by the host or caller.
- Pi codemode (`codemode.mode` `"on"` or `"only"`) is a Pi setting. SoL-Pi works with either and needs no configuration for it; see [Codemode](docs/compatibility.md#codemode).

## Inputs

Resolve these values before making changes:

- `sol_pi_root`: absolute path to the intended SoL-Pi checkout;
- `target_project`: project in which Pi will run;
- install scope: project-local or user-wide;
- exact SoL-Pi branch and commit;
- configuration profile: `all-enabled` (the default) or `live-compact`. Select `live-compact` only when the user asks for Live Compact, the high-retention context mode. The two profiles are mutually exclusive, because Live Compact requires the Evidence-Preserving Reducer to be off.

Do not guess an ambiguous path or install scope.

## Phase 1: validate the checkout

From `sol_pi_root`, record the repository state without changing it:

```bash
git status --short --branch
git rev-parse HEAD
node --version
npm --version
```

Require Node.js 22.19 or newer. Install from the lockfile and run the source checks:

```bash
npm ci --ignore-scripts
npm run check
npm audit --audit-level=high
node scripts/check-pi-compat.mjs --strict
npx vitest run tests/all-mechanisms.test.ts
```

`npm run check` covers type checking, the complete test suite, and package inspection. These checks run against the checkout's development dependency, Pi 1.5.2. `tests/all-mechanisms.test.ts` confirms that one all-enabled configuration registers all four mechanisms against Pi's public extension API. The tests run without a model provider.

Stop if any command fails. Do not hide a failure with `|| true` or replace `npm ci` with an unlocked install.

For the `live-compact` profile, the checkout must contain Live Compact. Upstream NVlabs/SoL-Pi does not contain it yet; it is developed on the `feat/local-context-policy` branch of the `yczheng-hit/SoL-Pi` fork. Confirm before continuing, and stop if the file is missing:

```bash
test -f src/sol-pi/extensions/live-compact/index.ts
```

## Phase 2: install Pi and SoL-Pi

Install the tested Pi release without changing its source. Use `1.5.2` unless the user asked for `1.3.0` or `0.84.2`. Pi 1.3.0 pins `undici` 8.10.2, which has a high-severity advisory; prefer 1.5.2:

```bash
npm install --global --ignore-scripts @earendil-works/pi-coding-agent@1.5.2
pi --version
```

Require `pi --version` to report the version you installed. From `sol_pi_root`, check that installed Pi against the APIs SoL-Pi uses:

```bash
node scripts/check-pi-compat.mjs --strict --pi-root "$(npm root -g)/@earendil-works/pi-coding-agent"
```

Require exit status 0. The output must name the installed version; with `--strict`, an untested version fails.

For the `live-compact` profile, Pi must be 0.87.0 or newer, and the tested version is 1.5.2. Older Pi lacks the `turn_end` boundary entries that Live Compact writes, so SoL-Pi leaves Live Compact unregistered and only shows a warning. If Pi is already installed at another version, report it; for example, Pi 1.5.0 passes the API checks but fails `--strict` as untested. Install 1.5.2 only with the user's agreement, then re-run the strict check.

For a project-local registration, run this from `target_project` and substitute the resolved absolute `sol_pi_root`:

```bash
pi install "/absolute/path/to/SoL-Pi" --local --approve
pi list --approve
```

For a user-wide registration, omit `--local`:

```bash
pi install "/absolute/path/to/SoL-Pi" --approve
pi list --approve
```

The `pi list` output must show the exact SoL-Pi source in the selected scope. Do not install the same checkout in both scopes. A project-local registration must run only in a trusted project; use `--approve` for automated invocations unless trust has already been explicitly persisted.

## Phase 3: configure the selected profile

SoL-Pi defaults every mechanism to disabled. Create exactly one effective configuration for the selected profile. Phase 3A is the `all-enabled` profile; Phase 3B is the `live-compact` profile. The location, merge, trust, and secret rules after Phase 3B apply to both.

### Phase 3A: `all-enabled` profile

Enable every mechanism:

```json
{
  "version": 1,
  "actionFusion": true,
  "observationPack": true,
  "evidencePreservingReducer": true,
  "evidencePreservingReducerProvider": "provider-id",
  "evidencePreservingReducerModel": "model-id",
  "onlineContextCompact": true,
  "cacheWriteReadRatio": 12.5
}
```

`evidencePreservingReducerProvider` and `evidencePreservingReducerModel` select the nested reducer route that Evidence-Preserving Reducer resolves through Pi's model registry. They default to the built-in reducer route and must be non-empty strings when supplied. Change them only when a different reducer model is intended.

### Phase 3B: `live-compact` profile

Start from [`sol-pi.live-compact.example.json`](sol-pi.live-compact.example.json), which contains this configuration:

```json
{
  "version": 1,
  "actionFusion": true,
  "observationPack": true,
  "evidencePreservingReducer": false,
  "onlineContextCompact": true,
  "cacheWriteReadRatio": 12.5,
  "liveCompact": {
    "enabled": true,
    "thresholds": { "startRatio": 0.7, "targetRatio": 0.7, "ceilingRatio": 0.8 },
    "protection": { "keepRecentToolRounds": 3, "minFullRequests": 2 },
    "observation": { "minBytes": 10240, "excerptTargetBytes": 8192 }
  }
}
```

The rules for this profile:

- `observationPack` must be `true`, and `evidencePreservingReducer` must be `false`.
- `actionFusion` and `onlineContextCompact` are optional. With Live Compact on, Online Context Compact keeps `update_plan` but does not run price-driven compaction.
- Change a `liveCompact` value only when the user asks for it. Ratios are fractions, so `0.7` means 70%, and they must satisfy `0 < targetRatio <= startRatio < ceilingRatio < 1`.
- The `summary`, `verification`, and `background` groups are validated but not used yet, and `background.enabled: true` is rejected.

See [Live Compact](docs/configuration.md#live-compact-experimental) for every field and the current limits.

### Shared configuration rules

`cacheWriteReadRatio` is the only pricing-related input SoL-Pi reads. It defaults to `12.5`, accepts any finite non-negative number, and treats `0` as an explicit statement that a cache write adds no cost relative to a cache read. SoL-Pi does not inspect Pi model prices. The value controls one compaction decision and is not a bill estimate. The default follows the GPT-5.6 Sol OpenAI Standard cache-write/read ratio checked on 2026-08-21; see [OpenAI API pricing](https://developers.openai.com/api/docs/pricing). Change it when a different policy is required.

Use one location matching the selected scope. Resolve the directory through Pi; the official Pi defaults are shown in parentheses:

- project-local: `<target_project>/<Pi config directory>/sol-pi.json` (`<target_project>/.pi/sol-pi.json`);
- user-wide: `<Pi agent directory>/sol-pi.json` (`~/.pi/agent/sol-pi.json`).

SoL-Pi uses Pi's public `CONFIG_DIR_NAME` and `getAgentDir()` APIs. Do not assume the defaults when Pi reports different directories.

The project file replaces the user-wide file; the two are not merged. If both exist, inspect them and obtain direction before changing either one. Unknown keys, unsupported versions, malformed JSON, non-boolean feature values, invalid reducer model fields, and invalid ratios must remain fatal.

Do not put provider URL, credentials, shell path, command prefix, storage path, or run ID in `sol-pi.json`. SoL-Pi either reads those values from Pi or derives them from the Pi session.

SoL-Pi reads no dedicated environment variables. Evidence-Preserving Reducer uses the configured reducer provider/model route and Pi-managed authentication. Configure credentials in Pi and do not copy them into `sol-pi.json`.

From `sol_pi_root`, validate the exact effective file:

```bash
node scripts/check-sol-pi-config.mjs \
  --config /absolute/path/to/effective/sol-pi.json \
  --require-all-enabled
```

Require exit status 0 and retain its JSON output. The check applies SoL-Pi's default values, rejects unknown keys and wrong types, and confirms all four mechanisms are enabled. A partially enabled file can be valid SoL-Pi configuration, but it does not satisfy this all-enabled profile.

For the `live-compact` profile, replace `--require-all-enabled` with `--require-live-compact`:

```bash
node scripts/check-sol-pi-config.mjs \
  --config /absolute/path/to/effective/sol-pi.json \
  --require-live-compact
```

Require exit status 0 and `"live_compact_enabled": true` in the output. The check also rejects a Live Compact configuration with `observationPack` off or `evidencePreservingReducer` on. The two `--require-*` flags cannot be combined.

## Phase 4: verify the installation

1. Run `pi list --approve` from `target_project` and confirm the expected SoL-Pi source and scope.
2. Run `check-sol-pi-config.mjs` with the flag for the selected profile (`--require-all-enabled` or `--require-live-compact`) against the effective `sol-pi.json`, and re-run `check-pi-compat.mjs --strict --pi-root` against the installed Pi.
3. Re-run `npx vitest run tests/all-mechanisms.test.ts` from `sol_pi_root`.
4. Start Pi with `--offline --approve`, send no prompt, confirm there is no extension load error, and exit. For the `live-compact` profile, run this check from `target_project` instead, so it reads the effective configuration. It sends no prompt:

   ```bash
   printf '{"id":"commands","type":"get_commands"}\n' | pi --offline --approve --no-session --mode rpc
   ```

   Require a response with `"id":"commands"` whose `data.commands` includes `live-compact`, and no extension error on stderr. If the command is missing, Pi is older than 0.87 or the configuration did not enable Live Compact.
5. Confirm that upstream Pi was not patched and that the SoL-Pi checkout contains no vendored Pi monorepo source.

## Completion report

Report:

- SoL-Pi absolute path, branch, and commit;
- repository state before and after installation;
- Node, npm, and Pi versions, and the `check-pi-compat.mjs` result for the installed Pi;
- install scope and the exact entry shown by `pi list`;
- configuration profile;
- effective config path, four enabled flags, EPR reducer provider/model, and `cacheWriteReadRatio`, without secrets;
- for `live-compact`: the effective `liveCompact` thresholds and protection values, and whether `/live-compact` was registered;
- every validation command and result;
- any blocker or deviation.

Do not describe the installation as successful if a required check is missing.

## Agent entry files

`agents-install.md` is the single source of truth, but agents do not universally auto-discover arbitrary filenames. Root `AGENTS.md` tells Codex to read this file, while root `CLAUDE.md` imports it for Claude Code. Keep those entry files short and keep executable installation details here.

- [Codex `AGENTS.md` discovery](https://developers.openai.com/codex/guides/agents-md)
- [Claude Code project memory and imports](https://docs.anthropic.com/zh-CN/docs/claude-code/memory)
