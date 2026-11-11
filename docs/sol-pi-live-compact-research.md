# 基于 SoL-Pi 吸收 Live Compact：源码核对与开发建议

核对日期：2026-11-11。范围为一手文档、公开源码静态阅读；没有运行真实模型评测。下文“建议”均为拟议设计，不表示上游已有功能。

## 结论

保留 SoL-Pi 为唯一基座，先扩展 ObservationPack，保留 Online Context Compact 作为大摘要与窗口保护。不要移植 DSH 的替换后端、preset patch 和会话日志事务。第一版不需要第二套摘要器，也不需要代理。

## 已有能力，避免重复建设

- `src/sol-pi/extensions/observation-pack/observation.ts`：仅处理成功的纯文本工具结果；阈值为 10 KiB，完整发送次数为 2，摘要摘录总预算为 1024 字节；已校验原文归档、拒绝符号链接，并提供内容哈希。前文项目网站描述的摘录大小与当前代码不同，实施应以固定提交源码为准。[源码](https://github.com/NVlabs/SoL-Pi/blob/main/src/sol-pi/extensions/observation-pack/observation.ts)
- ObservationPack 已注册 `obs_recall`，只改 `context` 事件给出的消息副本，保留存储历史；替换时原地改消息内容，不返回重建对象。归档或处理失败则保留原文。[实现](https://github.com/NVlabs/SoL-Pi/blob/main/src/sol-pi/extensions/observation-pack/index.ts)
- Online Context Compact 已考虑收益、缓存重写债务、冷却和窗口保护，不应被简单的“每轮超过 20K 就切”取代。[经济决策](https://github.com/NVlabs/SoL-Pi/blob/main/src/sol-pi/extensions/online-context-compact/economics.ts)
- 兼容层已处理 resume、fork、codemode、扩展顺序和 native compact 之后继续工作。当前文档列出测试版本 0.84.2、1.0.4、1.3.0；声明版本范围较宽不代表全部已测试。[兼容说明](https://github.com/NVlabs/SoL-Pi/blob/main/docs/compatibility.md)

## 可以吸收什么

| Live Compact 的参考点 | SoL-Pi 内的拟议实现 | 优先级 |
|---|---|---|
| 最近若干工具轮保留原文；不跨真实用户边界；保护工具调用配对 | 扩展 ObservationPack 的候选选择器，加入 `keepRecentToolRounds`；第一版仅投影工具结果，不折叠用户/助手消息，不拆工具对 | P1 |
| 已经压过的区域不反复向前重切，尽量保持缓存前缀 | 为每个分支保存投影决策清单，已压为占位符的条目不自行展开；暂停/恢复不能使旧占位符来回切换 | P1 |
| 无模型的局部收短与模型大摘要分工 | 在 ObservationPack 增加可配置策略：原有两次完整发送作为默认，对长 read 等白名单探索更早归档；OCC 仍负责大摘要 | P1 |
| 压缩前原文备份、恢复后完整性核对 | 复用现有对象归档；加强损坏、磁盘满、resume/fork 端到端验收；归档失败不压缩 | P1 |
| 原因明确、退出状态不能被误写为成功 | 第一版继续跳过 `isError`；后续另做失败结果卡片，必须保留退出码/错误类型/关键原因 | P2 |
| 游标和分批维护避免大历史反复扫描 | 给 ObservationPack 增量索引和缓存；有新候选或视图变化才处理，设置每批时间预算并让出事件循环 | P2 |
| 本地备份容量与轮换 | 先做容量统计和手动清理预览；确需自动回收时只清理已确认无活跃引用的对象，不能照搬全局删最老 | P2 |

Live Compact 源码中已有最近轮保留、用户边界与调用配对检查、checkpoint 地板、本地备份和分批捕获机制，可参考其约束思想，而非搬运宿主相关代码。[后端源码](https://github.com/Tranquillitatis-Lab/dsh-live-compact/blob/main/index.js)

Live Compact 卡片规划还保留来源角色、原始调用身份及错误要点；可借鉴其证据标注，不宜直接搬运基于文本正则的事实抽取规则到通用 Pi 工具。[卡片规划](https://github.com/Tranquillitatis-Lab/dsh-live-compact/blob/main/plan.js)

## 代码入口

1. 配置：`src/sol-pi/config.ts`，新增独立可选策略对象，旧配置保持原义；当前解析器拒绝未知字段，必须同步更新校验、示例、脚本和文档。[配置源码](https://github.com/NVlabs/SoL-Pi/blob/main/src/sol-pi/config.ts)
2. 装配：`src/sol-pi/index.ts`，把新策略传入 ObservationPack，保持 OCC 在其他变换器之后注册。[入口](https://github.com/NVlabs/SoL-Pi/blob/main/src/sol-pi/index.ts)
3. 小清理：`extensions/observation-pack/index.ts`、`observation.ts`、`ledger.ts`；新增纯函数候选策略，避免再注册一个会改同一消息的上下文插件。
4. 大压缩：仅在确有必要时调整 `extensions/online-context-compact/economics.ts` 与 `extension.ts`；小清理后的实际投影应被 OCC 正确计量，不能按原始归档大小重复计算节省。

## 分阶段交付与验收

### 阶段 0：固定上游基线（半天）

fork 后保留上游 main；设置 upstream 指向 NVlabs/SoL-Pi，工作分支建议 `feat/local-context-policy`。记录上游提交、Pi/Node 版本，先通过现有 `npm run check` 和 Pi 兼容检查。除必要配置外，原有行为保持不变。

### 阶段 1：最小可用改造（1–2 个工作日）

交付可配置 ObservationPack + 最近轮保护 + 稳定投影决策 + 决策统计。默认采用原有行为，新策略显式开启。不新增模型调用，不持久改写 Pi 原始历史，不移动 provider URL。

验收：开关关闭时请求与基线一致；受保护消息不变；归档原文分页拼接字节一致（含中文）；连续请求中旧占位符稳定；损坏/磁盘满时保留原文；原始会话日志内容不被小清理改写；resume、fork、compact 后可召回。

### 阶段 2：性能与可观测性（1–2 个工作日）

引入增量索引、分批扫描、候选跳过原因。记录投影前后估计 token、真实 provider input/cache usage、首个变化位置、处理耗时、召回次数。不同口径分开展示，不能把累计“省下的 token”直接当费用节省。

### 阶段 3：对照试用（1–2 个工作日）

用同模型、同任务、相同初始代码做三组：原生 Pi；上游 SoL-Pi；改造版。任务包含大文件探索、长测试日志、重复失败修复、压缩后追问早期约束。每类至少 3 次独立运行作为试用信号，不能当统计显著结论。

验收顺序：任务可执行结果/约束保持 → 召回正确性 → 实际总费用与墙钟 → 缓存与 token 诊断。出现稳定质量退化即禁用对应策略，不用节省指标掩盖失败。阶段 1 通过前不扩展错误输出压缩，也不同时改 Action Fusion 与 Reducer，以便归因。

## 风险与不移植项

- 不复制固定 20K、650K 等 DSH 阈值；Pi 的模型窗口、输出预留与工作负载不同。
- 不承诺“前缀缓存完全不失效”：占位符首次替换处之后的缓存可能需要重建。真正目标是避免旧区域反复抖动。
- 不同时引入第二个消息重写插件；第三方 `context` handler 的顺序需集成验证。
- 不自动删除仍被活跃占位符引用的归档；本地原始会话存在不代表原有 `obs_recall` 引用自动可重建。
- 不把摘录标成新指令、授权或已验证事实；保留工具名、调用 ID、来源状态。
- 两仓库均声明 MIT；参考思想无需复制代码。若复制具体实现，应保留相应版权与许可证并记录来源，不把 NVIDIA 标识当作 fork 自己的背书。

## 执行状态与证据限制

已创建并通过 GitHub API 验证 fork：https://github.com/yczheng-hit/SoL-Pi ，parent 为 NVlabs/SoL-Pi。已读取本地浅克隆并记录基线提交 `219568034fa54ed121ede80961655e33dfb9d0e3`，设置 upstream 指向 NVIDIA 原仓库。

命令行最初在受限环境中被本机代理连接失败误报为凭据无效；正常网络环境核验登录后成功创建 fork。完整历史下载超时后改为浅克隆成功。没有安装到 PI、修改功能代码、安装依赖或运行测试；本文是开发计划，不代表功能已实现或测试已通过。

开发工时为粗略估算，取决于 PI 版本适配和真实任务回归结果。
