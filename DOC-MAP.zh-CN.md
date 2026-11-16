# 文档罗盘

这份文件是本仓库文档的地图：每个插件现在在什么位置、下一步做什么、想了解某件事该读哪份。它是**带上下文的目录**，不是被指向文档的副本。细节一旦在某份文档里定下来，那份文档就是事实来源；这里只告诉你去哪找。

## 当前状态

生命周期阶段以 `scripts/plugin-release-states.json` 为唯一来源，只能单向前进：`draft` → `testing` → `published`。各阶段的含义与发布规则见 [RELEASING.zh-CN.md](RELEASING.zh-CN.md)。

| 插件 | 生命周期 | 进展 |
| --- | --- | --- |
| [`@summerscar/dsh-mnemon-sync`](plugins/dsh-mnemon-sync/docs/README.zh-CN.md) | `published` | 已发布，进入常规维护；后续改动走正常更新流程。能力与限制见它自己的 README。 |
| [`@summerscar/dsh-connect-agentscope-platform`](plugins/dsh-connect-agentscope-platform/docs/README.zh-CN.md) | `published` | 已发布，进入常规维护；同样的更新流程。账号处理、可选模型供应商与额度面板见其 README。 |
| [`@summerscar/dsh-factory`](plugins/dsh-factory/docs/README.zh-CN.md) | `draft` | 开发中；源码已入库但尚未发布。完整的添加链路已真机验过，L1 自治引擎已实现。 |

工厂是目前唯一在开发的插件。它现在能做什么、还有什么没解决，都要读它的路线图：[§2](plugins/dsh-factory/docs/ROADMAP.zh-CN.md) 写当前行为，[§5](plugins/dsh-factory/docs/ROADMAP.zh-CN.md) 列已知缺口。其中两条直接影响自动派发的安全——派发会话的权限边界、写入与回执之间的窗口——属于前置条件，不是普通待办。缺口清单不等于「已验证行为」的完整清单，判断以源码和真机为准。

## 未来规划

下面只给全局视图，细节、取舍和验收标准在[路线图 §4](plugins/dsh-factory/docs/ROADMAP.zh-CN.md)，缺口与未满足的前置条件在 [§5](plugins/dsh-factory/docs/ROADMAP.zh-CN.md)。

| 阶段 | 目标 | 状态 | 去哪看 |
| --- | --- | --- | --- |
| P1 | 在真机上验证完整的添加链路 | 已完成 | 路线图 §4 P1：验收分组与逐轮账本 |
| P2 | 自治引擎 L1 | 已实现；自动派发链路尚未端到端验通 | 路线图 §4 P2 与 §5 |
| P3 | L2，自动推进到 draft PR | 未开始 | 路线图 §4 P3：单独一轮，因为它改变批准来源 |
| P4 | 自治档位、状态与暂停／接管的界面 | 未开始 | 路线图 §4 P4：依赖引擎行为先稳定 |

**下一步**：先清掉 §5 里挡住派发的缺口，再用内容与任务相符的仓库在真机上验自动链路。P3 有意单独成轮，因为它移动批准来源；P4 只有在它要展示的引擎行为稳定之后才有意义。

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
| 怎么把插件投递到两个社区市场 | [`.agents/skills/dsh-plugin-market-release/SKILL.md`](.agents/skills/dsh-plugin-market-release/SKILL.md) | 两种投递形态、字段规则、返修与改名流程。 |
| 怎么发 npm、推进生命周期 | [`.agents/skills/npm-plugin-release/SKILL.md`](.agents/skills/npm-plugin-release/SKILL.md) | 发布工作流、OIDC、提交推送前的同步。 |
| 怎么在真机上验证插件 | [`.agents/skills/dsh-plugin-live-verification/SKILL.md`](.agents/skills/dsh-plugin-live-verification/SKILL.md) | 宿主契约、静默降级、环境变量路径、取证纪律。 |

## 维护

- 中英结构保持一致，一起改。
- 这里不写测试数量、版本号、日期或「已验证某版本」；让能承载这些的那份文档去写。
- 插件集合、生命周期阶段或路线图分期发生变化时，连同事实来源一起更新本文件，不凭记忆写。
