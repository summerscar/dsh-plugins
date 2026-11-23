# dsh-factory 路线图

> 状态：以下描述的是已实现的行为，不是排期；文中各期均已完成。本文件面向任何接手这个项目的人：读完应能独立判断「它现在能做什么、下一步做什么、为什么这么定」。
> 设计取舍的**理由**写在这里，避免重复争论；具体实现细节看源码，运行命令看仓库的 `AGENTS.md` 与各目录约定。

## 1. 这个插件要做什么

把一条需求（GitHub issue）变成可评审的 PR，中间每一步都交给独立的 agent 会话去做，人只在关键闸门上点头。

三个不可让渡的点：

1. **一张卡 = 一个独立会话 + 一个独立工作区**。卡与卡之间不共享工作目录，也不共享依赖。
2. **交付止于 draft PR，合并永远是人的动作。** 默认档位下，commit / push / 开 PR 由人批准；只有显式选定的「自动交付」档让机器把一个已评审的 head 交付到 draft PR 为止（§2.5）。
3. **多项目是一等公民**。每个项目有自己的根路径、一块看板、卡和配置，互不干扰。

长期目标——「定时发现 issue → 分析 → 自动开发 → 交付出 draft PR」——在「自动交付」档上已有一条机器路径（§2.5）；但**合并永远留给人**。

## 2. 现在能做什么

### 2.1 数据与看板

- **一项目一板：项目 → 看板 → 卡。** 建项目时在同一事务里写好它唯一的看板；再为该项目建板只会返回已有那块，因此 boards 列表里每个项目最多一块活跃板。历史多看板状态在加载时收敛，不升 schema 版本：保留第一块**活跃**板，把其它板上的卡并进去，重指每个项目的 `intakeBoardId`（包括已经指向归档板的），多余板标记为 `archived` 并留在 state 里。不删卡、不删板，重复加载是 no-op。用旧归档板 id 手动 intake 会被 400 拒绝。
- schema 版本仍是 `1`；加载时版本不符会抛错。因此这次的数据修复靠就地归档，而不是升版迁移。
- 卡的生命周期是 8 个状态：`inbox` / `triage` / `plan` / `plan-review` / `build` / `review` / `done` / `canceled`。
- **卡片可取消（软删）。** 所有非终态卡（除 `done`/`canceled`）在操作区末尾有「取消卡片」按钮，一键调 `POST /cards/:id/transition {to:'canceled',actor:'human'}`，复用现有状态机与审计、后端零改动；无二次确认，成功后出 toast、失败显后端原文。取消是改状态不是删数据：卡留在库里、`source` 继续占位，所以自动卡取消后不会被下一轮 intake 重建；正文、history 与审计都保留，退出自动派发与批准，worktree / 分支不碰。界面在页尾「已取消 · N」折叠条里体现：点开可读被取消卡的标题与正文摘要（复用 `renderCard`，取消终态没有操作按钮，天然只读），不占看板第六列。非终态卡只做软删；终态卡（`done` / `canceled`）另有**永久删除**入口：`DELETE /cards/:id` 需界面确认弹窗与请求体 `{ confirm: true }` 两道闸，删前记 `card-deleted` 审计，审计与 history 故意保留，删的只是卡本体。终态孤儿卡不再渲染无意义的「取消卡片」按钮，只剩删除按钮。
- **任务卡统计排除 canceled、保留 done。** 右上角「任务卡」用 `boardCards.length - canceledCards.length`，侧栏与标签页共用的 `cardCounts` 遍历跳过 `status==='canceled'`，两处显示同步；`done` 仍计入、仍在「完成」列。数量守恒：任务卡（非取消）+ 页尾已取消 = 总卡数。「活跃会话」「有效名额」不受影响。
- 每次状态转移都记录是谁做的（人 / agent / 自动规则），可全局审计。
- 收件箱是数据状态，在界面上单独呈现，不占看板列。
- **状态持久化在 SQLite 里**，用宿主运行时自带的 SQLite（`node:sqlite`，静态 import）。整份状态——项目、看板、卡片、事件、设置与 schema 版本——作为一份 JSON 文档存在单行里；内存模型与公共方法原样不动，上层看不到引擎变化，重载插件后数据仍在。
- 默认库文件是 `<DSH home>/dsh-factory/factory.sqlite`。DSH home 一律经宿主包 `@deepseek-ai/dsh-home-paths`（`resolveDshHome`）解析——绝不手写 fallback——因此路径跟随宿主自己的配置 / `DSH_HOME` / 默认解析。`config.dataDir` 或 `DSH_FACTORY_DATA_DIR` 可覆盖目录。该宿主包列为 peer 依赖。

### 2.2 派发与工作区

- 每张卡派发时建一个 **git worktree**，分支为 `factory/<cardId>`，会话的工作目录就是该 worktree。
- **worktree 隔离是强制的，不提供关闭开关**：所有项目、所有自动化档位一律在 worktree 内干活。原因是「在项目根直接改」会推错分支、卷入未提交改动、并击穿授权闸门。
- 建完 worktree 后可执行项目自定义的准备步骤：
  - `copyFiles`：把项目根下被 git 忽略的本地文件（如环境变量文件）拷进 worktree；
  - `postCreate`：在 worktree 内跑一条用户自填的准备命令。
  - 两者都**不预置任何默认值**：装什么依赖、跑什么验证由目标仓库自己的约定决定。任一步失败则整体回滚（删 worktree 与分支、卡留在收件箱）。
- **一个全局的「worktrees root」设置**决定新 worktree 建在哪里，位于设置抽屉的**全局**页签（「路径与并发」分组），不在项目页上。留空即用默认 `~/dsh-factory-worktrees`（按用户主目录解析）：输入框占位显示该默认值，另有一行「当前生效」显示解析后的绝对路径。它只影响此后新建的 worktree——已有项目与在跑的卡都不受影响。被拒绝的值会把后端的原始错误原样透出。该根下每个项目占一个目录，名字由项目名的 slug 加 id 的一小段前缀组成（改名不会让路径失联，同名项目也不会撞），每张卡的 worktree 再嵌在它下面。
- **worktree 路径由同一道闸门挡在数据根之外。** 根通常可以落在数据根外；唯一的根内例外是 `<home>/dsh-factory-worktrees` 这一条精确子树，用于 HOME 本身就在数据根内的布局。会话库、缓存、其它项目的 state、以及别处的同名目录仍然禁写。包含关系每次调用都实时解析（`resolveDataRoot()` / `homedir()`，从不缓存），`assertWorktreeRoot`、`worktreePathFor`、`createWorktree` 三处都过同一个 `isAllowedWorktreePath` 检查。显式的 `DSH_FACTORY_WORKTREE_ROOT` 覆盖值不继承该例外。HOME 在数据根外的机器行为不变。

### 2.3 会话接续（三级降级）

一张卡会经历多个阶段，每个阶段需要新的 agent 会话，但必须复用同一个 worktree 与分支。接续按三级降级，逐级记录、不静默：

1. **会话还活着** → 直接向同一会话追加输入（最省）；
2. **会话已结束、历史还在** → 按持久化会话恢复，上下文完整；
3. **历史不可用** → 新建会话并注入历史摘要，同时在卡的历史里记一条降级记录。

失败处理：接续失败只释放占用，不改卡状态、不删 worktree，可重试。

### 2.4 熔断

同一张卡连续以**同一种阶段**失败达到阈值（当前为 3 次）即标记该阶段停滞、停止自动重试，等人工处理。派发失败（`dispatchFailures` / `stalled`）与 L4 在 review 入口的自动提交失败（`commitFailures` / `commitStalled`）各有独立预算，一个阶段停滞不连累另一个。

### 2.5 授权闸门

- 「确认提交」与「推送分支并创建 PR」在 `manual`、`you-approve`、`machine-approve` 三档下是两个独立的人工动作，没有批准就没有任何 git 写。
- 「自动交付」档下，这两个人工动作被一道**机器闸门**取代，每个引擎 tick 在同一处求值一次：项目档位为 `auto-delivery`；项目未暂停、卡未被接管、卡不待人工信息；卡在 `review`；其 verdict 为 `approved` 且 `blocking` 为空；verdict 的 `reviewerSessionId` 等于该卡登记的 `reviewSessionId`；verdict 的 `reviewedHead` 仍等于从 git 重读的 worktree 当前 HEAD。受保护或 base 分支一律拒绝，凭证或仓库绑定缺失时 fail-closed。闸门按 head 幂等：已交付的 head 永不重复交付，失败的 head 可重试、已完成的步骤跳过。
- **verdict 认证的树就是交付的树。** `build` 会故意留下脏树供人查看，而交付要求干净树；L4 在**进入 review 时**先把这棵脏树自动提交成新 head（`ensureCommittedForAutoDelivery`，用户预授权的 L4 写边界——不伪造人工确认、不动人工 commit 闸），让评审看到的就是这个 head，交付推的也是它。非 L4 档位不变：工作树有未提交改动仍拒绝交付且零 git 写——那些改动从未经评审。自动提交按 head 幂等，条件是「树干净 **且** `commitSha === HEAD`」双条件（打回 build 重建不会清 `commitSha`，只看 sha 会误判已提交）；提交失败写审计与卡片、只停在提交阶段、不派评审也不交付，下一 tick 可重试但按独立预算限流。交付评估前先查 worktree 是否仍存在（`worktreeExists`），已失效则报「卡片工作树已失效……需重新派发」而不是底层 `ENOENT`。
- **L4 的 git 写在动手前就被围住。** 构建或评审会话还在跑时拒绝自动提交；没有 `commitSha` 的评审卡若当前 HEAD 与基线 tip 不同，拒绝；工作树删除了异常多的已跟踪文件，拒绝——都在暂存与任何 git 写之前，并留下带原因的 `commit-refused` 审计。决策时 git 端口从 `git status --porcelain` 冻结脏路径清单，只暂存/提交这些路径（`git add --`、`git commit --only --`），钩子事后新建的文件进不了交付提交。游离的夹具 HEAD 因此会 fail closed，不会被扫进 PR。
- **停滞的 L4 失败有人工恢复入口。** 提交失败预算耗尽后，`auto-delivery` 档的评审卡在没有会话、接管、待补信息阻挡时显示「重试自动交付」。路由要求显式 `actor: 'human'`，拒绝其他档位、状态与活会话，可记录人工修好的 commit sha，清除失败/停滞状态并用从 git 重读的 head 重新武装引擎；按钮仍受同一评审动作闸保护，重试本身不授权任何 git 写。
- 开 PR **一律是 draft**（所有档位，含「手动」）；「自动交付」档的机器可以开出并更新 draft PR，但**不自动合并**、不自动标记完成、不自动提权——授权止于 draft PR。
- 拒绝向受保护分支推送、拒绝空 diff、不 force push。

### 2.6 项目创建助手

- 一个只读分析工具：读取目标仓库的客观事实（根目录文件、目录、忽略规则、清单文件、声明的包管理器），**不返回任何「该跑什么命令」的结论**。
- 一个创建工具：直接登记项目。创建是本地可逆的配置登记，不碰任何 git 写。它**按 git index 剔除已被跟踪的 `copyFiles` 项**——已跟踪文件新 worktree 本来就带，复制纯属冗余；这一步是确定性护栏，不依赖模型判断。
- **建项目时一次性识别 GitHub 绑定。** `createProject` 用只读命令读一次本地 git `origin`，仅当它是 github.com 的 HTTPS 或 SSH 地址时把 `owner/repo` 解析进 `issueRepo`，并在写默认看板、把 `intakeBoardId` 指向它的同一事务里写入。显式传入的 `issueRepo` 优先、直接跳过识别。没有 remote、非 GitHub 地址、非 git 根目录、或多个 origin 地址都不阻断建项目，各自记一个 `bindingReason` 原因码，由身份卡用白话解释。**识别由用户建项目触发、只发生这一次；引擎运行时不猜仓库、不读 remote（见 P2 的「手动」说明），也不回填历史项目。** 项目设置里可手动改绑或清空：值必须是 `owner/repo`，留空即解绑。
- `/factory add [path]` 命令只是**触发器**：它把意图交给 agent，由 `factory-add-project` 技能引导 agent 分析仓库、生成配置提议、再创建项目。不带路径时使用当前会话的工作目录。
- 项目根**可以**落在数据根内（用户有些仓库就在那里）：允许登记、带一条 warning，但**不许当会话 cwd**，worktree 强制外置。这条在真机验过（V2b）。
- `GET /api/dsh-factory/status` 暴露 `toolsRegistered`：工具注册失败曾长期静默降级（命令和接口照常成功、agent 却没工具可调），现在有可被客观读到的信号。

### 2.7 技能

7 篇：6 篇阶段技能（分诊 / 计划 / 构建 / 自审 / 评审 / 复评）+ 1 篇项目添加技能。阶段技能与状态机的「agent 可推进」边一一对应。

### 2.8 自治档位

