# dsh-factory 路线图

> 状态日期：2026-11-15。本文件面向任何接手这个项目的人：读完应能独立判断「它现在能做什么、下一步做什么、为什么这么定」。
> 设计取舍的**理由**写在这里，避免重复争论；具体实现细节看源码，运行命令看仓库的 `AGENTS.md` 与各目录约定。

## 1. 这个插件要做什么

把一条需求（GitHub issue）变成可评审的 PR，中间每一步都交给独立的 agent 会话去做，人只在关键闸门上点头。

三个不可让渡的点：

1. **一张卡 = 一个独立会话 + 一个独立工作区**。卡与卡之间不共享工作目录，也不共享依赖。
2. **commit / push / 开 PR 永远由人批准**。插件可以自动准备一切，但不会自己把改动推出去。
3. **多项目是一等公民**。每个项目有自己的根路径、看板、卡和配置，互不干扰。

长期目标是「定时发现 issue → 分析 → 自动开发 → 交付出 draft PR」，但**合并永远留给人**。

## 2. 现在能做什么（2026-11-15）

### 2.1 数据与看板

- 三层模型：**项目 → 看板 → 卡**。
- 卡的生命周期是 8 个状态：`inbox` / `triage` / `plan` / `plan-review` / `build` / `review` / `done` / `canceled`。
- 每次状态转移都记录是谁做的（人 / agent / 自动规则），可全局审计。
- 收件箱是数据状态，在界面上单独呈现，不占看板列。

### 2.2 派发与工作区

- 每张卡派发时建一个 **git worktree**，分支为 `factory/<cardId>`，会话的工作目录就是该 worktree。
- **worktree 隔离是强制的，不提供关闭开关**：所有项目、所有自动化档位一律在 worktree 内干活。原因是「在项目根直接改」会推错分支、卷入未提交改动、并击穿授权闸门。
- 建完 worktree 后可执行项目自定义的准备步骤：
  - `copyFiles`：把项目根下被 git 忽略的本地文件（如环境变量文件）拷进 worktree；
  - `postCreate`：在 worktree 内跑一条用户自填的准备命令。
  - 两者都**不预置任何默认值**：装什么依赖、跑什么验证由目标仓库自己的约定决定。任一步失败则整体回滚（删 worktree 与分支、卡留在收件箱）。
- **一个全局的「worktrees root」设置**决定新 worktree 建在哪里，在项目工厂页顶部一个可折叠的设置区里。留空即用默认 `~/dsh-factory-worktrees`（按用户主目录解析）：输入框占位显示该默认值，另有一行「当前生效」显示解析后的绝对路径。它只影响此后新建的 worktree——已有项目与在跑的卡都不受影响。被拒绝的值会把后端的原始错误原样透出。该根下每个项目占一个目录，名字由项目名的 slug 加 id 的一小段前缀组成（改名不会让路径失联，同名项目也不会撞），每张卡的 worktree 再嵌在它下面。
- **worktree 路径由同一道闸门挡在数据根之外。** 根通常可以落在数据根外；唯一的根内例外是 `<home>/dsh-factory-worktrees` 这一条精确子树，用于 HOME 本身就在数据根内的布局。会话库、缓存、其它项目的 state、以及别处的同名目录仍然禁写。包含关系每次调用都实时解析（`resolveDataRoot()` / `homedir()`，从不缓存），`assertWorktreeRoot`、`worktreePathFor`、`createWorktree` 三处都过同一个 `isAllowedWorktreePath` 检查。显式的 `DSH_FACTORY_WORKTREE_ROOT` 覆盖值不继承该例外。HOME 在数据根外的机器行为不变。

### 2.3 会话接续（三级降级）

一张卡会经历多个阶段，每个阶段需要新的 agent 会话，但必须复用同一个 worktree 与分支。接续按三级降级，逐级记录、不静默：

1. **会话还活着** → 直接向同一会话追加输入（最省）；
2. **会话已结束、历史还在** → 按持久化会话恢复，上下文完整；
3. **历史不可用** → 新建会话并注入历史摘要，同时在卡的历史里记一条降级记录。

失败处理：接续失败只释放占用，不改卡状态、不删 worktree，可重试。

### 2.4 熔断

同一张卡连续派发失败达到阈值（当前为 3 次）即标记为 stalled、停止自动重试，等人工处理。

### 2.5 授权闸门

