<p align="center">
  <img src="assets/sol-pi-hero.png" width="100%" alt="pi-ambient-compact: Ambient Context Compaction for Pi" />
</p>

# 🌊 pi-ambient-compact：面向 Pi 的黄金区间无感上下文维护扩展

<p align="center">
  <strong>中文</strong> · <a href="README.en.md">English</a> · <a href="docs/configuration.md">配置文档</a> · <a href="docs/compatibility.md">兼容性</a> · <a href="agents-install.md">AI 安装协议</a> · <a href="LICENSE">MIT License</a>
</p>

> [!NOTE]
> **`pi-ambient-compact`** 是面向 [Pi](https://github.com/earendil-works/pi) 的独立上下文管理与工具效率扩展。
> 本项目深度融合并演进了两个上游工程的核心思想：
> - **[NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi)**（[arXiv:2609.20519](https://arxiv.org/abs/2609.20519)）：提供零侵入的公开 Pi 扩展架构、内容寻址原文归档与分页召回（`ObservationPack` / `obs_recall`）、在线压缩协调生命周期（`Online Context Compact`）、编辑验证融合（`Action Fusion`）以及证据保真规约器（`Evidence-Preserving Reducer`）。
> - **[Tranquillitatis-Lab/dsh-live-compact](https://github.com/Tranquillitatis-Lab/dsh-live-compact)**：提供轮次边界的水位压力控制、最近完整工具轮（Recent Tool Rounds）保护、工具调用与返回配对闭包检查、以及“先归档再替换”的安全准则。

---

## 💡 核心理念：有下限、有上限、在 30%–70% 黄金区间无感自动维持

在数小时的编码、调试与定时巡检长会话中，传统的上下文管理往往陷入两个极端：要么等到 95%+ 触发原生全量压缩，把几十万 token 的历史一次性**“剃光头”**（默认仅留约 20K 近期尾部），导致早期约束、否定条件和已排查路径丢失；要么每轮频繁改写历史，导致 Prompt Cache 不断失效、等待时间变长。

**`pi-ambient-compact`** 以 **AI 性能（约束与证据保真）> 用户体验 >> token 开销** 为优先级，将上下文稳定控制在 **30%–70% 黄金工作区间**：

1. **🛡️ 有下限（高保真、绝不“剃光头”）**
   - **关键上下文原样保留**：用户全部原始消息与约束、系统提示、最近 N 个完整工具轮（默认 3 轮，单轮并行调用不拆散）、报错/非纯文本工具结果、以及最新回答永远保持原文，绝不参与压缩。
   - **Summary + Verification 双模型质量门**：由 `summary` 模型（可配快模型，如 DeepSeek Flash）全局挑选已完成的历史片段并生成摘要，再由 `verification` 模型（可配强模型，如 Gemini / Claude）对照 `<original>` 原文逐段挑刺核验。凡是遗漏失败信息、篡改路径/数字/版本号、把“尝试”写成“已完成”或复述工具输出中提示注入（Prompt Injection）的摘要一律打回重做；重做仍不合格则宁可保留原文。
   - **100% 落盘归档与无损召回**：每次替换前先做内容寻址（SHA-256）归档。模型随时可通过 `context_recall`（整段历史召回）与 `obs_recall`（大工具输出分页召回）按字节偏移量读取逐字原文；即便跨 fork 或归档文件缺失，也能从当前会话分支的原始记录自愈重建。
2. **🚧 有上限（严格防超窗、防死锁）**
   - **真实 Token 动态校准**：根据服务商返回的真实 `usage` 实时校准字符/token 比例（消除中文与 JSON 内容约 2 倍的估算偏差），扣除真实输出预留与安全余量得出 `safeInputLimit`，并始终保持在 Pi 原生压缩阈值之下。
   - **多级安全防线**：达到紧迫线（默认 80%）时自动跨过冷却与最低收益限制立即维护；单次超大输入在发送前自动先触发一轮即时维护，仍放不下则拦截提示；在紧迫线以上若遇模型限流（429/5xx），除单轮内自动退避重试（5s → 15s）外，每 2 分钟或切换模型路由后立即可重试，绝不会因“输入被拦 + 退避等待增长”而死锁。
3. **🌊 在 30%–70% 黄金区间里无感自动维持**
   - **低于启动线（如 70%）零干预**：完全不改写任何历史前缀，保持纯追加（Append-only），100% 保护服务商 Prompt Cache 命中率。
   - **到达水位集中整理一次**：当上下文升至约 70% 时，在轮次边界（`turn_end` 或 `agent_before_settle`）触发一次全局选择性压缩，一次性回落至 **30%–50%** 的黄金区间，随后进入冷却期（默认间隔 12 次真实请求），让后续数十轮继续享受高缓存命中与充裕窗口。

---

## 📊 与两个参考工程的功能对比

| 维度 | NVlabs/SoL-Pi（上游基座） | dsh-live-compact（参考工程） | **pi-ambient-compact（本工程）** |
|---|---|---|---|
| **核心目标** | 降低 token 成本与重复工具轮次 | 按水位收短旧工具输出，防止单次爆窗 | **AI 性能优先**：在 **30%–70% 黄金区间**高保真自动维持 |
| **触发机制** | 依赖 `update_plan` 计划步骤完成边界 + 缓存读写经济比（`cacheWriteReadRatio`） | 轮次结束后按固定水位检查，仅针对工具输出做多轮局部替换 | **双边界水位状态机**（`turn_end` + `agent_before_settle`）+ 冷却请求数 + 最小回收收益门控 |
| **压缩范围与粒度** | `ObservationPack` 在 2 次请求后无条件替换 >10KiB 工具输出；`OCC` 调用 Pi 原生全量深压缩 | 仅收短旧的 `toolResult`，不处理冗长的 `assistant` 推理/代码参数或重复巡检轮次 | **全局片段级（Episode + Tool Rounds）+ 工具级双策略**：支持合并完整历史问答轮、连续工具轮与大工具输出 |
| **下限保护（防“剃光头”）** | 原生压缩默认仅保留约 20K token 尾部，早期长历史被概括为单段摘要 | 保护最近 N 个完整工具轮，但缺乏跨轮次的语义级筛选 | **保留全部用户指令 + 最近 N 个完整工具轮 + 错误现场 + 最新回答**，回落目标可设在 **30%–50%** |
| **上限保护（防超窗）** | 依赖 Pi 原生阈值与溢出恢复 | 局部收短不足时退回原生压缩 | **真实 usage 动态校准 + 输出空间预留 + 超大输入即时压缩/准入拦截 + 超限安全暂停 + 2 分钟防死锁重试** |
| **AI 摘要质量门** | `EPR` 仅针对单条长日志做逐字引用校验；会话压缩无独立核验模型 | 无双模型生成/核验闭环 | **`Summary`（生成）+ `Verification`（对照原文挑刺核验）双模型独立路由**，不合格有界重做，防幻觉与提示注入 |
| **崩溃安全与原子性** | 单条替换或原生单条 compaction | 基于内部会话事务与备份回滚 | **前缀安全排序批次**（先删 `toolResult` → 再删 `assistant` → 最后替换）+ 批次起止标记 + 崩溃后内存补全与下轮自动恢复 |
| **原文归档与召回** | `obs_recall`（仅召回单条工具输出） | 本地文件备份工具输出 | **`context_recall`（召回整段被摘要的历史消息）+ `obs_recall`（召回工具输出）**，归档缺失时可从分支自愈重建 |
| **交互配置与跨会话同步** | 仅支持手动编辑 `sol-pi.json` 并重启 Pi | 命令行与静态配置 | **`/ambient-compact` 交互式 TUI 设置面板**（同 `/codex-settings` 体验）：搜索、选模型、调水位、单会话覆写 `~`、`.settings-lock` 原子保存与**多会话自动热加载** |
| **工具生态兼容性** | `Action Fusion` 在 `session_start` 重注册 `edit`/`write` 在白名单下可能误激活已禁用工具 | 需配合特定后端或补丁环境 | **纯 Pi 公开扩展接口（零补丁）**：保持 `pi-hashline-edit-pro` / `apply_patch` 的工具禁用状态，被 `pi-cc-extensions` 覆盖时主动提示 |

---

## 🧩 当前功能与架构概览

本扩展包含在单一包 `pi-ambient-compact` 中，所有机制均通过 Pi 公开扩展 API 装配，默认按需显式开启：

| 模块 | 策略 / 工具 / 命令 | 功能说明 |
|---|---|---|
| **Ambient Compact (`dynamic-ai`)** | `/ambient-compact`（别名 `/live-compact`）、`context_recall` | **全局 AI 选择性压缩策略（推荐）**：在 30%–70% 区间自动评估完整历史片段（Episodes & Tool Rounds），经 `summary` + `verification` 双模型生成并核验摘要，原文归档可通过 `context_recall` 分页召回。 |
| **Ambient Compact (`local-tools`)** | `/ambient-compact`（别名 `/live-compact`）、`obs_recall` | **本地零模型收短策略**：不调用摘要模型，仅在突破水位上限时将最旧的 >10KiB 纯文本成功工具输出替换为带 SHA-256 与首尾逐字摘录（默认 8KiB）的卡片。 |
| **ObservationPack** | `obs_recall` | 为大型纯文本工具输出提供内容寻址归档与精确字节/行分页召回；在开启 Ambient Compact 时自动移交投影控制权，仅负责归档与 `obs_recall` 召回。 |
| **Online Context Compact** | `update_plan` | 提供结构化工作计划工具 `update_plan`；在未开启 Ambient Compact 时可按 `cacheWriteReadRatio` 经济比在步骤完成边界触发压缩，开启 Ambient Compact 后自动关闭价格触发以避免深压缩冲突。 |
| **Action Fusion** | `edit` / `write` (`then_run`) | 为内置 `edit` 和 `write` 增加可选的 `then_run` 跟进验证命令；自动尊重 `pi-hashline-edit-pro` 与 `pi-openai-codex-compat` (`apply_patch`) 的工具禁用状态，若被其他扩展覆盖则在首次提问时主动提示。 |
| **Evidence-Preserving Reducer** | `delegate_Read` / `delegate_Bash` | 在旧模式下将超长诊断日志交由规约模型提炼为带逐字引用的结构化收据（与 `liveCompact.enabled: true` 互斥）。 |

---

## 🖥️ 使用方式与交互式设置面板

### 1. 交互式 TUI 设置面板（`/ambient-compact`）

在 Pi 的 TUI 模式下，直接输入 **`/ambient-compact`**（或 `/ambient-compact settings`，兼容别名 `/live-compact`），即可打开与 `/codex-settings` 完全一致的交互式设置面板：

- **即时搜索**：直接输入字符即可按名称、配置键名或描述过滤设置项。
- **水位与模型自由调节**：
  - **Compaction strategy**：在 `dynamic-ai`（全局 AI 压缩）与 `local-tools`（本地工具输出收短）之间切换；
  - **Summary model / Verification model**：自动读取 Pi `modelRegistry` 中所有已注册模型供上下选择，也支持选择 `Working model`（跟随当前主模型）或 `Custom (provider/model)…` 手动输入路由（如 `nvidia-inference/nvidia/deepseek-ai/eccn-deepseek-v4.1-flash-1017`）；
  - **Start threshold / Target level / Urgent ceiling**：支持 `30%`、`40%`、`50%`、`60%`、`70%`、`80%` 等预设或自定义百分比（自动校验 `0 < target ≤ start < ceiling < 100`）；
  - **保护与维护预算**：支持修改 `Keep recent tool rounds`（默认 3 轮）、`Min cycle savings`（默认 10%）、`Cooldown requests`（默认 12 次）、`Retry growth after failure`（默认 5%）、`Max model calls per cycle`（默认 4 次）及超时时间。
- **草稿（`*`）、单会话应用（`~`）与跨会话热加载保存（`Ctrl+S`）**：
  - 修改后的选项先标为草稿 `*`，不会立即写盘；
  - 在底部动作栏选择 **Apply to session**：仅应用到当前会话（显示 `~` 标记，写入会话条目，不修改磁盘上的 `sol-pi.json`）；
  - 按 **`Ctrl+S`** 或选择 **Save and close**：通过 `.settings-lock` 文件锁和字段 SHA-256 冲突检测，原子写入 `~/.pi/agent/sol-pi.json`（或受信任项目的 `.pi/sol-pi.json`）；**其他正在运行的 Pi 会话会在下一轮自动热加载更新后的磁盘配置**，同时保留各自会话内的单独覆写；
  - 选择 **Run maintenance now**：直接在面板内立即触发一轮维护压缩，顶部状态栏实时显示结果；
  - 按 **`F1`**（或选择 **Details, errors, and save target**）：查看当前水位百分比、有效模型路由来源、最近一次边界与压缩详情以及保存目标路径；
  - 按 **`Esc`**：取消当前子编辑器，或丢弃未应用的草稿并关闭面板。

### 2. 命令行子命令

在 TUI 或非 TUI 模式下均可直接使用子命令（`/ambient-compact` 与 `/live-compact` 均支持）：

| 命令 | 作用 |
|---|---|
| `/ambient-compact` 或 `/ambient-compact settings` | 在 TUI 模式下打开交互式设置面板（非 TUI 模式下输出当前状态） |
| `/ambient-compact status` | 查看当前水位（Start / Target / Urgent / Safe Input）、生效模型路由及来源、最近一次维护结果 |
| `/ambient-compact now` | 跳过冷却、退避与最小收益限制，立即执行一轮维护压缩（下一次请求即生效，并在下一边界持久化） |
| `/ambient-compact model` | 查看当前生效的 `summary` 与 `verification` 模型路由及来源（`session` / `global` / `startup`） |
| `/ambient-compact model summary <provider>/<model>` | 仅在当前会话覆盖生成摘要的模型（将 `summary` 换为 `verification` 可设置核验模型） |
| `/ambient-compact model summary default` | 清除当前会话的模型覆盖，恢复继承全局或启动配置 |
| `/ambient-compact model summary <provider>/<model> --global` | 校验并原子写入有效 `sol-pi.json`，其他正在运行的会话在下一轮自动热加载生效 |

---

## ⚙️ 推荐配置示例（`sol-pi.json`）

配置文件位于用户级 `~/.pi/agent/sol-pi.json` 或受信任项目级 `<project>/.pi/sol-pi.json`（项目级文件存在时整体替换用户级文件，两者不合并）。

以下为推荐的 **30%–70% 黄金区间 `dynamic-ai` 模式**配置：

```json
{
  "version": 1,
  "actionFusion": false,
  "observationPack": true,
  "evidencePreservingReducer": false,
  "onlineContextCompact": true,
  "cacheWriteReadRatio": 12.5,
  "liveCompact": {
    "enabled": true,
    "strategy": "dynamic-ai",
    "thresholds": {
      "startRatio": 0.7,
      "targetRatio": 0.5,
      "ceilingRatio": 0.8
    },
    "protection": {
      "keepRecentToolRounds": 3,
      "minFullRequests": 2
    },
    "observation": {
      "minBytes": 10240,
      "excerptTargetBytes": 8192
    },
    "summary": {
      "provider": "nvidia-inference",
      "model": "nvidia/deepseek-ai/eccn-deepseek-v4.1-flash-1017",
      "maxOutputTokens": "auto",
      "timeoutMs": 120000
    },
    "verification": {
      "maxOutputTokens": "auto",
      "timeoutMs": 120000
    },
    "maintenance": {
      "minSavingsRatio": 0.1,
      "cooldownRequests": 12,
      "retryGrowthRatio": 0.05,
      "maxCallsPerCycle": 4,
      "timeoutMs": 300000
    }
  }
}
```

- 希望回落更深（如压回 35%–40%）时，可将 `thresholds.targetRatio` 设为 `0.35` 或 `0.4`（或在 `/ambient-compact` 面板中调整 `Target level`）。
- `verification` 省略 `provider`/`model` 时默认跟随当前工作主模型；若主模型为 Claude 且希望避免 Anthropic 蒸馏分类器误拦核验请求，可通过 `/ambient-compact` 将 `Verification model` 设为 Gemini 或 DeepSeek。
- `cacheWriteReadRatio` 仅在旧模式 `Online Context Compact` 经济触发中使用，默认 `12.5`，不会读取或推断模型价格字段。
- 完整字段说明见 [配置文档](docs/configuration.md)，Codemode 兼容说明见 [Codemode](docs/compatibility.md#codemode)。

---

## 🤖 AI 工具安装与配置索引（AI Agent Installation Guide）

如果你是 **Codex、Claude Code 或 Pi** 等 AI 编程助手，正在帮用户安装、配置或验证本工程，请遵循规范的 [agent installation and configuration protocol](agents-install.md)（仓库根目录的 [`AGENTS.md`](AGENTS.md) 与 [`CLAUDE.md`](CLAUDE.md) 已自动建立入口索引）。

### AI 快速执行清单

1. **完整阅读安装协议**：在执行任何安装或配置命令前，先完整读取 [`agents-install.md`](agents-install.md)。
2. **环境与受测 Pi 版本要求**：
   - 需要 Node.js `>=22.19.0`。
   - 已测试的 Pi 版本包括：`1.5.2`（最新受测默认版本）、`1.3.0`、`1.0.4`、`0.84.2`（最低支持基线，Ambient Compact 需 `>=0.87.0`）。全新安装 Pi 时使用：
     ```bash
     npm install --global @earendil-works/pi-coding-agent@1.5.2
     ```
3. **克隆与本地校验（Phase 1）**：
   ```bash
   git clone https://github.com/yczheng-hit/SoL-Pi.git pi-ambient-compact
   cd pi-ambient-compact
   npm ci --ignore-scripts
   npm run check
   npm audit --audit-level=high
   node scripts/check-pi-compat.mjs --strict
   npx vitest run tests/all-mechanisms.test.ts
   ```
4. **注册到 Pi（Phase 2）**：
   ```bash
   # 全局安装（推荐）
   pi install "/absolute/path/to/pi-ambient-compact" --approve
   # 或直接从 Git 安装
   pi install git:github.com/yczheng-hit/SoL-Pi
   pi list --approve
   ```
5. **写入并校验配置文件（Phase 3 & Phase 4）**：
   - **Ambient Compact 模式（推荐 `live-compact` profile）**：参考 [`sol-pi.live-compact.example.json`](sol-pi.live-compact.example.json) 写入 `~/.pi/agent/sol-pi.json`（可启用 `"strategy": "dynamic-ai"`），然后运行预检：
     ```bash
     node scripts/check-sol-pi-config.mjs \
       --config ~/.pi/agent/sol-pi.json \
       --require-live-compact
     ```
   - **上游四机制全开模式（`all-enabled` profile）**：参考 [`sol-pi.example.json`](sol-pi.example.json)，通过 `scripts/check-sol-pi-config.mjs --require-all-enabled` 运行预检：
     ```bash
     node scripts/check-sol-pi-config.mjs --config ~/.pi/agent/sol-pi.json --require-all-enabled
     ```
   - **RPC 离线启动验证（不发送提示词）**：
     ```bash
     printf '{"id":"commands","type":"get_commands"}\n' | pi --offline --approve --no-session --mode rpc
     ```
     确认返回结果中包含 `ambient-compact`（及 `live-compact`），且 stderr 无扩展错误。

---

## 📚 文档索引

| 文档 | 说明 |
|---|---|
| [English README](README.en.md) | 英文版完整项目说明与使用指南 |
| [AI 安装与配置协议 (`agents-install.md`)](agents-install.md) | 面向 Codex / Claude Code / Pi 的分阶段可复现安装、配置与验收标准 |
| [配置参考 (`docs/configuration.md`)](docs/configuration.md) | 配置文件搜索顺序、`liveCompact` 完整 Schema、TUI 面板与命令说明 |
| [动态全局压缩方案 (`docs/live-compact-dynamic-plan.md`)](docs/live-compact-dynamic-plan.md) | `dynamic-ai` 策略的架构设计、G0–G3 验证记录与真实数据抽样结果 |
| [高保留模式总方案 (`docs/live-compact-plan.md`)](docs/live-compact-plan.md) | 初版水位状态机设计与 P0–P1 实施记录 |
| [兼容性说明 (`docs/compatibility.md`)](docs/compatibility.md) | 支持的 Pi 版本、公开 API 与 [Codemode](docs/compatibility.md#codemode) 兼容性 |
| [安全说明 (`SECURITY.md`)](SECURITY.md) | 本地归档目录、远程模型调用路由与凭据隔离原则 |

## 📄 开源许可与致谢

本项目基于 [MIT License](LICENSE) 开源。感谢 [Pi](https://github.com/earendil-works/pi)、[NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi) 与 [Tranquillitatis-Lab/dsh-live-compact](https://github.com/Tranquillitatis-Lab/dsh-live-compact) 提供的优秀架构与设计启发。