存储的是四个语义档：`manual` / `you-approve` / `machine-approve` / `auto-delivery`；新项目默认 `manual`。界面把它们呈现为**单滑杆上的五个显示档 L0–L4**：L0 `manual`、L1 `you-approve`（关自动派发）、L2 `you-approve`（开自动派发）、L3 `machine-approve`、L4 `auto-delivery`。唯一的开关是 `autoDispatch`，只属于「你批准」档；`machine-approve` 不读任何开关，`auto-delivery` 显式忽略 `autoDispatch`——它继承「机器批准」的全部能力，并多加一项独立设闸的权力：交付已评审的 head。不设仓库或卡片白名单。

- `manual`（手动）：严格零动作——不发现、不派发、不批准。
- `you-approve`（你批准）：发现 issue，其唯一开关 `autoDispatch` 决定其余。开：引擎走 `inbox -> triage` 一条边，卡片停在 `plan-review` 等人；关：引擎只建 inbox 卡。
- `machine-approve`（机器批准）：多走一条自动边 `plan-review -> build`，且**不读任何开关**——档位即唯一真相源。机器代卡片批准计划，并接着该卡的会话让 `build` 真跑起来——只批准不续会话会把卡晾在 `build`、没有 agent。它与其他转移一样走同一个 `autoRule` actor、过同一道 `assertTransition` 状态闸，所以到不了闸门不允许的状态。边界是有意收窄的：机器**只批准计划并续原会话**；武装交付授权（commit、push、开 PR）仍留给人，机器绝不碰 git、不创建 PR。这比「全自动到 draft PR」更窄——机器不武装、不交付。
- `auto-delivery`（L4，自动交付）：「机器批准」的全部能力，外加交付权力——每个引擎 tick，一张 verdict 满足 §2.5 闸门的 `review` 卡会被提交（仅在被评审的树仍是 HEAD 时）、推送并开出 draft PR。滑杆行为：单一原生 0–4 控件；拖动只置 pending 值，松手（`pointerup` / `keyup`）才提交，保存是独立一步；升到 L3 / L4 先二次确认（取消则滑杆回滚），降档不弹；状态徽标只读已保存的档位。界面上没有独立的 `autoDispatch` 开关。

**旧存档迁移。** 存储 schemaVersion 由 1 升到 2，旧档在 store 加载时一次性改写（加载永不拒绝旧档或脏档）：`L0` → `manual`；`L1` 开/关 `autoStart` → `you-approve` 对应开/关 `autoDispatch`；`L2` 两开关都开 → `machine-approve`；`L2` 开 `autoStart` 关 `autoApprove` → `you-approve` + 开；`L2` 关 `autoStart` → `you-approve` + 关；缺失或非法 → `manual`。旧字段名从落盘状态删除。

**审计 tier 按档位取。** 建卡、派发、批准的每条记录都带项目档位作 tier——`machine-approve` 档事件 `tier=machine-approve`、`you-approve` 档事件 `tier=you-approve`——同一档的记录永远滤在同一 tier 下。自动交付闸门的每个决定（armed / commit-skipped / pushed / draft-pr / delivered / failed）都记在 `tier=auto-delivery` 下。

审批与派发共用同一份并发预算：项目级与全局上限约束活跃会话数，只有有名额时才批准计划。复用仍活着会话的接续（followup）不开新会话、不占名额；只有 `resume`/新建这种真会起会话的降级才扣预算。没有名额时**连审批一起扣住**，不只是扣接续：卡片留在 `plan-review`（记为因容量暂缓），由后续 tick 重试，绝不会把卡批进一个没有 agent 的 `build`。活跃判定在 tick 起点与决策点各做一次，会话若在 tick 中途死掉，不会趁快照判活绕过名额、多开一个超限会话。

`pause` 与单卡 `takeover` 对批准也立即生效：被暂停的项目或被接管的卡不会被自动批准，暂停期间跳过的卡恢复后也不补跑。重复 tick 幂等，这条自动边没有通往 `done` 或 `canceled` 的路径。

### 2.9 整页视图、配置抽屉、文案与窄屏看板

- **视图按整页设计。** 插件顶部是一条页内吸顶头栏（高 56px）；项目侧栏与顶栏标签是同一份项目选择的两种呈现，由「视图」控件（侧栏 / 标签）切换。默认侧栏，选择存本地、刷新后保持——没有后端字段、不改 schema。两种导航都显示每个项目的档位徽标（L0–L4）、卡片数与暂停标记，数据都来自看板已加载的内容。宽屏时侧栏固定在看板旁；窄屏时侧栏变为带遮罩的抽屉，标签仍是横向条。看板本身保留真实高度（min-height 440px），全局页把 GitHub 连接组置顶。
- **操作给居中、页根的反馈。** 滑杆升到 L3（`machine-approve`）或 L4（`auto-delivery`）先弹二次确认：取消则滑杆回滚，已存档位不变、保存是独立一步；降档不弹。删项目用输入名称的居中确认。为避免 fixed 遮罩被变形的抽屉困住，这些弹窗都挂在页面根节点；保存结果与卡片操作（如接管）用自动消失的 toast，成功与失败可区分。
- **配置抽屉项目优先。** scope 初值是 `auto`：有项目选中时解析为项目页，否则为全局页；点页签会在本次页面会话内固定作用域，刷新后重新回到 `auto`。项目页有「全局设置 ›」入口，抽屉标题跟随当前页。项目页的暂停/恢复走项目级接口，引擎暂停/恢复只在全局页出现。项目页保留身份卡常驻，把自治与暂停合成一个区块，周围是 worktree 准备、并发上限、危险区；全局页按「GitHub 连接」「路径与并发」「引擎」分组。
- **运行时文案只有一个来源。** 所有 `t()` 字符串来自向 locale 服务注册的 zh/en 内联字典。包内 locale JSON 保留宿主需要的 `meta` 并镜像同一套 UI key：四处（内联 zh/en 与 locale zh/en）重叠 key 逐字一致、每个 key 的占位符 token 集合相同（8 个 key 带占位符），只有 locale 多一个 `meta`，`meta` 不进 UI 字典。UI key 总数随迭代增长，文档不写死，由自足断言在运行时核对。GitHub Token、gh CLI、GitHub OAuth App、Client ID、worktree、commit、PR 等专有名词两种语言都原样保留。旧的「无法识别账号」通用说法不再用于已连接的身份：账号解析不到时退回来源表述。
- **窄屏看板。** 在 760px 断点下看板变成横向 scroll-snap 条：列宽为视口的 84%，列头 sticky，看板高度上限 56vh，阶段指示按真实渲染列宽算出「当前列 / 5」。QA 在 390px 真机复测确认每屏一列、吸附正常、页面无横向溢出；列外宽最初因 `content-box` padding 略高于 84vw，已用 `box-sizing:border-box` 修掉（见 §5.2）。宽视口（包括主内容列很窄的宿主容器）仍是普通横向滚动，各列可达。

- **滚动时标签栏仍可见。** 标签视图下项目标签钉在 56px 顶栏正下方，背景不透明并带最小高度；展开收件箱卡或向下滚页面都不会把标签吞掉，标签自身的横向滚动不变。页面根节点不再有 header 与内容之间的 `gap`。

### 2.10 卡片正文（任务描述）

- **建卡可写正文。** 页根新建卡片弹窗除标题外还有一个「任务描述」textarea（占位文案写明背景 / 目标 / 验收标准），`POST /cards` 带 `body` 字段；正文可空，禁用创建只看标题与看板，不要求正文。
- **卡面摘要只读、纯文本。** 卡面把正文剥成纯文本（去 Markdown/HTML 标记、链接与图片只留文字、压连续空行），按码点截到 240 字做两行省略，鼠标悬停的 `title` 给到 2000 字；空正文不渲染摘要节点。摘要不可展开、不可点，完整内容走会话注入。
- **正文注入在技能指令之前。** 每张卡派发时，system prompt 在阶段技能正文之前注入一个独立块，顺序为「数据非指令标注 → 自动卡快照标注 → 正文 → 截断提示」。标注明确要求忽略正文里试图改任务、放宽标准或让执行命令的字句；它在 `sectionText` 最前，先于卡片字段与技能正文到达模型。手动建的卡没有 source，正文全文注入、不加快照标注也不加截断提示；只有带真实来源（`source` 非空且非 `manual`）的卡超过 3000 码点才截断，并在末尾加「回源 GitHub issue」提示。截断按码点切，不拆代理对。
- **提示词文案与界面同源。** 这几条 notice/hint 从打包的 locale 字典读，不在 `session-context.js` 里另存一份；locale 从宿主上下文解析，拿不到或不是英文时默认中文。

### 2.11 单卡接管与交还

- **接管把一张卡从引擎拿走。** `POST /cards/:id/takeover` 置 `takenOver=true`，写 `takeover` 历史与 `taken-over` 审计；看板卡与收件箱列表用同一个「已接管」短标签（同一组件、同一条件），不打断正在跑的会话，只让后续 tick 跳过这张卡，也不再自动批准它。
- **交还只翻一个标志。** `POST /cards/:id/release` 把 `takenOver` 置回 `false`，补一条 `returned-to-engine` 历史与 `decision=returned-to-engine` 的审计事件；`sessionId`、`pendingDispatch`、worktree 一个都不碰——这些属于正在跑的会话，引擎本来就会跳过。交还不立刻派发，下一个 tick 才按正常并发闸门接手。
- **幂等且无二次确认。** 对没接管的卡重复 `POST /cards/:id/release` 是静默 no-op，历史与审计都不新增；交还可逆，界面不弹确认，只用 `busy` 挡重复点击。有活会话或派发锁时，成功 toast 追加第二行提示「会话继续，引擎不会重复派发」。
- **交还与派发锁是两回事。** `/release` 是「人把卡还给引擎」，与释放并发名额的 `releaseClaim` 不是一个接口，不要混。

### 2.12 卡片上的会话入口与阶段报告

- 派发过的卡片显示已关联会话的标题，来源只用一个：宿主客户端会话目录 `ctx.sessions.list` 的 `displayTitle`（标题生成或改名后随订阅更新），没有后端字段、不改 schema。点击走宿主导航 `ctx.uiWorkspace.openSession(sessionId)` 跳到那个会话；没有对应行时退回显示会话 id，宿主不提供导航服务时只显示只读标签。
- 卡片上的「查看报告 · N」打开只读弹窗，按时间列出 `card.history` 里所有 `type:'report'` 条目，带作者（AI / 人工）、时间与全文。报告正文用宿主 UI 组件按 Markdown 渲染，原始 HTML 不执行；没有报告时不显示按钮。
- 会话跳转不用 URL：DSH 切换会话是客户端状态，URL 不变、`?session=` 也不生效，猜链接必然落空；宿主服务才是唯一入口（取舍见 §3）。

### 2.13 看板同步、交付状态与批准门槛

- 看板只看当前选中项目的一份轻量摘要（每 5 秒一次 HTTP 探针，摘要变了才拉全量，切回标签页立即探一次）。agent 或引擎改了阶段会自己反映到看板，不用手动刷新；别的项目动卡不会让这里空转。选中项目与报告排序是浏览器偏好，不进卡片、不进后端。
- 交付状态与按钮闸门读同一批字段：commit 短 sha 与 PR 链接在任何阶段的卡片上都显示；PR 链接只放行 http(s)，新窗口打开并带 `noopener noreferrer`。会话在跑时整张卡做动效（顶部扫光、呼吸光晕、脉动小点），不加文字横幅。
- 报告编号固定按这张卡的时间正序（最早 = 1）；排序开关只改显示顺序。Markdown 用宿主自带 `MarkdownText`，原始 HTML 不执行，插件不额外引入运行时依赖。
- 客户端把最终生效的显示语言（例如 DSH 跟随浏览器解析出的 `fr`）回传并存在宿主侧；派发会话优先用它，其次用宿主显式的 `locale.preference`，再回退中文。指令按语言 id 动态生成，要求回复和 `factory_report` 正文使用该语言；代码、命令、路径和专有名词保留原文。
- 「批准计划」要求 `plan-review` + 会话已跑完 + 卡片至少有一份报告，否则按钮禁用并说明原因。「标记完成」在 `review` 阶段一直可用，何时算完成由人判断。
- **评审在独立会话里进行，产出结构化 verdict。** 评理会话记在 `card.reviewSessionId`（永不覆盖 builder 的 `sessionId`），与构建会话一样跟随项目配置的工作模式，评审者因此能执行命令；角色边界写在提示词里：不移卡、不授权 git 动作、不 commit / push / 开 PR，结论由人读后决定。其 verdict——结论值、阻断项与 follow-up 分列、实际跑过的检查——经 `factory_report` 写入，head 由后端从 git 计算，绝不取自评审者。`review -> build` 回退后的复评复用仍活着的评理会话并重读上一轮 verdict。`review -> build` 与标记完成仍是人的决定；「自动交付」档下，卡片还带着机器闸门的审计记录（`auto-delivery` 历史条目：armed / commit-skipped / pushed / draft-pr / delivered / failed），交付失败时卡片留在 `review`，下一 tick 可重试。