- 「确认提交」与「推送分支并创建 PR」是两个独立的人工动作，没有批准就没有任何 git 写。
- 自动模式下可以自动走到 draft PR，但**不自动合并**、不自动标记完成、不自动提权。
- 拒绝向受保护分支推送、拒绝空 diff、不 force push。

### 2.6 项目创建助手

- 一个只读分析工具：读取目标仓库的客观事实（根目录文件、目录、忽略规则、清单文件、声明的包管理器），**不返回任何「该跑什么命令」的结论**。
- 一个创建工具：直接登记项目。创建是本地可逆的配置登记，不碰任何 git 写。它**按 git index 剔除已被跟踪的 `copyFiles` 项**——已跟踪文件新 worktree 本来就带，复制纯属冗余；这一步是确定性护栏，不依赖模型判断。
- `/factory add [path]` 命令只是**触发器**：它把意图交给 agent，由 `factory-add-project` 技能引导 agent 分析仓库、生成配置提议、再创建项目。不带路径时使用当前会话的工作目录。
- 项目根**可以**落在数据根内（用户有些仓库就在那里）：允许登记、带一条 warning，但**不许当会话 cwd**，worktree 强制外置。这条在真机验过（V2b）。
- `GET /api/dsh-factory/status` 暴露 `toolsRegistered`：工具注册失败曾长期静默降级（命令和接口照常成功、agent 却没工具可调），现在有可被客观读到的信号。

### 2.7 技能

7 篇：6 篇阶段技能（分诊 / 计划 / 构建 / 自审 / 评审 / 复评）+ 1 篇项目添加技能。阶段技能与状态机的「agent 可推进」边一一对应。

### 2.8 自治档位

共三档。`L0` 严格零动作。`L1` 是默认：引擎只走 `inbox -> triage` 一条边，卡片停在 `plan-review` 等人。`L2` **默认关闭、必须按项目显式开启**，不设仓库或卡片白名单。

在 `L2` 下机器多走一条自动边 `plan-review -> build`，代卡片批准计划。它与其他转移一样走同一个 `autoRule` actor、过同一道 `assertTransition` 状态闸，所以到不了闸门不允许的状态。边界是有意收窄的：机器**只批准计划**，卡片进 `build` 就停；武装交付授权（commit、push、开 PR）仍留给人，机器绝不碰 git、不创建 PR。这比「全自动到 draft PR」更窄——机器不武装、不交付。

`pause` 与单卡 `takeover` 对批准也立即生效：被暂停的项目或被接管的卡不会被自动批准，暂停期间跳过的卡恢复后也不补跑。重复 tick 幂等，这条自动边没有通往 `done` 或 `canceled` 的路径。

## 3. 已经定死、不必再争的设计

| 决定 | 理由 |
|---|---|
| worktree 强制开、不给关 | 关掉会在项目根直接干活：推错分支、卷入未提交改动、授权闸门无法界定改动归属 |
| 隔离用 git worktree，不用「独立目录 clone」 | 两者在「依赖独立、本地文件要拷」上等价；worktree 建造是秒级、远端天然正确，且不会在侧栏堆出一堆工作区 |
| 不追求真容器沙箱 | 宿主环境没有容器化能力，只能做「限制写入范围」级别的隔离；不假装它是强隔离 |
| worktree 路径在数据根外，只留一条主目录子树例外 | worktree 落进会话库、缓存或别人的项目 state 会损坏无关数据；根内唯一容忍的是 `<home>/dsh-factory-worktrees` 这一条精确子树，每次实时解析，三处边界检查共用同一道闸 |
| 单一全局「worktrees root」设置，留空即用按 HOME 解析的默认 | 一个设置比每个项目各配一根更好推理；默认用 `homedir()` 表达，绝不写死机器相关的绝对路径 |
| 每阶段新建会话 + 历史摘要，而非同一会话用到底 | 评审阶段必须独立：自己审自己会破坏注入防御与评审纪律 |
| 默认由人把守计划审批与交付授权 | 默认每一道闸门都留给人；L2 只能通过按项目显式 opt-in 委托**计划审批**这一项，绝不委托交付 |
| 只有 L2 能自动批计划，且必须显式 opt-in | 默认关、无白名单；机器经 `autoRule` 走 `plan-review -> build`、过同一道状态闸，然后停住。武装交付、git 写与合并永远留人 |

## 4. 后续计划（按优先级）

