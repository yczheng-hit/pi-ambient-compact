# Live Compact 配置规范（设计提案）

状态：schema 已在 `feat/local-context-policy` 分支实现，位于 `src/sol-pi/live-compact-config.mjs`，运行时与 CLI 共用，并有一致性测试。本文是 [总方案](live-compact-plan.md) 的配置参考；修改配置解析器、CLI preflight、配置示例或相关测试前先读本文。

各字段当前的生效情况：

- 已生效：`enabled`、`thresholds`、`protection`、`observation`、`limits.batchBudgetMs`、`limits.maxCandidatesPerPass`、`budget`。
- 只校验、尚未使用：`summary`、`verification`、`limits.maxRegenerations`、`background` 的其余字段。
- `background.enabled: true` 在后台功能实现前会被拒绝。

目标不变：**AI 性能 > 用户体验 >> token 开销**。70%/80%、近期保护、模型路由和调度参数是可调整策略；来源隔离、完整性校验和请求安全检查是强制底线。

## 1. 配置入口与分组

统一放在有效 `sol-pi.json` 的 `liveCompact` 对象内：

| 分组 | 负责内容 |
|---|---|
| `enabled` | 新模式开关 |
| `thresholds` | 启动、回落、软上限比例 |
| `protection` | 最近工具轮与完整展示次数 |
| `observation` | 候选大小与摘录目标预算 |
| `summary` | 摘要模型、输出预算、调用超时 |
| `verification` | 核验模型、输出预算、调用超时 |
| `background` | 后台开关、跨会话并发、任务期限与前台等待 |
| `limits` | 有界重做和本地维护批次 |
| `budget` | 在自动安全余量之外额外保留的空间 |

这是取代早期草案平铺字段的规范结构，不同时接受两种写法。此前草案的 `startRatio`、`summaryProvider`、`summaryModel`、`backgroundSummaries` 等没有实现过，不作为兼容别名。原有顶层 SoL-Pi 字段与旧模式兼容性不变。

## 2. 推荐配置示例

下面显式开启新模式，并列出建议初始值；摘要/核验省略 provider/model，默认跟随工作模型。时间、批次和摘录默认值是待 P0–P5 验证的起点，不代表已经测得最佳值或完成时间保证。

```json
{
  "version": 1,
  "observationPack": true,
  "onlineContextCompact": true,
  "evidencePreservingReducer": false,
  "liveCompact": {
    "enabled": true,
    "thresholds": {
      "startRatio": 0.70,
      "targetRatio": 0.70,
      "ceilingRatio": 0.80
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
      "maxOutputTokens": "auto",
      "timeoutMs": 120000
    },
    "verification": {
      "maxOutputTokens": "auto",
      "timeoutMs": 120000
    },
    "background": {
      "enabled": false,
      "maxConcurrentJobs": 1,
      "jobTimeoutMs": 300000,
      "foregroundWaitMs": 15000
    },
    "limits": {
      "maxRegenerations": 1,
      "batchBudgetMs": 50,
      "maxCandidatesPerPass": 8
    },
    "budget": {
      "extraReserveTokens": 0
    }
  }
}
```

只关心水位时，可以仅配置 `liveCompact.enabled` 和 `liveCompact.thresholds`，其余使用默认值。`liveCompact` 缺失或 `enabled` 缺失时默认关闭。

## 3. 字段、默认值与校验

下表路径均相对于 `liveCompact`。除注明的联合类型外不进行字符串/数字/布尔强制转换；整数均要求安全整数，比例必须是有限数值。

### 3.1 水位、保护与局部整理

| 字段 | 建议默认值 | 校验与语义 |
|---|---:|---|
| `enabled` | `false` | 布尔值 |
| `thresholds.startRatio` | `0.70` | 进入维护的输入占窗比例 |
| `thresholds.targetRatio` | `0.70` | 需要整理时的目标比例，不是必须填满的下限 |
| `thresholds.ceilingRatio` | `0.80` | 日常软上限，不取代请求安全上限 |
| `protection.keepRecentToolRounds` | `3` | 1–100；正常保护的完整工具轮数，单轮并行调用不拆开计数 |
| `protection.minFullRequests` | `2` | 1–20；正常路径至少完整展示的已确认 provider 请求数 |
| `observation.minBytes` | `10240` | 正整数；成功纯文本候选须严格大于此 UTF-8 字节数 |
| `observation.excerptTargetBytes` | `8192` | 正整数；逐字摘录目标预算，不含身份/引用元数据，不是所有结果的强制截断长度 |
| `budget.extraReserveTokens` | `0` | 非负整数；只能增加自动安全余量，不能取消输出预留与自动安全余量 |

比例关系必须满足：