上一轮认证的 head 作为一等字段 `previousReviewedHead` 显式注入评审上下文（唯一来源是上一轮 verdict 的 `reviewedHead`，不接受模型传参；无上轮结论时为 `—`），后端据此生成两种范围行：上轮有阻断项则逐项在新 head 上核对是否解决、只看差量找回归；上轮 approved 则只看差量找新问题——两者最后都整体重看一遍。`—` 或与当前 head 相等时不走增量，按全量评审；skill 判据为「有回退转移或有 head 差量」即挂 `factory-rereview`。引擎对「review 内自动提交导致 verdict 过期（`reviewStale`）」的 L4 卡自动复评（走 `followupReview` 三级回退，旧 verdict 留作上下文、不清），每卡一生最多 3 次（`AUTO_REREVIEW_LIMIT`），只在引擎自动发起时计数、人手动重派不计数、不重置；用尽后转全人工，但过期提示与重派按钮仍在。卡片提示优先级：复评额度用尽 > 评审过期 > 通用交付失败 > 无结论。

### 2.14 每张卡一行的流程提示与补充信息上文

- **每卡恰好一行流程提示。** 看板卡片在 meta 行与操作按钮之间渲染 `flowHint`：单行（`whiteSpace:nowrap`、超出省略、不用 `pre-line`），最多一个节点。四个字典新增 17 个 key：基础 11 个（`flowInboxAuto` / `flowInboxManual`、`flowTriageAuto`、`flowPlanAuto`、`flowPlanReviewAuto` / `flowPlanReviewManual`、`flowBuildAuto`、`flowReviewAuto` / `flowReviewManual`、`flowDone`、`flowCanceled`）与覆盖 6 个（`flowPaused`、`flowCapacity`、`flowTakenOver`、`flowNeedsInfo`、`flowStalled`、`flowSessionStopped`）。自动/手动文案按存储档位定：`you-approve` 且 `autoDispatch === true`（显示档 L2）、`machine-approve`、`auto-delivery` 为自动；triage / plan / build 三行描述正在进行的会话，不分自动/手动。
- **优先级放在纯函数里。** `cardFlowHintKey(ctx)` 按序只选一个 key：孤儿卡复用 `orphanWhy`；已有 L4 评审提示时返回空（不叠加）；再依次 `needsHumanInfo` → `takenOver` → `paused` → `capacity` → `stalled` → `sessionStopped` → 状态 × 档位基础文案。入参全部取自页面已有的状态快照——`engine.paused`、`project.paused`、并发用 `engine.projects[].action === 'queued'` 或 `approvalHeld > 0`、`card.stalled`、会话活跃用 `sessionRows[].running`——不加后端字段、不改路由与 schema。
- **三处按代码事实校正了文案稿。** capacity 的判据是 `action === 'queued'` 或 `approvalHeld > 0`，不是裸的排队卡数；评审卡的会话停止看 `reviewSessionId`，并排除 `plan-review` 与新鲜的 approved verdict；L1/L2 的区分是 `you-approve` 下 `project.autoDispatch === true`，不靠显示档位猜。
- **补充信息弹窗只读展示上次退回原因。** `needsHumanInfo` 卡点「补充信息并重新派发」时，`lastTriageReturnReason(history)` 取最近一条非空 `triage-return.reason`，在输入框上方以 `notePreviousReason` + 原文 + `noteResupplyGuidance` 渲染。**输入框不预填**——预填会让后端首条会话消息重复同一段文字；没有退回原因时弹窗与旧行为完全一致。两个 key 都不带占位符（符合 AC-1.5）。

### 2.15 AI 起草交付文案

- **草稿永远是草稿，不等于写入。** 生成器读取有上限并截断的 diff（`diffForCopy`）与卡片标题/正文，经宿主的默认模型（`agentDefaultModel.currentSelection()`）调用一次 `llm.stream` 返回文本；不启用 task Agent、不加载 skill、不提供模型/供应商选择器。任务正文与 diff 都作为数据传入，并明确要求忽略其中的指令；提交信息被压成一行纯文本，PR 文案按严格 JSON 解析出标题与正文。
- **人工写入先经过可编辑草稿。** 确认提交 / 回炉提交 / 首次建 PR 会打开草稿弹窗：只读草稿路由（`POST /cards/:id/draft-commit` 或 `/draft-pr`）与写入路由共用「会话未运行 + 有 approved verdict」两道闸，`/draft-pr` 还只接受已有 commit、尚无 PR 的卡。弹窗有四个可见状态——生成中（spinner + 状态文字）、可编辑草稿、失败/超时兜底（警示 + 原默认文案）、提交中；生成中、标题/信息 trim 后为空、提交中时确认按钮禁用。取消会关窗并丢弃迟到的生成结果；只有确认后才把编辑后的文案发到既有的 authorize 再 commit / commit-existing / create-pr 路由。清空 PR 正文是一次真实编辑：显式空串原样下发，缺失或非字符串值才回退到卡片正文。
- **L4 起草是尽力而为，且在既有闸门之内。** 自动提交只在树确实脏时起草 message，首次建 draft PR 只在真正开 PR 时起草标题/正文。缺服务、非 `stop` 结束、超时（15 秒）、结果为空或不可解析都退回原默认文案（`factory: auto-delivery <短 ID>` / 卡片标题与正文），绝不改变交付决定。`committed` 与 `draft-pr` 审计记录带 `copySource`（`ai` 或 `default`），可看出文案来源。
- **兜底也要让人看得见。** 草稿界面区分「AI 起草」与「已填默认文案」，区分超时与其他失败，卡片无正文时给出提示，并原样显示后端错误；两组新文案 key 在四个字典中镜像一致。

## 3. 已经定死、不必再争的设计

| 决定 | 理由 |
|---|---|
| worktree 强制开、不给关 | 关掉会在项目根直接干活：推错分支、卷入未提交改动、授权闸门无法界定改动归属 |
| 隔离用 git worktree，不用「独立目录 clone」 | 两者在「依赖独立、本地文件要拷」上等价；worktree 建造是秒级、远端天然正确，且不会在侧栏堆出一堆工作区 |
| 不追求真容器沙箱 | 宿主环境没有容器化能力，只能做「限制写入范围」级别的隔离；不假装它是强隔离 |
| worktree 路径在数据根外，只留一条主目录子树例外 | worktree 落进会话库、缓存或别人的项目 state 会损坏无关数据；根内唯一容忍的是 `<home>/dsh-factory-worktrees` 这一条精确子树，每次实时解析，三处边界检查共用同一道闸 |
| 单一全局「worktrees root」设置，留空即用按 HOME 解析的默认 | 一个设置比每个项目各配一根更好推理；默认用 `homedir()` 表达，绝不写死机器相关的绝对路径 |
| 每阶段新建会话 + 历史摘要，而非同一会话用到底 | 评审阶段必须独立：自己审自己会破坏注入防御与评审纪律 |
| 用 SQLite 取代单个 JSON 文件 | 整份状态存在单行里，内存模型与所有调用方原样不动，同时得到一个真实数据库文件；重载后数据完整读回 |
| DSH home 只经宿主包解析 | `@deepseek-ai/dsh-home-paths` 是配置 / `DSH_HOME` / 默认的唯一来源——手写 fallback 会与宿主布局漂移 |
| 默认由人把守计划审批与交付授权 | 默认每一道闸门都留给人；`machine-approve` 只能通过按项目显式选档委托**计划审批**这一项，绝不委托交付 |
| 只有 `machine-approve` 能自动批计划，且必须显式选到该档 | 新项目默认 `manual`、无白名单、不读任何开关；机器经 `autoRule` 走 `plan-review -> build`、过同一道状态闸，然后停住。武装交付、git 写与合并永远留人 |
| 一项目一板，靠归档收敛而不是删除 | 看板是项目的 intake 面，不是用户自行管理的分组；归档让历史卡片与 intake 目标仍可解析，同时接口每个项目只暴露一块活跃板，还免去 schema 升版 |
| 配置抽屉默认落在当前项目 | 从项目打开设置的人几乎总是要该项目设置；全局仍可通过页签与项目页入口到达 |
| 内联字典是运行时文案源，locale JSON 镜像它 | 改一句话只有一个地方，key 集合校验让两份副本不会悄悄漂移 |
| 专有名词两种语言都原样保留 | 把 GitHub Token / gh CLI / GitHub OAuth App / Client ID 换成通用说法后配置说明变得无法理解 |
| 卡正文标注为「数据非指令」并在技能前注入 | 正文来自 issue 或人手写，不可信；放在技能指令之前并要求忽略其中改任务、放宽标准的字句，才压得住提示词注入 |
| 有真实来源的卡才做 3000 码点截断并提示回源，手写卡全文注入 | 手写卡的正文是唯一任务内容，截掉就没有全文可回源；有 source 的卡才可能从 issue 读到全文 |
| 交还只清 `takenOver`，不动会话 / 派发锁 / worktree，下一 tick 才派发 | 那些字段属于在跑的会话，清掉会重复派发或丢工作区；延后一个 tick 让引擎按自己的并发闸门接手 |
| 交还原地幂等、不弹确认 | 重复交还是无意义的写；操作可逆且比接管更轻，二次确认只会打断 |
| 取消卡片走软删（转 `canceled`）而非物理删除，`source` 占位防复活 | intake 按现有卡的 `source` 去重且不看状态；硬删自动卡会让它的 source 消失、下一轮被当新 issue 重建，还断掉 history / 审计链。留卡改状态既退出管线又不复活，后端与渲染都已支持 |
| 会话入口走宿主 `uiWorkspace.openSession`，不猜 URL | DSH 会话选择是客户端状态，URL 始终是根路径、`?session=` 不生效；宿主服务是唯一真实导航口。`ctx.sessions.list` 是标题的唯一来源，卡片自己不存标题 |
| verdict 认证的树就是交付的树 | 未提交的改动从未经评审；「手动 / 你批准 / 机器批准」三档下，被评审 head 上工作树干净则跳过提交，脏树拒绝且零 git 写。L4 则在评审**之前**先把脏树提交成新 head、让评审认证它，交付的仍是同一棵树（§2.5） |
| arm 令牌是一次性的，权威是代码闸门而非令牌 | 执行前对活卡片与活 head 重评整套闸门再动手，令牌永远不能当作常驻授权；skill、报告与 HTTP 调用方都武装不了交付，只有引擎 tick 能 |
| 「自动交付」止于 draft PR：不合并、不自动标完成、不延伸到其他档位或工作模式 | 用户的常驻授权恰好以此为界：机器把被评审的 head 交付到 draft PR，之后的所有事留给人 |
| 存储四个语义档，L0–L4 是呈现层映射 | 「你批准」档加它的开关覆盖两个显示档；`auto-delivery` 是独立的存储档、不读任何开关，五个滑杆档位不需要新的存储值，也没有开关泄漏能力 |
| 每卡只给一行流程提示，优先级固定、不叠加 | 一张卡对「下一步做什么」只能说一件事；孤儿卡与已有 L4 评审提示已占用这一行，新提示让位而不是堆上去。优先级是状态快照上的纯函数，不需要浏览器就能测 |
| 上次退回原因只展示、不预填 | 后端本就会把该原因带进下一会话首条消息，预填会让同一段话出现两次；只读展示省去手打，又不改变请求内容 |
| 纯显示层增量不 bump `BUILD` | 提示与弹窗复用的都是页面已有的数据与路由，没有改 Host 侧代码、导出面、路由或 schema。`BUILD` 标记的是必须重载才能相信新读数的 Host 侧改动；既有状态契约下的纯客户端改动保持原值 |
| 交付文案由宿主的轻量模型调用起草，人工写入前一定要本人编辑确认 | 既有写入闸门才是权威：生成文案的草稿路由要带同样的会话/verdict 校验，只有确认这一步才授权并写入。失败、超时或拿不到模型时退回原文案，不阻塞交付 |
| 评理会话跟随项目工作模式，不写死只读沙箱 | 评审者要能执行命令验证改动。独立性靠会话字段和 head 保证；「不移卡、不写 git」的边界写在提示词里，verdict 与授权闸门保持不变 |
| 显式空串是用户编辑，不是缺值 | 清空 PR 正文是有意操作；`||` 回退会把卡片正文悄悄填回来，让编辑器看起来失灵 |
| L4 自动提交遇到意外 HEAD、活会话或大量删除时 fail closed，只提交决策时冻结的路径 | 没有已记录提交的卡必须仍停在基线 tip；游离的夹具提交不是交付 head。钩子后生成的文件不在评审认证的树里，绝不能进提交（§4 P11） |
| 停滞的交付失败由人重新武装，不由引擎自己重试 | 三次提交失败是停止信号，不是继续重试的理由；显式重试路由让人决定修正后的工作树何时重新进入管线 |
| Git 钩子先剥掉 Git 导出的环境变量，再跑嵌套 git 命令 | `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` 等会让夹具的 `git init` / `git commit` 悄悄写到正在提交的仓库；全量闸门还只隐藏一个会造成已知环境假红的重复 token 变量 |

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

### P2 — 自治引擎（**三档已实现、已提交，并在真机端到端验通**）

`autonomy` / `autoStart` / `autoApprove` 三个字段原本只有存储与写入校验、没有任何代码读取它们做决策。**引擎已落地**（`autonomy.js`）；语义三档与唯一开关取代了旧档位 id 与两个开关，旧存档加载时一次性迁移（§2.8）：