### P1 — 真机全链验证（**已完成**，2026-11-15）

`/factory add` 的完整链路：命令 → agent → 技能 → 工具 → 项目出现在看板。**已在真机跑通，六轮收敛。**

- 验收（最终口径，七组）：**V0** 工具注册（读 `GET /api/dsh-factory/status` 的 `toolsRegistered`，不采信 agent 自述）；**V1** 无参 `add`（会话 cwd 必须是数据根**外**的真实 git 仓根，这是环境硬限制）；**V2a** 带参常规路径；**V2b** 带参**数据根内**仓库（登记成功 + `warning` 有值 + worktree 落在数据根外）；**V3** 确实是 agent 调的**且调用成功**（不是命令自建，也不是报错后改用别的手段补齐）；**V4** 提议有依据、`copyFiles` 每项未被 git 跟踪、不含插件内置命令；**V5** 项目进看板 + 删除后仓库文件仍在。
- 取证：以「项目数从 0 变 1」判定真的建成了，不采信 agent 自述；截图前先强制刷新，排除旧前端产物。
- 六轮账本（前五轮全是真故障，没有一条是测试用例的问题）：

| 轮次 | 卡在哪 |
|---|---|
| 1 | `package.json` 未声明 `@deepseek-ai/dsh-tools` peer → 宿主 loader 不注入，`import` 必失败，六个工具全没注册 |
| 2 | 工具返回 `warning: undefined` → 过不了宿主的 lossless-JSON 校验，数据根外的仓每次调用必失败 |
| 3 | 六个工具的 `render` 返回字符串 → 违反 `ContentBlock[]` 契约，下游 `content.some` 崩，六个工具全废 |
| 4 | `copyFiles` 列出已被 git 跟踪的文件 → 判断波动，改成代码层护栏（按 git index 剔除） |
| 5 | 随包技能没传 `source` → 宿主不补这个字段，7 个技能在真机上一个都注册不上 |
| 6 | 全绿：技能真正生效（轨迹出现「加载技能」，agent 自己跑 `git check-ignore` 核对），七组判据全过 |

前四条（peer / 序列化 / render / 技能 source）都是「插件在真机上根本不可用」级别，已全部修掉。第 4 条不再依赖 agent 自觉，`factory_create_project` 会按 git index 剔除已跟踪项并丢弃，第五轮实测护栏确实触发（agent 传了 4 个已跟踪文件，全部丢弃，入库 `copyFiles` 为空）。

### P2 — 自治引擎（L1 **已实现、已提交，并在真机端到端验通**）

`autonomy` / `autoStart` / `autoApprove` 三个字段原本只有存储与写入校验、没有任何代码读取它们做决策。**L1 引擎已落地**（`autonomy.js`）：

- **一个插件级定时器**，挂在宿主 timer 服务上，卸载随插件清理；服务缺失不静默降级，原因在 `status.engine.timerReason` 可读。多项目只是每轮枚举，不是多个定时器；tick 单飞不叠加。
- **L1 只走一条自动边**：`inbox -> triage`，经 `dispatchCard` 完成，actor 记 `autoRule` 并带 `tier`/`rule`/`channel`。阶段推进仍由会话内技能以 `agent` 身份完成，**引擎不自己挪卡**；到 `plan-review` 停住等批。**agent preset 必须显式挂载**：派发会话以前从没挂 preset，所以没有 `tool-bash`、只能去抓宿主全局的 SSH 工具，沙箱也管不着它；现在在 `setup` 里调用 `agentPresets.mount(agentCtx)`（**不传 id，跟随用户当前选择的预设**），拿不到该服务就拒绝派发——这条是真 bug，已修。技能指引与技能正文的注入也已落地。
- **`autoApprove` 在 L1 一次不读**：即使 `L1 + autoApprove=true` 也停在 `plan-review`，防「字段开着、代码顺手就用了」的越权。
- **并发两级上限**（项目级 + 全局兜底），按运行时活跃会话计，不按 `sessionId` 字段计；满额排队不丢卡、不标 stalled，有空位后由后续 tick 取走。
- **暂停 / 恢复 / 单卡接管**是三个独立动作、各自持久化并留治理记录。暂停与接管都**不打断**已在运行的会话，只影响后续 tick 的自动派发——硬杀会话会留下 worktree 和半截改动。
- **默认零副作用**：`L0` 严格零动作；缺 issue 源或目标看板的项目被跳过，原因在 `status` 可见，**不猜、不从 git remote 反推、不自动建板**。
- **同步不代批**：`sync.js` 改用独立 `syncRule` actor + 空白名单 `SYNC_AUTO_EDGES`，远端「PR 关闭」建议只记待人处理、不会把等批的卡推进 `build`；L2 下的计划审批改用 `autoRule` actor，与同步严格分开。
- **权限档不虚报**：`permissionEnforced` 恒为 `false`，界面与状态不得宣称写入限制已生效。
- **沙箱三道硬保证**（派发与续派的三级链每一级都过同一套闸）：① 在 `createSession` 的 `seed` 里写 `sandbox/mode: workspace-write` 固定模式（无时序竞态）；② 建完回读 `sandboxMode` 投影校验，不符就 dispose 并拒绝；③ 权限上限为 `workspace-write`，项目配更高档也不放行。修复前的历史会话在接续时被拒绝并降级重建，旧的全权会话不复用。

