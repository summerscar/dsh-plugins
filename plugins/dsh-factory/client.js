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
      inbox: "📥 收件箱",
      inboxEmpty: "收件箱为空",
      colPlanning: "规划中",
      colAwaiting: "待批准",
      colBuilding: "实现中",
      colReview: "待评审",
      colDone: "完成",
      canceled: "已取消",
      emptyColumn: "—",
      actDispatch: "交给 AI 处理",
      actApprovePlan: "批准计划",
      actConfirmCommit: "确认提交",
      actCreatePr: "推送分支并创建 PR",
      actMarkDone: "标记完成",
      setupTitle: "worktree 准备",
      setupPurpose: "从项目根复制本地文件，并在新 worktree 内运行准备命令",
      setupCopyLabel: "要复制的文件",
      setupCopyHint: "从项目根拷进新 worktree 的相对路径，通常是被 git 忽略的本地文件",
      setupEg: "例如",
      setupAddPath: "+ 添加路径",
      setupRemove: "移除",
      setupCopyEmpty: "还没有要复制的文件。不填 = worktree 里不会有这些本地文件",
      setupPathInvalid: "路径必须相对项目根，且不能是绝对路径、..、.git 或符号链接",
      setupPathMissing: "项目根下没找到 {path}，派发时跳过",
      setupPostLabel: "创建后运行",
      setupPostHint: "在新建 worktree 内执行的命令，由你填写，插件不预设；失败会回滚派发",
      setupRisk: "会在你的机器上执行，只填你信任的命令",
      setupFollowRepo: "具体装什么、跑什么验证请遵循目标仓库自己的 AGENTS.md / CONTRIBUTING",
      setupLocalFilesHint: "本地文件请用「要复制的文件」配置，不要在这里用 cp ../",
      setupVarsTitle: "命令里可用的变量",
      setupVarsEnv: "通过环境变量传入，命令里不要自行拼接路径",
      setupVarWorktreePath: "本次 worktree 的绝对路径",
      setupVarWorktreeName: "worktree 名称",
      setupVarBranchName: "本次分支名",
      setupVarBaseRef: "基分支",
      setupAdvanced: "高级",
      setupTimeout: "超时（分钟）",
      setupTimeoutHint: "超时将中止并回滚派发",
      setupPostEmpty: "留空 = 不做额外准备",
      setupSave: "保存",
      setupSaving: "保存中…",
      setupSaved: "已保存",
      setupPreparing: "准备 worktree 中…",
      setupRolledBack: "已回滚：worktree 与分支已清理",
      wtRootTitle: "Worktrees 根目录",
      wtRootPurpose: "设置新项目 worktree 的统一存放位置，各项目会在此目录下有独立子目录",
      wtRootLabel: "Worktrees root（留空即用默认）",
      wtRootPlaceholder: "~/dsh-factory-worktrees",
      wtRootHint: "留空使用默认 `~/dsh-factory-worktrees`（按用户主目录解析）",
      wtRootResolved: "当前生效：{path}",
      wtRootScope: "仅对之后新建的 worktree 生效；已有 worktree 不受影响",
      wtRootDanger: "worktrees root 不能位于 DSH 数据目录内",
      // P4 · autonomy & runtime panel
      autoPanelTitle: "自治与运行",
      autoPanelPurpose: "档位、暂停、运行数分开保存，互不影响",
      lvTitle: "运行档位",
      lvL0: "手动",
      lvL1: "你批准",
      lvL2: "机器批准",
      badgeL0: "手动",
      badgeL1: "你批准",
      badgeL2: "机器批准",
      badgePaused: "已暂停",
      lvSub: "机器替你做到哪一步",
      leMachine: "机器会做",
      leYou: "你要做",
      leL0M: "不自动做任何事，全部等你亲自操作。",
      leL0Y: "自己派发、自己批准计划、自己确认提交。",
      leL1M: "把卡推进到「待批准」就停下，不会自己往下走。",
      leL1Y: "批准计划后，机器才继续实现。",
      leL2M: "连计划也自动批准，一路推进到实现。",
      leL2Y: "不用管，随时可改回手动；机器不碰 git、不建 PR、不标完成。",
      prefHead: "偏好设置（一般不用改）",
      prefNote: "档位决定怎么跑；开关只做记录，切档不会清空。",
      unsaved: "未保存",
      autoStart: "新卡自动开工",
      autoApprove: "计划自动批准",
      inactiveAtLevel: "本档位用不到",
      saveLevel: "保存档位",
      l2Title: "改用「机器批准」档位？",
      l2Body: "机器会自动批准计划并继续实现，但不碰 git、不建 PR、不标记完成。按项目单独启用，随时可改回手动。",
      enableL2: "确认启用",
      cancel: "取消",
      pauseTitle: "暂停与接管",
      pauseSub: "即时生效的人工门闩",
      projPause: "暂停本项目的自动派发",
      enginePause: "暂停引擎",
      engineResume: "恢复引擎",
      engineRunning: "引擎运行中",
      enginePaused: "引擎已暂停",
      pauseSem: "暂停只拦新任务；正在跑的不动，跳过的卡不补。",
      takeover: "我来接手",
      concTitle: "同时运行数",
      concSub: "单独保存；实际数量取较小的",
      projMaxLabel: "本项目最多同时跑几个（maxActiveSessions）",
      globMaxLabel: "同时运行上限（globalMaxActive）",
      blankDefault: "留空则用默认",
      globHelp: "所有项目加起来，最多同时跑几个任务。留空用默认；改完立即生效，重启也不丢。",
      effLabel: "当前能同时跑几个",
      effSrc: "来源：{src}；取两项中较小的",
      srcSettings: "已保存的全局设置",
      srcConfig: "部署配置",
      srcDefault: "内置默认",
      saveConc: "保存并发设置",
      saveGlobal: "保存全局设置",
      dangerTitle: "危险区",
      dangerSub: "仅当前项目",
      deleteHint: "删除项目及其所有看板、卡片与 worktree，操作不可撤销。",
      deleteProject: "删除项目",
      delTitle: "删除项目及其 worktree",
      delBody: "将删除本项目登记及其所有 worktree；只清理属于本项目的 worktree，有未提交改动的会被拒绝并列出改动，部分清理失败则保留项目登记并显示原始错误。",
      delType: "输入项目名 {name} 以确认",
      delWrong: "项目名不匹配，未删除",
      forceHead: "强制清理有未提交改动的 worktree（不默认勾选）",
      forceBody: "默认拒绝删除并列出改动；仅在确知可丢弃时勾选。",
      delConfirm: "删除项目",
      needsTitle: "需要你处理",
      needsApprove: "待批准计划",
      needsStalled: "停滞卡片",
      needsOrphan: "孤儿会话",
      needsEngineErr: "引擎错误",
      needsClear: "暂无需要处理的事项",
      gmInvalid: "同时运行上限必须是正整数或 null",
      pmInvalid: "项目并发必须是正整数或 null",
      scopeGlobal: "全局设置",
      scopeGlobalSub: "作用于所有项目",
      scopeProject: "项目设置",
      scopeProjectSub: "只作用于当前项目",
      globalNote: "全局设置作用于所有项目；改动只影响之后新建的 worktree 与调度，已有项目和运行中的卡不受影响。",
      engineGate: "暂停整个引擎",
      engineGateHint: "全局暂停挡住所有项目的自动派发；已在运行的会话不受影响。页头的引擎开关与此同步。",
      viewDesc: "卡片按阶段排好，到关口才请你批准。",
      statCards: "卡片",
      statActive: "活跃会话",
      statSlots: "可同时跑",
      closeSettings: "关闭",
      mobileSettings: "配置",
      mobileTakeover: "我来接手",
      mobileApprove: "批准计划",
      mobileDispatch: "交给 AI",
      // P4-github · project GitHub identity card (Design copy — plain words only)
      ghCardTitle: "这个仓库的 GitHub 连接",
      ghLocalLabel: "本地文件夹",
      ghRepoLabel: "GitHub 仓库",
      ghLinked: "已连好",
      ghExpandPath: "展开完整路径",
      ghNowUsing: "正在用：{account}",
      ghFrom: "来源：{source}",
      ghUnknownAccount: "暂时认不出是谁",
      ghSharedTag: "所有项目共用",
      srcConnected: "已连接",
      srcComputer: "电脑上已登录",
      srcSystem: "系统里已设置",
      srcAddedShared: "自己填写的",
      srcThisRepo: "只给这个仓库",
      srcNone: "还没连接",
      ghPermOk: "可以正常访问这个仓库",
      ghPermBad: "访问不了这个仓库",
      ghCheckPerm: "检查权限",
      ghChecking: "正在确认…",
      ghConnect: "连接 GitHub",
      ghAddAccount: "填写账号",
      ghGuideNone: "这个仓库还没连接账号。连一次（所有项目都能用），或电脑上登录一个，或自己填一个。",
      ghGuideNoAccess: "已连接的账号访问不了这个仓库。换一个能访问的账号，或给这个仓库单独填一个。",
      ghKeepOpen: "连接时请先别关这个页面",
      ghStepOpen: "打开这个网址",
      ghStepCode: "登录后把看到的码填进来",
      ghStepConnecting: "正在连接…",
      ghStepDone: "连好了，所有项目都能用",
      ghScopeTitle: "这个账号给谁用？",
      ghScopeAll: "所有项目都用",
      ghScopeRepo: "只给这个仓库",
      ghScopeHint: "选「所有项目都用」，以后新建的项目也会用这个账号；选「只给这个仓库」，只影响当前仓库。",
      ghAppIdLabel: "连接用的应用编号",
      ghAppIdHint: "在你自己的 GitHub 建一个连接用的应用，把编号填这里。建一次，所有项目共用。",
      ghChangeSharedConfirm: "这会改变所有项目正在用的账号，确定吗？",
      ghSaveAppId: "保存编号",
      ghAccountLabel: "你的登录信息",
      ghAccountHint: "填入你自己的登录信息，只存在你的账号里，不会显示出来。",
      ghSaveAccount: "保存",
      ghSaved: "已保存",
      // P4-github increment · global account management (Design §7.7)
      ghConnectState: "连接状态：{state}",
      ghStateOn: "已连接",
      ghStateOff: "还没连接",
      ghReconnect: "重新连接",
      ghDisconnect: "断开这台设备",
      ghDisconnectDone: "已在这台设备上断开。",
      ghRevokeGuide: "要彻底撤销，请到 GitHub 网页取消这个应用的授权。",
      ghRevokeLink: "去 GitHub 网页撤销",
      ghConnectBusy: "正在连接，请稍候。",
      ghOneAtATime: "一次只能连接一次，正在连时请别重复点。",
      ghComputerLoginTitle: "电脑上的登录",
      ghComputerLoggedIn: "已登录",
      ghComputerLoggedOut: "未登录",
      ghComputerLoginGuide: "这台电脑还没登录。先登录，再回来看看。",
      ghPermNotChecked: "还没检查权限",
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
      inbox: "📥 Inbox",
      inboxEmpty: "Inbox empty",
      colPlanning: "Planning",
      colAwaiting: "Awaiting approval",
      colBuilding: "Building",
      colReview: "Review",
      colDone: "Done",
      canceled: "Canceled",
      emptyColumn: "—",
      actDispatch: "Hand to AI",
      actApprovePlan: "Approve plan",
      actConfirmCommit: "Confirm commit",
      actCreatePr: "Push branch & create PR",
      actMarkDone: "Mark done",
      setupTitle: "Worktree setup",
      setupPurpose: "Copy local files from the project root and run setup commands inside each new worktree",
      setupCopyLabel: "Files to copy",
      setupCopyHint: "Relative paths copied from the project root into each new worktree; usually git-ignored local files",
      setupEg: "e.g.",
      setupAddPath: "+ Add path",
      setupRemove: "Remove",
      setupCopyEmpty: "No files yet. Leave empty = these local files won't be in the worktree",
      setupPathInvalid: "Path must be relative to the project root, and cannot be absolute, .., .git, or a symlink",
      setupPathMissing: "{path} not found at the project root; skipped on dispatch",
      setupPostLabel: "Run after create",
      setupPostHint: "Command run inside the new worktree; you provide it, the plugin ships no default; failure rolls back the dispatch",
      setupRisk: "Runs on your machine; only use commands you trust",
      setupFollowRepo: "Follow the target repo's own AGENTS.md / CONTRIBUTING for what to install and verify",
      setupLocalFilesHint: "Add local files under 'Files to copy' instead of cp ../ here",
      setupVarsTitle: "Variables available to the command",
      setupVarsEnv: "Injected as environment variables; do not build paths by string concatenation",
      setupVarWorktreePath: "Absolute path of this worktree",
      setupVarWorktreeName: "Worktree name",
      setupVarBranchName: "Branch name",
      setupVarBaseRef: "Base ref",
      setupAdvanced: "Advanced",
      setupTimeout: "Timeout (minutes)",
      setupTimeoutHint: "A timeout aborts and rolls back the dispatch",
      setupPostEmpty: "Leave empty = no extra setup",
      setupSave: "Save",
      setupSaving: "Saving…",
      setupSaved: "Saved",
      setupPreparing: "Preparing worktree…",
      setupRolledBack: "Rolled back: worktree and branch removed",
      wtRootTitle: "Worktrees root",
      wtRootPurpose: "Set the shared location for new projects' worktrees; each project gets its own subdirectory under it",
      wtRootLabel: "Worktrees root (leave blank for default)",
      wtRootPlaceholder: "~/dsh-factory-worktrees",
      wtRootHint: "Leave blank to use the default `~/dsh-factory-worktrees` (resolved from your home directory)",
      wtRootResolved: "Effective now: {path}",
      wtRootScope: "Applies only to worktrees created from now on; existing worktrees are unaffected",
      wtRootDanger: "Worktrees root cannot be inside the DSH data directory",
      // P4 · autonomy & runtime panel
      autoPanelTitle: "Autonomy & runtime",
      autoPanelPurpose: "Level, pause and task count save separately — never together",
      lvTitle: "Autonomy level",
      lvL0: "Manual",
      lvL1: "You approve",
      lvL2: "Machine approves",
      badgeL0: "Manual",
      badgeL1: "You approve",
      badgeL2: "Machine approves",
      badgePaused: "Paused",
      lvSub: "how far the engine goes for you",
      leMachine: "Machine does",
      leYou: "You do",
      leL0M: "Nothing runs on its own — it waits for you at every step.",
      leL0Y: "Dispatch, approve plans and confirm commits yourself.",
      leL1M: "Moves cards up to \"awaiting approval\", then stops.",
      leL1Y: "Approve the plan; only then does the machine continue.",
      leL2M: "Approves plans automatically and pushes through to implementation.",
      leL2Y: "Nothing — switch back to Manual anytime; it never touches git, opens PRs or marks done.",
      prefHead: "Preferences (usually leave as-is)",
      prefNote: "The level sets behavior; switches only record your choice and stay unchanged when you switch levels.",
      unsaved: "Unsaved",
      autoStart: "Auto-start new cards",
      autoApprove: "Auto-approve plans",
      inactiveAtLevel: "unused at this level",
      saveLevel: "Save level",
      l2Title: "Switch to the \"Machine approves\" level?",
      l2Body: "The machine auto-approves plans and keeps implementing, but never touches git, opens a PR or marks work done. Enabled per project, reversible anytime.",
      enableL2: "Enable",
      cancel: "Cancel",
      pauseTitle: "Pause & takeover",
      pauseSub: "immediate human gates",
      projPause: "Pause auto dispatch for this project",
      enginePause: "Pause engine",
      engineResume: "Resume engine",
      engineRunning: "Engine running",
      enginePaused: "Engine paused",
      pauseSem: "Pause stops new work only — running tasks stay, skipped cards aren't retried.",
      takeover: "Take back",
      concTitle: "Tasks at once",
      concSub: "Saved on its own; actual count is the smaller of the two",
      projMaxLabel: "Max tasks at once for this project (maxActiveSessions)",
      globMaxLabel: "Max tasks at once (globalMaxActive)",
      blankDefault: "Leave blank to use the default",
      globHelp: "Across all projects: the most tasks that can run at once. Leave blank for the default. Changes apply immediately and survive a restart.",
      effLabel: "Tasks that can run now",
      effSrc: "Source: {src}; the smaller of the two",
      srcSettings: "saved global setting",
      srcConfig: "deployment config",
      srcDefault: "built-in default",
      saveConc: "Save concurrency",
      saveGlobal: "Save global settings",
      dangerTitle: "Danger zone",
      dangerSub: "this project only",
      deleteHint: "Deletes this project and all its boards, cards and worktrees. This cannot be undone.",
      deleteProject: "Delete project",
      delTitle: "Delete project and its worktrees",
      delBody: "Deletes the project registration and all its worktrees; only worktrees belonging to this project are removed. Dirty worktrees are refused with their change list, and a partial cleanup failure keeps the registration and shows the original error.",
      delType: "Type the project name {name} to confirm",
      delWrong: "Project name does not match — nothing deleted",
      forceHead: "Force-remove worktrees with uncommitted changes (off by default)",
      forceBody: "By default a dirty tree is refused and listed; only tick this when you know the changes can be discarded.",
      delConfirm: "Delete project",
      needsTitle: "Needs attention",
      needsApprove: "plans to approve",
      needsStalled: "stalled cards",
      needsOrphan: "orphan sessions",
      needsEngineErr: "engine error",
      needsClear: "Nothing needs your attention",
      gmInvalid: "Max tasks at once must be a positive integer or null",
      pmInvalid: "Project cap must be a positive integer or null",
      scopeGlobal: "Global",
      scopeGlobalSub: "applies to all projects",
      scopeProject: "Project",
      scopeProjectSub: "this project only",
      globalNote: "Global settings apply to all projects; changes only affect worktrees and scheduling created from now on — existing projects and in-flight cards are untouched.",
      engineGate: "Pause entire engine",
      engineGateHint: "A global pause blocks auto dispatch for all projects; running sessions are untouched. The header engine switch stays in sync.",
      viewDesc: "Cards grouped by stage; we ask you to approve only at key gates.",
      statCards: "Cards",
      statActive: "Live sessions",
      statSlots: "Running now",
      closeSettings: "Close",
      mobileSettings: "Settings",
      mobileTakeover: "Take back",
      mobileApprove: "Approve",
      mobileDispatch: "Hand to AI",
      // P4-github · project GitHub identity card (Design copy — plain words only)
      ghCardTitle: "GitHub connection for this repo",
      ghLocalLabel: "Local folder",
      ghRepoLabel: "GitHub repository",
      ghLinked: "Linked",
      ghExpandPath: "Show full path",
      ghNowUsing: "Now using: {account}",
      ghFrom: "Via: {source}",
      ghUnknownAccount: "Can't tell who right now",
      ghSharedTag: "Shared by all projects",
      srcConnected: "Connected",
      srcComputer: "Signed in on this computer",
      srcSystem: "Set up on this system",
      srcAddedShared: "Added by you",
      srcThisRepo: "This repo only",
      srcNone: "Not connected",
      ghPermOk: "Can access this repo",
      ghPermBad: "Can't access this repo",
      ghCheckPerm: "Check access",
      ghChecking: "Checking…",
      ghConnect: "Connect GitHub",
      ghAddAccount: "Add an account",
      ghGuideNone: "No account connected for this repo. Connect once for all projects, sign in on this computer, or add one yourself.",
      ghGuideNoAccess: "The connected account can't reach this repo. Use one that can, or add one just for this repo.",
      ghKeepOpen: "Keep this page open while connecting",
      ghStepOpen: "Open this link",
      ghStepCode: "Sign in, then enter the code you see",
      ghStepConnecting: "Connecting…",
      ghStepDone: "Connected — all projects can use it",
      ghScopeTitle: "Who should use this account?",
      ghScopeAll: "All projects",
      ghScopeRepo: "This repo only",
      ghScopeHint: "\"All projects\" also covers projects you create later; \"This repo only\" affects just this one.",
      ghAppIdLabel: "Connection app ID",
      ghAppIdHint: "Create a connection app in your GitHub and paste its ID here. Set up once for all projects.",
      ghChangeSharedConfirm: "This changes the account all projects use. Continue?",
      ghSaveAppId: "Save ID",
      ghAccountLabel: "Your sign-in details",
      ghAccountHint: "Enter your own sign-in details; they are stored under your account only and never shown again.",
      ghSaveAccount: "Save",
      ghSaved: "Saved",
      // P4-github increment · global account management (Design §7.7)
      ghConnectState: "Connection: {state}",
      ghStateOn: "Connected",
      ghStateOff: "Not connected",
      ghReconnect: "Reconnect",
      ghDisconnect: "Disconnect this device",
      ghDisconnectDone: "Disconnected on this device.",
      ghRevokeGuide: "To fully revoke access, remove this app's permission on the GitHub website.",
      ghRevokeLink: "Revoke on GitHub",
      ghConnectBusy: "Connecting, please wait.",
      ghOneAtATime: "Only one connection at a time — don't tap again while connecting.",
      ghComputerLoginTitle: "Sign-in on this computer",
      ghComputerLoggedIn: "Signed in",
      ghComputerLoggedOut: "Not signed in",
      ghComputerLoginGuide: "This computer isn't signed in. Sign in, then come back.",
      ghPermNotChecked: "Access not checked yet",
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
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: T.muted } }, [
        label,
        h('input', {
          key: 'input', value, placeholder,
          onChange: (event) => onChange(event.target.value),
          style: { padding: '6px 8px', border: `1px solid ${T.line}`, borderRadius: 6, background: T.card, color: T.ink, fontSize: 13 },
        }),
      ])
    }

    function Button({ children, onClick, disabled }) {
      return h('button', {
        onClick, disabled,
        style: { padding: '6px 12px', borderRadius: 6, border: `1px solid ${T.line}`, background: T.card, color: T.ink, fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1 },
      }, children)
    }

    function Card({ card }) {
      const accent = STATUS_ACCENT[card.status] || T.muted
      const meta = (card.source && card.source !== 'manual' ? `${card.source} · ` : '') + card.status
      return h('div', {
        className: 'df-card',
        style: { background: T.card, border: `1px solid ${T.line}`, borderLeft: `3px solid ${accent}`, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 },
      }, [
        h('div', { key: 'title', style: { fontSize: 13, color: T.ink, fontWeight: 500 } }, card.title),
        h('div', { key: 'meta', style: { fontSize: 11, color: T.muted } }, meta),
      ])
    }

    // Per-card action buttons. Each drives the gated backend (authorize, then the
    // git action, or a human transition); the backend refuses anything not armed,
    // so the UI can never bypass the approval gate even if a button is mis-clicked.
    function CardActions({ card, run, t }) {
      const buttons = []
      const add = (label, fn) => buttons.push(h(Button, { key: label, onClick: () => void run(fn) }, label))
      if (card.status === 'inbox') add(t('actDispatch'), async () => { await callApi('POST', `/cards/${card.id}/dispatch`) })
      if (card.status === 'plan-review') add(t('actApprovePlan'), async () => { await callApi('POST', `/cards/${card.id}/transition`, { to: 'build', actor: 'human' }) })
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
      return h('div', { className: 'df-col', style: { flex: '1 1 0', minWidth: 140, background: T.panel, borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 } }, [
        h('div', { key: 'head', style: { fontSize: 12, fontWeight: 600, color: T.muted, display: 'flex', justifyContent: 'space-between' } }, [
          h('span', { key: 'label' }, title),
          h('span', { key: 'count' }, String(cards.length)),
        ]),
        cards.length === 0
          ? h('div', { key: 'empty', style: { fontSize: 12, color: T.muted } }, t('emptyColumn'))
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

      const small = { fontSize: 12, color: T.muted, lineHeight: 1.6 }
      const box = { background: T.panel, border: `1px solid ${T.line}`, borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }
      const inputStyle = { padding: '6px 8px', border: `1px solid ${T.line}`, borderRadius: 6, background: T.card, color: T.ink, fontSize: 13, width: '100%', boxSizing: 'border-box' }
      const chip = { padding: '3px 8px', borderRadius: 12, border: `1px solid ${T.line}`, background: T.card, color: T.info, fontSize: 12, cursor: 'pointer' }

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
                h('button', { key: 'rm', type: 'button', style: { ...chip, color: T.muted }, onClick: () => setPaths(paths.filter((_, i) => i !== index)) }, t('setupRemove')),
                bad ? h('div', { key: 'err', style: { ...small, color: T.danger, flexBasis: '100%' } }, t('setupPathInvalid')) : null,
              ].filter(Boolean))
            })),
        h('button', { key: 'add', type: 'button', style: { ...chip, alignSelf: 'flex-start' }, onClick: () => setPaths([...paths, '']) }, t('setupAddPath')),
        h('div', { key: 'postLabel', style: { fontSize: 13, color: T.ink, fontWeight: 500 } }, t('setupPostLabel')),
        h('div', { key: 'postHint', style: small }, t('setupPostHint')),
        h('div', { key: 'risk', style: { ...small, color: T.warning } }, `${t('setupRisk')} · ${t('setupFollowRepo')}`),
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
            h('code', { key: `${name}-k`, style: { color: T.info } }, name),
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
          error ? h('span', { key: 'err', style: { ...small, color: T.danger } }, `${t('errorPrefix')}${error}`) : null,
          touched && invalid ? h('span', { key: 'inv', style: { ...small, color: T.danger } }, t('setupPathInvalid')) : null,
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

      const small = { fontSize: 12, color: T.muted, lineHeight: 1.6 }
      const inputStyle = { padding: '6px 8px', border: `1px solid ${T.line}`, borderRadius: 6, background: T.card, color: T.ink, fontSize: 13, width: '100%', boxSizing: 'border-box' }
      return h('div', { key: 'wtRoot', style: { background: T.panel, border: `1px solid ${T.line}`, borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 } }, [
        h('div', { key: 'label', style: { fontSize: 13, color: T.ink, fontWeight: 500 } }, t('wtRootLabel')),
        h('div', { key: 'purpose', style: small }, t('wtRootPurpose')),
        h('input', {
          key: 'input', value, placeholder: t('wtRootPlaceholder'), spellCheck: false,
          style: inputStyle, onChange: (event) => setValue(event.target.value),
        }),
        h('div', { key: 'hint', style: small }, t('wtRootHint')),
        h('div', { key: 'resolved', style: { ...small, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, t('wtRootResolved', { path: resolved || '—' })),
        h('div', { key: 'scope', style: small }, t('wtRootScope')),
        h('div', { key: 'danger', style: { ...small, color: T.warning } }, t('wtRootDanger')),
        h('div', { key: 'saveRow', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h(Button, { key: 'save', disabled: saving, onClick: () => void save() }, saving ? t('setupSaving') : t('setupSave')),
          message ? h('span', { key: 'ok', style: { ...small, color: T.success } }, message) : null,
          error ? h('span', { key: 'err', style: { ...small, color: T.danger } }, `${t('errorPrefix')}${error}`) : null,
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
          style: { background: T.card, borderRadius: 12, width: '100%', maxWidth: 480, boxShadow: '0 24px 70px rgba(10,16,24,.28)', overflow: 'hidden' },
        }, [
          h('div', { style: { padding: '16px 18px 12px', borderBottom: `1px solid ${T.line}` } },
            h('h3', { style: { margin: 0, fontSize: 15, color: tone === 'danger' ? T.danger : T.ink } }, title)),
          h('div', { style: { padding: '14px 18px', fontSize: 13, color: T.muted, lineHeight: 1.7 } }, children),
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

      const small = { fontSize: 12, color: T.muted, lineHeight: 1.6 }
      // Selected segment uses a soft brand wash + coloured label (Design #1):
      // L0 grey, L1 blue, L2 orange — never a solid blue fill.
      const segTone = { L0: [T.grayWash, T.gray], L1: [T.blueWash, T.blue], L2: [T.orangeWash, T.orange] }
      const segBtn = (lv) => {
        const on = level === lv
        const [wash, ink] = segTone[lv]
        return {
          padding: '7px 12px', borderRadius: 6, border: `1px solid ${on ? ink : T.line}`,
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
        h('span', { style: { ...small, color: inactive ? T.muted : T.ink, fontWeight: 600 } }, t(label)),
        inactive ? h('span', { style: { fontSize: 10.5, color: T.muted, background: T.panel, borderRadius: 5, padding: '2px 7px' } }, t('inactiveAtLevel')) : null,
      ])

      // Explain card: two fixed lines — "machine does / you do" — that follow the
      // PENDING choice so a first-time reader can tell what each level means.
      const explainer = h('div', {
        key: 'explain',
        style: { background: T.accentWash, border: `1px solid ${T.line}`, borderLeft: `3px solid ${T.accent}`, borderRadius: 8, padding: '10px 12px', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 },
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
            ? h('span', { key: 'paused', style: { display: 'inline-flex', gap: 6, alignItems: 'center', padding: '5px 12px', borderRadius: 999, fontSize: 12, fontWeight: 650, background: T.panel, color: T.muted } },
              [h('span', { key: 'dot', style: { width: 7, height: 7, borderRadius: '50%', background: 'currentColor' } }), t('badgePaused')])
            : null,
          // The badge block ends with the unsaved marker; it shows only the saved
          // level, never the preference switches below.
          dirty ? h('span', { key: 'rb', style: { fontSize: 11, color: T.warning, fontWeight: 600 } }, t('unsaved')) : null,
        ]),
        explainer,
        h('button', {
          key: 'prefToggle', type: 'button',
          style: { background: 'transparent', border: 'none', color: T.muted, fontSize: 12, cursor: 'pointer', textAlign: 'left', padding: '10px 0 0', minHeight: 44 },
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
          error ? h('span', { key: 'err', style: { ...small, color: T.danger, whiteSpace: 'pre-line' } }, `${t('errorPrefix')}${error}`) : null,
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
      const small = { fontSize: 12, color: T.muted, lineHeight: 1.6 }
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
          h('span', { key: 'b', className: 'df-tap' }, h(Button, { disabled: saving, onClick: () => void toggle() }, paused ? t('engineResume') : t('enginePause'))),
        ]),
        h('div', { key: 'sem', style: small }, t('pauseSem')),
        h('div', { key: 'takeHint', style: small }, t('takeover') + ' · ' + t('pauseSub')),
        message ? h('div', { key: 'ok', style: { ...small, color: T.success } }, message) : null,
        error ? h('div', { key: 'err', style: { ...small, color: T.danger } }, `${t('errorPrefix')}${error}`) : null,
      ])
    }

    // P4-github · global "connection app ID" (non-secret client_id). Lives in
    // settings, not a credential; UI calls it a "连接用的应用编号" in plain words.
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
      const small = { fontSize: 12, color: T.muted, lineHeight: 1.6 }
      const inputStyle = { padding: '6px 8px', border: `1px solid ${T.line}`, borderRadius: 6, background: T.card, color: T.ink, fontSize: 13, width: '100%', boxSizing: 'border-box' }
      return h('div', { key: 'appId', style: { background: T.card, border: `1px solid ${T.line}`, borderRadius: 8, padding: 12, marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 } }, [
        h('div', { key: 'label', style: { fontSize: 13, color: T.ink, fontWeight: 600 } }, t('ghAppIdLabel')),
        h('div', { key: 'hint', style: small }, t('ghAppIdHint')),
        h('input', {
          key: 'input', value, spellCheck: false, onChange: (event) => setValue(event.target.value),
          placeholder: t('ghAppIdLabel'), style: inputStyle,
        }),
        h('div', { key: 'row', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h(Button, { key: 'save', disabled: saving, onClick: () => void save() }, saving ? t('setupSaving') : t('ghSaveAppId')),
          message ? h('span', { key: 'ok', style: { ...small, color: T.success } }, message) : null,
          error ? h('span', { key: 'err', style: { ...small, color: T.danger } }, `${t('errorPrefix')}${error}`) : null,
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

      const small = { fontSize: 12, color: T.muted, lineHeight: 1.6 }
      const connected = oauth?.connected === true
      const inFlight = oauth?.inFlight === true || connecting
      const stateText = connected ? t('ghStateOn') : t('ghStateOff')

      return h('div', { key: 'acctMgr', style: { background: T.card, border: `1px solid ${T.line}`, borderRadius: 8, padding: 12, marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 } }, [
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
          disconnected ? h('div', { key: 'disc', style: { ...small, color: T.success, background: T.accentWash, borderRadius: 6, padding: '7px 9px' } }, [
            h('div', { key: 'd1' }, t('ghDisconnectDone')),
            h('div', { key: 'd2', style: { marginTop: 4 } }, t('ghRevokeGuide')),
            revokeUrl ? h('a', { key: 'd3', href: revokeUrl, target: '_blank', rel: 'noreferrer', style: { display: 'inline-block', marginTop: 5, color: T.accent } }, t('ghRevokeLink')) : null,
          ]) : null,
          // In-flight connect: three steps + keep-open note, one-at-a-time guard
          connecting ? h('div', { key: 'conn', style: { ...small, background: T.panel, borderRadius: 6, padding: '7px 9px' } }, [
            h('div', { key: 'keep', style: { color: T.warning } }, t('ghKeepOpen')),
            h('div', { key: 'one', style: { marginTop: 3 } }, t('ghOneAtATime')),
            h('div', { key: 's', style: { marginTop: 3, color: T.ink } },
              step === 'code' || step === 'connecting' ? t('ghStepCode') : t('ghStepOpen')),
            notice?.url ? h('a', { key: 'url', href: notice.url, target: '_blank', rel: 'noreferrer', style: { display: 'inline-block', marginTop: 4, color: T.accent } }, t('ghStepOpen')) : null,
            notice?.code ? h('div', { key: 'code', style: { marginTop: 5, fontSize: 19, fontWeight: 700, letterSpacing: 2, fontFamily: 'ui-monospace, monospace', color: T.ink } }, notice.code) : null,
            pendingPrompt ? h('span', { key: 'go', className: 'df-tap' }, h(Button, { disabled: busy, onClick: () => void answer('done') }, t('ghStepDone'))) : null,
            step === 'connecting' ? h('div', { key: 'wait', style: { marginTop: 4 } }, t('ghStepConnecting')) : null,
            h('span', { key: 'cx', className: 'df-tap' }, h(Button, { disabled: busy, onClick: () => void cancel(), style: { marginTop: 6, padding: '4px 9px' } }, t('cancel'))),
          ]) : null,
          error ? h('div', { key: 'err', style: { ...small, color: T.danger, whiteSpace: 'pre-line' } }, `${t('errorPrefix')}${error}`) : null,
        ]),
        // gh CLI status — shown whether logged in or not (PGH-21), read-only
        h('div', { key: 'ghcli', style: { borderTop: `1px solid ${T.line}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 5 } }, [
          h('div', { key: 'title', style: { fontSize: 12.5, fontWeight: 600, color: T.ink } }, t('ghComputerLoginTitle')),
          h('div', { key: 'st', style: small }, ghcli === null
            ? t('ghChecking')
            : (ghcli.loggedIn
              ? `${t('ghComputerLoggedIn')}${ghcli.login ? ` · ${ghcli.login}` : ''}`
              : t('ghComputerLoggedOut'))),
          ghcli !== null && !ghcli.loggedIn ? h('div', { key: 'guide', style: { ...small, color: T.warning } }, t('ghComputerLoginGuide')) : null,
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
      const small = { fontSize: 12, color: T.muted, lineHeight: 1.6 }
      const eff = settings?.effectiveGlobalMaxActive
      return h('div', { key: 'globalCap', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
        h('div', { key: 'label', style: { fontSize: 13, color: T.ink, fontWeight: 500 } }, t('globMaxLabel')),
        h('input', {
          key: 'in', inputMode: 'numeric', value, spellCheck: false, placeholder: t('blankDefault'),
          style: { padding: '6px 8px', border: `1px solid ${T.line}`, borderRadius: 6, background: T.card, color: T.ink, fontSize: 13, width: '100%', boxSizing: 'border-box' },
          onChange: (e) => setValue(e.target.value),
        }),
        h('div', { key: 'help', style: small }, t('globHelp')),
        eff ? h('div', { key: 'eff', style: { ...small, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } },
          `${t('effLabel')}: ${eff.value} · ${t('src' + (eff.source === 'settings' ? 'Settings' : eff.source === 'config' ? 'Config' : 'Default'))}`) : null,
        h('div', { key: 'save', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h('span', { key: 'btn', className: 'df-tap' }, h(Button, { disabled: saving, onClick: () => void save() }, saving ? t('setupSaving') : t('saveGlobal'))),
          message ? h('span', { key: 'ok', style: { ...small, color: T.success } }, message) : null,
          error ? h('span', { key: 'err', style: { ...small, color: T.danger } }, `${t('errorPrefix')}${error}`) : null,
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
      const small = { fontSize: 12, color: T.muted, lineHeight: 1.6 }
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
          style: { padding: '6px 8px', border: `1px solid ${T.line}`, borderRadius: 6, background: T.card, color: T.ink, fontSize: 13, width: '100%', boxSizing: 'border-box' },
          onChange: (e) => setValue(e.target.value),
        }),
        h('div', { key: 'help', style: small }, t('blankDefault')),
        h('div', { key: 'eff', style: { ...small, background: T.panel, border: `1px solid ${T.line}`, borderRadius: 6, padding: '8px 10px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, [
          h('div', { key: 'v' }, `${t('effLabel')}: ${effective ?? '—'}`),
          h('div', { key: 's', style: { opacity: .85 } }, t('effSrc', { src: globalSrc })),
        ]),
        h('div', { key: 'save', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h('span', { key: 'btn', className: 'df-tap' }, h(Button, { disabled: saving, onClick: () => void save() }, saving ? t('setupSaving') : t('saveConc'))),
          message ? h('span', { key: 'ok', style: { ...small, color: T.success } }, message) : null,
          error ? h('span', { key: 'err', style: { ...small, color: T.danger } }, `${t('errorPrefix')}${error}`) : null,
        ]),
      ])
    }

    function DangerSection({ project, t, onDeleted }) {
      const [confirm, setConfirm] = useState(false)
      const [typed, setTyped] = useState('')
      const [force, setForce] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const small = { fontSize: 12, color: T.muted, lineHeight: 1.6 }
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
            style: { borderColor: T.danger, color: T.danger },
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
            style: { padding: '7px 9px', border: `1px solid ${T.line}`, borderRadius: 6, background: T.card, color: T.ink, fontSize: 13, width: '100%', boxSizing: 'border-box' },
            onChange: (e) => setTyped(e.target.value),
          }),
          h('label', { key: 'force', style: { display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 12, cursor: 'pointer' } }, [
            h('input', { key: 'cb', type: 'checkbox', checked: force, onChange: (e) => setForce(e.target.checked), style: { marginTop: 3 } }),
            h('span', { key: 'ft' }, [
              h('b', { key: 'h', style: { color: T.danger } }, t('forceHead')),
              h('br', { key: 'br' }), t('forceBody'),
            ]),
          ]),
          error ? h('div', { key: 'err', style: { ...small, color: T.danger, marginTop: 10 } }, `${t('errorPrefix')}${error}`) : null,
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

      const small = { fontSize: 12, color: T.muted, lineHeight: 1.6 }
      const id = card?.identity || {}
      const binding = card?.binding || {}
      const sourceLabel = id.source && SRC_LABEL[id.source] ? t(SRC_LABEL[id.source]) : t('srcNone')
      const pathText = (v) => {
        if (!v) return '—'
        return !expanded && v.length > 46 ? `${v.slice(0, 22)}…${v.slice(-18)}` : v
      }

      return h('div', { key: 'identity', style: { background: T.card, border: `1px solid ${T.line}`, borderRadius: T.radiusLg, boxShadow: T.shadow, overflow: 'hidden' } }, [
        // Header
        h('div', { key: 'h', style: { padding: '10px 13px', borderBottom: `1px solid ${T.line}`, fontSize: 13, fontWeight: 650, color: T.ink } }, t('ghCardTitle')),
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
                h('span', { key: 'txt', style: { fontSize: 11.5, color: perm === 'ok' ? T.green : (perm === 'insufficient' ? T.danger : T.muted) } },
                  // Neutral text when connected-but-not-yet-checked: "来源：xxx"
                  // already renders in its own line above — don't repeat it here.
                  checking ? t('ghChecking')
                    : (perm === 'ok' ? t('ghPermOk')
                      : (perm === 'insufficient' ? t('ghPermBad')
                        : (id.connected ? t('ghPermNotChecked') : t('ghGuideNone')))),
                ),
                id.connected && !checking ? h('span', { key: 'chk', className: 'df-tap' }, h(Button, { onClick: () => void checkPermission(), disabled: busy, style: { padding: '3px 9px', fontSize: 11 } }, t('ghCheckPerm'))) : null,
              ]),
              perm === 'insufficient' && permReason ? h('div', { key: 'pr', style: { ...small, color: T.danger, whiteSpace: 'pre-line', background: T.dangerWash, borderRadius: 6, padding: '6px 8px' } }, permReason) : null,
              perm === 'insufficient' ? h('div', { key: 'gd', style: { ...small, marginTop: 2 } }, t('ghGuideNoAccess')) : null,
            ]),
            // ③ actions + ④ not-connected guidance
            h('div', { key: 'acts', style: { display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 10, borderTop: `1px solid ${T.line}` } }, [
              h('span', { key: 'c', className: 'df-tap' }, h(Button, { onClick: () => void beginConnect(), disabled: busy }, t('ghConnect'))),
              h('span', { key: 'a', className: 'df-tap' }, h(Button, { onClick: openAdd, disabled: busy }, t('ghAddAccount'))),
            ]),
            !id.connected ? h('div', { key: 'guide', style: { ...small, marginTop: 8, background: T.panel, borderRadius: 6, padding: '7px 9px' } }, t('ghGuideNone')) : null,
          ]),
          error ? h('div', { key: 'err', style: { ...small, color: T.danger, whiteSpace: 'pre-line', marginTop: 6 } }, `${t('errorPrefix')}${error}`) : null,
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
            style: { padding: '7px 9px', border: `1px solid ${T.line}`, borderRadius: 6, background: T.card, color: T.ink, fontSize: 13, width: '100%', boxSizing: 'border-box', marginTop: 8 },
          }),
          h('div', { key: 'scope', style: { marginTop: 14 } }, [
            h('div', { key: 'st', style: { fontSize: 12, fontWeight: 600, color: T.ink, marginBottom: 4 } }, t('ghScopeTitle')),
            h('div', { key: 'seg', style: { display: 'flex', gap: 6 } }, [
              h(Button, { key: 'all', onClick: () => setScope('global'), style: scope === 'global' ? { background: T.accentWash, borderColor: T.accent, color: T.accentInk, fontWeight: 600 } : {} }, t('ghScopeAll')),
              h(Button, { key: 'repo', onClick: () => setScope('project'), style: scope === 'project' ? { background: T.accentWash, borderColor: T.accent, color: T.accentInk, fontWeight: 600 } : {} }, t('ghScopeRepo')),
            ]),
            h('div', { key: 'sh', style: { ...small, marginTop: 7 } }, t('ghScopeHint')),
            scope === '' ? h('div', { key: 'need', style: { ...small, color: T.warning, marginTop: 5 } }, t('ghScopeTitle')) : null,
          ]),
          error ? h('div', { key: 'err', style: { ...small, color: T.danger, whiteSpace: 'pre-line', marginTop: 8 } }, `${t('errorPrefix')}${error}`) : null,
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
          h('div', { key: 'keep', style: { ...small, color: T.warning, marginBottom: 10 } }, t('ghKeepOpen')),
          h('ol', { key: 'steps', style: { margin: 0, paddingLeft: 20, ...small } }, [
            h('li', { key: 's1', style: step ? { color: T.ink } : {} }, t('ghStepOpen')),
            h('li', { key: 's2', style: step === 'code' || step === 'connecting' || step === 'done' ? { color: T.ink } : {} }, t('ghStepCode')),
            h('li', { key: 's3', style: step === 'connecting' || step === 'done' ? { color: T.ink } : {} }, t('ghStepConnecting')),
          ]),
          notice?.url ? h('div', { key: 'url', style: { marginTop: 10, fontSize: 12, wordBreak: 'break-all' } },
            h('a', { href: notice.url, target: '_blank', rel: 'noreferrer', style: { color: T.accent } }, t('ghStepOpen'))) : null,
          notice?.code ? h('div', { key: 'code', style: { marginTop: 8, fontSize: 20, fontWeight: 700, letterSpacing: 2, fontFamily: 'ui-monospace, monospace', color: T.ink } }, notice.code) : null,
          pendingPrompt ? h('span', { key: 'go', className: 'df-tap' }, h(Button, { onClick: () => void answerConnect('done'), disabled: busy }, t('ghStepDone'))) : null,
          step === 'done' ? h('div', { key: 'done', style: { ...small, color: T.green, marginTop: 8 } }, t('ghStepDone')) : null,
          error ? h('div', { key: 'err', style: { ...small, color: T.danger, whiteSpace: 'pre-line', marginTop: 8 } }, `${t('errorPrefix')}${error}`) : null,
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
            background: paused ? T.orangeWash : 'var(--df-green-wash, #e8f6ef)', color: paused ? T.orange : T.green },
        }, [h('span', { key: 'dot', style: { width: 7, height: 7, borderRadius: '50%', background: 'currentColor' } }), t(paused ? 'enginePaused' : 'engineRunning')]),
        h('span', { key: 'btn', className: 'df-tap' }, h(Button, { disabled: busy, onClick: () => void toggle() }, paused ? t('engineResume') : t('enginePause'))),
        error ? h('span', { key: 'err', style: { fontSize: 12, color: T.danger } }, `${t('errorPrefix')}${error}`) : null,
      ])
    }

    function NeedsAttention({ t, engine, cards }) {
      const approvable = cards.filter((card) => card.status === 'plan-review' && card.takenOver !== true).length
      const stalled = cards.filter((card) => card.stalled === true).length
      const orphans = engine?.orphans?.length ?? 0
      const lastError = engine?.lastError ?? null
      const total = approvable + stalled + orphans + (lastError ? 1 : 0)
      // Chips carry type colour (Design #5): approve/orphans orange, stalled/error
      // red. The empty state stays a quiet green-bordered strip.
      const chip = (key, label, value, tone) => {
        const ink = tone === 'danger' ? T.danger : T.orange
        const wash = tone === 'danger' ? T.dangerWash : T.orangeWash
        return h('span', { key, style: { fontSize: 11, color: ink, background: wash, border: `1px solid ${ink}`, borderRadius: 6, padding: '3px 8px' } },
          `${label} ${value}`)
      }
      return h('div', {
        key: 'attention',
        style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', background: T.card, border: `1px solid ${T.line}`, borderLeft: `3px solid ${total > 0 ? T.orange : T.green}`, borderRadius: 8, padding: '8px 12px' },
      }, [
        h('span', { key: 'title', style: { fontSize: 12.5, fontWeight: 700 } }, `${t('needsTitle')} · ${total}`),
        total === 0 ? h('span', { key: 'clear', style: { fontSize: 12, color: T.muted } }, t('needsClear')) : null,
        approvable > 0 ? chip('a', t('needsApprove'), approvable, 'warn') : null,
        stalled > 0 ? chip('s', t('needsStalled'), stalled, 'danger') : null,
        orphans > 0 ? chip('o', t('needsOrphan'), orphans, 'warn') : null,
        lastError ? chip('e', t('needsEngineErr'), '1', 'danger') : null,
      ].filter(Boolean))
    }

    // One-time scoped stylesheet for the mobile action bar, 44px tap targets and
    // bottom-sheet confirm dialog. Injected via the host document, never a build
    // step; selectors are scoped to this plugin's root attribute.
    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById('dsh-factory-p4-css')) return
      const css = [
        // P4 brand tokens, scoped to this view only — never alter the host theme.
        '[data-dsh-factory-p4]{--df-accent:#4f46d5;--df-accent-wash:#eef0ff;--df-accent-ink:#3b33b8;--df-blue:#2f7de1;--df-blue-wash:#eaf2fe;--df-orange:#c9771f;--df-orange-wash:#fdf1e3;--df-green:#1f8f63;--df-gray:#8b95a5;--df-gray-wash:#f1f3f6;--df-danger-wash:#fdf0f1;--df-radius:11px;--df-radius-sm:7px;--df-shadow:0 1px 2px rgba(20,28,40,.04),0 6px 20px rgba(20,28,40,.04)}',
        // Unified card treatment (Design #2/#3): rounded, layered, radius system.
        '[data-dsh-factory-p4] .df-card{border-radius:var(--df-radius, 11px);box-shadow:var(--df-shadow, 0 1px 2px rgba(20,28,40,.04),0 6px 20px rgba(20,28,40,.04))}',
        // Large containers share the 11px radius; controls share 7px (Design #3).
        '[data-dsh-factory-p4] .df-col,[data-dsh-factory-p4] .df-group,[data-dsh-factory-p4] .df-inbox{border-radius:var(--df-radius, 11px)!important}',
        '[data-dsh-factory-p4] input,[data-dsh-factory-p4] textarea,[data-dsh-factory-p4] select{border-radius:var(--df-radius-sm, 7px)!important}',
        '[data-dsh-factory-p4] .df-mobar{display:none}',
        '[data-dsh-factory-p4] .df-tap button,[data-dsh-factory-p4] button.df-tap{min-height:44px}',
        '[data-dsh-factory-p4] .df-board{display:flex;gap:8px;align-items:flex-start;overflow-x:auto}',
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
        '  [data-dsh-factory-p4] .df-board{max-height:42vh;overflow-y:auto}',
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
      const [boardId, setBoardId] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [newProject, setNewProject] = useState({ name: '', rootPath: '' })
      const [newBoardName, setNewBoardName] = useState('')
      const [newCardTitle, setNewCardTitle] = useState('')
      const [drawerOpen, setDrawerOpen] = useState(false)
      const [scope, setScope] = useState('global')
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
      const projectBoards = boards.filter((entry) => entry.projectId === projectId)
      const board = projectBoards.find((entry) => entry.id === boardId) || projectBoards[0] || null
      const boardCards = board ? cards.filter((entry) => entry.boardId === board.id) : []
      const inboxCards = boardCards.filter((entry) => entry.status === 'inbox')
      const canceledCards = boardCards.filter((entry) => entry.status === 'canceled')

      const run = async (fn) => {
        setBusy(true); setError('')
        try { await fn(); await load() } catch (err) { setError(err.message) } finally { setBusy(false) }
      }

      const renderCard = (card) => h('div', { key: card.id, style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
        h(Card, { key: 'card', card }),
        h(CardActions, { key: 'actions', card, run, t }),
      ])

      const selectStyle = { padding: '6px 8px', border: `1px solid ${T.line}`, borderRadius: 6, background: T.card, color: T.ink, fontSize: 13 }
      const children = []

      // One block of the project settings accordion (single-open). Mounted only
      // when open so a stale pending level never hides in a collapsed panel.
      const block = (key, num, titleKey, subKey, tone, body) => h('div', {
        key, className: 'df-group', style: { background: T.card, border: `1px solid ${T.line}`, borderRadius: 8, marginBottom: 10, overflow: 'hidden' },
      }, [
        h('button', {
          type: 'button', onClick: () => setOpenBlock(openBlock === key ? '' : key),
          style: { width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '11px 13px', background: 'transparent', border: 'none', color: T.ink, cursor: 'pointer', textAlign: 'left', minHeight: 44 },
        }, [
          h('span', { key: 'bar', style: { width: 3, height: 17, borderRadius: 2, background: tone === 'danger' ? T.danger : tone === 'warn' ? T.warning : T.info } }),
          h('span', { key: 't', style: { fontSize: 13, fontWeight: 650 } }, t(titleKey)),
          subKey ? h('span', { key: 's', style: { fontSize: 11, color: T.muted } }, t(subKey)) : null,
          h('span', { key: 'c', style: { marginLeft: 'auto', color: T.muted } }, openBlock === key ? '▾' : '▸'),
        ]),
        openBlock === key ? h('div', { key: 'b', style: { borderTop: `1px solid ${T.line}`, padding: '12px 13px' } }, body) : null,
      ])

      // Shared page shell: every branch (empty / no-board / full) gets the config
      // drawer, its scrim and the mobile action bar. Keeps the board the first-class
      // citizen while config lives off-canvas (P4-0).
      const renderPage = () => h('div', { 'data-dsh-factory-p4': '1', style: { display: 'flex', flexDirection: 'column', gap: 12, padding: 4, position: 'relative' } }, [
        h('div', { key: 'main', style: { display: 'flex', flexDirection: 'column', gap: 12 } }, children),
        // Scrim + right-side config drawer.
        drawerOpen ? h('div', {
          key: 'scrim', onClick: () => setDrawerOpen(false),
          style: { position: 'fixed', inset: 0, background: 'rgba(18,24,32,.34)', zIndex: 40 },
        }) : null,
        h('aside', {
          key: 'drawer', 'aria-label': t('mobileSettings'),
          style: { position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(500px,94vw)', background: T.panel, zIndex: 50,
            transform: drawerOpen ? 'translateX(0)' : 'translateX(102%)', transition: 'transform .24s cubic-bezier(.2,.7,.2,1)',
            boxShadow: '-18px 0 50px rgba(16,22,30,.18)', display: 'flex', flexDirection: 'column' },
        }, [
          h('div', { key: 'dh', style: { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', background: T.card, borderBottom: `1px solid ${T.line}` } }, [
            h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 650, flex: 1 } }, t('mobileSettings')),
            h(Button, { onClick: () => setDrawerOpen(false), style: { padding: '4px 10px', minHeight: 44 } }, t('closeSettings')),
          ]),
          h('div', { key: 'tabs', style: { display: 'flex', gap: 4, padding: '10px 16px 0', background: T.card, borderBottom: `1px solid ${T.line}` } }, [
            h('button', {
              type: 'button', onClick: () => setScope('global'),
              style: { border: 'none', background: 'transparent', color: scope === 'global' ? T.info : T.muted, fontSize: 13, fontWeight: 650, padding: '9px 14px', borderBottom: scope === 'global' ? `2px solid ${T.info}` : '2px solid transparent', minHeight: 44 },
            }, `${t('scopeGlobal')} · ${t('scopeGlobalSub')}`),
            h('button', {
              type: 'button', onClick: () => setScope('project'),
              style: { border: 'none', background: 'transparent', color: scope === 'project' ? T.info : T.muted, fontSize: 13, fontWeight: 650, padding: '9px 14px', borderBottom: scope === 'project' ? `2px solid ${T.info}` : '2px solid transparent', minHeight: 44 },
            }, `${t('scopeProject')} · ${t('scopeProjectSub')}`),
          ]),
          h('div', { key: 'body', style: { overflow: 'auto', padding: '14px 16px 40px', flex: 1 } },
            scope === 'global'
              ? h('div', { key: 'gp' }, [
                  h('div', { key: 'note', style: { fontSize: 12, color: T.muted, background: T.card, border: `1px solid ${T.line}`, borderRadius: 8, padding: '8px 10px', marginBottom: 12 } }, t('globalNote')),
                  h(WorktreesRootSetting, { key: 'wr', t }),
                  h(AppIdSetting, { key: 'appid', t, settings, onSaved: () => void load() }),
                  // Global account management — OAuth connect/reconnect/disconnect
                  // + gh CLI status, all machine-level (Design §7, PGH-19~21).
                  h(AccountManager, { key: 'acctmgr', t, onChanged: () => void load() }),
                  h('div', { key: 'gc', style: { background: T.card, border: `1px solid ${T.line}`, borderRadius: 8, padding: 12, marginTop: 12 } }, [
                    h(GlobalCapSection, { key: 'gcap', t, settings, onSaved: () => void load() }),
                    h('div', { key: 'rule', style: { height: 1, background: T.line, margin: '14px 0' } }),
                    h(EngineBar, { key: 'egate', t, engine, onChanged: () => void load() }),
                    h('div', { key: 'hint', style: { fontSize: 12, color: T.muted, marginTop: 8 } }, t('engineGateHint')),
                  ]),
                ])
              : (project
                  ? h('div', { key: 'pp' }, [
                      h('div', { key: 'note', style: { fontSize: 12, color: T.muted, background: T.card, border: `1px solid ${T.line}`, borderRadius: 8, padding: '8px 10px', marginBottom: 12 } }, `${t('scopeProjectSub')} · ${project.name}`),
                      // Identity card FIRST — the prerequisite for "can this repo
                      // work at all" (Design §1), ahead of the settings blocks.
                      h('div', { key: 'idcard', style: { marginBottom: 12 } },
                        h(IdentityCard, { key: `${project.id}:identity`, project, t, onChanged: () => void load() })),
                      block('prep', '01', 'setupTitle', 'setupPurpose', 'info', h(WorktreeSetup, { key: `${project.id}:setup`, project, t, onSaved: () => void load() })),
                      block('autonomy', '02', 'autoPanelTitle', 'autoPanelPurpose', 'warn', h(AutonomySection, { key: `${project.id}:autonomy`, project, t, onSaved: () => void load() })),
                      block('pause', '03', 'pauseTitle', 'pauseSub', 'info', h(PauseSection, { key: `${project.id}:pause`, project, t, onSaved: () => void load() })),
                      block('conc', '04', 'concTitle', 'concSub', 'info', h(ConcurrencySection, { key: `${project.id}:conc`, project, t, settings, onSaved: () => void load() })),
                      block('danger', '05', 'dangerTitle', 'dangerSub', 'danger', h(DangerSection, { key: `${project.id}:danger`, project, t, onDeleted: () => { setDrawerOpen(false); setProjectId(''); void load() } })),
                    ])
                  : h('div', { key: 'pn', style: { fontSize: 13, color: T.muted } }, t('noProjects'))
                )
          ),
        ]),
        // Mobile action bar: primary actions pinned to the bottom on narrow screens.
        h('div', { key: 'mobar', className: 'df-mobar' }, [
          h(Button, { onClick: () => { setScope('global'); setDrawerOpen(true) } }, h('span', { className: 'df-tap' }, t('mobileSettings'))),
          // Pause & takeover live in the project scope's 'pause' block — not the
          // danger zone. The per-card takeover button stays in CardActions.
          h(Button, { onClick: () => { setScope('project'); setOpenBlock('pause'); setDrawerOpen(true) } }, h('span', { className: 'df-tap' }, t('pauseTitle'))),
        ]),
      ])

      // View head: title + description, three headline stats, engine gate and the
      // settings entry. The board below is the first-class citizen, full width.
      const activeCount = cards.filter((card) => typeof card.sessionId === 'string' && card.sessionId !== '').length
      const globalEff = settings?.effectiveGlobalMaxActive
      const projDefault = settings?.projectDefaultMaxActive
      const projEff = project?.maxActiveSessions > 0 ? project.maxActiveSessions : (projDefault ?? null)
      const slots = projEff !== null && globalEff?.value != null ? Math.min(projEff, globalEff.value) : (projEff ?? globalEff?.value ?? '—')
      const stat = (key, n, label) => h('div', { key, style: { background: T.card, border: `1px solid ${T.line}`, borderRadius: 8, padding: '6px 12px', minWidth: 78 } }, [
        h('div', { key: 'n', style: { fontSize: 18, fontWeight: 700, color: T.ink } }, String(n)),
        h('div', { key: 'l', style: { fontSize: 10.5, color: T.muted } }, label),
      ])
      children.push(h('div', { key: 'viewHead', style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' } }, [
        h('div', { key: 'vt', style: { display: 'flex', flexDirection: 'column', gap: 2 } }, [
          h('div', { key: 'crumb', style: { fontSize: 11.5, color: T.muted, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, `dsh-factory / ${t('navLabel')}`),
          h('div', { key: 'title', style: { fontSize: 21, fontWeight: 680, color: T.ink, letterSpacing: '-.02em' } }, t('navLabel')),
          h('div', { key: 'desc', style: { fontSize: 12, color: T.muted } }, t('viewDesc')),
        ]),
        h('div', { key: 'tools', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h('span', { key: 'engine', className: 'df-hide-sm' }, h(EngineBar, { t, engine, onChanged: () => void load() })),
          h(Button, { key: 'refresh', onClick: () => void load(), disabled: busy }, busy ? t('loading') : t('refresh')),
          h('span', { key: 'cfg', className: 'df-tap' }, h(Button, {
            onClick: () => { setScope('global'); setDrawerOpen(true) },
            style: { background: T.accent, borderColor: T.accent, color: '#fff' },
          }, t('mobileSettings'))),
        ]),
      ]))

      if (error) {
        children.push(h('div', { key: 'error', style: { color: T.danger, fontSize: 13, background: T.panel, border: `1px solid ${T.danger}`, borderRadius: 6, padding: '6px 10px', whiteSpace: 'pre-line' } }, `${t('errorPrefix')}${error}`))
      }

      if (projects.length === 0) {
        children.push(h('div', { key: 'empty', style: { color: T.muted, fontSize: 13 } }, t('noProjects')))
        children.push(h('div', { key: 'newProject', style: { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', background: T.panel, padding: 10, borderRadius: 8 } }, [
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
        h('span', { key: 'plabel', style: { fontSize: 12, color: T.muted } }, `${t('project')}:`),
        h('select', {
          key: 'project', value: projectId,
          onChange: (event) => { setProjectId(event.target.value); setBoardId('') },
          style: selectStyle,
        }, [h('option', { key: '', value: '' }, '—'), ...projects.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name))]),
        projectBoards.length > 0 ? h('span', { key: 'blabel', style: { fontSize: 12, color: T.muted } }, `${t('board')}:`) : null,
        projectBoards.length > 0 ? h('select', {
          key: 'board', value: board ? board.id : '',
          onChange: (event) => setBoardId(event.target.value),
          style: selectStyle,
        }, projectBoards.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name))) : null,
      ].filter(Boolean)))

      if (project && project.warning) {
        children.push(h('div', { key: 'warn', style: { fontSize: 12, color: T.warning } }, project.warning))
      }

      // Headline stats — a first-class view header over the board.
      children.push(h('div', { key: 'stats', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
        stat('sc', boardCards.length, t('statCards')),
        stat('sa', activeCount, t('statActive')),
        stat('ss', slots, t('statSlots')),
      ]))

      // Needs-attention strip: a read-only roll-up of the existing engine status
      // plus plan-review / stalled cards. No new capability — just presentation.
      children.push(h(NeedsAttention, { key: 'attention', t, engine, cards: boardCards }))

      if (project && projectBoards.length === 0) {
        children.push(h('div', { key: 'newBoard', style: { display: 'flex', gap: 8, alignItems: 'flex-end', background: T.panel, padding: 10, borderRadius: 8 } }, [
          h(Field, { key: 'bn', label: t('newBoard'), value: newBoardName, onChange: setNewBoardName }),
          h(Button, { key: 'bc', disabled: busy || !newBoardName, onClick: () => void run(async () => {
            await callApi('POST', '/boards', { projectId: project.id, name: newBoardName })
            setNewBoardName('')
          }) }, t('create')),
        ]))
        return renderPage()
      }

      children.push(h('div', { key: 'inbox', className: 'df-inbox', style: { background: T.panel, borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 } }, [
        h('div', { key: 'ih', style: { fontSize: 12, fontWeight: 600, color: T.warning } }, `${t('inbox')} · ${inboxCards.length}`),
        inboxCards.length === 0 ? h('div', { key: 'ie', style: { fontSize: 12, color: T.muted } }, t('inboxEmpty')) : inboxCards.map(renderCard),
      ]))

      children.push(h('div', { key: 'newCard', style: { display: 'flex', gap: 8, alignItems: 'flex-end' } }, [
        h(Field, { key: 'ct', label: t('newCard'), value: newCardTitle, onChange: setNewCardTitle }),
        h(Button, { key: 'cc', disabled: busy || !newCardTitle || !board, onClick: () => void run(async () => {
          await callApi('POST', '/cards', { boardId: board.id, title: newCardTitle })
          setNewCardTitle('')
        }) }, t('create')),
      ]))

      children.push(h('div', { key: 'board', className: 'df-board', style: { display: 'flex', gap: 8, alignItems: 'flex-start', overflowX: 'auto' } },
        COLUMNS.map((column) => h(Column, {
          key: column.key,
          title: t(column.labelKey),
          t,
          renderCard,
          cards: boardCards.filter((card) => column.statuses.includes(card.status)),
        }))))

      if (canceledCards.length > 0) {
        children.push(h('div', { key: 'canceled', style: { fontSize: 12, color: T.muted } }, `${t('canceled')}: ${canceledCards.length}`))
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