- **一个插件级定时器**，挂在宿主 timer 服务上，卸载随插件清理；服务缺失不静默降级，原因在 `status.engine.timerReason` 可读。多项目只是每轮枚举，不是多个定时器；tick 单飞不叠加。
- **`you-approve` 只走一条自动边**（其 `autoDispatch` 开关开时）：`inbox -> triage`，经 `dispatchCard` 完成，actor 记 `autoRule` 并带 `tier`/`rule`/`channel`。阶段推进仍由会话内技能以 `agent` 身份完成，**引擎不自己挪卡**；到 `plan-review` 停住等批。**agent preset 必须显式挂载**：派发会话以前从没挂 preset，所以没有 `tool-bash`、只能去抓宿主全局的 SSH 工具，沙箱也管不着它；现在在 `setup` 里调用 `agentPresets.mount(agentCtx)`（**不传 id，跟随用户当前选择的预设**），拿不到该服务就拒绝派发——这条是真 bug，已修。技能指引与技能正文的注入也已落地。
- **开关不泄漏能力**：唯一的开关是 `autoDispatch`，只在 `you-approve` 档被读；`machine-approve` 一次不读开关（档位即真相源），`manual` 严格零动作——「开关开着、代码顺手就用了」没有路径。
- **并发两级上限**（项目级 + 全局兜底），按运行时活跃会话计，不按 `sessionId` 字段计；满额排队不丢卡、不标 stalled，有空位后由后续 tick 取走。
- **暂停 / 恢复 / 单卡接管**是三个独立动作、各自持久化并留治理记录。暂停在界面上是一个状态开关（开＝已暂停、关＝运行中、标签固定不翻转）而非动作按钮；暂停与接管都**不打断**已在运行的会话，只影响后续 tick 的自动派发——硬杀会话会留下 worktree 和半截改动。
- **默认零副作用**：`manual` 严格零动作；缺 issue 源或目标看板的项目被跳过，原因在 `status` 可见，**运行时不猜、不从 git remote 反推、不自动建板**。仓库识别是另一个独立的只读步骤，只在用户建项目时发生（§2.6），不是引擎行为。
- **同步不代批**：`sync.js` 改用独立 `syncRule` actor + 空白名单 `SYNC_AUTO_EDGES`，远端「PR 关闭」建议只记待人处理、不会把等批的卡推进 `build`；`machine-approve` 档下的计划审批改用 `autoRule` actor，与同步严格分开。
- **权限档不虚报**：`permissionEnforced` 恒为 `false`，界面与状态不得宣称写入限制已生效。
- **沙箱三道硬保证**（派发与续派的三级链每一级都过同一套闸）：① 在 `createSession` 的 `seed` 里写 `sandbox/mode: workspace-write` 固定模式（无时序竞态）；② 建完回读 `sandboxMode` 投影校验，不符就 dispose 并拒绝；③ 权限上限为 `workspace-write`，项目配更高档也不放行。修复前的历史会话在接续时被拒绝并降级重建，旧的全权会话不复用。

**验收状态**：离线用例与真机四项（`status.engine` 字段、暂停/恢复、接管路由、审计路由）已验。**真实自动派发（AE-2）现已在真机端到端验通**：一条真实 GitHub issue 被发现并建成卡片，引擎只走唯一一条自动边 `inbox -> triage`（记为 `autoRule`），派发的 agent 把卡片推进过 `triage`、`plan`，停在 `plan-review`——全程无人工点击。此前几轮失败是验证夹具与任务内容不匹配（空壳仓没有与任务对应的源码），不是产品缺陷；这一轮用的是内容与任务相符的仓库，且清理前等 `turn/end` 落定，见 §5 与 §7。

### P3 — `machine-approve`，机器代批计划（**已实现并在真机验通**）

**按项目显式选档**（从不默认、无白名单、不读任何开关）：机器可以批准计划，多走一条自动边 `plan-review -> build`，以 `autoRule` 走其他转移共用的同一道 `assertTransition` 状态闸，随后续原会话让 `build` 真跑。边界有意收窄——机器**只批准计划并续会话**：

- 批准后接着该卡的会话让 `build` 真跑起来；**武装交付授权仍留给人**，机器绝不碰 git、不开 PR、不合并、不标记完成。这比「机器也武装交付」的最初设想更窄——那部分有意不做，是选定的边界、不是缺口。
- 审批与派发取自同一份并发预算（项目级上限 + 全局兜底，都按活跃会话计）。把卡批进没有 agent 的 `build` 毫无意义，所以没有名额时**连审批和卡一起扣住**：卡留在 `plan-review`、记为因容量暂缓，后续 tick 重试。只有真会开新会话的接续才扣名额；接续到仍活着会话的 followup 复用已计数的会话、不占名额。会话若在 tick 起点的活跃扫描与审批决策之间死掉，决策点会再查一次，不会因此绕过上限。
- `pause`（项目或全局）与单卡 `takeover` 立即挡住批准，不补跑暂停期跳过的卡；重复 tick 幂等；这条自动边无旁路到 `done`。
- `manual` 与 `you-approve` 从不批计划：批准是 `machine-approve` 档独有的能力，且它不读任何开关。

已在真机验证：`machine-approve` 下一张等批的 `plan-review` 卡被批进 `build`、审计字段齐全（批准、派发、建卡事件都带档位 tier）；`you-approve`/`manual` 保持惰性；暂停、接管、幂等都成立；无旁路到 `done`；AE-2b 同步路径未回退。这是**自治钥匙的另一半**——计划审批交给机器，交付授权仍握在人手里。

### P4 — 自治档界面（**已实现并验收；界面已在真机复测，P4-7a/7b 全局上限证明已用后端并发夹具验过——P4 全部完成**）

零构建、纯 JS 的设置界面（沿用现有 `client.js` 模式——不引入构建步骤、不引入 TS 规则引擎）。项目自己的管理看板是一等公民：页面顶部全宽高，带标题、三个关键统计（卡片数 / 活跃会话 / 有效名额）与引擎闸门；所有配置收进右侧抽屉、不占主视图高度。

**落地了什么：**
- **档位三选一。** 单个分段控件切 `manual` / `you-approve` / `machine-approve`（互斥），命名**手动 / 你批准 / 机器批准**（Manual / You approve / Machine approves）。判据是「谁批准计划」——不用「半自动 / Assisted」这类抽象词。每档下方随选择切换一张两行说明卡（「机器会做 / 你要做」），完全不懂的人也能分清三档；从他档切到 `machine-approve` 先弹保守边界说明（不碰 git、不建 PR、不标完成）再确认，切离它不弹。**状态徽标只读 `autonomy` 档位**，所以「档位已回手动、开关还开着」仍显示「手动」。`autoDispatch` 开关只在「你批准」档显示——另外两档隐藏、不是置灰。
- **暂停 / 接管，两个作用域。** 项目级暂停/恢复与全局引擎暂停/恢复（与顶栏开关保持同步）；卡片级接管只在卡片操作区。暂停文案白话说明作用域：只挡之后的 tick、不补跑跳过的卡、不动运行中会话，另有一条纯说明指出接管是单卡动作。「需要你处理 / Needs attention」条是 `status.engine` 的只读聚合。
- **并发上限。** 项目级 `maxActiveSessions`（可编辑，留空=用默认）与全局级 `globalMaxActive`（可编辑——写入口见 §5）。有效名额取两者较小，数值与来源都从后端读回渲染、绝不写死。
- **删项目连带清 worktree。** 删项目真会先清掉该项目的所有 worktree（dirty 检查保留未提交改动）再删登记。
- **配置按作用域分离。** 全局与项目设置分两个抽屉 pane、互不串写；每块各自保存，失败把后端原文原样透出。
- **移动端。** 主操作钉底部操作条、触摸目标 ≥44px、危险区二次确认用底部弹出而非居中弹窗。窄屏宿主下视图还在自身有界容器内滚动、绕开宿主 app-shell 锁死纵向滚动的问题（绕开法与宿主侧说明见 §5）。

四条硬要求全部满足：界面按语义档位字段判断、唯一开关只属于「你批准」档；保存失败显示原文；被静默归一的档位回显归一后的实际值；三个区块（准备 / 自治 / intake）各自保存。

**「P4 不加功能」的两个明确例外**（均由用户拍板）：(1) 删项目连带清 worktree；(2) 全局上限改为可 HTTP 写入、不再是纯启动配置。写入口已就位；写后卡住下一个 tick、且跨重载不丢的夹具级证明（P4-7a/7b）已用后端并发夹具验过。

### P5 — UI/UX、文案与一项目一板轮次（**已实现；QA 报告全量通过**）

本轮只改了既有单文件 `client.js` 视图的措辞、信息结构与有限的可读性——没有组件库、没有构建步骤。结论是从代码重新核出来的，不是照抄设计稿。

- **界面一项目一板。** 页头以项目名为主，看板名为非默认值时才在下方显示一行低调的「看板 · <名称>」；看板下拉与「新建看板」表单已移除。数据侧行为见 §2.1。
- **配置项目优先。** 有项目时打开设置落在项目页，无项目时落在全局页；点页签在本次页面会话内固定作用域，刷新回到 `auto`。项目页有「全局设置 ›」入口并走项目暂停/恢复，引擎暂停/恢复只在全局页。
- **术语。** 两字典都保留专有名词；本轮新增的 key 见 §2.9。禁用黑话词在两份字典里均 0 命中。
- **验证。** QA 新增了专门的验收测试文件，覆盖字典一致性、专名与禁用词、schema/契约不变量、一项目一板的 CRUD/收敛以及归档板 intake 的 400。旧的身份测试里的黑话禁令被收窄：放行「GitHub OAuth App」里的 OAuth，孤立 OAuth、其改写说法和其余黑话继续禁用；另一处断言改为现行的共享身份措辞。没有新增 skip。QA 做了窄屏数值的真机复测。测试数字会过期，这里不记，以实际运行为准。

### P6 — 整页视图、建项目一次性绑定与身份显示（**已实现；QA 报告全量通过**）

本轮仍在单文件 `client.js` 视图里做，不引入组件库、不加构建步骤；结论从代码重新核出。

- **整页外壳与两种导航。** 56px 页内吸顶头栏；项目侧栏与顶栏标签是同一份项目选择的两种呈现，由「视图」控件切换，默认侧栏、选择存本地、刷新后保持。两种导航都显示档位徽标、卡片数与暂停标记。看板宽屏 min-height 440px、窄屏 84vw 单列 snap。`machine-approve` 二次确认、删项目确认与其它弹窗都挂页面根节点（宽屏居中、窄屏底部抽屉）；保存与卡片操作（如接管）用自动消失的 toast，全局页把 GitHub 连接组置顶。
- **建项目时绑定。** `createProject` 只在建项目时从 github.com 的 git `origin`（HTTPS 或 SSH）识别一次 `owner/repo`，与默认看板的 `intakeBoardId` 同事务写入。失败是非阻断的原因码；不回填、不在运行时识别。项目设置可手动改绑或清空，校验 `owner/repo`、留空即解绑。
- **身份与绑定显示。** 当前账号由 `gh` CLI 只读解析（`gh api user --jq .login`，去掉 `--silent`）；已连接但拿不到登录名时退回来源表述。项目卡上的 GitHub 按钮只跳全局连接设置——不在项目里发起 OAuth。页头有仓库绑定状态徽标，点它打开该项目的绑定输入框。
- **文案一致性。** 四个字典新增一批 key（`pauseProject`、`resumeProject` 等），重叠值逐字一致、占位符集合固定、四个产品专名原样保留；数量以实际运行为准，这里不记写死的总数。

**增量（GitHub 身份设置）：** 全局 GitHub 区按用户可见的四层身份重排——① GitHub OAuth App（全局）→ ② `gh` CLI 登录（全局，本机）→ ③ GitHub Token（全局，所有项目共用）→ ④ GitHub Token（仅此仓库，最后兜底）。Client ID 输入框并入 ① 块内，位于状态行下、连接按钮上，独立卡片与重复提示已删；指引写明创建时要勾选 Device flow，Homepage URL 与 Authorization callback URL 是 GitHub 创建页的必填项但设备流程不用、随便填个网址即可，插件只需要 Client ID，且 Client ID 不是密钥、配置一次所有项目共用。项目身份卡标出当前生效层，检查通过时写明是哪一层通过的；环境变量里的 Token 会点亮全局 Token 那一行并标注为该层默认值，另存的全局 Token 使用时优先、环境变量本身不改动。卡片底部常驻的入口行（全局设置 · GitHub 连接；为本仓库填写 GitHub Token）只在仓库已绑定且检查结果尚未出（未检查、或检查中）时渲染；未绑定仓库、检查通过、检查失败三种情况都不显示。检查失败时，卡片下方的修复块（打开全局设置；为本仓库填写 Token）是唯一一套入口，不再与入口行重复。全局 Token 状态由只读的 `GET /api/dsh-factory/auth/token/state` 提供：configured / source（`none` / `env` / `stored`）/ state / login / 掩码指纹 / 独立的 `env` 块 / `overridden` / `reason`，掩码只露头尾各四位（八位及以下整体遮成「…」），任何响应都不含完整 Token。四份字典保持逐字节一致。QA 已真机复核新文案、①→②→③ 顺序与 Client ID 位置；失败态修复块、真机保存 Client ID、Token 保存/清除写操作与英文界面仍未真机验证。数字以实际运行为准，这里不记。