**验收状态**：离线用例与真机四项（`status.engine` 字段、暂停/恢复、接管路由、审计路由）已验。**真实自动派发（AE-2）现已在真机端到端验通**：一条真实 GitHub issue 被发现并建成卡片，引擎只走唯一一条自动边 `inbox -> triage`（记为 `autoRule`），派发的 agent 把卡片推进过 `triage`、`plan`，停在 `plan-review`——全程无人工点击。此前几轮失败是验证夹具与任务内容不匹配（空壳仓没有与任务对应的源码），不是产品缺陷；这一轮用的是内容与任务相符的仓库，且清理前等 `turn/end` 落定，见 §5 与 §7。

### P3 — L2，机器代批计划（**已实现并在真机验通**）

**按项目显式 opt-in**（默认关、无白名单）：机器可以批准计划，多走一条自动边 `plan-review -> build`，以 `autoRule` 走其他转移共用的同一道 `assertTransition` 状态闸。边界有意收窄——机器**只批准计划**：

- 卡片进 `build` 就停；**武装交付授权仍留给人**，机器绝不碰 git、不开 PR、不合并、不标记完成。这比「机器也武装交付」的最初设想更窄——那部分有意不做，是选定的边界、不是缺口。
- `pause`（项目或全局）与单卡 `takeover` 立即挡住批准，不补跑暂停期跳过的卡；重复 tick 幂等；这条自动边无旁路到 `done`。
- `L0` 与 `L1` 不变：即使设了 `autoApprove`，也只有 L2 项目会响应它。

已在真机验证：`L2 + autoApprove` 下一张等批的 `plan-review` 卡被批进 `build`、审计字段齐全；`L1`/`L0` 保持惰性；暂停、接管、幂等都成立；无旁路到 `done`；AE-2b 同步路径未回退。这是**自治钥匙的另一半**——计划审批交给机器，交付授权仍握在人手里。

### P4 — 自治档界面（未开始）

设置页、状态徽标、暂停/接管。**前置**：引擎行为先落地，否则是空开关。

- 硬要求：界面状态必须按档位字段判断，**不能按两个开关判断**——因为「档位已回到手动、开关还开着」是合法组合，按开关判会显示成「正在自动运行」而引擎实际不动。
- 硬要求：保存失败必须把错误原文显示给用户，不许吞掉。
- 硬要求：档位被静默归一（新建项目路径）后，界面必须回显归一后的实际值。
- 硬要求：准备配置与自治档**分成两个独立区块、各自保存**——后端不接受两类字段混在同一次写入。
- 规划：设置界面还要提供**并发上限**的设置入口——项目级 `maxActiveSessions`（覆盖项目级默认值）与全局级 `globalMaxActive`（硬顶，项目值再大也越不过）。层级语义：项目值覆盖项目级默认值、全局值是项目值不能越过的硬顶，有效名额取两者较小。此项属 P4 范围——这里只记规划，本轮不实现界面。

## 5. 已知缺口（别当它是完整的）

