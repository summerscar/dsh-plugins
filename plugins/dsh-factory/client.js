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
    }

    // Status → accent, by "who is waiting". triage/plan/build = agent busy (blue);
    // inbox/plan-review/review = your turn (amber); done green; canceled grey.
    const STATUS_ACCENT = {
      inbox: T.warning,
      triage: T.info,
      plan: T.info,
      'plan-review': T.warning,
      build: T.info,
      review: T.warning,
      done: T.success,
      canceled: T.muted,
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
      actDispatch: "派发",
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
      actDispatch: "Dispatch",
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
        style: { background: T.card, border: `1px solid ${T.line}`, borderLeft: `3px solid ${accent}`, borderRadius: 6, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 },
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
      return h('div', { style: { flex: '1 1 0', minWidth: 140, background: T.panel, borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 } }, [
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

    function BoardPage({ t }) {
      const [projects, setProjects] = useState([])
      const [boards, setBoards] = useState([])
      const [cards, setCards] = useState([])
      const [projectId, setProjectId] = useState('')
      const [boardId, setBoardId] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [newProject, setNewProject] = useState({ name: '', rootPath: '' })
      const [newBoardName, setNewBoardName] = useState('')
      const [newCardTitle, setNewCardTitle] = useState('')
      const [showSetup, setShowSetup] = useState(false)

      const load = useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const [p, b, c] = await Promise.all([
            callApi('GET', '/projects'), callApi('GET', '/boards'), callApi('GET', '/cards'),
          ])
          setProjects(p.projects || [])
          setBoards(b.boards || [])
          setCards(c.cards || [])
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

      children.push(h('div', { key: 'header', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } }, [
        h('div', { key: 'title', style: { fontSize: 16, fontWeight: 600, color: T.ink } }, t('navLabel')),
        h(Button, { key: 'refresh', onClick: () => void load(), disabled: busy }, busy ? t('loading') : t('refresh')),
      ]))

      if (error) {
        children.push(h('div', { key: 'error', style: { color: T.danger, fontSize: 13, background: T.panel, border: `1px solid ${T.danger}`, borderRadius: 6, padding: '6px 10px' } }, `${t('errorPrefix')}${error}`))
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
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: 4 } }, children)
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

      // Project-level worktree setup, per design §12: opt-in panel, not part of
      // the create form. Always active: worktree isolation is mandatory, so there
      // is no "disabled when isolation is off" state to show.
      if (project) {
        children.push(h('div', { key: 'setupToggle', style: { display: 'flex', gap: 8, alignItems: 'center' } }, [
          h('button', {
            key: 'toggle', type: 'button',
            style: { padding: '4px 10px', borderRadius: 6, border: `1px solid ${T.line}`, background: T.card, color: T.ink, fontSize: 12, cursor: 'pointer' },
            onClick: () => setShowSetup(!showSetup),
          }, t('setupTitle')),
          h('span', { key: 'hint', style: { fontSize: 12, color: T.muted } }, t('setupPurpose')),
        ]))
        if (showSetup) {
          children.push(h(WorktreeSetup, { key: `${project.id}:setup`, project, t, onSaved: () => void load() }))
        }
      }

      if (project && projectBoards.length === 0) {
        children.push(h('div', { key: 'newBoard', style: { display: 'flex', gap: 8, alignItems: 'flex-end', background: T.panel, padding: 10, borderRadius: 8 } }, [
          h(Field, { key: 'bn', label: t('newBoard'), value: newBoardName, onChange: setNewBoardName }),
          h(Button, { key: 'bc', disabled: busy || !newBoardName, onClick: () => void run(async () => {
            await callApi('POST', '/boards', { projectId: project.id, name: newBoardName })
            setNewBoardName('')
          }) }, t('create')),
        ]))
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: 4 } }, children)
      }

      children.push(h('div', { key: 'inbox', style: { background: T.panel, borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 } }, [
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

      children.push(h('div', { key: 'board', style: { display: 'flex', gap: 8, alignItems: 'flex-start', overflowX: 'auto' } },
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

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: 4 } }, children)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
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