### P7 — 卡片正文注入与单卡交还（**已实现；Review 无阻断、Design UI 审稿通过、QA 报告全绿**）

本轮两条线都在既有零构建视图与引擎里做，没有组件库、构建步骤或 schema 变更；以下从源码逐条复核。

- **正文进卡、进摘要、进会话。** 手动建卡弹窗加「任务描述」textarea（`POST /cards` 带 `body`、可空）；卡面摘要纯文本化、两行截断、240 字摘要 / 2000 字悬停、空正文不渲染；派发会话在阶段技能正文之前注入独立正文块（数据非指令 → 自动卡快照 → 正文 → 截断提示）。手写卡全文注入、无快照 / 无截断；只有带真实来源的卡超过 3000 码点才截断并给回源提示。提示词文案从打包 locale 读，locale 从宿主解析、默认中文。行为见 §2.10。
- **接管之外补上交还。** `POST /cards/:id/takeover` 置 `takenOver=true`；新增 `POST /cards/:id/release`，只把 `takenOver` 置回 `false` 并写历史 / 审计（`decision=returned-to-engine`），不碰 `sessionId`/`pendingDispatch`/worktree，不立即派发、下一 tick 才接手；重复交还是静默 no-op；有活会话时 toast 追加提醒；无二次确认。看板与收件箱共用一个「已接管」短标签。行为见 §2.11。
- **文案四处同步、断言自足。** 本轮四个字典各新增 11 个 key（任务描述、未可信标注、快照 / 截断提示、已接管 / 交还与提示等），四处逐字节一致。验收断言从「写死总数」改为「本轮新增 key 清单 + 四副本逐字一致 + 占位符集合固定 + 真实 API 读回」，不再拿 `git show HEAD:` 的内容当基线——那样一提交 HEAD 就变成测试自身，断言必红。
- **验收。** Review 无阻断问题；Design 静态源码审稿判定可用，唯一非阻断项是窄屏「交还引擎」按钮 44px 触控高度未生效（内联 `minHeight:28` 压过窄屏规则），Dev 已在窄屏规则上补一处 `!important` 修掉，桌面 28px 不受影响。QA 新增两组用例（body 线、接管线）并把旧断言改成自足形式，报告两条线全绿、全仓套件全绿、业务代码 bug 0；测试数字以实际运行为准，这里不记。真机端到端「改远端 issue → 再派发 → 报告体现新内容」未跑，原因与授权需求见 §5。

**增量（取消卡片，A 档软删）：** 用户反馈看不到删除卡片入口后，核对确认后端早有 `canceled` 终态与各阶段 human→canceled 边、渲染与审计，缺的只是 UI 按钮。按快车道小改在 CardActions 非终态末尾加「取消卡片」（`POST /cards/:id/transition {to:'canceled',actor:'human'}`），四字典新增 `cancelCard` / `toastCardCanceled` 两个 key，四处逐字节一致；后端与 worktree 一行未动。QA 新增独立用例文件，报告取消相关用例与相关文件全绿、自动卡取消不复活验实、业务 bug 0；按快车道未跑全量，数字以实际运行为准。能力见 §2.1，取舍见 §3。

**增量（已取消折叠列表 + 任务卡统计修正）：** 用户反馈看不到「已取消列表」、且全取消后右上角仍显示 3 任务卡。核对发现页尾原本只有纯文本计数、toast 却说「保留在已取消列表」名不副实，统计遍历也未排除 canceled。快车道改 client.js 三处、零字典零后端：页尾纯文本改为 `details/summary` 折叠条（`summary` 显示 `${t('canceled')} · N`，展开 `canceledCards.map(renderCard)`，只读）；右上角统计减去 canceled；`cardCounts` 跳过 canceled，侧栏与标签页一起修正；`done` 仍计入、数量守恒成立。QA 新增独立用例文件，报告取消相关用例全绿、全取消归零与守恒验实、业务 bug 0，未跑全量；数字以实际运行为准。

### P8 — 评审与自动交付迭代（**已完成**；迭代自有的 P0–P3 子阶段）

这一轮把「机器建造」与「人可以放心放手交付」之间的缺口补上了：结构化评审 verdict、独立评理会话、以及一个可选的、止于 draft PR 的机器交付。会话最初是只读的，后来改为跟随项目工作模式（见 P10），verdict 与写入闸门始终没变。子阶段按迭代自己的编号：

- **P0 — 沙箱与权限状态真实化。** 解除了固定沙箱闸：所需沙箱档位改为 create / followup / resume 三条链共用，`permissionEnforced` 按 tick 读真实沙箱投影而不是宣称上限，实验性 auto-review 插件的状态可从状态接口读到。
- **P1 — 结构化 verdict。** `factory_report` 接受封闭的 verdict 形状（`source` / `verdict` / `blocking` / `followUps` / `checks` / `reviewerSessionId`）；`reviewedHead` 由后端从 git 计算，模型自报的 head 一律忽略；同一 head 幂等（不产生第二条 verdict，报告仍追加）；残缺 verdict 拒收而非半写；评理会话上下文隔离——无推进/移卡措辞、注入评审字段、attach 失败即 fail-closed。
- **P2a — 独立评理会话与工作模式。** 每卡一个独立评理会话，记在 `card.reviewSessionId`；复评复用活会话并重读上一轮 verdict；`reviewMode` 接入真实派发链并回读宿主沙箱；三种工作模式（`workspace-write` 默认 / `full-access` / `auto-review`）持久化并有 API 写入口——`auto` 是权限预设、绝不写进沙箱 mode。此时会话仍是只读；后来改为跟随项目工作模式，见 P10。
- **P2b — 三条人工退回。** `return-to-build` / `return-to-plan` / `return-to-inbox`，Inbox 补料开新会话重派，以及 `push-existing`：已有 PR 的卡只在原分支上推、更新同一个 PR 并保持 draft。
- **P3 — 五档与 L4 闸门。** 四个存储档在单个滑杆上呈现为 L0–L4（§2.8）；`auto-delivery` 继承 `machine-approve` 并加上代码闸控的交付：§2.5 的条件、按 head 幂等、认证树规则、止于 draft PR。

**P8 之后的 L4 实战修补（延续本迭代，均已实现）：** review 入口自动提交脏树（双条件幂等 + 独立提交失败预算），使 build 留树与交付要净树不再互相打架；`reviewStale` 显式布尔 + 独立 `markReviewStale`/`clearReviewStale`；`previousReviewedHead` 一等字段（只取上一轮 verdict，不采模型传参）与两种复评范围行；引擎自动复评，每卡一生最多 3 次、只引擎发起计数、三级会话回退；skill 判据改为「有回退转移或有 head 差量」；终态卡永久删除（双闸、审计保留）；提交失败计数与派发失败计数分离；`autoDeliveryFailedNotice` 恢复 `{reason}` 模板；交付前 `worktreeExists` 前置检查给出可读错误。另外修复了「已取消的孤儿卡仍渲染取消按钮」——孤儿快路加终态守卫，终态孤儿只剩删除按钮（删除按钮由 `finish()` 统一出口提供）。

**这一轮改变了验收做法**（因为改的是本项目的验证方式，特记）：离线套件全程绿灯，四个 bug 全部只有真机才暴露——引擎依赖工厂漏传一个端口（被静默丢弃）、一个公开导出被新导出顶掉、一个拿提交前 HEAD 去校验提交后 sha 的检查（真实 git 下永不成立）、以及漏掉的 push 加容器里 git 没有 credential helper。注入的假端口证明的是分支逻辑，证明不了接线与环境。长期规则：凡跨层端口透传、公开导出面、或真实 git/gh 命令链的改动，都要跑一次真实命令链并在验收里记下来。通用版规则沉淀在 `.agents/skills/dsh-plugin-live-verification`（§十）。

### P9 — 每张卡的流程提示与补充信息上文（**已完成**）

P8 之后的纯显示层增量，在单文件客户端里完成，未改后端、`qa-*`、`delivery.js`、`session-context.js`，也未 bump `BUILD`。以下条目从 `client.js` 与 locale 文件逐条复核（见 §2.14）。

- **一行优先。** `cardFlowHintKey(ctx)` 从 17 个新 key 中选一个：孤儿卡复用 `orphanWhy`，已有 L4 评审提示时不出提示，再依次 待补充信息 > 已接管 > 暂停 > 并发排队 > 卡住 > 会话停止 > 状态 × 档位。capacity、评审会话停止、L1/L2 按 `autoDispatch` 区分这三处按代码事实校正文案稿，没有为迁就文案改引擎行为。
- **上次退回原因只读。** `lastTriageReturnReason(history)` 提供输入框上方的信息块，textarea 保持空；后端首条会话消息里只出现一次该原因。没有退回原因时弹窗保持旧行为。
- **验证如实记录。** Dev 新增 `dev-flow-hint` 与 `dev-resupply-hint`，并更新自有 dev 测试的签名；去掉 paused 优先级、去掉「已有评审提示压制」、去掉 context 信息块的变异各自让对应断言变红，还原后一致。整包、i18n parity 与 lint 均报告全绿，`git diff --check` 干净；测试数字以实际运行为准，这里不记。QA 用 DOM 证据在真机核过流程提示：基础文案随状态/档位、每卡唯一且单行位于按钮前、needsHumanInfo/takenOver/paused 优先级、L4 既有提示不叠加、review 场景会话停止。`done`、capacity、triage/plan/build 会话停止三处**未做真机验证**（造不出或没抓到样本），由纯函数测试与代码复核覆盖，Chief 已认可。补充信息弹窗只过 Dev 离线测试与变异验证，**未做真机眼见**，用户选择不补验直接提交。

### P10 — AI 起草交付文案、评理会话工作模式与界面回归修复（**已完成**）

本轮两条线一起收尾；以下行为均从当前源码逐条复核。

- **评理会话跟随工作模式。** `dispatchReview` / `followupReview` 解析项目生效的工作模式（含 `auto-review`）并传给 create / followup / resume；`auto-review` 选 `auto` 预设，其他模式选带名字的预设，让宿主的访问档选择器显示同一档。setup 只展开一次，不再作为以 `read-only` 为键的工厂传入；attach 时不再要求只读沙箱。verdict、`reviewedHead`、head 从 git 取、写入授权等闸门不变，提示词仍禁止移卡与写 git。
- **先起草再确认。** `ai-copy.js` 持有有界的一次性生成器；`index.js` 把它接进两条草稿路由、L4 自动提交与 L4 首次建 PR。客户端草稿弹窗覆盖生成中 / 可编辑 / 兜底 / 提交中四态，取消干净，只有用户确认编辑后的文案才写入。`git-exec.js` 现在区分空串与缺值。新增 16 个文案 key，四个字典镜像一致。
- **同一视图里的两处回归。** 草稿弹窗漏传 `title` 会让三个提交入口一点就整页崩；现在用按钮文案 `confirmLabel` 当标题。标签栏原本没有 sticky，被不透明顶栏吞掉；现在钉在顶栏下、背景不透明、`overflow-y:hidden` 且有最小高度，根节点同时去掉大 `gap`。崩溃修复改到 Host 加载的状态，需要 bump build；随后两条纯 CSS 微调不需要。
- **验证如实记录。** Dev 为目标行为补测试，并对客户端回归做了变异（改回裸 `title`、去掉 sticky/min-height、把根 `gap` 加回去各让对应断言变红，还原后恢复），报告整包、字典一致、lint 与 `git diff --check` 全绿；Chief 独立复核数字与 build。QA 的正式结论覆盖三个不再崩的入口与手动提交四态（生成中只发草稿请求、取消不回填、预填可编辑且 trim 空禁用、注入 fetch reject 得默认文案、确认后把编辑的 `message` 经 authorize 送 commit / commit-existing）。真机还确认 L4 首次草稿 PR 带上了生成文案、PR 正文清空后确实为空、标签栏计算样式与钉住位置符合预期。PR 双字段 UI 路径与「生成请求重复次数」**没有**拿到 QA 的正式结论；后端失败/超时兜底只做过离线验证，未在真机制造失败。见 §5.1。

### P11 — 夹具提交根因、L4 写入护栏与人工重试（**已完成**）

本轮修的是整条流程，不是一个症状；下面按改动后的代码与构建复核。

