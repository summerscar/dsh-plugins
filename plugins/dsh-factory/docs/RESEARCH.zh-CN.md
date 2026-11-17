# 竞品调研：工厂式开发 agent

> 本轮口径：按**功能优劣**对比同类产品，不以看板长相论高低。UI 参考锚点是 **Mastra Factory**；下面几家 taskboard 型插件只作功能对比，不当 UI 标杆。
> 这份是可复用记录，给接手的人看：说明我们的设计在同类中处在什么位置、哪些有意采纳或拒绝、哪些结论喂给后续分期。它是决策输入，**不是**路线图的副本——分期与验收标准读[路线图 §4](ROADMAP.zh-CN.md)。

## 1. 比了谁、怎么比

外部五个项目加本插件共六家。更早的两份参考架构摘要见[路线图 §6](ROADMAP.zh-CN.md)；本文记录其后扩展开的这次对比。

对比看重可观察的能力，不看呈现。矩阵里星号表示该能力具备且做得完整，横线表示没有。人气计数与版本标签有意不写——它们会过期，也不改变工程判断。

## 2. 功能矩阵

| 维度 | Mastra Factory | dsh-factory（我们） | shengsheng90 | cloader | maochiy | linglanxin |
|---|---|---|---|---|---|---|
| issue 接入源 | 强——多源：GitHub / Linear / Slack 外加 Jira / GitLab / incident.io，按源过滤 | 中——GitHub issue intake，按项目配源与看板 | 弱——以人工建卡加批准为主 | 强——GitHub 加外部同步（禅道 / TAPD） | 无 | 无 |
| 阶段闸门可配 | 强——阶段、结果与转移策略代码级自定义 | 中——固定状态机 `assertTransition` 加 L0/L1/L2 档 | 强——固定状态，approve / accept 分离 | 强——固定列加受阻态 | 中——固定列 | 无 |
| 自治／手动档位 | 强——**每阶段 manual/auto 可配，另有板级两个开关** | 强——**项目级 L0/L1/L2 加 `autoStart` / `autoApprove`** | 中——自动化规则，配额触发暂停 | 中——认领／定时／cron 执行方式 | 无 | 无 |
| 并发控制 | 强——每副本在途上限、队列指示与健康视图 | 中——项目级与全局级上限，仅后端有、UI 待 P4 | 强——项目／全局双层 worker 上限 | 强——可配并发上限 | 无 | 无 |
| 会话与工作区隔离 | 强——每工作项独立会话与沙箱 | 强——一卡一会话加 worktree 加任务分支 | 强——每工作项会话与工作区 cwd、目标驱动 | 强——worktree、任务分支、多仓镜像、非 git 降级 | 中——卡片与会话联动 | 无——只读监控 |
| 审批与接管 | 强——accept / accept-and-plan / approve-plan / merge 全分离、人工转移策略、独立评审卡与会话 | 强——仅评审授权门、单次待授权、接管与暂停 | 强——approve / accept／强制接管／退回 | 强——agent 到不了 done、一键完成或退回 | 无 | 无 |
| 持久化与一致性 | 强——多后端、乐观版本、凭据加密 | 强——整份状态存 SQLite 单行、带 schema 版本、引擎可换 | 强——内置 SQLite，写事务加版本锁 | 中——JSON 加锁文件与版本校验 | 中——JSON 临时文件加 rename | 无——只读事件日志 |
| 集成生态 | 强——多源加 Slack 双向会话 | 弱——只有 GitHub | 无 | 中——禅道 / TAPD | 无 | 无 |
| 可扩展／可定制 | 强——自定义看板复用现有界面；agent、工具、UI、鉴权、存储与沙箱均可配 | 中——skill 体系；零构建纯 JS 插件 | 强——工作流编辑器 | 中——模板与分支名预设 | 无 | 无 |
| 活跃度与成熟度 | 强——大规模开源、持续维护，仍处 beta | 开发中、未发布 | 活跃 | 活跃 | 近乎空壳的单笔提交 | 近乎空壳的单笔提交 |