| 缺口 | 影响 | 备注 |
|---|---|---|
| **【安全 · 已修】派发会话曾默认拿到 `danger-full-access`，绕过 worktree 沙箱（真机暴露）** | 真机验证中，用户观察到派发的 agent「找不到 worktree」并浏览了**宿主可见的文件系统**。机制（Dev 读源码闭环）：`meta.cwd` 经 `sessions.prepare` 写进 `header.cwd`，而它**正是 `workspace-write` 沙箱的 `workspaceRoot`**（`dsh-sandbox-policy` 的 `sessionWorkspaceRoot()`），bash 执行时按调用 session 解析该策略并 `confine()`——**所以 cwd 恰恰是边界，不是「只决定起始目录」**；bash 是 harness 进程的子进程、在**容器内**执行（bubblewrap 文件隔离），不是跨到宿主另一侧。唯一让边界失效的开关是 mode：`danger-full-access` 下 `dsh-bash-sandbox` 直接 `super.execute()`、**不套沙箱**。而本 profile 的 `permission-presets.defaultPreset` 正是 `danger-full-access`（`approval: never`），且 `dsh-permission-presets` 在 `agent/created` 事件里用 `pinInitialPermission` **把该档钉到每个新会话**——这才是 mode 的来源，比 base patch 的 `defaultMode: workspace-write` 优先级更高。工厂的 `project.defaultPermission` 默认 `workspace-write`（`store.js`），**却和 `model` 一样在 `createSession` 层被丢弃、从未传给 `agents.create`**，于是派发会话被钉成 profile 默认档、裸奔 | **没有实际越界写入**：Chief 核查宿主，workspace 卷 `git status` 干净、HEAD 未变、只动过 `.git/COMMIT_EDITMSG` 与 `.git/index`（我们自己提交），无外推；**只证明看过路径，不能证明写入**。**已修并在真机验证**：自动派发现已在下述闸门下运行，AE-2 端到端链路在这些闸门生效的情况下通过。修法（Chief 定，Dev 已查清时序；现已落地并验证）：① **`createSession` 的 `seed` 里带一条 `sandbox/mode: workspace-write`**——`agents.create` 的执行顺序是「先写 seed → 再 setup → 最后 announce（即 `pinInitialPermission`）」，seed 写入后 `pinInitialPermission` 看到 `sandbox !== null` 就跳过 `setSandboxMode`，**无时序竞态**。**为何选 seed 而非在 setup 里抢先**：seed 是构造参数、语义就是初始事件，不依赖「赶在某个回调之前」的时序，宿主调整顺序也不会失效（时序依赖是脆的）。② **无论哪条路，建完都必须回读 `sandboxMode` session 投影校验**（`dsh-sandbox-policy` 注册 key `sandboxMode`）——不是 `workspace-write` 就 dispose 会话并抛错、走 `dispatchCard` 失败回滚；这是硬保证，防「写了事件就假设生效」，也防宿主版本/配置差异让折叠逻辑不同。③ **自动派发会话的权限上限是 `workspace-write`，即使项目配了 `danger-full-access` 也不放行**（自动派发不该有全权，`project.defaultPermission` 接上但以此上限封顶）；④ worktree 根现在默认用按 HOME 解析的 `~/dsh-factory-worktrees`，走 §2.2 所述的方案 B 窄例外（通常位于数据根外；根内只容忍 `<home>/dsh-factory-worktrees` 这一条精确子树）。⑤ **修复前的历史会话**（无 `sandbox/mode` 事件、可能落在 profile 的默认全权档）在接续时被**拒绝并降级重建**，已落地、不是待办：level 1 的 `followupSession` 与 level 2 的 `resumeSession` 都过 `assertSandboxMode` 闸——level 1 被拒不再让卡卡死，直接降级；level 2 被拒则 `dispose` 该会话再抛错，让 `continueCard` 落到 level 3，用 `createSession` 的 seed 闸重建一个带 `workspace-write` 的新会话，并在卡上记一条降级记录。这样旧的全权会话不会被继续复用，也不必手动清理。另建议用户把 profile 的 `defaultPreset` 改为 `workspace-write`——**这影响其界面上所有普通会话的沙箱保护**，需用户点头单独确认，不与工厂修复捆绑，本鱼不擅自改 |
| **写入与回执之间没有事务边界（工厂侧窗口已焊死，宿主侧窗口仍在）** | 工具过去先 `execute`（写入已落库）再 snapshot/lossless 校验/render；任一步失败就变成「写入已发生但报错」，回执丢失。真机上表现为重名项目堆积 | **由用户拍板选方案 A、已在工厂侧修好**：三个写工具（transition / report / createProject）在落盘前先做回执自检——lossless → schema → render → render lossless 全过才写库。schema 校验生产注入宿主的公开校验器；lossless 用本仓的最小实现、置于可注入端口之后。失败抛原始错误、日志可观测；已端到端验证并做变异验证（摘掉预检则用例变红）与全量回归。**L1 四项措施保留**（幂等、单飞、孤儿对账只报不清理、`dispatchCard` 回滚）：与本修复正交、是防御纵深，不是被替代。**如实记录已知缺口**：① 宿主对任意工具的 write/receipt 窗口仍在，方案 A 只堵工厂自身这条链路；② 本仓 lossless 最小实现与宿主快照函数是两份同语义实现，宿主规则若变动会漂移（schema 那半边已注入宿主真函数消除）；③ 宿主真成功回执流水线本仓不可 import（peer-only），那一环在此测不到。宿主侧 B/C 方案未立项——记为已知缺口，不单独立项 |
| **`card.repo` 与 `card.repoPath` 已拆分** | `intake.js` 把远端 GitHub 标识写入 `repo`、本地根路径写入 `repoPath`；`session-context.js` 的 `repoOf` 优先用 `repoPath`，`repo` 只作展示标识渲染 | **已解决**：两种语义不再共用一个字段，agent 不会再拿到「当路径用的远端标识」。（原为 L2 前置，见 PRD §10） |
| **L1 真实自动派发（AE-2）已端到端验通** | 「真实 GitHub issue 源 → 建卡 → 自动派发 → 停 plan-review」这条链现已在真机跑通，全程无人工点击 | **已验通**：引擎只走 `inbox -> triage` 这一条自动边（记为 `autoRule`），派发的 agent 把卡片推进过 `triage`、`plan`，停在 `plan-review`。链路细节见 §4 P2。（此前因缺真实 issue 源与匹配夹具而未验） |
| **接管无 UI 入口** | `POST /cards/:id/takeover` 只能走 HTTP，`client.js` 里没有按钮；与「删除项目无 UI 入口」同类 | 归 P4 界面一起做 |
| **路由命名易混** | 实际路径是 `/cards/:id/takeover`，不是 `/take-over`；照着猜会 404（QA 真机已踩） | 已请 Docs 在 README 接口说明写清实际路径 |
| **agent 行为漂移（观察中）** | 第 5、6 轮 agent 改用提问卡等确认再建项目，前 3 轮是直接建。判据未要求「不许问」，项目也确实建成 | 倾向判定为技能生效后的正常表现（技能正文写了「先把配置给用户看」），非缺陷。记在此观察，别等到 P2 才发现 agent 到处问 |
| 只支持 GitHub | GitLab 相关技能未实现 | 有明确落点再补 |
| 没有 webhook | 发现 issue 靠轮询 | 单机场景够用 |
| 单机、无多副本协调 | 并发锁只在单进程内有效 | 不是当前场景的问题 |
| 权限字段是可配置值，不是强制边界 | `defaultPermission` 可配，但派发会话的沙箱模式已被上面三道保证真正钉在 `workspace-write`；`permissionEnforced` **刻意恒为 `false`** | 不虚报：界面与状态都不宣称写入限制已生效。沙箱边界本身是真实且已验的；`permissionEnforced` 保持 `false` 正是这份诚实信号，不是未修的缺陷 |
| 分支名是纯标识符 | 人工 review 时可读性差 | 纯改进，非阻塞 |
| 收件箱发现由引擎定时触发 | L1 定时器每轮 tick 都跑 intake（origin 记 `autoRule`，并遵守 `intakeLimit`）；手动 intake 仍可走 HTTP | 随 L1 引擎一并实现——发现 issue 不再需要手动触发 |
| 删除项目无界面入口 | 只能调 HTTP 接口删（`client.js` 无 DELETE 调用） | P4 界面一起做 |
| 删项目不清 worktree | `deleteProject` 只删登记，worktree 根下残留目录 | 低影响，P4 一起处理 |