- **根因。** Git 在 pre-commit 钩子运行时导出 `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` / `GIT_OBJECT_DIRECTORY` / `GIT_ALTERNATE_OBJECT_DIRECTORIES` / `GIT_COMMON_DIR`。测试套件在临时夹具里执行 `git init` / `git commit` 时继承了这些变量，把夹具树写进了卡片分支，于是一条条无关文件提交接连出现。同时环境里的 `GITHUB_TOKEN` 触发已知 PGH-14 环境假红，全量闸门始终过不去，卡片三次失败后锁死 `commitStalled`。卡片的本地分支停在夹具 HEAD，而真正要交付的五文件改动在工作树里。
- **钩子与脚本卫生。** `.husky/pre-commit` 现在先 unset 那六个 `GIT_*` 变量，再运行仓库的完整提交闸门，只隐藏已知会造成环境假红的 `GITHUB_TOKEN`，闸门其余部分不变。release-state 脚本也给自己的 git 子进程剥掉 `GIT_*`，不递归污染卡片仓库。夹具测试因此只会看到自己的仓库。
- **L4 提交的三道闸。** `ensureCommittedForAutoDelivery` 现在接收 `isSessionActive`，会话在跑时在任何 git 读写之前停下；没有 `commitSha` 时把基线 ref 解析成完整 SHA，要求当前 HEAD 与之相等，基线读不到或不是完整 SHA 都拒；统计已跟踪文件的删除数，工作树像夹具换壳时拒。git 端口新增 `headOf`、`deletedCount`、`changedPaths`，`add` / `commit` 带显式路径并加 `--only`。冻结清单来自决策时的状态，之后出现的文件进不了提交。所有拒绝都记成带原因的 `commit-refused` 审计。
- **恢复而不是悄悄重置。** `POST /cards/:id/retry-auto-delivery` 与评审卡按钮让人在修好工作树后清除锁死的失败状态，可选地把修复提交的 sha 同步进 store，下一 tick 由引擎重新跑正常闸门。非 L4、非 Review、接管中、待补信息、活会话、无失败可重都会拒绝。卡片已退回真实基线、只留五个计划内文件，失败状态已清，新的评审会话已派出；源码修复随后由 Chief 提交推送。自动交付路径变了，构建号相应 bump。见 §2.5 与新的 git-write-gates skill。
- **验证如实记录。** Dev 自己的守卫套件覆盖八个场景（意外 HEAD、正常脏树路径、活会话、大量删除、已记录 sha 可前进、钩子环境变量剥离、重试清停滞、重试各类拒绝）；把守卫/路由关掉的变异让其中四条变红，还原后八条全绿。Dev 报告整包、字典一致、release-state、lint 与 `git diff --check` 全绿，并在真机看到新构建与评审会话派出。这些是 Dev 自检加真机观察，本轮**没有**单独的正式 QA 结论。见 §5.1。

### TODO — 候选下一轮（**仅记录，未排期**）

以下为用户提出、尚未授权开工的想法；先记在这里，由 PM/Design 出 PRD 与验收标准、Chief 排优先级。本节任何一条都不是开发指令。

| # | 想法 | 要求的形态 | 验收标准 / 待定决策 |
|---|---|---|---|
| T1 | 全局设置参考单仓设置的 UI 风格优化 | 全局设置面板改用与单仓设置一致的视觉语言：带编号的分栏、标题 + 一行用途说明 + 语气色，卡片容器与间距对齐单仓面板，替换目前较松散的分组标题。 | 只动表现层；任何设置不跨作用域、不跨作用域写入；四份字典逐字节一致；两栏都要真机核对。 |
| T2 | 单仓支持自定义注入 skill，替换默认加载的那几个 skill | 项目可填自己的 skill 正文，**替换**默认加载的技能，不是与默认技能并存。放在单仓设置新开的 **自定义 prompt 与 skill** 栏，位置 **04**；危险区顺延 **05**。每个自定义 skill 输入框上方给出对应默认 skill 的参考 GitHub 地址。 | 已定（用户拍板）：范围＝6 篇阶段技能（triage/plan/build/self-review/review/rereview，add-project 不进框）；留空＝未配置＝回退内置默认、触发点照常生效；一技能一框、整栏一次保存，每技能 8000 字符、系统指令 1000 字符；四份字典同步。注入正文按不可信数据处理：不得绕过阶段流转、授权闸门与沙箱。待定：self-review/rereview 的激活以 T4 会话级版为准；宿主技能注册/source 冲突处理不作为方案依赖（宿主语义仍待真机复核）。 |
| T3 | 单仓注入自定义系统指令 | 同一个 04 栏允许填项目级系统指令，例如「使用中文生成阶段报告」。 | 已定：不作用于 `/factory add` 会话（该时项目尚未创建，add-project 不进框）。待定：与阶段技能、卡片正文注入的先后合并顺序；怎么验收。不得覆盖状态机、授权闸门、沙箱与「数据非指令」防御。 |
| T4 | 独立评审会话（code review / pr review） | 看板仍是一个 `review` 阶段；阶段内分两个会话 + 人做 commit/PR：commit/PR 前由独立新会话审分支 diff（code review，读 `factory-self-review`）；PR 开后人审或另起独立会话审 PR（pr review，读 `factory-review`，回炉追加 `factory-rereview`）。不新增看板列、不加 verdict 硬闸、不自动 commit/自动开 PR；commit/push/开 PR/标完成全由人经现有 authorize 闸门完成。会话字段 `codeReviewSessionId` / `prReviewSessionId` 不得覆盖 `card.sessionId`；两类评审会话每次注入阻断项纪律（Blocking vs follow-up）。 | **本轮已实现（P2a–P3，见 §4 P8）：** 会话级独立在 `card.reviewSessionId` 上落地，结构化 verdict、人工 `review -> build` 回退续原 builder 会话、重读上一轮 verdict 的复评、`push-existing` 路径。T2/T3 中「review 技能激活以 T4 为准」的交叉引用仍然适用。 |

自定义 skill 输入框上方要展示的参考地址（已在 `summerscar/dsh-plugins` 的 `main` 上核对；只读提示、不是可编辑值；内置技能变动时同步更新）：

- `factory-triage` — https://github.com/summerscar/dsh-plugins/tree/main/plugins/dsh-factory/skills/factory-triage
- `factory-plan` — https://github.com/summerscar/dsh-plugins/tree/main/plugins/dsh-factory/skills/factory-plan
- `factory-build` — https://github.com/summerscar/dsh-plugins/tree/main/plugins/dsh-factory/skills/factory-build
- `factory-self-review` — https://github.com/summerscar/dsh-plugins/tree/main/plugins/dsh-factory/skills/factory-self-review
- `factory-review` — https://github.com/summerscar/dsh-plugins/tree/main/plugins/dsh-factory/skills/factory-review
- `factory-rereview` — https://github.com/summerscar/dsh-plugins/tree/main/plugins/dsh-factory/skills/factory-rereview
- `factory-add-project` — https://github.com/summerscar/dsh-plugins/tree/main/plugins/dsh-factory/skills/factory-add-project

其中 `factory-add-project` 没有对应输入框（add-project 不在替换范围，见 T2 已定范围），该地址仅作为内置技能正文登记保留。

| 缺口 | 影响 | 备注 |
|---|---|---|
| **【安全 · 已修】派发会话曾默认拿到 `danger-full-access`，绕过 worktree 沙箱（真机暴露）** | 真机验证中，用户观察到派发的 agent「找不到 worktree」并浏览了**宿主可见的文件系统**。机制（Dev 读源码闭环）：`meta.cwd` 经 `sessions.prepare` 写进 `header.cwd`，而它**正是 `workspace-write` 沙箱的 `workspaceRoot`**（`dsh-sandbox-policy` 的 `sessionWorkspaceRoot()`），bash 执行时按调用 session 解析该策略并 `confine()`——**所以 cwd 恰恰是边界，不是「只决定起始目录」**；bash 是 harness 进程的子进程、在**容器内**执行（bubblewrap 文件隔离），不是跨到宿主另一侧。唯一让边界失效的开关是 mode：`danger-full-access` 下 `dsh-bash-sandbox` 直接 `super.execute()`、**不套沙箱**。而本 profile 的 `permission-presets.defaultPreset` 正是 `danger-full-access`（`approval: never`），且 `dsh-permission-presets` 在 `agent/created` 事件里用 `pinInitialPermission` **把该档钉到每个新会话**——这才是 mode 的来源，比 base patch 的 `defaultMode: workspace-write` 优先级更高。工厂的 `project.defaultPermission` 默认 `workspace-write`（`store.js`），**却和 `model` 一样在 `createSession` 层被丢弃、从未传给 `agents.create`**，于是派发会话被钉成 profile 默认档、裸奔 | **没有实际越界写入**：Chief 核查宿主，workspace 卷 `git status` 干净、HEAD 未变、只动过 `.git/COMMIT_EDITMSG` 与 `.git/index`（我们自己提交），无外推；**只证明看过路径，不能证明写入**。**已修并在真机验证**：自动派发现已在下述闸门下运行，AE-2 端到端链路在这些闸门生效的情况下通过。修法（Chief 定，Dev 已查清时序；现已落地并验证）：① **`createSession` 的 `seed` 里带一条 `sandbox/mode: workspace-write`**——`agents.create` 的执行顺序是「先写 seed → 再 setup → 最后 announce（即 `pinInitialPermission`）」，seed 写入后 `pinInitialPermission` 看到 `sandbox !== null` 就跳过 `setSandboxMode`，**无时序竞态**。**为何选 seed 而非在 setup 里抢先**：seed 是构造参数、语义就是初始事件，不依赖「赶在某个回调之前」的时序，宿主调整顺序也不会失效（时序依赖是脆的）。② **无论哪条路，建完都必须回读 `sandboxMode` session 投影校验**（`dsh-sandbox-policy` 注册 key `sandboxMode`）——不是 `workspace-write` 就 dispose 会话并抛错、走 `dispatchCard` 失败回滚；这是硬保证，防「写了事件就假设生效」，也防宿主版本/配置差异让折叠逻辑不同。③ **自动派发会话的权限上限是 `workspace-write`，即使项目配了 `danger-full-access` 也不放行**（自动派发不该有全权，`project.defaultPermission` 接上但以此上限封顶）；④ worktree 根现在默认用按 HOME 解析的 `~/dsh-factory-worktrees`，走 §2.2 所述的方案 B 窄例外（通常位于数据根外；根内只容忍 `<home>/dsh-factory-worktrees` 这一条精确子树）。⑤ **修复前的历史会话**（无 `sandbox/mode` 事件、可能落在 profile 的默认全权档）在接续时被**拒绝并降级重建**，已落地、不是待办：level 1 的 `followupSession` 与 level 2 的 `resumeSession` 都过 `assertSandboxMode` 闸——level 1 被拒不再让卡卡死，直接降级；level 2 被拒则 `dispose` 该会话再抛错，让 `continueCard` 落到 level 3，用 `createSession` 的 seed 闸重建一个带 `workspace-write` 的新会话，并在卡上记一条降级记录。这样旧的全权会话不会被继续复用，也不必手动清理。另建议用户把 profile 的 `defaultPreset` 改为 `workspace-write`——**这影响其界面上所有普通会话的沙箱保护**，需用户点头单独确认，不与工厂修复捆绑，本鱼不擅自改 |
| **写入与回执之间没有事务边界（工厂侧窗口已焊死，宿主侧窗口仍在）** | 工具过去先 `execute`（写入已落库）再 snapshot/lossless 校验/render；任一步失败就变成「写入已发生但报错」，回执丢失。真机上表现为重名项目堆积 | **由用户拍板选方案 A、已在工厂侧修好**：三个写工具（transition / report / createProject）在落盘前先做回执自检——lossless → schema → render → render lossless 全过才写库。schema 校验生产注入宿主的公开校验器；lossless 用本仓的最小实现、置于可注入端口之后。失败抛原始错误、日志可观测；已端到端验证并做变异验证（摘掉预检则用例变红）与全量回归。**引擎四项措施保留**（幂等、单飞、孤儿对账只报不清理、`dispatchCard` 回滚）：与本修复正交、是防御纵深，不是被替代。**如实记录已知缺口**：① 宿主对任意工具的 write/receipt 窗口仍在，方案 A 只堵工厂自身这条链路；② 本仓 lossless 最小实现与宿主快照函数是两份同语义实现，宿主规则若变动会漂移（schema 那半边已注入宿主真函数消除）；③ 宿主真成功回执流水线本仓不可 import（peer-only），那一环在此测不到。宿主侧 B/C 方案未立项——记为已知缺口，不单独立项 |
| **`card.repo` 与 `card.repoPath` 已拆分** | `intake.js` 把远端 GitHub 标识写入 `repo`、本地根路径写入 `repoPath`；`session-context.js` 的 `repoOf` 优先用 `repoPath`，`repo` 只作展示标识渲染 | **已解决**：两种语义不再共用一个字段，agent 不会再拿到「当路径用的远端标识」。（原为 `machine-approve` 档前置，见 PRD §10） |
| **真实自动派发（AE-2）已端到端验通** | 「真实 GitHub issue 源 → 建卡 → 自动派发 → 停 plan-review」这条链现已在真机跑通，全程无人工点击 | **已验通**：引擎只走 `inbox -> triage` 这一条自动边（记为 `autoRule`），派发的 agent 把卡片推进过 `triage`、`plan`，停在 `plan-review`。链路细节见 §4 P2。（此前因缺真实 issue 源与匹配夹具而未验） |
| ~~接管无 UI 入口~~ | 接管现在有真实 UI 入口：卡片操作区的「接管」按钮 + 设置抽屉里项目级的「暂停与接管」块，都调同一条 `POST /cards/:id/takeover`（另有项目/全局暂停开关；项目级暂停现在是状态开关而非动作按钮：开＝已暂停、关＝运行中） | **P4 已解决**（界面上线） |
| **路由命名易混** | 实际路径是 `/cards/:id/takeover`，不是 `/take-over`；照着猜会 404（QA 真机已踩） | 已请 Docs 在 README 接口说明写清实际路径 |
| **agent 行为漂移（观察中）** | 第 5、6 轮 agent 改用提问卡等确认再建项目，前 3 轮是直接建。判据未要求「不许问」，项目也确实建成 | 倾向判定为技能生效后的正常表现（技能正文写了「先把配置给用户看」），非缺陷。记在此观察，别等到 P2 才发现 agent 到处问 |
| 只支持 GitHub | GitLab 相关技能未实现 | 有明确落点再补 |
| 没有 webhook | 发现 issue 靠轮询 | 单机场景够用 |
| 单机、无多副本协调 | 并发锁只在单进程内有效 | 不是当前场景的问题 |
| 权限字段是可配置值，不是强制边界 | `defaultPermission` 可配，但派发会话的沙箱模式已被上面三道保证真正钉在 `workspace-write`；`permissionEnforced` **刻意恒为 `false`** | 不虚报：界面与状态都不宣称写入限制已生效。沙箱边界本身是真实且已验的；`permissionEnforced` 保持 `false` 正是这份诚实信号，不是未修的缺陷 |
| 分支名是纯标识符 | 人工 review 时可读性差 | 纯改进，非阻塞 |
| 收件箱发现由引擎定时触发 | 引擎定时器每轮 tick 都跑 intake（origin 记 `autoRule`，并遵守 `intakeLimit`）；手动 intake 仍可走 HTTP | 随自治引擎一并实现——发现 issue 不再需要手动触发 |
| ~~删除项目无界面入口~~ | 删项目现在在设置抽屉「危险区」：二次确认（项目名 + 影响），真调 `DELETE /projects/:id` 并连带清 worktree | **P4 已解决**（界面上线） |
| ~~删项目不清 worktree~~ | `DELETE /projects/:id` 现在先清该项目所有 worktree（dirty 检查拒绝脏树并原样返回改动列表；落在项目根外的路径直接拒删），再删登记、记审计事件 | **P4 已解决**（worktree 清理落地） |
| **全局上限已可 HTTP 写入（P4 新增事实）** | `globalMaxActive` 过去只是启动配置值（引擎启动时读、被闭包捕获；改了要重启）。现在可 HTTP 写：`PATCH /settings` 有独立的 `globalMaxActive` 写入口、绝不覆盖 `worktreeRoot`，值落进 `store.settings`，引擎每 tick 实时读、写后下一个 tick 即生效、不需重启，`status.engine` 读回当前有效值及其来源（设置 / 启动配置 / 默认） | **记为新增能力。** 已用后端并发夹具验过：写后卡住下一个 tick、且新 store 读回值不变（P4-7a/7b）。 |
| **宿主 app-shell 在窄屏锁死纵向滚动** | 窄屏宿主（P4 视图把 ≤760px 当作窄屏断点）下，DSH app-shell 的主内容列按 `overflow:hidden` 渲染，纵向滚动被锁死：视图内容超过宿主给的高度时，超出部分既看不见也滚不到。这是宿主行为，插件够不到宿主那层 | **P4 已缓解、真机验过。** P4 视图把样式表限定在自身根属性 `[data-dsh-factory-p4]` 作用域内；窄屏 media query 里给视图根一个「高度受限、内部自滚」的容器（`height:100%; min-height:0; overflow-y:auto`），让溢出在我们自己的容器里滚、而不是被宿主裁剪列卡死；看板区再给 `max-height`，保持有界的横向滚动区、不把整页撑高。真机结果：第一屏可见看板、纵向能滚到各列、横滚与钉底操作条都正常。此后把这条自滚动从窄屏 media query 提到基础规则、覆盖所有宽度（宿主在各宽度都把视图挂在固定高度槽里；展开「已取消」折叠条会在看板下新增内容，宽屏若没有自己的滚动容器就会落进宿主裁剪区、滚不到）；窄屏仍以 `padding:8px` 覆盖、行为不变。宿主那层的锁本身仍在（改宿主不在范围） |

