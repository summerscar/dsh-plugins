# 文档罗盘

这份文件是本仓库文档的地图：每个插件现在在什么位置、下一步做什么、想了解某件事该读哪份。它是**带上下文的目录**，不是被指向文档的副本。细节一旦在某份文档里定下来，那份文档就是事实来源；这里只告诉你去哪找。

## 当前状态

生命周期阶段以 `scripts/plugin-release-states.json` 为唯一来源，只能单向前进：`draft` → `testing` → `published`。各阶段的含义与发布规则见 [RELEASING.zh-CN.md](RELEASING.zh-CN.md)。

| 插件 | 生命周期 | 进展 |
| --- | --- | --- |
| [`@summerscar/dsh-mnemon-sync`](plugins/dsh-mnemon-sync/docs/README.zh-CN.md) | `published` | 已发布，进入常规维护；后续改动走正常更新流程。能力与限制见它自己的 README。 |
| [`@summerscar/dsh-connect-agentscope-platform`](plugins/dsh-connect-agentscope-platform/docs/README.zh-CN.md) | `published` | 已发布，进入常规维护；同样的更新流程。账号处理、可选模型供应商与额度面板见其 README。 |
| [`@summerscar/dsh-factory`](plugins/dsh-factory/docs/README.zh-CN.md) | `draft` | 开发中；源码已入库但尚未发布。P1 添加链路、P2 自治引擎、P3 机器代批计划、P4 自治档界面、P5/P6 整页改版与界面迭代（含 GitHub 项目级身份配置）、P7（卡片正文注入与单卡交还）均已实现；自治现为语义三档（manual / you-approve / machine-approve）加唯一 autoDispatch 开关，取代旧 L0/L1/L2 与两个开关（旧存档加载时一次性迁移）；另有「取消卡片」软删（转 `canceled` 终态、保留卡与 source 防复活、后端零改动），页尾可用折叠条展开只读查看已取消卡，任务卡统计排除 canceled、保留 done。状态持久化在 SQLite。GitHub 身份设置增量补上四层身份（OAuth App → gh CLI → 全局 Token → 仅此仓库 Token）、把 Client ID 并入 ① OAuth App 块，并让全局 Token 状态以只读接口返回掩码指纹。后续纯显示层增量给每张卡在 meta 下加一行按优先级选出的流程提示（自动/手动随档位，暂停/并发/接管/待补充/卡住/会话停止为覆盖态，不与已有 L4 评审提示叠加）；补充信息弹窗现在把上次退回原因只读展示在未填写的输入框上方。交付文案改由宿主的轻量模型调用起草：手动提交与首次建 PR 先过原有闸门再打开可编辑草稿，只有确认才写入；L4 起草尽力而为、失败退回原文案，显式清空的 PR 正文保持为空。评理会话跟随项目工作模式，独立会话与 verdict 闸门不变；标签视图下项目标签钉在顶栏下方。L4 的 git 写对意外 head、活会话和大量删除 fail closed，只提交决策时冻结的路径；交付停滞可由人通过「重试自动交付」重新武装。V4 取代档位模型：新项目只存阶段规则（默认全速、只能收窄），构建会话提交推送但不开 PR，独立自审评审人开唯一草稿 PR，独立只读 PR 评审会话写 `pr-review` verdict，人合并后由 `syncRule` 按远端合并事实完成卡片。verdict 按 source 绑到 `reviewSessionId` 或 `prReviewSessionId`、没有兜底；PR 评审空转只审计一次，不自动重派。 |

工厂是目前唯一在开发的插件。它现在能做什么、还有什么没解决，都要读它的路线图：[§2](plugins/dsh-factory/docs/ROADMAP.zh-CN.md) 写当前行为，[§5](plugins/dsh-factory/docs/ROADMAP.zh-CN.md) 列已知缺口。缺口清单不等于「已验证行为」的完整清单，判断以源码和真机为准。派发会话的权限边界与写入/回执窗口（工厂侧）都已修并验通。卡正文按「数据非指令」在技能指令前注入；单卡接管现在有对称的、幂等的交还路由；非终态卡可一键取消（软删），没有按卡硬删；已取消卡可在页尾折叠条只读查看，任务卡统计不含已取消卡、仍计已完成卡。

## 未来规划

下面只给全局视图，细节、取舍和验收标准在[路线图 §4](plugins/dsh-factory/docs/ROADMAP.zh-CN.md)，缺口与未满足的前置条件在 [§5](plugins/dsh-factory/docs/ROADMAP.zh-CN.md)。

