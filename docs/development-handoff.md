# SoL-Pi 开发交接

更新日期：2026-11-11。下一次开发在 SoL-Pi fork 的本地检出中开始。

## 1. 先执行的动作

```sh
cd /path/to/SoL-Pi
git status --short
git remote -v
```

读完本仓库 `AGENTS.md`；准备安装、构建、配置或测试时，先完整阅读 `agents-install.md`，再按适用流程执行。当前进度：P0 基线与 P1 局部整理已在 fork 的 `main` 分支完成，下一项是 P2（每次请求准入与突发保护）。

## 2. 已确定的目标

用户决定以 SoL-Pi 为开发基座，参考 Live Compact，改善长会话的工具输出收短、最近轮保护、缓存稳定性及处理性能。保持 PI 原生扩展形态。

后续目标明确为 **AI 性能 > 用户体验 >> token 开销** 的高保留模式：约 70% 开始维护，尽量在 70–80% 工作，减少原生摘要概括过多历史。继续分析、开发或验收时先读 [Live Compact 总方案](live-compact-plan.md)，以其 P0–P5、保护规则与验收矩阵为准。新模式以压力触发替换 OCC 经济触发；加入每次请求准入、必要旧前缀摘要、独立摘要路由与强模型核验；后台预摘要是可选体验增强，不能承担防超窗职责。新模式关闭时维持上游行为。

70%/80%、近期保护、摘要/核验模型、后台并发与时限均须可配置。实现配置解析、preflight、示例或配置测试前，读取 [Live Compact 配置规范](live-compact-config-plan.md)；它规定分组字段、默认值、范围和生效时机，安全校验不得通过配置绕过。

本机 Pi 包版本静态检查为 1.5.0，超出仓库目前最高已测试的 1.3.0。尚未执行兼容验证，不应直接视为可用。

- 开发目录：SoL-Pi fork 的本地检出。
- origin：<https://github.com/yczheng-hit/SoL-Pi>。
- upstream：<https://github.com/NVlabs/SoL-Pi>。
- 参考项目：<https://github.com/Tranquillitatis-Lab/dsh-live-compact>。
- 迁移时分支：`main`。基线提交：`219568034fa54ed121ede80961655e33dfb9d0e3`。
- 克隆形式：浅克隆、blob 过滤；需要早期历史时再获取。部分 Git 命令可能需要联网补取对象。

迁移前代码工作区干净。方案文档包括本文件、`docs/sol-pi-live-compact-research.md`、`docs/live-compact-plan.md` 和 `docs/live-compact-config-plan.md`。P0/P1 和这些文档已推送到 fork 的 `main` 分支（origin，yczheng-hit/SoL-Pi）；upstream（NVlabs/SoL-Pi）不包含这些改动。

## 3. 已完成与未完成

已完成：

- GitHub fork 创建，并验证 parent 为 NVlabs/SoL-Pi；本地仓库迁移；origin/upstream 核对。
- 源码静态阅读与方案设计。
- P0：Phase 1 检出验证。开发依赖升级为 Pi 1.5.2，确认了事件顺序与公开边界 API。
- P1：`extensions/live-compact/`、共享配置 schema、`/live-compact` 状态命令，以及单元测试、AgentSession 测试和真实 CLI 启动测试。

- 文档：README 新增“Changes in this fork”与 Live Compact 安装配置说明；`agents-install.md` 新增 `live-compact` 配置方案（版本门槛、`--require-live-compact` preflight、通过 RPC `get_commands` 确认已注册）；新增 `sol-pi.live-compact.example.json`。

记录见总方案 §2.3 与 §13；分支上 `npm run check`、`npm audit --audit-level=high`、`check-pi-compat --strict`、all-mechanisms 均通过。

未完成：

- P2–P5；
- 真实模型评测；
- PI 插件安装与用户配置；
- 本机全局 Pi 1.5.0 的完整验证（`--strict` 判为未测试版本）。

不要把文档中尚未实现阶段的验收目标视为测试通过。

## 4. 初版开工顺序（历史记录；现以总方案 P0–P5 为准）