| ~~intake 拉取数量曾写死 `--limit 100`~~ | issue 很多的繁忙上游一次 tick 就可能灌满看板，随后每张新卡都被派发成真会话 | **已修并验证**：改为项目级可配的 `intakeLimit`（默认沿用原上限、保持向后兼容），由引擎 tick 传给 `intakeIssues`；设了值就按值限制每次拉取的建卡数 |
| **批准后接续失败会把卡晾在 `build`** | 批准（`plan-review -> build`，人工按钮或 `machine-approve` 引擎）之后会紧接着接续同一会话。若这次接续失败（例如 profile 没有 `agents` 服务），卡已经进了 `build`，没有自动重试、也没有续接按钮：只能人工接管或手动 `POST /cards/:id/continue` | 已知边界，未修。`machine-approve` 引擎会记一条 `auto-approve-continue-failed` 事件并写 `status.lastError`、不回滚批准；人工按钮路径没有审计事件。后续 tick 不会重试这张卡。另有一种「批准前」的首次接续失败只释放占用、可重试——本行指的是批准之后那一步 |
| **intake 无 label 过滤** | 只能按「全部 open issue」拉，不能只拉指定 label 的 issue；配合不限量的上游仓仍可能拉进大量无关 issue | 保留为缺口，本轮不做（与 `intakeLimit` 是两个功能，别混）。可用 `intakeLimit` 先压量兜底 |
| **派发消息曾未指定阶段技能（已修）** | `session-context.js` 的 `firstMessage` / `sectionText` 原本 `skill` 一词零命中——只说「用 `factory_transition_work_item` 推进」，没说「按 `factory-triage` 技能办事」。对比 `/factory add` 的 `buildAddIntent` 明确写了技能名 | **已修**：两段文案都点名当前阶段技能（`inbox`/`triage→factory-triage`、`plan→factory-plan`、`build→factory-build`、`review→factory-review`；`plan-review`/`done`/`canceled` 无技能）并写明先加载技能再动手，已提交。**注意：只修这条并没让 AE-2 通过**，还有更下层的模型路由问题（下一行）也要修；两者现已都修好，链路已端到端验通 |
| **自动派发的会话曾停在 `triage` 不调工厂工具（AE-2 根因——已修并验通）** | 早几轮真机验证中，每轮都确认宿主 `build` 为新代码、前半链（建卡 / 自动派发 / `inbox→triage` / 审计可区分 / 无 push/PR）照常通；但派发会话始终停在 `triage`、`sessionTurn=1`、`report=null`，不调 `factory_transition_work_item`、没到 `plan-review`；引擎 `lastError:null`、无 orphan | **根因（Dev 追到源码行号，Chief 认可）**：`dispatch.js` 的 `createSession` 当时不解构也不使用 `model`（`dispatch.js:334`，注释自认「not yet wired」）→ `agents.create` 不传 `agentOptions`，agent-loop 补成 `{}`（`dsh-agent-loop:1706`）→ `assertAgentOptions({})` 只校验 maxTokens、放行（`1264-1266`），所以会话建得起来、不报错 → `preStep` 里 `model.current()` 返回 undefined 抛错（`684-685`），被 `kick()` 的 `catch(_error){}` **静默吞掉**（`667`）→ 表现就是「turn=1、啥都没干、无 error 上报」。**四轮已排除**：ESM 缓存、技能指引缺失、preset / `skill` 工具、正文内联（`.26` 仍无变化）。**用户定的模型语义**：会话默认跟随 DSH 默认模型，UI 后续可手动选。修法选 **B**（Chief 定）——port 层 `ctx.get('agentDefaultModel')` 读 `currentSelection()`，照 UI 入口用 getter 形式（**每次读取时现取、不缓存**，理由是与宿主 UI 同构；`currentSelection()` 无副作用，配置在多次读取间变化的极端竞态由下一轮自洽，不是设计缺陷）；`project.defaultModel` 有值时覆盖 model 部分、无值跟随宿主；`createSession` 真接上 `model`。**fail-fast 关键判据**：构造 `agentOptions` 前先探一次 `currentSelection()`，若 `provider` 或 `model` 拿不到就**立即抛错**、走 `dispatchCard` 失败回滚并记到卡上——把「静默停在 triage 什么都不说」变成「派发明确失败并说明原因」，因为宿主 `kick()` 的 `catch(_error){}` 会吞掉会话内部错误，不能依赖它。**已按方案 B 修好并在真机端到端验通——见 §4 P2。** |
| **真机派发起的会话无法主动终止（已知不可清理项）** | AE-2 四轮真机各起一个真 agent 会话（id：`d726dd75…`、`4d5d6911…`、`6ab382b7…`、`e8a6a538…`）；测试项目删掉后引擎不会再派它们，但宿主会话列表里可能仍 idle。`sessions` API 不可用，插件侧无法主动终止 | **起真会话的实际成本**，不是 bug。真机验收收尾要如实记「可能残留 idle 会话」及会话 id，别让它变成下次的谜团；不要为「收尾干净」而谎报已终止 |
| **【验证夹具】空壳测试仓造成「agent 不回执 / 跑出 worktree」的假象** | 真机验证曾用一个只有空 README 与单个 init 提交的最小仓作项目根，worktree 从它拉、里面**没有任何与卡片 issue 对应的源码**；卡片任务却是真实上游 issue。agent 合理地去 `/tmp` 克隆真源码做调查，于是被误读成「不守 worktree」「不回执」 | **不是 agent 行为缺陷，是测试夹具与任务内容不匹配**。连续几轮的「agent 有问题」结论查到底都是环境/配置问题：预设未挂载、工作目录被清理过早、worktree 空壳。技能正文本身要求「只在 worktreePath 内工作」，不引导去 `/tmp`。**危害**：用空壳仓验「回执」「是否留在 worktree」，得出的结论都不成立。**修法就是换用内容与任务相符的真仓库**（有对应源码）——用这种夹具链路已端到端验通；长期纪律见 §4 P2 与 §7 |
| **AE-2b 的「远端 PR CLOSED 快照注入」（真机入口已加）** | `applyRemoteSync` 过去只有函数与单测调用，真机没有办法喂入远端快照。现在有了受控产品入口——`POST /api/dsh-factory/cards/:id/remote-sync`（弱幂等）——调用现成的 `applyRemoteSync`：只记建议、绝不落卡片状态，目标列由远端状态推导、actor 固定 `syncRule`、鉴权继承宿主的 connection 闸。两版 README 已写明该路由；将来 webhook 可复用它 | **已在真机验证**（入口安全与远端建议判据通过）。源码逻辑不变：`SYNC_AUTO_EDGES` 仍是空表、「PR 关闭」建议只记录、不应用。**已知缺口**：① 请求体过大时返回服务端错误而非预期的客户端错误——这是宿主既有全局行为、非本次引入；② 入口未鉴权时 fail-closed 只在代码层确认、未在真机主动触发，因为那样会越过宿主边界 |
| **会话正文「实时优先」未做代码级回源** | 带 source 的卡在会话里拿到的是建卡时快照 + 「数据非指令」标注 + 快照标注，同卡还注入阶段技能的「读远端 issue 全文」指令；设计上把「以实时为准」交给 agent 按指令回源，没有在代码里再拉一次 GitHub | **是选定边界，不等于「已实现实时回源」**：快照在前、回源指令在后，两者在拼装后的 system prompt 里并存；完整端到端「改远端 issue → 再派发 → 报告体现新内容」未跑，见下一条 |
| **Q8 真机端到端未跑** | 上条的完整链路依赖真实 LLM 会话与外部写（绑定仓库 + 改远端 issue），当前真机只有手写卡、无 source 来源卡 | QA 如实标为残留风险、未判绿；要做需用户明确授权绑定仓库并改远端 issue，不在本轮验收范围 |
| ~~窄屏「交还引擎」按钮 44px 触控高度未生效~~ | 内联 `minHeight:28` 曾压过窄屏 CSS 规则，实际窄屏仍是 28px | **已修**：窄屏规则补一处 `!important`，桌面 28px 不变；非阻断，纯 CSS，不改行为 |
| **SQLite 存储留有后续演进工作** | 宿主自带的 `node:sqlite` 是实验性、不受 semver 约束；整份状态每次变更都整行写回，目前没有细粒度表结构 | 实现隔离在 store 模块一处，将来适配 API 只动一个文件；本仓 engines 下限已过免 flag 线。**拆表结构留到将来。** **旧数据不迁移**：这是开发阶段决定，旧 JSON 文件原地保留、新库从空开始；找回旧记录要等迁移功能 |

### 5.1 待办与未验事项

这些都不是引擎行为缺口：一条文案待拍板、一条证据只在代码层的修复，加上下面的未验项。都不影响使用，记在这里免得下一轮重新发现。