| ~~intake 拉取数量曾写死 `--limit 100`~~ | issue 很多的繁忙上游一次 tick 就可能灌满看板，随后每张新卡都被派发成真会话 | **已修并验证**：改为项目级可配的 `intakeLimit`（默认沿用原上限、保持向后兼容），由引擎 tick 传给 `intakeIssues`；设了值就按值限制每次拉取的建卡数 |
| **intake 无 label 过滤** | 只能按「全部 open issue」拉，不能只拉指定 label 的 issue；配合不限量的上游仓仍可能拉进大量无关 issue | 保留为缺口，本轮不做（与 `intakeLimit` 是两个功能，别混）。可用 `intakeLimit` 先压量兜底 |
| **派发消息曾未指定阶段技能（已修）** | `session-context.js` 的 `firstMessage` / `sectionText` 原本 `skill` 一词零命中——只说「用 `factory_transition_work_item` 推进」，没说「按 `factory-triage` 技能办事」。对比 `/factory add` 的 `buildAddIntent` 明确写了技能名 | **已修**：两段文案都点名当前阶段技能（`inbox`/`triage→factory-triage`、`plan→factory-plan`、`build→factory-build`、`review→factory-review`；`plan-review`/`done`/`canceled` 无技能）并写明先加载技能再动手，已提交。**注意：只修这条并没让 AE-2 通过**，还有更下层的模型路由问题（下一行）也要修；两者现已都修好，链路已端到端验通 |
| **自动派发的会话曾停在 `triage` 不调工厂工具（AE-2 根因——已修并验通）** | 早几轮真机验证中，每轮都确认宿主 `build` 为新代码、前半链（建卡 / 自动派发 / `inbox→triage` / 审计可区分 / 无 push/PR）照常通；但派发会话始终停在 `triage`、`sessionTurn=1`、`report=null`，不调 `factory_transition_work_item`、没到 `plan-review`；引擎 `lastError:null`、无 orphan | **根因（Dev 追到源码行号，Chief 认可）**：`dispatch.js` 的 `createSession` 当时不解构也不使用 `model`（`dispatch.js:334`，注释自认「not yet wired」）→ `agents.create` 不传 `agentOptions`，agent-loop 补成 `{}`（`dsh-agent-loop:1706`）→ `assertAgentOptions({})` 只校验 maxTokens、放行（`1264-1266`），所以会话建得起来、不报错 → `preStep` 里 `model.current()` 返回 undefined 抛错（`684-685`），被 `kick()` 的 `catch(_error){}` **静默吞掉**（`667`）→ 表现就是「turn=1、啥都没干、无 error 上报」。**四轮已排除**：ESM 缓存、技能指引缺失、preset / `skill` 工具、正文内联（`.26` 仍无变化）。**用户定的模型语义**：会话默认跟随 DSH 默认模型，UI 后续可手动选。修法选 **B**（Chief 定）——port 层 `ctx.get('agentDefaultModel')` 读 `currentSelection()`，照 UI 入口用 getter 形式（**每次读取时现取、不缓存**，理由是与宿主 UI 同构；`currentSelection()` 无副作用，配置在多次读取间变化的极端竞态由下一轮自洽，不是设计缺陷）；`project.defaultModel` 有值时覆盖 model 部分、无值跟随宿主；`createSession` 真接上 `model`。**fail-fast 关键判据**：构造 `agentOptions` 前先探一次 `currentSelection()`，若 `provider` 或 `model` 拿不到就**立即抛错**、走 `dispatchCard` 失败回滚并记到卡上——把「静默停在 triage 什么都不说」变成「派发明确失败并说明原因」，因为宿主 `kick()` 的 `catch(_error){}` 会吞掉会话内部错误，不能依赖它。**已按方案 B 修好并在真机端到端验通——见 §4 P2。** |
| **真机派发起的会话无法主动终止（已知不可清理项）** | AE-2 四轮真机各起一个真 agent 会话（id：`d726dd75…`、`4d5d6911…`、`6ab382b7…`、`e8a6a538…`）；测试项目删掉后引擎不会再派它们，但宿主会话列表里可能仍 idle。`sessions` API 不可用，插件侧无法主动终止 | **起真会话的实际成本**，不是 bug。真机验收收尾要如实记「可能残留 idle 会话」及会话 id，别让它变成下次的谜团；不要为「收尾干净」而谎报已终止 |
| **【验证夹具】空壳测试仓造成「agent 不回执 / 跑出 worktree」的假象** | 真机验证曾用一个只有空 README 与单个 init 提交的最小仓作项目根，worktree 从它拉、里面**没有任何与卡片 issue 对应的源码**；卡片任务却是真实上游 issue。agent 合理地去 `/tmp` 克隆真源码做调查，于是被误读成「不守 worktree」「不回执」 | **不是 agent 行为缺陷，是测试夹具与任务内容不匹配**。连续几轮的「agent 有问题」结论查到底都是环境/配置问题：预设未挂载、工作目录被清理过早、worktree 空壳。技能正文本身要求「只在 worktreePath 内工作」，不引导去 `/tmp`。**危害**：用空壳仓验「回执」「是否留在 worktree」，得出的结论都不成立。**修法就是换用内容与任务相符的真仓库**（有对应源码）——用这种夹具链路已端到端验通；长期纪律见 §4 P2 与 §7 |
| **AE-2b 的「远端 PR CLOSED 快照注入」（真机入口已加）** | `applyRemoteSync` 过去只有函数与单测调用，真机没有办法喂入远端快照。现在有了受控产品入口——`POST /api/dsh-factory/cards/:id/remote-sync`（弱幂等）——调用现成的 `applyRemoteSync`：只记建议、绝不落卡片状态，目标列由远端状态推导、actor 固定 `syncRule`、鉴权继承宿主的 connection 闸。两版 README 已写明该路由；将来 webhook 可复用它 | **已在真机验证**（入口安全与远端建议判据通过）。源码逻辑不变：`SYNC_AUTO_EDGES` 仍是空表、「PR 关闭」建议只记录、不应用。**已知缺口**：① 请求体过大时返回服务端错误而非预期的客户端错误——这是宿主既有全局行为、非本次引入；② 入口未鉴权时 fail-closed 只在代码层确认、未在真机主动触发，因为那样会越过宿主边界 |

