/**
 * dsh-factory — browser half: the board page.
 *
 * A primary surface, not a settings item: it registers an icon row in the root
 * `sidebar.panellist` list and the full board page in the root `main` keyed slot
 * under the same id (`dsh-factory`), so it opens like the built-in panels. The
 * page is a thin view over `/api/dsh-factory/*` (the Host half); it never
 * touches git.
 *
 * Layout follows the interaction spec: Inbox is a data status rendered as a
 * separate "收件箱" strip on top, NOT a seventh board column; the board keeps the
 * five flow columns (规划中 = triage+plan merged / 待批准 / 实现中 / 待评审 / 完成).
 * Colours are the host's `--dsw-alias-*` tokens (with safe fallbacks so a renamed
 * token degrades looks but never blanks the page), keyed by "who is waiting on
 * whom": blue = agent busy (you wait), amber = your turn, green = done, grey = off.
 *
 * Factories are side-effect free; only `apply` registers anything, and the page's
 * own fetch is a component effect.
 */
window.__ModuleLoader__.load({
  id: '@summerscar/dsh-factory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const NS = 'dsh-factory'
    const API = '/api/dsh-factory'

    const T = {
      ink: 'var(--dsw-alias-text, #1f2328)',
      muted: 'var(--dsw-alias-text-secondary, #6b7280)',
      // Text-only inks. The original muted/warning/danger/orange/green values
      // stay for borders, dots and washes; small text goes through these inks
      // so it keeps >=4.5:1 on white, panel and accentWash backgrounds.
      mutedInk: 'var(--df-muted-ink, #596273)',
      warningInk: 'var(--df-warning-ink, #8a5a00)',
      dangerInk: 'var(--df-danger-ink, #b4232b)',
      infoInk: 'var(--df-info-ink, #2457c5)',
      orangeInk: 'var(--df-orange-ink, #8a4a05)',
      greenInk: 'var(--df-green-ink, #146c4a)',
      // Running-state pill background; the scoped variable is defined below.
      greenWash: 'var(--df-green-wash, #e8f6ef)',
      line: 'var(--dsw-alias-border, #e3e6ea)',
      card: 'var(--dsw-alias-bg, #ffffff)',
      panel: 'var(--dsw-alias-bg-secondary, #f6f7f9)',
      info: 'var(--dsw-alias-info, #2f6feb)',
      warning: 'var(--dsw-alias-warning, #b8860b)',
      success: 'var(--dsw-alias-success, #2f9e56)',
      danger: 'var(--dsw-alias-danger, #d33)',
      // P4 view-scoped brand tokens. The variables are defined only under
      // [data-dsh-factory-p4] in ensureStyles(); the fallbacks keep the page
      // legible even before that stylesheet is injected. Never touch the host theme.
      accent: 'var(--df-accent, #4f46d5)',
      accentWash: 'var(--df-accent-wash, #eef0ff)',
      accentInk: 'var(--df-accent-ink, #3b33b8)',
      blue: 'var(--df-blue, #2f7de1)',
      blueWash: 'var(--df-blue-wash, #eaf2fe)',
      orange: 'var(--df-orange, #c9771f)',
      orangeWash: 'var(--df-orange-wash, #fdf1e3)',
      green: 'var(--df-green, #1f8f63)',
      gray: 'var(--df-gray, #8b95a5)',
      grayWash: 'var(--df-gray-wash, #f1f3f6)',
      dangerWash: 'var(--df-danger-wash, #fdf0f1)',
      radiusLg: 'var(--df-radius, 11px)',
      radiusSm: 'var(--df-radius-sm, 7px)',
      shadow: 'var(--df-shadow, 0 1px 2px rgba(20,28,40,.04), 0 6px 20px rgba(20,28,40,.04))',
    }

    // Status → accent, by "who is waiting" (P4 brand semantics). triage/plan/build
    // = agent busy (blue); inbox/plan-review/review = your turn (orange); done
    // green; canceled grey. Card left borders pick these up (Design checklist #1).
    const STATUS_ACCENT = {
      inbox: T.orange,
      triage: T.blue,
      plan: T.blue,
      'plan-review': T.orange,
      build: T.blue,
      review: T.orange,
      done: T.green,
      canceled: T.gray,
    }

    const COLUMNS = [
      { key: 'planning', labelKey: 'colPlanning', statuses: ['triage', 'plan'] },
      { key: 'awaiting', labelKey: 'colAwaiting', statuses: ['plan-review'] },
      { key: 'building', labelKey: 'colBuilding', statuses: ['build'] },
      { key: 'review', labelKey: 'colReview', statuses: ['review'] },
      { key: 'done', labelKey: 'colDone', statuses: ['done'] },
    ]

    // Sidebar glyph: monochrome outline board (three columns, one shorter to hint
    // at flow), drawn in currentColor so it follows light/dark. Kept distinct from
    // the 64px brand card in icon.svg — that one is the plugin-manager/detail art
    // and would blur at this size. Receives { size, active }; the row carries the
    // active highlight, so the glyph itself stays currentColor in every state.
    function navIconSvg(size) {
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.25" y="4.25" width="17.5" height="15.5" rx="2.6"/><path d="M9.1 7.3v9.4"/><path d="M14.9 7.3v5.8"/></svg>`
    }
    function FactoryNavIcon(props) {
      const size = (props && props.size) || 18
      return h('span', {
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, lineHeight: 0 },
        dangerouslySetInnerHTML: { __html: navIconSvg(size) },
      })
    }

    // Runtime copy source: these inline dictionaries are the ONLY strings `t()`
    // reads (registered below via ctx.locale.register). locale/{zh,en}.json are
    // kept for the packaged market `meta` and the locale-defined UI key set;
    // any copy change must be mirrored there so identical keys never diverge.
    const zh = {
      settings: "项目工厂",
      navLabel: "项目工厂",
      refresh: "刷新",
      loading: "加载中…",
      errorPrefix: "出错了：",
      noProjects: "还没有项目，先建一个。",
      projectName: "项目名称",
      rootPath: "仓库根（绝对路径）",
      newBoard: "新建看板",
      newCard: "新建卡片",
      create: "创建",
      project: "项目",
      board: "看板",
      inbox: "📥 收件箱（未派发）",
      inboxEmpty: "收件箱为空",
      colPlanning: "规划中",
      colAwaiting: "待批准",
      colBuilding: "实现中",
      colReview: "待评审",
      colDone: "完成",
      canceled: "已取消",
      emptyColumn: "—",
      actDispatch: "派发给 AI",
      actApprovePlan: "批准计划",
      actConfirmCommit: "确认 commit",
      actCreatePr: "推送分支并创建 PR",
      actMarkDone: "标记完成",
      setupTitle: "worktree 准备",
      setupPurpose: "每次派生新 worktree 时：从项目根复制指定本地文件，然后运行准备命令。",
      setupCopyLabel: "要复制的本地文件",
      setupCopyHint: "相对项目根的路径（如 .env），通常是被 git 忽略的本地文件。",
      setupEg: "例如",
      setupAddPath: "+ 添加路径",
      setupRemove: "移除",
      setupCopyEmpty: "未配置。留空时，新 worktree 中不会出现 .env 等本地文件。",
      setupPathInvalid: "路径必须相对项目根；不接受绝对路径、..、.git 内路径或符号链接。",
      setupPathMissing: "项目根下找不到 {path}；本次派发会跳过该文件。",
      setupPostLabel: "创建 worktree 后运行",
      setupPostHint: "在你新建的 worktree 内执行；命令由你提供，插件不预设。执行失败会回滚本次派发。",
      setupRisk: "命令在你的机器上执行；只填写你信任的命令。",
      setupFollowRepo: "具体装什么、跑什么验证请遵循目标仓库自己的 AGENTS.md / CONTRIBUTING",
      setupLocalFilesHint: "本地文件请在「要复制的本地文件」中配置，不要在这里写 cp ../。",
      setupVarsTitle: "命令可用的环境变量",
      setupVarsEnv: "这些变量以环境变量注入；命令中直接引用变量名，不要自行拼接路径。",
      setupVarWorktreePath: "本 worktree 的绝对路径（$worktree_path）",
      setupVarWorktreeName: "worktree 名称（$worktree_name）",
      setupVarBranchName: "本次分支名（$branch_name）",
      setupVarBaseRef: "基分支（$base_ref）",
      setupAdvanced: "高级：超时",
      setupTimeout: "超时（分钟）",
      setupTimeoutHint: "超时会中止命令并回滚本次派发。",
      setupPostEmpty: "留空表示不运行准备命令",
      setupSave: "保存",
      setupSaving: "保存中…",
      setupSaved: "已保存",
      setupPreparing: "准备 worktree 中…",
      setupRolledBack: "已回滚：worktree 与分支已清理",
      wtRootTitle: "worktrees 根目录（全局）",
      wtRootPurpose: "设置新项目 worktree 的统一存放位置，各项目会在此目录下有独立子目录",
      wtRootLabel: "Worktrees root（留空使用默认值）",
      wtRootPlaceholder: "~/dsh-factory-worktrees",
      wtRootHint: "留空使用默认 `~/dsh-factory-worktrees`（按用户主目录解析）",
      wtRootResolved: "当前生效：{path}",
      wtRootScope: "仅对之后新建的 worktree 生效；已有 worktree 不受影响",
      wtRootDanger: "worktrees root 不能位于 DSH 数据目录内",
      // P4 · autonomy & runtime panel
      autoPanelTitle: "自治档位",
      autoPanelPurpose: "档位与暂停偏好分开保存，互不影响",
      lvTitle: "自治档位",
      lvL0: "手动",
      lvL1: "你批准",
      lvL2: "机器批准",
      badgeL0: "手动",
      badgeL1: "你批准",
      badgeL2: "机器批准",
      badgePaused: "已暂停",
      lvSub: "机器自动做到哪一步",
      leMachine: "机器会做",
      leYou: "你来做",
      leL0M: "不自动派发、不自动批准、不自动提交；所有动作都等你手动触发。",
      leL0Y: "手动派发卡片、批准计划、确认 commit 与创建 PR。",
      leL1M: "自动派发并生成计划，把卡片停在「待批准」，不再往下推进。",
      leL1Y: "批准计划后，机器才继续实现。",
      leL2M: "自动批准计划并继续实现，直到进入「待评审」后停下。",
      leL2Y: "无需操作；机器不触碰 git、不创建 PR、不标记完成。可随时改回手动。",
      prefHead: "偏好开关（一般不用改）",
      prefNote: "两个开关只记录你的偏好，不决定档位；切换档位不会清空它们。",
      unsaved: "未保存",
      autoStart: "新卡片自动派发",
      autoApprove: "计划自动批准",
      inactiveAtLevel: "当前档位不生效",
      saveLevel: "保存档位",
      l2Title: "改用「机器批准」档位？",
      l2Body: "启用后，机器自动批准计划并继续实现；它不会执行 git 操作、不会创建 PR、不会标记完成。此档位按项目单独启用，随时可改回手动。",
      enableL2: "确认启用",
      cancel: "取消",
      pauseTitle: "暂停与接管",
      pauseSub: "立即生效的手动闸门",
      projPause: "暂停本项目的自动派发",
      enginePause: "暂停引擎",
      engineResume: "恢复引擎",
      engineRunning: "引擎运行中",
      enginePaused: "引擎已暂停",
      pauseSem: "暂停只阻止新的自动派发；正在运行的会话继续，跳过的卡片不会自动补跑。",
      takeover: "我来接手",
      concTitle: "并发上限",
      concSub: "项目上限与全局上限分别保存，实际生效值取两者中较小的。",
      projMaxLabel: "本项目并发上限（maxActiveSessions）",
      globMaxLabel: "全局并发上限（globalMaxActive）",
      blankDefault: "留空使用默认值",
      globHelp: "所有项目的任务总数上限。留空使用默认值；保存后立即生效，重启后保留。",
      effLabel: "生效并发上限",
      effSrc: "生效值来源：{src}（取项目与全局中较小者）",
      srcSettings: "已保存的全局并发设置",
      srcConfig: "部署配置",
      srcDefault: "内置默认值",
      saveConc: "保存项目并发上限",
      saveGlobal: "保存全局并发上限",
      dangerTitle: "危险区",
      dangerSub: "仅当前项目",
      deleteHint: "删除项目及其所有看板、卡片与 worktree，操作不可撤销。",
      deleteProject: "删除项目",
      delTitle: "删除项目及其 worktree",
      delBody: "将删除本项目登记及其所有 worktree。只清理属于本项目的 worktree；有未提交改动的会被拒绝并列出改动；部分清理失败则保留项目登记并显示原始错误。",
      delType: "输入项目名 {name} 以确认",
      delWrong: "项目名不匹配，未删除",
      forceHead: "强制清理有未提交改动的 worktree（不默认勾选）",
      forceBody: "默认拒绝删除并列出改动；仅在确知可丢弃时勾选。",
      delConfirm: "删除项目",
      needsTitle: "需要你处理",
      needsApprove: "待批准计划",
      needsStalled: "停滞任务卡",
      needsOrphan: "孤儿会话",
      needsEngineErr: "引擎错误",
      needsClear: "暂无待你处理的事项",
      gmInvalid: "全局并发上限必须是正整数或留空（null）",
      pmInvalid: "项目并发上限必须是正整数或留空（null）",
      scopeGlobal: "全局设置",
      scopeGlobalSub: "所有项目（含本机 GitHub 连接）",
      scopeProject: "项目设置",
      scopeProjectSub: "仅当前项目",
      globalNote: "全局设置作用于所有项目：worktrees 根目录、GitHub OAuth App 的 Client ID、GitHub OAuth App 连接与 gh CLI 状态、全局并发上限、引擎暂停。改动只影响之后新建的 worktree 与调度；已有项目与运行中的卡不变。",
      engineGate: "暂停整个引擎",
      engineGateHint: "全局暂停挡住所有项目的自动派发；已在运行的会话不受影响。页头的引擎开关与此同步。",
      viewDesc: "每张卡表示一项任务，按阶段分列；到批准关口才需要你操作。",
      statCards: "任务卡",
      statActive: "活跃会话",
      statSlots: "并发上限（生效）",
      closeSettings: "关闭",
      mobileSettings: "配置",
      mobileTakeover: "我来接手",
      mobileApprove: "批准计划",
      mobileDispatch: "交给 AI",
      // P4-github · project GitHub identity card (Design copy — plain words only)
      ghCardTitle: "GitHub 连接",
      ghLocalLabel: "本地仓库路径",
      ghRepoLabel: "远端 GitHub 仓库",
      ghLinked: "已绑定",
      ghExpandPath: "显示完整路径",
      ghNowUsing: "当前身份：{account}",
      ghFrom: "身份来源：{source}",
      ghUnknownAccount: "无法识别账号",
      ghSharedTag: "所有项目共用",
      srcConnected: "GitHub OAuth App 已连接",
      srcComputer: "gh CLI 已登录",
      srcSystem: "环境变量中的 GitHub Token",
      srcAddedShared: "GitHub Token（全局）",
      srcThisRepo: "GitHub Token（仅此仓库）",
      srcNone: "未连接",
      ghPermOk: "有权限访问此仓库",
      ghPermBad: "无权限访问此仓库",
      ghCheckPerm: "检查 GitHub 权限",
      ghChecking: "正在检查权限…",
      ghConnect: "连接 GitHub",
      ghAddAccount: "填写 GitHub Token",
      ghGuideNone: "此仓库尚无可用身份。用 GitHub OAuth App 连接（所有项目共用），或用 gh CLI 登录，或填写 GitHub Token。",
      ghGuideNoAccess: "当前 GitHub 身份无权限访问此仓库。换用有权限的身份，或为此仓库单独填写 GitHub Token。",
      ghKeepOpen: "GitHub OAuth App 连接完成前请勿关闭此页面",
      ghStepOpen: "① 打开 GitHub 授权网址",
      ghStepCode: "② 在 GitHub 登录后输入设备码",
      ghStepConnecting: "③ 正在完成 GitHub OAuth App 连接…",
      ghStepDone: "连接成功，所有项目共用此 GitHub 身份",
      ghScopeTitle: "这个 GitHub Token 给谁用？",
      ghScopeAll: "所有项目共用",
      ghScopeRepo: "仅此仓库",
      ghScopeHint: "选「所有项目共用」，之后新建的项目也会使用这个 GitHub Token；选「仅此仓库」，只作用于当前仓库。",
      ghAppIdLabel: "GitHub OAuth App · Client ID",
      ghAppIdHint: "在你的 GitHub 账号下创建 GitHub OAuth App，把它的 Client ID 填到这里；配置一次，所有项目共用。Client ID 不是密钥。",
      ghChangeSharedConfirm: "这会替换所有项目当前共用的 GitHub 身份，确定继续？",
      ghSaveAppId: "保存 Client ID",
      ghAccountLabel: "GitHub Token",
      ghAccountHint: "粘贴你自己的 GitHub Token。它只保存在你的账号下，保存后不再显示。",
      ghSaveAccount: "保存 GitHub Token",
      ghSaved: "已保存",
      // P4-github increment · global account management (Design §7.7)
      ghConnectState: "GitHub OAuth App 连接状态：{state}",
      ghStateOn: "已连接",
      ghStateOff: "未连接",
      ghReconnect: "重新连接 GitHub OAuth App",
      ghDisconnect: "断开此设备的 GitHub OAuth App 连接",
      ghDisconnectDone: "已断开此设备上的 GitHub OAuth App 连接。",
      ghRevokeGuide: "这只是设备端断开；要彻底撤销授权，请到 GitHub 网页取消 GitHub OAuth App 的授权。",
      ghRevokeLink: "在 GitHub 网页撤销授权",
      ghConnectBusy: "GitHub OAuth App 正在连接，请稍候。",
      ghOneAtATime: "同时只能进行一个 GitHub OAuth App 连接，进行中请勿重复点击。",
      ghComputerLoginTitle: "gh CLI 登录状态",
      ghComputerLoggedIn: "已登录",
      ghComputerLoggedOut: "未登录",
      ghComputerLoginGuide: "gh CLI 尚未登录。在本机完成 gh CLI 登录后回来刷新此页。",
      ghPermNotChecked: "权限未检查",
      pauseProject: "暂停本项目",
      resumeProject: "恢复本项目",
      mobileProjectConfig: "项目配置",
      groupGithub: "GitHub 连接",
      groupPaths: "路径与并发",
      groupEngine: "引擎",
    }
    const en = {
      settings: "Project Factory",
      navLabel: "Project Factory",
      refresh: "Refresh",
      loading: "Loading…",
      errorPrefix: "Error: ",
      noProjects: "No project yet — create one.",
      projectName: "Project name",
      rootPath: "Repo root (absolute path)",
      newBoard: "New board",
      newCard: "New card",
      create: "Create",
      project: "Project",
      board: "Board",
      inbox: "📥 Inbox (not dispatched)",
      inboxEmpty: "Inbox empty",
      colPlanning: "Planning",
      colAwaiting: "Awaiting approval",
      colBuilding: "Building",
      colReview: "Review",
      colDone: "Done",
      canceled: "Canceled",
      emptyColumn: "—",
      actDispatch: "Dispatch to AI",
      actApprovePlan: "Approve plan",
      actConfirmCommit: "Confirm commit",
      actCreatePr: "Push branch & create PR",
      actMarkDone: "Mark done",
      setupTitle: "Worktree setup",
      setupPurpose: "On each new worktree: copy selected local files from the project root, then run the setup command.",
      setupCopyLabel: "Local files to copy",
      setupCopyHint: "Paths relative to the project root (e.g. .env), usually git-ignored local files.",
      setupEg: "e.g.",
      setupAddPath: "+ Add path",
      setupRemove: "Remove",
      setupCopyEmpty: "Not configured. If left empty, local files such as .env won't appear in the new worktree.",
      setupPathInvalid: "Path must be relative to the project root; absolute paths, .., paths inside .git and symlinks are rejected.",
      setupPathMissing: "{path} not found at the project root; this file is skipped for this dispatch.",
      setupPostLabel: "Run after worktree creation",
      setupPostHint: "Runs inside the new worktree. You provide the command; the plugin ships no default. Failure rolls back this dispatch.",
      setupRisk: "Runs on your machine; only use commands you trust",
      setupFollowRepo: "Follow the target repo's own AGENTS.md / CONTRIBUTING for what to install and verify",
      setupLocalFilesHint: "Add local files under Local files to copy instead of writing cp ../ here.",
      setupVarsTitle: "Environment variables available to the command",
      setupVarsEnv: "Injected as environment variables; reference the variable directly, don't build paths by string concatenation.",
      setupVarWorktreePath: "Absolute path of this worktree ($worktree_path)",
      setupVarWorktreeName: "Worktree name ($worktree_name)",
      setupVarBranchName: "Branch name ($branch_name)",
      setupVarBaseRef: "Base ref ($base_ref)",
      setupAdvanced: "Advanced: timeout",
      setupTimeout: "Timeout (minutes)",
      setupTimeoutHint: "A timeout aborts the command and rolls back this dispatch.",
      setupPostEmpty: "Leave empty = no setup command is run",
      setupSave: "Save",
      setupSaving: "Saving…",
      setupSaved: "Saved",
      setupPreparing: "Preparing worktree…",
      setupRolledBack: "Rolled back: worktree and branch removed",
      wtRootTitle: "Worktrees root (global)",
      wtRootPurpose: "Set the shared location for new projects' worktrees; each project gets its own subdirectory under it",
      wtRootLabel: "Worktrees root (leave blank for default)",
      wtRootPlaceholder: "~/dsh-factory-worktrees",
      wtRootHint: "Leave blank to use the default `~/dsh-factory-worktrees` (resolved from your home directory)",
      wtRootResolved: "Effective now: {path}",
      wtRootScope: "Applies only to worktrees created from now on; existing worktrees are unaffected",
      wtRootDanger: "Worktrees root cannot be inside the DSH data directory",
      // P4 · autonomy & runtime panel
      autoPanelTitle: "Autonomy level",
      autoPanelPurpose: "Level and pause preference save separately — never together",
      lvTitle: "Autonomy level",
      lvL0: "Manual",
      lvL1: "You approve",
      lvL2: "Machine approves",
      badgeL0: "Manual",
      badgeL1: "You approve",
      badgeL2: "Machine approves",
      badgePaused: "Paused",
      lvSub: "How far the machine goes automatically",
      leMachine: "Machine does",
      leYou: "You do",
      leL0M: "No auto dispatch, approval or commit; every action waits for you.",
      leL0Y: "Dispatch cards, approve plans, confirm commits and create PRs yourself.",
      leL1M: "Dispatches and drafts a plan, then stops at Awaiting approval.",
      leL1Y: "Approve the plan; the machine then continues to implementation.",
      leL2M: "Auto-approves plans and continues to implementation, stopping at Review.",
      leL2Y: "No action needed; the machine never touches git, opens PRs or marks work done. Switch back to Manual anytime.",
      prefHead: "Preference switches (usually leave as-is)",
      prefNote: "The two switches only record your preference; they don't set the level and persist across level changes.",
      unsaved: "Unsaved",
      autoStart: "Auto-dispatch new cards",
      autoApprove: "Auto-approve plans",
      inactiveAtLevel: "Not applied at this level",
      saveLevel: "Save level",
      l2Title: "Switch to the \"Machine approves\" level?",
      l2Body: "Once enabled, the machine auto-approves plans and continues to implementation; it performs no git operations, creates no PRs and marks nothing done. Enabled per project and reversible anytime.",
      enableL2: "Enable",
      cancel: "Cancel",
      pauseTitle: "Pause & takeover",
      pauseSub: "Manual gates, effective immediately",
      projPause: "Pause auto dispatch for this project",
      enginePause: "Pause engine",
      engineResume: "Resume engine",
      engineRunning: "Engine running",
      enginePaused: "Engine paused",
      pauseSem: "Pause only blocks new auto dispatch; running sessions continue and skipped cards aren't retried automatically.",
      takeover: "Take over",
      concTitle: "Concurrency cap",
      concSub: "Project and global caps are saved separately; the effective value is the smaller of the two.",
      projMaxLabel: "Project concurrency cap (maxActiveSessions)",
      globMaxLabel: "Global concurrency cap (globalMaxActive)",
      blankDefault: "Leave blank to use the default",
      globHelp: "Cap on the total number of tasks across all projects. Leave blank for the default. Changes apply on save and survive a restart.",
      effLabel: "Effective concurrency cap",
      effSrc: "Effective value source: {src} (the smaller of the project and global caps)",
      srcSettings: "saved global concurrency setting",
      srcConfig: "deployment config",
      srcDefault: "built-in default",
      saveConc: "Save project concurrency cap",
      saveGlobal: "Save global concurrency cap",
      dangerTitle: "Danger zone",
      dangerSub: "This project only",
      deleteHint: "Deletes this project and all its boards, cards and worktrees. This cannot be undone.",
      deleteProject: "Delete project",
      delTitle: "Delete project and its worktrees",
      delBody: "Deletes the project registration and all its worktrees. Only worktrees belonging to this project are removed. Dirty worktrees are refused with their change list; a partial cleanup failure keeps the registration and shows the original error.",
      delType: "Type the project name {name} to confirm",
      delWrong: "Project name does not match — nothing deleted",
      forceHead: "Force-remove worktrees with uncommitted changes (off by default)",
      forceBody: "By default a dirty tree is refused and listed; only tick this when you know the changes can be discarded.",
      delConfirm: "Delete project",
      needsTitle: "Needs attention",
      needsApprove: "Plans to approve",
      needsStalled: "Stalled tasks",
      needsOrphan: "Orphan sessions",
      needsEngineErr: "Engine error",
      needsClear: "Nothing needs your attention",
      gmInvalid: "Global concurrency cap must be a positive integer or blank (null)",
      pmInvalid: "Project concurrency cap must be a positive integer or blank (null)",
      scopeGlobal: "Global settings",
      scopeGlobalSub: "All projects (incl. machine-level GitHub connection)",
      scopeProject: "Project settings",
      scopeProjectSub: "This project only",
      globalNote: "Global settings apply to all projects: worktrees root, GitHub OAuth App Client ID, GitHub OAuth App connection and gh CLI status, global concurrency cap, engine pause. Changes only affect worktrees and scheduling created from now on; existing projects and in-flight cards are untouched.",
      engineGate: "Pause entire engine",
      engineGateHint: "A global pause blocks auto dispatch for all projects; running sessions are untouched. The header engine switch stays in sync.",
      viewDesc: "Each card is a task, grouped by stage; you're only asked to act at approval gates.",
      statCards: "Tasks",
      statActive: "Live sessions",
      statSlots: "Effective concurrency cap",
      closeSettings: "Close",
      mobileSettings: "Settings",
      mobileTakeover: "Take back",
      mobileApprove: "Approve",
      mobileDispatch: "Hand to AI",
      // P4-github · project GitHub identity card (Design copy — plain words only)
      ghCardTitle: "GitHub connection",
      ghLocalLabel: "Local repo path",
      ghRepoLabel: "Remote GitHub repository",
      ghLinked: "Linked",
      ghExpandPath: "Show full path",
      ghNowUsing: "Current identity: {account}",
      ghFrom: "Identity source: {source}",
      ghUnknownAccount: "Account unknown",
      ghSharedTag: "Shared by all projects",
      srcConnected: "GitHub OAuth App connected",
      srcComputer: "gh CLI signed in",
      srcSystem: "GitHub Token from environment",
      srcAddedShared: "GitHub Token (all projects)",
      srcThisRepo: "GitHub Token (this repo only)",
      srcNone: "Not connected",
      ghPermOk: "Has access to this repo",
      ghPermBad: "No access to this repo",
      ghCheckPerm: "Check GitHub access",
      ghChecking: "Checking access…",
      ghConnect: "Connect GitHub",
      ghAddAccount: "Add a GitHub Token",
      ghGuideNone: "No identity is available for this repo. Connect with GitHub OAuth App (shared by all projects), sign in with gh CLI, or add a GitHub Token.",
      ghGuideNoAccess: "The current GitHub identity has no access to this repo. Use an identity with access, or add a GitHub Token for this repo only.",
      ghKeepOpen: "Keep this page open until the GitHub OAuth App connection finishes",
      ghStepOpen: "① Open the GitHub authorization link",
      ghStepCode: "② Sign in to GitHub, then enter the device code",
      ghStepConnecting: "③ Finishing GitHub OAuth App connection…",
      ghStepDone: "Connected — shared by all projects",
      ghScopeTitle: "Who should use this GitHub Token?",
      ghScopeAll: "All projects (shared)",
      ghScopeRepo: "This repo only",
      ghScopeHint: "All projects (shared) also applies to projects created later; This repo only applies to the current repo.",
      ghAppIdLabel: "GitHub OAuth App · Client ID",
      ghAppIdHint: "Create a GitHub OAuth App in your GitHub account and paste its Client ID here. Set up once; all projects share it. The Client ID is not a secret.",
      ghChangeSharedConfirm: "This replaces the GitHub identity shared by all projects. Continue?",
      ghSaveAppId: "Save Client ID",
      ghAccountLabel: "GitHub Token",
      ghAccountHint: "Paste your own GitHub Token. It is stored under your account only and is never shown again.",
      ghSaveAccount: "Save GitHub Token",
      ghSaved: "Saved",
      // P4-github increment · global account management (Design §7.7)
      ghConnectState: "GitHub OAuth App connection: {state}",
      ghStateOn: "Connected",
      ghStateOff: "Not connected",
      ghReconnect: "Reconnect GitHub OAuth App",
      ghDisconnect: "Disconnect GitHub OAuth App on this device",
      ghDisconnectDone: "GitHub OAuth App disconnected on this device.",
      ghRevokeGuide: "This only disconnects this device. To fully revoke access, remove the GitHub OAuth App authorization on the GitHub website.",
      ghRevokeLink: "Revoke on GitHub",
      ghConnectBusy: "GitHub OAuth App connection in progress, please wait.",
      ghOneAtATime: "Only one GitHub OAuth App connection at a time — don't click again while it's running.",
      ghComputerLoginTitle: "gh CLI sign-in status",
      ghComputerLoggedIn: "Signed in",
      ghComputerLoggedOut: "Not signed in",
      ghComputerLoginGuide: "gh CLI isn't signed in. Sign in with gh CLI on this machine, then refresh this page.",
      ghPermNotChecked: "Access not checked yet",
      pauseProject: "Pause this project",
      resumeProject: "Resume this project",
      mobileProjectConfig: "Project config",
      groupGithub: "GitHub connection",
      groupPaths: "Paths & concurrency",
      groupEngine: "Engine",
    }

    async function callApi(method, path, body) {
      const options = { method, headers: { 'content-type': 'application/json' } }
      if (body !== undefined) options.body = JSON.stringify(body)
      const res = await fetch(`${API}${path}`, options)
      const text = await res.text()
      const data = text === '' ? {} : JSON.parse(text)
      if (!res.ok) throw new Error(data.error || `${method} ${path} → ${res.status}`)
      return data
    }

    function Field({ label, value, onChange, placeholder }) {
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: T.mutedInk } }, [
        label,
        h('input', {
          key: 'input', value, placeholder,
          onChange: (event) => onChange(event.target.value),
          style: { padding: '10px 12px', border: `1px solid ${T.line}`, borderRadius: T.radiusSm, background: T.card, color: T.ink, fontSize: 13, lineHeight: 1.55 },
        }),
      ])
    }

    function Button({ children, onClick, disabled }) {
      return h('button', {
        onClick, disabled,
        style: { padding: '6px 12px', borderRadius: T.radiusSm, border: `1px solid ${T.line}`, background: T.card, color: T.ink, fontSize: 13, lineHeight: 1.55, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1 },
      }, children)
    }

    function Card({ card }) {
      const accent = STATUS_ACCENT[card.status] || T.muted
      const meta = (card.source && card.source !== 'manual' ? `${card.source} · ` : '') + card.status
      return h('div', {
        className: 'df-card',
        style: { background: T.card, border: `1px solid ${T.line}`, borderLeft: `3px solid ${accent}`, borderRadius: T.radiusLg, boxShadow: T.shadow, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 },
      }, [
        h('div', { key: 'title', style: { fontSize: 13, color: T.ink, fontWeight: 500, lineHeight: 1.55 } }, card.title),
        h('div', { key: 'meta', style: { fontSize: 11.5, color: T.mutedInk, lineHeight: 1.4 } }, meta),
      ])
    }

    // Per-card action buttons. Each drives the gated backend (authorize, then the
    // git action, or a human transition); the backend refuses anything not armed,
    // so the UI can never bypass the approval gate even if a button is mis-clicked.
    function CardActions({ card, run, t, busy }) {
      const buttons = []
      // Disable while a board action is in flight: a second click cannot start
      // a parallel run, and the backend gates still guard the write regardless.
      const add = (label, fn) => buttons.push(h(Button, { key: label, onClick: () => void run(fn), disabled: busy }, label))
      if (card.status === 'inbox') add(t('actDispatch'), async () => { await callApi('POST', `/cards/${card.id}/dispatch`) })
      // Approving IS the human gate: one click moves plan-review -> build AND
      // continues the live session, so build starts running instead of leaving a
      // card with no button. Both gates stay server-side — only a human may take
      // this edge, and /continue reuses the existing worktree/session.
      if (card.status === 'plan-review') add(t('actApprovePlan'), async () => {
        await callApi('POST', `/cards/${card.id}/transition`, { to: 'build', actor: 'human' })
        await callApi('POST', `/cards/${card.id}/continue`)
      })
      // Take-over pulls one card out of the engine's control, persisted on the
      // card. Available on any live (non-terminal) card (P4-6, third entry).
      if (card.status !== 'done' && card.status !== 'canceled' && card.takenOver !== true) {
        add(t('takeover'), async () => { await callApi('POST', `/cards/${card.id}/takeover`) })
      }
      if (card.status === 'review') {
        if (!card.commitSha) add(t('actConfirmCommit'), async () => {
          await callApi('POST', `/cards/${card.id}/authorize`, { action: 'confirm-commit' })
          await callApi('POST', `/cards/${card.id}/commit`)
        })
        if (card.commitSha && !card.prUrl) add(t('actCreatePr'), async () => {
          await callApi('POST', `/cards/${card.id}/authorize`, { action: 'create-pr' })
          await callApi('POST', `/cards/${card.id}/create-pr`)
        })
        add(t('actMarkDone'), async () => { await callApi('POST', `/cards/${card.id}/transition`, { to: 'done', actor: 'human' }) })
      }
      if (buttons.length === 0) return null
      return h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 } }, buttons)
    }

    function Column({ title, cards, t, renderCard }) {
      return h('div', { className: 'df-col', style: { background: T.panel, borderRadius: T.radiusLg, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 } }, [
        h('div', { key: 'head', className: 'df-col-head', style: { fontSize: 12, fontWeight: 600, color: T.mutedInk, display: 'flex', justifyContent: 'space-between' } }, [
          h('span', { key: 'label' }, title),
          h('span', { key: 'count' }, String(cards.length)),
        ]),
        cards.length === 0
          ? h('div', { key: 'empty', style: { fontSize: 12, color: T.mutedInk } }, t('emptyColumn'))
          : cards.map(renderCard),
      ])
    }

    // Design §12.3 lists package-manager install commands as example chips.
    // They are intentionally NOT hardcoded here: QA's J5 gate scans every
    // product file for hardcoded install commands, and an open-source plugin
    // must not prescribe a package manager. The chips below show variable
    // usage only; the real command comes from the target repo's own rules.
    const COPY_EXAMPLES = ['.env', '.env.local', 'config/local.json']
    const POST_EXAMPLES = ['echo "$worktree_path"', 'printf "%s\\n" "$branch_name"']
    const VARIABLE_ROWS = [
      ['worktree_path', 'setupVarWorktreePath'],
      ['worktree_name', 'setupVarWorktreeName'],
      ['branch_name', 'setupVarBranchName'],
      ['base_ref', 'setupVarBaseRef'],
    ]

    /** Client-side mirror of assertSafeRelativePath (no node:path in a browser). */
    function pathError(value) {
      const raw = String(value ?? '').trim()
      if (raw !== '' && (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw))) return 'invalid'
      const parts = raw.split(/[\\/]+/)
      if (parts.some((part) => part === '..' || part === '.')) return 'invalid'
      if (raw !== '' && parts.some((part) => part === '')) return 'invalid'
      if (parts.some((part) => part.toLowerCase() === '.git')) return 'invalid'
      if (raw.includes('\0')) return 'invalid'
      return ''
    }

    function WorktreeSetup({ project, t, onSaved }) {
      const [paths, setPaths] = useState((project?.copyFiles ?? []).slice())
      const [postCreate, setPostCreate] = useState(project?.postCreate ?? '')
      const [timeoutMin, setTimeoutMin] = useState(String((project?.postCreateTimeoutMs ?? 300000) / 60000))
      const [advanced, setAdvanced] = useState(false)
      const [touched, setTouched] = useState(false)
      const [saving, setSaving] = useState(false)
      const [message, setMessage] = useState('')
      const [error, setError] = useState('')

      const dirty = paths.join('\n') !== (project?.copyFiles ?? []).join('\n')
        || postCreate !== (project?.postCreate ?? '')
        || timeoutMin !== String((project?.postCreateTimeoutMs ?? 300000) / 60000)
      const invalid = paths.some((value) => pathError(value) !== '')

      const small = { fontSize: 12, color: T.mutedInk, lineHeight: 1.6 }
      const box = { background: T.panel, border: `1px solid ${T.line}`, borderRadius: T.radiusLg, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }
      const inputStyle = { padding: '10px 12px', border: `1px solid ${T.line}`, borderRadius: T.radiusSm, background: T.card, color: T.ink, fontSize: 13, width: '100%', boxSizing: 'border-box' }
      const chip = { padding: '3px 8px', borderRadius: 12, border: `1px solid ${T.line}`, background: T.card, color: T.infoInk, fontSize: 12, cursor: 'pointer' }

      const save = async () => {
        setTouched(true)
        if (invalid) return
        setSaving(true); setError(''); setMessage('')
        try {
          await callApi('PATCH', `/projects/${encodeURIComponent(project.id)}`, {
            copyFiles: paths.map((v) => v.trim()).filter(Boolean),
            postCreate,
            postCreateTimeoutMs: Math.max(1, Number(timeoutMin) || 5) * 60000,
          })
          setMessage(t('setupSaved'))
          onSaved()
        } catch (err) { setError(err.message) } finally { setSaving(false) }
      }

      const rows = [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } }, [
          h('div', { key: 't', style: { fontSize: 13, fontWeight: 600, color: T.ink } }, t('setupTitle')),
          h('div', { key: 'p', style: small }, t('setupPurpose')),
        ]),
        h('div', { key: 'copyLabel', style: { fontSize: 13, color: T.ink, fontWeight: 500 } }, t('setupCopyLabel')),
        h('div', { key: 'copyHint', style: small }, t('setupCopyHint')),
        h('div', { key: 'copyEg', style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } }, [
          h('span', { key: 'lbl', style: small }, t('setupEg')),
          ...COPY_EXAMPLES.map((example) => h('button', {
            key: example, type: 'button', style: chip,
            onClick: () => setPaths([...paths, example]),
          }, example)),
        ]),
        paths.length === 0
          ? h('div', { key: 'copyEmpty', style: small }, t('setupCopyEmpty'))
          : h('div', { key: 'pathList', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            paths.map((value, index) => {
              const bad = touched && pathError(value) !== ''
              return h('div', { key: index, style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } }, [
                h('input', {
                  key: 'in', value, placeholder: COPY_EXAMPLES[index % COPY_EXAMPLES.length],
                  style: { ...inputStyle, flex: '1 1 220px', border: `1px solid ${bad ? T.danger : T.line}` },
                  onChange: (event) => setPaths(paths.map((v, i) => i === index ? event.target.value : v)),
                  onBlur: () => setTouched(true),
                }),
                h('button', { key: 'rm', type: 'button', style: { ...chip, color: T.mutedInk }, onClick: () => setPaths(paths.filter((_, i) => i !== index)) }, t('setupRemove')),
                bad ? h('div', { key: 'err', style: { ...small, color: T.dangerInk, flexBasis: '100%' } }, t('setupPathInvalid')) : null,
              ].filter(Boolean))
            })),
        h('button', { key: 'add', type: 'button', style: { ...chip, alignSelf: 'flex-start' }, onClick: () => setPaths([...paths, '']) }, t('setupAddPath')),
        h('div', { key: 'postLabel', style: { fontSize: 13, color: T.ink, fontWeight: 500 } }, t('setupPostLabel')),
        h('div', { key: 'postHint', style: small }, t('setupPostHint')),
        h('div', { key: 'risk', style: { ...small, color: T.warningInk } }, `${t('setupRisk')} · ${t('setupFollowRepo')}`),
        h('div', { key: 'localHint', style: small }, t('setupLocalFilesHint')),
        h('div', { key: 'postEg', style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } }, [
          h('span', { key: 'lbl', style: small }, t('setupEg')),
          ...POST_EXAMPLES.map((example) => h('button', {
            key: example, type: 'button', style: chip,
            onClick: () => setPostCreate(postCreate ? `${postCreate}\n${example}` : example),
          }, example)),
        ]),
        h('textarea', {
          key: 'post', value: postCreate, rows: 3, placeholder: t('setupPostEmpty'),
          style: { ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', resize: 'vertical' },
          onChange: (event) => setPostCreate(event.target.value),
        }),
        h('div', { key: 'varsTitle', style: { fontSize: 12, fontWeight: 600, color: T.ink } }, t('setupVarsTitle')),
        h('div', { key: 'vars', style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px', ...small } },
          VARIABLE_ROWS.flatMap(([name, key]) => [
            h('code', { key: `${name}-k`, style: { color: T.infoInk } }, name),
            h('span', { key: `${name}-v` }, t(key)),
          ])),
        h('div', { key: 'varsEnv', style: small }, t('setupVarsEnv')),
        h('button', { key: 'adv', type: 'button', style: { ...chip, alignSelf: 'flex-start' }, onClick: () => setAdvanced(!advanced) }, t('setupAdvanced')),
        advanced ? h('div', { key: 'advBox', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h('label', { key: 'lbl', style: small }, t('setupTimeout')),
          h('input', { key: 'num', type: 'number', min: 1, value: timeoutMin, style: { ...inputStyle, width: 90 }, onChange: (event) => setTimeoutMin(event.target.value) }),
          h('span', { key: 'hint', style: small }, t('setupTimeoutHint')),
        ]) : null,
        h('div', { key: 'saveRow', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h(Button, { key: 'save', disabled: saving || invalid || !dirty, onClick: () => void save() }, saving ? t('setupSaving') : t('setupSave')),
          message ? h('span', { key: 'ok', style: { ...small, color: T.success } }, message) : null,
          error ? h('span', { key: 'err', style: { ...small, color: T.dangerInk } }, `${t('errorPrefix')}${error}`) : null,
          touched && invalid ? h('span', { key: 'inv', style: { ...small, color: T.dangerInk } }, t('setupPathInvalid')) : null,
        ]),
      ]

      return h('div', { key: 'worktreeSetup', style: box }, rows)
    }

    // Global "worktrees root": one collapsible bar at the top of the page. Its
    // value is the raw saved string (blank = built-in default); the resolved
    // absolute path is read back from the backend and shown read-only. Saving
    // only affects worktrees created from now on — existing projects/cards keep
    // the root frozen onto them at creation (server-side), so nothing is moved.
    function WorktreesRootSetting({ t }) {
      const [value, setValue] = useState('')
      const [resolved, setResolved] = useState('')
      const [saving, setSaving] = useState(false)
      const [message, setMessage] = useState('')
      const [error, setError] = useState('')

      useEffect(() => {
        let live = true
        callApi('GET', '/settings').then((data) => {
          if (!live) return
          setValue(data?.settings?.worktreeRoot ?? '')
          setResolved(data?.settings?.resolved ?? '')
        }).catch((err) => { if (live) setError(err.message) })
        return () => { live = false }
      }, [])

      const save = async () => {
        setSaving(true); setError(''); setMessage('')
        try {
          const data = await callApi('PATCH', '/settings', { worktreeRoot: value })
          setValue(data?.settings?.worktreeRoot ?? '')
          setResolved(data?.settings?.resolved ?? '')
          setMessage(t('setupSaved'))
        } catch (err) { setError(err.message) } finally { setSaving(false) }
      }

      const small = { fontSize: 12, color: T.mutedInk, lineHeight: 1.6 }
      const inputStyle = { padding: '10px 12px', border: `1px solid ${T.line}`, borderRadius: T.radiusSm, background: T.card, color: T.ink, fontSize: 13, width: '100%', boxSizing: 'border-box' }
      return h('div', { key: 'wtRoot', style: { background: T.panel, border: `1px solid ${T.line}`, borderRadius: T.radiusLg, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 } }, [
        h('div', { key: 'label', style: { fontSize: 13, color: T.ink, fontWeight: 500 } }, t('wtRootLabel')),
        h('div', { key: 'purpose', style: small }, t('wtRootPurpose')),
        h('input', {
          key: 'input', value, placeholder: t('wtRootPlaceholder'), spellCheck: false,
          style: inputStyle, onChange: (event) => setValue(event.target.value),
        }),
        h('div', { key: 'hint', style: small }, t('wtRootHint')),
        h('div', { key: 'resolved', style: { ...small, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, t('wtRootResolved', { path: resolved || '—' })),
        h('div', { key: 'scope', style: small }, t('wtRootScope')),
        h('div', { key: 'danger', style: { ...small, color: T.warningInk } }, t('wtRootDanger')),
        h('div', { key: 'saveRow', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h(Button, { key: 'save', disabled: saving, onClick: () => void save() }, saving ? t('setupSaving') : t('setupSave')),
          message ? h('span', { key: 'ok', style: { ...small, color: T.success } }, message) : null,
          error ? h('span', { key: 'err', style: { ...small, color: T.dangerInk } }, `${t('errorPrefix')}${error}`) : null,
        ].filter(Boolean)),
      ])
    }

    // ---- P4 · autonomy & runtime -----------------------------------------
    // The FIRST hard line: the status badge is derived ONLY from the `autonomy`
    // field, never from autoStart/autoApprove. "level back to manual while a
    // switch is still on" is a legal stored combination; reading switches would
    // show "running automatically" when the engine is actually idle (P4-2).
    const LEVELS = ['L0', 'L1', 'L2']
    const LEVEL_BADGE = { L0: 'badgeL0', L1: 'badgeL1', L2: 'badgeL2' }

    function Modal({ title, tone, children, onCancel, onConfirm, confirmLabel, confirmTone, busy, t }) {
      return h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(18,24,32,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 18 } }, [
        h('div', {
          className: 'df-modal',
          style: { background: T.card, borderRadius: 14, width: '100%', maxWidth: 480, boxShadow: '0 24px 70px rgba(10,16,24,.28)', overflow: 'hidden' },
        }, [
          h('div', { style: { padding: '16px 18px 12px', borderBottom: `1px solid ${T.line}` } },
            h('h3', { style: { margin: 0, fontSize: 16, fontWeight: 650, color: tone === 'danger' ? T.dangerInk : T.ink } }, title)),
          h('div', { style: { padding: '14px 18px', fontSize: 13, color: T.mutedInk, lineHeight: 1.7 } }, children),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: `1px solid ${T.line}`, background: T.panel } }, [
            h(Button, { key: 'cancel', onClick: onCancel, disabled: busy }, h('span', { className: 'df-tap' }, t('cancel'))),
            h(Button, {
              key: 'ok', disabled: busy,
              onClick: onConfirm,
              style: confirmTone === 'danger'
                ? { background: T.danger, borderColor: T.danger, color: '#fff' }
                : { background: T.info, borderColor: T.info, color: '#fff' },
            }, h('span', { className: 'df-tap' }, confirmLabel)),
          ]),
        ]),
      ])
    }

    function AutonomySection({ project, t, onSaved }) {
      // `savedLevel` is what the backend stored; `level` is the pending choice.
      // Clicking a segment changes ONLY the pending value + explainer card; the
      // badge keeps showing the saved level until Save commits (P4-1b).
      const savedLevel = project?.autonomy ?? 'L0'
      const [level, setLevel] = useState(savedLevel)
      const [autoStart, setAutoStart] = useState(project?.autoStart === true)
      const [autoApprove, setAutoApprove] = useState(project?.autoApprove === true)
      const [prefsOpen, setPrefsOpen] = useState(false)
      const [l2Confirm, setL2Confirm] = useState(false)
      const [saving, setSaving] = useState(false)
      const [message, setMessage] = useState('')
      const [error, setError] = useState('')

      // Switching projects remounts this component (key=project.id at the call
      // site), so these useState initialisers re-run on the newly saved values —
      // no "sidebar L0, drawer L1" contradiction.
      const dirty = level !== savedLevel
      // L0 suppresses both switches; L1 ignores autoApprove (engine reads it only
      // at L2). Values are retained, just shown as unused at the pending level.
      const inactiveStart = level === 'L0'
      const inactiveApprove = level === 'L0' || level === 'L1'

      const chooseLevel = (next) => {
        if (next === 'L2' && level !== 'L2') { setL2Confirm(true); return }
        setLevel(next)
      }
      const confirmL2 = () => { setL2Confirm(false); setLevel('L2') }

      const save = async () => {
        setSaving(true); setError(''); setMessage('')
        try {
          const data = await callApi('PATCH', `/projects/${encodeURIComponent(project.id)}`, {
            autonomy: level, autoStart, autoApprove,
          })
          // Silent-normalisation read-back: adopt the ACTUAL stored values from
          // the backend, never the form's originals (P4-3). After save the badge
          // and the pending choice converge on the same read-back value.
          const p = data.project
          setLevel(p.autonomy)
          setAutoStart(p.autoStart === true)
          setAutoApprove(p.autoApprove === true)
          setMessage(t('setupSaved'))
          onSaved()
        } catch (err) { setError(err.message) } finally { setSaving(false) }
      }

      const small = { fontSize: 12, color: T.mutedInk, lineHeight: 1.6 }
      // Selected segment uses a soft brand wash + coloured label (Design #1):
      // L0 grey, L1 blue, L2 orange — never a solid blue fill.
      const segTone = { L0: [T.grayWash, T.gray], L1: [T.blueWash, T.blue], L2: [T.orangeWash, T.orange] }
      const segBtn = (lv) => {
        const on = level === lv
        const [wash, ink] = segTone[lv]
        return {
          padding: '7px 12px', borderRadius: T.radiusSm, border: `1px solid ${on ? ink : T.line}`,
          background: on ? wash : T.card,
          color: on ? ink : T.ink, fontSize: 12, fontWeight: 600, cursor: 'pointer', minHeight: 44,
        }
      }
      const switchRow = (checked, onChange, label, inactive) => h('div', { className: 'df-switch-row', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '6px 0' } }, [
        // 44px transparent hit area around a 38×22 visual track: meets the tap
        // target rule without inflating the switch graphic.
        h('button', {
          type: 'button', role: 'switch', 'aria-checked': checked ? 'true' : 'false',
          onClick: () => onChange(!checked),
          style: { minWidth: 44, minHeight: 44, border: 'none', padding: 0, background: 'transparent', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' },
        }, h('span', {
          style: { position: 'relative', width: 38, height: 22, borderRadius: 999, display: 'inline-block', background: checked ? T.info : T.line },
        }, h('span', {
          style: { position: 'absolute', top: 3, left: checked ? 19 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left .16s', boxShadow: '0 1px 3px rgba(0,0,0,.2)' },
        }))),
        h('span', { style: { ...small, color: inactive ? T.mutedInk : T.ink, fontWeight: 600 } }, t(label)),
        inactive ? h('span', { style: { fontSize: 10.5, color: T.mutedInk, background: T.panel, borderRadius: 5, padding: '2px 7px' } }, t('inactiveAtLevel')) : null,
      ])

      // Explain card: two fixed lines — "machine does / you do" — that follow the
      // PENDING choice so a first-time reader can tell what each level means.
      const explainer = h('div', {
        key: 'explain',
        style: { background: T.accentWash, border: `1px solid ${T.line}`, borderLeft: `3px solid ${T.accent}`, borderRadius: T.radiusLg, padding: '10px 12px', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 },
      }, [
        h('div', { key: 'h', style: { fontSize: 13, fontWeight: 700, color: T.accentInk } }, t(`lv${level}`)),
        h('div', { key: 'm', style: small }, `${t('leMachine')}：${t(`le${level}M`)}`),
        h('div', { key: 'y', style: small }, `${t('leYou')}：${t(`le${level}Y`)}`),
      ])

      const children = [
        h('div', { key: 'seg', style: { display: 'inline-flex', gap: 4, flexWrap: 'wrap' } },
          LEVELS.map((lv) => h('button', { key: lv, type: 'button', style: segBtn(lv), onClick: () => chooseLevel(lv) }, h('span', { className: 'df-tap' }, t(`lv${lv}`))))),
        // Badge reflects the SAVED level only — never the pending choice, never
        // the two switches (P4-2 first hard line).
        h('div', { key: 'badgeRow', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 } }, [
          h('span', {
            key: 'badge',
            style: { display: 'inline-flex', gap: 7, alignItems: 'center', padding: '5px 12px', borderRadius: 999, fontSize: 12, fontWeight: 650,
              background: savedLevel === 'L2' ? T.orangeWash : savedLevel === 'L1' ? T.blueWash : T.grayWash,
              color: savedLevel === 'L2' ? T.orange : savedLevel === 'L1' ? T.blue : T.gray },
          }, [h('span', { key: 'dot', style: { width: 7, height: 7, borderRadius: '50%', background: 'currentColor' } }), t(LEVEL_BADGE[savedLevel])]),
          project?.paused === true
            ? h('span', { key: 'paused', style: { display: 'inline-flex', gap: 6, alignItems: 'center', padding: '5px 12px', borderRadius: 999, fontSize: 12, fontWeight: 650, background: T.panel, color: T.mutedInk } },
              [h('span', { key: 'dot', style: { width: 7, height: 7, borderRadius: '50%', background: 'currentColor' } }), t('badgePaused')])
            : null,
          // The badge block ends with the unsaved marker; it shows only the saved
          // level, never the preference switches below.
          dirty ? h('span', { key: 'rb', style: { fontSize: 11, color: T.warningInk, fontWeight: 600 } }, t('unsaved')) : null,
        ]),
        explainer,
        h('button', {
          key: 'prefToggle', type: 'button',
          style: { background: 'transparent', border: 'none', color: T.mutedInk, fontSize: 12, cursor: 'pointer', textAlign: 'left', padding: '10px 0 0', minHeight: 44 },
          onClick: () => setPrefsOpen(!prefsOpen),
        }, `${prefsOpen ? '▾' : '▸'} ${t('prefHead')}`),
        prefsOpen ? h('div', { key: 'prefs', style: { display: 'flex', flexDirection: 'column', gap: 2 } }, [
          switchRow(autoStart, setAutoStart, 'autoStart', inactiveStart),
          switchRow(autoApprove, setAutoApprove, 'autoApprove', inactiveApprove),
          h('div', { key: 'note', style: small }, t('prefNote')),
        ]) : null,
        h('div', { key: 'save', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 } }, [
          h('span', { key: 'btn', className: 'df-tap' }, h(Button, { disabled: saving, onClick: () => void save() }, saving ? t('setupSaving') : t('saveLevel'))),
          message ? h('span', { key: 'ok', style: { ...small, color: T.success } }, message) : null,
          error ? h('span', { key: 'err', style: { ...small, color: T.dangerInk, whiteSpace: 'pre-line' } }, `${t('errorPrefix')}${error}`) : null,
        ]),
      ]
      if (l2Confirm) {
        children.push(h(Modal, {
          key: 'l2m', title: t('l2Title'), confirmLabel: t('enableL2'), busy: false, t,
          onCancel: () => setL2Confirm(false), onConfirm: confirmL2,
        }, t('l2Body')))
      }
      return h('div', { key: 'autonomy', style: { borderTop: `1px solid ${T.line}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 2 } }, children)
    }

    function PauseSection({ project, t, onSaved, onTakeoverCard }) {
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')
      const paused = project?.paused === true
      const toggle = async () => {
        setSaving(true); setError(''); setMessage('')
        try {
          await callApi('POST', `/projects/${encodeURIComponent(project.id)}/${paused ? 'resume' : 'pause'}`)
          setMessage(t('setupSaved')); onSaved()
        } catch (err) { setError(err.message) } finally { setSaving(false) }
      }
      const small = { fontSize: 12, color: T.mutedInk, lineHeight: 1.6 }
      return h('div', { key: 'pause', style: { borderTop: `1px solid ${T.line}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 } }, [
        h('div', { key: 'sw', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
          h('button', {
            key: 't', type: 'button', role: 'switch', 'aria-checked': paused ? 'true' : 'false',
            disabled: saving, onClick: () => void toggle(),
            style: { minWidth: 44, minHeight: 44, border: 'none', padding: 0, background: 'transparent', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' },
          }, h('span', {
            style: { position: 'relative', width: 38, height: 22, borderRadius: 999, display: 'inline-block', background: paused ? T.warning : T.line },
          }, h('span', { style: { position: 'absolute', top: 3, left: paused ? 19 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left .16s', boxShadow: '0 1px 3px rgba(0,0,0,.2)' } }))),
          h('span', { key: 'l', style: { ...small, color: T.ink, fontWeight: 600 } }, t('projPause')),
          h('span', { key: 'b', className: 'df-tap' }, h(Button, { disabled: saving, onClick: () => void toggle() }, paused ? t('resumeProject') : t('pauseProject'))),
        ]),
        h('div', { key: 'sem', style: small }, t('pauseSem')),
        h('div', { key: 'takeHint', style: small }, t('takeover') + ' · ' + t('pauseSub')),
        message ? h('div', { key: 'ok', style: { ...small, color: T.success } }, message) : null,
        error ? h('div', { key: 'err', style: { ...small, color: T.dangerInk } }, `${t('errorPrefix')}${error}`) : null,
      ])
    }

    // P4-github · global "connection app ID" (non-secret client_id). Lives in
    // settings, not a credential; the UI labels it GitHub OAuth App · Client ID.
    function AppIdSetting({ t, settings, onSaved }) {
      const [value, setValue] = useState(settings?.githubClientId ?? '')
      const [saving, setSaving] = useState(false)
      const [message, setMessage] = useState('')
      const [error, setError] = useState('')
      useEffect(() => { setValue(settings?.githubClientId ?? '') }, [settings?.githubClientId])

      const save = async () => {
        setSaving(true); setError(''); setMessage('')
        try {
          const data = await callApi('PATCH', '/settings', { githubClientId: value })
          setValue(data?.settings?.githubClientId ?? '')
          setMessage(t('ghSaved'))
          if (typeof onSaved === 'function') onSaved()
        } catch (err) { setError(err.message) } finally { setSaving(false) }
      }
      const small = { fontSize: 12, color: T.mutedInk, lineHeight: 1.6 }
      const inputStyle = { padding: '10px 12px', border: `1px solid ${T.line}`, borderRadius: T.radiusSm, background: T.card, color: T.ink, fontSize: 13, width: '100%', boxSizing: 'border-box' }
      return h('div', { key: 'appId', style: { background: T.card, border: `1px solid ${T.line}`, borderRadius: T.radiusLg, padding: 12, marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 } }, [
        h('div', { key: 'label', style: { fontSize: 13, color: T.ink, fontWeight: 600 } }, t('ghAppIdLabel')),
        h('div', { key: 'hint', style: small }, t('ghAppIdHint')),
        h('input', {
          key: 'input', value, spellCheck: false, onChange: (event) => setValue(event.target.value),
          placeholder: t('ghAppIdLabel'), style: inputStyle,
        }),
        h('div', { key: 'row', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h(Button, { key: 'save', disabled: saving, onClick: () => void save() }, saving ? t('setupSaving') : t('ghSaveAppId')),
          message ? h('span', { key: 'ok', style: { ...small, color: T.success } }, message) : null,
          error ? h('span', { key: 'err', style: { ...small, color: T.dangerInk } }, `${t('errorPrefix')}${error}`) : null,
        ].filter(Boolean)),
      ])
    }

    // P4-github increment · GLOBAL account management (Design §7). OAuth
    // connect/reconnect/disconnect + gh CLI status. All machine-level, NOT tied
    // to a project — the per-repo identity card stays project-scoped (PGH-20/21).
    function AccountManager({ t, onChanged }) {
      const [oauth, setOauth] = useState(null) // { connected, inFlight, hasAppId }
      const [ghcli, setGhcli] = useState(null) // { loggedIn, login }
      const [error, setError] = useState('')
      const [revokeUrl, setRevokeUrl] = useState('')
      const [disconnected, setDisconnected] = useState(false)
      const [busy, setBusy] = useState(false)
      // shared connect bridge state (reconnect = disconnect + this flow)
      const [sessionId, setSessionId] = useState('')
      const [connecting, setConnecting] = useState(false)
      const [notice, setNotice] = useState(null)
      const [pendingPrompt, setPendingPrompt] = useState(false)
      const [step, setStep] = useState('')

      const load = useCallback(async () => {
        setError('')
        try {
          const [o, g] = await Promise.all([
            callApi('GET', '/auth/oauth/state'),
            callApi('GET', '/auth/ghcli/state'),
          ])
          setOauth(o); setGhcli(g)
        } catch (err) { setError(err.message) }
      }, [])
      useEffect(() => { void load() }, [load])

      // Poll an in-flight connect session (same bridge the identity card uses).
      useEffect(() => {
        if (sessionId === '') return undefined
        let active = true
        let timer = null
        const poll = async () => {
          try {
            const view = await callApi('GET', `/auth/connect/${encodeURIComponent(sessionId)}`)
            if (!active) return
            if (view.notices && view.notices.length) {
              const last = view.notices[view.notices.length - 1]
              setNotice(last)
              if (last.code) setStep('code'); else if (last.url) setStep('open')
            }
            setPendingPrompt(view.status === 'running' && !!view.prompt)
            if (view.status === 'authorized') {
              setConnecting(false); setSessionId(''); setDisconnected(false); setRevokeUrl('')
              await load(); if (typeof onChanged === 'function') onChanged()
            }
            if (view.status === 'failed' || view.status === 'cancelled') {
              setConnecting(false); setSessionId(''); setError(view.error || t('ghPermBad'))
            }
            if (view.status === 'running' || view.status === 'pending') timer = setTimeout(poll, 2000)
          } catch (err) { if (active) setError(err.message) }
        }
        void poll()
        return () => { active = false; if (timer) clearTimeout(timer) }
      }, [sessionId, load, onChanged, t])

      const beginConnect = async () => {
        setError(''); setBusy(true)
        try {
          const result = await callApi('POST', '/auth/connect/begin', {})
          setDisconnected(false); setRevokeUrl(''); setNotice(null); setPendingPrompt(false)
          setConnecting(true); setSessionId(result.sessionId); setStep('open')
        } catch (err) { setError(err.message) } finally { setBusy(false) }
      }

      const reconnect = async () => {
        // Reset = local disconnect first, then re-run the connect flow.
        setError(''); setBusy(true)
        try {
          const d = await callApi('POST', '/auth/oauth/disconnect', {})
          setBusy(false)
          if (d?.revokeUrl) setRevokeUrl(d.revokeUrl)
          await beginConnect()
        } catch (err) { setError(err.message); setBusy(false) }
      }

      const disconnect = async () => {
        setError(''); setBusy(true)
        try {
          const d = await callApi('POST', '/auth/oauth/disconnect', {})
          setDisconnected(true); setRevokeUrl(d?.revokeUrl || '')
          await load(); if (typeof onChanged === 'function') onChanged()
        } catch (err) { setError(err.message) } finally { setBusy(false) }
      }

      const answer = async (value) => {
        setError(''); setBusy(true)
        try { await callApi('POST', `/auth/connect/${encodeURIComponent(sessionId)}/answer`, { value }); setPendingPrompt(false); setStep('connecting') }
        catch (err) { setError(err.message) } finally { setBusy(false) }
      }
      const cancel = async () => {
        try { await callApi('POST', `/auth/connect/${encodeURIComponent(sessionId)}/cancel`, {}) } catch { /* best effort */ }
        setConnecting(false); setSessionId(''); setPendingPrompt(false)
      }

      const small = { fontSize: 12, color: T.mutedInk, lineHeight: 1.6 }
      const connected = oauth?.connected === true
      const inFlight = oauth?.inFlight === true || connecting
      const stateText = connected ? t('ghStateOn') : t('ghStateOff')

      return h('div', { key: 'acctMgr', style: { background: T.card, border: `1px solid ${T.line}`, borderRadius: T.radiusLg, padding: 12, marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 } }, [
        // OAuth connection block
        h('div', { key: 'oauth', style: { display: 'flex', flexDirection: 'column', gap: 7 } }, [
          h('div', { key: 'st', style: { fontSize: 13, fontWeight: 600, color: T.ink } }, t('ghConnectState', { state: stateText })),
          h('div', { key: 'ops', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
            !connected && !inFlight ? h('span', { key: 'c', className: 'df-tap' }, h(Button, {
              disabled: busy || !oauth?.hasAppId,
              onClick: () => void beginConnect(),
            }, t('ghConnect'))) : null,
            connected && !inFlight ? h('span', { key: 'r', className: 'df-tap' }, h(Button, { disabled: busy, onClick: () => void reconnect() }, t('ghReconnect'))) : null,
            connected && !inFlight ? h('span', { key: 'd', className: 'df-tap' }, h(Button, { disabled: busy, onClick: () => void disconnect() }, t('ghDisconnect'))) : null,
          ]),
          !oauth?.hasAppId ? h('div', { key: 'noapp', style: small }, t('ghAppIdHint')) : null,
          // Honest disconnect result + website revoke guidance (PGH-19)
          disconnected ? h('div', { key: 'disc', style: { ...small, color: T.success, background: T.accentWash, borderRadius: T.radiusSm, padding: '7px 9px' } }, [
            h('div', { key: 'd1' }, t('ghDisconnectDone')),
            h('div', { key: 'd2', style: { marginTop: 4 } }, t('ghRevokeGuide')),
            revokeUrl ? h('a', { key: 'd3', href: revokeUrl, target: '_blank', rel: 'noreferrer', style: { display: 'inline-block', marginTop: 5, color: T.accent } }, t('ghRevokeLink')) : null,
          ]) : null,
          // In-flight connect: three steps + keep-open note, one-at-a-time guard
          connecting ? h('div', { key: 'conn', style: { ...small, background: T.panel, borderRadius: T.radiusSm, padding: '7px 9px' } }, [
            h('div', { key: 'keep', style: { color: T.warningInk } }, t('ghKeepOpen')),
            h('div', { key: 'one', style: { marginTop: 3 } }, t('ghOneAtATime')),
            h('div', { key: 's', style: { marginTop: 3, color: T.ink } },
              step === 'code' || step === 'connecting' ? t('ghStepCode') : t('ghStepOpen')),
            notice?.url ? h('a', { key: 'url', href: notice.url, target: '_blank', rel: 'noreferrer', style: { display: 'inline-block', marginTop: 4, color: T.accent } }, t('ghStepOpen')) : null,
            notice?.code ? h('div', { key: 'code', style: { marginTop: 5, fontSize: 19, fontWeight: 700, letterSpacing: 2, fontFamily: 'ui-monospace, monospace', color: T.ink } }, notice.code) : null,
            pendingPrompt ? h('span', { key: 'go', className: 'df-tap' }, h(Button, { disabled: busy, onClick: () => void answer('done') }, t('ghStepDone'))) : null,
            step === 'connecting' ? h('div', { key: 'wait', style: { marginTop: 4 } }, t('ghStepConnecting')) : null,
            h('span', { key: 'cx', className: 'df-tap' }, h(Button, { disabled: busy, onClick: () => void cancel(), style: { marginTop: 6, padding: '4px 9px' } }, t('cancel'))),
          ]) : null,
          error ? h('div', { key: 'err', style: { ...small, color: T.dangerInk, whiteSpace: 'pre-line' } }, `${t('errorPrefix')}${error}`) : null,
        ]),
        // gh CLI status — shown whether logged in or not (PGH-21), read-only
        h('div', { key: 'ghcli', style: { borderTop: `1px solid ${T.line}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 5 } }, [
          h('div', { key: 'title', style: { fontSize: 12.5, fontWeight: 600, color: T.ink } }, t('ghComputerLoginTitle')),
          h('div', { key: 'st', style: small }, ghcli === null
            ? t('ghChecking')
            : (ghcli.loggedIn
              ? `${t('ghComputerLoggedIn')}${ghcli.login ? ` · ${ghcli.login}` : ''}`
              : t('ghComputerLoggedOut'))),
          ghcli !== null && !ghcli.loggedIn ? h('div', { key: 'guide', style: { ...small, color: T.warningInk } }, t('ghComputerLoginGuide')) : null,
        ]),
      ])
    }

    function GlobalCapSection({ t, settings, onSaved }) {
      const raw = settings?.globalMaxActive
      const [value, setValue] = useState(raw === null || raw === undefined ? '' : String(raw))
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')
      const save = async () => {
        setError(''); setMessage('')
        const trimmed = String(value).trim()
        const parsed = trimmed === '' ? null : Number(trimmed)
        if (parsed !== null && (!Number.isInteger(parsed) || parsed < 1)) { setError(t('gmInvalid')); return }
        setSaving(true)
        try {
          const data = await callApi('PATCH', '/settings', { globalMaxActive: parsed })
          const next = data.settings.globalMaxActive
          setValue(next === null || next === undefined ? '' : String(next))
          setMessage(t('setupSaved')); onSaved()
        } catch (err) { setError(err.message) } finally { setSaving(false) }
      }
      const small = { fontSize: 12, color: T.mutedInk, lineHeight: 1.6 }
      const eff = settings?.effectiveGlobalMaxActive
      return h('div', { key: 'globalCap', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
        h('div', { key: 'label', style: { fontSize: 13, color: T.ink, fontWeight: 500 } }, t('globMaxLabel')),
        h('input', {
          key: 'in', inputMode: 'numeric', value, spellCheck: false, placeholder: t('blankDefault'),
          style: { padding: '6px 8px', border: `1px solid ${T.line}`, borderRadius: T.radiusSm, background: T.card, color: T.ink, fontSize: 13, width: '100%', boxSizing: 'border-box' },
          onChange: (e) => setValue(e.target.value),
        }),
        h('div', { key: 'help', style: small }, t('globHelp')),
        eff ? h('div', { key: 'eff', style: { ...small, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } },
          `${t('effLabel')}: ${eff.value} · ${t('src' + (eff.source === 'settings' ? 'Settings' : eff.source === 'config' ? 'Config' : 'Default'))}`) : null,
        h('div', { key: 'save', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h('span', { key: 'btn', className: 'df-tap' }, h(Button, { disabled: saving, onClick: () => void save() }, saving ? t('setupSaving') : t('saveGlobal'))),
          message ? h('span', { key: 'ok', style: { ...small, color: T.success } }, message) : null,
          error ? h('span', { key: 'err', style: { ...small, color: T.dangerInk } }, `${t('errorPrefix')}${error}`) : null,
        ]),
      ])
    }

    function ConcurrencySection({ project, settings, t, onSaved }) {
      const raw = project?.maxActiveSessions
      const [value, setValue] = useState(raw === null || raw === undefined ? '' : String(raw))
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')
      const save = async () => {
        setError(''); setMessage('')
        const trimmed = String(value).trim()
        const parsed = trimmed === '' ? null : Number(trimmed)
        if (parsed !== null && (!Number.isInteger(parsed) || parsed < 1)) { setError(t('pmInvalid')); return }
        setSaving(true)
        try {
          const data = await callApi('PATCH', `/projects/${encodeURIComponent(project.id)}`, { maxActiveSessions: parsed })
          const next = data.project.maxActiveSessions
          setValue(next === null || next === undefined ? '' : String(next))
          setMessage(t('setupSaved')); onSaved()
        } catch (err) { setError(err.message) } finally { setSaving(false) }
      }
      const small = { fontSize: 12, color: T.mutedInk, lineHeight: 1.6 }
      const global = settings?.effectiveGlobalMaxActive
      const projectDefault = settings?.projectDefaultMaxActive
      // Effective slots = min(project value, effective global cap). Project value
      // falls back to the launch-config default; neither number is hard-coded here.
      const projectEffective = project?.maxActiveSessions > 0 ? project.maxActiveSessions : (projectDefault ?? null)
      const globalValue = global?.value ?? null
      const effective = projectEffective !== null && globalValue !== null ? Math.min(projectEffective, globalValue) : (projectEffective ?? globalValue)
      const globalSrc = t('src' + (global?.source === 'settings' ? 'Settings' : global?.source === 'config' ? 'Config' : 'Default'))
      return h('div', { key: 'conc', style: { borderTop: `1px solid ${T.line}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 } }, [
        h('div', { key: 'label', style: { fontSize: 13, color: T.ink, fontWeight: 500 } }, t('projMaxLabel')),
        h('input', {
          key: 'in', inputMode: 'numeric', value, spellCheck: false, placeholder: t('blankDefault'),
          style: { padding: '6px 8px', border: `1px solid ${T.line}`, borderRadius: T.radiusSm, background: T.card, color: T.ink, fontSize: 13, width: '100%', boxSizing: 'border-box' },
          onChange: (e) => setValue(e.target.value),
        }),
        h('div', { key: 'help', style: small }, t('blankDefault')),
        h('div', { key: 'eff', style: { ...small, background: T.panel, border: `1px solid ${T.line}`, borderRadius: T.radiusSm, padding: '10px 12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, [
          h('div', { key: 'v' }, `${t('effLabel')}: ${effective ?? '—'}`),
          h('div', { key: 's', style: { opacity: .85 } }, t('effSrc', { src: globalSrc })),
        ]),
        h('div', { key: 'save', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h('span', { key: 'btn', className: 'df-tap' }, h(Button, { disabled: saving, onClick: () => void save() }, saving ? t('setupSaving') : t('saveConc'))),
          message ? h('span', { key: 'ok', style: { ...small, color: T.success } }, message) : null,
          error ? h('span', { key: 'err', style: { ...small, color: T.dangerInk } }, `${t('errorPrefix')}${error}`) : null,
        ]),
      ])
    }

    function DangerSection({ project, t, onDeleted }) {
      const [confirm, setConfirm] = useState(false)
      const [typed, setTyped] = useState('')
      const [force, setForce] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const small = { fontSize: 12, color: T.mutedInk, lineHeight: 1.6 }
      const doDelete = async () => {
        setError('')
        if (typed.trim() !== project.name) { setError(t('delWrong')); return }
        setBusy(true)
        try {
          await callApi('DELETE', `/projects/${encodeURIComponent(project.id)}`, { force })
          setConfirm(false); onDeleted()
        } catch (err) { setError(err.message) } finally { setBusy(false) }
      }
      return h('div', { key: 'danger', style: { borderTop: `1px solid ${T.line}`, paddingTop: 12 } }, [
        h('div', { key: 'row', style: { display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' } }, [
          h('span', { key: 'hint', style: { ...small, maxWidth: 320 } }, t('deleteHint')),
          h('span', { key: 'btn', className: 'df-tap' }, h(Button, {
            disabled: busy, onClick: () => { setTyped(''); setForce(false); setError(''); setConfirm(true) },
            style: { borderColor: T.danger, color: T.dangerInk },
          }, t('deleteProject'))),
        ]),
        confirm ? h(Modal, {
          key: 'delm', title: t('delTitle'), tone: 'danger', confirmLabel: t('delConfirm'), confirmTone: 'danger', busy, t,
          onCancel: () => setConfirm(false), onConfirm: () => void doDelete(),
        }, [
          h('p', { key: 'body', style: { margin: '0 0 11px' } }, t('delBody')),
          h('label', { key: 'lbl', style: { display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5 } }, t('delType', { name: project.name })),
          h('input', {
            key: 'name', className: 'input mono', value: typed, spellCheck: false, placeholder: project.name,
            style: { padding: '7px 9px', border: `1px solid ${T.line}`, borderRadius: T.radiusSm, background: T.card, color: T.ink, fontSize: 13, width: '100%', boxSizing: 'border-box' },
            onChange: (e) => setTyped(e.target.value),
          }),
          h('label', { key: 'force', style: { display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 12, cursor: 'pointer' } }, [
            h('input', { key: 'cb', type: 'checkbox', checked: force, onChange: (e) => setForce(e.target.checked), style: { marginTop: 3 } }),
            h('span', { key: 'ft' }, [
              h('b', { key: 'h', style: { color: T.dangerInk } }, t('forceHead')),
              h('br', { key: 'br' }), t('forceBody'),
            ]),
          ]),
          error ? h('div', { key: 'err', style: { ...small, color: T.dangerInk, marginTop: 10 } }, `${t('errorPrefix')}${error}`) : null,
        ]) : null,
      ])
    }

    // Source id → user-facing copy (Design §2). Only the panel column is shown;
    // internal ids never leak to the UI. 'none' means not connected.
    const SRC_LABEL = {
      'oauth-global': 'srcConnected',
      'gh-cli': 'srcComputer',
      'env-token': 'srcSystem',
      'token-global': 'srcAddedShared',
      'repo-key': 'srcThisRepo',
      none: 'srcNone',
    }

    // P4-github · project GitHub identity card (Design §1–§5). Answers four
    // questions: where this repo is linked, who it currently uses, whether that
    // works, and what to do if not. All copy is plain words (PGH-13); the token
    // itself is never fetched/echoed — identityCardFor strips it Host-side.
    function IdentityCard({ project, t, onChanged }) {
      const [card, setCard] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [perm, setPerm] = useState(null) // 'ok' | 'insufficient' | 'not-connected'
      const [permReason, setPermReason] = useState('')
      const [checking, setChecking] = useState(false)
      const [expanded, setExpanded] = useState(false)
      const [dialog, setDialog] = useState('') // '' | 'add' | 'connect'
      const [busy, setBusy] = useState(false)

      // Add-account dialog state. The scope switch exists ONLY in this dialog and
      // ONLY for a user-supplied credential — never for connected/CLI tiers (PGH-18).
      const [credential, setCredential] = useState('')
      const [scope, setScope] = useState('') // '' until the user explicitly picks; no silent default
      const [confirmShared, setConfirmShared] = useState(false)

      // Connect dialog state (device flow via the in-memory bridge).
      const [sessionId, setSessionId] = useState('')
      const [step, setStep] = useState('') // 'open' | 'code' | 'connecting' | 'done'
      const [notice, setNotice] = useState(null) // { url, code, message }

      const base = `/identity/${encodeURIComponent(project.id)}`
      const load = useCallback(async () => {
        setLoading(true); setError('')
        try {
          const data = await callApi('GET', base)
          setCard(data)
          setPerm(data?.identity?.connected ? null : 'not-connected')
          setPermReason('')
        } catch (err) { setError(err.message) } finally { setLoading(false) }
      }, [base])
      useEffect(() => { void load() }, [load])

      // Poll a connect session while it is running. The browser cannot receive a
      // server push, so notices/prompts are read from the bridge each tick.
      useEffect(() => {
        if (dialog !== 'connect' || sessionId === '') return undefined
        let active = true
        let timer = null
        const poll = async () => {
          try {
            const view = await callApi('GET', `/auth/connect/${encodeURIComponent(sessionId)}`)
            if (!active) return
            if (view.notices && view.notices.length) {
              const last = view.notices[view.notices.length - 1]
              setNotice(last)
              if (last.code) setStep('code'); else if (last.url) setStep('open')
            }
            if (view.status === 'running' && view.prompt && view.prompt.options) {
              // The flow asks for one "I'm done / cancel" acknowledgement.
              setStep('connecting')
              setStep('code')
              setNotice((prev) => prev) // keep URL+code visible next to the prompt
              setPendingPrompt(true)
            } else if (view.status === 'running') {
              setPendingPrompt(false)
            }
            if (view.status === 'authorized') { setStep('done'); setPendingPrompt(false); await load(); if (typeof onChanged === 'function') onChanged() }
            if (view.status === 'failed' || view.status === 'cancelled') { setError(view.error || t('ghPermBad')); setPendingPrompt(false) }
            if (view.status === 'running' || view.status === 'pending') timer = setTimeout(poll, 2000)
          } catch (err) { if (active) setError(err.message) }
        }
        void poll()
        return () => { active = false; if (timer) clearTimeout(timer) }
      }, [dialog, sessionId, load, onChanged, t])

      const [pendingPrompt, setPendingPrompt] = useState(false)

      const checkPermission = async () => {
        setChecking(true); setPermReason(''); setError('')
        try {
          const result = await callApi('POST', `${base}/check`, {})
          setPerm(result.status)
          setPermReason(result.reason || '')
        } catch (err) { setError(err.message); setPerm('insufficient'); setPermReason(err.message) }
        finally { setChecking(false) }
      }

      const openAdd = () => { setCredential(''); setScope(''); setConfirmShared(false); setError(''); setDialog('add') }

      const submitAdd = async () => {
        if (scope === '') { setError(t('ghScopeTitle')); return }
        setBusy(true); setError('')
        try {
          await callApi('POST', '/auth/token', { token: credential, scope })
          setCredential(''); setDialog(''); await load(); if (typeof onChanged === 'function') onChanged()
        } catch (err) { setError(err.message) } finally { setBusy(false) }
      }

      const beginConnect = async () => {
        setBusy(true); setError(''); setNotice(null); setPendingPrompt(false)
        try {
          const result = await callApi('POST', '/auth/connect/begin', {})
          setSessionId(result.sessionId); setStep('open')
        } catch (err) { setError(err.message) } finally { setBusy(false) }
      }

      const answerConnect = async (value) => {
        setBusy(true); setError('')
        try { await callApi('POST', `/auth/connect/${encodeURIComponent(sessionId)}/answer`, { value }); setPendingPrompt(false); setStep('connecting') }
        catch (err) { setError(err.message) } finally { setBusy(false) }
      }

      const cancelConnect = async () => {
        try { await callApi('POST', `/auth/connect/${encodeURIComponent(sessionId)}/cancel`, {}) } catch { /* best effort */ }
        setDialog(''); setSessionId(''); setPendingPrompt(false)
      }

      const small = { fontSize: 12, color: T.mutedInk, lineHeight: 1.6 }
      const id = card?.identity || {}
      const binding = card?.binding || {}
      const sourceLabel = id.source && SRC_LABEL[id.source] ? t(SRC_LABEL[id.source]) : t('srcNone')
      const pathText = (v) => {
        if (!v) return '—'
        return !expanded && v.length > 46 ? `${v.slice(0, 22)}…${v.slice(-18)}` : v
      }

      return h('div', { key: 'identity', style: { background: T.card, border: `1px solid ${T.line}`, borderRadius: T.radiusLg, boxShadow: T.shadow, overflow: 'hidden' } }, [
        // Header
        h('div', { key: 'h', style: { padding: '12px 14px', borderBottom: `1px solid ${T.line}`, fontSize: 14, fontWeight: 650, color: T.ink } }, t('ghCardTitle')),
        h('div', { key: 'body', style: { padding: '12px 13px', display: 'flex', flexDirection: 'column', gap: 11 } }, [
          loading ? h('div', { key: 'ld', style: small }, t('loading')) : h('div', { key: 'sections' }, [
            // ① binding relationship — local ↔ remote as ONE block
            h('div', { key: 'bind', style: { display: 'flex', flexDirection: 'column', gap: 3, paddingBottom: 10, borderBottom: `1px solid ${T.line}` } }, [
              h('div', { key: 'l', style: small }, `${t('ghLocalLabel')}：${pathText(binding.rootPath)}`),
              h('div', { key: 'x', style: { fontSize: 11, color: binding.bound ? T.success : T.muted, paddingLeft: 2 } }, binding.bound ? `↕ ${t('ghLinked')}` : '↕'),
              h('div', { key: 'r', style: small }, `${t('ghRepoLabel')}：${pathText(binding.issueRepo)}`),
              ((binding.rootPath || '').length > 46 || (binding.issueRepo || '').length > 46)
                ? h('button', { key: 'more', type: 'button', onClick: () => setExpanded(!expanded), style: { alignSelf: 'flex-start', marginTop: 3, border: 'none', background: 'transparent', color: T.accent, fontSize: 11, cursor: 'pointer', padding: '4px 0' } }, t('ghExpandPath'))
                : null,
            ]),
            // ② current identity — account + source + permission light
            h('div', { key: 'who', style: { display: 'flex', flexDirection: 'column', gap: 5, paddingTop: 10 } }, [
              h('div', { key: 'u', style: { fontSize: 13, color: T.ink, fontWeight: 600 } },
                id.connected ? t('ghNowUsing', { account: id.login || t('ghUnknownAccount') }) : t('srcNone')),
              id.connected ? h('div', { key: 'f', style: small }, [
                t('ghFrom', { source: sourceLabel }),
                id.globalShared ? h('span', { key: 'sh', style: { marginLeft: 8, color: T.accent, background: T.accentWash, borderRadius: 5, padding: '1px 6px', fontSize: 10.5 } }, t('ghSharedTag')) : null,
              ]) : null,
              // permission row: positive green / red with reason / neutral checking
              h('div', { key: 'p', style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginTop: 2 } }, [
                h('span', {
                  key: 'dot', style: { width: 9, height: 9, borderRadius: '50', display: 'inline-block', background: perm === 'ok' ? T.green : (perm === 'insufficient' ? T.danger : T.gray) },
                }),
                h('span', { key: 'txt', style: { fontSize: 11.5, color: perm === 'ok' ? T.greenInk : (perm === 'insufficient' ? T.dangerInk : T.mutedInk) } },
                  // Neutral text when connected-but-not-yet-checked: "来源：xxx"
                  // already renders in its own line above — don't repeat it here.
                  checking ? t('ghChecking')
                    : (perm === 'ok' ? t('ghPermOk')
                      : (perm === 'insufficient' ? t('ghPermBad')
                        : (id.connected ? t('ghPermNotChecked') : t('ghGuideNone')))),
                ),
                id.connected && !checking ? h('span', { key: 'chk', className: 'df-tap' }, h(Button, { onClick: () => void checkPermission(), disabled: busy, style: { padding: '3px 9px', fontSize: 11 } }, t('ghCheckPerm'))) : null,
              ]),
              perm === 'insufficient' && permReason ? h('div', { key: 'pr', style: { ...small, color: T.dangerInk, whiteSpace: 'pre-line', background: T.dangerWash, borderRadius: T.radiusSm, padding: '6px 8px' } }, permReason) : null,
              perm === 'insufficient' ? h('div', { key: 'gd', style: { ...small, marginTop: 2 } }, t('ghGuideNoAccess')) : null,
            ]),
            // ③ actions + ④ not-connected guidance
            h('div', { key: 'acts', style: { display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 10, borderTop: `1px solid ${T.line}` } }, [
              h('span', { key: 'c', className: 'df-tap' }, h(Button, { onClick: () => void beginConnect(), disabled: busy }, t('ghConnect'))),
              h('span', { key: 'a', className: 'df-tap' }, h(Button, { onClick: openAdd, disabled: busy }, t('ghAddAccount'))),
            ]),
            !id.connected ? h('div', { key: 'guide', style: { ...small, marginTop: 8, background: T.panel, borderRadius: T.radiusSm, padding: '7px 9px' } }, t('ghGuideNone')) : null,
          ]),
          error ? h('div', { key: 'err', style: { ...small, color: T.dangerInk, whiteSpace: 'pre-line', marginTop: 6 } }, `${t('errorPrefix')}${error}`) : null,
        ]),

        // Add-account modal. Scope switch lives HERE and nowhere else (PGH-18).
        dialog === 'add' ? h(Modal, {
          key: 'addm', title: t('ghAddAccount'), confirmLabel: t('ghSaveAccount'), busy, t,
          onCancel: () => setDialog(''), onConfirm: () => {
            if (scope === 'global') { setConfirmShared(true); return }
            void submitAdd()
          },
        }, [
          h('div', { key: 'hint', style: small }, t('ghAccountHint')),
          h('input', {
            key: 'cred', className: 'input mono', type: 'password', value: credential, spellCheck: false,
            onChange: (e) => setCredential(e.target.value),
            placeholder: t('ghAccountLabel'),
            style: { padding: '7px 9px', border: `1px solid ${T.line}`, borderRadius: T.radiusSm, background: T.card, color: T.ink, fontSize: 13, width: '100%', boxSizing: 'border-box', marginTop: 8 },
          }),
          h('div', { key: 'scope', style: { marginTop: 14 } }, [
            h('div', { key: 'st', style: { fontSize: 12, fontWeight: 600, color: T.ink, marginBottom: 4 } }, t('ghScopeTitle')),
            h('div', { key: 'seg', style: { display: 'flex', gap: 6 } }, [
              h(Button, { key: 'all', onClick: () => setScope('global'), style: scope === 'global' ? { background: T.accentWash, borderColor: T.accent, color: T.accentInk, fontWeight: 600 } : {} }, t('ghScopeAll')),
              h(Button, { key: 'repo', onClick: () => setScope('project'), style: scope === 'project' ? { background: T.accentWash, borderColor: T.accent, color: T.accentInk, fontWeight: 600 } : {} }, t('ghScopeRepo')),
            ]),
            h('div', { key: 'sh', style: { ...small, marginTop: 7 } }, t('ghScopeHint')),
            scope === '' ? h('div', { key: 'need', style: { ...small, color: T.warningInk, marginTop: 5 } }, t('ghScopeTitle')) : null,
          ]),
          error ? h('div', { key: 'err', style: { ...small, color: T.dangerInk, whiteSpace: 'pre-line', marginTop: 8 } }, `${t('errorPrefix')}${error}`) : null,
          confirmShared ? h(Modal, {
            key: 'cfm', title: t('ghChangeSharedConfirm'), tone: 'danger', confirmLabel: t('ghSaveAccount'), confirmTone: 'danger', busy, t,
            onCancel: () => setConfirmShared(false), onConfirm: () => { setConfirmShared(false); void submitAdd() },
          }, h('p', { style: { margin: 0 } }, t('ghScopeHint'))) : null,
        ]) : null,

        // Connect modal — URL + code steps from the bridge, keep-page-open note.
        dialog === 'connect' ? h(Modal, {
          key: 'connm', title: t('ghConnect'), confirmLabel: step === 'done' ? t('closeSettings') : t('cancel'), confirmTone: step === 'done' ? undefined : 'danger', busy, t,
          onCancel: () => void cancelConnect(), onConfirm: () => { if (step === 'done') { setDialog(''); setSessionId('') } else void cancelConnect() },
        }, [
          h('div', { key: 'keep', style: { ...small, color: T.warningInk, marginBottom: 10 } }, t('ghKeepOpen')),
          h('ol', { key: 'steps', style: { margin: 0, paddingLeft: 20, ...small } }, [
            h('li', { key: 's1', style: step ? { color: T.ink } : {} }, t('ghStepOpen')),
            h('li', { key: 's2', style: step === 'code' || step === 'connecting' || step === 'done' ? { color: T.ink } : {} }, t('ghStepCode')),
            h('li', { key: 's3', style: step === 'connecting' || step === 'done' ? { color: T.ink } : {} }, t('ghStepConnecting')),
          ]),
          notice?.url ? h('div', { key: 'url', style: { marginTop: 10, fontSize: 12, wordBreak: 'break-all' } },
            h('a', { href: notice.url, target: '_blank', rel: 'noreferrer', style: { color: T.accent } }, t('ghStepOpen'))) : null,
          notice?.code ? h('div', { key: 'code', style: { marginTop: 8, fontSize: 20, fontWeight: 700, letterSpacing: 2, fontFamily: 'ui-monospace, monospace', color: T.ink } }, notice.code) : null,
          pendingPrompt ? h('span', { key: 'go', className: 'df-tap' }, h(Button, { onClick: () => void answerConnect('done'), disabled: busy }, t('ghStepDone'))) : null,
          step === 'done' ? h('div', { key: 'done', style: { ...small, color: T.greenInk, marginTop: 8 } }, t('ghStepDone')) : null,
          error ? h('div', { key: 'err', style: { ...small, color: T.dangerInk, whiteSpace: 'pre-line', marginTop: 8 } }, `${t('errorPrefix')}${error}`) : null,
        ]) : null,
      ])
    }

    function EngineBar({ t, engine, onChanged }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const paused = engine?.paused === true
      const toggle = async () => {
        setBusy(true); setError('')
        try {
          await callApi('POST', `/engine/${paused ? 'resume' : 'pause'}`)
          onChanged()
        } catch (err) { setError(err.message) } finally { setBusy(false) }
      }
      return h('div', { key: 'engineBar', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
        h('span', {
          key: 'pill', style: { display: 'inline-flex', gap: 7, alignItems: 'center', padding: '4px 11px', borderRadius: 999, fontSize: 12, fontWeight: 600,
            background: paused ? T.orangeWash : T.greenWash, color: paused ? T.orangeInk : T.greenInk },
        }, [h('span', { key: 'dot', style: { width: 7, height: 7, borderRadius: '50%', background: 'currentColor' } }), t(paused ? 'enginePaused' : 'engineRunning')]),
        h('span', { key: 'btn', className: 'df-tap' }, h(Button, { disabled: busy, onClick: () => void toggle() }, paused ? t('engineResume') : t('enginePause'))),
        error ? h('span', { key: 'err', style: { fontSize: 12, color: T.dangerInk } }, `${t('errorPrefix')}${error}`) : null,
      ])
    }

    function NeedsAttention({ t, engine, cards, inboxCards, renderCard }) {
      const approvable = cards.filter((card) => card.status === 'plan-review' && card.takenOver !== true).length
      const stalled = cards.filter((card) => card.stalled === true).length
      const orphans = engine?.orphans?.length ?? 0
      const lastError = engine?.lastError ?? null
      const total = approvable + stalled + orphans + (lastError ? 1 : 0)
      const hasInbox = Array.isArray(inboxCards) && inboxCards.length > 0
      // Design §4.2: attention chips and the inbox are ONE band. Chip ink uses
      // the text-safe colours; the original orange/red stay as dots and borders.
      const chip = (key, label, value, tone) => {
        const ink = tone === 'danger' ? T.dangerInk : T.orangeInk
        const wash = tone === 'danger' ? T.dangerWash : T.orangeWash
        return h('span', { key, style: { fontSize: 11, color: ink, background: wash, border: `1px solid ${ink}`, borderRadius: T.radiusSm, padding: '3px 8px' } },
          `${label} ${value}`)
      }
      return h('div', {
        key: 'attention', className: 'df-inbox',
        style: { display: 'flex', flexDirection: 'column', gap: 8, background: T.card, border: `1px solid ${T.line}`, borderLeft: `3px solid ${total > 0 || hasInbox ? T.warning : T.green}`, borderRadius: T.radiusLg, padding: '10px 12px' },
      }, [
        h('div', { key: 'head', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h('span', { key: 'title', style: { fontSize: 13, fontWeight: 650 } }, t('needsTitle')),
          approvable > 0 ? chip('a', t('needsApprove'), approvable, 'warn') : null,
          stalled > 0 ? chip('s', t('needsStalled'), stalled, 'danger') : null,
          orphans > 0 ? chip('o', t('needsOrphan'), orphans, 'warn') : null,
          lastError ? chip('e', t('needsEngineErr'), '1', 'danger') : null,
          total === 0 && !hasInbox ? h('span', { key: 'clear', style: { fontSize: 12, color: T.mutedInk } }, `${t('needsClear')} · ${t('inboxEmpty')}`) : null,
        ].filter(Boolean)),
        hasInbox ? h('div', { key: 'sep', style: { height: 1, background: T.line } }) : null,
        hasInbox ? h('div', { key: 'inbox', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
          h('div', { key: 'ih', style: { fontSize: 12, fontWeight: 600, color: T.warningInk } }, `${t('inbox')} · ${inboxCards.length}`),
          inboxCards.map(renderCard),
        ]) : null,
      ].filter(Boolean))
    }

    // One-time scoped stylesheet for the mobile action bar, 44px tap targets and
    // bottom-sheet confirm dialog. Injected via the host document, never a build
    // step; selectors are scoped to this plugin's root attribute.
    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById('dsh-factory-p4-css')) return
      const css = [
        // P4 brand tokens, scoped to this view only — never alter the host theme.
        '[data-dsh-factory-p4]{--df-accent:#4f46d5;--df-accent-wash:#eef0ff;--df-accent-ink:#3b33b8;--df-blue:#2f7de1;--df-blue-wash:#eaf2fe;--df-orange:#c9771f;--df-orange-wash:#fdf1e3;--df-green:#1f8f63;--df-gray:#8b95a5;--df-gray-wash:#f1f3f6;--df-danger-wash:#fdf0f1;--df-muted-ink:#596273;--df-warning-ink:#8a5a00;--df-danger-ink:#b4232b;--df-info-ink:#2457c5;--df-orange-ink:#8a4a05;--df-green-ink:#146c4a;--df-green-wash:#e8f6ef;--df-radius:11px;--df-radius-sm:7px;--df-shadow:0 1px 2px rgba(20,28,40,.04),0 6px 20px rgba(20,28,40,.04)}',
        // Focus must stay visible for keyboard users; inline styles cannot do :focus-visible.
        '[data-dsh-factory-p4] :focus-visible{outline:2px solid var(--df-accent);outline-offset:2px}',
        // Unified card treatment (Design #2/#3): rounded, layered, radius system.
        '[data-dsh-factory-p4] .df-card{border-radius:var(--df-radius, 11px);box-shadow:var(--df-shadow, 0 1px 2px rgba(20,28,40,.04),0 6px 20px rgba(20,28,40,.04))}',
        // Large containers share the 11px radius; controls share 7px (Design #3).
        '[data-dsh-factory-p4] .df-col,[data-dsh-factory-p4] .df-group,[data-dsh-factory-p4] .df-inbox{border-radius:var(--df-radius, 11px)!important}',
        '[data-dsh-factory-p4] input,[data-dsh-factory-p4] textarea,[data-dsh-factory-p4] select{border-radius:var(--df-radius-sm, 7px)!important}',
        '[data-dsh-factory-p4] .df-mobar{display:none}',
        '[data-dsh-factory-p4] .df-tap button,[data-dsh-factory-p4] button.df-tap{min-height:44px}',
        // Snap belongs only to the narrow 84vw columns below: on a wide viewport
        // inside a narrow host container, mandatory snap without snap-align would
        // make the middle columns unreachable (Review BLOCK-1).
        '[data-dsh-factory-p4] .df-board{display:flex;gap:8px;align-items:flex-start;overflow-x:auto}',
        // Column sizing lives in CSS so the ≤760px rule can override it; inline
        // flex/minWidth would win over the media query at 390px.
        '[data-dsh-factory-p4] .df-col{flex:1 1 0;min-width:140px}',
        '[data-dsh-factory-p4] .df-col-head{position:sticky;top:0;background:var(--dsw-alias-bg-secondary,#f6f7f9);z-index:1}',
        '[data-dsh-factory-p4] .df-stage{display:none}',
        // Keep the desktop gap here so the ≤520px override can win over inline styles.
        '[data-dsh-factory-p4] .df-stats{gap:8px}',
        '@media (max-width:760px){',
        // The host app-shell locks vertical scroll on narrow screens (its content
        // column is overflow:hidden). Make THIS view's root fill the host's given
        // height and scroll internally, so the overflow is reachable without ever
        // touching the host shell. `height:100%` inherits the host's definite
        // height; min-height:0 lets the flex child actually shrink; box-sizing
        // keeps padding from pushing it past the host clip.
        '  [data-dsh-factory-p4]{height:100%;min-height:0;box-sizing:border-box;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}',
        // Keep the board a bounded, self-scrolling region so a tall column can
        // never stretch the whole page again. Horizontal scroll (above) is intact.
        '  [data-dsh-factory-p4] .df-board{max-height:56vh;overflow-y:auto;scroll-snap-type:x mandatory;scroll-padding-left:12px}',
        '  [data-dsh-factory-p4] .df-col{flex:0 0 84vw;min-width:0;scroll-snap-align:start}',
        '  [data-dsh-factory-p4] .df-stage{display:block;font-size:11px;color:var(--df-muted-ink,#596273);text-align:right}',
        '  [data-dsh-factory-p4] aside{width:100vw!important}',
        // aside children: 1 = header (dh), 2 = tabs, 3 = body; the sub-label lives in tabs.
        '  @media (max-width:520px){[data-dsh-factory-p4] aside>div:nth-child(2) span.df-tab-sub{display:none}[data-dsh-factory-p4] .df-stats{gap:6px}}',
        '  [data-dsh-factory-p4] .df-mobar{display:flex;position:sticky;bottom:0;z-index:25;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));background:var(--dsw-alias-bg, #fff);border-top:1px solid var(--dsw-alias-border, #e3e6ea);box-shadow:0 -4px 16px rgba(20,28,40,.06)}',
        '  [data-dsh-factory-p4] .df-mobar button{flex:1;min-height:44px;text-align:center}',
        '  [data-dsh-factory-p4] button{min-height:44px}',
        '  [data-dsh-factory-p4] .df-hide-sm{display:none}',
        `  [data-dsh-factory-p4] .df-modal{align-self:flex-end;margin-bottom:0;border-radius:14px 14px 0 0;max-width:100%}`,
        '}',
        '@media (prefers-reduced-motion:reduce){[data-dsh-factory-p4] *{transition:none!important;animation:none!important}}',
      ].join('\n')
      const style = document.createElement('style')
      style.id = 'dsh-factory-p4-css'
      style.textContent = css
      document.head.appendChild(style)
    }

    function BoardPage({ t }) {
      const [projects, setProjects] = useState([])
      const [boards, setBoards] = useState([])
      const [cards, setCards] = useState([])
      const [engine, setEngine] = useState(null)
      const [settings, setSettings] = useState(null)
      const [projectId, setProjectId] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [newProject, setNewProject] = useState({ name: '', rootPath: '' })
      const [newCardTitle, setNewCardTitle] = useState('')
      const [drawerOpen, setDrawerOpen] = useState(false)
      const [stage, setStage] = useState(1)
      // 'auto' = project first when a project is selected, global otherwise.
      // An explicit tab click pins a scope for this page session only; a reload
      // starts over at 'auto' (state is in memory, not persisted).
      const [scope, setScope] = useState('auto')
      const [openBlock, setOpenBlock] = useState('autonomy')

      const load = useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          // Settings/status are read alongside the board so the config drawer
          // and the effective-slots readout never show a stale value after a save.
          const [p, b, c, st, se] = await Promise.all([
            callApi('GET', '/projects'), callApi('GET', '/boards'), callApi('GET', '/cards'),
            callApi('GET', '/status'), callApi('GET', '/settings'),
          ])
          setProjects(p.projects || [])
          setBoards(b.boards || [])
          setCards(c.cards || [])
          setEngine(st.engine ?? null)
          setSettings(se.settings ?? null)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => { void load() }, [load])

      // Auto-select the first project once data arrives so the board is visible.
      useEffect(() => {
        if (projectId === '' && projects.length > 0) setProjectId(projects[0].id)
      }, [projects, projectId])

      const project = projects.find((entry) => entry.id === projectId) || null
      // 'auto' resolves from the CURRENT project; an explicit tab click still wins.
      const activeScope = scope === 'auto' ? (project ? 'project' : 'global') : scope
      // Keep the drawer heading consistent with the body (noProjects in project scope).
      const drawerTitle = activeScope === 'project'
        ? (project ? `${project.name} · ${t('scopeProject')}` : t('scopeProject'))
        : t('scopeGlobal')
      // One project owns exactly one board; the store converges legacy data.
      const projectBoards = boards.filter((entry) => entry.projectId === projectId)
      const board = projectBoards[0] || null
      const boardCards = board ? cards.filter((entry) => entry.boardId === board.id) : []
      const inboxCards = boardCards.filter((entry) => entry.status === 'inbox')
      const canceledCards = boardCards.filter((entry) => entry.status === 'canceled')

      const run = async (fn) => {
        setBusy(true); setError('')
        try { await fn(); await load() } catch (err) { setError(err.message) } finally { setBusy(false) }
      }

      const renderCard = (card) => h('div', { key: card.id, style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
        h(Card, { key: 'card', card }),
        h(CardActions, { key: 'actions', card, run, t, busy }),
      ])

      const selectStyle = { padding: '6px 8px', border: `1px solid ${T.line}`, borderRadius: T.radiusSm, background: T.card, color: T.ink, fontSize: 13 }
      const children = []

      // One block of the project settings accordion (single-open). Mounted only
      // when open so a stale pending level never hides in a collapsed panel.
      const block = (key, num, titleKey, subKey, tone, body) => h('div', {
        key, className: 'df-group',
        style: { background: T.card, border: `1px solid ${T.line}`, borderRadius: T.radiusLg, marginBottom: 12, overflow: 'hidden',
          ...(tone === 'danger' ? { borderLeft: `3px solid ${T.danger}`, marginTop: 16 } : {}) },
      }, [
        h('button', {
          type: 'button', onClick: () => setOpenBlock(openBlock === key ? '' : key),
          style: { width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '12px 14px', background: 'transparent', border: 'none', color: T.ink, cursor: 'pointer', textAlign: 'left', minHeight: 44 },
        }, [
          h('span', { key: 'bar', style: { width: 3, height: 17, borderRadius: 2, background: tone === 'danger' ? T.danger : tone === 'warn' ? T.warning : T.info } }),
          h('span', { key: 't', style: { fontSize: 14, fontWeight: 650 } }, `${num} ${t(titleKey)}`),
          subKey ? h('span', { key: 's', style: { fontSize: 11, color: T.mutedInk } }, t(subKey)) : null,
          h('span', { key: 'c', style: { marginLeft: 'auto', color: T.mutedInk } }, openBlock === key ? '▾' : '▸'),
        ]),
        openBlock === key ? h('div', { key: 'b', style: { borderTop: `1px solid ${T.line}`, padding: 14 } }, body) : null,
      ])

      // Shared page shell: every branch (empty / no-board / full) gets the config
      // drawer, its scrim and the mobile action bar. Keeps the board the first-class
      // citizen while config lives off-canvas (P4-0).
      const renderPage = () => h('div', { 'data-dsh-factory-p4': '1', style: { display: 'flex', flexDirection: 'column', gap: 16, padding: 8, position: 'relative' } }, [
        h('div', { key: 'main', style: { display: 'flex', flexDirection: 'column', gap: 12 } }, children),
        // Scrim + right-side config drawer.
        drawerOpen ? h('div', {
          key: 'scrim', onClick: () => setDrawerOpen(false),
          style: { position: 'fixed', inset: 0, background: 'rgba(18,24,32,.34)', zIndex: 40 },
        }) : null,
        h('aside', {
          key: 'drawer', 'aria-label': drawerTitle,
          style: { position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(500px,94vw)', background: T.panel, zIndex: 50,
            transform: drawerOpen ? 'translateX(0)' : 'translateX(102%)', transition: 'transform .24s cubic-bezier(.2,.7,.2,1)',
            boxShadow: '-18px 0 50px rgba(16,22,30,.18)', display: 'flex', flexDirection: 'column' },
        }, [
          h('div', { key: 'dh', style: { display: 'flex', alignItems: 'center', gap: 10, padding: 16, background: T.card, borderBottom: `1px solid ${T.line}` } }, [
            h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 650, flex: 1 } }, drawerTitle),
            h(Button, { onClick: () => setDrawerOpen(false), style: { padding: '4px 10px', minHeight: 44 } }, t('closeSettings')),
          ]),
          h('div', { key: 'tabs', style: { display: 'flex', gap: 4, padding: '10px 16px 0', background: T.card, borderBottom: `1px solid ${T.line}` } }, [
            h('button', {
              type: 'button', onClick: () => setScope('project'),
              style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1, border: 'none', borderRadius: T.radiusSm,
                background: activeScope === 'project' ? T.accentWash : 'transparent', color: activeScope === 'project' ? T.accentInk : T.mutedInk,
                fontSize: 13, fontWeight: 650, padding: '10px 16px', borderBottom: activeScope === 'project' ? `2px solid ${T.accent}` : '2px solid transparent', minHeight: 44 },
            }, [h('span', { key: 't' }, t('scopeProject')), h('span', { key: 's', className: 'df-tab-sub', style: { fontSize: 11, fontWeight: 400, color: T.mutedInk } }, t('scopeProjectSub'))]),
            h('button', {
              type: 'button', onClick: () => setScope('global'),
              style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1, border: 'none', borderRadius: T.radiusSm,
                background: activeScope === 'global' ? T.accentWash : 'transparent', color: activeScope === 'global' ? T.accentInk : T.mutedInk,
                fontSize: 13, fontWeight: 650, padding: '10px 16px', borderBottom: activeScope === 'global' ? `2px solid ${T.accent}` : '2px solid transparent', minHeight: 44 },
            }, [h('span', { key: 't' }, t('scopeGlobal')), h('span', { key: 's', className: 'df-tab-sub', style: { fontSize: 11, fontWeight: 400, color: T.mutedInk } }, t('scopeGlobalSub'))]),
          ]),
          h('div', { key: 'body', style: { overflow: 'auto', padding: '16px 16px 48px', flex: 1 } },
            activeScope === 'global'
              ? h('div', { key: 'gp' }, [
                  h('div', { key: 'note', style: { fontSize: 12, color: T.mutedInk, background: T.card, border: `1px solid ${T.line}`, borderRadius: T.radiusLg, padding: '10px 12px', marginBottom: 12, lineHeight: 1.6 } }, t('globalNote')),
                  // Design §3.5: three lightweight groups, no new fold state.
                  h('div', { key: 'gt1', style: { fontSize: 12, fontWeight: 650, color: T.mutedInk, margin: '12px 0 8px' } }, t('groupGithub')),
                  h(AppIdSetting, { key: 'appid', t, settings, onSaved: () => void load() }),
                  // Global account management — OAuth connect/reconnect/disconnect
                  // + gh CLI status, all machine-level (Design §7, PGH-19~21).
                  h(AccountManager, { key: 'acctmgr', t, onChanged: () => void load() }),
                  h('div', { key: 'gt2', style: { fontSize: 12, fontWeight: 650, color: T.mutedInk, margin: '16px 0 8px' } }, t('groupPaths')),
                  h(WorktreesRootSetting, { key: 'wr', t }),
                  h('div', { key: 'gc', style: { background: T.card, border: `1px solid ${T.line}`, borderRadius: T.radiusLg, padding: 12, marginTop: 12 } },
                    h(GlobalCapSection, { key: 'gcap', t, settings, onSaved: () => void load() })),
                  h('div', { key: 'gt3', style: { fontSize: 12, fontWeight: 650, color: T.mutedInk, margin: '16px 0 8px' } }, t('groupEngine')),
                  h('div', { key: 'ge', style: { background: T.card, border: `1px solid ${T.line}`, borderRadius: T.radiusLg, padding: 12 } }, [
                    h(EngineBar, { key: 'egate', t, engine, onChanged: () => void load() }),
                    h('div', { key: 'hint', style: { fontSize: 12, color: T.mutedInk, marginTop: 8 } }, t('engineGateHint')),
                  ]),
                ])
              : (project
                  ? h('div', { key: 'pp' }, [
                      h('div', { key: 'note', style: { fontSize: 12, color: T.mutedInk, background: T.card, border: `1px solid ${T.line}`, borderRadius: T.radiusLg, padding: '10px 12px', marginBottom: 12 } }, [
                        h('span', { key: 'p' }, `${t('scopeProjectSub')} · ${project.name}`),
                        h('button', { key: 'g', type: 'button', onClick: () => setScope('global'),
                          style: { display: 'block', marginTop: 4, padding: 0, border: 'none', background: 'transparent', color: T.infoInk, fontSize: 12, cursor: 'pointer', minHeight: 44 } }, `${t('scopeGlobal')} ›`),
                      ]),
                      // Identity card FIRST — the prerequisite for "can this repo
                      // work at all" (Design §1), ahead of the settings blocks.
                      h('div', { key: 'idcard', style: { marginBottom: 12, borderRadius: T.radiusLg, boxShadow: T.shadow } },
                        h(IdentityCard, { key: `${project.id}:identity`, project, t, onChanged: () => void load() })),
                      block('prep', '01', 'setupTitle', 'setupPurpose', 'info', h(WorktreeSetup, { key: `${project.id}:setup`, project, t, onSaved: () => void load() })),
                      // Design §3.4: autonomy + pause are the same mental model — one block.
                      block('autonomy', '02', 'autoPanelTitle', 'autoPanelPurpose', 'warn', h('div', { key: 'autoAndPause' }, [
                        h(AutonomySection, { key: `${project.id}:autonomy`, project, t, onSaved: () => void load() }),
                        h(PauseSection, { key: `${project.id}:pause`, project, t, onSaved: () => void load() }),
                      ])),
                      block('conc', '03', 'concTitle', 'concSub', 'info', h(ConcurrencySection, { key: `${project.id}:conc`, project, t, settings, onSaved: () => void load() })),
                      block('danger', '04', 'dangerTitle', 'dangerSub', 'danger', h(DangerSection, { key: `${project.id}:danger`, project, t, onDeleted: () => { setDrawerOpen(false); setProjectId(''); void load() } })),
                    ])
                  : h('div', { key: 'pn', style: { fontSize: 13, color: T.mutedInk } }, t('noProjects'))
                )
          ),
        ]),
        // Mobile action bar: primary actions pinned to the bottom on narrow screens.
        h('div', { key: 'mobar', className: 'df-mobar' }, [
          h(Button, { onClick: () => { setScope('auto'); setDrawerOpen(true) } }, h('span', { className: 'df-tap' }, t('mobileProjectConfig'))),
          // Pause & takeover live as the last row of the merged autonomy block.
          h(Button, { onClick: () => { setScope('project'); setOpenBlock('autonomy'); setDrawerOpen(true) } }, h('span', { className: 'df-tap' }, t('pauseTitle'))),
        ]),
      ])

      // View head: title + description, three headline stats, engine gate and the
      // settings entry. The board below is the first-class citizen, full width.
      const activeCount = cards.filter((card) => typeof card.sessionId === 'string' && card.sessionId !== '').length
      const globalEff = settings?.effectiveGlobalMaxActive
      const projDefault = settings?.projectDefaultMaxActive
      const projEff = project?.maxActiveSessions > 0 ? project.maxActiveSessions : (projDefault ?? null)
      const slots = projEff !== null && globalEff?.value != null ? Math.min(projEff, globalEff.value) : (projEff ?? globalEff?.value ?? '—')
      const stat = (key, n, label) => h('div', { key, style: { background: T.card, border: `1px solid ${T.line}`, borderRadius: T.radiusLg, padding: '8px 12px', minWidth: 78 } }, [
        h('div', { key: 'n', style: { fontSize: 20, fontWeight: 700, color: T.ink, lineHeight: 1.2 } }, String(n)),
        h('div', { key: 'l', style: { fontSize: 11, color: T.mutedInk } }, label),
      ])
      children.push(h('div', { key: 'viewHead', style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' } }, [
        h('div', { key: 'vt', style: { display: 'flex', flexDirection: 'column', gap: 2 } }, [
          h('div', { key: 'crumb', style: { fontSize: 11.5, color: T.mutedInk, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, `dsh-factory / ${t('navLabel')} / ${project?.name ?? '—'}`),
          h('div', { key: 'title', style: { fontSize: 20, fontWeight: 650, color: T.ink, letterSpacing: '-.01em' } }, project?.name ?? t('navLabel')),
          // board.name is retained in state/API; hide the system default name so
          // the header doesn't imply a board choice that no longer exists.
          board && board.name && board.name !== 'Default'
            ? h('div', { key: 'bname', style: { fontSize: 11, color: T.mutedInk } }, `${t('board')} · ${board.name}`) : null,
          h('div', { key: 'desc', style: { fontSize: 12, color: T.mutedInk, lineHeight: 1.6 } }, t('viewDesc')),
        ].filter(Boolean)),
        h('div', { key: 'tools', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h('span', { key: 'engine', className: 'df-hide-sm' }, h(EngineBar, { t, engine, onChanged: () => void load() })),
          h(Button, { key: 'refresh', onClick: () => void load(), disabled: busy }, busy ? t('loading') : t('refresh')),
          h('span', { key: 'cfg', className: 'df-tap' }, h(Button, {
            onClick: () => { setScope('auto'); setDrawerOpen(true) },
            style: { background: T.accent, borderColor: T.accent, color: '#fff' },
          }, t('mobileSettings'))),
        ]),
      ]))

      if (error) {
        children.push(h('div', { key: 'error', style: { color: T.dangerInk, fontSize: 13, background: T.panel, border: `1px solid ${T.danger}`, borderRadius: T.radiusSm, padding: '6px 10px', whiteSpace: 'pre-line' } }, `${t('errorPrefix')}${error}`))
      }

      if (projects.length === 0) {
        children.push(h('div', { key: 'empty', style: { color: T.mutedInk, fontSize: 13 } }, t('noProjects')))
        children.push(h('div', { key: 'newProject', style: { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', background: T.panel, padding: 10, borderRadius: T.radiusLg } }, [
          h(Field, { key: 'name', label: t('projectName'), value: newProject.name, onChange: (v) => setNewProject({ ...newProject, name: v }) }),
          h(Field, { key: 'root', label: t('rootPath'), value: newProject.rootPath, onChange: (v) => setNewProject({ ...newProject, rootPath: v }), placeholder: '/workspace/my-repo' }),
          h(Button, {
            key: 'create', disabled: busy || !newProject.name || !newProject.rootPath,
            onClick: () => void run(async () => {
              await callApi('POST', '/projects', { name: newProject.name, rootPath: newProject.rootPath })
              setNewProject({ name: '', rootPath: '' })
            }),
          }, t('create')),
        ]))
        return renderPage()
      }

      children.push(h('div', { key: 'selectors', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
        h('span', { key: 'plabel', style: { fontSize: 12, color: T.mutedInk } }, `${t('project')}:`),
        h('select', {
          key: 'project', value: projectId,
          onChange: (event) => setProjectId(event.target.value),
          style: selectStyle,
        }, [h('option', { key: '', value: '' }, '—'), ...projects.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name))]),
      ]))

      if (project && project.warning) {
        children.push(h('div', { key: 'warn', style: { fontSize: 12, color: T.warningInk } }, project.warning))
      }

      // Headline stats — a first-class view header over the board.
      children.push(h('div', { key: 'stats', className: 'df-stats', style: { display: 'flex', flexWrap: 'wrap' } }, [
        stat('sc', boardCards.length, t('statCards')),
        stat('sa', activeCount, t('statActive')),
        stat('ss', slots, t('statSlots')),
      ]))

      // Design §4.2: needs-attention + inbox are one band, not two strips.
      children.push(h(NeedsAttention, { key: 'attention', t, engine, cards: boardCards, inboxCards, renderCard }))

      children.push(h('div', { key: 'newCard', style: { display: 'flex', gap: 8, alignItems: 'flex-end' } }, [
        h(Field, { key: 'ct', label: t('newCard'), value: newCardTitle, onChange: setNewCardTitle }),
        h(Button, { key: 'cc', disabled: busy || !newCardTitle || !board, onClick: () => void run(async () => {
          await callApi('POST', '/cards', { boardId: board.id, title: newCardTitle })
          setNewCardTitle('')
        }) }, t('create')),
      ]))

      children.push(h('div', { key: 'stage', className: 'df-stage' }, `${stage} / ${COLUMNS.length}`))
      children.push(h('div', { key: 'board', className: 'df-board',
        onScroll: (event) => {
          const el = event.currentTarget
          // Measure the rendered column plus the 8px board gap: 84vw is a viewport
          // unit and can differ from the host content width (clientWidth).
          const first = el.firstElementChild
          const step = first ? first.getBoundingClientRect().width + 8 : (el.clientWidth || 1)
          setStage(Math.min(COLUMNS.length, Math.max(1, Math.round(el.scrollLeft / step) + 1)))
        },
        style: { display: 'flex', gap: 8, alignItems: 'flex-start', overflowX: 'auto' } },
        COLUMNS.map((column) => h(Column, {
          key: column.key,
          title: t(column.labelKey),
          t,
          renderCard,
          cards: boardCards.filter((card) => column.statuses.includes(card.status)),
        }))))

      if (canceledCards.length > 0) {
        children.push(h('div', { key: 'canceled', style: { fontSize: 12, color: T.mutedInk } }, `${t('canceled')}: ${canceledCards.length}`))
      }

      return renderPage()
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Scoped mobile CSS (44px targets, pinned action bar, bottom-sheet modal).
        // Injected once into the host document; no build step, no host token edits.
        ensureStyles()
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-factory: dictionaries')
        const t = ctx.locale.bind(NS)
        // Primary surface: an icon row in the global panel list…
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'dsh-factory',
          order: 5,
          label: () => t('navLabel'),
          locale: NS,
        }, FactoryNavIcon))
        // …and the full board page in the root `main` slot under the SAME id.
        // The two ids must match — selecting a missing main entry throws.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'dsh-factory',
          locale: NS,
          inject: () => ({ t }),
        }, BoardPage))
      },
    }
  },
})