| 阶段 | 目标 | 状态 | 去哪看 |
| --- | --- | --- | --- |
| P1 | 在真机上验证完整的添加链路 | 已完成 | 路线图 §4 P1：验收分组与逐轮账本 |
| P2 | 自治引擎，语义三档 | 已实现；真实自动派发已在真机端到端验通，停在 plan-review | 路线图 §4 P2 与 §5 |
| P3 | machine-approve：机器代批计划（按项目显式选档） | 已实现并真机验通——机器只走 `plan-review -> build`、不读任何开关，交付授权仍留人 | 路线图 §4 P3 |
| P4 | 自治档位、状态、暂停／接管与并发设置的界面 | 已实现并验收；界面已在真机复测、P4-7a/7b 全局上限证明已用后端并发夹具验过 | 路线图 §4 P4 与 §5 |
| P5 | UI/UX、文案与一项目一板 | 已实现；QA 报告全量通过 | 路线图 §4 P5 |
| P6 | 整页视图、建项目一次性绑定与身份显示 | 已实现；QA 报告全量通过；后续增量补上四层身份、Client ID 位置与只读 Token 状态 | 路线图 §4 P6 |
| P7 | 卡片正文注入（任务描述）与单卡交还 | 已实现；Review 无阻断、Design UI 审稿通过、QA 报告全绿；正文实时回源的真机端到端明确未闭环，列为残留风险 | 路线图 §4 P7 与 §5 |
| P8 | 结构化评审 verdict、独立评理会话与受闸门的 L4 交付 | 已完成；迭代自有 P0–P3 子阶段与后续 L4 加固均已完成 | 路线图 §4 P8 |
| P9 | 每张卡一行流程提示与补充信息上文 | 已完成；流程提示用 DOM 证据真机验过，补充信息弹窗只过离线测试与变异验证 | 路线图 §4 P9 与 §2.14 |
| P10 | AI 起草交付文案、评理会话工作模式与界面回归修复 | 已完成；手动提交草稿四态与三个提交入口已真机核过、L4 生成文案已在真机看到；PR 双字段的正式 QA 结论与重复请求次数仍待补 | 路线图 §4 P10、§2.15 与 §5.1 |
| P11 | 夹具提交根因、L4 写入护栏与人工重试 | 已完成；V4 之前的历史。钩子/脚本环境变量剥离与八条守卫用例由 Dev 自检加变异验证，卡片恢复与新评审会话在真机看到；没有单独的正式 QA 结论 | 路线图 §4 P11、§2.5 与 §5.1 |
| P12 | V4 生命周期、类型化评审身份与写路径收口 | 已完成；QA 报告整包全绿、真机跑到合并 → 自动 done；交叉拒交与 PR 评审第三入口 DOM 未在真机取得 | 路线图 §4 P12 与 §2.16 |

**下一步**：V4 已交付。如实记录的剩余项：真机交叉拒交不可触发（没有 HTTP verdict 路由、会话被 active write handle 占用、模型按注入防御拒绝），依据只有双向单测、变异与源码审；PR 评审第三会话入口真机 DOM 未验；四层身份降级真机只走到 env/none 一层；旧引擎路径删死分支后没有显式「已交付不重复」护栏，但当前不可达。P10 的 PR 编辑器与重复请求 QA 结论、P11 的独立 QA 判定仍属此前历史遗留。[RESEARCH.zh-CN.md](plugins/dsh-factory/docs/RESEARCH.zh-CN.md) 里的 Work/Review 拆双卡仍需拍板；正文实时性的真机端到端需要用户授权绑定仓库并改远端 issue；GitHub 身份设置里失败态修复块、保存 Client ID、Token 写操作与英文界面仍待真机复核。其余缺口见路线图 §5。

## 想了解某件事，读哪份