## 6. 调研依据（摘要，避免重复调研）

这个插件没有直接 fork 任何现成实现，而是对比两份参考实现后取长补短：

- **参考 A（看板型插件）**：卡片绑独立会话、移动列即给 agent 下达阶段指令、worktree 隔离与清理前脏检查、后台三件套（看门狗熔断 / 成本计量 / 定时任务）成熟。但它**只能配一个项目根**，且没有计划审批门。
- **参考 B（工厂型框架）**：项目→看板→阶段的多源交付平台，有显式的「计划→提交审批→建造」闸门与独立评审纪律。代价是逻辑压在超大运行时依赖里，并硬绑外部数据库、队列与沙箱供应商。

采纳结论：**骨架取 A（卡片=独立会话、worktree 隔离、看门狗），闸门与评审纪律取 B，多项目自己做**（A 做不到、B 的实现方式对本机场景过重）。

## 7. 怎么参与

- 先读仓库根与插件目录下的约定文件，再动代码。
- 改动前先确认它属于哪个优先级；P1 未完成前，新功能一律排在它后面。
- 任何涉及 git 写的改动都必须经过人工授权闸门，测试不得绕过。
- 测试由专人维护，不通过自证；数字以实际运行结果为准，不接受「看起来能跑」。
- **数据根相关测试一律注入临时 `DSH_HOME`**：指向 `tmpdir()` 下的临时目录，跑完还原原值并删净。不写真实数据根、不靠 `skip` 规避——数据根判断是惰性求值，进程内改环境变量立即生效，所以用例能真跑起来，覆盖面比跳过更大。
- **「会话不响应」先确认 agent 有没有在推理，再改 prompt**：AE-2 四轮里有两轮花在改 prompt（技能指引、正文内联），真机行为一点没变，根因在更下游（模型路由 / 执行机制）。排查顺序：确认新代码真在内存（`build`）→ 会话是否产生下一个 turn → 有没有工具调用 → 模型路由是否接通 → 最后才轮到 prompt 内容。改 prompt 前不完成前三步，就是拿真会话烧 token 猜谜。
- **真机验证必须用「内容与任务相符」的真仓库**：项目根要指向**含任务所涉源码**的仓库，别用只有空 README 的最小仓。worktree 是从项目根拉的，根里没代码，agent 只能去别处克隆真源码调查——此时验「是否留在 worktree」「有没有回执」得出的结论都不成立，还会被误读成产品缺陷。夹具与任务不匹配时，先修夹具再下结论。
- **取证清理前必须等 `turn/end` 落定**：判据是 `turn/end.reason.kind`（`error` 即异常/被打断），不是其后的 `session/end` / `job/settled:completed`——那些是崩溃后的收尾事件，不是正常结束的证据。提前删 worktree 会抽掉 agent 的 cwd，让它没法走完「写报告 + 推进卡片」的收尾，看起来像「不回执」，实际是被打断。等 turn 真正结束（或明确 error）再清理。