1. 记录 Node 和 PI 版本，按 `agents-install.md` 完成适用的依赖与基线检查；完成标志是记录每项命令结果及实际版本，失败项明确列出。
2. 从基线建立 `feat/local-context-policy` 开发分支（历史记录：完成后已作为 fork 的 `main` 推送；跟进上游时从 upstream/main 合并）。
3. 扩展现有 ObservationPack 的策略配置，保持旧配置与关闭新策略时的行为；完成标志是配置、校验、示例与对应验证同步。
4. 加入最近工具轮保护、候选选择和稳定替换决策；完成标志是近期内容受保护，旧占位符不会随连续请求反复展开/折叠。
5. 验证归档失败、恢复会话、fork 和 native compact 后的召回；完成标志是原文能精确恢复，异常时保留可用原文。
6. 最后增加增量扫描、批次耗时预算和统计；完成标志是长历史无需每轮全量重扫，任务结果与原文召回不退化。

上述初版范围对应的旧估算已不覆盖高保留摘要、质量核验与后台竞态处理；当前分阶段工时以总方案第 13 节为准，均不代表已排期。

## 5. 改造入口与边界

| 入口 | 拟议工作 |
|---|---|
| `src/sol-pi/config.ts` | 可选策略配置；解析器目前拒绝未知字段，同步校验脚本、示例和文档 |
| `src/sol-pi/index.ts` | 传入策略，维持各扩展装配顺序 |
| `src/sol-pi/extensions/observation-pack/index.ts` | 候选选择、最近轮保护、稳定投影、召回集成 |
| `src/sol-pi/extensions/observation-pack/observation.ts` | 原文归档、占位符、阈值和摘录策略 |
| `src/sol-pi/extensions/observation-pack/ledger.ts` | 复用已有账本，再决定需要新增哪些决策统计 |
| `src/sol-pi/extensions/online-context-compact/` | 旧模式保留经济判断；新模式加入压力控制、必要旧前缀摘要及原生压缩协调，详见总方案 |

当前源码已具备：成功纯文本工具结果筛选、10 KiB 阈值、完整发送两次、1024 字节摘录预算、原文哈希及 `obs_recall`。官网介绍与代码的摘录预算存在差异，以固定提交为基准。

第一期直接扩展 ObservationPack；避免并行注册第二套上下文改写器。保留 Online Context Compact 做大摘要。错误结果继续沿用现有保护。DSH 的 preset patch、固定 20K/650K 阈值和后端替换代码不属于本次移植范围。

## 6. 验收条件

- 新策略关闭时与上游基线行为一致；用户指令、来源角色、工具调用配对保持正确。
- 小清理只影响发给模型的上下文投影，PI 原始历史保持完整。
- 归档后分页召回拼接与原文逐字节一致，覆盖中文和长日志。
- 磁盘满、归档损坏、写入失败的结果有明确记录并保留原文；不删除仍被引用的归档。
- resume、fork、native compact 之后引用归属正确，不串会话。
- 旧占位符稳定；承认首次修改位置之后的前缀缓存可能重建。
- 同工作模型、同初始代码、同任务比较原生 PI 默认配置、原生 PI 大尾部配置、上游 SoL-Pi 与改造版；按 AI 任务质量、用户体验、token/费用的顺序验收。摘要模型与后台模式另做对照；每类至少三次运行只作试用信号。

已有测试入口见 `package.json` 和 `tests/observation-pack.test.ts`、`tests/online-context-compact-*.test.ts`。按实际修改选验证范围；阶段完成时记录通过与失败，不预先宣称通过。

## 7. 环境经验

普通环境访问 GitHub 曾因 `127.0.0.1:18080` 代理不可达而失败，并造成 `gh auth status` 看似凭据失效。正常网络环境执行 `gh api user --jq .login` 已确认账号 `yczheng-hit` 并成功 fork。遇到相同报错先区分网络与认证，避免直接退出登录或替换凭据。

本地开发仓库不是旧的 `work/sol-pi-source`。此前全量 clone 超时留下的 `work/SoL-Pi` 不是有效开发副本，不应从该目录继续。

## 8. 进一步阅读

[源码核对、参考点和分阶段建议](sol-pi-live-compact-research.md)。具体引用及已知风险在该文档中；它是研究时点的快照，功能实施前核对当前 checkout。

复制 Live Compact 具体代码时保留适用的 MIT 版权和许可证说明；参考其约束思想优先于直接搬运宿主相关代码。
