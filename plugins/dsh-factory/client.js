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
      settings: '项目工厂', navLabel: '项目工厂', refresh: '刷新', loading: '加载中…', errorPrefix: '出错了：',
      noProjects: '还没有项目，先建一个。', projectName: '项目名称',
      rootPath: '仓库根（绝对路径）', newBoard: '新建看板',
      newCard: '新建卡片', create: '创建', project: '项目', board: '看板',
      inbox: '📥 收件箱', inboxEmpty: '收件箱为空',
      colPlanning: '规划中', colAwaiting: '待批准', colBuilding: '实现中', colReview: '待评审', colDone: '完成',
      canceled: '已取消', emptyColumn: '—',
      actDispatch: '派发', actApprovePlan: '批准计划', actConfirmCommit: '确认提交', actCreatePr: '推送分支并创建 PR', actMarkDone: '标记完成',
    }
    const en = {
      settings: 'Project Factory', navLabel: 'Project Factory', refresh: 'Refresh', loading: 'Loading…', errorPrefix: 'Error: ',
      noProjects: 'No project yet — create one.', projectName: 'Project name',
      rootPath: 'Repo root (absolute path)', newBoard: 'New board',
      newCard: 'New card', create: 'Create', project: 'Project', board: 'Board',
      inbox: '📥 Inbox', inboxEmpty: 'Inbox empty',
      colPlanning: 'Planning', colAwaiting: 'Awaiting approval', colBuilding: 'Building', colReview: 'Review', colDone: 'Done',
      canceled: 'Canceled', emptyColumn: '—',
      actDispatch: 'Dispatch', actApprovePlan: 'Approve plan', actConfirmCommit: 'Confirm commit', actCreatePr: 'Push branch & create PR', actMarkDone: 'Mark done',
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