| 事项 | 当前状态 | 还差什么 |
|---|---|---|
| ~~**「批准计划」按钮文案**~~ | 控件仍写 **批准计划 / Approve plan**。一次点击同时会把卡转到 `build` 并续原会话，文案低估了它实际做的事（设计稿里的名字是「批准计划，开始实现」）。 | **已拍板：保持不改**。用户明确「就叫批准计划」；控件维持「批准计划 / Approve plan」，与设计稿名称不一致，但这个差异被接受。 |
| **卡片操作按钮的双击禁用** | 前端确实把 `busy` 传给 `disabled`，但 React 重渲染是异步的，**同一帧内的第二次点击仍会进 handler、再发一个 `run`**；disabled 只能在重渲染之后的后续事件里拦住。真正防重复的是**后端兜底**：dispatch 有并发锁、commit / 开 PR 有单次授权 + 状态闸、resupply 有状态门禁。残留小瑕疵：takeover 会多写一条重复审计，两个 run 交错时可能出现重复 toast。 | 结论：双击不会产生重复副作用（有 4 条测试证据）。这不是功能缺陷、也不是已修复项，原行描述不准确已改正；仍欠一次真浏览器双击的真机验证。 |
| ~~**退回/接管的风险提示（AC43）前端未实现**~~ | 后端默认值已按档位派生，前端提示原本没做。 | **已完成**：退回改计划时，若档位为 machine-approve / auto-delivery（这两档后端会自动接管该卡），备注弹窗多一行警示（`NoteModal` 新增可选 `notice`，与 message 分开，不撑长 textarea 的 placeholder）；交还在同两档且卡处于 plan-review 时，成功提示末尾追加一行「下一 tick 会被自动批准」。新增两个 key 四字典已同步；另有 3 条 dev 测试覆盖四字典一致、两档守卫与 notice 不碰 placeholder。如实标注：三个项目里没有 plan-review 卡，风险行与 toast 目前只由测试覆盖、未在真机点过一次，真机眼见仍欠。 |
| ~~更早的 UI 缺口：退回动作仍用 `window.prompt`；Inbox 的 `needsHumanInfo` 徽标未渲染~~ | 两处的后端强制校验都在，只是表现层没跟上。 | **已完成**：退回动作改为页内 `NoteModal`（补充信息重派 / 退回 Inbox / 退回改计划 / 退回构建四个动作全覆盖；空值不可提交、取消中止）；新增「待补充信息 / Needs info」徽标，在共享卡片头部按 `needsHumanInfo === true` 渲染，看板与 Inbox 两处都覆盖。 |
| **真机已验：`approved → push + 草稿 PR`、`push-existing` 端到端、`return-to-plan` 续会话失败回滚** | 交付此前由 Dev/QA 直接调 `runAutoDelivery` + 真实 git port 验，引擎接线由单测与 P3 修 bug 时的 tick 证据覆盖。早期真机 E2E 跑到 autoCommit → 过期 → 自动复评 → 新 verdict 时评审两次判 `verification-incomplete`，`approved → push + 开草稿 PR` 一度未在真机触发；现已跑通两次：PR [#8](https://github.com/summerscar/factory-e2e-hono/pull/8)（head `0dd92be9`）与 PR [#9](https://github.com/summerscar/factory-e2e-hono/pull/9)（head `88e1ce1`），两次均为 draft、`isDraft=true`、`headRefOid` 等于 `reviewedHead`，随后由 Chief 关闭。`push-existing` 端到端：临时 L4 项目的卡 `8d1e37df` 由引擎自动跑到 review 并开草稿 PR [#10](https://github.com/summerscar/factory-e2e-hono/pull/10)；依次 authorize confirm-commit → `commit-existing` 得到新 sha `9b5f806`，authorize push-existing → `POST /cards/{id}/push-existing` 返回 200，url 仍是 PR #10、sha 为新 sha；真实 git/gh 侧远端分支 head 由 `48275109` 变为 `9b5f806`，旧 sha 是新 sha 的祖先（非 force push），PR #10 仍是同一个 PR（`state=OPEN isDraft=true`），未新建 PR、`prUrl` 未改写；卡片 history 新增 `type: push-existing`（actor human，sha `9b5f806`），与首次交付 `actor: auto-delivery` 那条靠 actor + sha 区分；不重新授权重复调用被拒（400「缺少「推送更新草稿 PR」授权」）。`return-to-plan` 续会话失败回滚：卡 `1d66bf5b` 处于 `plan-review` 但无 worktree，`continueCard` 在 worktree 检查处真实报错，`POST /cards/{id}/return-to-plan` 返回 400 `{"error":"该卡没有 worktree，应使用首次派发而不是接续","retryable":true}`，卡片合成回滚到 `plan-review`（未卡在 plan），history 顺序为 `takeover` → `plan-feedback` → `transition plan-review→plan actor=human` → `transition plan→plan-review actor=agent note="continuation failed; retry"`，审计写入 `return-to-plan-continue-failed`（actor human / decision failed），原样重试结果一致、仍可重试；前置拒绝也已验：空 note → 400「修改意见必填」，非 plan-review 卡 → 400「仅 Plan-review 可执行」，不带 `takeOver` 字段时 `machine-approve` 档默认接管生效。 | **已验**：三项均已在真机跑通，无剩余待验。 |
| ~~**`qa-p3` 的 `realPort` 假端口缺 `worktreeExists`**~~ | 真实 host 在交付评估前多一次 `worktreeExists` 本地 git 检查；原先 `qa-p3` 的 fake port 没有该方法，靠 `typeof port?.worktreeExists === 'function'` 守卫让调用序列断言照常通过，与真机有偏差。 | **已完成**：`realPort` 已补上 `worktreeExists`（恒 `true`、记录调用），4 处精确调用序列断言（C5/C5b/C6/C8，各含 arm+execute 两次校验）已同步；补测当时单文件 21/21、整包 657/657 全绿。 |
| **历史遗留的共用失败计数未迁移** | 提交阶段已拆出独立的 `commitFailures` / `commitStalled`（新行为互不干扰），但存量卡里过去与派发共用的 `dispatchFailures` 计数**没有做数据迁移**。 | 真需要时对存量卡做一次计数迁移；不影响新卡的分离行为。 |
| **P1/P2a 残留：没有打包好的 review preset；状态接口里 auto-review 可用性最多一分钟陈旧** | 记为分期限制，不是缺陷。 | 包内 review preset、实时插件状态读。 |
| ~~**「自动交付」已授权但未设定时与最终安全评审**~~ | 调度其实已就位：L4 项目在**每次 tick 里自动尝试交付**，受 `delivery` 的七条硬条件门禁 + 每 head 幂等 + 树等价约束，不需要单独的调度开关。真正缺的是：一次真机等过完整 tick 的端到端交付证据（已在上行记录），以及一次正式的安全评审。 | **剩下要定的是「是否/何时做一次正式安全评审」，不是「要不要开启自动交付」**。 |
| ~~**`/factory` 帮助文本：「commit / push / PR 仍需人工批准」**~~ | `plugins/dsh-factory/commands.js` 的产品可见文案在「自动交付」档下已不准确——该档机器会 commit、push、开 draft PR，而 merge 与标完成仍留给人。 | **已完成**：文案改为写明 L4 会自己 commit / push / 开 draft PR，merge 与标完成始终需要人；锁旧文案的两条正则断言（Dev 与 QA 各一条）已同步更新为锁新文案的关键片段，旧措辞在代码与测试里已无残留。 |
| **流程提示三处场景未在真机验到** | `done`、capacity（`action==='queued'` / `approvalHeld>0`）与 triage/plan/build 的会话停止在造数据里造不出样本，QA 如实报「未验」；基础文案、单行唯一、覆盖优先、不叠加与 review 会话停止已用 DOM 证据验过 | 由纯函数测试与源码复核覆盖，Chief 认可这三处未验；不伪造样本 |
| **补充信息弹窗未做真机眼见** | `lastTriageReturnReason` 的 context 展示与空输入框只过 Dev 离线测试与变异验证，没有真机视觉检查 | 用户选择不补验直接提交；仍欠一次真机点击验证 |
| **PR 双字段编辑器没有 QA 正式结论** | 标题 input、正文 textarea、清空正文路径与空正文提示都过 Dev 自测和真机核对，但 QA 的回复停在手动提交那一半，没有给正式的 C 段结论 | 仍欠 QA 对这条路径的一小段确认；没有报功能缺陷 |
| **开发态观察到生成请求重复** | 点一次会发出多次 `/draft-commit` 或 `/draft-pr`；写请求仍只在确认后发生，闸门没被绕过 | 次数与生产构建表现没有正式结论。影响的是请求成本、不是写入边界；本轮未修 |
| **L4 起草失败/超时未在真机复现** | 兜底路径由注入端口测试与变异覆盖，未在真机制造模型失败或超时 | 离线已覆盖；真机失败场景需要受控的供应商故障 |
| **P11 没有单独的正式 QA 结论** | 八条守卫用例及变异来自 Dev 自检；卡片恢复与评审会话派出在真机看到过，源码修复由 Chief 核实推送 | 新护栏与重试路由还没有 QA 的正式判定；P10 的 C/E 两项也仍欠结论 |

### 5.2 本轮 UI/UX 明确不做的

以下是评估过并明确不做的，不是本轮遗留的缺陷：

- 暗色主题或主题开关。
- 响应式重构，或在本轮窄屏可读性修复之外新增断点。
- 新增动效。
- 引入组件库，或改成宿主主题 token 重写；界面仍是手写 `h()` 加 scoped CSS。
- 身份解析顺序与凭据存储改造。
- 卡片状态机与审批门改造。

窄屏列外宽最初因 `content-box` padding 略高于 84vw，已修：窄屏 `.df-col` 规则加了 `box-sizing:border-box`，390px 视口真机实测列外宽回到 327.59px，与 84vw（327.6px）一致。`intakeBoardId` 无界面入口是已拍板的产品选择、不是开放项：不再加 UI 控件，自动化用户走项目 `PATCH /projects/:id` 路由设置。

## 6. 调研依据（摘要，避免重复调研）

这个插件没有直接 fork 任何现成实现，而是对比两份参考实现后取长补短：

- **参考 A（看板型插件）**：卡片绑独立会话、移动列即给 agent 下达阶段指令、worktree 隔离与清理前脏检查、后台三件套（看门狗熔断 / 成本计量 / 定时任务）成熟。但它**只能配一个项目根**，且没有计划审批门。
- **参考 B（工厂型框架）**：项目→看板→阶段的多源交付平台，有显式的「计划→提交审批→建造」闸门与独立评审纪律。代价是逻辑压在超大运行时依赖里，并硬绑外部数据库、队列与沙箱供应商。

采纳结论：**骨架取 A（卡片=独立会话、worktree 隔离、看门狗），闸门与评审纪律取 B，多项目自己做**（A 做不到、B 的实现方式对本机场景过重）。

其后扩展开的对比——多家工厂式产品的功能优劣、Mastra Factory 的 UI 锚点、后续分期该采纳或跳过什么——见[RESEARCH.md](RESEARCH.md) / [RESEARCH.zh-CN.md](RESEARCH.zh-CN.md)。其结论喂给 §4 的分期；那是决策输入，不是本节的复述。

## 7. 怎么参与

- 先读仓库根与插件目录下的约定文件，再动代码。
- 改动前先确认它属于哪个优先级。§4 里的 P1–P11 均已完成；按 §4 当前状态重新排期，不要依据更旧的状态。
- **嵌套 git 命令必须看见它该检查的仓库。** 提交钩子会把 `GIT_*` 变量传给每个子进程；跑夹具测试或自建仓库的脚本前先剥掉它们。判据是夹具的 `git commit` 落在夹具里、绝不落到卡片分支。通用做法见 `.agents/skills/dsh-git-write-gates`。
- **验收断言写自足的**：断言本轮新增内容、跨副本逐字一致、占位符集合与真实 API 读回，不写死总数，也不拿提交前的文件内容当基线——测试一提交基线就翻转，提交闸门必红。
- 任何涉及 git 写的改动都必须经过人工授权闸门，测试不得绕过。
- 测试由专人维护，不通过自证；数字以实际运行结果为准，不接受「看起来能跑」。
- **数据根相关测试一律注入临时 `DSH_HOME`**：指向 `tmpdir()` 下的临时目录，跑完还原原值并删净。不写真实数据根、不靠 `skip` 规避——数据根判断是惰性求值，进程内改环境变量立即生效，所以用例能真跑起来，覆盖面比跳过更大。
- **「会话不响应」先确认 agent 有没有在推理，再改 prompt**：AE-2 四轮里有两轮花在改 prompt（技能指引、正文内联），真机行为一点没变，根因在更下游（模型路由 / 执行机制）。排查顺序：确认新代码真在内存（`build`）→ 会话是否产生下一个 turn → 有没有工具调用 → 模型路由是否接通 → 最后才轮到 prompt 内容。改 prompt 前不完成前三步，就是拿真会话烧 token 猜谜。
- **真机验证必须用「内容与任务相符」的真仓库**：项目根要指向**含任务所涉源码**的仓库，别用只有空 README 的最小仓。worktree 是从项目根拉的，根里没代码，agent 只能去别处克隆真源码调查——此时验「是否留在 worktree」「有没有回执」得出的结论都不成立，还会被误读成产品缺陷。夹具与任务不匹配时，先修夹具再下结论。
- **取证清理前必须等 `turn/end` 落定**：判据是 `turn/end.reason.kind`（`error` 即异常/被打断），不是其后的 `session/end` / `job/settled:completed`——那些是崩溃后的收尾事件，不是正常结束的证据。提前删 worktree 会抽掉 agent 的 cwd，让它没法走完「写报告 + 推进卡片」的收尾，看起来像「不回执」，实际是被打断。等 turn 真正结束（或明确 error）再清理。
