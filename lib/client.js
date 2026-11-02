// LawCase 律案工作台 · 客户端半区（手写单文件，无需打包器）
//
// 两种挂载方式，共用同一个 Panel：
//   1) DSH Desktop 工作台：ctx.desktopWorkbenches.register({...}, Panel)
//   2) 普通 Harness Web UI：sidebar.panellist 侧栏图标 + main 面板（key 与 id 同名）
//
// 数据全部来自宿主侧只读接口 POST /api/lawcase（见 lib/server/api.js）。
// 这里不做任何法律判断，也不调 LLM：只把台账摊开给人看。

window.__ModuleLoader__.load({
  id: 'lawcase',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const API = '/api/lawcase'
    const APP_TITLE = '律案工作台'
    const APP_DESC = '把法律服务过程变成可验收的初稿：材料、事实、结论、工序、五道验收一屏看完'
    // 工作台身份：规范的 GitHub 仓库 URL（宿主会规范化成 owner/repo 当身份）。
    // 换仓库地址＝换身份，已绑定的工作台会话要迁移，所以发布后不要再改。
    const REPOSITORY = 'https://github.com/zhaoweicmd/lawdesktop'
    const TABS = ['概览', '材料', '事实', '结论', '工序', '验收']
    // 模块一加载就报一次：能区分「模块没被加载」和「加载了但 apply 里失败」
    // （后者看不到这条，前者看得到——两种故障的修法完全不同）
    try {
      fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ op: 'client.mount', payload: { phase: 'module-load' } }),
      }).catch(() => {})
    } catch (e) {}


    // ---------- 主题 ----------
    const T = {
      bg: 'var(--dsw-alias-bg-base, #ffffff)',
      layer1: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
      layer2: 'var(--dsw-alias-bg-layer-2, #eef0f4)',
      border: 'var(--dsw-alias-border-l1, #e3e6ea)',
      border2: 'var(--dsw-alias-border-l2, #cfd4da)',
      text: 'var(--dsw-alias-label-primary, #1b1f24)',
      text2: 'var(--dsw-alias-label-secondary, #5b6470)',
      brand: 'var(--dsw-alias-brand-primary, #3b6cf6)',
      ok: 'var(--dsw-alias-state-success-primary, #1f9d55)',
      warn: 'var(--dsw-alias-state-warn-primary, #b7791f)',
      err: 'var(--dsw-alias-state-error-primary, #d64545)',
      idle: 'var(--dsw-alias-state-idle-primary, #8b94a0)',
    }

    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        width: '100%',
        height: '100%',
        // customFrame 下宿主给的是主内容区，父容器不一定有确定高度：
        // 只写 height:100% 会塌成 0，表现为"工作台在一"片空白"，所以给个下限。
        minHeight: 420,
        boxSizing: 'border-box',
        background: T.bg,
        color: T.text,
        overflow: 'hidden',
        // AI 入口用「相对本面板」的绝对定位：宿主的 compact 头部会把工具栏重排/裁切，
        // 放工具栏里可能整个看不见（踩过：工作台里找不到对话框入口）
        position: 'relative',
      },
      toolbar: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 16px',
        borderBottom: `1px solid ${T.border}`,
        minHeight: 48,
        boxSizing: 'border-box',
        flexWrap: 'wrap',
      },
      body: { display: 'flex', flex: 1, minHeight: 0, minWidth: 0 },
      side: {
        width: 292,
        minWidth: 220,
        maxWidth: 360,
        borderRight: `1px solid ${T.border}`,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: T.layer1,
      },
      main: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      scroll: { flex: 1, minHeight: 0, minWidth: 0, width: '100%', boxSizing: 'border-box', overflow: 'auto', padding: '12px 16px 24px' },
    }

    // 仅使用宿主主题 token；样式放在组件树内，卸载工作台时自动清理。
    function UiStyles() {
      return h('style', { 'data-lawcase-ui': '' }, `
        .lawcase-page { font-family: inherit; }
        .lawcase-toolbar { background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #f7f8fa) 76%, transparent); box-shadow: 0 1px 0 color-mix(in srgb, var(--dsw-alias-border-l1, #e3e6ea) 68%, transparent); }
        .lawcase-button { min-height: 34px; padding-inline: 14px; border-radius: 8px; transition: background .15s ease, border-color .15s ease, box-shadow .15s ease, transform .05s ease; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
        .lawcase-button:not(:disabled):hover { border-color: var(--dsw-alias-brand-primary, #3b6cf6) !important; background: var(--dsw-alias-bg-layer-2, #eef0f4) !important; box-shadow: 0 3px 8px rgba(16,24,40,.10); }
        .lawcase-button-primary:not(:disabled) { box-shadow: 0 2px 5px color-mix(in srgb, var(--dsw-alias-brand-primary, #3b6cf6) 24%, transparent); }
        .lawcase-button-primary:not(:disabled):hover { background: var(--dsw-alias-brand-hover, #2f5fe0) !important; box-shadow: 0 4px 10px color-mix(in srgb, var(--dsw-alias-brand-primary, #3b6cf6) 30%, transparent); }
        .lawcase-button:not(:disabled):active { transform: translateY(1px); box-shadow: none; }
        .lawcase-button:focus-visible, .lawcase-input:focus-visible, .lawcase-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b6cf6); outline-offset: 2px; }
        .lawcase-button-danger:not(:disabled) { color: var(--dsw-alias-state-error-primary, #d64545) !important; border-color: var(--dsw-alias-state-error-primary, #d64545) !important; }
        .lawcase-button-danger:not(:disabled):hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 10%, transparent) !important; }
        .lawcase-side { flex: 0 1 clamp(240px, 24vw, 320px); background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #f7f8fa) 88%, transparent); }
        .lawcase-main { flex: 1 1 0; background: var(--dsw-alias-bg-base, #ffffff); }
        .lawcase-toolbar { flex: 0 0 auto; }
        .lawcase-tabs { position: relative; z-index: 2; min-height: 44px; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; flex-wrap: nowrap !important; background: var(--dsw-alias-bg-base, #ffffff); }
        .lawcase-tab { flex: 0 0 auto; min-height: 42px; border-radius: 7px 7px 0 0 !important; }
        .lawcase-tab[aria-selected='true'] { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3b6cf6) 7%, transparent); }
        .lawcase-notice { max-width: min(680px, 100%); max-height: 96px; overflow: auto; white-space: normal; overflow-wrap: anywhere; }
        .lawcase-ai { position: absolute; top: 0; right: 0; bottom: 0; z-index: 4; box-shadow: -12px 0 28px rgba(0,0,0,.12); }
        .lawcase-empty { border: 1px dashed var(--dsw-alias-border-l2, #cfd4da); border-radius: 10px; padding: 18px 14px !important; background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #f7f8fa) 50%, transparent); }
        @media (max-width: 980px) {
          .lawcase-body { flex-direction: column; }
          .lawcase-side { width: 100%; max-width: none; min-width: 0; max-height: 250px; border-right: none !important; border-bottom: 1px solid var(--dsw-alias-border-l1, #e3e6ea); }
          .lawcase-side-list { max-height: 150px; }
          .lawcase-ai { width: min(420px, 48vw) !important; min-width: 280px !important; }
        }
        @media (max-width: 640px) {
          .lawcase-toolbar, .lawcase-actionbar { padding-left: 10px !important; padding-right: 10px !important; }
          .lawcase-toolbar-root { flex-basis: 100%; order: 3; }
          .lawcase-scroll { padding: 10px 10px 20px !important; }
          .lawcase-tabs { padding: 0 6px !important; }
          .lawcase-tab { padding-left: 8px !important; padding-right: 8px !important; }
          .lawcase-ai { position: absolute; inset: 0 0 0 auto; width: min(100%, 420px) !important; max-width: 100% !important; z-index: 4; box-shadow: -12px 0 28px rgba(0,0,0,.12); }
          .lawcase-main > div:first-child { min-width: 0; }
          .lawcase-main > div:first-child > div:first-child { align-items: flex-start !important; }
          .lawcase-main > div:first-child > div:first-child > div:first-child { flex: 1 1 100%; max-width: 100%; white-space: normal !important; overflow: visible !important; overflow-wrap: anywhere; }
          .lawcase-main > div:first-child > div:nth-child(2) { max-height: 42px; overflow: auto; }
        }
        @media (prefers-reduced-motion: reduce) { .lawcase-button { transition: none; } }
      `)
    }

    // ---------- 小工具 ----------
    /**
     * 网关/代理层的失败要翻成人能看懂的话。
     *
     * 宿主自己的 /api 回包永远是 JSON（200 + {ok}），所以拿到 502/503/504
     * 或者根本不是 JSON，就说明请求在到达插件之前被别的中间层拦掉了——
     * 最常见的是本机代理（Clash 之类）把 127.0.0.1 的请求也接管了，
     * 或者一次请求跑得太久被中间层判成超时。原来这里只印一句
     * 「接口返回的不是 JSON（HTTP 502）」，用户完全不知道下一步该干什么。
     */
    function gatewayMessage(status) {
      if (status === 502 || status === 503 || status === 504) {
        return (
          `请求被中间层拦下了（HTTP ${status}），没有到达律案插件。` +
          `常见原因：浏览器/系统代理把 127.0.0.1 也代理走了，或这次操作太久被判超时。` +
          `可以先把代理关掉（或让 127.0.0.1 直连）再重试。`
        )
      }
      if (status === 401) {
        return (
          `这次请求没有通过宿主鉴权（HTTP 401）。` +
          `请用桌面应用自己的窗口打开工作台，不要用外部浏览器访问随机端口。`
        )
      }
      return null
    }

    async function call(op, payload) {
      let res = null
      try {
        res = await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ op, payload: payload || {} }),
        })
      } catch (e) {
        // fetch 自己抛：连接被拒/被代理切断。也要说清楚，而不是裸露 "Failed to fetch"
        const err = new Error(
          `连不上律案接口（${(e && e.message) || e}）。` +
          `如果开了代理，请让 127.0.0.1 直连后重试。`
        )
        err.code = 'api/offline'
        throw err
      }
      let json = null
      const status = res.status
      try {
        json = await res.json()
      } catch (e) {
        const gw = gatewayMessage(status)
        const err = new Error(gw || `接口返回的不是 JSON（HTTP ${status}）`)
        err.code = gw ? 'api/gateway' : 'api/not-json'
        throw err
      }
      if (!json || json.ok !== true) {
        const e = (json && json.error) || {}
        // 鉴权失败时宿主只回一句 "unauthorized"，那不是给用户看的：
        // 先说清楚该用哪个窗口打开，再附上服务端原话备查。
        const gw = status === 401 || status === 403 ? gatewayMessage(status) : null
        const raw = String(e.message || '').trim()
        const err = new Error(
          gw
            ? (raw && raw !== 'unauthorized' && raw !== 'forbidden' ? `${gw}（服务端：${raw}）` : gw)
            : (raw || gatewayMessage(status) || `接口失败（HTTP ${status}）`)
        )
        err.code = e.code || (gw ? 'api/gateway' : 'api/failed')
        throw err
      }
      return json.data
    }

    function fmtTime(v) {
      if (!v) return ''
      const s = String(v)
      return s.length >= 16 ? s.slice(0, 16).replace('T', ' ') : s
    }

    function num(n) {
      return typeof n === 'number' ? String(n) : '0'
    }

    // 案型：落盘值是英文（core 只认 litigation/contract），界面一律显示中文。
    // 两边都从这里取，避免界面上写一份、别处又写一份。
    const CASE_TYPES = [
      { value: 'litigation', label: '诉讼/争议' },
      { value: 'contract', label: '合同审核' },
    ]

    // 客户端拿不到 node 的 path 模块，目录拼接自己来（统一用 /：macOS/Linux 就认这个）。
    /**
     * 复制到剪贴板。优先 navigator.clipboard（安全上下文才有），
     * 退到 execCommand 兜底——Electron 里 file:// 或不带安全上下文时前者不可用，
     * 只写前者会让「复制指令」按钮点了没反应。
     */
    function copyText(text) {
      const s = String(text || '')
      if (!s) return false
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(s).catch(() => {})
          return true
        }
      } catch (e) {}
      try {
        const ta = document.createElement('textarea')
        ta.value = s
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.top = '-1000px'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return Boolean(ok)
      } catch (e) {
        return false
      }
    }

    /**
     * 从草稿列表里找出某条款的草稿。
     *
     * 编号可能是「4」也可能是「第四条」，两种都要认——条款索引里是什么就存什么，
     * 而 AI 写草稿时可能写成另一种，直接用 === 比会漏。
     */
    function draftOfClause(drafts, no) {
      const key = String(no || '').replace(/\s+/g, '')
      if (!key || !Array.isArray(drafts)) return null
      const num = (x) => {
        const t = String(x || '').replace(/\s+/g, '')
        const arabic = t.match(/^第?(\d{1,3})条?$/)
        if (arabic) return arabic[1]
        const cn = t.match(/第([零一二三四五六七八九十百]+)条/)
        if (cn) {
          const d = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
          let total = 0, cur = 0
          for (const ch of cn[1]) {
            if (d[ch] !== undefined) cur = d[ch]
            else if (ch === '十') { total += (cur || 1) * 10; cur = 0 }
            else if (ch === '百') { total += (cur || 1) * 100; cur = 0 }
          }
          return String(total + cur)
        }
        return t
      }
      const want = num(key)
      return drafts.find((d) => String(d.clause).replace(/\s+/g, '') === key || num(d.clause) === want) || null
    }

    /** 把一条草稿写进表单（统一入口，避免三处各写一遍 setState） */
    function applyDraftToForm(dr, setters) {
      if (!dr) return
      setters.setLevel(dr.level || '重大风险')
      setters.setIssue(dr.issue || '')
      setters.setFix(dr.fix || '')
      setters.setBasis(dr.basis || '')
      setters.setQuote(dr.quote || '')
    }

    function joinDir(base, name) {
      const b = String(base || '').replace(/\\/g, '/').replace(/\/+$/, '')
      const n = String(name || '').replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')
      if (!n) return b
      return b ? b + '/' + n : n
    }

    // 案件名称 → 目录名：去掉文件系统不认的字符（/ : * ? " < > |），压掉多余空白。
    // 目的只有一个：用户只填名称，目录名自动长出来，不用再手打路径。
    function dirNameOf(title) {
      return String(title || '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/, '')
        .slice(0, 80)
    }

    // ---------- 基础组件 ----------
    function Button(props) {
      const kind = props.kind || 'default'
      const bg = kind === 'primary' ? T.brand : 'transparent'
      const fg = kind === 'primary' ? '#fff' : T.text
      const bd = kind === 'primary' ? T.brand : T.border2
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          disabled: Boolean(props.disabled),
          title: props.title || '',
          'aria-label': props['aria-label'] || undefined,
          'aria-expanded': props['aria-expanded'] == null ? undefined : String(Boolean(props['aria-expanded'])),
          'aria-controls': props['aria-controls'] || undefined,
          'aria-busy': props.busy ? 'true' : undefined,
          'data-dsh-no-drag': '',
          className: 'lawcase-button' + (kind === 'primary' ? ' lawcase-button-primary' : '') + (kind === 'danger' ? ' lawcase-button-danger' : ''),
          style: {
            appearance: 'none',
            border: `1px solid ${kind === 'danger' ? T.err : bd}`,
            background: bg,
            color: kind === 'danger' ? T.err : fg,
            borderRadius: 7,
            padding: props.small ? '5px 10px' : '7px 14px',
            fontSize: props.small ? 12 : 13,
            lineHeight: 1.35,
            cursor: props.disabled ? 'not-allowed' : 'pointer',
            opacity: props.disabled ? 0.55 : 1,
            whiteSpace: 'nowrap',
            minWidth: props.small ? 0 : 72,
            fontWeight: kind === 'primary' ? 600 : 400,
          },
        },
        props.busy ? '处理中…' : props.children
      )
    }

    function Tag(props) {
      const tone = props.tone || 'idle'
      const color = T[tone] || T.idle
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '1px 7px',
            borderRadius: 999,
            fontSize: 11,
            lineHeight: '18px',
            color,
            border: `1px solid ${color}`,
            background: 'transparent',
            whiteSpace: 'nowrap',
          },
        },
        props.children
      )
    }

    function Empty(props) {
      return h(
        'div',
        { className: 'lawcase-empty', role: 'status', 'aria-live': 'polite', style: { color: T.text2, fontSize: 13, padding: '18px 0', lineHeight: 1.7 } },
        props.children || '暂无数据'
      )
    }

    // ---------- 逐条核对（人工签字的前置） ----------
    // 台账共用（事实/结论）：✓ 已核（一键）、改 / 疑（先写一句说明再提交）。
    // 「未核对」就是没点过——没有默认通过，否则签字的含金量归零。
    const CHECK_RESULTS = [
      { value: 'ok', label: '✓ 已核' },
      { value: 'fix', label: '改' },
      { value: 'doubt', label: '疑' },
    ]

    function CheckButtons(props) {
      const { state, onCheck, busy } = props
      const [asking, setAsking] = useState(null) // 'fix' | 'doubt' | null
      const [note, setNote] = useState('')
      // 正在提交哪一种（'ok' | 'fix' | 'doubt'）：点了要有可见反馈，
      // 否则接口慢的时候等于「按钮不存在」——这条踩过两次，别省。
      const [pending, setPending] = useState(null)
      if (!onCheck) return null

      // onCheck 是异步的：必须 await 才知道有没有记上，
      // 否则「点了没反应」——因为拒收原因藏在 Promise 里没人看
      const submit = async (result, text) => {
        if (pending) return
        setPending(result)
        try {
          const ok = await onCheck(result, text)
          if (ok === false) return
          setAsking(null)
          setNote('')
        } finally {
          setPending(null)
        }
      }

      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' } },
        state && state.result
          ? h(
              Tag,
              { tone: state.result === 'ok' ? 'ok' : state.result === 'fix' ? 'warn' : 'err' },
              (state.result === 'ok' ? '已核对' : state.result === 'fix' ? '需修改' : '有疑问') +
                (state.changed ? '（核对后已改）' : '') +
                (state.by ? ' · ' + state.by : '')
            )
          : h(Tag, { tone: 'idle' }, '未核对'),
        h(Button, { small: true, busy: pending === 'ok', disabled: Boolean(pending) || Boolean(busy), onClick: () => submit('ok', ''), title: '我看过了，这条没问题' }, CHECK_RESULTS[0].label),
        h(Button, { small: true, disabled: Boolean(pending) || Boolean(busy), onClick: () => setAsking(asking === 'fix' ? null : 'fix'), title: '这条要改，写清改什么' }, CHECK_RESULTS[1].label),
        h(Button, { small: true, disabled: Boolean(pending) || Boolean(busy), onClick: () => setAsking(asking === 'doubt' ? null : 'doubt'), title: '这条有疑问，写清疑点' }, CHECK_RESULTS[2].label),
        asking
          ? h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: 4, width: '100%', marginTop: 4 } },
              h(TextInput, {
                value: note,
                onChange: setNote,
                width: 320,
                placeholder: asking === 'fix' ? '要改成什么（必填，会写进签字单）' : '疑点是什么（必填，会写进签字单）',
              }),
              h(
                Button,
                {
                  small: true,
                  kind: 'primary',
                  disabled: !note.trim() || Boolean(pending),
                  busy: pending === asking,
                  onClick: () => submit(asking, note.trim()),
                },
                '确认' + (asking === 'fix' ? '需修改' : '有疑问')
              )
            )
          : null
      )
    }

    /** 从 actions.checkMap 取某条的核对状态 */
    function checkStateOf(actions, kind, id) {
      const m = actions && actions.checkMap
      if (!m || typeof m.get !== 'function') return null
      return m.get(kind + ':' + id) || null
    }

    /** 机器预核的三色灯：green 机器可确认 / yellow 机器判不了 / red 查出矛盾 */
    function LightTag(props) {
      const light = props.light
      if (!light) return null
      const map = {
        green: { tone: 'ok', label: '机器可核' },
        yellow: { tone: 'warn', label: '需人工判断' },
        red: { tone: 'err', label: '有矛盾' },
      }
      const m = map[light]
      if (!m) return null
      return h(Tag, { tone: m.tone }, m.label)
    }

    // ---------- 批量核对确认条 ----------
    // 「下一步」说「让我批量标 F1、F2、F3」时，真正执行的地方是这个条：
    // 必须看得见名单、填得出核对人、点得下确认。不做「全部一键通过」——
    // 那等于把签字变成形式，反而害了用的人。
    function BatchCheckBar(props) {
      const { draft, checker, onCancel, onConfirm, running } = props
      if (!draft) return null
      const ids = draft.ids || []
      return h(
        'div',
        {
          style: {
            border: '1px solid ' + T.warn,
            borderRadius: 8,
            padding: '8px 10px',
            background: T.layer1,
            marginBottom: 10,
          },
        },
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h(Tag, { tone: 'warn' }, '批量核对'),
          h('span', { style: { fontSize: 12 } }, `将把这 ${ids.length} 条标为「已核对」：`),
          h('span', { style: { fontSize: 12, fontWeight: 600, wordBreak: 'break-all' } }, ids.join('、')),
          checker
            ? h('span', { style: { fontSize: 11, color: T.text2, marginLeft: 'auto' } }, '核对人：' + checker)
            : h('span', { style: { fontSize: 11, color: T.warn, marginLeft: 'auto' } }, '先在上面填核对人姓名')
        ),
        h(
          'div',
          { style: { fontSize: 11, color: T.text2, marginTop: 4, lineHeight: 1.6 } },
          '批量只适合「这一批我已经整体看过」的情况。每条仍会单独留痕（谁、什么时候、内容指纹），但签字单上看不出你是否逐条读过——真正的逐条核对请在上面每条右侧点「✓ 已核」。'
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 6 } },
          h(
            Button,
            {
              small: true,
              kind: 'primary',
              disabled: Boolean(running) || !checker,
              onClick: () => onConfirm(draft),
            },
            running ? '执行中…' : `确认标这 ${ids.length} 条`
          ),
          h(Button, { small: true, onClick: onCancel }, '取消')
        )
      )
    }


    /** 从「下一步」里挑出可以批量核的编号：默认取还没核对的前 20 条事实 */
    function suggestBatchIds(next, allItems, limit = 20) {
      const text = String((next && next.action) || '') + ' ' + String((next && next.stuck) || '')
      const found = [...text.matchAll(/\bF(\d+)\b/g)].map((m) => 'F' + m[1])
      const uniq = [...new Set(found)]
      if (uniq.length) return uniq.slice(0, limit)
      // 兜底：从当前核对台账里取前 N 条未核对的
      const pending = (allItems || []).filter((x) => x.kind === 'fact' && !x.result).map((x) => x.id)
      return pending.slice(0, limit)
    }

    function Section(props) {
      return h(
        'section',
        { style: { marginBottom: 18 } },
        h('div', { style: { fontSize: 12, fontWeight: 600, color: T.text2, letterSpacing: 0.4, marginBottom: 8 } }, props.title),
        props.children
      )
    }

    function Grid(props) {
      return h(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))',
            gap: 8,
          },
        },
        props.children
      )
    }

    function Kpi(props) {
      return h(
        'div',
        {
          style: {
            border: `1px solid ${T.border}`,
            borderRadius: 9,
            padding: '9px 11px',
            background: T.layer1,
            minWidth: 0,
          },
        },
        h('div', { style: { fontSize: 11, color: T.text2, marginBottom: 3 } }, props.label),
        h(
          'div',
          { style: { fontSize: 19, fontWeight: 600, lineHeight: 1.25, color: props.tone ? T[props.tone] : T.text } },
          props.value
        ),
        props.hint ? h('div', { style: { fontSize: 11, color: T.text2, marginTop: 2 } }, props.hint) : null
      )
    }

    function ListRow(props) {
      return h(
        'div',
        {
          onClick: props.onClick,
          style: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '8px 10px',
            borderRadius: 8,
            cursor: props.onClick ? 'pointer' : 'default',
            border: `1px solid ${props.active ? T.brand : 'transparent'}`,
            background: props.active ? T.layer2 : 'transparent',
            marginBottom: 2,
            minWidth: 0,
          },
        },
        h(
          'div',
          { style: { minWidth: 0, flex: 1 } },
          h(
            'div',
            {
              style: {
                fontSize: 13,
                fontWeight: props.active ? 600 : 500,
                color: T.text,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
              title: props.title || '',
            },
            props.title
          ),
          h('div', { style: { fontSize: 11, color: T.text2, marginTop: 3, display: 'flex', gap: 6, flexWrap: 'wrap' } }, props.meta)
        ),
        props.side || null
      )
    }

    function Field(props) {
      return h(
        'div',
        { style: { display: 'flex', gap: 10, padding: '5px 0', fontSize: 13, borderBottom: `1px dashed ${T.border}`, minWidth: 0 } },
        h('div', { style: { color: T.text2, width: 76, flex: '0 0 76px' } }, props.label),
        h('div', { style: { minWidth: 0, flex: 1, wordBreak: 'break-all' } }, props.value == null || props.value === '' ? '—' : props.value)
      )
    }

    function statusTone(s) {
      if (s === 'done') return 'ok'
      if (s === 'doing') return 'brand'
      if (s === 'blocked') return 'err'
      if (s === 'fail') return 'err'
      if (s === 'warn') return 'warn'
      if (s === 'pass') return 'ok'
      if (s === 'ok') return 'ok'
      if (s === 'broken') return 'err'
      return 'idle'
    }

    // ---------- 侧栏：案件列表 ----------
    function CaseSide(props) {
      const { root, setRoot, cases, activeDir, onPick, onReload, busy, err } = props
      const [draft, setDraft] = useState(root || '')
      const [pickRoot, setPickRoot] = useState(false)
      useEffect(() => {
        setDraft(root || '')
      }, [root])
      return h(
        'div',
        { className: 'lawcase-side', style: S.side },
        h(
          'div',
          { style: { padding: '10px 12px', borderBottom: `1px solid ${T.border}` } },
          h('div', { style: { fontSize: 12, color: T.text2, marginBottom: 6 } }, '案件根目录'),
          h(
            'div',
            { style: { display: 'flex', gap: 6, minWidth: 0 } },
            h('input', {
              value: draft,
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') setRoot(String(draft).trim())
              },
              placeholder: '案件总目录（绝对路径）',
              spellCheck: false,
              title: draft || '', // 悬停能看到完整路径
              style: {
                // flex-basis 0 + minWidth 0：不要把「选择/载入」两个按钮挤没了，
                // 也不要让路径被截断成只剩前半截（踩过）
                flex: '1 1 0',
                minWidth: 0,
                fontSize: 12,
                padding: '5px 7px',
                borderRadius: 6,
                border: `1px solid ${T.border2}`,
                background: T.bg,
                color: T.text,
                textOverflow: 'ellipsis',
              },
            }),
            h(Button, { small: true, onClick: () => setPickRoot(true), title: '点选目录' }, '选择'),
            h(
              Button,
              {
                small: true,
                onClick: () => setRoot(String(draft).trim()),
                title: '载入这个目录下的案件',
              },
              '载入'
            )
          ),
          // 换行完整显示：路径被输入框截断时，这一行能看清到底指向哪里
          draft
            ? h(
                'div',
                {
                  style: {
                    marginTop: 4,
                    fontSize: 11,
                    color: T.text2,
                    lineHeight: 1.5,
                    wordBreak: 'break-all',
                  },
                },
                draft
              )
            : null,
          err
            ? h('div', { style: { marginTop: 8, fontSize: 12, color: T.err, lineHeight: 1.6 } }, err)
            : null
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px 6px',
              fontSize: 12,
              color: T.text2,
            },
          },
          h('span', null, cases ? `案件 ${cases.length}` : '案件'),
          h(Button, { small: true, onClick: onReload, disabled: busy, title: '重新读取' }, busy ? '读中…' : '刷新')
        ),
        h(
          'div',
          { style: { overflow: 'auto', flex: 1, minHeight: 0, padding: '0 8px 12px' } },
          !cases
            ? h(Empty, null, '先填根目录，或在宿主配置里把 root 指到案件总目录。')
            : cases.length === 0
              ? h(Empty, null, '这个目录下没有案件（案件目录需含 .lawcase/case.json）。')
              : cases.map((c) =>
                  h(ListRow, {
                    key: c.dir,
                    active: c.dir === activeDir,
                    title: c.title || c.caseId,
                    title2: c.dir,
                    onClick: () => onPick(c.dir),
                    meta: [
                      h(Tag, { key: 't', tone: 'brand' }, c.caseTypeLabel),
                      h('span', { key: 'm' }, `材料${num(c.counts.materials)}`),
                      h('span', { key: 'f' }, `事实${num(c.counts.facts)}`),
                      h('span', { key: 'k' }, `结论${num(c.counts.findings)}`),
                      c.counts.procBlocked
                        ? h(Tag, { key: 'b', tone: 'err' }, `阻塞${num(c.counts.procBlocked)}`)
                        : null,
                    ],
                    side: h('div', { style: { fontSize: 11, color: T.text2, whiteSpace: 'nowrap' } }, fmtTime(c.updatedAt)),
                  })
                )
        ),
        h(DirPicker, {
          open: pickRoot,
          title: '选择案件根目录',
          startDir: root || draft || '',
          onClose: () => setPickRoot(false),
          onPick: (d) => {
            setDraft(d)
            setPickRoot(false)
            setRoot(d)
          },
        })
      )
    }

    // ---------- 主区 ----------
    // 「待你确认」里每条到底怎么消掉：这些提醒是建案时写进去的，
    // 对应动作做完 core 会自动过滤掉，所以这里只要告诉人去做哪件事。
    function confirmHowTo(text) {
      const t = String(text || '')
      if (/工序拆解|工序表/.test(t)) {
        return '在对话里说「把本案工序拆出来，每道写清验收标准和依赖」；助手提交工序表（lc_proc_plan）后这条自动消失'
      }
      if (/材料定版|版本/.test(t)) {
        return '去「材料」页把版本组逐一「定版」（哪一版为准）；定完这条自动消失'
      }
      if (/材料(目录)?清单|卷宗目录|材料目录/.test(t)) {
        return '点顶部「扫材料」把卷宗目录扫进来（或说「把卷宗目录扫进本案」）；扫到材料后这条自动消失'
      }
      return '在对话里说清要做哪一件事，助手做完会把它记进台账'
    }

    function Overview(props) {
      const d = props.detail
      return h(
        'div',
        null,
        h(
          Section,
          { title: '下一步（插件按状态推的，不是判断）' },
          d.hints && d.hints.length
            ? h(
                'ul',
                { style: { margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.9 } },
                d.hints.map((t, i) => h('li', { key: i }, t))
              )
            : h(Empty, null, '没有待办提示。')
        ),
        h(
          Section,
          { title: '台账' },
          h(
            Grid,
            null,
            h(Kpi, { label: '材料', value: num(d.materials.total), hint: `已解析 ${num(d.materials.parsed)}` }),
            h(Kpi, { label: '事实', value: num(d.facts.total), hint: `待核 ${num(d.facts.unverified)}`, tone: d.facts.unverified ? 'warn' : null }),
            h(Kpi, { label: '结论', value: num(d.findings.total) }),
            h(Kpi, {
              label: '工序',
              value: `${num(d.proc.done)}/${num(d.proc.total)}`,
              hint: d.proc.blocked.length ? `阻塞 ${d.proc.blocked.join('、')}` : '无阻塞',
              tone: d.proc.blocked.length ? 'err' : null,
            })
          )
        ),
        h(
          Section,
          { title: '案件' },
          h(Field, { label: '名称', value: d.title }),
          h(Field, { label: '案由', value: d.cause }),
          h(Field, { label: '当事人', value: d.parties }),
          h(Field, { label: '案型', value: d.caseTypeLabel }),
          h(Field, { label: '状态', value: d.status }),
          h(Field, { label: '目录', value: d.dir }),
          h(Field, { label: '更新时间', value: fmtTime(d.updatedAt) })
        ),
        d.pendingConfirm && d.pendingConfirm.length
          ? h(
              Section,
              { title: `待你确认（${d.pendingConfirm.length}）` },
              h(
                'ul',
                { style: { margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.9 } },
                d.pendingConfirm.map((t, i) => {
                  const text = typeof t === 'string' ? t : t.text || JSON.stringify(t)
                  const how = confirmHowTo(text)
                  return h(
                    'li',
                    { key: i },
                    text,
                    how
                      ? h('div', { style: { fontSize: 11, color: T.text2, lineHeight: 1.6 } }, '→ ' + how)
                      : null
                  )
                })
              ),
              h(
                'div',
                { style: { fontSize: 11, color: T.text2, marginTop: 4, lineHeight: 1.6 } },
                '这些不是要你点「同意」，而是把对应的事做完就会自动消失；做完还留着，说明某一步没记进台账。'
              )
            )
          : null,
        d.lastLog
          ? h(Section, { title: '上次操作' }, h('div', { style: { fontSize: 12, color: T.text2, lineHeight: 1.7 } }, `${fmtTime(d.lastLog.ts)}　${d.lastLog.op || ''} ${d.lastLog.summary || ''}`))
          : null
      )
    }

    function MaterialsView(props) {
      const data = props.data
      // 材料页不做逐份核对：诉讼线的核对对象是事实与结论（在各自页签里逐条核对、
      // 进签字单），把 32 份卷宗逐一点"已核"没有业务含义；合同审核线核的是条款与意见。
      // 所以本页不设筛选状态，也不显示"未核 N / 已核 N"。
      if (!data) return h(Empty, null, '读材料台账…')
      if (!data.files || !data.files.length) return h(Empty, null, data.summary || '尚未扫描材料')
      const all = data.files
      // 材料扫描在诉讼线上只做两件事：登记 + 解析。
      //
      // 「要不要审」不是这一步的问题 —— 扫描器不分案型，它的提示（版本待定、
      // 一份没解析）说的是材料本身。诉讼案的推进单位是事实→结论→法条，
      // 那些页签一直都在（见下方 tabs），所以这里不再引导"去审合同"，
      // 只把「扫描之后该干什么」讲清楚，免得用户以为停在扫描这一步。
      const unparsed = all.filter((f) => !f.parsed).length
      const scanNote = props.caseType === 'litigation'
        ? h(
            'div',
            {
              style: {
                padding: '8px 10px', marginBottom: 6, borderRadius: 8,
                border: '1px solid ' + T.border2, background: T.layer2,
                fontSize: 12, lineHeight: 1.7, color: T.text2,
              },
            },
            all.length + ' 份已登记' + (unparsed ? '，' + unparsed + ' 份没解析（压缩包/音频这类不在可解析范围，跳过即可）' : '，全部已解析') + '。',
            h('br', null),
            '诉讼线在材料之后是：逐条抽事实（材料编号 + 位置 + 原文）→ 出结论 → 核法条 → 五道验收。合同、章程这类文件在这条线上是证据，按证据用就行。'
          )
        : null
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        scanNote,
        // 汇总行：只报"多少份"，不再带核对筛选
        h(
          'div',
          { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 11, color: T.text2 } }, data.summary || '')
        ),
        all.map((f) =>
          h(
            'div',
            {
              key: f.mid + f.rel,
              style: {
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                padding: '7px 10px',
                border: `1px solid ${T.border}`,
                borderRadius: 8,
                background: T.layer1,
                minWidth: 0,
                flexWrap: 'wrap',
              },
            },
            h('div', { style: { fontSize: 12, fontWeight: 600, color: T.brand, width: 44, flex: '0 0 44px' } }, f.mid),
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: f.rel }, f.rel),
              h(
                'div',
                { style: { fontSize: 11, color: T.text2, marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h('span', null, f.kind || ''),
                h('span', null, f.size ? `${Math.round(f.size / 1024)} KB` : ''),
                f.isLatest === false ? h(Tag, { tone: 'warn' }, '非最新') : null,
                f.dupOf ? h(Tag, { tone: 'warn' }, `重复：${f.dupOf}`) : null
                // 这里原来有逐条的「已核」按钮。材料不是核对对象（诉讼线核事实/结论，
                // 合同审核线核条款/意见），留着它只会让人觉得材料还欠一道工序。
              )
            )
          )
        )
      )
    }

    function TextInput(props) {
      return h('input', {
        value: props.value,
        onChange: (e) => props.onChange(e.target.value),
        placeholder: props.placeholder || '',
        spellCheck: false,
        className: 'lawcase-input',
        'data-dsh-no-drag': '',
        style: {
          fontSize: 12,
          padding: '5px 8px',
          borderRadius: 6,
          border: '1px solid ' + T.border2,
          background: T.bg,
          color: T.text,
          width: props.width || 220,
          minWidth: 0,
        },
      })
    }

    function TextArea(props) {
      return h('textarea', {
        value: props.value,
        onChange: (e) => props.onChange(e.target.value),
        placeholder: props.placeholder || '',
        rows: props.rows || 2,
        className: 'lawcase-input',
        'data-dsh-no-drag': '',
        style: {
          fontSize: 12,
          padding: '5px 8px',
          borderRadius: 6,
          border: '1px solid ' + T.border2,
          background: T.bg,
          color: T.text,
          width: '100%',
          boxSizing: 'border-box',
          resize: 'vertical',
          fontFamily: 'inherit',
          minWidth: 0,
        },
      })
    }

    // 选项既可以是字符串，也可以是 { value, label }：
    // 案型这类要「对内英文（落盘值）/ 对外中文（界面）」的字段就靠后者。
    function Select(props) {
      const opts = props.options || []
      return h(
        'select',
        {
          value: props.value,
          onChange: (e) => props.onChange(e.target.value),
          className: 'lawcase-input',
          'data-dsh-no-drag': '',
          style: {
            fontSize: 12,
            padding: '5px 6px',
            borderRadius: 6,
            border: '1px solid ' + T.border2,
            background: T.bg,
            color: T.text,
          },
        },
        opts.map((o) => {
          const isObj = Boolean(o) && typeof o === 'object'
          const value = isObj ? o.value : o
          const label = isObj && o.label != null ? o.label : o
          return h('option', { key: String(value), value }, label)
        })
      )
    }

    function FormRow(props) {
      return h(
        'div',
        { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 } },
        props.children
      )
    }

    function FactsView(props) {
      const data = props.data
      const act = props.actions || {}
      const [open, setOpen] = useState(false)
      const [text, setText] = useState('')
      const [source, setSource] = useState('')
      const [locator, setLocator] = useState('')
      const [quote, setQuote] = useState('')
      const [editId, setEditId] = useState(null)
      const [editLoc, setEditLoc] = useState('')
      const [editText, setEditText] = useState('')
      const [editReason, setEditReason] = useState('')
      const [revokeId, setRevokeId] = useState(null)
      const [revokeReason, setRevokeReason] = useState('')
      // 机器预核后：默认只看「需要人处理」的（红+黄），绿灯折叠起来
      // 核对状态筛选：all=全部 / pending=未核 / done=已核
      const [checkFilter, setCheckFilter] = useState('all')
      const [onlyTodo, setOnlyTodo] = useState(false)
      const machine = props.machine || null
      const checkStateOfLocal = (id) => (act && act.checkMap && act.checkMap.get ? act.checkMap.get('fact:' + id) : null)
      const isDone = (id) => {
        const st = checkStateOfLocal(id)
        return Boolean(st && st.result)
      }
      const lightOf = (id) => {
        if (!machine || !machine.facts || !Array.isArray(machine.facts.items)) return null
        const hit = machine.facts.items.find((x) => x.id === id)
        return hit ? { light: hit.light, problems: hit.problems || [], notes: hit.notes || [] } : null
      }
      const lightRank = { red: 0, yellow: 1, green: 2 }

      const canAdd = text.trim() && source.trim() && locator.trim()

      // 从验收页跳过来时带着 focusId：自动切到「全部」并高亮那一条
      const focusId = props.focusId || ''
      useEffect(() => {
        if (focusId) setCheckFilter('all')
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [focusId])

      // 按筛选条件出列表：未核的排前面（要先处理），已核的按原顺序
      const allFacts = (data && data.facts) || []
      const filtered = allFacts.filter((f) => {
        if (checkFilter === 'done') return isDone(f.id)
        if (checkFilter === 'pending') return !isDone(f.id)
        return true
      })
      const visibleFacts = onlyTodo && machine ? filtered.filter((f) => { const l = lightOf(f.id); return l && l.light !== 'green' }) : filtered

      return h(
        'div',
        null,
        props.batch || null,
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' } },
          h(Button, { small: true, kind: open ? 'default' : 'primary', onClick: () => setOpen(!open) }, open ? '收起' : '登记事实'),
          // 机器预核：能机器判的先判掉，人工只看它判不了的
          h(
            Button,
            {
              small: true,
              kind: machine ? 'default' : 'primary',
              disabled: Boolean(props.machineRunning) || !act.onMachine,
              onClick: () => act.onMachine && act.onMachine(),
              title: '引文是否真在材料里、出处是否存在、页码是否越界——机器能判的先判掉',
            },
            props.machineRunning ? '预核中…' : machine ? '重新预核' : '机器预核'
          ),
          // 核对状态筛选：直接数清楚「已核/未核」
          h(
            'span',
            { style: { display: 'inline-flex', gap: 4, alignItems: 'center' } },
            ...[['all', '全部'], ['pending', '未核'], ['done', '已核']].map(([k, label]) => {
              const list = (data && data.facts) || []
              const n = k === 'all' ? list.length : k === 'done' ? list.filter((f) => isDone(f.id)).length : list.filter((f) => !isDone(f.id)).length
              return h(
                Button,
                { key: k, small: true, kind: checkFilter === k ? 'primary' : 'default', onClick: () => setCheckFilter(k) },
                `${label} ${n}`
              )
            })
          ),
          h('span', { style: { fontSize: 11, color: T.text2 } }, '出处必填：文件 + 定位（页码 / 段号 / 表格行）'),
          data && data.summary
            ? h('span', { style: { fontSize: 11, color: T.text2, marginLeft: 'auto' } }, data.summary)
            : null
        ),
        // 预核结果摘要：直接告诉人还剩多少要自己看
        machine
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  padding: '6px 9px',
                  marginBottom: 8,
                  border: '1px solid ' + T.border2,
                  borderRadius: 8,
                  background: T.layer2,
                  fontSize: 11,
                },
              },
              h(LightTag, { light: 'green' }),
              h('span', null, `机器可核 ${machine.facts.green}`),
              h(LightTag, { light: 'yellow' }),
              h('span', null, `需人工 ${machine.facts.yellow}`),
              h(LightTag, { light: 'red' }),
              h('span', null, `有矛盾 ${machine.facts.red}`),
              h(
                Button,
                { small: true, onClick: () => setOnlyTodo(!onlyTodo), title: '只看机器判不了的' },
                onlyTodo ? '显示全部' : '只看需处理'
              ),
              onlyTodo && machine.facts.green
                ? h(
                    Button,
                    {
                      small: true,
                      kind: 'primary',
                      disabled: Boolean(props.machineRunning),
                      onClick: () => act.onBatchMachineGreen && act.onBatchMachineGreen(),
                      title: '把「机器可核」的这批一次性标为已核对（仍逐条留痕）',
                    },
                    `一键确认机器可核的 ${machine.facts.green} 条`
                  )
                : null,
              h('span', { style: { color: T.text2, maxWidth: 520, lineHeight: 1.5 } }, '机器核 = 引文与出处对得上，不代表内容成立；黄/红必须自己看。')
            )
          : null,
        open
          ? h(
              'div',
              {
                style: {
                  border: '1px solid ' + T.border,
                  borderRadius: 8,
                  padding: 10,
                  background: T.layer1,
                  marginBottom: 10,
                },
              },
              h(TextArea, { value: text, onChange: setText, rows: 2, placeholder: '事实内容：一条只写一件事，能追到出处' }),
              h(
                FormRow,
                null,
                h(TextInput, { value: source, onChange: setSource, width: 260, placeholder: '出处文件，如 情况说明.txt 或 M3' }),
                h(TextInput, { value: locator, onChange: setLocator, width: 260, placeholder: '定位，如 P12 / 第3段 / 表格「应付」行' }),
                h(Button, { small: true, kind: 'primary', disabled: !canAdd, onClick: () => {
                  act.onFactAdd({ text: text.trim(), source: source.trim(), locator: locator.trim(), quote: quote.trim() || undefined })
                  setText('')
                  setSource('')
                  setLocator('')
                  setQuote('')
                  setOpen(false)
                } }, '登记')
              ),
              h(FormRow, null, h(TextInput, { value: quote, onChange: setQuote, width: 520, placeholder: '原文片段（可选，逐字）' }))
            )
          : null,
        !data
          ? h(Empty, null, '读事实台账…')
          : !data.facts || !data.facts.length
            ? h(Empty, null, data.summary || '事实台账为空')
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                visibleFacts.map((f) =>
                  h(
                    'div',
                    {
                      key: f.id,
                      // 从验收页跳过来的那一条高亮标出来，不用自己翻
                      style: {
                        padding: '8px 10px',
                        border: '1px ' + (props.focusId === f.id ? '2px solid ' + T.brand : 'solid ' + T.border),
                        borderRadius: 8,
                        background: props.focusId === f.id ? T.layer2 : T.layer1,
                        minWidth: 0,
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                      h('span', { style: { fontSize: 12, fontWeight: 600, color: T.brand } }, f.id),
                      h(Tag, { tone: statusTone(f.verified) }, f.verified === 'ok' ? '已核' : f.verified === 'broken' ? '来源失效' : '待核'),
                      h('span', { style: { fontSize: 11, color: T.text2, marginLeft: 'auto' } }, (f.file || '') + '　' + (f.locator || '')),
                      h(Button, { small: true, onClick: () => {
                        setEditId(editId === f.id ? null : f.id)
                        setEditText(f.text)
                        setEditLoc(f.locator || '')
                        setEditReason('')
                      } }, '修正'),
                      h(Button, { small: true, onClick: () => {
                        setRevokeId(revokeId === f.id ? null : f.id)
                        setRevokeReason('')
                      } }, '作废')
                    ),
                    h('div', { style: { fontSize: 13, marginTop: 5, lineHeight: 1.7, wordBreak: 'break-word' } }, f.text),
                    // 人工逐条核对：这一行决定它能不能进签字单
                    h(
                      'div',
                      { style: { marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                      h(CheckButtons, {
                        state: checkStateOf(act, 'fact', f.id),
                        onCheck: act.onCheck ? (result, note) => act.onCheck({ kind: 'fact', id: f.id, result, note }) : null,
                      })
                    ),
                    editId === f.id
                      ? h(
                          'div',
                          { style: { marginTop: 8, borderTop: '1px dashed ' + T.border, paddingTop: 8 } },
                          h(
                            FormRow,
                            null,
                            h(TextInput, { value: editLoc, onChange: setEditLoc, width: 200, placeholder: '新定位' }),
                            h(TextInput, { value: editReason, onChange: setEditReason, width: 280, placeholder: '修正理由（必填）' }),
                            h(Button, { small: true, kind: 'primary', disabled: !editReason.trim(), onClick: () => {
                              act.onFactAmend({ id: f.id, locator: editLoc.trim() || undefined, text: editText.trim() || undefined, reason: editReason.trim() })
                              setEditId(null)
                            } }, '保存修正')
                          ),
                          h(FormRow, null, h(TextArea, { value: editText, onChange: setEditText, rows: 2 }))
                        )
                      : null,
                    revokeId === f.id
                      ? h(
                          'div',
                          { style: { marginTop: 8, borderTop: '1px dashed ' + T.border, paddingTop: 8 } },
                          h(
                            FormRow,
                            null,
                            h(TextInput, { value: revokeReason, onChange: setRevokeReason, width: 340, placeholder: '作废理由（必填，会留痕可审计）' }),
                            h(Button, { small: true, disabled: !revokeReason.trim(), onClick: () => {
                              act.onFactRevoke({ id: f.id, reason: revokeReason.trim() })
                              setRevokeId(null)
                            } }, '确认作废')
                          )
                        )
                      : null
                  )
                )
              )
      )
    }

    function FindingsView(props) {
      const data = props.data
      const act = props.actions || {}
      // 核对状态筛选（与事实页一致）
      const [checkFilter, setCheckFilter] = useState('all')
      const isDone = (id) => {
        const st = act && act.checkMap && act.checkMap.get ? act.checkMap.get('finding:' + id) : null
        return Boolean(st && st.result)
      }
      if (!data) return h(Empty, null, '读结论台账…')
      if (!data.items || !data.items.length) return h(Empty, null, data.summary || '结论台账为空')
      const all = data.items
      const shown = all.filter((f) => (checkFilter === 'done' ? isDone(f.id) : checkFilter === 'pending' ? !isDone(f.id) : true))
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h(
          'div',
          { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' } },
          ...[['all', '全部'], ['pending', '未核'], ['done', '已核']].map(([k, label]) => {
            const n = k === 'all' ? all.length : k === 'done' ? all.filter((f) => isDone(f.id)).length : all.filter((f) => !isDone(f.id)).length
            return h(Button, { key: k, small: true, kind: checkFilter === k ? 'primary' : 'default', onClick: () => setCheckFilter(k) }, `${label} ${n}`)
          }),
          h('span', { style: { fontSize: 11, color: T.text2 } }, data.summary || ''),
          // 没填核对人时明说差什么：否则一排 ✓/改/疑 看着点不动，
          // 用户以为「没有核对按钮」（实际是没责任人、被接口拒收）。
          props.checker
            ? null
            : h('span', { style: { fontSize: 11, color: T.warn, marginLeft: 'auto' } }, '先在上面填「核对人姓名」，逐条核对才会记账')
        ),
        shown.length ? null : h(Empty, null, checkFilter === 'done' ? '还没有已核对的结论' : '没有未核对的结论'),
        shown.map((f) =>
          h(
            'div',
            {
              key: f.id,
              style: { padding: '8px 10px', border: `1px solid ${T.border}`, borderRadius: 8, background: T.layer1, minWidth: 0 },
            },
            h(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('span', { style: { fontSize: 12, fontWeight: 600, color: T.brand } }, f.id),
              h(Tag, { tone: statusTone(f.trace) }, f.trace === 'ok' ? '可追溯' : f.trace === 'broken' ? '事实引用失效' : '法条未回源'),
              f.factRefs && f.factRefs.length ? h('span', { style: { fontSize: 11, color: T.text2 } }, `依据 ${f.factRefs.join('、')}`) : null
            ),
            h('div', { style: { fontSize: 13, marginTop: 5, lineHeight: 1.7, wordBreak: 'break-word' } }, f.text),
            f.law ? h('div', { style: { fontSize: 11, color: T.text2, marginTop: 3 } }, `法条：${f.law}`) : null,
            h(
              'div',
              { style: { marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h(CheckButtons, {
                state: checkStateOf(act, 'finding', f.id),
                onCheck: act.onCheck ? (result, note) => act.onCheck({ kind: 'finding', id: f.id, result, note }) : null,
              })
            )
          )
        )
      )
    }

    // ---------- 法条溯源：结论 → 法条 → 原文 → 来源 ----------
    // 解决的问题：结论里写「依据刑法第224条」很容易，但要能回答
    // 「这个条号真的在台账里吗、有原文吗、来源是法宝还是我手打的、还有效吗」。
    function LawTraceView(props) {
      const { data, running, onRun, onGotoFindings } = props
      if (!data) {
        return h(
          'div',
          null,
          h(
            FormRow,
            null,
            h(Button, { small: true, kind: 'primary', disabled: Boolean(running), onClick: onRun }, running ? '核对中…' : '跑法条溯源'),
            h('span', { style: { fontSize: 11, color: T.text2 } }, '把每条结论引用的法条与条文原文、权威来源对一遍；不调模型、不改文件。')
          ),
          h(Empty, null, '还没跑过。点「跑法条溯源」——它只读台账，不联网。')
        )
      }

      const levelTone = (lv) => (lv === '重大风险' ? 'err' : lv === '建议修改' ? 'warn' : lv === 'pass' ? 'ok' : 'idle')
      const bad = (data.items || []).filter((x) => x.level !== 'pass')

      return h(
        'div',
        null,
        h(
          FormRow,
          null,
          h(Button, { small: true, disabled: Boolean(running), onClick: onRun }, running ? '核对中…' : '重新核对'),
          h(Tag, { tone: bad.length ? (data.stats.missing ? 'err' : 'warn') : 'ok' }, data.summary),
          onGotoFindings ? h(Button, { small: true, onClick: onGotoFindings }, '去结论页') : null
        ),
        data.note
          ? h('div', { style: { fontSize: 11, color: T.warn, marginTop: 6, lineHeight: 1.6 } }, data.note)
          : null,

        // 问题清单（只有真有问题才列）
        bad.length
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 } },
              bad.map((it) =>
                h(
                  'div',
                  { key: it.findingId + it.lawId, style: { padding: '8px 10px', border: '1px solid ' + T.border, borderRadius: 8, background: T.layer1 } },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                    h('span', { style: { fontSize: 12, fontWeight: 600, color: T.brand } }, it.findingId),
                    h(Tag, { tone: levelTone(it.level) }, it.level),
                    h('span', { style: { fontSize: 11, color: T.text2 } }, it.lawId ? it.lawId + ' ' + (it.lawTitle || '') + ' ' + (it.article || '') : '未标法条')
                  ),
                  h('div', { style: { fontSize: 12, marginTop: 4, lineHeight: 1.7 } }, '结论：' + it.finding),
                  h(
                    'ul',
                    { style: { margin: '4px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.7, color: T.err } },
                    it.problems.map((p, i) => h('li', { key: i }, p))
                  )
                )
              )
            )
          : null,

        // 全部结论的溯源表
        h(
          'div',
          { style: { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: T.text2 } }, `逐条溯源（${(data.items || []).length} 条结论）`),
          (data.items || []).map((it) =>
            h(
              'div',
              {
                key: 'row-' + it.findingId,
                style: { padding: '7px 10px', border: '1px solid ' + T.border, borderRadius: 8, background: it.level === 'pass' ? T.layer1 : T.bg },
              },
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { style: { fontSize: 12, fontWeight: 600, color: T.brand } }, it.findingId),
                it.level === 'pass'
                  ? h(Tag, { tone: 'ok' }, '可核')
                  : h(Tag, { tone: levelTone(it.level) }, it.level),
                it.lawId
                  ? h('span', { style: { fontSize: 12 } }, it.lawId + '｜' + (it.lawTitle || '') + ' ' + (it.article || ''))
                  : h('span', { style: { fontSize: 12, color: T.warn } }, '未标法条'),
                it.sourceLabel ? h(Tag, { tone: it.weight >= 90 ? 'ok' : it.weight >= 80 ? 'brand' : 'warn' }, it.sourceLabel) : null,
                it.status ? h('span', { style: { fontSize: 11, color: T.text2 } }, it.status) : null
              ),
              it.quote
                ? h(
                    'div',
                    {
                      style: {
                        fontSize: 11,
                        color: T.text2,
                        marginTop: 4,
                        lineHeight: 1.7,
                        borderLeft: '2px solid ' + T.border2,
                        paddingLeft: 8,
                        maxHeight: 84,
                        overflow: 'auto',
                        whiteSpace: 'pre-wrap',
                      },
                    },
                    it.quote.slice(0, 300) + (it.quote.length > 300 ? '…' : '')
                  )
                : null
            )
          )
        ),

        // 台账里有但没被引用的法条
        (data.unused || []).length
          ? h(
              'div',
              { style: { marginTop: 12, fontSize: 11, color: T.text2, lineHeight: 1.8 } },
              h('div', { style: { fontWeight: 600, marginBottom: 2 } }, `台账里有、但没被任何结论引用（${data.unused.length} 条）`),
              data.unused.map((u) => h('div', { key: u.id }, `${u.id}｜${u.title || ''} ${u.article || ''}`))
            )
          : null
      )
    }

    /**
     * 工序建表器：在工作台里直接拆工序，不必回到对话框。
     *
     * 为什么必须做（2026-11-01 实测）：工序页空表时原来只给一句
     * 「工序表为空（在对话里让助手 lc_proc_plan）」——等于把入口推给了另一个界面。
     * 而 lc_proc_plan 要求每道工序都带验收标准、依赖要成 DAG，在对话里靠自然语言
     * 表达这些结构既啰嗦又容易被打回。工作台既然叫工作台，这一步就该在这里做。
     *
     * 设计取舍：只做「一行一道工序」的表格式输入（名称 / 验收标准 / 依赖）。
     * 依赖用名称填（与 core 同一套口径：dependsOn 存名称不存 id），成环交由 core 拒绝，
     * 界面只负责把错误原样显示出来——不在这里猜"哪里成环了"。
     */
    function ProcPlanner(props) {
      const act = props.actions || {}
      const [rows, setRows] = useState([{ name: '', acceptance: '', dependsOn: '' }])
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)

      const setRow = (i, k, v) => {
        const next = rows.slice()
        next[i] = Object.assign({}, next[i], { [k]: v })
        setRows(next)
      }
      const canSubmit =
        rows.some((r) => r.name.trim()) &&
        rows.every((r) => !r.name.trim() || r.acceptance.trim().length > 0)

      const submit = async () => {
        setErr('')
        const processes = rows
          .filter((r) => r.name.trim())
          .map((r) => ({
            name: r.name.trim(),
            acceptance: r.acceptance.trim(),
            dependsOn: r.dependsOn.split(/[、,，\s]+/).map((x) => x.trim()).filter(Boolean),
            inputs: '',
            outputs: '',
          }))
        if (!processes.length) {
          setErr('至少填一道工序')
          return
        }
        const missing = processes.find((p) => !p.acceptance)
        if (missing) {
          setErr('「' + missing.name + '」没写验收标准：没有验收标准的工序等于没做')
          return
        }
        setBusy(true)
        try {
          // 走 runAction：它自己把失败吞成界面提示，不会抛出来，
          // 所以这里不能靠 try/catch 判断成败——成了才清空表单。
          // runAction 成功返回 data（core 的 proc.plan 结果是对象），失败返回 undefined。
          const r = await act.onProcPlan({ processes })
          if (r) {
            setRows([{ name: '', acceptance: '', dependsOn: '' }])
            if (props.onDone) props.onDone()
          }
        } catch (e) {
          // 保留了异常分支：将来若换成直接 call，仍能显示原因
          setErr(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', border: '1px solid ' + T.border2, borderRadius: 8, background: T.layer1 } },
        h('div', { style: { fontSize: 13, fontWeight: 600 } }, '拆工序'),
        h(
          'div',
          { style: { fontSize: 11, color: T.text2, lineHeight: 1.7 } },
          '一行一道工序。验收标准必填——它决定这道工序算不算做完；依赖填前面的工序名称（留空=无依赖），拿不准就不填。'
        ),
        rows.map((r, i) =>
          h(
            'div',
            { key: i, style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 } },
            h(TextInput, {
              value: r.name,
              onChange: (v) => setRow(i, 'name', v),
              width: 200,
              placeholder: '工序名，如「整理起诉状事实」',
            }),
            h(TextInput, {
              value: r.acceptance,
              onChange: (v) => setRow(i, 'acceptance', v),
              width: 300,
              placeholder: '验收标准（必填）：怎么算做完',
            }),
            h(TextInput, {
              value: r.dependsOn,
              onChange: (v) => setRow(i, 'dependsOn', v),
              width: 180,
              placeholder: '依赖的工序名（可空）',
            }),
            rows.length > 1
              ? h(
                  Button,
                  {
                    small: true,
                    title: '删掉这一行',
                    onClick: () => setRows(rows.filter((x, j) => j !== i)),
                  },
                  '×'
                )
              : null
          )
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
          h(
            Button,
            {
              small: true,
              onClick: () => setRows(rows.concat([{ name: '', acceptance: '', dependsOn: '' }])),
            },
            '+ 加一行'
          ),
          h(
            Button,
            { small: true, kind: 'primary', disabled: !canSubmit || busy, onClick: submit },
            busy ? '提交中…' : '提交工序表'
          ),
          err ? h('span', { style: { fontSize: 12, color: T.err } }, err) : null
        )
      )
    }

    function ProcView(props) {
      const data = props.data
      const act = props.actions || {}
      const [blockNote, setBlockNote] = useState({})
      // 重排开关：默认收起，避免误覆盖现有工序
      const [replan, setReplan] = useState(false)
      if (!data) return h(Empty, null, '读工序表…')
      // 空表不是"没东西可看"，而是"这一步还没做"——直接把建表器摆出来。
      // 以前这里只留一句"去对话里让助手 lc_proc_plan"，工作台就没有入口。
      if (!data.proc || !data.proc.length) {
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h(ProcPlanner, { actions: act, onDone: props.onPlanned })
        )
      }

      const doneIds = {}
      for (const p of data.proc) if (p.status === 'done') doneIds[p.id] = true

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        data.proc.map((p) => {
          const waitDep = (p.dependsOn || []).filter((d) => !doneIds[d])
          const depsOk = waitDep.length === 0
          return h(
            'div',
            {
              key: p.id,
              style: { padding: '8px 10px', border: '1px solid ' + T.border, borderRadius: 8, background: T.layer1, minWidth: 0 },
            },
            h(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('span', { style: { fontSize: 12, fontWeight: 600, color: T.brand } }, p.id),
              h('span', { style: { fontSize: 13, fontWeight: 500 } }, p.name),
              h(Tag, { tone: statusTone(p.status) }, p.status),
              waitDep.length ? h('span', { style: { fontSize: 11, color: T.warn } }, '等 ' + waitDep.join('、')) : null,
              h(
                'div',
                { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
                p.status === 'todo'
                  ? h(Button, { small: true, disabled: !depsOk, title: depsOk ? '' : '依赖未完成', onClick: () => act.onProcUpdate({ id: p.id, status: 'doing' }) }, '开始')
                  : null,
                p.status === 'doing'
                  ? h(Button, { small: true, kind: 'primary', onClick: () => act.onProcUpdate({ id: p.id, status: 'done', acceptResult: true }) }, '完成')
                  : null,
                p.status === 'doing'
                  ? h(Button, { small: true, onClick: () => act.onProcUpdate({ id: p.id, status: 'blocked', note: (blockNote[p.id] || '').trim() || '人工标阻塞' }) }, '阻塞')
                  : null,
                p.status === 'blocked' ? h(Button, { small: true, onClick: () => act.onProcUpdate({ id: p.id, status: 'todo' }) }, '解阻塞') : null
              )
            ),
            p.acceptance ? h('div', { style: { fontSize: 12, color: T.text2, marginTop: 4, lineHeight: 1.6 } }, '验收：' + p.acceptance) : null,
            p.status === 'doing'
              ? h(FormRow, null, h(TextInput, {
                  value: blockNote[p.id] || '',
                  onChange: (v) => { const next = Object.assign({}, blockNote); next[p.id] = v; setBlockNote(next) },
                  width: 340,
                  placeholder: '阻塞原因（点「阻塞」时写入台账）',
                }))
              : null
          )
        }),
        // 有表也要能重排：开工后发现拆得不对是常事，原来只能靠对话，
        // 而对话里改结构最容易把已经标过的完成状态一起冲掉（replace 会重置进度）。
        h(
          'div',
          { style: { marginTop: 6 } },
          h(
            Button,
            {
              small: true,
              onClick: () => setReplan(!replan),
              title: '重排会丢弃现有工序的完成状态（core 口径：replace 即重置）',
            },
            replan ? '收起重排' : '重排工序表'
          ),
          replan
            ? h('div', { style: { marginTop: 6, fontSize: 11, color: T.warn, lineHeight: 1.7 } },
                '注意：提交新表会覆盖现有工序，已标的完成/阻塞状态不会保留。',
                h(ProcPlanner, { actions: act, onDone: () => { setReplan(false); if (props.onPlanned) props.onPlanned() } }))
            : null
        )
      )
    }

    function VerifyView(props) {
      const { result, onRun, busy, onGotoItem, onReviseDocx, onWaive, outputs, revising, reviseMsg, onLoadOutputs, onOpenOutput, openBusy } = props
      const [onlyIssues, setOnlyIssues] = useState(false)
      // 正在填忽略理由的那一项 + 理由文本（页内输入，Electron 下不依赖 window.prompt）
      const [waiveFor, setWaiveFor] = useState('')
      const [waiveWhy, setWaiveWhy] = useState('')
      // 当前展开预览的产出文件（点文件名切换）
      const [openFile, setOpenFile] = useState('')
      const checks = result && result.checks ? result.checks : []
      const shown = onlyIssues ? checks.filter((c) => c.status !== 'pass') : checks
      return h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' } },
          h(Button, { kind: 'primary', onClick: onRun, disabled: busy }, busy ? '跑验收…' : '跑五道验收'),
          result ? h(Button, { small: true, onClick: () => setOnlyIssues(!onlyIssues) }, onlyIssues ? '看全部' : '只看没过') : null,
          // 审核完→验收→出修订版，是一条完整链路；缺这一步用户得自己找入口
          onReviseDocx
            ? h(
                Button,
                {
                  small: true,
                  disabled: Boolean(revising),
                  onClick: () => {
                    // 留痕：这个按钮到底有没有被点到、处理函数有没有到。
                    // 用户环境里出问题时，我读 /api/lawcase 的 client.mount 日志即可定位，
                    // 不必让用户开控制台（他们开不了，也不好意思让他们找）。
                    try {
                      fetch(API, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({ op: 'client.mount', payload: { phase: 'click-revise', hasHandler: typeof onReviseDocx === 'function' } }),
                      }).catch(() => {})
                    } catch (e) {}
                    onReviseDocx({ source: 'drafts' })
                  },
                  title: '按当前 AI 草稿生成带修订痕迹的 Word（原合同不动，只写 out/ 下的新文件）',
                },
                revising ? '生成中…' : '生成修订版 Word（含批注）'
              )
            : null,
          onLoadOutputs
            ? h(Button, { small: true, onClick: () => onLoadOutputs() }, '刷新产出')
            : null,
          h('span', { style: { fontSize: 12, color: T.text2 } }, '只读检查：不改案件状态，结论仍由你拍板')
        ),
        !result
          ? h(Empty, null, '还没跑过验收。')
          : h(
              'div',
              null,
              h(
                'div',
                {
                  style: {
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid ' + (result.verdict === 'pass' ? T.ok : result.verdict === 'needs_review' ? T.warn : T.err),
                    marginBottom: 12,
                    fontSize: 13,
                    lineHeight: 1.7,
                  },
                },
                h('div', { style: { fontWeight: 600, marginBottom: 2 } }, '结论：' + (result.verdict === 'pass' ? '五道全过' : result.verdict === 'needs_review' ? '无硬性失败，有待确认' : '不能外发')),
                h('div', { style: { color: T.text2 } }, result.summary)
              ),
              shown.map((c) =>
                h(
                  'div',
                  {
                    key: c.name,
                    style: { padding: '8px 10px', border: '1px solid ' + T.border, borderRadius: 8, marginBottom: 6, background: T.layer1, minWidth: 0 },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                    h(Tag, { tone: statusTone(c.status) }, c.status),
                    h('span', { style: { fontSize: 13, fontWeight: 500 } }, c.title),
                    c.items && c.items.length ? h('span', { style: { fontSize: 11, color: T.text2 } }, c.items.length + ' 项') : null,
                    // 忽略/取消忽略：只有 warn 能忽略（fail 是真缺东西，不允许说"我不管"）
                    c.waived
                      ? h(Tag, { tone: 'ok' }, '已忽略')
                      : null,
                    // 忽略理由用**页内输入**，不能用 window.prompt：
                    // Electron 里 prompt 直接返回 null，表现为「点了忽略完全没反应」（这个坑踩过两次）。
                    onWaive && !c.waived && c.status === 'warn'
                      ? h(
                          Button,
                          {
                            small: true,
                            onClick: () =>
                              setWaiveFor(waiveFor === c.name ? '' : c.name),
                            title: '人工判定这一项不适用于本案（会记录理由，可撤销）',
                          },
                          '忽略'
                        )
                      : null,
                    onWaive && c.waived
                      ? h(
                          Button,
                          {
                            small: true,
                            onClick: () => onWaive({ name: c.name, revoke: true }),
                            title: '撤销忽略，恢复为待确认',
                          },
                          '取消忽略'
                        )
                      : null,
                    // 事实道拆开显示：未核对 vs 出处问题，避免被当成一回事
                    c.counts
                      ? h(
                          'span',
                          { style: { fontSize: 11, color: T.text2 } },
                          [
                            c.counts.unchecked ? `未核对 ${c.counts.unchecked}` : null,
                            c.counts.sourceIssues
                              ? `出处问题 ${c.counts.sourceIssues}` +
                                (c.counts.machineLimited === c.counts.sourceIssues ? '（全部是机器比对不了，你已人工核对）' : '')
                              : null,
                          ]
                            .filter(Boolean)
                            .join('｜')
                        )
                      : null
                  ),
                  // 点「忽略」后展开的理由输入（页内，不用 prompt）
                  waiveFor === c.name && onWaive
                    ? h(
                        'div',
                        { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' } },
                        h('input', {
                          value: waiveWhy,
                          onChange: (e) => setWaiveWhy(e.target.value),
                          placeholder: '忽略理由（≥4 字，会留痕）：如「本案无法条争议」',
                          'data-dsh-no-drag': '',
                          style: {
                            flex: '1 1 240px',
                            minWidth: 160,
                            fontSize: 12,
                            padding: '4px 8px',
                            borderRadius: 6,
                            border: '1px solid ' + T.border2,
                            background: T.bg,
                            color: T.text,
                          },
                        }),
                        h(
                          Button,
                          {
                            small: true,
                            kind: 'primary',
                            disabled: String(waiveWhy).trim().length < 4,
                            onClick: async () => {
                              const why = String(waiveWhy).trim()
                              if (why.length < 4) return
                              setWaiveFor('')
                              setWaiveWhy('')
                              await onWaive({ name: c.name, reason: why })
                            },
                          },
                          '确认忽略'
                        ),
                        h(Button, { small: true, onClick: () => { setWaiveFor(''); setWaiveWhy('') } }, '取消')
                      )
                    : null,
                  c.items && c.items.length
                    ? h(
                        'ul',
                        { style: { margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: T.text2, lineHeight: 1.7 } },
                        // 验收项字段名是 msg（不是 text/title）：以前回退成 JSON.stringify，
                        // 界面直接显示 {"level":"warn","msg":"..."} 这种原始串
                        c.items.slice(0, 20).map((it, i) => {
                          const msg = String(it.msg || it.text || it.title || '')
                          // 从消息里抠出台账编号（F35 / K2 / M13），给出直达按钮
                          const hit = msg.match(/\b([FKMN])(\d+)\b/)
                          return h(
                            'li',
                            { key: i },
                            msg,
                            hit && onGotoItem
                              ? h(
                                  'button',
                                  {
                                    type: 'button',
                                    onClick: () => onGotoItem(hit[0]),
                                    'data-dsh-no-drag': '',
                                    title: '跳到这一条去处理',
                                    style: {
                                      marginLeft: 6,
                                      appearance: 'none',
                                      border: '1px solid ' + T.border2,
                                      background: 'transparent',
                                      color: T.brand,
                                      borderRadius: 6,
                                      fontSize: 11,
                                      padding: '1px 7px',
                                      cursor: 'pointer',
                                    },
                                  },
                                  '去处理 ' + hit[0]
                                )
                              : null
                          )
                        })
                      )
                    : null
                )
              ),
              result.mustFix && result.mustFix.length
                ? h(Section, { title: '必须修' }, h('ul', { style: { margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 } }, result.mustFix.map((m, i) => h('li', { key: i }, String(m.msg || m.text || m.title || '')))))
                : null,
              // ---- 产出文件预览区 ----
              // 为什么必须有：生成修订版后只弹一句顶部提示，用户看不到"文件在哪、长什么样"，
              // 体感就是"点了没反应"。这里把 out/ 里的文件列出来，Markdown 直接显示正文。
              h(
                'div',
                { style: { marginTop: 12, border: '1px solid ' + T.border, borderRadius: 8, padding: 10, background: T.layer1 } },
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 } },
                  h('span', { style: { fontSize: 12, fontWeight: 600 } }, '产出文件'),
                  outputs && outputs.count
                    ? h('span', { style: { fontSize: 11, color: T.text2 } }, outputs.summary)
                    : h('span', { style: { fontSize: 11, color: T.text2 } }, '还没有产出：跑验收 / 生成修订版后出现在这里')
                ),
                reviseMsg
                  ? h(
                      'div',
                      {
                        role: 'status',
                        style: {
                          fontSize: 12,
                          marginBottom: 6,
                          padding: '6px 9px',
                          borderRadius: 6,
                          border: '1px solid ' + (reviseMsg.ok ? T.ok : T.err),
                          background: T.bg,
                          color: T.text,
                          lineHeight: 1.7,
                          wordBreak: 'break-word',
                        },
                      },
                      reviseMsg.text
                    )
                  : null,
                outputs && outputs.items && outputs.items.length
                  ? h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                      (outputs.items || []).map((f, i) => {
                        const isOpen = openFile === f.name
                        return h(
                          'div',
                          {
                            key: f.name + i,
                            style: {
                              border: '1px solid ' + (isOpen ? T.brand : T.border),
                              borderRadius: 7,
                              background: T.bg,
                              overflow: 'hidden',
                            },
                          },
                          // 整行可点：点文件名 = 展开/收起预览（预览优先，比跳出去更快）
                          h(
                            'div',
                            {
                              role: 'button',
                              tabIndex: 0,
                              'data-dsh-no-drag': '',
                              onClick: () => setOpenFile(isOpen ? '' : f.name),
                              onKeyDown: (e) => {
                                if (e && (e.key === 'Enter' || e.key === ' ')) setOpenFile(isOpen ? '' : f.name)
                              },
                              title: f.preview ? '点击预览内容' : '点击查看路径',
                              style: {
                                display: 'flex',
                                gap: 8,
                                alignItems: 'center',
                                flexWrap: 'wrap',
                                padding: '7px 9px',
                                cursor: 'pointer',
                                background: isOpen ? (T.layer2 || T.bg) : 'transparent',
                              },
                            },
                            h('span', { style: { fontSize: 11, color: T.text2, width: 10 } }, isOpen ? '▾' : '▸'),
                            h(
                              Tag,
                              { tone: f.kind === 'word' ? 'ok' : 'idle' },
                              f.kind === 'word' ? 'Word' : f.kind === 'markdown' ? 'Markdown' : (f.ext || '').replace('.', '') || '文件'
                            ),
                            h('span', { style: { fontSize: 12, fontWeight: 500, wordBreak: 'break-all' } }, f.name),
                            h('span', { style: { fontSize: 11, color: T.text2 } }, Math.round(f.bytes / 1024) + ' KB'),
                            h('span', { style: { fontSize: 11, color: T.text2 } }, String(f.at || '').slice(0, 16).replace('T', ' ')),
                            h(
                              'span',
                              { style: { marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' } },
                              f.preview ? h('span', { style: { fontSize: 11, color: T.brand } }, isOpen ? '收起' : '预览') : null,
                              // 「在默认应用打开」：与双击文件效果一致（Word/PDF 用系统关联程序）
                              onOpenOutput
                                ? h(
                                    Button,
                                    {
                                      small: true,
                                      kind: 'primary',
                                      busying: openBusy === f.name,
                                      onClick: (e) => {
                                        if (e && e.stopPropagation) e.stopPropagation()
                                        onOpenOutput({ name: f.name, mode: 'file' })
                                      },
                                      title: '用系统默认应用打开（如 Word、预览）',
                                    },
                                    '在默认应用打开'
                                  )
                                : null,
                              onOpenOutput
                                ? h(
                                    Button,
                                    {
                                      small: true,
                                      onClick: (e) => {
                                        if (e && e.stopPropagation) e.stopPropagation()
                                        onOpenOutput({ mode: 'folder' })
                                      },
                                      title: '在访达 / 资源管理器中打开 out 目录',
                                    },
                                    '打开文件夹'
                                  )
                                : null,
                              h(
                                Button,
                                {
                                  small: true,
                                  onClick: (e) => {
                                    if (e && e.stopPropagation) e.stopPropagation()
                                    copyText(f.abs)
                                  },
                                  title: '复制文件完整路径（粘到访达/资源管理器即可定位）',
                                },
                                '复制路径'
                              )
                            )
                          ),
                          // 展开后的内容
                          isOpen
                            ? h(
                                'div',
                                { style: { padding: '0 9px 9px' } },
                                f.preview
                                  ? h(
                                      'pre',
                                      {
                                        style: {
                                          margin: 0,
                                          maxHeight: 420,
                                          overflow: 'auto',
                                          fontSize: 11.5,
                                          lineHeight: 1.8,
                                          whiteSpace: 'pre-wrap',
                                          wordBreak: 'break-word',
                                          color: T.text,
                                          background: T.layer1,
                                          border: '1px solid ' + T.border,
                                          padding: '8px 10px',
                                          borderRadius: 6,
                                        },
                                      },
                                      f.preview
                                    )
                                  : h(
                                      'div',
                                      { style: { fontSize: 12, color: T.text2, lineHeight: 1.8 } },
                                      '这个文件类型不能页内预览。用「复制路径」粘到访达/资源管理器里打开。'
                                    ),
                                h(
                                  'div',
                                  { style: { fontSize: 11, color: T.text2, marginTop: 6, lineHeight: 1.7 } },
                                  '路径：' + f.abs,
                                  f.truncated ? '｜内容过长，只显示前 4 万字' : '',
                                  f.kind === 'word' ? '｜这里显示的是纯文本，修订痕迹请在 Word 中查看' : ''
                                )
                              )
                            : null
                        )
                      })
                    )
                  : null
              ),
              // 把「核对」和「验收」的关系说清楚：这两个不是一回事
              h(
                'div',
                { style: { marginTop: 10, padding: '8px 10px', border: '1px dashed ' + T.border2, borderRadius: 8, fontSize: 11, color: T.text2, lineHeight: 1.7 } },
                '「核对」是你在台账页逐条看过并认可内容；「验收」是机器检查出处、法条、逻辑、格式、保密。',
                h('br', null),
                '核完了仍可能有出问题——例如引文所在的扫描页 OCR 乱码、定位写成「P3」而其实该是第3段。这类是「出处可追溯」的问题，不是「没核对」。'
              )
            )
      )
    }

    function ClausesView(props) {
      const data = props.data
      const act = props.actions || {}
      const [file, setFile] = useState('')
      // 输入框默认收起来：把合同切成条款是确定性操作，不该让用户去复制路径。
      // 它只在「材料台账里没有这份合同」时才需要，是例外而非常态。
      const [manualOpen, setManualOpen] = useState(false)
      // 正在填「不索引」理由的那一份 + 理由文本（页内输入，不用 window.prompt）
      const [skipAsk, setSkipAsk] = useState('')
      const [skipWhy, setSkipWhy] = useState('')

      // 材料台账里的 docx：点一下就能索引。这才是主入口。
      const cands = (data && data.candidates && data.candidates.items) || []
      const hasFiles = Boolean(data && data.files && data.files.length)

      const indexBy = (ref) => {
        if (!ref) return
        if (act.onClauseIndex) act.onClauseIndex({ file: ref })
        setFile('')
      }

      const candidateRows = cands.length
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 } },
            cands.map((c) =>
              h(
                'div',
                { key: c.mid, style: { display: 'flex', flexDirection: 'column', gap: 0 } },
                h(
                'div',
                {
                  style: {
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    padding: '7px 10px',
                    border: '1px solid ' + (c.indexed ? T.border : T.border2),
                    borderRadius: 8,
                    background: c.indexed ? T.layer1 : T.layer2,
                  },
                },
                h('span', { style: { fontSize: 11, fontWeight: 600, color: T.brand } }, c.mid),
                h('span', { style: { fontSize: 13 } }, c.name),
                h('span', { style: { fontSize: 11, color: T.text2 } }, Math.round((c.size || 0) / 1024) + ' KB'),
                c.exists
                  ? null
                  : h(Tag, { tone: 'err' }, '文件已不在磁盘上'),
                c.indexed
                  ? h(Tag, { tone: 'ok' }, '已索引 ' + c.clauseCount + ' 条')
                  : c.skipped
                    ? h(Tag, { tone: 'idle' }, '不索引')
                    : h(Tag, { tone: 'idle' }, '未索引'),
                // 跳过的显式写理由：过两个月要能看出为什么不审这份
                c.skipped && c.skipReason
                  ? h('span', { style: { fontSize: 11, color: T.text2 } }, '（' + c.skipReason + '）')
                  : null,
                h(
                  'span',
                  { style: { marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' } },
                  h(
                    Button,
                    {
                      small: true,
                      kind: c.indexed ? 'default' : c.skipped ? 'default' : 'primary',
                      disabled: !c.exists,
                      title: c.indexed ? '重新切一遍（条款按最新版本覆盖）' : '把这份合同按「第X条」切成条款',
                      onClick: () => indexBy(c.mid),
                    },
                    c.indexed ? '重新索引' : '索引这份合同'
                  ),
                  // 「不索引」是本轮修的核心：卷宗里常混着没有条款编号的附件，
                  // 不能让它把「索引条款」这一步永远卡住。
                  c.indexed
                    ? null
                    : h(
                        Button,
                        {
                          small: true,
                          title: c.skipped ? '撤销「不索引」，恢复成待索引' : '选填：明确标记这份不审（未索引的本来就不参与审核）',
                          onClick: () => {
                            if (c.skipped) {
                              if (act.onClauseSkip) act.onClauseSkip({ file: c.mid, unskip: true })
                              return
                            }
                            setSkipWhy('')
                            setSkipAsk(skipAsk === c.mid ? '' : c.mid)
                          },
                        },
                        c.skipped ? '撤销不索引' : '不索引'
                      )
                )
                ),
                // 点了「不索引」才展开的理由输入（页内，不用 prompt：Electron 里 prompt 返回 null）
                skipAsk === c.mid
                  ? h(
                      'div',
                      { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, paddingLeft: 10, flexWrap: 'wrap' } },
                      h('input', {
                        value: skipWhy,
                        onChange: (e) => setSkipWhy(e.target.value),
                        placeholder: '理由（选填）：如「劳动合同无条款编号，本次不审」',
                        'data-dsh-no-drag': '',
                        style: {
                          flex: '1 1 260px',
                          minWidth: 160,
                          fontSize: 12,
                          padding: '4px 8px',
                          borderRadius: 6,
                          border: '1px solid ' + T.border2,
                          background: T.bg,
                          color: T.text,
                        },
                      }),
                      h(
                        Button,
                        {
                          small: true,
                          kind: 'primary',
                          disabled: false,
                          onClick: () => {
                            const why = String(skipWhy).trim()
                            if (why.length < 2) return
                            setSkipAsk('')
                            setSkipWhy('')
                            if (act.onClauseSkipConfirm) act.onClauseSkipConfirm({ file: c.mid, reason: why })
                          },
                        },
                        '确认不索引'
                      ),
                      h(Button, { small: true, onClick: () => { setSkipAsk(''); setSkipWhy('') } }, '取消')
                    )
                  : null
              )
            )
          )
        : null

      return h(
        'div',
        null,
        // 主入口：材料里的合同，一键索引。没有候选时才需要手工指定。
        candidateRows,
        cands.length
          ? null
          : h(
              'div',
              { style: { fontSize: 12, color: T.text2, marginBottom: 8, lineHeight: 1.7 } },
              '材料台账里没有 .docx。先去「材料」页扫材料，或用下面的「索引其他文件」直接指定一份。'
            ),
        h(
          FormRow,
          null,
          h(
            Button,
            { small: true, onClick: () => setManualOpen(!manualOpen), 'aria-expanded': manualOpen },
            manualOpen ? '收起' : '索引其他文件（不在材料台账里的）'
          ),
          data && data.noteTotal
            ? h('span', { style: { fontSize: 11, color: T.text2 } }, '已登记意见 ' + data.noteTotal + ' 条')
            : null
        ),
        manualOpen
          ? h(
              'div',
              { style: { marginTop: 6, padding: '8px 10px', border: '1px dashed ' + T.border2, borderRadius: 8 } },
              h(
                FormRow,
                null,
                h(TextInput, { value: file, onChange: setFile, width: 400, placeholder: '绝对路径，或相对案件目录的路径' }),
                h(Button, { small: true, kind: 'primary', disabled: !file.trim(), onClick: () => indexBy(file.trim()) }, '索引条款')
              ),
              h(
                'div',
                { style: { fontSize: 11, color: T.text2, marginTop: 4, lineHeight: 1.6 } },
                '也可以直接填材料编号（如 M1）——插件会去材料台账里找它的真实位置。'
              )
            )
          : null,
        !data
          ? h(Empty, null, '读条款索引…')
          : !hasFiles
            ? h(Empty, null, '还没有索引任何合同。上面点「索引这份合同」就能切开条款。')
            : data.files.map((f) =>
                h(
                  'div',
                  { key: f.name, style: { marginTop: 12 } },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' } },
                    h('div', { style: { fontSize: 12, fontWeight: 600 } }, f.name + '（' + f.total + ' 条）'),
                    f.noteCount ? h(Tag, { tone: 'warn' }, '已登记 ' + f.noteCount + ' 条意见') : h(Tag, { tone: 'idle' }, '未登记意见')
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                    f.clauses.map((c) =>
                      h(
                        'div',
                        {
                          key: c.no,
                          style: {
                            padding: '6px 9px',
                            border: '1px solid ' + (c.noteCount ? T.border2 : T.border),
                            borderRadius: 7,
                            background: c.noteCount ? T.layer2 : T.layer1,
                          },
                        },
                        h(
                          'div',
                          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                          h('span', { style: { fontSize: 12, fontWeight: 600, color: T.brand } }, c.no + (c.title ? '　' + c.title : '')),
                          c.noteCount ? h(Tag, { tone: 'warn' }, c.noteCount + ' 条意见') : null,
                          // 「已审·无需修改」跟「有意见」是两种结论，都要看得见——
                          // 否则复核的人分不清这条是漏审还是看过觉得没问题
                          c.ruling
                            ? h(
                                Tag,
                                { tone: c.ruling.kind === 'norevision' ? 'ok' : 'warn' },
                                (c.ruling.kind === 'norevision' ? '已审·无需修改' : '已审·需修改') +
                                  (c.ruling.by ? ' · ' + c.ruling.by : '')
                              )
                            : c.noteCount
                            ? null
                            : h(Tag, { tone: 'idle' }, '待审')
                        ),
                        h('div', { style: { fontSize: 12, color: T.text2, marginTop: 2, lineHeight: 1.6, maxHeight: 66, overflow: 'hidden' } }, String(c.text || '').slice(0, 260))
                      )
                    )
                  )
                )
              )
      )
    }

    /**
     * 「AI 预生成」按钮内置的指令。
     *
     * 写在代码里而不是让人每次手写：提示词决定草稿质量，而质量取决于几条硬约束
     * （引文必须逐字复制、不许空泛、三档要分级）。这些约束跟插件校验规则是一套的，
     * 放在一起才不会漂——改了 validateDrafts 就该改这里。
     */
    /**
     * 「载入 AI 草稿」内置的指令。
     *
     * 写法上有两处刻意的选择：
     *   1) 每次点按钮都重新读口径（立场/类型/补充要求），所以同一份合同换个立场再点，
     *      指令会跟着变——口径不能写死在这里。
     *   2) 只给目标、约束和可用工具，**不给固定步骤**。审合同没有放之四海皆准的流程：
     *      十几条的居间协议和上百条的工程合同，该怎么切、先看哪、要不要逐条都不同。
     *      把方法定死会让模型在不适用的地方硬套。
     */
    const REVIEW_PROMPT_TEMPLATE = (ctx) => {
      const c = ctx || {}
      const cfg = c.config || null
      const lines = [
        '审这个案件的合同，产出可落地的审核意见草稿。',
        '',
        '你在做辅助工作，不是替代律师做最终判断：起草、给依据、说清后果；改不改由人定。',
        '',
        '## 本次口径（可能每次都不一样，以这里为准）',
      ]
      if (cfg && cfg.stance) {
        lines.push(`- 立场：${cfg.stance.label} —— ${cfg.stance.hint}`)
        lines.push('  同一条条款换个立场，结论可能完全相反。这份意见只代表上述立场，不要两边都写。')
      }
      if (cfg && cfg.template) lines.push(`- 合同类型：${cfg.template.title} —— ${cfg.template.description}`)
      if (cfg && cfg.review && cfg.review.instructions) lines.push(`- 本人本次特别要求：${cfg.review.instructions}`)
      if (cfg && Array.isArray(cfg.rules) && cfg.rules.length) {
        lines.push('', '### 这类合同通常该查的方向（参考，不必逐项硬套）')
        for (const r of cfg.rules) lines.push(`- ${r.title}：${r.guidance}`)
      }
      lines.push(
        '',
        '## 怎么审，你自己判断',
        '没有固定流程。按合同实际情况决定：哪些条款值得写、一条写几处问题、要不要合并相邻条款。',
        '特别要求优先于上面的参考清单。',
        '',
        '## 可用工具（用不用、用几次、什么顺序，你定）',
        '- `lc_note_worksheet`：取全部条款 + 每条可直接逐字引用的原句 + 已有意见数。',
        '  建议先看一眼——不是为了走流程，是因为引文必须逐字命中，凭记忆抄会被拒收。',
        '- `lc_note_validate`：提交前自查引文是否命中、有无空泛话术。传 `save=true` 才会存成草稿给面板读。',
        '- 也可以自己读合同原文（条款索引在案件的 `.lawcase/clauses.json`），需要更细的上下文时用。',
        '',
        '## 硬约束（这些不是建议）',
        '- **引文必须逐字**：只能从条款原文里整句复制，改一个字就会被拒收。',
        '- **不许空泛**：「建议完善」「予以明确」「注意风险」这类话会被拒收。要说清哪句话、导致什么后果。',
        '- **替换条文要能直接用**：写「由双方另行协商」等于没写。要给具体的表述、金额、期限、比例。',
        '- **不许编造**：法条、机构名、金额、日期，没有依据就不写；拿不准的降级为「提示」并写清在确认什么。',
        '- 分级要有区分：重大风险／建议修改／提示，全标一档等于没分级。',
        '',
        '## 交付形态',
        '每条意见包含：clause（条款号，用索引里的原值）、level、issue、fix、quote、basis（可选）。',
        '最后调 `lc_note_validate` 传 `drafts` 和 `save=true`，按返回的 problems 修到全部 ok。',
        '然后告诉我：写了几条、几条被拒、拒在哪、哪些条款你判断不需要写意见及理由。',
        '',
        `案件路径：${c.dir}`,
      )
      return lines.join('\n')
    }

    const buildReviewPrompt = (ctx) => REVIEW_PROMPT_TEMPLATE(ctx || {})

    const RISK_TEMPLATES = [
      {
        key: '付款',
        issue: '付款节点与交付/验收未挂钩：〔写清哪一句导致什么后果，例如"签约即全额付款 + 无验收条款，导致买方先付款后无救济手段"〕',
        fix: '合同签订后〔X〕个工作日内支付合同总价的〔30%〕作为预付款；标的物交付并验收合格后〔10〕个工作日内支付剩余〔70%〕；验收不合格的，卖方应在〔5〕个工作日内整改并重新验收。',
      },
      {
        key: '验收',
        issue: '验收标准与期限缺失：〔写清例如"未约定验收标准、期限与不合格处理方式，导致卖方交付即可主张全额价款"〕',
        fix: '买方应在收到标的物后〔7〕个工作日内按附件〔技术规格书〕验收；逾期未提出书面异议视为验收合格；验收不合格的，卖方应在〔5〕个工作日内整改，整改后仍不合格的买方有权解除合同并要求赔偿。',
      },
      {
        key: '解除',
        issue: '解除权与后果约定不明：〔写清例如"仅约定任意解除而未约定解除后的结算与赔偿，导致守约方无法主张损失"〕',
        fix: '一方根本违约的，守约方书面通知后合同解除；解除后〔已完成部分按比例结算，已付款项中未对应部分应予返还，违约方另按合同总价的〔10%〕支付违约金，不足以弥补损失的应补足〕。',
      },
      {
        key: '违约',
        issue: '违约责任不对等或过低：〔写清例如"仅约束一方逾期交货，未约定逾期付款责任，双方救济失衡"〕',
        fix: '任何一方逾期履行金钱义务的，每逾期一日按逾期金额的〔0.05%〕支付违约金；逾期超过〔30〕日的，对方有权解除合同并要求赔偿全部损失。违约金不足以弥补实际损失时，违约方应补足差额。',
      },
    ]

    // 审核口径：立场（替谁审）+ 合同类型（必查项不同）+ 本次补充要求
    const REVIEW_STANCES = [
      { value: 'neutral', label: '中立审查' },
      { value: 'partyA', label: '站在甲方立场' },
      { value: 'partyB', label: '站在乙方立场' },
    ]
    const REVIEW_TEMPLATES = [
      { value: 'general', label: '通用合同' },
      { value: 'purchase', label: '采购合同' },
      { value: 'service', label: '服务合同' },
      { value: 'lease', label: '租赁合同' },
    ]

    /**
     * 审核指令模板（用户 2026-11-01：「AI 审核时我要能给出提示词；要 AI 怎么审」）。
     *
     * 空 textarea 等于逼人从零想措辞——律师要的是能直接点一下再改几个字。
     * 这些模板**只是起点**，点进去就能编辑；它们不会覆盖上面的立场与类型，
     * 而是在那之外再补一层「这次我特别在意什么」。
     */
    const REVIEW_INSTRUCTION_TEMPLATES = [
      {
        label: '只看对我方不利的条款',
        text: '只报对我方不利的条款：把义务加给我方、责任免除对方、期限对我方不利的都要指出。对方占便宜的写法直接给出替代表述。',
      },
      {
        label: '逐条给替代表述',
        text: '每一条问题都必须给出可以直接粘回合同的替代表述，不要只说"建议明确"。金额、比例、期限用【】标出待填。',
      },
      {
        label: '重点查这三处',
        text: '重点检查：① 付款条件与节点（是否与验收挂钩、有无逾期后果）；② 违约责任（是否对等、有无封顶、违约金是否过高）；③ 解除与争议解决（解除条件是否单方、管辖是否对我方不利）。其余条款只看明显问题。',
      },
      {
        label: '别报格式类小问题',
        text: '不要报错别字、标点、编号格式、排版这类问题；只报会造成实际权利义务影响的实体问题。',
      },
      {
        label: '按风险高低排序',
        text: '按对我方的实际影响从高到低排列，最严重的三条写在最前面。影响不大的放进 skipped，写一句不审的理由。',
      },
      {
        label: '这是一份要发给对方看的稿',
        text: '这份意见稿会直接发给对方：措辞要克制、对事不对人，避免"显失公平""恶意"这类对抗性形容词，改用客观描述加具体后果。',
      },
    ]

    /**
     * 解析「条款号 | 原文 | 替换为 | 理由」这种一行一处补丁的文本。
     *
     * 用竖线分隔而不是 JSON：律师不会手写 JSON，但粘贴三列文本毫无压力。
     * 原文里可能含竖线（罕见），所以只按前三个竖线切，剩下的整体当理由。
     */
    function parseFragmentLines(text) {
      const out = []
      for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const parts = line.split('|').map((x) => x.trim())
        if (parts.length < 2) continue
        const clause = parts[0]
        // 四段的空原文＝新增；三段的里空原文也算新增
        const original = parts.length >= 3 ? parts[1] : ''
        const replacement = parts.length >= 3 ? parts[2] : parts[1]
        const reason = parts.length >= 4 ? parts.slice(3).join('|') : ''
        if (!clause) continue
        out.push({ clause, original, replacement, reason })
      }
      return out
    }

    // 模型下拉的取值编码：'' 表示跟随 DSH 默认模型；其余是 "provider\u0000model"。
    // 用不可见分隔符而不是 ':'，因为 provider/model 里都可能出现冒号与斜杠。
    const MODEL_SEP = '\u0000'
    const parseModelKey = (key) => {
      const k = String(key || '')
      if (!k) return null
      const i = k.indexOf(MODEL_SEP)
      if (i < 0) return null
      return { provider: k.slice(0, i), model: k.slice(i + 1) }
    }

    /**
     * 审核模型选择器。
     *
     * 为什么不是普通 Select：模型目录是「默认项 + 多个 provider 分组」，
     * 分组标题必须不可选（否则选到组名会发出一个不存在的 model）。
     * 约定：disabled 的 option 就是分组标题。
     */
    function ModelSelect({ value, onChange, models }) {
      const m = models || { default: null, groups: [], warnings: [] }
      const opts = []
      const defLabel = m.default ? `跟随 DSH 默认（${m.default.provider} / ${m.default.model}）` : '跟随 DSH 默认模型'
      opts.push(h('option', { key: '__def', value: '' }, defLabel))
      for (const g of m.groups || []) {
        opts.push(h('option', { key: '__g_' + g.id, value: '', disabled: true }, '— ' + g.name + ' —'))
        for (const mm of g.models || []) {
          const k = g.id + MODEL_SEP + mm.id
          opts.push(h('option', { key: k, value: k }, mm.name || mm.id))
        }
      }
      const noModel = !m.groups || !m.groups.length
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('span', { style: { fontSize: 11, color: T.text2 } }, '审核模型'),
        h(
          'select',
          {
            value: value || '',
            disabled: noModel,
            onChange: (e) => onChange(e.target.value),
            'data-dsh-no-drag': '',
            'data-lawcase-testid': 'model-select',
            title: noModel ? '宿主没有可用的模型：请先在 DSH 设置里配置模型' : '选具体模型；不选就跟随 DSH 当前默认模型',
            style: {
              fontSize: 12,
              padding: '5px 8px',
              borderRadius: 6,
              border: '1px solid ' + T.border2,
              background: T.bg,
              color: T.text,
              maxWidth: 260,
            },
          },
          opts
        )
      )
    }

    function NotesView(props) {
      const data = props.data
      const act = props.actions || {}
      const review = props.review || { stance: 'neutral', templateId: 'general', instructions: '', brief: '' }
      const preview = props.preview || null
      const files = (props.files || []).map((x) => x.name)
      // 条款选项：来自条款索引，带"已有几条意见"提示，避免重复登记
      const options = []
      for (const f of props.files || []) {
        for (const c of f.clauses || []) {
          options.push({ key: f.name + '#' + c.no, label: f.name.replace(/\.docx?$/i, '') + ' ' + c.no + (c.noteCount ? '（' + c.noteCount + ' 条）' : ''), file: f.name, no: c.no })
        }
      }

      // 视图模式：full=全文四段式（默认，通读用）；form=原来的登记表单
      const [viewMode, setViewMode] = useState('full')
      const [fullKeyword, setFullKeyword] = useState('')
      const [picked, setPicked] = useState('')
      const [file, setFile] = useState(files[0] || '')
      const [clause, setClause] = useState('')
      const [level, setLevel] = useState('重大风险')
      const [issue, setIssue] = useState('')
      const [fix, setFix] = useState('')
      const [basis, setBasis] = useState('')
      const [quote, setQuote] = useState('')
      const [stance, setStance] = useState(review.stance || 'neutral')
      const [templateId, setTemplateId] = useState(review.templateId || 'general')
      const [ins, setIns] = useState(review.instructions || '')
      // 全文视图里「审核指令」折叠面板的开合
      const [insOpen, setInsOpen] = useState(false)
      // AI 预生成的草稿：只在这里预览，勾选采纳才真正写台账
      const [drafts, setDrafts] = useState([])
      const [draftBusy, setDraftBusy] = useState(false)
      const [draftMsg, setDraftMsg] = useState('')
      // 点过一次「载入」才显示空状态：否则一进页面就报「没有草稿」很吵
      const [draftTried, setDraftTried] = useState(false)
      // 按钮内置的指令：没有草稿时摆出来，人一键复制发给 AI 即可
      const [draftPrompt, setDraftPrompt] = useState('')
      // 上次载入有没有真的拿到草稿。不能靠 drafts.length 反推：
      // 同一批次里 drafts 还没更新时，会同时显示「已载入 N 条」和空状态（线上踩过）
      const [draftLoaded, setDraftLoaded] = useState(false)
      const [promptBusy, setPromptBusy] = useState(false)

      // ---- AI 直接审核（宿主模型）----
      // 与「载入 AI 草稿」的区别：这条路是插件自己调宿主已配置的模型，
      // 不需要人开对话框；草稿仍然要人工采纳才进台账——插件不替律师签字。
      const [models, setModels] = useState({ default: null, groups: [], warnings: [] })
      const [modelKey, setModelKey] = useState('') // '' = 跟随 DSH 默认模型
      const [aiBusy, setAiBusy] = useState(false)
      // 阶段文案：「准备中 / 模型调用中 / 解析校验中」——长任务没有阶段反馈就像卡死
      const [aiStage, setAiStage] = useState('')
      const [aiErr, setAiErr] = useState(null)
      const [aiMeta, setAiMeta] = useState(null) // 本次审核的模型/口径/计数，供页内展示
      const [aiConfirm, setAiConfirm] = useState(false) // 发出之前先明示「合同会发给模型」
      // 丢弃草稿：正在记录哪一条 + 一次性的理由 + 失败信息
      const [discarding, setDiscarding] = useState('')
      const [discardReason, setDiscardReason] = useState('')
      const [discardErr, setDiscardErr] = useState(null)
      // 片段级修订：每行一处补丁 + 校验结果
      const [fragText, setFragText] = useState('')
      const [fragBusy, setFragBusy] = useState(false)
      const [fragErr, setFragErr] = useState(null)
      const [fragMsg, setFragMsg] = useState('')
      const [fragPreview, setFragPreview] = useState(null)

      // 模型目录：进页面拉一次。某个 provider 发现失败只进 warnings，不挡住审核。
      // 目录与案件无关（它来自宿主），但换案件时重拉一次没坏处——
      // 切换案件的同时人可能刚在设置里换了模型。
      const caseDir = props.caseDir || ''
      useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const r = await call('models.list', {})
            if (!alive) return
            setModels({ default: (r && r.default) || null, groups: (r && r.groups) || [], warnings: (r && r.warnings) || [] })
          } catch (e) {
            if (alive) setModels({ default: null, groups: [], warnings: [String((e && e.message) || e)] })
          }
        })()
        return () => {
          alive = false
        }
      }, [caseDir])

      useEffect(() => {
        if (options.length && !options.some((o) => o.key === picked)) {
          setPicked(options[0].key)
          setFile(options[0].file)
          setClause(options[0].no)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [(props.files || []).map((x) => x.name + (x.total || 0)).join('|')])

      // 口径以服务端为准：保存成功（updatedAt 变了）才回灌，避免用户正在打字时被覆盖
      useEffect(() => {
        setStance(review.stance || 'neutral')
        setTemplateId(review.templateId || 'general')
        setIns(review.instructions || '')
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [review.updatedAt || 'none'])

      /**
       * 选条款：除了切换编号，**把这一条已有的 AI 草稿直接填进表单**。
       *
       * 为什么必须自动填：草稿的本意就是「不用从空白开始写」。
       * 以前只有点草稿卡片上的「采纳」才填，从下拉选条款则不填——
       * 用户明明看到「条款 4（2 条）」，选过去还是空表单，等于白生成。
       */
      const onPick = (key) => {
        setPicked(key)
        const hit = options.find((o) => o.key === key)
        if (hit) { setFile(hit.file); setClause(hit.no) }
        // 先按 key 直接填一次，让界面立刻有反应；
        // 真正的兜底在下面的 useEffect（条款号变化就填），
        // 因为载入草稿的那一刻 drafts 还没进 state，这里读到的可能是旧值。
        applyDraftToForm(draftOfClause(drafts, hit ? hit.no : key), { setLevel, setIssue, setFix, setBasis, setQuote })
      }

      // 选中条款一变就填对应草稿：载入草稿、切条款、清空重载都会走到这里。
      // 只靠 onPick 不够——草稿是异步载入的，那时的 drafts 还是空的（踩过：
      // 「只有第一条被填进去，切到其它条款表单不动」）。
      useEffect(() => {
        if (!clause) return
        const dr = draftOfClause(drafts, clause)
        if (!dr) return
        applyDraftToForm(dr, { setLevel, setIssue, setFix, setBasis, setQuote })
        // 依赖用「条款+草稿指纹」而不是 drafts.length：
        // 数量相同但内容被替换时（重新生成），也要重填。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [clause, drafts.map((d) => d.clause + ':' + (d.fix || '').length).join('|')])

      /** 当前选中条款对应的草稿（没有就 null），供表单顶部提示用 */
      const draftForClause = (function () {
        const no = String(clause || '').replace(/\s+/g, '')
        if (!no) return null
        return drafts.find((d) => String(d.clause).replace(/\s+/g, '') === no) || null
      })()

      const canSubmit = clause.trim().length > 0 && issue.trim().length >= 15 && fix.trim().length >= 15 && (files.length <= 1 || Boolean(file))

      const diffBlock = (it) => {
        const d = it.diff || {}
        if (d.same) {
          return h('div', { style: { fontSize: 12, color: T.text2 } }, '与原文相同：这条意见没有改动任何文字，建议补一条真正的替换条文')
        }
        return h(
          'div',
          {
            style: {
              fontSize: 12,
              lineHeight: 1.9,
              whiteSpace: 'pre-wrap',
              border: '1px solid ' + T.border,
              borderRadius: 6,
              padding: '6px 8px',
              background: T.bg,
              wordBreak: 'break-word',
            },
          },
          d.prefix || '',
          d.oldMid
            ? h('del', { style: { color: T.err, background: 'rgba(214,69,69,.10)' } }, d.oldMid)
            : null,
          d.newMid
            ? h(
                'ins',
                { style: { color: T.ok, textDecoration: 'none', background: 'rgba(31,157,85,.12)', fontWeight: 500 } },
                d.newMid
              )
            : null,
          d.suffix || ''
        )
      }

      /**
       * 发起一次 AI 审核。
       *
       * 为什么 busy 在这里自己管、而不是全交给外层 actions：onAiReview 是外层闭包，
       * 拿不到 NotesView 的 state。busy 必须在这里置位，否则「模型调用中」
       * 这个状态永远不会出现，用户会以为按钮没反应而反复点击（重复计费）。
       */
      async function runAiReview() {
        if (aiBusy) return
        setAiBusy(true)
        setAiErr(null)
        setAiStage('准备中…')
        // 重新审核 = 重来一遍：先把上一次的草稿从**界面**清掉。
        // 用户 2026-11-01：「重新审核应该清除原草稿」。
        // 为什么必须先清：这次审核如果失败/被取消，后端不会写新草稿，
        // 界面上留着旧的会被当成"刚审出来的结论"——那是最危险的一种假象。
        setDrafts([])
        setDraftLoaded(false)
        setAiMeta(null)
        // 服务端也清一次：它的 note-drafts.json 若还留着上次的（比如上次跑崩在半路），
        // 下次「载入 AI 草稿」会把旧结论又端上来。
        try {
          await act.onDraftsClearAll && act.onDraftsClearAll()
        } catch (e) {}
        // 模型调用是慢的那一段，单独把阶段文案换成它，让人知道在等什么
        // 不写秒数：不设上限了，写死一个数字只会让人以为到点会断
        const tick = setTimeout(() => setAiStage('模型调用中…（长合同会比较久，可随时取消）'), 400)
        try {
          const r = await act.onAiReview({
            stance,
            templateId,
            instructions: ins,
            modelSelection: parseModelKey(modelKey),
          })
          if (!r || r.ok === false) {
            setAiErr({ code: (r && r.code) || 'ai/failed', message: (r && r.message) || 'AI 审核失败' })
            return
          }
          // 成功：把草稿摆出来，并把选中条款填进表单
          const list = Array.isArray(r.drafts) ? r.drafts : []
          setDrafts(list)
          setDraftLoaded(list.length > 0)
          setDraftTried(true)
          setAiMeta({
            model: r.model,
            config: r.config,
            counts: r.counts,
            reviewId: r.reviewId,
            truncated: r.truncated,
            warnings: r.warnings || [],
            at: r.at,
          })
          setDraftMsg(r.message || '')
          const fallbackNo = options.length ? options[0].no : ''
          const cur = String(clause || fallbackNo || '').replace(/\s+/g, '')
          if (cur && !clause && options.length) {
            setPicked(options[0].key)
            setFile(options[0].file)
            setClause(options[0].no)
          }
          applyDraftToForm(draftOfClause(list, cur), { setLevel, setIssue, setFix, setBasis, setQuote })
        } catch (e) {
          setAiErr({ code: (e && e.code) || 'ai/failed', message: (e && e.message) || String(e) })
        } finally {
          clearTimeout(tick)
          setAiStage('')
          setAiBusy(false)
        }
      }

      // 全文视图：把整份合同铺开，四段并排（原文/审核意见/建议修改/实际修改意见）
      // 全文视图里的审核操作条：模型选择 + AI 审核 + 载入草稿。
      // 放进全文视图，是因为通读才是主场景——不该为了审核先切到"登记表单"。
      const reviewToolbar = h(
        'div',
        {
          style: {
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
            padding: '8px 10px',
            marginBottom: 10,
            border: '1px solid ' + T.border,
            borderRadius: 8,
            background: T.layer1,
          },
        },
        h('span', { style: { fontSize: 12, fontWeight: 600 } }, '审核'),
        h(ModelSelect, { value: modelKey, onChange: setModelKey, models }),
        // 全文视图里也要能改「怎么审」：通读才是主场景，让人为了写指令先切表单很别扭。
        // 点一下就展开输入框，收起后只留一个入口，不占版面。
        h(
          Button,
          {
            small: true,
            onClick: () => setInsOpen(!insOpen),
            'aria-expanded': insOpen ? 'true' : 'false',
            title: ins ? '已写审核指令，点击展开查看/修改' : '告诉 AI 这一次要怎么审',
          },
          (ins ? '审核指令 ●' : '审核指令') + (insOpen ? ' ▴' : ' ▾')
        ),
        h(
          Button,
          {
            small: true,
            kind: 'primary',
            disabled: aiBusy || !options.length,
            onClick: () => {
              if (!aiConfirm) return setAiConfirm(true)
              setAiConfirm(false)
              runAiReview()
            },
            title: options.length
              ? '用宿主已配置的模型直接审全部条款（不打开对话框）；草稿要你采纳才进台账'
              : '先在「条款」页索引合同',
          },
          aiBusy ? aiStage || '审核中…' : 'AI 审核全部条款'
        ),
        aiBusy
          ? h(
              Button,
              {
                small: true,
                onClick: async () => {
                  setAiStage('正在取消…')
                  if (act.onAiCancel) {
                    try { await act.onAiCancel({}) } catch (e) {}
                  }
                  setAiBusy(false)
                  setAiStage('')
                  setAiErr({ code: 'model/aborted', message: '已取消：本次没有产生任何审核结论。' })
                },
              },
              '取消'
            )
          : null,
        h(
          Button,
          {
            small: true,
            disabled: draftBusy || (!options.length && !drafts.length),
            onClick: async () => {
              if (!act.onDraftAll) return
              setDraftBusy(true)
              setDraftMsg('')
              setDraftTried(true)
              try {
                const r = await act.onDraftAll({ stance, templateId, instructions: ins })
                setDraftMsg((r && r.text) || '')
                const list = r && Array.isArray(r.drafts) ? r.drafts : []
                setDrafts(list)
                setDraftLoaded(list.length > 0)
              } catch (e) {
                setDraftMsg('载入草稿失败：' + ((e && e.message) || e))
              } finally {
                setDraftBusy(false)
              }
            },
          },
          draftBusy ? '载入中…' : '载入 AI 草稿'
        ),
        drafts.length ? h('span', { style: { fontSize: 11, color: T.text2 } }, '当前 ' + drafts.length + ' 条草稿') : null,
        // 展开的审核指令区（占满整行）：模板按钮 + 多行输入
        insOpen
          ? h(
              'div',
              { style: { flex: '1 1 100%', marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 } },
              h(
                'div',
                { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { style: { fontSize: 11, color: T.text2 } }, '告诉 AI 这一次要怎么审（会随提示词一起发给模型）：'),
                ...REVIEW_INSTRUCTION_TEMPLATES.map((tplItem) =>
                  h(
                    Button,
                    {
                      key: tplItem.label,
                      small: true,
                      title: tplItem.text,
                      onClick: () => setIns(ins ? ins + '\n' + tplItem.text : tplItem.text),
                    },
                    tplItem.label
                  )
                ),
                ins ? h(Button, { small: true, onClick: () => setIns('') }, '清空') : null
              ),
              h('textarea', {
                value: ins,
                rows: 3,
                'data-dsh-no-drag': '',
                placeholder: '例如：重点看付款与验收；每条都要给可直接粘回合同的替代表述；不要报错别字这类小问题。',
                onChange: (e) => setIns(e.target.value),
                style: {
                  width: '100%',
                  boxSizing: 'border-box',
                  fontSize: 12,
                  lineHeight: 1.7,
                  padding: '7px 9px',
                  borderRadius: 6,
                  border: '1px solid ' + T.border2,
                  background: T.bg,
                  color: T.text,
                  fontFamily: 'inherit',
                  resize: 'vertical',
                },
              }),
              h(
                Button,
                {
                  small: true,
                  kind: 'primary',
                  onClick: async () => {
                    if (act.onConfigSet) await act.onConfigSet({ stance, templateId, instructions: ins })
                    setInsOpen(false)
                    setDraftMsg('审核指令已保存，下次点「AI 审核」就用它')
                  },
                },
                '保存指令'
              )
            )
          : null
      )

      const fullView = h(FullTextReview, {
        files: props.files || [],
        notes: (data && Array.isArray(data.notes) ? data.notes : []),
        drafts,
        toolbar: reviewToolbar,
        actions: Object.assign({}, act, {
          onNotice: (t) => setDraftMsg(t),
        }),
        keyword: fullKeyword,
        onKeyword: setFullKeyword,
      })

      return h(
        'div',
        null,
        // ---- 视图切换 ----
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 } },
          h('span', { style: { fontSize: 12, fontWeight: 600 } }, '条款视图'),
          h(
            Button,
            { small: true, kind: viewMode === 'full' ? 'primary' : undefined, onClick: () => setViewMode('full') },
            '全文四段式'
          ),
          h(
            Button,
            { small: true, kind: viewMode === 'form' ? 'primary' : undefined, onClick: () => setViewMode('form') },
            '登记表单'
          ),
          h(
            'span',
            { style: { fontSize: 11, color: T.text2 } },
            viewMode === 'full'
              ? '整份合同一次列全：原文 / 审核意见 / 建议修改（可复制）/ 实际修改意见'
              : '逐条选条款、填三要素后登记；适合已经明确要改哪一条'
          )
        ),
        // 全文四段式（默认视图）
        viewMode === 'full' ? fullView : null,
        // ---- 登记表单视图（只在 form 模式下渲染）----
        viewMode === 'form'
          ? h('div', null,
        // ---- 审核口径（C）----
          h(
            'div',
            { style: { border: '1px solid ' + T.border, borderRadius: 8, padding: 10, background: T.layer1, marginBottom: 10 } },
            h(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('span', { style: { fontSize: 12, fontWeight: 600 } }, '审核口径'),
              h(Select, { value: stance, onChange: setStance, options: REVIEW_STANCES }),
              h(Select, { value: templateId, onChange: setTemplateId, options: REVIEW_TEMPLATES }),
              // 审核指令用多行框而不是单行输入：这里写的是一段「要 AI 怎么审」的话，
              // 一句话常放不下。下面的模板按钮点一下就填进去，再按需改几个字
              // （用户 2026-11-01：AI 审核时我要能给出提示词，要 AI 怎么审）。
              h('textarea', {
                value: ins,
                rows: 3,
                'data-dsh-no-drag': '',
                placeholder: '审核指令：告诉 AI 这一次要怎么审。例如「重点看付款与验收」「每条都要给可直接粘回合同的替代表述」「不要报错别字这类小问题」',
                onChange: (e) => setIns(e.target.value),
                style: {
                  flex: '1 1 420px',
                  minWidth: 240,
                  fontSize: 12,
                  lineHeight: 1.7,
                  padding: '7px 9px',
                  borderRadius: 6,
                  border: '1px solid ' + T.border2,
                  background: T.bg,
                  color: T.text,
                  fontFamily: 'inherit',
                  resize: 'vertical',
                },
              }),
              // 常用审核指令模板：点一下追加，不用从零想措辞
              h(
                'div',
                { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 } },
                h('span', { style: { fontSize: 11, color: T.text2 } }, '常用：'),
                ...REVIEW_INSTRUCTION_TEMPLATES.map((tplItem) =>
                  h(
                    Button,
                    {
                      key: tplItem.label,
                      small: true,
                      title: tplItem.text,
                      onClick: () => setIns(ins ? ins + '\n' + tplItem.text : tplItem.text),
                    },
                    tplItem.label
                  )
                ),
                ins ? h(Button, { small: true, onClick: () => setIns(''), title: '清空审核指令' }, '清空') : null
              ),
              h(
                Button,
                {
                  small: true,
                  onClick: () => act.onConfigSet({ stance, templateId, instructions: ins }),
                },
                '保存口径'
              ),
              // ---- 审核模型 + AI 直接审核 ----
              // 模型下拉：'' = 跟随 DSH 默认模型。选完立刻发请求，不弹对话框。
              h(ModelSelect, {
                value: modelKey,
                onChange: setModelKey,
                models,
              }),
              h(
                Button,
                {
                  small: true,
                  kind: 'primary',
                  disabled: aiBusy || !options.length,
                  onClick: () => {
                    // 第一次点：先明示「合同正文会发给所选模型」，避免默认以为在本机跑
                    if (!aiConfirm) return setAiConfirm(true)
                    setAiConfirm(false)
                    runAiReview()
                  },
                  title: options.length
                    ? '用宿主已配置的模型直接审全部条款（不打开对话框）；草稿要你采纳才进台账'
                    : '先在「条款」页索引合同',
                },
                aiBusy ? aiStage || '审核中…' : 'AI 审核全部条款'
              ),
              aiBusy
                ? h(
                    Button,
                    {
                      small: true,
                      onClick: () => {
                        // 取消只能是「本次没有结论」，不能变成「没有风险」
                        setAiBusy(false)
                        setAiStage('')
                        setAiErr({ code: 'model/aborted', message: '已取消：本次没有产生任何审核结论。' })
                      },
                    },
                    '取消'
                  )
                : null,

              // 两个按钮，两件事，不要混在一起：
              //   载入 AI 草稿 —— 只读 .lawcase/note-drafts.json，把 AI 已经生成好的草稿摆出来
              //   生成提示词   —— 不读也不写，只按当前口径拼一段给 AI 的指令，供复制
              // 混在一起的后果：没有草稿时点「载入」，用户以为功能坏了，其实只是该先要提示词。
              h(
                Button,
                {
                  small: true,
                  kind: 'primary',
                  disabled: draftBusy || (!options.length && !drafts.length),
                  onClick: async () => {
                    if (!act.onDraftAll) return
                    setDraftBusy(true)
                    setDraftMsg('')
                    setDraftTried(true)
                    try {
                      const r = await act.onDraftAll({ stance, templateId, instructions: ins })
                      setDraftMsg((r && r.text) || '')
                      const list = r && Array.isArray(r.drafts) ? r.drafts : []
                      setDrafts(list)
                      setDraftLoaded(list.length > 0)
                      // 载入后把「当前选中条款」的草稿直接填进表单。
                      // 不能读 state 里的 clause —— 它由 useEffect 首次设置，
                      // 这一次渲染里还是空串（踩过：填了个寂寞）。用 options 的默认值兜底。
                      const fallbackNo = options.length ? options[0].no : ''
                      const cur = String(clause || fallbackNo || '').replace(/\s+/g, '')
                      if (cur && !clause && options.length) {
                        setPicked(options[0].key)
                        setFile(options[0].file)
                        setClause(options[0].no)
                      }
                      applyDraftToForm(draftOfClause(list, cur), { setLevel, setIssue, setFix, setBasis, setQuote })
                    } catch (e) {
                      setDraftMsg('载入草稿失败：' + ((e && e.message) || e))
                    } finally {
                      setDraftBusy(false)
                    }
                  },
                  title: options.length || drafts.length
                    ? '读取 AI 已生成的草稿（不调用模型、不弹对话框）；草稿要你勾选才进台账'
                    : '先在「条款」页索引合同',
                },
                draftBusy ? '载入中…' : '载入 AI 草稿'
              ),
              h(
                Button,
                {
                  small: true,
                  disabled: promptBusy,
                  onClick: async () => {
                    if (!act.onDraftPrompt) return
                    setPromptBusy(true)
                    setDraftMsg('')
                    try {
                      const r = await act.onDraftPrompt({ stance, templateId, instructions: ins })
                      setDraftPrompt((r && r.prompt) || '')
                      setDraftMsg((r && r.text) || '')
                    } catch (e) {
                      setDraftMsg('生成提示词失败：' + ((e && e.message) || e))
                    } finally {
                      setPromptBusy(false)
                    }
                  },
                  title: '按当前口径拼一段给 AI 的指令（不读草稿、不调模型），复制后发给 AI',
                },
                promptBusy ? '生成中…' : '生成提示词'
              )
            ),
            h(
              'div',
              { style: { fontSize: 11, color: T.text2, marginTop: 4, lineHeight: 1.6 } },
              '当前：' + (review.brief || '立场：中立审查｜类型：通用合同') + '。立场决定「替谁审」：同一份合同换立场结论会变，意见表首页会写明。'
            ),
            // ---- 首次点「AI 审核」前的隐私确认 ----
            // 必须明说：合同正文会发给所选模型服务。保存本地不等于推理离线。
            aiConfirm && !aiBusy
              ? h(
                  'div',
                  {
                    role: 'alert',
                    style: {
                      marginTop: 8,
                      padding: '8px 10px',
                      borderRadius: 7,
                      border: '1px solid ' + T.warn,
                      background: 'rgba(200,140,20,.08)',
                      fontSize: 12,
                      lineHeight: 1.7,
                      color: T.text,
                    },
                  },
                  h('div', { style: { fontWeight: 600, marginBottom: 3 } }, '确认发送？'),
                  h(
                    'div',
                    null,
                    '这次审核会把《' +
                      (options.length ? options[0].file || '合同' : '合同') +
                      '》的条款正文**发送给所选模型服务**（' +
                      (modelKey ? (parseModelKey(modelKey) || {}).model || '所选模型' : 'DSH 默认模型') +
                      '）完成推理。案件数据保存在本地，但推理不在本机。涉密案件请先按所里规定确认。'
                  ),
                  h(
                    'div',
                    { style: { marginTop: 6, display: 'flex', gap: 8 } },
                    h(
                      Button,
                      {
                        small: true,
                        kind: 'primary',
                        onClick: () => {
                          setAiConfirm(false)
                          runAiReview()
                        },
                      },
                      '确认并审核'
                    ),
                    h(Button, { small: true, onClick: () => setAiConfirm(false) }, '取消')
                  )
                )
              : null,
            // ---- AI 审核失败：原样给出原因，绝不说「没有风险」 ----
            aiErr
              ? h(
                  'div',
                  {
                    role: 'alert',
                    'aria-live': 'assertive',
                    style: {
                      marginTop: 8,
                      padding: '8px 10px',
                      borderRadius: 7,
                      border: '1px solid ' + T.err,
                      background: 'rgba(214,69,69,.08)',
                      fontSize: 12,
                      lineHeight: 1.7,
                      color: T.text,
                      wordBreak: 'break-word',
                    },
                  },
                  h('div', { style: { fontWeight: 600, marginBottom: 3 } }, 'AI 审核失败（' + (aiErr.code || '未知') + '）'),
                  h('div', null, aiErr.message),
                  h('div', { style: { marginTop: 4, fontSize: 11, color: T.text2 } }, '这次没有产生任何审核结论，不能当作「合同没有风险」。'),
                  h(
                    'div',
                    { style: { marginTop: 6 } },
                    h(
                      Button,
                      {
                        small: true,
                        onClick: () => runAiReview(),
                      },
                      '重试'
                    )
                  )
                )
              : null,
            // ---- AI 审核成功摘要：模型、口径、计数、截断与告警 ----
            aiMeta
              ? h(
                  'div',
                  {
                    style: {
                      marginTop: 8,
                      padding: '7px 10px',
                      borderRadius: 7,
                      border: '1px solid ' + T.border2,
                      background: T.bg,
                      fontSize: 11,
                      lineHeight: 1.7,
                      color: T.text2,
                      wordBreak: 'break-word',
                    },
                  },
                  h('div', { style: { color: T.text } }, '本次模型：' + ((aiMeta.model && aiMeta.model.label) || '未知')),
                  h('div', null, '本次口径：' + ((aiMeta.config && aiMeta.config.brief) || '—')),
                  aiMeta.counts
                    ? h(
                        'div',
                        null,
                        '可采纳 ' + aiMeta.counts.ok + ' 条' +
                          (aiMeta.counts.warn ? '｜待人工确认 ' + aiMeta.counts.warn + ' 条' : '') +
                          (aiMeta.counts.fail ? '｜校验拒收 ' + aiMeta.counts.fail + ' 条' : '') +
                          (aiMeta.counts.skipped ? '｜判定无需修改 ' + aiMeta.counts.skipped + ' 条' : '')
                      )
                    : null,
                  aiMeta.truncated
                    ? h('div', { style: { color: T.warn } }, '合同过长，本次只审了部分条款，其余请分批审核。')
                    : null,
                  (aiMeta.warnings || []).map((w, i) => h('div', { key: i, style: { color: T.warn } }, '· ' + w))
                )
              : null,
            // 提示要看得见：11 号小字在深色背景上等于没有，用户会以为「按了没反应」。
            draftMsg
              ? h(
                  'div',
                  {
                    role: 'status',
                    'aria-live': 'polite',
                    style: {
                      marginTop: 8,
                      padding: '7px 10px',
                      borderRadius: 7,
                      border: '1px solid ' + T.border2,
                      background: T.bg,
                      fontSize: 12,
                      color: T.text,
                      lineHeight: 1.65,
                      wordBreak: 'break-word',
                    },
                  },
                  draftMsg
                )
              : null,
            // 内置指令：没草稿时摆出来，一键复制就发给 AI。
            // 提示词写在 REVIEW_PROMPT_TEMPLATE 里，跟插件校验规则同源，不让人每次手写。
            draftPrompt
              ? h(
                  'div',
                  { style: { marginTop: 8 } },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 } },
                    h('span', { style: { fontSize: 12, fontWeight: 600 } }, '发给 AI 的指令'),
                    h(
                      Button,
                      {
                        small: true,
                        kind: 'primary',
                        onClick: () => {
                          const ok = copyText(draftPrompt)
                          setDraftMsg(ok ? '指令已复制，粘贴到左侧对话发送即可。' : '复制失败：请手动选中下面的文本复制。')
                        },
                        title: '复制到剪贴板，粘进对话发送',
                      },
                      '复制指令'
                    ),
                    h('span', { style: { fontSize: 11, color: T.text2 } }, 'AI 跑完会用 lc_note_validate(save=true) 存成草稿')
                  ),
                  h('textarea', {
                    readOnly: true,
                    value: draftPrompt,
                    rows: 10,
                    'data-dsh-no-drag': '',
                    onFocus: (e) => {
                      try {
                        e.target.select()
                      } catch (err) {}
                    },
                    style: {
                      width: '100%',
                      boxSizing: 'border-box',
                      fontSize: 11,
                      lineHeight: 1.6,
                      padding: '8px 10px',
                      borderRadius: 7,
                      border: '1px solid ' + T.border2,
                      background: T.layer1,
                      color: T.text,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      resize: 'vertical',
                    },
                  })
                )
              : null
          ),
          // ---- 空状态：点过「载入 AI 草稿」但一条都没有时，说清下一步 ----
          draftTried && !drafts.length && !draftLoaded
            ? h(
                'div',
                {
                  role: 'status',
                  style: {
                    border: '1px dashed ' + T.border2,
                    borderRadius: 8,
                    padding: '10px 12px',
                    marginBottom: 10,
                    background: T.layer1,
                    fontSize: 12,
                    color: T.text2,
                    lineHeight: 1.8,
                  },
                },
                h('div', { style: { fontWeight: 600, color: T.text, marginBottom: 4 } }, '这个案件还没有 AI 草稿'),
                h('div', null, '草稿不是点按钮生成的：它得由 AI 在会话里跑完一遍、存成草稿后才读得到。'),
                h(
                  'div',
                  { style: { marginTop: 4 } },
                  options.length
                    ? '当前已索引 ' + options.length + ' 条条款。把上面那段指令交给 AI 跑，回来再点「载入 AI 草稿」。'
                    : '这个案件还没索引合同：先去「条款」页把合同切成条款。'
                )
              )
            : null,
          // ---- AI 草稿（采纳后才进台账）----
          drafts.length
            ? h(
                'div',
                { style: { border: '1px solid ' + T.brand, borderRadius: 8, padding: 10, background: T.layer2, marginBottom: 10 } },
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 } },
                  h('span', { style: { fontSize: 12, fontWeight: 600 } }, 'AI 草稿 ' + drafts.length + ' 条'),
                  h('span', { style: { fontSize: 11, color: T.text2 } }, '采纳才写进台账；草稿是初稿，责任仍是律师的'),
                  h(Button, { small: true, onClick: () => setDrafts([]) }, '清空草稿')
                ),
                discardErr
                  ? h('div', { role: 'alert', style: { fontSize: 11, color: T.err, marginBottom: 6 } }, '丢弃失败：' + discardErr)
                  : null,
                (Array.isArray(drafts) ? drafts : []).map((dr, i) =>
                  h(
                    'div',
                    {
                      key: i,
                      style: {
                        border: '1px solid ' + (dr.ok ? T.border : T.err),
                        borderRadius: 7,
                        padding: '7px 9px',
                        marginBottom: 6,
                        background: T.bg,
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                      h('span', { style: { fontSize: 11, fontWeight: 600, color: T.brand } }, dr.clause),
                      h(Tag, { tone: dr.level === '重大风险' ? 'err' : dr.level === '建议修改' ? 'warn' : 'idle' }, dr.level),
                      dr.quoteOk === true ? h(Tag, { tone: 'ok' }, '引文命中') : null,
                      dr.ok ? null : h(Tag, { tone: 'err' }, dr.problems.join('；')),
                      h(
                        'span',
                        { style: { marginLeft: 'auto', display: 'inline-flex', gap: 6 } },
                        h(
                          Button,
                          {
                            small: true,
                            kind: 'primary',
                            disabled: !dr.ok,
                            onClick: () => {
                              // 采纳＝填进下面的表单，不直接提交：人还要看一眼、可能改几个字
                              if (act.onDraftDiscard) act.onDraftDiscard({ clause: dr.clause })
                              setClause(dr.clause)
                              setLevel(dr.level)
                              setIssue(dr.issue)
                              setFix(dr.fix)
                              setBasis(dr.basis || '')
                              setQuote(dr.quote || '')
                              const hit = options.find((o) => o.no === dr.clause)
                              if (hit) { setPicked(hit.key); setFile(hit.file) }
                              setDrafts(drafts.filter((_, k) => k !== i))
                            },
                            title: dr.ok ? '这条要改：填进下面表单，改完点「登记意见」' : '先修好上面的问题',
                          },
                          '采纳（要修改）'
                        ),
                        // 丢弃＝「这条我看过了，不用改」。这是审核结论，必须留痕；
                        // 只从界面移除等于丢掉了「审过」这个事实，下次又会捡回来。
                        // 理由默认取 AI 自己的判断，但人可以在输入框里改——理由要人认可才作数。
                        h(
                          Button,
                          {
                            small: true,
                            disabled: discarding === dr.clause,
                            onClick: async () => {
                              setDiscarding(dr.clause)
                              setDiscardErr(null)
                              try {
                                // 理由选填（用户要求不用填）。
                                // 唯一要守住的：**绝不能**拿 dr.issue 当默认理由——
                                // issue 是"哪里有问题"，拿它当"为什么不用改"会写出自相矛盾的判定，
                                // 真机踩过：19 条风险条款全被记成「无需修改」。所以默认留空。
                                const why = String((dr._why || '')).trim()
                                const r = await act.onDraftDiscardAsNoRevision({ clause: dr.clause, reason: why, file: dr.file })
                                if (!r || r.ok === false) {
                                  setDiscardErr((r && r.message) || '记录判定失败')
                                  return
                                }
                                setDrafts(drafts.filter((_, k) => k !== i))
                                setDiscardReason('')
                                setDraftMsg((r && r.summary) || '已记录「已审·无需修改」')
                              } finally {
                                setDiscarding('')
                              }
                            },
                            title: '标记为「已审·无需修改」并留痕（理由选填，可留空）',
                          },
                          discarding === dr.clause ? '记录中…' : '丢弃（无需修改）'
                        )
                      )
                    ),
                    h('div', { style: { fontSize: 12, marginTop: 4, lineHeight: 1.6 } }, dr.issue),
                    dr.quote ? h('div', { style: { fontSize: 11, color: T.text2, marginTop: 2 } }, '引文：' + dr.quote) : null,
                    // 「丢弃时要写的理由」放在这张卡片里，就在丢弃按钮下面——
                    // 之前放在草稿区标题行，用户根本找不到（反馈：没有地方填理由）。
                    // 现在它是**选填**：留空直接丢弃即可。
                    h(
                      'div',
                      { style: { marginTop: 6 } },
                      h(TextInput, {
                        value: (dr && dr._why) || '',
                        onChange: (v) => {
                          const next = drafts.slice()
                          const hit = next.findIndex((x) => x.clause === dr.clause)
                          if (hit >= 0) next[hit] = Object.assign({}, next[hit], { _why: v })
                          setDrafts(next)
                        },
                        width: 420,
                        placeholder: '丢弃理由（选填，可留空）',
                      })
                    )
                  )
                )
              )
            : null,
          // ---- 片段级修订（Phase 3）----
          // 与整条替换的区别：只改条款里那一句话，其余原文原样保留。
          // 硬规则由服务端强制执行：original 必须唯一定位、补丁之间不得重叠、任一处不合格整批拒绝。
          h(
            'div',
            { style: { border: '1px solid ' + T.border, borderRadius: 8, padding: 10, background: T.layer1, marginBottom: 12 } },
            h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 2 } }, '片段级修订'),
            h(
              'div',
              { style: { fontSize: 11, color: T.text2, marginBottom: 6, lineHeight: 1.7 } },
              '只改那一段话，不动整条。原文片段必须在该条里**唯一出现**；出现两次或以上、或与其他修改重叠，整批拒绝应用（不会产出改了一半的合同）。'
            ),
            h(TextArea, {
              value: fragText,
              onChange: setFragText,
              rows: 5,
              placeholder: '每行一处修订，格式：条款号 | 原文片段 | 替换为 | 理由（可选）\n例如：第二条 | 交付标准由双方另行确定 | 交付标准以附件一为准 | 标准必须写死',
            }),
            h(
              FormRow,
              null,
              h(
                Button,
                {
                  small: true,
                  disabled: fragBusy || !fragText.trim(),
                  onClick: async () => {
                    setFragBusy(true)
                    setFragErr(null)
                    setFragPreview(null)
                    try {
                      const patches = parseFragmentLines(fragText)
                      if (!patches.length) {
                        setFragErr('没有解析出任何修订：每行至少要有「条款号 | 原文 | 替换为」三段')
                        return
                      }
                      const r = await act.onPatchPreview({ patches })
                      if (!r || r.ok === false) {
                        setFragErr((r && r.message) || '预览失败')
                        return
                      }
                      setFragPreview(r)
                    } catch (e) {
                      setFragErr((e && e.message) || String(e))
                    } finally {
                      setFragBusy(false)
                    }
                  },
                },
                fragBusy ? '校验中…' : '校验并预览'
              ),
              h(
                Button,
                {
                  small: true,
                  kind: 'primary',
                  disabled: fragBusy || !fragPreview,
                  onClick: async () => {
                    setFragBusy(true)
                    setFragErr(null)
                    try {
                      const r = await act.onPatchApply({ patches: parseFragmentLines(fragText) })
                      if (!r || r.ok === false) {
                        setFragErr((r && r.message) || '应用失败')
                        return
                      }
                      setFragMsg((r && r.summary) || '已生成修订版')
                      setFragPreview(null)
                    } catch (e) {
                      setFragErr((e && e.message) || String(e))
                    } finally {
                      setFragBusy(false)
                    }
                  },
                  title: '生成带修订痕迹的 docx；原合同只读，只写 out/ 下的新文件',
                },
                '生成修订版'
              )
            ),
            fragErr
              ? h('div', { role: 'alert', style: { fontSize: 11, color: T.err, marginTop: 6, lineHeight: 1.7 } }, fragErr)
              : null,
            fragMsg
              ? h('div', { style: { fontSize: 11, color: T.ok, marginTop: 6 } }, fragMsg)
              : null,
            fragPreview && fragPreview.diff && fragPreview.diff.length
              ? h(
                  'div',
                  { style: { marginTop: 8 } },
                  h('div', { style: { fontSize: 11, color: T.text2, marginBottom: 4 } }, fragPreview.summary),
                  fragPreview.diff.map((d, i) =>
                    h(
                      'div',
                      {
                        key: i,
                        style: { fontSize: 11, lineHeight: 1.7, borderLeft: '2px solid ' + T.brand, paddingLeft: 8, marginBottom: 6 },
                      },
                      h('span', { style: { fontWeight: 600 } }, d.clause + '：'),
                      d.addition
                        ? h('ins', { style: { color: T.ok, textDecoration: 'none' } }, '新增 ' + d.after)
                        : null,
                      d.addition ? null : h('del', { style: { color: T.err } }, d.before),
                      d.addition ? null : h('ins', { style: { color: T.ok, textDecoration: 'none' } }, d.after),
                      d.reason ? h('div', { style: { color: T.text2 } }, '理由：' + d.reason) : null
                    )
                  )
                )
              : null
          ),
          // ---- 登记意见 ----
          h(
            'div',
            { style: { border: '1px solid ' + T.border, borderRadius: 8, padding: 10, background: T.layer1, marginBottom: 12 } },
            h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 2 } }, '登记审核意见'),
            h('div', { style: { fontSize: 11, color: T.text2, marginBottom: 4 } }, '三要素缺一不收：指到条款 / 说清哪句话导致什么后果 / 给出可直接替换的条文'),
            h(
              FormRow,
              null,
              options.length
                // value 必须是 key：Select 的 onChange 交回来的是 option 的 value。
                // 只传 label 数组时，onPick 里按 key 匹配永远失败——选了条款等于什么都没做。
                ? h(Select, { value: picked, onChange: onPick, options: options.map((o) => ({ value: o.key, label: o.label })) })
                : h('span', { style: { fontSize: 12, color: T.warn } }, '还没索引合同：先去「条款」页索引，意见才能挂到条款上'),
              h(Select, { value: level, onChange: setLevel, options: ['重大风险', '建议修改', '提示'] }),
              h(TextInput, { value: basis, onChange: setBasis, width: 240, placeholder: '依据（法条 / 惯例，可选）' })
            ),
            options.length
              ? h(FormRow, null, h('span', { style: { fontSize: 11, color: T.text2 } }, '当前条款：' + clause + '（' + file + '）'))
              : h(FormRow, null, h(TextInput, { value: clause, onChange: setClause, width: 160, placeholder: '条款编号，如 第五条' })),
            h(
              FormRow,
              null,
              h('span', { style: { fontSize: 11, color: T.text2 } }, '风险点模板：'),
              RISK_TEMPLATES.map((t) =>
                h(
                  Button,
                  {
                    key: t.key,
                    small: true,
                    onClick: () => { setIssue(t.issue); setFix(t.fix) },
                    title: '填入后请把〔〕里的内容改成这份合同的实际情况',
                  },
                  t.key
                )
              )
            ),
            h(FormRow, null, h(TextArea, { value: issue, onChange: setIssue, rows: 2, placeholder: '问题：哪句话导致什么后果（一句话说清即可）' })),
            // ---- 引文（B）：给了就必须逐字出现在该条款里 ----
            h(
              FormRow,
              null,
              h(TextInput, {
                value: quote,
                onChange: setQuote,
                width: 520,
                placeholder: '引文（可选）：从该条款原文逐字摘抄，≥6 字；改写成同义句会被拒收',
              })
            ),
            h(FormRow, null, h(TextArea, { value: fix, onChange: setFix, rows: 3, placeholder: '替换条文：能直接粘回合同（写不出可留空）' })),
            h(
              FormRow,
              null,
              h(Button, { small: true, kind: 'primary', disabled: !canSubmit, onClick: () => {
                act.onNoteAdd({
                  file: file || undefined,
                  clause: clause.trim(),
                  level,
                  issue: issue.trim(),
                  fix: fix.trim(),
                  basis: basis.trim() || undefined,
                  quote: quote.trim() || undefined,
                })
                setIssue('')
                setFix('')
                setBasis('')
                setQuote('')
              } }, '登记意见'),
              h('span', { style: { fontSize: 11, color: T.text2 } }, '空泛话术（建议完善 / 予以重视…）会被插件直接拒收；引文必须逐字命中该条款')
            )
          ),
          // ---- 出口：意见表 / 修订 docx / 对照预览 ----
          h(
            FormRow,
            null,
            h(Button, { small: true, onClick: () => act.onReport({}) }, '生成意见表'),
            h(Button, { small: true, onClick: () => act.onRevise({}) }, '生成修订版 docx（含批注）'),
            h(Button, { small: true, onClick: () => act.onPreview({}) }, '修订对照预览'),
            h('span', { style: { fontSize: 11, color: T.text2 } }, '意见表是 Markdown；修订版带红色修订痕迹 + Word 批注（写明问题与建议）；对照预览只算不改文件')
          ),
          // ---- 预览结果（D）----
          preview && preview.items
            ? h(
                'div',
                { style: { border: '1px solid ' + T.border2, borderRadius: 8, padding: 10, background: T.layer2, marginTop: 10 } },
                h('div', { style: { fontSize: 12, fontWeight: 600 } }, '修订对照预览'),
                h('div', { style: { fontSize: 11, color: T.text2, marginTop: 2, lineHeight: 1.6 } }, preview.summary),
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 } },
                  (preview.items || []).map((it) =>
                    h(
                      'div',
                      { key: it.noteId, style: { border: '1px solid ' + T.border, borderRadius: 7, padding: '7px 9px', background: T.bg } },
                      h(
                        'div',
                        { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 } },
                        h('span', { style: { fontSize: 12, fontWeight: 600, color: T.brand } }, it.noteId + '｜' + it.clause),
                        h(Tag, { tone: it.level === '重大风险' ? 'err' : it.level === '建议修改' ? 'warn' : 'idle' }, it.level),
                        h('span', { style: { fontSize: 11, color: T.text2 } }, '删 ' + it.removedChars + ' 字 / 增 ' + it.addedChars + ' 字')
                      ),
                      diffBlock(it)
                    )
                  )
                ),
                h('div', { style: { fontSize: 11, color: T.text2, marginTop: 6 } }, preview.note || '')
              )
            : null,
          !data
            ? h(Empty, null, '读审核意见…')
            : !data.notes || !data.notes.length
              ? h(Empty, null, data.summary || '还没有审核意见')
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 } },
                  data.notes.map((n) =>
                    h(
                      'div',
                      { key: n.id, style: { padding: '8px 10px', border: '1px solid ' + T.border, borderRadius: 8, background: T.layer1 } },
                      h(
                        'div',
                        { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                        h('span', { style: { fontSize: 12, fontWeight: 600, color: T.brand } }, n.id),
                        h(Tag, { tone: n.level === '重大风险' ? 'err' : n.level === '建议修改' ? 'warn' : 'idle' }, n.level),
                        n.quote ? h(Tag, { tone: 'ok' }, '有引文') : null,
                        h('span', { style: { fontSize: 11, color: T.text2 } }, n.file ? n.file : ''),
                        h('span', { style: { fontSize: 12 } }, n.clause + (n.clauseHeading ? '　' + n.clauseHeading : '')),
                        // 落地形式：批注（正文不动）还是改正文（画红线）。
                        // 用按钮切换而不是下拉：这是每条意见都要做一次的决定，
                        // 下拉要点两下，按钮一下。当前态用实心/描边区分。
                        h(
                          'span',
                          { style: { display: 'inline-flex', gap: 4, alignItems: 'center' }, title: '这条意见落到 Word 里：只挂批注（正文不动），还是直接改正文（画红线）' },
                          h(
                            Button,
                            {
                              small: true,
                              kind: n.apply === 'redline' ? 'default' : 'primary',
                              onClick: () => act.onNoteApply && act.onNoteApply({ id: n.id, apply: 'comment' }),
                            },
                            '批注'
                          ),
                          h(
                            Button,
                            {
                              small: true,
                              kind: n.apply === 'redline' ? 'primary' : 'default',
                              onClick: () => act.onNoteApply && act.onNoteApply({ id: n.id, apply: 'redline' }),
                            },
                            '改正文'
                          )
                        ),
                        h('div', { style: { marginLeft: 'auto' } }, h(Button, { small: true, onClick: () => act.onNoteDelete({ id: n.id }) }, '作废'))
                      ),
                      n.quote
                        ? h('div', { style: { fontSize: 12, marginTop: 4, lineHeight: 1.6, color: T.text2, borderLeft: '2px solid ' + T.border2, paddingLeft: 8 } }, '引文：' + n.quote)
                        : null,
                      h('div', { style: { fontSize: 12, marginTop: 4, lineHeight: 1.6 } }, '问题：' + n.issue),
                      h(
                        'div',
                        { style: { fontSize: 12, marginTop: 3, lineHeight: 1.6, color: T.text2 } },
                        (n.apply === 'redline' ? '改正文：' : '建议改为：') + n.fix
                      ),
                      n.basis ? h('div', { style: { fontSize: 11, color: T.text2, marginTop: 2 } }, '依据：' + n.basis) : null
                    )
                  )
                )
            )
          : null
      )
    }

    /**
     * 全文条款视图：把整份合同一次性铺开，每条四段。
     *
     * 为什么要这个视图：原来的「意见」页是"下拉选一条 → 填表单"，
     * 人得先记住哪条有问题，再一条条翻。律师审合同实际是**通读**的，
     * 所以这里按条款顺序把四段并排摆出来：
     *   ① 原文   ② 审核意见   ③ 建议修改（带复制）   ④ 实际修改意见
     *
     * 「实际修改意见」是指律师最终决定写进台账的那句（notes.jsonl 里的 fix），
     * 和建议文分开显示：建议是模型/初稿，实际是人的定稿，两者必须能对照。
     */
    /**
     * 条款号 → 数字（客户端版）。
     * 与 lib/core/clause.js 的 clauseNoOf 同一判据，但不能 import（客户端只拿 react）。
     * 认「第二十三条」「第4条」「4」「4.」四种写法；认不出返回 null。
     */
    function clauseNoOfLocal(text) {
      const s = String(text || '').trim()
      const arabic = s.match(/^第?\s*(\d{1,3})\s*条?$/) || s.match(/^(\d{1,3})[.．、]/)
      if (arabic) return Number(arabic[1])
      const m = s.match(/第([零一二三四五六七八九十百]+)条/)
      if (!m) return null
      const d = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
      let total = 0
      let num = 0
      for (const ch of m[1]) {
        if (d[ch] !== undefined) num = d[ch]
        else if (ch === '十') { total += (num || 1) * 10; num = 0 }
        else if (ch === '百') { total += (num || 1) * 100; num = 0 }
      }
      return total + num
    }

    function FullTextReview(props) {
      // 「实际修改意见」要能人手填：这里存每条的编辑稿（key = file#clause）。
      // 用独立的 state 而不是直接改 props：编辑中不能反写台账，
      // 只有点「保存」才落盘（notes.jsonl），否则半句话就会被当成正式意见。
      const [finalEdits, setFinalEdits] = useState({})
      const [finalBusy, setFinalBusy] = useState('')
      const [finalMsg, setFinalMsg] = useState({})
      // 「审核意见」也要能人填：AI 草稿不一定覆盖全部问题，
      // 律师看出来但模型没提的风险必须有地方写（原来这里只读，用户无处下笔）。
      const [issueEdits, setIssueEdits] = useState({})
      const [issueLevels, setIssueLevels] = useState({})
      const files = (props.files || []).slice()
      const notes = (props.notes || []).slice()
      // 每条条款的落地形式选择（key = file#clause）。未登记意见时先记在这里，
      // 点「保存」时随意见一起写进台账。为什么不用 prompt/弹窗：这是每条都要做的选择，
      // 按钮一下最省事。
      const [applyChoice, setApplyChoices] = useState({})
      const drafts = Array.isArray(props.drafts) ? props.drafts : []
      const actions = props.actions || {}
      const keyword = String(props.keyword || '').toLowerCase()

      // 按「文件 + 条款号」索引意见与草稿。
      //
      // ⚠ 条款号必须**归一**：同一份合同里存在两种写法 ——
      //   前言里的编号列表会被切条成 `1`/`2`/`3`，正文条款是 `第一条`/`第二条`。
      //   意见登记时记的是「第一条」，而渲染循环用的是 `c.no`（可能是 `1`），
      //   键对不上 ⇒ myNotes 为空 ⇒ 「批注/改正文」按钮不出现、updateId 丢失导致
      //   「已登记过相同问题 N1」这种让人去点一个不存在按钮的报错（2026-11-01 真机）。
      //   所以这里把条款号统一折算成数字再拼键；折不出来就退回原文。
      const norm = (x) => String(x == null ? '' : x).replace(/\s+/g, '')
      const noKey = (x) => {
        const n = clauseNoOfLocal(x)
        return n ? 'N' + n : norm(x)
      }
      const notesBy = new Map()
      for (const n of notes) {
        const k = norm(n.file) + '#' + noKey(n.clause)
        if (!notesBy.has(k)) notesBy.set(k, [])
        notesBy.get(k).push(n)
      }
      // 草稿索引：**只登记一个键**。
      // 早先同时登记了 `file#clause` 和兜底 `#clause`，同一份草稿会被两条路径各取一次，
      // 结果同一条建议在界面上重复出现、复制按钮也多一个（测试抓到了）。
      // 现在：带 file 就用 file#clause，不带才用 `#clause` 兜底。
      const draftsBy = new Map()
      for (const d of drafts) {
        const k = d.file ? norm(d.file) + '#' + noKey(d.clause) : '#' + noKey(d.clause)
        if (!draftsBy.has(k)) draftsBy.set(k, [])
        draftsBy.get(k).push(d)
      }

      const copy = (text, label) => {
        const ok = copyText(text)
        if (actions.onNotice) actions.onNotice(ok ? '已复制' + (label || '') : '复制失败：请手动选中文本复制')
      }

      // 四段的小标题 + 统一外观
      const Seg = (title, body, opts) => {
        const o = opts || {}
        return h(
          'div',
          { style: { marginTop: o.first ? 0 : 8 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 } },
            h('span', { style: { fontSize: 11, fontWeight: 600, color: o.color || T.text2 } }, title),
            o.copyText
              ? h(
                  Button,
                  {
                    small: true,
                    onClick: () => copy(o.copyText, '「' + title + '」'),
                    title: '复制这一段到剪贴板',
                  },
                  '复制'
                )
              : null
          ),
          h(
            'div',
            {
              style: {
                fontSize: 12,
                lineHeight: 1.8,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: o.muted ? T.text2 : T.text,
                background: o.bg || T.bg,
                border: '1px solid ' + T.border,
                borderRadius: 6,
                padding: '7px 9px',
              },
            },
            body
          )
        )
      }

      let shown = 0
      const blocks = []
      for (const f of files) {
        const fname = f.name
        const clauses = Array.isArray(f.clauses) ? f.clauses : []
        for (const c of clauses) {
          const k = norm(fname) + '#' + noKey(c.no)
          const myNotes = notesBy.get(k) || []
          // 兜底键必须用**同一套归一**（noKey），否则草稿永远匹配不到：
          // 键已经是 '#N1' 这种形态了，还在用 '#' + norm(c.no) 就是 '#第一条'，永远查不到。
          const myDrafts = draftsBy.get(k) || draftsBy.get('#' + noKey(c.no)) || []
          const body = String(c.text || '')
          // 关键词过滤：原文 / 意见 / 建议 / 实际 任一命中即显示
          if (keyword) {
            const hay = (body + ' ' + myNotes.map((n) => n.issue + n.fix).join(' ') + ' ' + myDrafts.map((d) => d.issue + d.fix).join(' ')).toLowerCase()
            if (!hay.includes(keyword)) continue
          }
          shown += 1

          // ② 审核意见：优先取已登记的正式意见；没有就取 AI 草稿；都没有则标待审
          // ---- ② 审核意见：**合并成一条** ----
          const opSegs = []
          // 同一条款常有多个独立风险点（实测第10条有 5 条），逐条罗列会把版面撑成
          // 三四个红标签，人看不出"这条整体多严重"。所以：
          //   · 级别取其中**最高**的（重大风险 > 建议修改 > 提示）
          //   · 各风险点的说明按顺序合成一段（带序号，便于引用）
          const levelRank = { 重大风险: 0, 建议修改: 1, 提示: 2 }
          const pickHighest = (list) => {
            let best = null
            for (const x of list) {
              const lv = x && x.level
              if (!lv || levelRank[lv] === undefined) continue
              if (!best || levelRank[lv] < levelRank[best]) best = lv
            }
            return best || '提示'
          }

          const hasNotes = myNotes.length > 0
          const src = hasNotes ? myNotes : myDrafts
          let opBody = null
          let opLevel = null
          let opTags = []
          if (src.length) {
            opLevel = pickHighest(src)
            // 合并正文：多条时加编号，单条不加（避免"1."这种无意义前缀）
            const lines = src
              .map((x, i) => {
                const text = String((hasNotes ? x.issue : (x.issue || x.title)) || '').trim()
                return text ? (src.length > 1 ? i + 1 + '. ' + text : text) : ''
              })
              .filter(Boolean)
            opBody = lines.join('\n')
            opTags = hasNotes
              ? [{ tone: 'idle', text: '已登记' + (myNotes.length > 1 ? ' ' + myNotes.length + ' 条' : '') }]
              : [
                  { tone: 'idle', text: 'AI 草稿' + (myDrafts.length > 1 ? ' ' + myDrafts.length + ' 条' : '') },
                  myDrafts.some((d) => d.quoteOk === true) ? { tone: 'ok', text: '引文命中' } : null,
                ].filter(Boolean)
          }

          if (opBody) {
            opSegs.push(
              h(
                'div',
                { key: 'merged' },
                h(
                  'div',
                  { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 3 } },
                  h(Tag, { tone: opLevel === '重大风险' ? 'err' : opLevel === '建议修改' ? 'warn' : 'idle' }, opLevel),
                  opTags.map((t, i) => h(Tag, { key: 't' + i, tone: t.tone }, t.text)),
                  hasNotes && myNotes[0].basis
                    ? h('span', { style: { fontSize: 11, color: T.text2 } }, '依据：' + myNotes[0].basis)
                    : null
                ),
                h('div', { style: { fontSize: 12, lineHeight: 1.8, whiteSpace: 'pre-wrap' } }, opBody)
              )
            )
          } else {
            opSegs.push(
              h(
                'div',
                { style: { fontSize: 12, color: T.text2, lineHeight: 1.8 } },
                c.ruling && c.ruling.kind === 'norevision'
                  ? '已审·无需修改' + (c.ruling.reason ? '（' + c.ruling.reason + '）' : '')
                  : '还没有审核意见'
              )
            )
          }

          // 这条条款已登记的意见（取第一条作代表）：决定 Word 里用批注还是改正文
          const applyWhich = myNotes.length ? myNotes[0] : null
          // 当前生效的落地形式：已登记意见优先用它存的值；否则用本页临时选择
          const applyNow = applyWhich ? (applyWhich.apply === 'redline' ? 'redline' : 'comment') : (applyChoice[k] || 'comment')
          const finalText = myNotes.map((n) => n.fix).filter(Boolean).join('\n\n')
          const suggestText = myDrafts
            .map((d) => d.fix)
            .filter(Boolean)
            .join('\n\n')

          // 输入框的值：用户改过就用改的；没改过就带出建议文（没有则带出已定稿）。
          // 必须放在 suggestText 之后——放在前面会在暂时性死区里读它。
          const editVal = finalEdits[k] != null ? finalEdits[k] : (suggestText || finalText || '')
          // 审核意见输入框：改过用改的；没改过就带出合并后的意见（便于在原文上补充）
          const issueVal = issueEdits[k] != null ? issueEdits[k] : (opBody || '')
          const issueLevel = issueLevels[k]

          blocks.push(
            h(
              'div',
              {
                key: k,
                'data-lawcase-clause': c.no,
                style: {
                  border: '1px solid ' + T.border,
                  borderRadius: 8,
                  padding: 10,
                  marginBottom: 10,
                  background: T.layer1,
                },
              },
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 } },
                h('span', { style: { fontSize: 13, fontWeight: 600 } }, fname.replace(/\.docx?$/i, '') + ' ' + c.no),
                c.heading ? h('span', { style: { fontSize: 11, color: T.text2 } }, c.heading) : null,
                myNotes.length ? h(Tag, { tone: 'ok' }, '已登记 ' + myNotes.length) : null,
                !myNotes.length && myDrafts.length ? h(Tag, { tone: 'warn' }, 'AI 草稿 ' + myDrafts.length) : null,
                c.ruling && c.ruling.kind === 'norevision' ? h(Tag, { tone: 'idle' }, '无需修改') : null
              ),
              Seg('原文', body, { first: true, bg: T.bg }),
              // ② 审核意见：上面合并展示已有的（AI 草稿/正式意见），
              //    下面给一个可编辑输入框 —— 模型没提到、但律师看出来的风险必须有地方写。
              h(
                'div',
                { style: { marginTop: 8 } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: 11, fontWeight: 600, color: T.text2 } }, '审核意见'),
                  h(Select, {
                    value: issueLevel || opLevel || '建议修改',
                    onChange: (v) => setIssueLevels(Object.assign({}, issueLevels, { [k]: v })),
                    options: ['重大风险', '建议修改', '提示'],
                  }),
                  h(
                    'span',
                    { style: { fontSize: 11, color: T.text2 } },
                    opBody ? '已合并显示；可在下面补充或改写' : '识别到的问题写在这里（哪句话 → 导致什么后果）'
                  )
                ),
                opBody ? h('div', { style: { marginBottom: 6 } }, opSegs) : null,
                h('textarea', {
                  value: issueVal,
                  rows: 2,
                  'data-dsh-no-drag': '',
                  placeholder: '审核意见：哪句话导致什么后果（「建议完善」这类空泛话术会被拒收）',
                  onChange: (e) => {
                    const v = e.target.value
                    setIssueEdits(Object.assign({}, issueEdits, { [k]: v }))
                  },
                  style: {
                    width: '100%',
                    boxSizing: 'border-box',
                    fontSize: 12,
                    lineHeight: 1.8,
                    padding: '7px 9px',
                    borderRadius: 6,
                    border: '1px solid ' + T.border,
                    background: T.bg,
                    color: T.text,
                    fontFamily: 'inherit',
                    resize: 'vertical',
                  },
                })
              ),
              Seg('建议修改', suggestText || h('span', { style: { color: T.text2 } }, '（暂无建议：可以先用上面的 AI 审核生成）'), {
                bg: T.bg,
                copyText: suggestText,
                color: suggestText ? T.brand : T.text2,
              }),
              // ④ 实际修改意见：**可编辑**，默认带出建议文/已有定稿，点「保存」写进台账。
              // 这是律师真正定稿的地方——必须能改，而不是只能看。
              h(
                'div',
                { style: { marginTop: 8 } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: 11, fontWeight: 600, color: finalText ? T.ok : T.text2 } }, '实际修改意见'),
                  finalText ? h(Tag, { tone: 'ok' }, '已登记') : null,
                  // 落地形式：批注（正文不动）还是改正文（画红线）。
                  // ⚠ 必须**始终可见**：用户 2026-11-01 截图反馈「仍然没有」，
                  //   根因是第一版把它绑在「已登记意见」上，而走到这一步时多半还只是 AI 草稿。
                  //   正确顺序是「先决定形式，再保存」——形式随保存一起写进台账。
                  h(
                    'span',
                    { style: { display: 'inline-flex', gap: 4, alignItems: 'center' } },
                    h(
                      Button,
                      {
                        small: true,
                        kind: applyNow === 'redline' ? 'default' : 'primary',
                        title: '正文一个字不动，只在这条右侧挂批注（对外发意见稿用这个）',
                        onClick: () => {
                          if (applyWhich && actions.onNoteApply) actions.onNoteApply({ id: applyWhich.id, apply: 'comment' })
                          else setApplyChoices(Object.assign({}, applyChoice, { [k]: 'comment' }))
                        },
                      },
                      '批注'
                    ),
                    h(
                      Button,
                      {
                        small: true,
                        kind: applyNow === 'redline' ? 'primary' : 'default',
                        title: '正文画红色删除线并写入新条文（「我们已改好的稿子」用这个）',
                        onClick: () => {
                          if (applyWhich && actions.onNoteApply) actions.onNoteApply({ id: applyWhich.id, apply: 'redline' })
                          else setApplyChoices(Object.assign({}, applyChoice, { [k]: 'redline' }))
                        },
                      },
                      '改正文'
                    )
                  ),
                  h(
                    Button,
                    {
                      small: true,
                      kind: 'primary',
                      // 只要求「至少写了一处」：问题和条文都空才禁用。
                      // 原来两边都必填，等于不许只写问题、也不许只给条文（用户 2026-11-01 要求放开）。
                      disabled: finalBusy === k || (!String(editVal).trim() && !String(issueVal).trim()),
                      onClick: async () => {
                        const text = String(editVal).trim()
                        if (!text) return
                        if (!actions.onSaveFinal) {
                          setFinalMsg(Object.assign({}, finalMsg, { [k]: '当前环境不支持保存（缺少 onSaveFinal）' }))
                          return
                        }
                        setFinalBusy(k)
                        setFinalMsg(Object.assign({}, finalMsg, { [k]: '' }))
                        try {
                          const r = await actions.onSaveFinal({
                            file: fname,
                            clause: c.no,
                            fix: text,
                            // 问题描述用**人填的那份**（没有才回退到合并结果）：
                            // 律师补写的风险必须进台账，不能被模型的意见覆盖掉。
                            issue: String(issueVal).trim() || opBody || '',
                            level: issueLevel || opLevel || '建议修改',
                            // 该条款已有正式意见 → 原地更新它，而不是再登一条。
                            // 否则同一处反复保存会撞去重、或堆出一串重复意见。
                            updateId: myNotes.length ? myNotes[0].id : undefined,
                            apply: applyNow,
                          })
                          setFinalMsg(Object.assign({}, finalMsg, { [k]: (r && r.ok === false ? '保存失败：' + (r.message || '') : '已保存到台账') }))
                        } catch (e) {
                          setFinalMsg(Object.assign({}, finalMsg, { [k]: '保存失败：' + ((e && e.message) || e) }))
                        } finally {
                          setFinalBusy('')
                        }
                      },
                      title: '把这段条文作为该条款的正式意见写入台账（已审·需修改）',
                    },
                    finalBusy === k ? '保存中…' : '保存'
                  ),
                  h(
                    Button,
                    {
                      small: true,
                      disabled: !editVal,
                      onClick: () => copy(editVal, '「实际修改意见」'),
                      title: '复制这段条文',
                    },
                    '复制'
                  )
                ),
                h('textarea', {
                  value: editVal,
                  rows: 3,
                  'data-dsh-no-drag': '',
                  placeholder: '在这里写/改最终条文（会自动带出建议文，可随意编辑）',
                  onChange: (e) => {
                    const v = e.target.value
                    setFinalEdits(Object.assign({}, finalEdits, { [k]: v }))
                  },
                  style: {
                    width: '100%',
                    boxSizing: 'border-box',
                    fontSize: 12,
                    lineHeight: 1.8,
                    padding: '7px 9px',
                    borderRadius: 6,
                    border: '1px solid ' + (finalText ? T.ok : T.border),
                    background: T.bg,
                    color: T.text,
                    fontFamily: 'inherit',
                    resize: 'vertical',
                  },
                }),
                finalMsg[k]
                  ? h('div', { style: { fontSize: 11, marginTop: 3, color: /失败/.test(finalMsg[k]) ? T.err : T.ok } }, finalMsg[k])
                  : null
              )
            )
          )
        }
      }

      if (!shown) {
        return h(
          'div',
          { style: { fontSize: 12, color: T.text2, lineHeight: 1.9, padding: '10px 0' } },
          keyword ? '没有条款命中「' + props.keyword + '」。' : '这个案件还没有索引合同：先去「条款」页把合同切成条款。'
        )
      }

      return h(
        'div',
        null,
        // 审核操作条（AI 审核 / 模型选择）由外层传入，两种视图都能发起审核
        props.toolbar || null,
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 } },
          h('span', { style: { fontSize: 12, fontWeight: 600 } }, '全文条款（' + shown + ' 条）'),
          h('span', { style: { fontSize: 11, color: T.text2 } }, '每条：原文 / 审核意见 / 建议修改 / 实际修改意见'),
          h(TextInput, {
            value: props.keyword || '',
            onChange: props.onKeyword || (() => {}),
            width: 220,
            placeholder: '过滤（条款或正文关键词）',
          })
        ),
        blocks
      )
    }


    // ---------- 底部状态栏：现在在哪一步 + 下一步 ----------
    // 为什么要有它：台账页各管一段，用户容易不知道"整体走到哪了"。
    // 这里只做展示与跳转，判断全部来自 core 的 nextStep（与 lc_case_next 同一套）。
    function stagePlan(detail, step) {
      const st = (step && step.state) || {}
      const isContract = detail && detail.caseType === 'contract'
      const ck = (step && step.checkoff) || null
      const law = (step && step.lawtrace) || null
      if (isContract) {
        const clauses = st.clauses || 0
        const notes = st.notes || 0
        return [
          { key: '材料', tab: '材料', done: (st.materials || 0) > 0, hint: `材料 ${st.materials || 0}` },
          { key: '条款', tab: '条款', done: clauses > 0, hint: `条款 ${clauses}` },
          { key: '意见', tab: '意见', done: notes > 0, hint: `意见 ${notes}` },
          { key: '验收', tab: '验收', done: false, hint: '五道' },
        ]
      }
      const pendingKind = ck && ck.kinds
        ? (ck.kinds.material && ck.kinds.material.pending ? '材料' : ck.kinds.finding && ck.kinds.finding.pending ? '结论' : ck.kinds.fact && ck.kinds.fact.pending ? '事实' : '事实')
        : '事实'
      return [
        { key: '材料', tab: '材料', done: (st.materials || 0) > 0, hint: `材料 ${st.materials || 0}｜已解析 ${st.parsed || 0}` },
        { key: '工序', tab: '工序', done: (st.proc && st.proc.total) > 0, hint: st.proc ? `工序 ${st.proc.done}/${st.proc.total}` : '工序 0' },
        { key: '事实', tab: '事实', done: (st.facts || 0) > 0, hint: `事实 ${st.facts || 0}` },
        { key: '核对', tab: pendingKind, done: Boolean(ck && ck.total && ck.done >= ck.total), hint: ck ? `还差 ${ck.pending || 0} 条` : '' },
        { key: '结论', tab: '结论', done: (st.findings || 0) > 0, hint: `结论 ${st.findings || 0}` },
        {
          key: '法条',
          tab: '法条',
          // 结论都有法条、且溯源没查出问题，才算这一步做完
          done: Boolean(law && law.items && law.items.length && law.items.every((x) => x.level === 'pass')),
          hint: law && law.summary ? law.summary : '待溯源',
        },
        { key: '验收', tab: '验收', done: false, hint: '五道' },
      ]
    }

    function CaseStatusBar(props) {
      const { detail, step, onGoto, onNext, busy } = props
      const stages = stagePlan(detail, step)
      // 第一个没做完的阶段就是"当前阶段"
      const curIdx = Math.max(0, stages.findIndex((s) => !s.done))
      const next = step && step.next
      return h(
        'div',
        {
          className: 'lawcase-statusbar',
          style: {
            borderTop: '1px solid ' + T.border,
            background: T.layer1,
            flexWrap: 'wrap',
            minWidth: 0,
            fontSize: 12,
          },
        },
        // 阶段条
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', minWidth: 0 } },
          stages.map((s, i) =>
            h(
              'span',
              {
                key: s.key,
                onClick: () => onGoto && onGoto(s.tab),
                title: s.hint,
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px',
                  borderRadius: 999,
                  cursor: onGoto ? 'pointer' : 'default',
                  border: '1px solid ' + (i === curIdx ? T.brand : s.done ? T.ok : T.border2),
                  background: i === curIdx ? T.brand : 'transparent',
                  color: i === curIdx ? '#fff' : s.done ? T.ok : T.text2,
                  whiteSpace: 'nowrap',
                  fontWeight: i === curIdx ? 600 : 400,
                },
              },
              (s.done ? '✓ ' : i === curIdx ? '● ' : '○ ') + s.key
            )
          )
        ),
        // 卡点与下一步
        h(
          'div',
          {
            style: {
              marginLeft: 'auto',
              flex: '1 1 280px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minWidth: 0,
              flexWrap: 'wrap',
            },
          },
          h(
            'span',
            {
              style: {
                color: next ? T.text2 : T.ok,
                flex: '1 1 220px',
                minWidth: 0,
                overflowWrap: 'anywhere',
                whiteSpace: 'normal',
                maxWidth: '100%',
              },
              title: next ? `${next.stuck}｜${next.why || ''}` : (step && step.summary) || '',
            },
            next ? '卡在：' + next.stuck : (step && step.summary) || '读状态中…'
          ),
          next && onNext
            ? h(
                Button,
                {
                  small: true,
                  kind: 'primary',
                  disabled: Boolean(busy),
                  onClick: () => onNext(next),
                  title: next.action + (next.why ? '（' + next.why + '）' : ''),
                },
                '下一步：' + shortAction(next)
              )
            : null
        )
      )
    }

    /** 把 nextStep 的动作翻成短按钮文案（原文太长，放不下） */
    function shortAction(next) {
      const tool = String((next && next.tool) || '')
      const map = {
        lc_material_scan: '扫材料',
        lc_material_parse_all: '批量解析',
        lc_material_decide: '定版本',
        lc_proc_plan: '拆工序',
        lc_proc_update: next && next.args && next.args.id ? String(next.args.id) + ' 推进' : '推进工序',
        lc_fact_list: '核事实',
        lc_fact_add: '登事实',
        lc_finding_add: '出结论',
        lc_finding_list: '看结论',
        lc_candidate: '候选',
        lc_clause_index: '索引条款',
        lc_note_add: '登记意见',
        lc_precheck: '查占位符',
        lc_case_verify: '跑验收',
        lc_deliver: '打交付包',
        lc_review_open: '开对抗复盘',
        lc_review_verdict: '裁定攻击点',
      }
      return map[tool] || next.action || '继续'
    }

    /** 顶栏「上次动作」文案：只给结论，不给 JSON（审计里那份留给工具） */
    function lastActionLine(brief) {
      const b = brief || {}
      const last = b.last
      if (!last) return ''
      return `${last.when || ''} ${last.label || last.op || ''}${last.detail ? '（' + last.detail + '）' : ''}`.trim()
    }

    /** 顶栏「卡点」文案：没有卡点就不占位置（全部做完时应该说「可交付」，不是空白） */
    function blockerLine(brief) {
      const b = brief || {}
      if (b.blocker && b.blocker.text) return String(b.blocker.text)
      if (b.checkoff && b.checkoff.total && b.checkoff.pending === 0) return '核对已齐'
      return ''
    }

    /**
     * 页签上的数目与状态点（界面 U1）。
     *
     * 口径：数目 = 这一页有多少条（材料/事实/结论/条款/法条），工序与验收用「完成/总数」，
     * 概览不带数。状态点只表达一件事：**这一页有没有需要人处理的东西**。
     *   err  = 有红色卡点（核对后被改、验收 ⛔）
     *   warn = 有未完成（未核、工序未做完）
     *   ok   = 齐了
     * 不做成"每页都绿"，因为全绿等于没有信息。
     */
    function tabMeta(t, props, data) {
      const ck = props && props.checkoff
      const kinds = (ck && ck.kinds) || {}
      const d = data || {}
      const st = (d.state || {})
      const num = (n) => (typeof n === 'number' ? n : null)
      switch (t) {
        case '材料': {
          const k = kinds.material
          const total = k ? k.total : num(st.materials) ?? (d.materials && typeof d.materials.total === 'number' ? d.materials.total : null)
          return { count: total, tone: k && k.stale ? 'err' : k && k.pending ? 'warn' : k ? 'ok' : null, title: k ? `材料 ${k.total} 份｜已核 ${k.done}｜未核 ${k.pending}` : '材料清单' }
        }
        case '事实': {
          const k = kinds.fact
          const total = k ? k.total : num(st.facts) ?? (d.facts && typeof d.facts.total === 'number' ? d.facts.total : null)
          return { count: total, tone: k && k.stale ? 'err' : k && k.pending ? 'warn' : k ? 'ok' : null, title: k ? `事实 ${k.total} 条｜已核 ${k.done}｜未核 ${k.pending}${k.stale ? `｜核后被改 ${k.stale}` : ''}` : '事实台账' }
        }
        case '结论': {
          const k = kinds.finding
          const total = k ? k.total : num(st.findings) ?? (d.findings && typeof d.findings.total === 'number' ? d.findings.total : null)
          return { count: total, tone: k && k.stale ? 'err' : k && k.pending ? 'warn' : k ? 'ok' : null, title: k ? `结论 ${k.total} 条｜已核 ${k.done}｜未核 ${k.pending}${k.stale ? `｜核后被改 ${k.stale}` : ''}` : '结论台账' }
        }
        case '条款':
          return { count: num(st.clauses), tone: null, title: '合同条款索引' }
        case '意见':
          return { count: num(st.notes), tone: null, title: '条款级审核意见' }
        case '工序': {
          const p = st.proc || (d.proc && d.proc.total ? d.proc : {})
          if (!p.total) return { count: null, tone: null, title: '办理工序' }
          return { count: `${p.done}/${p.total}`, tone: p.done === p.total ? 'ok' : 'warn', title: `工序已完成 ${p.done}/${p.total}` }
        }
        case '验收':
          return { count: null, tone: null, title: '五道验收' }
        default:
          return { count: null, tone: null, title: t }
      }
    }

    function DetailPane(props) {
      const {
        detail, tab, setTab, tabData, verifyResult, runVerify, busy, tabErr, actions, notice, running,
        // 核对人 / 签字人（页内输入，不用 window.prompt）
        checker, onCheckerChange,
      } = props
      if (!detail) {
        return h(
          'div',
          { style: Object.assign({}, S.scroll, { color: T.text2, fontSize: 13, lineHeight: 1.9 }) },
          h('div', { style: { fontSize: 15, fontWeight: 600, color: T.text, marginBottom: 6 } }, APP_TITLE),
          h('div', null, APP_DESC),
          h('div', { style: { marginTop: 12 } }, '左边选一个案件开始。没有案件就先把案件根目录填上，或用上面「新建案件」。'),
          h('div', { style: { marginTop: 12, fontSize: 12 } }, '接口：POST ' + API + '（读 + 写，都是同一套 core）')
        )
      }
      const d = detail
      // 当前案件目录：DetailPane 不在 Panel 作用域里，拿不到 Panel 的 activeDir。
      // 但 detail 里的 dir 就是 Panel 选中的那个案件（summarizeCase 必带 dir），
      // 所以从 detail 取，别再从外层抓变量——之前抓 activeDir 直接导致整页渲染崩掉
      // （ReferenceError: activeDir is not defined → 工作台显示「渲染出错」）。
      const caseDir = d.dir || ''
      // 合同审核案**没有「工序」页**（用户 2026-10-27 明确要求）：
      // 工序是诉讼/争议案拆办理步骤用的；合同审核的推进单位是"条款"，
      // 用「条款状态 + 意见 + 预检 + 验收」就够了，多一个空工序表只会让下一步提示指向空页面。
      const tabs =
        d.caseType === 'contract'
          // 预检页签已去掉（用户 2026-11-01：预检这一步可以不要）。
          // 它的占位符检查并入「验收」；AI 审核已覆盖编号/附件/关键词/签署。
          ? ['概览', '材料', '条款', '意见', '验收']
          : ['概览', '材料', '事实', '结论', '法条', '工序', '验收']
      const shown = tabs.includes(tab) ? tab : '概览'
      const brief = d.review && d.review.brief ? d.review.brief : ''
      return h(
        'div',
        { className: 'lawcase-main', style: S.main },
        h(
          'div',
          { style: { position: 'relative', zIndex: 1, minWidth: 0, background: T.bg, padding: '12px 16px 8px', borderBottom: '1px solid ' + T.border } },
          h(
            'div',
            { style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0 } },
            h('div', { style: { fontSize: 16, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: d.title }, d.title || d.caseId),
            h(Tag, { tone: 'brand' }, d.caseTypeLabel),
            // 合同审核案：标题旁显示「立场｜类型」，**并且可以直接点开改**。
            // 用户 2026-11-01：「立场这里要能修改」——原本它只是个只读 Tag，
            // 要改得绕到意见页的「审核口径」区块，等于把最常改的东西藏起来了。
            // 现在：点它原地展开选择器，选完立即写回 case.json。
            d.caseType === 'contract' && brief ? h(Tag, { tone: 'ok' }, brief) : null,
            d.status ? h(Tag, { tone: 'idle' }, d.status) : null,
            // 对话绑定：直接告诉人「左侧对话框里的指令作用于哪个案」
            props.sessionBinding
              ? h(
                  Tag,
                  { tone: 'ok' },
                  '对话已绑此案'
                )
              : props.canBind
                ? h(Tag, { tone: 'warn' }, '对话未绑定案件')
                : null,
            props.canOpenAi
              ? h(Button, {
                  small: true,
                  kind: props.aiOpen ? 'primary' : 'default',
                  onClick: props.onToggleAi,
                  'aria-expanded': props.aiOpen,
                  'aria-controls': 'lawcase-ai-drawer',
                  title: props.aiOpen ? '收起 AI 对话' : '按需打开 AI 对话',
                }, props.aiOpen ? '收起 AI 对话' : '打开 AI 对话')
              : null,
             notice ? h('div', { style: { marginLeft: 'auto' } }, h(Notice, { notice })) : null
          ),
          // 上次动作 / 当前卡点（界面 U2）：路径是静态信息，律师真正要的是**时间维度**。
          // 这一行和 lc_case_brief 同源（不各算一遍），没有内容就整行不出现——空行是视觉噪音。
          lastActionLine(props.brief)
            ? h(
                'div',
                { className: 'lawcase-briefline', style: { fontSize: 12, marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 } },
                h('span', { style: { color: T.text2, flex: '0 0 auto' } }, '上次动作'),
                h('span', { style: { color: T.text, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: props.brief && props.brief.last ? props.brief.last.time : '' }, lastActionLine(props.brief)),
                blockerLine(props.brief)
                  ? h('span', { style: { color: props.brief.tri && props.brief.tri.stale ? T.err : T.warn, flex: '0 0 auto', fontWeight: 600 } }, '卡点：' + blockerLine(props.brief))
                  : null
              )
            : null,
          h('div', { style: { fontSize: 11, color: T.idle, marginTop: 3, wordBreak: 'break-all' } }, d.dir),
          props.sessionBinding
            ? h(
                'div',
                { style: { fontSize: 11, color: T.text2, marginTop: 2 } },
                '左侧对话的指令作用于本案件；要换案子请在左栏切换（会自动改绑），不同案件之间不会互相写串。'
              )
            : null
        ),
        h(
          'div',
          { className: 'lawcase-tabs', style: { display: 'flex', gap: 2, padding: '0 12px', borderBottom: '1px solid ' + T.border, flexWrap: 'wrap', alignItems: 'center' } },
          tabs.map((t) => {
            // 页签上直接带数目与状态点：律师打开界面第一个问题是「还差什么」，
            // 旧版要逐个点进去数。数据本来就算好了（checkoff / state），只是没摆到这儿。
            const meta = tabMeta(t, props, d)
            return h(
              'button',
              {
                key: t,
                type: 'button',
                className: 'lawcase-tab',
                role: 'tab',
                'aria-selected': t === shown ? 'true' : 'false',
                onClick: () => setTab(t),
                title: meta.title || t,
                style: {
                  appearance: 'none',
                  border: 'none',
                  borderBottom: '2px solid ' + (t === shown ? T.brand : 'transparent'),
                  background: 'transparent',
                  color: t === shown ? T.text : T.text2,
                  fontWeight: t === shown ? 600 : 400,
                  fontSize: 13,
                  padding: '8px 10px',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                },
              },
              t,
              meta.count != null ? h('span', { className: 'lawcase-tab-count', style: { fontSize: 11, color: T.text2, fontVariantNumeric: 'tabular-nums' } }, meta.count) : null,
              meta.tone ? h('span', { className: 'lawcase-tab-dot', 'aria-hidden': 'true', style: { width: 6, height: 6, borderRadius: 999, background: T[meta.tone] || T.idle, flex: '0 0 auto' } }) : null,
              meta.count != null || meta.tone ? h('span', { style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' } }, meta.sr || '') : null
            )
          }),
          // 核对进度 + 签字：放在页签行右侧，台账页都能看到还差多少没核。
          //
          // 「材料」页一律不显示核对进度（2026-11-01 用户明确）：
          // 两种案型都不逐份核对材料 —— 诉讼线核的是事实与结论，合同审核线核的是
          // 条款与意见；材料只是登记 + 解析。此前只在合同审核案里隐藏，
          // 诉讼案的材料页仍显示「未核 32」，用户会以为材料这边还欠一道必做工序，
          // 于是卡在原地问"没找到审核处"。
          props.checkoff && shown !== '材料'
            ? h(
                'span',
                {
                  style: {
                    marginLeft: 'auto',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11,
                    color: T.text2,
                    whiteSpace: 'nowrap',
                  },
                  title: props.checkoff.summary + '（全案合计）',
                },
                // 只显示「当前这一页」的进度：在事实页看到 81/153 会以为事实还差 72 条，
                // 其实 153 是事实+结论的合计。全案合计放 tooltip。
                // 材料不在核对范围（见下方显示条件），所以这里没有 材料:'material'。
                (function () {
                  const kindOfTab = { 事实: 'fact', 结论: 'finding' }[shown]
                  const k = kindOfTab && props.checkoff.kinds ? props.checkoff.kinds[kindOfTab] : null
                  const done = k ? k.done : props.checkoff.done
                  const total = k ? k.total : props.checkoff.total
                  const pend = k ? k.pending : props.checkoff.pending
                  const stale = k ? k.stale : props.checkoff.stale
                  return [
                    h(
                      Tag,
                      { key: 'k', tone: pend ? 'warn' : stale ? 'err' : 'ok' },
                      `${k ? k.label : '核对'} ${done}/${total}`
                    ),
                    stale ? h(Tag, { key: 's', tone: 'err' }, `核对后已改 ${stale}`) : null,
                  ]
                })(),
                // 核对人/签字人：页内输入框。Electron 的 window.prompt 返回 null，
                // 用它就表现为「点了已核完全没反应」——这才是当时那个 bug 的根因。
                h('input', {
                  value: props.checker || '',
                  onChange: (e) => props.onCheckerChange && props.onCheckerChange(e.target.value),
                  placeholder: '核对人姓名',
                  'data-dsh-no-drag': '',
                  style: {
                    width: 96,
                    fontSize: 11,
                    padding: '3px 6px',
                    borderRadius: 6,
                    border: '1px solid ' + (props.checker ? T.border2 : T.warn),
                    background: T.bg,
                    color: T.text,
                  },
                }),
                props.onSign
                  ? h(
                      Button,
                      {
                        small: true,
                        kind: 'primary',
                        disabled: !props.checker,
                        onClick: () => props.onSign(String(props.checker || '').trim()),
                        title: props.checker ? '生成核对签字单（逐条结论 + 未核条数 + 文件指纹）' : '先在左边填核对人姓名',
                      },
                      '生成签字单'
                    )
                  : null
              )
            : null,
          // 手动刷新本页：在对话里登记完台账（事实/意见/材料…）后，点一下就同步过来
          props.onReloadTab
            ? h(
                'button',
                {
                  type: 'button',
                  title: '重新读取这一页的台账（在对话里登记完东西后点它）',
                  onClick: () => props.onReloadTab(),
                  'data-dsh-no-drag': '',
                  style: {
                    appearance: 'none',
                    marginLeft: props.checkoff ? 0 : 'auto',
                    border: '1px solid ' + T.border2,
                    background: 'transparent',
                    color: T.text2,
                    borderRadius: 6,
                    fontSize: 11,
                    padding: '3px 9px',
                    cursor: 'pointer',
                  },
                },
                '刷新本页'
              )
            : null
        ),
        h(
          'div',
          { className: 'lawcase-scroll', style: S.scroll },
          tabErr ? h('div', { role: 'alert', 'aria-live': 'assertive', style: { color: T.err, fontSize: 12, marginBottom: 8, lineHeight: 1.6, overflowWrap: 'anywhere' } }, tabErr) : null,
          shown === '概览' ? h(Overview, { detail: d }) : null,
          shown === '材料'
            ? h(MaterialsView, {
                data: tabData.materials,
                // 材料页据此区分诉讼线（扫描后去抽事实）与合同审核线（扫描后去切条款）
                caseType: d.caseType,
              })
            : null,
          shown === '事实'
            ? h(FactsView, {
                data: tabData.facts,
                actions,
                focusId: tabData.focusId || '',
                batch: h(BatchCheckBar, {
                  draft: tabData.batchDraft || null,
                  checker,
                  running,
                  onCancel: () => setTabData((prev) => Object.assign({}, prev, { batchDraft: null })),
                  onConfirm: (d) => props.onBatchCheck && props.onBatchCheck(d),
                }),
              })
            : null,
          // actions 必须传：结论页的 ✓ 已核 / 改 / 疑 全靠它。
          // 漏传的后果不是报错，而是这一页**一个核对按钮都没有**（事实页有、结论页没有）。
          shown === '结论' ? h(FindingsView, { data: tabData.findings, actions, checker }) : null,
          shown === '法条'
            ? h(LawTraceView, {
                data: tabData.lawtrace || null,
                running: props.running,
                onRun: () => {
                  // 重新核对：清掉本页缓存再跑，结果覆盖回页面（否则看起来像没反应）
                  if (props.onReloadTab) props.onReloadTab()
                  if (actions && actions.onLawTrace) actions.onLawTrace({})
                },
                onGotoFindings: () => setTab('结论'),
              })
            : null,
          shown === '条款' ? h(ClausesView, { data: tabData.clauses, actions }) : null,
          shown === '意见'
            ? h(NotesView, {
                data: tabData.notes,
                actions,
                caseDir,
                files: (tabData.clauses && tabData.clauses.files) || [],
                review: d.review || null,
                preview: tabData.preview || null,
              })
            : null,
          // 预检页签已去掉；占位符自查并入「验收」（见下面 VerifyView 上方的自查块）
          shown === '工序'
            ? h(ProcView, {
                data: tabData.processes,
                actions,
                // 建完表要重读工序页：否则界面还停在空表分支，
                // 用户会以为"提交了没反应"，其实台账已经有表了。
                onPlanned: () => {
                  if (props.onReloadTab) props.onReloadTab('processes')
                },
              })
            : null,
          shown === '验收'
            ? h(
                'div',
                { style: { marginBottom: 10, padding: '8px 10px', border: '1px dashed ' + T.border2, borderRadius: 8, background: T.layer1 } },
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: 12, fontWeight: 600 } }, '机器自查（占位符）'),
                  h(
                    Button,
                    { small: true, disabled: Boolean(running), onClick: () => { if (actions && actions.onPrecheck) actions.onPrecheck({}) } },
                    running ? '检查中…' : '检查未填占位符'
                  ),
                  h(
                    'span',
                    { style: { fontSize: 11, color: T.text2 } },
                    '只查「〔〕/____/待填写」这类没填的空位——不调模型、不判断风险；风险由 AI 审核与人工核对负责。'
                  )
                ),
                tabData.precheck && tabData.precheck.findings && tabData.precheck.findings.length
                  ? h(
                      'div',
                      { style: { marginTop: 6, fontSize: 12, lineHeight: 1.7 } },
                      tabData.precheck.findings
                        .filter((f) => f.ruleId === 'placeholder')
                        .slice(0, 8)
                        .map((f) => h('div', { key: f.id, style: { color: T.warn } }, '· ' + f.title))
                    )
                  : tabData.precheck
                    ? h('div', { style: { marginTop: 6, fontSize: 12, color: T.ok } }, '没有未填的占位符')
                    : null
              )
            : null,
          shown === '验收'
            ? h(VerifyView, {
                result: verifyResult,
                onRun: runVerify,
                busy,
                // 验收查出问题后要能直接跳过去处理：否则用户只能自己去 81 条里翻。
                // 这里只负责「告诉上层要聚焦哪一条」，写状态由 PanelInner 做——
                // DetailPane 没有 setTabData（上次直接调它，抛异常导致点击毫无反应）。
                onGotoItem: (ref) => {
                  if (props.onFocusItem) props.onFocusItem(String(ref || ''))
                },
                onReviseDocx: props.onReviseDocx,
                onWaive: props.onWaive,
                // 预览区所需的数据必须一起转发，否则：
                //   · revising 是 undefined → 按钮文案永远不变（看起来"点了没反应"）
                //   · outputs 是 undefined → 产出预览区永远空
                outputs: props.outputs,
                revising: props.revising,
                reviseMsg: props.reviseMsg,
                onLoadOutputs: props.onLoadOutputs,
                onOpenOutput: props.onOpenOutput,
                openBusy: props.openBusy,
              })
            : null
        ),
        // 底部状态栏：现在在哪一步 + 下一步（判断来自 core.nextStep，不在这里另写一套）
        h(CaseStatusBar, {
          detail: d,
          step: props.step,
          busy: props.running || props.busy,
          onGoto: setTab,
          onNext: props.onNext,
        })
      )
    }

    // ---------- 操作条（写操作入口）----------
    function Notice(props) {
      const n = props.notice
      if (!n) return null
      return h(
        'div',
        {
          className: 'lawcase-notice',
          role: n.ok ? 'status' : 'alert',
          'aria-live': n.ok ? 'polite' : 'assertive',
          title: n.text,
          style: {
            fontSize: 12,
            lineHeight: 1.6,
            padding: '5px 9px',
            borderRadius: 7,
            border: '1px solid ' + (n.ok ? T.ok : T.err),
            color: n.ok ? T.ok : T.err,
            background: 'transparent',
            maxWidth: 'min(680px, 100%)',
            maxHeight: 96,
            overflow: 'auto',
            overflowWrap: 'anywhere',
            whiteSpace: 'normal',
          },
        },
        n.text,
        n.retry
          ? h(
              'button',
              {
                type: 'button',
                onClick: n.retry,
                'data-dsh-no-drag': '',
                style: {
                  marginLeft: 8,
                  appearance: 'none',
                  border: '1px solid currentColor',
                  borderRadius: 6,
                  background: 'transparent',
                  color: 'inherit',
                  padding: '2px 7px',
                  cursor: 'pointer',
                  fontSize: 11,
                },
              },
              '重试'
            )
          : null
      )
    }

    // ---------- AI 协助抽屉（工作台模式）----------
    // 宿主在 customFrame 模式下传进来的 conversation 节点就是原生会话；
    // 我们不复制聊天界面，只决定它出现在哪儿、什么时候出现。
    function AiDrawer(props) {
      const { conversation, service, folder, open, onClose, onStart, busy } = props
      if (!open) return null
      const session = service && typeof service.currentSession === 'function' ? service.currentSession() : null
      const hasNode = Boolean(conversation)
      return h(
        'div',
        {
          id: 'lawcase-ai-drawer',
          className: 'lawcase-ai',
          style: {
            width: 460,
            minWidth: 320,
            maxWidth: '52%',
            borderLeft: '1px solid ' + T.border,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            background: T.bg,
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              borderBottom: '1px solid ' + T.border,
              flexWrap: 'wrap',
            },
          },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, 'AI 协助'),
          h('div', { style: { fontSize: 11, color: T.text2, minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, folder || ''),
          h(Button, { small: true, onClick: onClose }, '收起')
        ),
        hasNode
          ? h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }, conversation)
          : session == null
          ? h(
              'div',
              { style: { padding: 16, fontSize: 13, lineHeight: 1.9, color: T.text2 } },
              h('div', { style: { marginBottom: 8 } }, '当前工作台还没有会话。开会话时用哪个目录当工作区？'),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h(Button, { small: true, kind: 'primary', disabled: busy || !folder, onClick: onStart }, busy ? '开会话…' : '用当前案件目录开会话'),
                folder ? h('span', { style: { fontSize: 11, color: T.text2, wordBreak: 'break-all' } }, folder) : h('span', { style: { fontSize: 11, color: T.warn } }, '先选一个案件，才知道在哪个目录里干活')
              ),
              h('div', { style: { fontSize: 11, marginTop: 10 } }, '会话归属由宿主登记；关掉抽屉不会删会话。')
            )
          : h('div', { style: { padding: 16, fontSize: 13, lineHeight: 1.9, color: T.text2 } },
              h('div', { style: { marginBottom: 6 } }, '会话已就绪，但宿主尚未把对话界面交给本工作台。'),
              h('div', null, '请关闭本抽屉后再点一次「打开 AI 对话」；若仍空白，说明该会话的归属登记未生效。')
            )
      )
    }

    // ---------- 目录选择器：本机目录点选 ----------
    // 数据来自只读 op fs.browse（只列子目录名，不读文件内容）。
    // 交互：点行进入子目录；行尾「选它」直接选定那一层；底部「选定此目录」选当前目录。
    function DirPicker(props) {
      const { open, title, startDir, onPick, onClose } = props
      const [cur, setCur] = useState('')
      const [draft, setDraft] = useState('')
      const [data, setData] = useState(null)
      const [err, setErr] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(async (to) => {
        setBusy(true)
        setErr(null)
        try {
          const d = await call('fs.browse', to ? { dir: to } : {})
          setData(d)
          setCur(d.dir)
          setDraft(d.dir)
        } catch (e) {
          setErr(e.message)
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => {
        if (open) load(startDir || '')
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open, startDir])

      if (!open) return null

      const choose = (p) => {
        if (!p) return
        if (onPick) onPick(p)
      }

      const entryRow = (e) =>
        h(
          'div',
          {
            key: e.path,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              borderBottom: `1px dashed ${T.border}`,
              minWidth: 0,
            },
          },
          h(
            'div',
            {
              onClick: () => load(e.path),
              title: e.path,
              style: {
                flex: 1,
                minWidth: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
                fontSize: 13,
                overflow: 'hidden',
              },
            },
            h('span', { style: { color: T.text2 } }, '📁'),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, e.name),
            e.hasCase ? h(Tag, { tone: 'ok' }, '案件') : null
          ),
          h(Button, { small: true, onClick: () => choose(e.path), title: '选定这个目录' }, '选它')
        )

      return h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,18,24,0.42)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            zIndex: 60,
          },
          onClick: (ev) => {
            if (ev && ev.target === ev.currentTarget && onClose) onClose()
          },
        },
        h(
          'div',
          {
            style: {
              width: 'min(720px, 96vw)',
              height: 'min(560px, 82vh)',
              background: T.bg,
              border: `1px solid ${T.border2}`,
              borderRadius: 12,
              boxShadow: '0 18px 48px rgba(0,0,0,.24)',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              overflow: 'hidden',
            },
          },
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                borderBottom: `1px solid ${T.border}`,
              },
            },
            h('div', { style: { fontSize: 13, fontWeight: 600, flex: 1 } }, title || '选择目录'),
            h(Button, { small: true, onClick: onClose }, '关闭')
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', flexWrap: 'wrap' } },
            h(Button, { small: true, disabled: busy || !(data && data.parent), onClick: () => load(data.parent) }, '上一级'),
            h('input', {
              value: draft,
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') load(String(draft).trim())
              },
              placeholder: '直接输入路径，回车跳转',
              spellCheck: false,
              'data-dsh-no-drag': '',
              style: {
                flex: 1,
                minWidth: 160,
                fontSize: 12,
                padding: '5px 7px',
                borderRadius: 6,
                border: `1px solid ${T.border2}`,
                background: T.bg,
                color: T.text,
              },
            }),
            h(Button, { small: true, disabled: busy, onClick: () => load(String(draft).trim()) }, busy ? '读中…' : '跳转')
          ),
          data && Array.isArray(data.sections) && data.sections.length
            ? h(
                'div',
                { style: { display: 'flex', gap: 6, padding: '0 12px 8px', flexWrap: 'wrap' } },
                ...data.sections.map((s) =>
                  h(Button, { key: s.label + '|' + s.path, small: true, onClick: () => load(s.path), title: s.path }, s.label)
                )
              )
            : null,
          h(
            'div',
            { style: { flex: 1, minHeight: 0, overflow: 'auto', borderTop: `1px solid ${T.border}` } },
            err
              ? h('div', { style: { padding: '10px 12px', fontSize: 12, color: T.err, lineHeight: 1.7 } }, err)
              : !data
                ? h('div', { style: { padding: '10px 12px', fontSize: 12, color: T.text2 } }, '读目录中…')
                : (data.entries || []).length
                  ? (data.entries || []).map(entryRow)
                  : h('div', { style: { padding: '10px 12px', fontSize: 12, color: T.text2 } }, '这个目录下没有子目录')
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 12px',
                borderTop: `1px solid ${T.border}`,
                background: T.layer1,
              },
            },
            h(
              'div',
              {
                title: cur,
                style: {
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12,
                  color: T.text2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              cur || '（未选定目录）'
            ),
            h(Button, { small: true, onClick: onClose }, '取消'),
            h(Button, { small: true, kind: 'primary', disabled: busy || !cur, onClick: () => choose(cur) }, '选定此目录')
          )
        )
      )
    }

    // ---------- 操作条 ----------
    // 建案只需要填名称：目录名由名称自动生成（落在案件根目录下），不必再手打路径。
    // 想放到别处就点「选择位置」点选父目录，或直接在目录框里改（改过就按你改的来）。
    function ActionBar(props) {
      const { activeDir, running, notice, root } = props
      const [mode, setMode] = useState(null) // null | 'new' | 'scan'
      // 打交付包前先在本区域确认（不用 window.confirm：Electron 下它返回 false，
      // 于是按钮"点了没反应"——与 prompt 是同一个坑）
      const [confirmDeliver, setConfirmDeliver] = useState(false)
      const [dir, setDir] = useState('') // 手动指定的完整路径（空 = 自动生成）
      const [baseDir, setBaseDir] = useState('') // 点选出来的父目录（空 = 用案件根目录）
      const [title, setTitle] = useState('')
      const [src, setSrc] = useState('')
      const [caseType, setCaseType] = useState('litigation')
      const [picker, setPicker] = useState(null) // null | 'case' | 'src'

      const autoName = dirNameOf(title)
      const autoDir = joinDir(baseDir || root || '', autoName)
      const effectiveDir = String(dir || '').trim() || autoDir

      const input = (value, onChange, placeholder, width) =>
        h('input', {
          value,
          onChange: (e) => onChange(e.target.value),
          placeholder,
          spellCheck: false,
          'data-dsh-no-drag': '',
          style: {
            fontSize: 12,
            padding: '4px 7px',
            borderRadius: 6,
            border: '1px solid ' + T.border2,
            background: T.bg,
            color: T.text,
            width: width || 200,
            minWidth: 0,
          },
        })

      const row = (...children) =>
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 } }, ...children)

      const hint = (text, tone) =>
        h('div', { style: { fontSize: 11, color: tone === 'err' ? T.err : T.text2, minWidth: 0, wordBreak: 'break-all' } }, text)

      return h(
        'div',
        {
          className: 'lawcase-actionbar',
          style: {
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            padding: '7px 16px',
            borderBottom: '1px solid ' + T.border,
            background: T.layer1,
          },
        },
        row(
          h(Button, { small: true, onClick: () => setMode(mode === 'new' ? null : 'new'), disabled: running }, '新建案件'),
          h(
            Button,
            {
              small: true,
              onClick: () => setMode(mode === 'scan' ? null : 'scan'),
              disabled: running || !activeDir,
              title: activeDir ? '把材料目录扫进本案' : '先选一个案件',
            },
            '扫材料'
          ),
          h(
            Button,
            {
              small: true,
              onClick: () => {
                if (!activeDir) return
                setConfirmDeliver(true)
              },
              disabled: running || !activeDir,
            },
            running ? '执行中…' : '打交付包'
          ),
          // 「在 Finder 中显示」：交付包在案件根目录下（交付包_日期-时间/），
          // 不在 out/ 里；用户打完包常常找不到它落在哪（2026-11-01 提出）。
          // -R 会直接在 Finder 里把那个文件夹选中，不是打开里面的内容。
          props.onRevealDeliver
            ? h(
                Button,
                { small: true, onClick: () => props.onRevealDeliver({}), disabled: !activeDir, title: '在 Finder 里定位最新的交付包文件夹' },
                '在 Finder 中显示'
              )
            : null,
          h(Button, { small: true, onClick: props.onReloadCase, disabled: running || !activeDir }, '重读本案'),
          h(Notice, { notice })
        ),
        // 打交付包的页内确认（替代 window.confirm）
        confirmDeliver
          ? h(
              'div',
              {
                role: 'alert',
                style: {
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  padding: '8px 10px',
                  border: '1px solid ' + T.warn,
                  borderRadius: 8,
                  background: 'rgba(200,140,20,.08)',
                  fontSize: 12,
                  lineHeight: 1.7,
                },
              },
              h('span', null, '打交付包？会把意见表、修订版、台账和验收结果复制到一个带时间戳的目录。'),
              h(
                Button,
                {
                  small: true,
                  kind: 'primary',
                  onClick: () => {
                    setConfirmDeliver(false)
                    props.onDeliver()
                  },
                },
                '确认打包'
              ),
              h(Button, { small: true, onClick: () => setConfirmDeliver(false) }, '取消')
            )
          : null,
        mode === 'new'
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 100%', minWidth: 0 } },
              row(
                input(title, setTitle, '案件名称（必填，目录名由它生成）', 260),
                h(Select, { value: caseType, onChange: setCaseType, options: CASE_TYPES })
              ),
              row(
                input(effectiveDir, (v) => setDir(v), '案件目录（留空自动生成）', 320),
                h(Button, { small: true, onClick: () => setPicker('case'), disabled: running }, '选择位置'),
                dir
                  ? h(
                      Button,
                      { small: true, onClick: () => setDir(''), disabled: running, title: '清掉手动路径，回到按名称自动生成' },
                      '自动'
                    )
                  : null,
                h(
                  Button,
                  {
                    small: true,
                    kind: 'primary',
                    disabled: running || !effectiveDir || !title.trim(),
                    onClick: () => {
                      props.onNewCase({ dir: effectiveDir, title: title.trim(), source: src.trim(), caseType })
                      setMode(null)
                      setDir('')
                      setBaseDir('')
                      setTitle('')
                      setSrc('')
                    },
                  },
                  '建案并扫描'
                )
              ),
              hint(
                title.trim()
                  ? '将建在：' + effectiveDir + (dir ? '（已手动指定）' : '（按案件名称自动生成）')
                  : '先填案件名称，目录名会自动生成；想换个位置就点「选择位置」',
                title.trim() ? null : 'err'
              ),
              row(
                input(src, setSrc, '卷宗目录（可选）', 260),
                h(Button, { small: true, onClick: () => setPicker('src'), disabled: running }, '选择材料目录')
              )
            )
          : null,
        mode === 'scan'
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 100%', minWidth: 0 } },
              row(
                input(src, setSrc, '材料目录（绝对路径）', 320),
                h(Button, { small: true, onClick: () => setPicker('src'), disabled: running }, '选择材料目录'),
                h(
                  Button,
                  {
                    small: true,
                    kind: 'primary',
                    disabled: running || !src.trim(),
                    onClick: () => {
                      props.onScan(src.trim())
                      setMode(null)
                      setSrc('')
                    },
                  },
                  '开始扫描'
                )
              )
            )
          : null,
        h(DirPicker, {
          open: picker === 'case' || picker === 'src',
          title: picker === 'src' ? '选择卷宗（材料）目录' : '选择案件位置',
          // 只往里开已存在的目录：新案目录这时还没建，拿它当起点会直接报不存在
          startDir: picker === 'src' ? src : baseDir || root || '',
          onClose: () => setPicker(null),
          onPick: (d) => {
            if (picker === 'src') setSrc(d)
            else {
              setBaseDir(d)
              setDir('')
            }
            setPicker(null)
          },
        })
      )
    }

    // ---------- 面板本体 ----------
    function PanelInner(hostProps) {
      const host = hostProps || {}
      const service = host.service
      const isWorkbench = Boolean(service && typeof service.ensureSession === 'function')
      const conversationNode = host.conversation || null

      const [root, setRoot] = useState(() => {
        try {
          return window.localStorage.getItem('lawcase.root') || ''
        } catch (e) {
          return ''
        }
      })
      const [cases, setCases] = useState(null)
      const [activeDir, setActiveDir] = useState(null)
      const [detail, setDetail] = useState(null)
      const [tab, setTab] = useState('概览')
      const [tabData, setTabData] = useState({})
      const [verifyResult, setVerifyResult] = useState(null)
      const [tabErr, setTabErr] = useState(null)
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)
      // 当前会话绑定到哪个案件（防「对话改错案」的可视化）
      const [sessionBinding, setSessionBinding] = useState(null)
      const refreshBinding = useCallback(async () => {
        const sid = isWorkbench && typeof service.currentSession === 'function' ? service.currentSession() : null
        if (!sid) {
          setSessionBinding(null)
          return
        }
        try {
          const r = await call('session.bind.list', { sessionId: sid })
          setSessionBinding(r && r.binding ? r.binding : null)
        } catch (e) {}
      }, [isWorkbench, service])
      // 核对人 / 签字人：**不能用 window.prompt**——Electron 里它返回 null，
      // 表现为「点了已核完全没反应」（踩过）。改成面板上的输入框，填一次记住。
      const [checker, setChecker] = useState('')
      const checkerRef = useRef('')
      const rememberChecker = useCallback((who) => {
        const w = String(who || '').trim()
        checkerRef.current = w
        setChecker(w)
        try {
          call('ui.state.set', { checker: w })
        } catch (e) {}
      }, [])
      const askChecker = useCallback(() => checkerRef.current, [])
      const loadedTabs = useRef({})

      const loadCases = useCallback(
        async (rootOverride) => {
          setBusy(true)
          setErr(null)
          try {
            const payload = rootOverride ? { root: rootOverride } : {}
            const data = await call('cases.list', payload)
            setCases(data.cases || [])
            // 把「根目录本身就是一个案件」说出来：这种填法会让列表只剩 1 条，
            // 用户会以为其它案件丢了（踩过：根目录被设成某个案件目录）
            if (data.single) {
              setErr('这个目录本身就是一个案件目录。建议把根目录设成它的上级（放所有案件的那一层），否则列表里只会看到它自己。')
            }
            if (data.root && !rootOverride) setRoot(data.root)
            if (rootOverride) {
              setRoot(rootOverride)
              // 存到插件状态目录：localStorage 是按 origin（含随机端口）隔离的，
              // 重启换端口就"掉了"，所以必须由宿主侧持久化。
              try {
                await call('ui.state.set', { root: rootOverride })
              } catch (e) {}
            }
          } catch (e) {
            setCases(null)
            setErr(e.message)
          } finally {
            setBusy(false)
          }
        },
        []
      )

      useEffect(() => {
        let cancelled = false
        ;(async () => {
          let stored = null
          let lastCase = null
          try {
            const st = await call('ui.state', {})
            stored = st && st.storedRoot ? st.storedRoot : null
            lastCase = st && st.lastCase ? st.lastCase : null
            // 上次填过的核对人：记住就不用每条都问
            if (st && st.checker) {
              checkerRef.current = String(st.checker)
              setChecker(String(st.checker))
            }
          } catch (e) {}
          if (cancelled) return
          await loadCases(stored || root || null)
          if (!cancelled && lastCase) await openCase(lastCase)
        })()
        return () => {
          cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const openCase = useCallback(async (dir) => {
        setActiveDir(dir)
        setTab('概览')
        setTabData({})
        setVerifyResult(null)
        setTabErr(null)
        loadedTabs.current = {}
        try {
          const data = await call('case.open', { case: dir })
          setDetail(data)
          // 状态栏 + 核对进度一起读：底部要知道"卡在哪、下一步做什么"
          try {
            const st = await call('next.step', { case: dir })
            setTabData({ checkoff: st.checkoff || null, step: st })
          } catch (e) {
            try {
              const ck = await call('checkoff.status', { case: dir })
              setTabData({ checkoff: ck })
            } catch (e2) {}
          }
          // 读回上次验收结果：否则刷新一次，验收页就忘了"已经跑过"，
          // 底部还在催「下一步：跑验收」（用户 2026-11-01 实测）。
          try {
            const lastVerify = await call('verify.last', { case: dir })
            if (lastVerify && lastVerify.verdict) setVerifyResult(lastVerify)
          } catch (e) {}
          try {
            await call('ui.state.set', { lastCase: dir })
          } catch (e) {}
          // 把当前对话也绑到这个案：面板在看哪个案，对话就作用于哪个案
          try {
            const sid = isWorkbench && typeof service.currentSession === 'function' ? service.currentSession() : null
            if (sid) {
              await call('session.bind.set', { sessionId: sid, case: dir, title: data.title })
              await refreshBinding()
            }
          } catch (e) {}
        } catch (e) {
          setDetail(null)
          setErr(e.message)
        }
      }, [])

      const loadTab = useCallback(
        async (which) => {
          if (!activeDir) return
          if (loadedTabs.current[which]) return
          setTabErr(null)
          try {
            let data = null
            if (which === 'materials') data = await call('materials.list', { case: activeDir })
            else if (which === 'facts') data = await call('facts.list', { case: activeDir })
            else if (which === 'findings') data = await call('findings.list', { case: activeDir })
            else if (which === 'lawtrace') data = await call('law.trace', { case: activeDir })
            else if (which === 'processes') data = await call('processes.list', { case: activeDir })
            else if (which === 'clauses') {
              // 条款页要同时知道「已经索引了什么」和「材料里还有哪些 docx 可以索引」。
              // 以前只有前一半，于是页面只能让你手敲路径——那是把确定性工作推给用户。
              const [clauses, candidates] = await Promise.all([
                call('clauses.list', { case: activeDir }),
                call('clause.candidates', { case: activeDir }).catch(() => null),
              ])
              data = Object.assign({}, clauses, { candidates: candidates || null })
            }
            else if (which === 'notes') data = await call('notes.list', { case: activeDir })
            else return
            loadedTabs.current[which] = true
            setTabData((prev) => ({ ...prev, [which]: data }))
          } catch (e) {
            setTabErr(e.message)
          }
        },
        [activeDir]
      )

      useEffect(() => {
        if (!activeDir) return
        if (tab === '材料') loadTab('materials')
        else if (tab === '事实') loadTab('facts')
        else if (tab === '结论') loadTab('findings')
        else if (tab === '法条') loadTab('lawtrace')
        else if (tab === '工序') loadTab('processes')
        else if (tab === '条款') loadTab('clauses')
        else if (tab === '意见') {
          loadTab('notes')
          loadTab('clauses')
        }
      }, [tab, activeDir, loadTab])

      // 页签 → 台账接口的 key。写一处，别在三个 if 链里各维护一份。
      const TAB_KEY = { 材料: 'materials', 事实: 'facts', 结论: 'findings', 法条: 'lawtrace', 工序: 'processes', 条款: 'clauses', 意见: 'notes', 预检: 'precheck' }

      // 重读当前页：清掉这一页的缓存再拉一次。
      // 「重读本案」以前只重读案件概要，当前页数据会一直是旧的——用户在对话里
      // 登记完事实、回面板还是「事实台账为空」，就是这么来的。
      // which 可选：多数调用是「刷新当前页」，但建表/切条款这类动作发生在
      // 某一页上、却要知道另一页也得重读（如建完工序还要刷详情里的待确认）。
      // 以前固定用当前 tab，传参会被静默忽略——看着调了，其实刷的是别的页。
      const reloadCurrentTab = useCallback(async (whichOverride) => {
        const which = whichOverride || TAB_KEY[tab]
        if (!which) return
        loadedTabs.current[which] = false
        await loadTab(which)
        if (which === 'notes') {
          loadedTabs.current.clauses = false
          await loadTab('clauses')
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tab, loadTab])

      // 「下一步」按钮：把 core.nextStep 给的动作翻译成面板上的操作。
      // 能在面板里一键做完的就直接做；需要内容/判断的（拆工序、登记事实、
      // 对抗复盘）不假装能代办——跳到对应页并说明为什么。
      // 后面才定义的函数（runAction/runVerify/actions）用 ref 拿，避免 TDZ 与闭包过期
      const lateRef = useRef({})
      // 从验收页跳转到某条台账：写 focusId + 切页签。
      // 必须放在 PanelInner（这里才有 setTabData），DetailPane 只做转发。
      // 故意不用 useCallback：它要用 setTab / loadTab / TAB_KEY 这些随渲染变化的闭包，
      // 空依赖会捕获首次渲染的旧值（setTab 在案件没加载时还是旧的），点了就没反应。
      /**
       * 生成修订版 Word。
       * source='drafts' 用未采纳的 AI 草稿出（审核完立刻能看到整份改动）；
       * 不传则用已登记的正式意见。
       * 原合同永远只读，只写 out/ 下的新文件——这一点由 core 保证并自检。
       */
      // 产出文件预览：out/ 目录清单 + 生成结果提示
      const [outputs, setOutputs] = useState(null)
      const [revising, setRevising] = useState(false)
      const [reviseMsg, setReviseMsg] = useState(null)
      const [openBusy, setOpenBusy] = useState('')

      /** 读 out/ 目录，供验收页的预览区显示 */
      async function onLoadOutputs() {
        if (!activeDir) return null
        try {
          const r = await call('outputs.list', { case: activeDir })
          setOutputs(r || null)
          return r
        } catch (e) {
          setOutputs({ items: [], count: 0, summary: '读取产出失败：' + ((e && e.message) || e) })
          return null
        }
      }

      // 切到「验收」页时自动读一次产出清单：
      // 否则预览区永远是空的，用户还得手动点「刷新产出」。
      useEffect(() => {
        if (!activeDir) return
        let alive = true
        ;(async () => {
          try {
            const r = await call('outputs.list', { case: activeDir })
            if (alive) setOutputs(r || null)
          } catch (e) {
            if (alive) setOutputs({ items: [], count: 0, summary: '读取产出失败：' + ((e && e.message) || e) })
          }
        })()
        return () => {
          alive = false
        }
      }, [activeDir])

      /** 用系统默认应用打开产出文件（或 out 目录） */
      async function onOpenOutput(p) {
        if (!activeDir) return { ok: false }
        const name = (p && p.name) || ''
        const mode = (p && p.mode) || 'file'
        if (mode === 'file') setOpenBusy(name)
        try {
          const r = await call('outputs.open', { case: activeDir, name, mode })
          setNotice({ ok: true, text: (r && r.summary) || '已打开' })
          return { ok: true }
        } catch (e) {
          const msg = (e && e.message) || String(e)
          setNotice({ ok: false, text: '打开失败：' + msg })
          return { ok: false, message: msg }
        } finally {
          setOpenBusy('')
        }
      }

      async function onReviseDocx(p) {
        if (!activeDir) {
          setNotice({ ok: false, text: '先选一个案件' })
          return { ok: false, message: '先选案件' }
        }
        setRevising(true)
        setReviseMsg(null)
        setNotice(null)
        try {
          const payload = { case: activeDir, source: (p && p.source) || 'drafts' }
          if (p && p.file) payload.file = p.file
          const r = await call('contract.revise', payload)
          setNotice({ ok: true, text: (r && r.summary) || '已生成修订版' })
          // 关键：结果同时写到预览区，用户能立刻看到文件与大小，
          // 不用靠顶部那条一闪而过的提示（之前"点生成没用"就是这个体感）。
          setReviseMsg({ ok: true, text: (r && r.summary) || '已生成修订版' })
          await refreshTab('clauses').catch(() => {})
          await onLoadOutputs().catch(() => {})
          return { ok: true, summary: r && r.summary }
        } catch (e) {
          const msg = (e && e.message) || String(e)
          setNotice({ ok: false, text: '生成修订版失败：' + msg })
          setReviseMsg({ ok: false, text: '生成失败：' + msg })
          return { ok: false, message: msg }
        } finally {
          setRevising(false)
        }
      }

      /**
       * 忽略/取消忽略某一道验收检查。
       * 只允许忽略 warn：fail 是真的缺内容（没意见、法条抄错），不能说"我不管"。
       */
      async function onWaive(p) {
        if (!activeDir || !p || !p.name) return { ok: false }
        try {
          const r = await call('verify.waive', {
            case: activeDir,
            name: p.name,
            reason: p.reason,
            revoke: Boolean(p.revoke),
            by: checker || '',
          })
          setNotice({ ok: true, text: (r && r.summary) || '已记录' })
          // 重跑验收让状态立刻反映出来。
          // runVerify 定义在后面，直接调会撞 TDZ，走 lateRef。
          if (lateRef.current && typeof lateRef.current.runVerify === 'function') {
            await lateRef.current.runVerify().catch(() => {})
          }
          return { ok: true }
        } catch (e) {
          setNotice({ ok: false, text: '操作失败：' + ((e && e.message) || e) })
          return { ok: false, message: (e && e.message) || String(e) }
        }
      }

      function onFocusItem(ref) {
        // N 是审核意见（notes）：合同审核案的验收提示全指向 N，早先只认 F/K/M，
        // 结果「去处理 N17」点了没反应——用户反馈"找不到人工审核的地方"就是这个。
        const m = String(ref || '').match(/([FKMN])(\d+)/)
        if (!m) return
        const tabOf = { F: '事实', K: '结论', M: '材料', N: '意见' }[m[1]]
        if (!tabOf) return
        setTabData((prev) => Object.assign({}, prev, { focusId: m[1] + m[2] }))
        setTab(tabOf)
        // 切页后重新拉一次，避免显示缓存的旧数据
        const key = TAB_KEY[tabOf]
        if (key && loadedTabs.current) {
          loadedTabs.current[key] = false
          Promise.resolve().then(() => {
            try {
              loadTab(key)
            } catch (e) {}
          })
        }
      }

      const refreshStep = useCallback(async () => {
        if (!activeDir) return
        try {
          const st = await call('next.step', { case: activeDir })
          setTabData((prev) => Object.assign({}, prev, { step: st, checkoff: st.checkoff || prev.checkoff || null }))
        } catch (e) {}
      }, [activeDir])

      const runNext = useCallback(
        async (next) => {
          if (!next || !activeDir) return
          const tool = String(next.tool || '')
          const jump = (name, why) => {
            setTab(name)
            if (why) setTabErr(null)
          }
          // 一键可做的：扫材料、批量解析、跑验收、打交付包、跑预检
          if (tool === 'lc_material_parse_all') {
            return lateRef.current.runAction &&
              lateRef.current.runAction('批量解析', 'material.parse_all', { case: activeDir }, async () => {
                await refreshTab('materials')
                await refreshStep()
              })
          }
          if (tool === 'lc_case_verify') {
            setTab('验收')
            return lateRef.current.runVerify && lateRef.current.runVerify()
          }
          if (tool === 'lc_deliver') {
            return lateRef.current.runAction &&
              lateRef.current.runAction('打交付包', 'deliver', { case: activeDir }, async () => {
                await refreshStep()
              })
          }
          if (tool === 'lc_precheck') {
            // 预检页签已并入验收：跳验收页，并在那里跑占位符自查
            setTab('验收')
            return lateRef.current.onPrecheck && lateRef.current.onPrecheck({})
          }
          // 批量核对：优先处理仍有待核条目的台账；事实已完成时不能再回到事实页空转
          if (tool === 'lc_checkoff') {
            const ck = tabData.checkoff || {}
            const kinds = ck.kinds || {}
            // 只有事实与结论参与核对；材料不进这一步（材料页已无核对入口）
            const pendingKind = kinds.fact && kinds.fact.pending ? { kind: 'fact', tab: '事实', label: '事实' }
              : kinds.finding && kinds.finding.pending ? { kind: 'finding', tab: '结论', label: '结论' }
              : null
            setTabData((prev) => Object.assign({}, prev, { batchDraft: null }))
            if (!pendingKind) {
              setTabErr('事实与结论都已核对。可以继续跑五道验收。')
              setTab('验收')
              return
            }
            setTab(pendingKind.tab)
            if (pendingKind.kind === 'fact') {
              const ids = suggestBatchIds(next)
              setTabData((prev) => Object.assign({}, prev, { batchDraft: ids.length ? { kind: 'fact', ids } : null }))
              if (!ids.length) setTabErr('事实台账已核对完成；请继续处理材料或结论台账。')
            } else {
              setTabErr(`事实台账已核对完成；请在「${pendingKind.label}」页逐条点击「✓ 已核」，还有 ${kinds[pendingKind.kind].pending} 条。`)
            }
            return
          }
          // 跳到对应页继续（面板上已有入口）
          const jumpMap = {
            lc_material_scan: '材料',
            lc_material_decide: '材料',
            lc_proc_plan: '工序',
            lc_proc_update: '工序',
            lc_fact_list: '事实',
            lc_fact_add: '事实',
            lc_finding_add: '结论',
            lc_finding_list: '结论',
            lc_clause_index: '条款',
            lc_note_add: '意见',
            lc_review_open: '结论',
            lc_review_verdict: '结论',
          }
          let target = jumpMap[tool]
          // 合同审核案没有「工序」页：下一步若指向工序，跳到「条款」而不是一个不存在的页签
          // （否则按钮点了没反应，用户以为坏了）。
          if (target === '工序' && detail && detail.caseType === 'contract') target = '条款'
          if (target) {
            jump(target)
            // 这类动作需要内容或判断，面板不代劳，把原因说清楚
            if (next.why) setTabErr('这一步要你自己判断：' + next.why + '（' + (next.action || '') + '）')
            return
          }
          // 兜底：跳不了就直接重读状态
          await refreshStep()
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [activeDir, refreshStep]
      )

      const [notice, setNotice] = useState(null)
      // 工作台：AI 抽屉 + 会话绑定
      const [aiOpen, setAiOpen] = useState(false)
      const [aiBusy, setAiBusy] = useState(false)
      const [sessionId, setSessionId] = useState(() => (isWorkbench && typeof service.currentSession === 'function' ? service.currentSession() : null))
      const [running, setRunning] = useState(false)

      // 写操作统一入口：执行 → 提示结果 → 刷新界面。异常不抛出，只显示。
      const runAction = useCallback(
        async (label, op, payload, after) => {
          setRunning(true)
          setNotice(null)
          try {
            const data = await call(op, payload)
            const detail = data && (data.summary || data.text || data.file || (data.dir ? String(data.dir) : null))
            setNotice({ ok: true, text: label + "完成" + (detail ? "：" + String(detail).slice(0, 160) : "") })
            if (after) await after(data)
          } catch (e) {
            setNotice({ ok: false, text: label + "失败：" + e.message, retry: () => runAction(label, op, payload, after) })
          } finally {
            setRunning(false)
          }
        },
        []
      )

      // 让某一页重新拉一次（缓存会被清掉）
      const refreshTab = useCallback(
        async (which) => {
          if (!activeDir) return
          loadedTabs.current[which] = false
          await loadTab(which)
        },
        [activeDir, loadTab]
      )

      // 只刷新案件概要（计数、下一步），不跳页
      const refreshDetail = useCallback(async () => {
        if (!activeDir) return
        try {
          const data = await call('case.open', { case: activeDir })
          setDetail(data)
        } catch (e) {}
      }, [activeDir])

      const actions = {
        onFactAdd: (p) => runAction('登记事实', 'fact.add', Object.assign({ case: activeDir }, p), async () => { await refreshTab('facts'); await refreshDetail() }),
        onFactAmend: (p) => runAction('修正事实', 'fact.amend', Object.assign({ case: activeDir }, p), async () => { await refreshTab('facts'); await refreshDetail() }),
        onFactRevoke: (p) => runAction('作废事实', 'fact.revoke', Object.assign({ case: activeDir }, p), async () => { await refreshTab('facts'); await refreshDetail() }),
        onProcUpdate: (p) => runAction('推进工序', 'proc.update', Object.assign({ case: activeDir }, p), async () => { await refreshTab('processes'); await refreshDetail() }),
        // 工作台内拆工序：建完表要同时刷工序页与详情（详情里的「待确认：工序拆解」靠它才消失）
        onProcPlan: (p) => runAction('拆工序', 'proc.plan', Object.assign({ case: activeDir }, p), async () => { await refreshTab('processes'); await refreshDetail() }),
        onClauseIndex: (p) => runAction('索引条款', 'clause.index', Object.assign({ case: activeDir }, p), async () => { await refreshTab('clauses'); await refreshDetail() }),
        // 「不索引」必须写理由：不写理由的跳过，过两个月没人知道为什么。
        // ⚠ 不能用 window.prompt —— Electron 里它直接返回 null，
        //   表现为「点了完全没反应」（这个坑本项目踩过两次，见 1602 行注释）。
        //   所以理由用页内输入：ClausesView 里带一个 skipAsk 状态展开输入行。
        onClauseSkip: (p) => {
          if (p.unskip) {
            runAction('撤销不索引', 'clause.skip', { case: activeDir, file: p.file, unskip: true }, async () => { await refreshTab('clauses') })
          }
        },
        onClauseSkipConfirm: (p) =>
          runAction('标记不索引', 'clause.skip', { case: activeDir, file: p.file, reason: p.reason }, async () => {
            await refreshTab('clauses')
            await refreshDetail()
          }),
        onNoteAdd: (p) => runAction('登记意见', 'note.add', Object.assign({ case: activeDir }, p), async () => { await refreshTab('notes'); await refreshDetail() }),
        /**
         * 「实际修改意见」保存：写成该条款的正式意见（notes.jsonl）。
         *
         * 与 onNoteAdd 的区别：这里不填"问题"表单，问题描述直接用已合并的审核意见，
         * 人只需要写最终条文。走 note.adopt 同一个 op（意见 + 「已审·需修改」判定一起落），
         * 这样状态机才会把这条算作「已处理」，而不是"草稿还在、意见没登"。
         */
        onSaveFinal: async (p) => {
          if (!activeDir) return { ok: false, message: '先选案件' }
          if (!p || !p.clause) return { ok: false, message: '缺条款号' }
          try {
            const r = await call('note.adopt', {
              case: activeDir,
              file: p.file || undefined,
              clause: p.clause,
              level: p.level || '建议修改',
              issue: p.issue,
              fix: p.fix,
              // 落地形式随保存一起写进台账：批注（正文不动）还是改正文
              apply: p.apply,
            })
            await refreshTab('clauses').catch(() => {})
            await refreshTab('notes').catch(() => {})
            return { ok: true, summary: (r && r.summary) || '已保存' }
          } catch (e) {
            return { ok: false, message: (e && e.message) || String(e) }
          }
        },
        // 切换某条意见的落地形式（批注 / 改正文）
        onNoteApply: (p) =>
          runAction(
            p.apply === 'redline' ? '改为修订正文' : '改为只加批注',
            'note.setApply',
            { case: activeDir, id: p.id, apply: p.apply },
            async () => { await refreshTab('notes') }
          ),
        onNoteDelete: (p) => runAction('作废意见', 'note.delete', Object.assign({ case: activeDir }, p), async () => { await refreshTab('notes') }),
        onReport: (p) => runAction('生成意见表', 'contract.report', Object.assign({ case: activeDir }, p), async () => { await refreshTab('notes') }),
        onRevise: (p) => runAction('生成修订版', 'contract.revise', Object.assign({ case: activeDir }, p), async () => {}),
        // 片段级修订：先只校验+预览（不落盘），确认后再真正生成 docx
        onPatchPreview: async (p) => {
          if (!activeDir) return { ok: false, message: '先选案件' }
          try {
            const r = await call('patch.preview', { case: activeDir, patches: (p && p.patches) || [] })
            return r || { ok: false, message: '预览失败' }
          } catch (e) {
            return { ok: false, message: (e && e.message) || String(e) }
          }
        },
        onPatchApply: async (p) => {
          if (!activeDir) return { ok: false, message: '先选案件' }
          try {
            const r = await call('patch.apply', { case: activeDir, patches: (p && p.patches) || [] })
            await refreshTab('clauses').catch(() => {})
            return r || { ok: false, message: '应用失败' }
          } catch (e) {
            return { ok: false, message: (e && e.message) || String(e) }
          }
        },
        // 预检、口径、对照预览：结果进 tabData，不刷新整个案件（预览要留在屏幕上）
        onPrecheck: (p) =>
          runAction('运行预检', 'precheck.run', Object.assign({ case: activeDir }, p), async (data) => {
            setTabData((prev) => Object.assign({}, prev, { precheck: data }))
          }),
        onPreview: (p) =>
          runAction('修订预览', 'contract.preview', Object.assign({ case: activeDir }, p), async (data) => {
            setTabData((prev) => Object.assign({}, prev, { preview: data }))
          }),
        // 法条溯源：结果留在页面上，不重载整个案件
        onLawTrace: (p) =>
          runAction('法条溯源', 'law.trace', Object.assign({ case: activeDir }, p), async (data) => {
            setTabData((prev) => Object.assign({}, prev, { lawtrace: data }))
          }),
        onConfigSet: (p) =>
          runAction('审核口径', 'contract.config.set', Object.assign({ case: activeDir }, p), async () => {
            await refreshDetail()
          }),
        // 取消正在进行的审核（真的中止后端请求）
        onAiCancel: async () => {
          if (!activeDir) return
          try {
            return await call('note.aiCancel', { case: activeDir })
          } catch (e) {
            return { ok: false, message: (e && e.message) || String(e) }
          }
        },
        // 重新审核前清空整批草稿（后端 note-drafts.json）
        onDraftsClearAll: async () => {
          if (!activeDir) return
          try {
            await call('note.draftsClear', { case: activeDir })
          } catch (e) {}
        },
        // 采纳/丢弃一条草稿后把它从暂存里去掉，刷新别又冒出来
        onDraftDiscard: async (p) => {
          if (!activeDir) return
          try {
            await call('note.draftsClear', { case: activeDir, clause: p && p.clause })
          } catch (e) {}
        },
        /**
         * 丢弃草稿 → 「已审·无需修改」。
         *
         * 现在走 note.discard 一个 op：判定与清草稿在服务端一次完成。
         * 以前是界面上分两次调（先 clause.rule 再 note.draftsClear），
         * 中间失败就会出现「判定写了、草稿还在」，下次审核又把它捡回来。
         */
        onDraftDiscardAsNoRevision: async (p) => {
          if (!activeDir) return { ok: false, message: '先选案件' }
          if (!p || !p.clause) return { ok: false, message: '缺条款号' }
          try {
            const r = await call('note.discard', {
              case: activeDir,
              file: p.file || undefined,
              clause: p.clause,
              reason: p.reason,
            })
            await refreshTab('clauses').catch(() => {})
            return { ok: true, summary: (r && r.summary) || '', ruling: r && r.ruling }
          } catch (e) {
            return { ok: false, message: (e && e.message) || String(e) }
          }
        },
        /**
         * 采纳草稿 → 登记正式意见 + 「已审·需修改」判定 + 清草稿，一次完成。
         * 表单里人可能改过措辞，所以这里传的是**表单当前值**，不是原始草稿。
         */
        onDraftAdopt: async (p) => {
          if (!activeDir) return { ok: false, message: '先选案件' }
          try {
            const r = await call('note.adopt', {
              case: activeDir,
              file: (p && p.file) || undefined,
              clause: p && p.clause,
              level: p && p.level,
              issue: p && p.issue,
              fix: p && p.fix,
              basis: p && p.basis,
              quote: p && p.quote,
            })
            await refreshTab('clauses').catch(() => {})
            await refreshTab('notes').catch(() => {})
            return { ok: true, summary: (r && r.summary) || '', warning: (r && r.warning) || null }
          } catch (e) {
            return { ok: false, message: (e && e.message) || String(e) }
          }
        },
        /**
         * 丢弃＝「已审·无需修改」：先记判定，再把草稿从暂存里去掉。
         * 判定会进 .lawcase/rulings.jsonl，报告和复核都看得到「这条审过、结论是不用改」。
         */
        onRuleNoRevision: async (p) => {
          if (!activeDir || !p || !p.clause) return
          const dr = p.draft || {}
          // 只接受模型**明确给出**的"为什么不用改"（why/reason）；
          // 绝不回退到 issue —— 那是问题描述，用它当理由会写出自相矛盾的判定。
          const reason = String(dr.why || dr.reason || '').slice(0, 200)
          if (reason.trim().length < 4) {
            setTabErr && setTabErr('要写一句「为什么这条不用改」的理由（≥4 字），不能拿问题描述顶替')
            return
          }
          try {
            await call('clause.rule', {
              case: activeDir,
              file: p.file || undefined,
              clause: p.clause,
              kind: 'norevision',
              reason: reason || '按当前口径无需修改',
            })
            await call('note.draftsClear', { case: activeDir, clause: p.clause })
            await refreshTab('clauses')
          } catch (e) {
            setTabErr && setTabErr('记录判定失败：' + ((e && e.message) || e))
          }
        },
        /**
         * 只生成提示词：不读草稿、不写任何文件，按当前口径拼一段给 AI 的指令。
         * 跟「载入草稿」分开的理由：很多人只是想要那段指令，不需要案件里已有草稿。
         */
        onDraftPrompt: async (p) => {
          if (!activeDir) return { text: '先选案件' }
          let cfg = null
          try {
            if (p) await call('contract.config.set', Object.assign({ case: activeDir }, p))
            cfg = await call('contract.config.get', { case: activeDir })
          } catch (e) {
            cfg = null
          }
          let ws = null
          try {
            ws = await call('note.worksheet', { case: activeDir })
          } catch (e) {
            ws = null
          }
          if (!ws) {
            return { text: '这个案件还没索引合同：先去「条款」页把合同切成条款。', prompt: '' }
          }
          const pending = (ws.items || []).filter((x) => !x.noteCount)
          return {
            text: `已按当前口径生成指令：${ws.file} 共 ${ws.total} 条，${pending.length} 条待审。复制后发给 AI。`,
            prompt: buildReviewPrompt({ dir: activeDir, worksheet: ws, config: cfg }),
            worksheet: ws,
            config: cfg,
          }
        },
        /**
         * AI 直接审核：插件自己调**宿主已配置的模型**，不打开对话框。
         *
         * 失败绝不显示成「没有风险」：错误码原样带回，界面按 aiErr 展示可行动的原因。
         * 口径（立场/类型/补充要求）随请求一起发，并且服务端会重新读一遍条款索引，
         * 所以这里传的只是「本次选择的立场」，不是「合同内容」。
         */
        onAiReview: async (p) => {
          if (!activeDir) return { ok: false, code: 'case/empty', message: '先选案件' }
          // 注意：这里只发请求、返回结果。
          // 界面的 busy/阶段/错误展示由 NotesView 自己的 runAiReview 管——
          // 本函数属于外层 Panel 作用域，碰不到 NotesView 的 state。
          try {
            const payload = {
              case: activeDir,
              file: (p && p.file) || undefined,
              stance: p && p.stance,
              templateId: p && p.templateId,
              instructions: p && p.instructions,
              // 带上会话 id：服务端据此拒绝「跨案件」的审核请求
              sessionId: sessionId || undefined,
            }
            if (p && p.modelSelection) payload.modelSelection = p.modelSelection

            const r = await call('note.aiReview', payload)
            if (!r || r.ok === false) {
              return {
                ok: false,
                code: (r && r.code) || 'ai/failed',
                message: (r && r.message) || 'AI 审核失败，未产生任何结论',
              }
            }
            // 草稿已由服务端写入 note-drafts.json；刷新条款页拿到最新判定/进度
            await refreshTab('clauses').catch(() => {})
            return {
              ok: true,
              message: r.summary,
              drafts: Array.isArray(r.drafts) ? r.drafts : [],
              model: r.model,
              config: r.config,
              counts: r.counts,
              reviewId: r.reviewId,
              truncated: r.truncated,
              warnings: r.warnings || [],
              at: r.at,
            }
          } catch (e) {
            return { ok: false, code: (e && e.code) || 'ai/failed', message: (e && e.message) || String(e) }
          }
        },
        /**
         * 载入 AI 草稿（不生成、不弹窗）。
         *
         * 另一条路：草稿由对话里的助手生成（调 lc_note_validate(save=true) 写进
         * .lawcase/note-drafts.json），这里只负责读回来摆给人勾选。
         * 保留它是为了「不配模型也能用」——人工 / 对话路径不能被 AI 路径挤掉。
         */
        onDraftAll: async (p) => {
          if (!activeDir) return { text: '先选案件' }
          try {
            if (p) await call('contract.config.set', Object.assign({ case: activeDir }, p))
            const d = await call('note.drafts', { case: activeDir })
            if (d && d.count) {
              return { text: `已载入 AI 草稿 ${d.count} 条，勾选采纳后才会写进台账。`, drafts: d.drafts }
            }
            // 没草稿：只给一句最短的指引。
            // 长指令已经拆到「生成提示词」按钮——两个动作合并会让人
            // 在「载入」里找指令、在「生成」里找草稿，两头都别扭。
            let ws = null
            try {
              ws = await call('note.worksheet', { case: activeDir })
            } catch (e) {
              return {
                text: '这个案件还没索引合同：先去「条款」页把合同切成条款，再来载入草稿。',
                noContract: true,
              }
            }
            const pending = (ws.items || []).filter((x) => !x.noteCount)
            return {
              text:
                `还没有草稿：${ws.file} 共 ${ws.total} 条，${pending.length} 条待审。` +
                '点「生成提示词」拿指令，发给 AI 跑完再来载入。',
              worksheet: ws,
            }
          } catch (e) {
            return { text: '载入草稿失败：' + ((e && e.message) || e) }
          }
        },
        // 逐条核对：只更新核对进度，不重载台账（否则刚点的那条会跳动）
        checkMap: (function () {
          const m = new Map()
          const ck = tabData.checkoff
          // 只放「已有结论」的：未核对的条目 result 是 null，
          // 塞进 map 会让界面上每一条都显示成「有疑问」（踩过）
          if (ck && Array.isArray(ck.items)) {
            for (const it of ck.items) if (it && it.result) m.set(it.kind + ':' + it.id, it)
          }
          return m
        })(),
        // 逐条核对：同步返回是否成功，调用方据此决定要不要清空输入框
        onCheck: async (p) => {
          const by = p.by || askChecker()
          if (!by) {
            // 没填核对人就别发请求：这条记录没有责任人，签字页也就没有意义
            setTabErr('没有核对人：点了「' + (p.result === 'ok' ? '已核' : p.result === 'fix' ? '改' : '疑') + '」但没填姓名，未记录')
            return false
          }
          try {
            const data = await call('checkoff.set', Object.assign({ case: activeDir }, p, { by }))
            const ck = await call('checkoff.status', { case: activeDir })
            setTabErr(null)
            setTabData((prev) => Object.assign({}, prev, { checkoff: ck, checkNotice: (data && data.summary) || '' }))
            return true
          } catch (e) {
            // 拒收原因显示在页内：顶部操作条太远，用户会以为「点了没反应」
            setTabErr('核对没记上：' + e.message)
            return false
          }
        },
        onSign: (signer) =>
          runAction('生成签字单', 'checkoff.sign', { case: activeDir, signer }, async () => {})
      }

      // 批量核对执行：走 checkoff.batch（逐条留痕），完成后清掉确认条并刷新
      const onBatchCheck = useCallback(
        async (draft) => {
          if (!draft || !draft.ids || !draft.ids.length) return
          const by = checkerRef.current
          if (!by) {
            setTabErr('批量核对需要先填核对人姓名')
            return
          }
          setBusy(true)
          setTabErr(null)
          try {
            const r = await call('checkoff.batch', { case: activeDir, kind: draft.kind || 'fact', ids: draft.ids, result: 'ok', by })
            const ck = await call('checkoff.status', { case: activeDir })
            const st = await call('next.step', { case: activeDir })
            setTabData((prev) => Object.assign({}, prev, { checkoff: ck, step: st, batchDraft: null }))
            loadedTabs.current.facts = false
            await loadTab('facts')
            if (r.failed && r.failed.length) {
              setTabErr('有 ' + r.failed.length + ' 条没标上：' + r.failed.map((f) => f.id + '（' + f.error + '）').join('；'))
            }
          } catch (e) {
            setTabErr('批量核对失败：' + e.message)
          } finally {
            setBusy(false)
          }
        },
        [activeDir, loadTab]
      )

      // 用当前案件目录当工作区开会话（宿主负责建工作区、登记归属）
      const startAiSession = useCallback(async () => {
        if (!isWorkbench || !activeDir) return
        setAiBusy(true)
        setNotice(null)
        try {
          const id = await service.ensureSession({ folder: activeDir })
          setSessionId(id)
          if (typeof service.openSession === 'function' && id) service.openSession(id)
          setNotice({ ok: true, text: '会话已就绪，归属本工作台' })
        } catch (e) {
          setNotice({ ok: false, text: '开会话失败：' + ((e && e.message) || e) })
        } finally {
          setAiBusy(false)
        }
      }, [isWorkbench, activeDir, service])

      // 切换案件时，把会话跟着切到新目录（已有该工作台会话则复用，否则留给用户点）
      useEffect(() => {
        if (!isWorkbench || typeof service.currentSession !== 'function') return
        setSessionId(service.currentSession())
      }, [activeDir, isWorkbench, service])

      const runVerify = useCallback(async () => {
        if (!activeDir) return
        setBusy(true)
        setTabErr(null)
        try {
          const data = await call('verify', { case: activeDir })
          setVerifyResult(data)
        } catch (e) {
          setTabErr(e.message)
        } finally {
          setBusy(false)
        }
      }, [activeDir])

      // 把「后定义」的函数交给 runNext（它比这几个先声明，只能走 ref）
      lateRef.current = { runAction, runVerify, onPrecheck: actions.onPrecheck }

      return h(
        'div',
        { className: 'lawcase-page', style: S.page },
        h(UiStyles, null),
        running
          ? h('div', { role: 'status', 'aria-live': 'polite', style: { height: 3, background: T.brand, opacity: 0.85, flex: '0 0 auto' } }, h('span', { style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' } }, '任务进行中，请稍候'))
          : null,
        h(
          'div',
          { className: 'lawcase-toolbar', style: S.toolbar, 'data-dsh-workbench-toolbar': '' },
          h('div', { style: { fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' } }, APP_TITLE),
          h('div', { className: 'lawcase-toolbar-root', style: { fontSize: 12, color: T.text2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, root || '未设置案件根目录'),
          h(Button, { small: true, onClick: () => loadCases(root || null), disabled: busy, 'data-dsh-no-drag': '' }, busy ? '读中…' : '刷新')
        ),
        h(ActionBar, {
          activeDir,
          root,
          running,
          notice,
          onNewCase: (f) =>
            runAction(
              "新建案件",
              "pipeline.run",
              { case: f.dir, title: f.title, source: f.source || undefined, caseType: f.caseType || 'litigation' },
              async (data) => {
                // 用服务端解析后的真实目录，而不是界面上输入的那个字符串
                const created = (data && data.case) || f.dir
                const parent = String(created).replace(/\/[^/]+\/?$/, '') || created
                // 新案不在当前根目录下时（比如填了别处的绝对路径），把根目录切过去，
                // 否则用户会看到"建了但列表里没有"。
                const sameRoot = root && String(root).replace(/\/$/, '') === parent
                await loadCases(sameRoot ? root : parent)
                await openCase(created)
              }
            ),
          onScan: (source) =>
            runAction("扫材料", "material.scan", { case: activeDir, source }, async () => {
            await openCase(activeDir)
            }),
          onDeliver: () =>
            runAction("打交付包", "deliver", { case: activeDir }, async () => {
              await openCase(activeDir)
            }),
          // 重读本案 = 案件概要 + 当前这一页的台账一起重读
          // 在 Finder 里定位最新交付包（服务端做 -R，前端只管提示）
          onRevealDeliver: async (p) => {
            if (!activeDir) return { ok: false }
            try {
              const r = await call('deliver.open', Object.assign({ case: activeDir }, p || {}))
              setNotice({ ok: true, text: (r && r.summary) || '已在 Finder 中显示' })
              return { ok: true }
            } catch (e) {
              setNotice({ ok: false, text: '打开失败：' + ((e && e.message) || String(e)) })
              return { ok: false }
            }
          },
          onReloadCase: async () => {
            await openCase(activeDir)
            await reloadCurrentTab()
          },
        }),
        h(
          'div',
          { className: 'lawcase-body', style: S.body },
          h(CaseSide, { root, setRoot: (v) => loadCases(v), cases, activeDir, onPick: openCase, onReload: () => loadCases(root || null), busy, err }),
          h(DetailPane, {
            detail,
            tab,
            setTab,
            tabData,
            loadTab,
            verifyResult,
            runVerify,
            busy,
            tabErr,
            actions,
            notice,
            running,
            onReloadTab: reloadCurrentTab,
            checkoff: tabData.checkoff || null,
            // 顶栏「上次动作/卡点」：来自 next.step 附带的 brief（与 lc_case_brief 同源）
            brief: (tabData.step && tabData.step.brief) || null,
            step: tabData.step || null,
            onNext: (next) => runNext(next),
            onFocusItem,
            onReviseDocx,
            onWaive,
            outputs,
            revising,
            reviseMsg,
            onLoadOutputs,
            onOpenOutput,
            openBusy,
            onBatchCheck,
            onSign: actions.onSign,
            checker,
            onCheckerChange: rememberChecker,
            sessionBinding,
            canBind: isWorkbench,
            canOpenAi: true,
            aiOpen,
            onToggleAi: () => setAiOpen((v) => !v),
          }),
          h(AiDrawer, {
            conversation: conversationNode,
            service,
            folder: activeDir,
            open: aiOpen,
            onClose: () => setAiOpen(false),
            onStart: startAiSession,
            busy: aiBusy,
          })
          // 标准分栏模式下宿主任左侧常驻原生会话，这里不再造任何会话 UI
          // （规范明确禁止复制聊天界面；AiDrawer 组件保留给 customFrame 场景与测试）
        )
      )
    }

    // ---------- 侧栏图标（插件面板模式用） ----------
    function LawcaseIcon(props) {
      const size = (props && props.size) || 18
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-label': '律案', role: 'img' },
        h('path', { d: 'M12 3v16', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', { d: 'M5 8h14', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', { d: 'M7.5 8 4.5 15h6L7.5 8Z', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round' }),
        h('path', { d: 'M16.5 8 13.5 15h6l-3-7Z', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round' }),
        h('path', { d: 'M8.5 20h7', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' })
      )
    }

    // ---------- 错误边界：组件炸了也要给出原因，不能白屏 ----------
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { err: null }
      }

      static getDerivedStateFromError(err) {
        return { err }
      }

      render() {
        if (this.state.err) {
          const msg = String((this.state.err && this.state.err.message) || this.state.err)
          return h(
            'div',
            { style: { padding: 18, color: T.err, fontSize: 13, lineHeight: 1.8, wordBreak: 'break-word' } },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '工作台渲染出错'),
            h('div', null, msg),
            h('div', { style: { color: T.text2, marginTop: 8, fontSize: 12 } }, '把这段报错发给助手，或看 Host 侧的 plugin.log.jsonl。')
          )
        }
        return this.props.children
      }
    }

    function Panel(hostProps) {
      // 宿主（工作台）通过 props 传 service / entry / active / conversation，
      // 这里必须原样转发，否则工作台模式下拿不到会话挂载点。
      return h(Boundary, null, h(PanelInner, hostProps || {}))
    }

    // ---------- 自报（诊断用）：挂载结果写回 Host 日志 ----------
    function report(payload) {
      try {
        fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ op: 'client.mount', payload: payload || {} }),
        }).catch(() => {})
      } catch (e) {}
    }

    // ---------- 挂载 ----------
    // 形态必须和官方模板一致：模块注入 'slots'，apply 里只碰 ctx.slots。
    // 不在 dsh.client.inject 里写 dsh-desktop-workbenches —— 普通 Harness 没这个包，
    // 写了会让 web boot 卡在 "lawcase: loading"。工作台改用运行时探测。
    function registerPanel(scope) {
      if (!scope || !scope.slots || typeof scope.slots.register !== 'function') return () => {}
      const off1 = scope.slots.inject('sidebar.panellist', () =>
        scope.slots.register({ name: 'sidebar.panellist', id: 'lawcase', order: 40, label: APP_TITLE }, LawcaseIcon)
      )
      const off2 = scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: 'lawcase' }, Panel))
      return () => {
        try { off1() } catch (e) {}
        try { off2() } catch (e) {}
      }
    }

    function registerWorkbench(scope) {
      const wb = typeof scope.get === 'function' ? scope.get('desktopWorkbenches') : undefined
      if (!wb || typeof wb.register !== 'function') return null
      // 整页模式（customFrame）：宿主不再替我们常驻左侧会话，
      // 对话入口与空状态都由本工作台自己给——这样「打开 AI 对话」才点得开真抽屉。
      // 注意：customFrame 下宿主不会显示通用无会话引导，必须自己提供（见 AiDrawer）。
      return wb.register(
        {
          title: APP_TITLE,
          description: APP_DESC,
          repository: REPOSITORY,
          customFrame: true,
          headerLayout: 'compact',
        },
        Panel
      )
    }

    function apply(ctx) {
      try {
        applyInner(ctx)
      } catch (e) {
        // 兜底：apply 抛异常会让整个 web boot 失败，宁可少一个面板也不能拖垮宿主
        report({ phase: "error", message: String((e && e.message) || e) })
        try { console.error("lawcase: mount failed", e) } catch (x) {}
      }
    }

    function applyInner(ctx) {
      const hasWorkbench = !!(ctx && typeof ctx.get === 'function' && ctx.get('desktopWorkbenches'))
      report({ phase: 'apply', hasSlots: !!(ctx && ctx.slots), hasWorkbench })

      // 1) 先按普通 Web UI 挂：侧栏图标 + 主面板（id 与 main 的 key 同名即可联动）
      const unmountPanel = registerPanel(ctx)

      // 2) Desktop 工作台：服务在就换成工作台，撤掉面板避免两处入口
      const mountWorkbench = (scope) => {
        const reg = registerWorkbench(scope)
        if (!reg) return false
        try { unmountPanel() } catch (e) {}
        if (typeof scope.effect === 'function') scope.effect(() => reg, 'lawcase: workbench')
        report({ phase: 'mount', mode: 'workbench' })
        return true
      }
      if (mountWorkbench(ctx)) return

      // 3) 工作台服务晚到（客户端加载顺序不确定）：可选注入，拿到再换
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['desktopWorkbenches'], (c) => { mountWorkbench(c) })
        } catch (e) {}
      }
      report({ phase: 'mount', mode: 'panel' })
    }

    // 供测试用：把各视图暴露出来，能脱离浏览器渲染一遍（挡住"点开就白屏"）
    const __views = {
      Overview,
      confirmHowTo,
      MaterialsView,
      FactsView,
      FindingsView,
      ClausesView,
      NotesView,
      FullTextReview,
      CaseStatusBar,
      LawTraceView,
      BatchCheckBar,
      draftOfClause,
      applyDraftToForm,
      suggestBatchIds,
      stagePlan,
      shortAction,
      ProcView,
      VerifyView,
      ActionBar,
      DirPicker,
      DetailPane,
      Notice,
      AiDrawer,
      Panel,
      RISK_TEMPLATES,
      CASE_TYPES,
      REVIEW_STANCES,
      REVIEW_TEMPLATES,
      dirNameOf,
      joinDir,
      call,
    }

    return { apply, inject: ['slots'], __views }
  },
})