```text
0 < targetRatio <= startRatio < ceilingRatio < 1
```

例如，可以设置 60% 开始、回落至 60%、75% 软上限，或 75% 开始、回落至 70%、85% 软上限。数字 `70` 不是 `70%`，会被拒绝。

有效安全预算为：

```text
H = C - O - M_auto - extraReserveTokens
```

`C` 为本次工作模型窗口，`O` 为输出预留，`M_auto` 为自动估计余量。有效水位受 `H` 限制；状态中同时展示配置比例与实际采用的水位。若固定内容/保护范围已无可用空间，明确报告并暂停，不能因为配置更激进就放行超限请求。

摘录可以为避免过度整理而保留更多原文；`excerptTargetBytes` 不会授权跳过证据或净收益检查。若卡片加元数据不比原文小，则跳过候选。紧急准入是显式异常路径，不谎报已经满足最近轮/完整展示保护。

### 3.2 摘要与核验模型

| 字段 | 建议默认值 | 校验与语义 |
|---|---|---|
| `summary.provider` / `summary.model` | 均省略，跟随工作模型 | 两者同时省略或同时为非空字符串；解析到 Pi 已注册路由 |
| `verification.provider` / `verification.model` | 均省略，跟随工作模型 | 同上；不因为摘要用了快模型而自动降级核验 |
| `summary.maxOutputTokens` | `"auto"` | `"auto"` 或正整数；摘要输出上限 |
| `verification.maxOutputTokens` | `"auto"` | `"auto"` 或正整数；核验输出上限 |
| `summary.timeoutMs` | `120000` | 1000–1800000；单次摘要调用总时限，含该调用的网络重试 |
| `verification.timeoutMs` | `120000` | 同上；单次核验调用总时限 |

- 工作模型始终由 Pi 管理；这里配置的是摘要与核验路由，不改变主模型。
- `"auto"` 使用所选路由支持的输出设置，再按该次输入/输出预算限制；显式数值也只是上限，不强迫超出模型能力。有效上限必须可观测；过小导致截断的摘要/核验结果不能通过质量门。
- 两种调用分别检查原始输入、输出和余量。模型窗口太小或路由不可用时明确报错，不静默截输入、换服务商或使用未经核验的结果。
- 质量修复需要重做时，使用配置的核验路由作为可靠重做路由；仍按原核验规则验收。这条选择显示在有效配置中，不额外暗选第三个 provider。
- 跟随工作模型的路由在任务开始时解析并冻结；工作模型切换后，提交前重验适用性。既有任务不在执行中偷偷改路由。
- DeepSeek Flash 等是候选，不写死 provider/model ID。必须使用用户实际配置的 ID，并完成保真与长输入能力评测；注册成功不代表摘要质量已达标。
- 不提供关闭质量核验的开关。核验模型可以配置，但检查存在、来源约束、完整输出及提交复核不能关闭。

独立路由示例：下列为要放进 `liveCompact` 的字段片段；字符串是占位符，不是已确认可用的服务商或模型名称。

```json
{
  "summary": {
    "provider": "your-summary-provider",
    "model": "your-summary-model-id"
  },
  "verification": {
    "provider": "your-verification-provider",
    "model": "your-verification-model-id"
  }
}
```

provider URL、API key 和认证均沿用 Pi，不放在此配置中。额外摘要/核验服务商必须由用户显式选择，不能为了便宜或命中缓存自动转发历史。

### 3.3 后台、超时与处理预算

| 字段 | 建议默认值 | 校验与语义 |
|---|---:|---|
| `background.enabled` | `false` | 布尔值；对应 Pi/provider 组合通过 P4 后才允许启用 |
| `background.maxConcurrentJobs` | `1` | 1–4；同进程跨会话后台任务上限，不是同会话并发上限 |
| `background.jobTimeoutMs` | `300000` | 1000–1800000；从后台需求开始排队到生成、核验和重做结束的总期限 |
| `background.foregroundWaitMs` | `15000` | 0–1800000，且不超过 jobTimeoutMs；前台已无安全余量时，一次阻塞阶段最多等待多久；0 表示立即暂停 |
| `limits.maxRegenerations` | `1` | 0–2；同一快照内质量修复与预算重规划共用的重做次数，0 表示不重做 |
| `limits.batchBudgetMs` | `50` | 1–1000；本地一次维护的协作式调度预算，不是单次 I/O 的硬期限 |
| `limits.maxCandidatesPerPass` | `8` | 1–100；单次维护最多新处理的候选数量；不影响应用已提交占位符 |