| 想了解 | 读这份 | 它管什么 |
| --- | --- | --- |
| 仓库是什么、怎么装插件、插件列表与生命周期表 | [README.md](README.md) / [README.zh-CN.md](README.zh-CN.md) | 面向用户的入口。两个标记之间的生命周期表是生成的，不要手改。 |
| 某个插件做什么、怎么装怎么用、有什么限制 | `plugins/<name>/README.md` 与 `plugins/<name>/docs/README.zh-CN.md` | 每个插件一份，中英成对；面向用户的功能事实。 |
| 仓库的通用规则：文档、验证、提交、运行时契约字符串 | [AGENTS.md](AGENTS.md) | 全仓适用；目录级规则优先。 |
| 在 `plugins/` 下开发代码的规则 | [plugins/AGENTS.md](plugins/AGENTS.md) | 宿主 peer 依赖、事件作用域、客户端 UI 原子组件、本仓现状。 |
| 插件站点与市场索引的规则 | [site/AGENTS.md](site/AGENTS.md) | `catalog.json`、渲染与构建、`index.json`、部署。 |
| 生命周期阶段、晋级、npm 发布流程 | [RELEASING.md](RELEASING.md) / [RELEASING.zh-CN.md](RELEASING.zh-CN.md) | `draft` → `testing` → `published`、首次发布、Trusted Publishing、发布冻结。 |
| 工厂的目标、已定取舍、分期、已知缺口与调研依据 | [ROADMAP.md](plugins/dsh-factory/docs/ROADMAP.md) / [ROADMAP.zh-CN.md](plugins/dsh-factory/docs/ROADMAP.zh-CN.md) | 设计理由与每个决定背后的原因；实现细节留在源码。 |
| 竞品对比：功能优劣、Mastra UI 锚点、后续分期该抄什么与不做什么 | [RESEARCH.md](plugins/dsh-factory/docs/RESEARCH.md) / [RESEARCH.zh-CN.md](plugins/dsh-factory/docs/RESEARCH.zh-CN.md) | 多项目对比及其取舍；指回消费这些结论的路线图分期。 |
| 怎么把插件投递到两个社区市场 | [`.agents/skills/dsh-plugin-market-release/SKILL.md`](.agents/skills/dsh-plugin-market-release/SKILL.md) | 两种投递形态、字段规则、返修与改名流程。 |
| 怎么发 npm、推进生命周期 | [`.agents/skills/npm-plugin-release/SKILL.md`](.agents/skills/npm-plugin-release/SKILL.md) | 发布工作流、OIDC、提交推送前的同步。 |
| 怎么在真机上验证插件 | [`.agents/skills/dsh-plugin-live-verification/SKILL.md`](.agents/skills/dsh-plugin-live-verification/SKILL.md) | 宿主契约、静默降级、环境变量路径、取证纪律。 |
| 怎么构建自动派发的 agent 会话：上下文注入、沙箱钉档、写前预检、自治边 | [`.agents/skills/dsh-dispatch-session-mechanics/SKILL.md`](.agents/skills/dsh-dispatch-session-mechanics/SKILL.md) | 派发会话的宿主侧机制：每类坑什么时候出现、怎么判断。 |
| 怎么同时支持多种凭据来源，并展示优先级、当前生效层与只读 Token 状态 | [`.agents/skills/dsh-credential-identity-ladder/SKILL.md`](.agents/skills/dsh-credential-identity-ladder/SKILL.md) | 多来源凭据的裁决顺序、环境变量作为默认值、掩码只读状态、失败后才出现的修复入口。 |
| 怎么给每张卡设计一行有优先级的提示、判断纯显示层改动要不要 bump `BUILD`，并用注入状态加变异验证落测试 | [`.agents/skills/dsh-card-flow-hint/SKILL.md`](.agents/skills/dsh-card-flow-hint/SKILL.md) | 纯函数优先级设计、显示层边界、变异验证与如实标注的真机证据。 |
| 怎么用宿主的轻量模型调用起草交付文案、在用户确认前保持生成只读、失败时兜底而不阻塞写入 | [`.agents/skills/dsh-ai-delivery-copy/SKILL.md`](.agents/skills/dsh-ai-delivery-copy/SKILL.md) | 先草稿后确认的边界、有界的一次性生成、四态编辑器、自动化尽力而为与请求顺序证据。 |
| 怎么给自动化 git 写加护栏：挡住意外 head 与钩子注入文件、给嵌套 git 命令剥掉 `GIT_*`、给停住的管线留一个显式人工重试 | [`.agents/skills/dsh-git-write-gates/SKILL.md`](.agents/skills/dsh-git-write-gates/SKILL.md) | 写前 fail-closed 校验、路径冻结、环境隔离与恢复入口设计。 |
| 怎么用类型化闸把两个评审会话身份分开，并在 git 写前覆盖所有活会话字段 | [`.agents/skills/dsh-typed-session-identity-gate/SKILL.md`](.agents/skills/dsh-typed-session-identity-gate/SKILL.md) | source 绑定 verdict、禁用 `||` 兜底、双向交叉拒交测试与全阶段会话活跃检查。 |
| 怎么诚实标注真机取不到的证据，并把搭档的「承诺」核对成真正落地的源码状态 | [`.agents/skills/dsh-evidence-integrity/SKILL.md`](.agents/skills/dsh-evidence-integrity/SKILL.md) | 证据边界、拒绝伪造轨迹、按源码确认上报结果。 |

## 维护

- 中英结构保持一致，一起改。
- 这里不写测试数量、版本号、日期或「已验证某版本」；让能承载这些的那份文档去写。
- 插件集合、生命周期阶段或路线图分期发生变化时，连同事实来源一起更新本文件，不凭记忆写。