## 3. 各家强项与硬伤（判定，非复述）

- **Mastra Factory**——强在**可配置性**：闸门、规则、集成、沙箱、存储全是可插拔点。把 Work 与 Review 拆成两张各自带会话的独立卡，是别家都没有的结构差异。代价：强绑自家平台（鉴权、数据库、云沙箱），看板规则用代码定义，且仍是 beta。
- **shengsheng90**——真功夫在**双层并发语义**与 SQLite 一致性工程；approve / accept 分离、强制接管。硬伤：没有外部 issue 源，架构偏重，GUI 主要在少数宿主版本上验过安装加载。
- **cloader**——**worktree 工程细节最丰富**（多仓镜像、非 git 降级、崩溃锁恢复、读失败保护），外部源最广。硬伤：全局单并发值、无档位概念、JSON 台账规模上限。
- **dsh-factory（我们）**——强在**一卡一会话一 worktree 加人工审批闸门加多项目**这套组合，外加 **L0/L1/L2 三档——六家里独一份**。弱项：接入源只有 GitHub、阶段固定不可配、并发 UI 未做、换 SQLite 前持久化最弱（现与 SQLite 几家同档）。
- **maochiy / linglanxin**——近乎空壳的单笔提交，前者是极简 CRUD 看板，后者是监控台而非任务管理，无参考价值。

## 4. UI 锚点：Mastra Factory

把它留作**视觉与交互参考**；上面几家 taskboard 插件不是 UI 标杆。