- 同一会话始终最多一个在途摘要任务，后续需求合并；该正确性规则不因提高进程并发数而改变。
- 各调用 deadline 同时受整个后台任务剩余期限限制；总期限不因重试、再核验、需求合并或进度更新而重新开始。`maxRegenerations` 与 Pi 的网络重试不同，两者都必须受总时限约束。
- `foregroundWaitMs` 只用于当前确实无法安全继续且已有后台任务的情形。安全时不等待；没有后台任务时走按需限域摘要/暂停。等待预算耗尽后明确暂停当前请求，任务如仍在期限内可继续准备，但晚到结果不能自行恢复已暂停/取消的用户 run。
- 单进程多个活动配置共享调度器时，取其请求上限的最小值作为进程总上限，并在状态中展示。跨进程不承诺全局限流，仍由宿主/provider 配额管理。
- 工作请求优先。共享 GPU 或 provider 限流已经影响前台时，可把实际并发降到配置上限以下或不做后台并行；必须展示降级原因，不以配置上限为必须占满的目标。
- 本地批次用尽时让出事件循环或留到后续处理；若此时请求仍不安全则等待/暂停，不能因达到处理预算就放行。

## 4. 默认、覆盖与生效时机

1. 先按现有信任规则选择唯一有效 `sol-pi.json`。项目文件替换用户文件，不把两个配置文件合并；未指定的嵌套字段只使用内置默认值。
2. 所有新对象都严格校验未知字段、对象类型、比例关系和路由成对要求。关闭模式时仍拒绝格式错误；只有合法的关闭配置才沿用 legacy 行为。
3. 首版新模式要求 `observationPack: true` 和 `evidencePreservingReducer: false`。`onlineContextCompact` 可选；开启时保留 `update_plan`，但关闭经济压缩。（实现调整：限域摘要改由 Live Compact 在 `turn_end` 边界提交，不再依赖 OCC。）原 all-enabled profile 仍在新模式关闭时回归。
4. 首版配置在扩展初始化时读取，修改后需重新加载扩展或重启；不承诺运行中热更新。重载时取消旧后台任务，不能将旧草稿当新配置产物提交。
5. 决策与后台快照记录 schema/策略版本及配置摘要。新配置只影响新决策；已有卡片字节与召回引用保持稳定，不因新摘录预算而重新展开/重压。关闭整个新模式恢复 legacy 语义，可能改变投影，应明确提示。
6. 每次模型切换重新解析窗口与默认路由，检查预算并使相关快照失效；这不等于重新读取配置文件。
7. `/live-compact status` 展示有效配置来源、配置/实际水位、摘要/核验/重做路由、并发/时限，以及未启用或降级原因，不展示凭据。CLI preflight 与运行时共用静态 schema、默认值和测试样例；CLI 未加载 Pi 运行环境时必须将路由存在性、认证、模型预算与后台能力标为“未验证”，不能仅凭 JSON 合法宣称可运行。动态检查在启用/调用前由 Pi 运行时完成。

本期不增加环境变量、临时命令行覆盖或 per-model override 的多层规则。比例本身适应不同窗口；如后续确需按工作模型定制策略，再单独定义覆盖顺序与运行中切换语义。

## 5. 不可关闭的安全规则

可配置策略不等于可以绕过以下条件：

- 发送前的容量检查及输出预留；归档先成功再替换。
- 原文完整性、引用来源、会话/分支隔离、工具配对和角色边界。
- 摘要质量门、最终快照/预算复核，以及停止/取消后的晚到结果隔离。
- 同会话单任务、有界重做、有限等待；失败保留原文，已知超限不发送。
- 不自动删除仍被引用的归档，不通过配置隐式启用默认深压缩。

## 6. 配置验收清单

- 缺省字段得到本文默认值；原配置与关闭新模式的行为不变。
- 调整为非默认比例（例如 start 0.60、target 0.55、ceiling 0.75）后，实际触发/回落/软上限均变化；安全预算仍独立生效。
- 修改最近轮数、完整展示次数、候选大小与摘录目标后策略生效，且不修改已提交卡片。
- 摘要/核验分别配置不同路由、全部省略、只填一个字段、不可用路由、模型窗口不足均有确定结果；工作模型不被切换。
- 非法比例顺序、NaN/无限值、错误类型、未知子字段、无限重试、超范围并发/超时被明确拒绝；JSON 无法表示的数值也在程序入口校验。
- `0` 对额外预留、重做次数和前台等待均保留明确含义，不用 truthy 默认逻辑覆盖。
- 后台总时限覆盖排队/生成/核验/重做，前台等待耗尽不会因循环或进度更新重新开始；晚到结果不擅自恢复 run。
- CLI 与运行时对同一 fixtures 产生一致的默认、通过/拒绝结果；状态展示配置值与实际裁剪/降级值。
- 重载、模型切换和恢复旧会话时，配置快照、归档、卡片和任务的版本归属正确。