- **页面结构**——Intake / Work / Review / Overview / Settings。**Work 与 Review 是两个独立看板**，PR 有自己的 Review 卡与会话。
- **阶段呈现**——Work 看板是**按 workflow 状态分组的列表**（点状态标题折叠／展开，计数与新建仍在），不是经典拖拽列。阶段为 Intake → Triage → Planning → Building → Review → Done（加 Canceled）。
- **manual/auto 怎么表达**——板级两个开关（自动起跑／自动批准计划）；**每阶段 manual/auto 是代码配置**，不在界面逐阶段切。批准计划用独立的提交动作，与阶段转移分开。
- **「需要我处理」**——Overview 汇总等待决策或报告问题的项；被关掉的审批请求进入 Needs attention 视图。
- **会话详情**——chat 加工具活动加工作区文件／改动；可直接对开着的会话做 steering，不另起对话。
- **卡片动作**——Accept（含 accept-and-plan / accept-and-build）、Approve plan、Merge、Re-review。
- **状态反馈**——favicon 随会话状态变（waiting／error／initializing／working），另有运行队列指示。
- **移动端**——onboarding 四段，桌面预览在旁；**移动端隐藏预览、主操作钉底部**，可直接照抄。
- **图**——没拿到稳定的产品截图直链（官网 social image 是动态标题卡，不是产品图）。可得的是 [overview 视频](https://youtu.be/iMA-Xkhj7fU)、[workshop 录像](https://www.youtube.com/live/LzZ_FptHWqs)，以及源码里的 [review-status 动画](https://github.com/mastra-ai/mastra/blob/main/mastracode/factory/assets/review-status/reviewing-light.gif) 与 [阶段图标](https://github.com/mastra-ai/mastra/tree/main/mastracode/factory-ui/src/ui/public/factory-stage-icons)。没有编造截图 URL。

## 5. 抄什么、别抄什么

**值得抄**

1. Work 与 Review 拆双卡、各自会话——与当前「一卡走到底」的结构差异，比皮肤改动大一号。
2. 板级两开关与 Needs attention 视图，作为自治状态的措辞与归口——正好供 L0/L1/L2 界面参考。
3. source events 回写闭环（issue 关闭／PR 合并如何推进卡片）——可用于 intake 闭环，见下文分期输入。
4. 移动端 onboarding 布局与会话状态 favicon 反馈。
5. 沙箱按会话隔离。

**有意不抄**

1. 代码定义的看板规则引擎——我们是零构建纯 JS 插件，那套太重。
2. 强绑平台的鉴权、数据库与云沙箱——不依赖厂商运行时。
3. 目标驱动执行、observational memory 与 graph wiki——超出本项目的重基础设施。

另注：别家每阶段 manual/auto 是**代码配置而非界面开关**，反倒印证我们自己踩出来的硬规矩——界面必须按自治档位字段判断，不能按两个开关判断。

## 6. 喂给后续分期的输入

本轮结论是**不再堆功能**。核心链路——issue 到 draft PR、人只在闸门点头——已端到端闭环。P4 是把已有能力做成界面、真用起来攒反馈，不是填功能坑。这时候加功能等于给刚调稳的机器拆开塞零件。

**喂进路线图**（见[§4 分期](ROADMAP.zh-CN.md)与[§5 缺口](ROADMAP.zh-CN.md)）：

- **P4 界面**——已实现并验收通过：自治档位界面已按上面的 Mastra UI 锚点落地——档位三选一（徽标只读 `autonomy`）、暂停／接管、含全局 HTTP 可写上限的并发上限、删项目清 worktree、全局／项目作用域分离、移动端主操作钉底。待办项（写入全局上限的夹具级证明、真机浏览器核对）记在[§5 缺口](ROADMAP.zh-CN.md)。
- **后续、结构性**——Work 与 Review 拆双卡、各自会话是真实结构差异。此处记录、未启动：它比 P4 大一号，没有明确决定就不动。
- **后续、仅在真成痛点时**——source events 回写闭环（issue 关闭／PR 合并推进卡片）是唯一「补完已有链路另一半」而非抄新特性的增强。它与 webhook 绑定，**本轮不做**。

**明确不做及理由**

- 更多 issue 源（GitLab / Linear / 禅道）与阶段自定义——是真增强，但属于扩产品边界而非补当前目标，现在做只会稀释 P4。
- webhook 与 source events 回写本轮不做——单机加轮询够用，远端快照注入入口已覆盖手动那一侧。
- 代码定义的规则引擎、强绑平台的基础设施、目标／记忆／wiki 那套——见上文「有意不抄」。

## 7. 来源

**Mastra Factory——官网与文档**

- [Factory](https://mastra.ai/factory) · [快速开始](https://factory.mastra.ai/) · [什么是 Factory](https://factory.mastra.ai/what-is-factory)
- [Work 与审批](https://factory.mastra.ai/using/work-and-approvals) · [会话](https://factory.mastra.ai/using/sessions) · [评审](https://factory.mastra.ai/using/reviews)
- [看板与规则](https://factory.mastra.ai/configure/boards-and-rules) · [存储](https://factory.mastra.ai/configure/storage) · [沙箱](https://factory.mastra.ai/configure/sandboxes) · [环境变量](https://factory.mastra.ai/reference/environment-variables)

**Mastra Factory——博客**

- [Beta 发布](https://mastra.ai/blog/announcing-mastra-factory-beta) · [Jira / GitLab / incident.io 集成](https://mastra.ai/blog/introducing-jira-gitlab-incident-integrations)

**Mastra Factory——源码**

- [mastra-ai/mastra](https://github.com/mastra-ai/mastra)，`mastracode/` 下 · 模板仓 [template-factory](https://github.com/mastra-ai/template-factory) 与 [softwarefactory-template](https://github.com/mastra-ai/softwarefactory-template)

**其余四家**——shengsheng90、cloader、maochiy、linglanxin 依据其仓库 README、`package.json` 与公开仓库元信息对比。本轮未取得它们可稳定引用的产品文档链接，因此不在此编造。

---

回到[路线图分期 §4](ROADMAP.zh-CN.md)与[调研依据 §6](ROADMAP.zh-CN.md)。
