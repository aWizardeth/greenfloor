// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (k === 'disabled' || k === 'checked' || k === 'selected' || k === 'open') {
      // Boolean DOM properties: set as property, not attribute.
      // setAttribute('disabled', false) still adds the attribute and disables the element.
      e[k] = Boolean(v)
    }
    else e.setAttribute(k, v)
  }
  for (const c of children) {
    if (typeof c === 'string') e.appendChild(document.createTextNode(c))
    else if (c) e.appendChild(c)
  }
  return e
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function jsonHtml(obj, indent = 0) {
  const pad = '  '.repeat(indent)
  const pad1 = '  '.repeat(indent + 1)
  if (obj === null) return `<span class="null">null</span>`
  if (typeof obj === 'boolean')
    return `<span style="color:${obj ? 'var(--green)' : 'var(--red)'}">${obj}</span>`
  if (typeof obj === 'number') return `<span class="num">${obj}</span>`
  if (typeof obj === 'string') return `<span class="str">"${escHtml(obj)}"</span>`
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    const items = obj.map((v) => `${pad1}${jsonHtml(v, indent + 1)}`).join(',\n')
    return `[\n${items}\n${pad}]`
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj)
    if (keys.length === 0) return '{}'
    const items = keys
      .map((k) => `${pad1}<span class="key">"${escHtml(k)}"</span>: ${jsonHtml(obj[k], indent + 1)}`)
      .join(',\n')
    return `{\n${items}\n${pad}}`
  }
  return String(obj)
}

function badge(text, type = 'muted') {
  const b = el('span', { class: `badge badge-${type}` })
  b.innerHTML = `<span class="dot"></span>${escHtml(text)}`
  return b
}

function statusBadge(ok) {
  return badge(ok ? 'OK' : 'FAIL', ok ? 'green' : 'red')
}

async function api(path, opts = {}) {
  const r = await fetch(path, opts)
  return r.json()
}

function renderJson(obj) {
  const pre = el('pre', { class: 'json-view' })
  pre.innerHTML = jsonHtml(obj)
  return pre
}

// ---------------------------------------------------------------------------
// Terminal (SSE stream)
// ---------------------------------------------------------------------------
function createTerminal() {
  const term = el('div', { class: 'terminal' })
  term.innerHTML = '<span class="text-muted">Ready.</span>'
  let lineCount = 0

  function append(html) {
    const line = document.createElement('div')
    line.innerHTML = html
    if (lineCount === 0) term.innerHTML = ''
    term.appendChild(line)
    lineCount++
    term.scrollTop = term.scrollHeight
  }

  function handleEvent(evtType, data) {
    if (evtType === 'cmd') {
      append(`<span class="ln-cmd">$ ${escHtml(data.cmd)}</span>`)
    } else if (evtType === 'json_line') {
      const evtName = data.event || data.type || ''
      const ok = data.ok !== false
      let cls = 'ln-json'
      if (!ok || evtName.includes('error') || evtName.includes('fail')) cls = 'ln-err'
      else if (evtName.includes('warn')) cls = 'ln-warn'
      else if (evtName.includes('ok') || evtName.includes('success') || evtName.includes('confirm'))
        cls = 'ln-ok'
      append(`<span class="${cls}">${escHtml(JSON.stringify(data))}</span>`)
    } else if (evtType === 'text_line') {
      append(`<span class="ln-json">${escHtml(data)}</span>`)
    } else if (evtType === 'stderr_text' || evtType === 'stderr_line') {
      append(
        `<span class="ln-warn">${escHtml(typeof data === 'string' ? data : JSON.stringify(data))}</span>`
      )
    } else if (evtType === 'done') {
      const cls = data.ok ? 'ln-ok ln-done' : 'ln-err ln-done'
      append(`<span class="${cls}">── exit ${data.exit_code} ${data.ok ? '✓' : '✗'} ──</span>`)
    } else if (evtType === 'error') {
      append(`<span class="ln-err">ERROR: ${escHtml(data.message)}</span>`)
    }
  }

  return { term, handleEvent }
}

async function streamPost(url, body, onEvent) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop()
    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith('data:')) continue
      try {
        const obj = JSON.parse(line.slice(5).trim())
        onEvent(obj.type, obj.data)
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
const pages = {}
// Market passed to the Build page via ▸ Build Offer buttons on market cards.
let _pendingBuildMarket = null
// Single timer ID for the market-loop status poll — cleared on every re-render
// so old timers from previous dashboard renders never accumulate.
let _loopPollTimerId = null

// Patch all loop-card DOM elements in-place from a fresh /api/market-loop/status
// response. Never triggers a full dashboard re-render.
async function _patchLoopCard() {
  const card = document.querySelector('[data-loop-card]')
  if (!card) return
  const fresh = await api('/api/market-loop/status').catch(() => null)
  if (!fresh) return

  // Border color
  card.style.borderColor = fresh.running
    ? 'rgba(56,189,132,.4)'
    : fresh.can_start
      ? 'rgba(99,102,241,.3)'
      : 'rgba(120,120,120,.2)'

  // Header badges (keep title span, replace everything after it)
  const hdr = card.querySelector('[data-loop-hdr]')
  if (hdr) {
    while (hdr.children.length > 1) hdr.removeChild(hdr.lastChild)
    hdr.appendChild(badge(fresh.running ? '● running' : '○ stopped', fresh.running ? 'green' : 'muted'))
    if (!fresh.sage_connected) hdr.appendChild(badge('Sage offline', 'yellow'))
    if (fresh.enabled_markets === 0) hdr.appendChild(badge('no enabled markets', 'muted'))
  }

  // Start / Stop button swap
  const ss = card.querySelector('[data-loop-startstop]')
  if (ss) {
    ss.innerHTML = ''
    if (!fresh.running) {
      const startBtn = el('button', {
        class: 'btn',
        onclick: async () => {
          startBtn.disabled = true; startBtn.textContent = 'Starting\u2026'
          const liveStatus = await api('/api/market-loop/status').catch(() => null)
          if (liveStatus && !liveStatus.sage_connected) {
            alert('Cannot start: Sage wallet certs not found. Enable the RPC server in Sage Settings \u2192 RPC.')
            startBtn.disabled = false; startBtn.textContent = '\u25b6 Start Loop'
            return
          }
          if (liveStatus && liveStatus.enabled_markets === 0) {
            alert('Cannot start: no enabled markets. Enable at least one market first.')
            startBtn.disabled = false; startBtn.textContent = '\u25b6 Start Loop'
            return
          }
          const r = await api('/api/market-loop/start', { method: 'POST' })
          if (!r.ok) alert('Cannot start loop: ' + (r.error || JSON.stringify(r)))
          await _patchLoopCard()
        },
      }, '\u25b6 Start Loop')
      ss.appendChild(startBtn)
    } else {
      const stopBtn = el('button', {
        class: 'btn btn-secondary',
        onclick: async () => {
          stopBtn.disabled = true; stopBtn.textContent = 'Stopping\u2026'
          await api('/api/market-loop/stop', { method: 'POST' })
          await _patchLoopCard()
        },
      }, '\u23f9 Stop Loop')
      ss.appendChild(stopBtn)
    }
  }

  // Stats
  const cycleEl = card.querySelector('[data-loop-stat-cycles] .stat-value')
  const errEl   = card.querySelector('[data-loop-stat-errors] .stat-value')
  const lastEl  = card.querySelector('[data-loop-stat-last] .stat-value')
  if (cycleEl) cycleEl.textContent = String(fresh.cycle_count ?? 0)
  if (errEl) {
    errEl.textContent = String(fresh.error_count ?? 0)
    errEl.style.color = fresh.error_count > 0 ? 'var(--red)' : ''
  }
  if (lastEl) lastEl.textContent = fresh.last_cycle_at ? new Date(fresh.last_cycle_at).toLocaleTimeString() : '\u2014'

  // Events log
  const evLogEl = card.querySelector('[data-loop-events]')
  if (evLogEl && fresh.recent_events?.length) {
    evLogEl.style.display = ''
    evLogEl.innerHTML = ''
    for (const ev of fresh.recent_events.slice().reverse()) {
      const line = el('div', { style: `color:${ev.type === 'cycle_error' ? 'var(--red)' : ev.type === 'cycle_done' ? 'var(--green)' : 'var(--muted)'}` })
      const ts = ev.at ? new Date(ev.at).toLocaleTimeString() : ''
      line.textContent = `${ts}  ${ev.message}`
      evLogEl.appendChild(line)
    }
  }
}

// ── Dashboard ──────────────────────────────────────────────────────────────
pages.dashboard = async function (content) {
  content.innerHTML = ''
  const topbar = document.getElementById('topbar-actions')
  topbar.innerHTML = ''
  topbar.appendChild(
    el('button', { class: 'btn btn-secondary', onclick: () => pages.dashboard(content) }, '↻ Refresh')
  )

  content.appendChild(
    el('div', { class: 'loading-row' }, el('div', { class: 'spinner' }), ' Loading…')
  )

  // Fetch everything in parallel
  const [sage, doctor, marketsRes, offersRes] = await Promise.all([
    api('/api/sage-rpc/status'),
    api('/api/doctor'),
    api('/api/markets-list'),
    api('/api/offers-status?limit=100&events_limit=5'),
  ])

  content.innerHTML = ''

  function makeStat(label, value, color, sub) {
    const s = el('div', { class: 'stat' })
    s.appendChild(el('div', { class: 'stat-label' }, label))
    const sv = el('div', { class: 'stat-value' })
    if (color) sv.style.color = color
    sv.textContent = value
    s.appendChild(sv)
    if (sub) s.appendChild(el('div', { class: 'stat-label', style: 'font-size:11px;margin-top:2px' }, sub))
    return s
  }

  // ── Detect wallet source ──────────────────────────────────────────────
  // Priority: Sage → Cloud Wallet (from doctor config) → Local Daemon
  const doctorData = doctor.parsed || {}
  const hasCloudWallet = (doctorData.resolved_key_ids?.length > 0) &&
    !doctorData.warnings?.some(w => String(w).toLowerCase().includes('cloud_wallet'))
  const walletSource = sage.connected ? 'sage'
    : hasCloudWallet ? 'cloud'
    : 'local'
  const walletLabels = { sage: 'Sage', cloud: 'Cloud Wallet', local: 'Local Daemon' }
  const walletColors = { sage: 'green', cloud: 'blue', local: 'muted' }

  // ── Wallet Strip ──────────────────────────────────────────────────────
  const walletCard = el('div', { class: 'card' })
  walletCard.style.borderColor = sage.connected ? 'rgba(56,189,132,.4)' : 'rgba(99,102,241,.3)'

  const walletHdr = el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:14px' })
  walletHdr.appendChild(el('div', { class: 'card-title', style: 'margin:0' }, 'Wallet'))
  walletHdr.appendChild(badge(walletLabels[walletSource], walletColors[walletSource]))
  if (sage.connected) {
    const ver = sage.version?.version
    if (ver) walletHdr.appendChild(el('span', { style: 'font-size:11px;color:var(--muted)' }, `v${ver}`))
  }
  walletCard.appendChild(walletHdr)

  if (sage.connected) {
    const sync = sage.sync_status || {}
    const key  = sage.active_key  || {}
    const precision = sync.unit?.precision ?? 12
    const balanceMojos = typeof sync.balance === 'number' ? sync.balance : null
    const balanceXch = balanceMojos !== null
      ? (balanceMojos / Math.pow(10, precision)).toLocaleString(undefined, { maximumFractionDigits: 6 })
      : '—'
    const ticker = sync.unit?.ticker ?? 'XCH'

    const wGrid = el('div', { class: 'grid-3' })
    wGrid.appendChild(makeStat('Balance', `${balanceXch} ${ticker}`, 'var(--green)'))
    wGrid.appendChild(makeStat('Active Key',
      key.name || (key.fingerprint ? String(key.fingerprint) : '—'), 'var(--accent)'))
    wGrid.appendChild(makeStat('Network', key.network_id || '—'))
    walletCard.appendChild(wGrid)

    if (sync.receive_address) {
      const addrRow = el('div', { style: 'margin-top:10px;display:flex;align-items:center;gap:8px' })
      addrRow.appendChild(el('code', {
        style: 'font-size:11px;word-break:break-all;flex:1;color:var(--muted)'
      }, sync.receive_address))
      const copyBtn = el('button', {
        class: 'btn btn-secondary',
        style: 'font-size:11px;padding:3px 10px;flex-shrink:0',
        onclick: () => {
          navigator.clipboard.writeText(sync.receive_address)
          copyBtn.textContent = 'Copied!'
          setTimeout(() => { copyBtn.textContent = 'Copy' }, 1500)
        }
      }, 'Copy')
      addrRow.appendChild(copyBtn)
      walletCard.appendChild(addrRow)
    }

    // Keys switcher
    const keysRes = await api('/api/sage-rpc/keys')
    if (keysRes.ok && (keysRes.keys || []).length > 0) {
      const keyToggle = el('details', { style: 'margin-top:12px' })
      keyToggle.appendChild(el('summary', {
        style: 'cursor:pointer;font-size:12px;color:var(--muted);user-select:none'
      }, `${keysRes.keys.length} wallet keys — click to switch`))
      const tblWrap = el('div', { class: 'tbl-wrap', style: 'margin-top:8px' })
      const tbl = el('table')
      tbl.appendChild(el('thead', {}, el('tr', {},
        ...['Name', 'Fingerprint', 'Network', ''].map(h => { const th = el('th'); th.textContent = h; return th })
      )))
      const tbody = el('tbody')
      for (const k of keysRes.keys) {
        const isActive = k.fingerprint === key.fingerprint
        const row = el('tr')
        if (isActive) row.style.background = 'rgba(56,189,132,.08)'
        function td(v) { const t = el('td'); t.textContent = String(v ?? '—'); return t }
        const nameTd = el('td')
        nameTd.appendChild(el('span', { style: 'font-weight:600' }, k.name || 'Unnamed'))
        if (isActive) nameTd.appendChild(el('span', {
          style: 'margin-left:6px;font-size:10px;background:rgba(56,189,132,.2);color:var(--green);padding:1px 6px;border-radius:4px'
        }, 'active'))
        row.appendChild(nameTd)
        row.appendChild(td(k.fingerprint))
        row.appendChild(td(k.network_id || '—'))
        const loginBtn = el('button', {
          class: 'btn btn-secondary',
          style: 'font-size:11px;padding:3px 10px',
          disabled: isActive,
          onclick: async () => {
            loginBtn.disabled = true
            const r = await api('/api/sage-rpc/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fingerprint: k.fingerprint }),
            })
            if (r.ok) pages.dashboard(content)
            else { alert('Login failed: ' + (r.error || '?')); loginBtn.disabled = false }
          }
        }, isActive ? 'Active' : 'Login')
        row.appendChild(el('td', {}, loginBtn))
        tbody.appendChild(row)
      }
      tbl.appendChild(tbody)
      tblWrap.appendChild(tbl)
      keyToggle.appendChild(tblWrap)
      walletCard.appendChild(keyToggle)
    }
  } else if (walletSource === 'cloud') {
    walletCard.appendChild(el('div', { style: 'color:var(--muted);font-size:13px' },
      'Cloud wallet configured — signing via remote key service.'))
  } else {
    // Not connected at all
    walletCard.style.borderColor = 'rgba(210,153,34,.3)'
    walletCard.appendChild(el('div', { style: 'color:var(--yellow);font-size:13px;margin-bottom:10px' },
      sage.error || 'No wallet connected. Enable Sage RPC in Sage → Settings → RPC, or configure cloud_wallet in Settings.'))
    walletCard.appendChild(el('button', {
      class: 'btn btn-secondary',
      onclick: () => navigate('settings'),
    }, 'Open Settings'))
  }
  content.appendChild(walletCard)

  // ── Markets Overview ──────────────────────────────────────────────────
  const markets = marketsRes.markets || []
  if (markets.length) {
    const offers = offersRes.parsed?.offers || offersRes.parsed?.results || []
    const activeOffers = offers.filter(o => (o.state || '').includes('active'))

    const mkCard = el('div', { class: 'card' })
    const mkHdr = el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:14px' })
    mkHdr.appendChild(el('div', { class: 'card-title', style: 'margin:0' }, 'Markets'))
    const enabledCount = markets.filter(m => m.enabled).length
    mkHdr.appendChild(badge(`${enabledCount} enabled`, enabledCount > 0 ? 'green' : 'muted'))
    mkHdr.appendChild(el('button', {
      class: 'btn btn-secondary',
      style: 'font-size:11px;padding:3px 10px;margin-left:auto',
      onclick: () => navigate('markets'),
    }, 'Manage →'))
    mkCard.appendChild(mkHdr)

    // Stats row
    const statsGrid = el('div', { class: 'grid-3 mb-16' })
    statsGrid.appendChild(makeStat('Configured', markets.length))
    statsGrid.appendChild(makeStat('Enabled', enabledCount, enabledCount > 0 ? 'var(--green)' : undefined))
    statsGrid.appendChild(makeStat('Active Offers', activeOffers.length, activeOffers.length > 0 ? 'var(--green)' : undefined))
    mkCard.appendChild(statsGrid)

    // Markets table
    const wrap = el('div', { class: 'tbl-wrap' })
    const tbl = el('table')
    tbl.appendChild(el('thead', {}, el('tr', {},
      ...['Market', 'Pair', 'Mode', 'Pricing', 'Active Offers', 'Status'].map(h => {
        const th = el('th'); th.textContent = h; return th
      })
    )))
    const tbody = el('tbody')
    for (const m of markets) {
      const mId = m.id || ''
      const mOffers = activeOffers.filter(o => o.market_id === mId)
      const row = el('tr')
      function td(child) {
        const t = el('td')
        if (typeof child === 'string' || typeof child === 'number') t.textContent = String(child)
        else if (child) t.appendChild(child)
        return t
      }

      // Market ID
      row.appendChild(td(mId))
      // Pair
      row.appendChild(td(`${m.base_symbol || m.base_asset?.slice(0,6) || '?'}:${m.quote_asset || '?'}`))
      // Mode
      row.appendChild(el('td', {}, badge(m.mode || '?', m.mode === 'sell_only' ? 'blue' : m.mode === 'two_sided' ? 'green' : 'muted')))
      // Pricing strategy
      const pricing = m.pricing || {}
      const pricingDesc = pricing.reference_source
        ? (pricing.buy_usd_per_base != null
            ? `buy ≤$${pricing.buy_usd_per_base} / sell ≥$${pricing.sell_usd_per_base}`
            : pricing.strategy_target_spread_bps != null
              ? `${pricing.reference_source} · ${pricing.strategy_target_spread_bps}bps spread`
              : `${pricing.reference_source}`)
        : pricing.fixed_quote_per_base != null
          ? `fixed ${pricing.fixed_quote_per_base}`
          : '—'
      row.appendChild(td(pricingDesc))
      // Active offers count
      row.appendChild(el('td', {}, el('span', {
        style: `font-weight:600;color:${mOffers.length > 0 ? 'var(--green)' : 'var(--muted)'}`
      }, String(mOffers.length))))
      // Enabled badge + toggle + build button
      const statusCell = el('td', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap' })
      statusCell.appendChild(badge(m.enabled ? 'enabled' : 'disabled', m.enabled ? 'green' : 'muted'))
      const toggleBtn = el('button', {
        class: 'btn btn-secondary',
        style: 'font-size:11px;padding:2px 8px',
        onclick: async () => {
          toggleBtn.disabled = true
          const updated = markets.map(x => x.id === m.id ? { ...x, enabled: !x.enabled } : x)
          const r = await api('/api/markets-write', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ markets: updated }),
          })
          if (r.ok) pages.dashboard(content)
          else { alert('Save failed: ' + (r.error || '?')); toggleBtn.disabled = false }
        }
      }, m.enabled ? '⏸ Disable' : '▶ Enable')
      statusCell.appendChild(toggleBtn)
      if (m.enabled) {
        const buildBtn = el('button', {
          class: 'btn btn-secondary',
          style: 'font-size:11px;padding:2px 8px',
          onclick: () => { _pendingBuildMarket = m; navigate('build') },
        }, '▸ Build Offer')
        statusCell.appendChild(buildBtn)
      }
      row.appendChild(statusCell)
      tbody.appendChild(row)
    }
    tbl.appendChild(tbody)
    wrap.appendChild(tbl)
    mkCard.appendChild(wrap)
    content.appendChild(mkCard)
  }

  // ── Market Loop ───────────────────────────────────────────────────────
  const loopRes = await api('/api/market-loop/status')
  const loop = loopRes || {}
  const loopCard = el('div', { class: 'card', 'data-loop-card': '1' })
  loopCard.style.borderColor = loop.running
    ? 'rgba(56,189,132,.4)'
    : loop.can_start
      ? 'rgba(99,102,241,.3)'
      : 'rgba(120,120,120,.2)'

  const loopHdr = el('div', { 'data-loop-hdr': '1', style: 'display:flex;align-items:center;gap:10px;margin-bottom:14px' })
  loopHdr.appendChild(el('div', { class: 'card-title', style: 'margin:0' }, 'Market Loop'))
  loopHdr.appendChild(badge(
    loop.running ? '● running' : '○ stopped',
    loop.running ? 'green' : 'muted',
  ))
  if (!loop.sage_connected) loopHdr.appendChild(badge('Sage offline', 'yellow'))
  if (loop.enabled_markets === 0) loopHdr.appendChild(badge('no enabled markets', 'muted'))
  loopCard.appendChild(loopHdr)

  const loopDesc = el('p', { style: 'margin:0 0 12px;color:var(--muted);font-size:13px' })
  loopDesc.textContent =
    'When running, the loop evaluates ladder strategy, posts offers via Sage RPC, ' +
    'and cancels/rotates offers each cycle — exactly what the daemon does.'
  loopCard.appendChild(loopDesc)

  const loopGrid = el('div', { class: 'grid-3', style: 'margin-bottom:14px' })
  const _cycleStat = makeStat('Cycles run', String(loop.cycle_count ?? 0))
  _cycleStat.dataset.loopStatCycles = '1'
  loopGrid.appendChild(_cycleStat)
  const _errStat = makeStat('Errors', String(loop.error_count ?? 0), loop.error_count > 0 ? 'var(--red)' : undefined)
  _errStat.dataset.loopStatErrors = '1'
  loopGrid.appendChild(_errStat)
  const _lastStat = makeStat('Last cycle',
    loop.last_cycle_at ? new Date(loop.last_cycle_at).toLocaleTimeString() : '—')
  _lastStat.dataset.loopStatLast = '1'
  loopGrid.appendChild(_lastStat)
  loopCard.appendChild(loopGrid)

  // Controls row
  const loopBtns = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px' })

  // [data-loop-startstop] is a display:contents wrapper so _patchLoopCard can
  // swap Start ↔ Stop without touching the rest of the buttons row.
  const _ssWrap = el('div', { 'data-loop-startstop': '1', style: 'display:contents' })
  if (!loop.running) {
    const startBtn = el('button', {
      class: 'btn',
      onclick: async () => {
        startBtn.disabled = true; startBtn.textContent = 'Starting…'
        const liveStatus = await api('/api/market-loop/status').catch(() => null)
        if (liveStatus && !liveStatus.sage_connected) {
          alert('Cannot start: Sage wallet certs not found. Enable the RPC server in Sage Settings → RPC.')
          startBtn.disabled = false; startBtn.textContent = '▶ Start Loop'
          return
        }
        if (liveStatus && liveStatus.enabled_markets === 0) {
          alert('Cannot start: no enabled markets. Enable at least one market first.')
          startBtn.disabled = false; startBtn.textContent = '▶ Start Loop'
          return
        }
        const r = await api('/api/market-loop/start', { method: 'POST' })
        if (!r.ok) alert('Cannot start loop: ' + (r.error || JSON.stringify(r)))
        await _patchLoopCard()
      },
    }, '▶ Start Loop')
    _ssWrap.appendChild(startBtn)
  } else {
    const stopBtn = el('button', {
      class: 'btn btn-secondary',
      onclick: async () => {
        stopBtn.disabled = true; stopBtn.textContent = 'Stopping…'
        await api('/api/market-loop/stop', { method: 'POST' })
        await _patchLoopCard()
      },
    }, '⏹ Stop Loop')
    _ssWrap.appendChild(stopBtn)
  }
  loopBtns.appendChild(_ssWrap)

  const trigBtn = el('button', {
    class: 'btn btn-secondary',
    onclick: async () => {
      trigBtn.disabled = true; trigBtn.textContent = 'Running…'
      const r = await api('/api/market-loop/trigger', { method: 'POST' })
      trigBtn.disabled = false; trigBtn.textContent = '⚡ Run Once'
      if (r.ok) {
        const code = r.result?.exit_code
        trigBtn.textContent = code === 0 ? '✓ Done' : `✗ Error (${code})`
        setTimeout(() => { trigBtn.textContent = '⚡ Run Once' }, 3000)
        _patchLoopCard()
      } else {
        alert('Trigger failed: ' + (r.error || JSON.stringify(r)))
      }
    },
  }, '⚡ Run Once')
  loopBtns.appendChild(trigBtn)
  loopCard.appendChild(loopBtns)

  // Recent loop events log
  const events = loop.recent_events || []
  const evLog = el('div', {
    style: 'background:var(--surface-alt,#151515);border-radius:6px;padding:8px 12px;max-height:140px;overflow-y:auto;font-family:monospace;font-size:11px',
    'data-loop-events': '1',
  })
  if (!events.length) evLog.style.display = 'none'
  for (const ev of events.slice().reverse()) {
    const line = el('div', { style: `color:${ev.type === 'cycle_error' ? 'var(--red)' : ev.type === 'cycle_done' ? 'var(--green)' : 'var(--muted)'}` })
    const ts = ev.at ? new Date(ev.at).toLocaleTimeString() : ''
    line.textContent = `${ts}  ${ev.message}`
    evLog.appendChild(line)
  }
  loopCard.appendChild(evLog)

  // Live-poll loop status every 5 s while this card is in the DOM.
  // Catches: market enabled after page load, loop stopped/started externally.
  // Clear any leftover timer from the previous render before registering a new one.
  if (_loopPollTimerId !== null) { clearInterval(_loopPollTimerId); _loopPollTimerId = null }
  _loopPollTimerId = setInterval(async () => {
    if (!document.querySelector('[data-loop-card]')) {
      clearInterval(_loopPollTimerId); _loopPollTimerId = null; return
    }
    await _patchLoopCard()
  }, 5000)

  content.appendChild(loopCard)

  // ── Recent Offers ─────────────────────────────────────────────────────
  const allOffers = offersRes.parsed?.offers || offersRes.parsed?.results || []
  if (allOffers.length) {
    const ofCard = el('div', { class: 'card' })
    const ofHdr = el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:14px' })
    ofHdr.appendChild(el('div', { class: 'card-title', style: 'margin:0' }, 'Recent Offers'))
    ofHdr.appendChild(el('button', {
      class: 'btn btn-secondary',
      style: 'font-size:11px;padding:3px 10px;margin-left:auto',
      onclick: () => navigate('offers'),
    }, 'View All'))
    ofCard.appendChild(ofHdr)

    const wrap = el('div', { class: 'tbl-wrap' })
    const tbl = el('table')
    tbl.appendChild(el('thead', {}, el('tr', {},
      ...['Market', 'Pair', 'State', 'Expires'].map(h => { const th = el('th'); th.textContent = h; return th })
    )))
    const tbody = el('tbody')
    for (const o of allOffers.slice(0, 10)) {
      const state = o.state || o.offer_state || '?'
      const stateColor = state === 'active' ? 'green' : state === 'taken' ? 'blue' : state === 'expired' ? 'muted' : 'yellow'
      const row = el('tr')
      function td(child) {
        const t = el('td')
        if (typeof child === 'string') t.textContent = child
        else if (child) t.appendChild(child)
        return t
      }
      row.appendChild(td(o.market_id || '—'))
      row.appendChild(td(`${o.base_symbol || '?'}:${o.quote_asset || '?'}`))
      row.appendChild(el('td', {}, badge(state, stateColor)))
      row.appendChild(td(o.expires_at ? new Date(o.expires_at).toLocaleString() : '—'))
      tbody.appendChild(row)
    }
    tbl.appendChild(tbody)
    wrap.appendChild(tbl)
    ofCard.appendChild(wrap)
    content.appendChild(ofCard)
  }

  // ── Config problems / warnings (only if any) ──────────────────────────
  const problems = doctorData.problems || []
  const warnings = doctorData.warnings || []

  if (problems.length) {
    const pCard = el('div', { class: 'card' })
    pCard.style.borderColor = 'rgba(248,81,73,.4)'
    pCard.appendChild(el('div', { class: 'card-title' }, `Config Problems (${problems.length})`))
    const pl = el('div', { class: 'check-list' })
    for (const p of problems) {
      const item = el('div', { class: 'check-item' })
      item.appendChild(el('span', { class: 'ci-icon' }, '❌'))
      const info = el('div')
      info.appendChild(el('div', { class: 'ci-key', style: 'color:var(--red)' }, String(p)))
      item.appendChild(info)
      pl.appendChild(item)
    }
    pCard.appendChild(pl)
    content.appendChild(pCard)
  }

  if (warnings.length) {
    const wCard = el('div', { class: 'card' })
    wCard.style.borderColor = 'rgba(210,153,34,.3)'
    wCard.appendChild(el('div', { class: 'card-title' }, `Config Warnings (${warnings.length})`))
    const wl = el('div', { class: 'check-list' })
    for (const w of warnings) {
      const item = el('div', { class: 'check-item' })
      item.appendChild(el('span', { class: 'ci-icon' }, '⚠️'))
      const info = el('div')
      info.appendChild(el('div', { class: 'ci-key', style: 'color:var(--yellow)' }, String(w)))
      item.appendChild(info)
      wl.appendChild(item)
    }
    wCard.appendChild(wl)
    content.appendChild(wCard)
  }
}

// ── Offers ─────────────────────────────────────────────────────────────────
pages.offers = async function (content) {
  content.innerHTML = ''
  const topbar = document.getElementById('topbar-actions')
  topbar.innerHTML = ''
  const btnRefresh = el('button', {
    class: 'btn btn-secondary',
    onclick: () => { loadOffers(); loadSageOffers() },
  }, '↻ Refresh')
  const btnReconcile = el('button', { class: 'btn btn-primary', onclick: () => runReconcile() }, '⚡ Reconcile')
  const btnCancelAll = el('button', {
    class: 'btn',
    style: 'background:var(--red,#c0392b);border-color:var(--red,#c0392b)',
    onclick: async () => {
      if (!confirm('Cancel ALL active offers in your Sage wallet?')) return
      btnCancelAll.disabled = true; btnCancelAll.textContent = 'Cancelling…'
      const r = await api('/api/sage-rpc/offers/cancel-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      btnCancelAll.disabled = false; btnCancelAll.textContent = '✕ Cancel All'
      if (r.ok) {
        alert(`Cancelled ${r.cancelled} of ${r.total} offers.${r.failed ? ` ${r.failed} failed.` : ''}`)
        loadSageOffers()
      } else {
        alert('Cancel all failed: ' + (r.error || JSON.stringify(r)))
      }
    },
  }, '✕ Cancel All')
  topbar.appendChild(el('div', { class: 'btn-group' }, btnRefresh, btnReconcile, btnCancelAll))

  const statusCard = el('div', { class: 'card' })
  const sageCard = el('div', { class: 'card' })
  const reconCard = el('div', { class: 'card' })
  reconCard.style.display = 'none'
  content.appendChild(statusCard)
  content.appendChild(sageCard)
  content.appendChild(reconCard)

  async function loadOffers() {
    statusCard.innerHTML =
      '<div class="card-title">Offers Status</div><div class="loading-row"><div class="spinner"></div> Loading…</div>'
    const res = await api('/api/offers-status?limit=50&events_limit=20')
    statusCard.innerHTML = '<div class="card-title">Offers Status</div>'
    if (!res.parsed) {
      const t = el('div', { class: 'terminal' })
      t.textContent = res.raw || res.error || 'No output'
      statusCard.appendChild(t)
      return
    }
    const offers = res.parsed.offers || res.parsed.results || []
    if (!offers.length) {
      statusCard.appendChild(el('div', { class: 'empty' }, 'No offers found.'))
      return
    }
    const headers = ['Offer ID', 'Market', 'State', 'Pair', 'Taker Signal', 'Created', 'Expires', 'Events']
    const wrap = el('div', { class: 'tbl-wrap' })
    const tbl = el('table')
    tbl.appendChild(
      el('thead', {}, el('tr', {}, ...headers.map((h) => { const th = el('th'); th.textContent = h; return th })))
    )
    const tbody = el('tbody')
    for (const o of offers) {
      const state = o.state || o.offer_state || '?'
      const stateColor = state === 'active' ? 'green' : state === 'taken' ? 'blue' : state === 'expired' ? 'muted' : 'yellow'
      const takerSig = o.taker_signal || '—'
      const ts = takerSig !== 'none' && takerSig !== '—' ? badge(takerSig, 'blue') : el('span', { class: 'text-muted' }, takerSig)
      const row = el('tr')
      function td(child) {
        const t = el('td')
        if (typeof child === 'string') t.textContent = child
        else t.appendChild(child)
        return t
      }
      const idSpan = el('span', { style: 'font-family:var(--font-mono);font-size:11px;display:block' })
      idSpan.textContent = o.offer_id || '—'
      row.appendChild(td(idSpan))
      row.appendChild(td(o.market_id || '—'))
      row.appendChild(el('td', {}, badge(state, stateColor)))
      row.appendChild(td(`${o.base_symbol || '?'}:${o.quote_asset || '?'}`))
      row.appendChild(el('td', {}, ts))
      row.appendChild(td(o.created_at ? new Date(o.created_at).toLocaleString() : '—'))
      row.appendChild(td(o.expires_at ? new Date(o.expires_at).toLocaleString() : '—'))
      row.appendChild(td(String((o.events || []).length)))
      tbody.appendChild(row)
    }
    tbl.appendChild(tbody)
    wrap.appendChild(tbl)

    const total = offers.length
    const active = offers.filter((o) => (o.state || '').includes('active')).length
    const statsGrid = el('div', { class: 'grid-3 mb-16' })
    ;[['Total', total], ['Active', active], ['Other', total - active]].forEach(([l, v]) => {
      const s = el('div', { class: 'stat' })
      s.appendChild(el('div', { class: 'stat-label' }, l))
      const sv = el('div', { class: 'stat-value' })
      sv.textContent = v
      s.appendChild(sv)
      statsGrid.appendChild(s)
    })
    statusCard.appendChild(statsGrid)
    statusCard.appendChild(wrap)
  }

  async function loadSageOffers() {
    sageCard.innerHTML =
      '<div class="card-title">Sage Wallet Offers</div><div class="loading-row"><div class="spinner"></div> Loading…</div>'
    const res = await api('/api/sage-rpc/offers?limit=200')
    sageCard.innerHTML = '<div class="card-title">Sage Wallet Offers</div>'
    if (!res.ok) {
      sageCard.appendChild(el('div', { class: 'empty text-muted' },
        res.error || 'Could not reach Sage wallet (is it running?)'))
      return
    }
    const offers = res.offers || []
    if (!offers.length) {
      sageCard.appendChild(el('div', { class: 'empty' }, 'No active offers in Sage wallet.'))
      return
    }
    const active = offers.filter(o => !['completed', 'failed', 'expired'].includes(String(o.status || '').toLowerCase()))
    const countGrid = el('div', { class: 'grid-3 mb-16' })
    ;[['Total', offers.length], ['Active', active.length], ['Completed', offers.length - active.length]].forEach(([l, v]) => {
      const s = el('div', { class: 'stat' }); s.appendChild(el('div', { class: 'stat-label' }, l))
      const sv = el('div', { class: 'stat-value' }); sv.textContent = v; s.appendChild(sv)
      countGrid.appendChild(s)
    })
    sageCard.appendChild(countGrid)

    const wrap = el('div', { class: 'tbl-wrap' })
    const tbl = el('table')
    tbl.appendChild(el('thead', {}, el('tr', {},
      ...['Offer ID', 'Status', 'Offered', 'Requested', ''].map(h => { const th = el('th'); th.textContent = h; return th })
    )))
    const tbody = el('tbody')
    for (const o of offers) {
      const status = String(o.status || 'unknown').toLowerCase()
      const isActive = !['completed', 'failed', 'expired'].includes(status)
      const stateColor = status === 'active' || status === 'pending' ? 'green' : status === 'completed' ? 'blue' : 'muted'
      const row = el('tr')
      function td2(child) {
        const t = el('td')
        if (typeof child === 'string') t.textContent = child
        else if (child) t.appendChild(child)
        return t
      }
      const idEl = el('span', { style: 'font-family:var(--font-mono);font-size:10px' })
      idEl.textContent = String(o.offer_id || '—').slice(0, 20) + (String(o.offer_id || '').length > 20 ? '…' : '')
      idEl.title = o.offer_id || ''
      row.appendChild(td2(idEl))
      row.appendChild(el('td', {}, badge(status, stateColor)))
      // Offered / requested asset summaries
      const ofAssets = (o.offered_assets || []).map(a => {
        const id = a.asset_id === null ? 'XCH' : String(a.asset_id || '').slice(0, 8) + '…'
        const amt = a.amount?.mojos !== undefined ? a.amount.mojos : (a.amount || 0)
        return `${id} (${amt})`
      }).join(', ') || '—'
      const reqAssets = (o.requested_assets || []).map(a => {
        const id = a.asset_id === null ? 'XCH' : String(a.asset_id || '').slice(0, 8) + '…'
        const amt = a.amount?.mojos !== undefined ? a.amount.mojos : (a.amount || 0)
        return `${id} (${amt})`
      }).join(', ') || '—'
      row.appendChild(td2(ofAssets))
      row.appendChild(td2(reqAssets))
      // Cancel button cell
      const actionTd = el('td')
      if (isActive) {
        const cancelBtn = el('button', {
          class: 'btn btn-secondary',
          style: 'font-size:11px;padding:2px 8px;color:var(--red)',
          onclick: async () => {
            cancelBtn.disabled = true; cancelBtn.textContent = '…'
            const r = await api('/api/sage-rpc/offers/cancel', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ offer_id: o.offer_id }),
            })
            if (r.ok) {
              row.style.opacity = '0.4'
              cancelBtn.textContent = '✓'
            } else {
              cancelBtn.disabled = false; cancelBtn.textContent = '✕ Cancel'
              alert('Cancel failed: ' + (r.error || JSON.stringify(r)))
            }
          },
        }, '✕ Cancel')
        actionTd.appendChild(cancelBtn)
      }
      row.appendChild(actionTd)
      tbody.appendChild(row)
    }
    tbl.appendChild(tbody)
    wrap.appendChild(tbl)
    sageCard.appendChild(wrap)
  }

  async function runReconcile() {
    btnReconcile.disabled = true
    reconCard.style.display = ''
    reconCard.innerHTML =
      '<div class="card-title">Reconcile Output</div><div class="loading-row"><div class="spinner"></div> Reconciling…</div>'
    const res = await api('/api/offers-reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    reconCard.innerHTML = '<div class="card-title">Reconcile Output</div>'
    const viewer = el('div', { class: 'terminal' })
    viewer.appendChild(renderJson(res.parsed || { raw: res.raw, error: res.error }))
    reconCard.appendChild(viewer)
    btnReconcile.disabled = false
  }

  loadOffers()
  loadSageOffers()
}

// ── Coins ──────────────────────────────────────────────────────────────────
pages.coins = async function (content) {
  content.innerHTML = ''
  const topbar = document.getElementById('topbar-actions')
  topbar.innerHTML = ''
  topbar.appendChild(
    el('button', { class: 'btn btn-secondary', onclick: () => loadCoins() }, '↻ Refresh')
  )

  const listCard = el('div', { class: 'card' })
  content.appendChild(listCard)

  // Split / Combine forms — built once, inputs shared so coin-row buttons can pre-fill them
  let splitPairEl, splitAmtEl, splitNumEl, splitCoinEl
  let combinePairEl, combineCntEl, combineAssetEl
  const splitCard = el('div', { class: 'card' })
  const combineCard = el('div', { class: 'card' })
  splitCard.appendChild(el('div', { class: 'card-title' }, 'Split Coin'))
  splitCard.appendChild(buildSplitForm())
  content.appendChild(splitCard)
  combineCard.appendChild(el('div', { class: 'card-title' }, 'Combine Coins'))
  combineCard.appendChild(buildCombineForm())
  content.appendChild(combineCard)

  // ── wallet source detection ──────────────────────────────────────────────
  // Priority: Sage RPC → CLI (cloud wallet / local daemon)
  async function detectWalletSource() {
    const sage = await api('/api/sage-rpc/status')
    if (sage.connected) return { source: 'sage', sage }
    return { source: 'cli', sage: null }
  }

  // ── normalize a coin record to a common shape ────────────────────────────
  // Sage coin fields: coin_id, parent_coin_info, puzzle_hash, amount (bigint mojos),
  //                   asset_id (null=XCH, hex=CAT), spendable (bool)
  // CLI  coin fields: varies — coin_id/id, amount_mojos/amount/mojos, asset/ticker, spendable, state
  function normalizeSageCoin(c) {
    return {
      coin_id:  c.coin_id || c.parent_coin_info || '?',
      asset_id: c.asset_id || null,          // null = XCH
      amount:   typeof c.amount === 'number' ? c.amount : (c.amount?.mojos ?? 0),
      // Sage does not return a 'spendable' bool; infer it: unspent + no pending tx + no open offer
      spendable: c.spent_height == null && c.transaction_id == null && c.offer_id == null,
      source: 'sage',
    }
  }
  function normalizeCliCoin(c) {
    return {
      coin_id:  c.coin_id || c.id || '?',
      asset_id: c.asset_id || null,
      amount:   c.amount_mojos ?? c.amount ?? c.mojos ?? 0,
      spendable: !!c.spendable,
      state:    c.state || c.coin_state || '?',
      source: 'cli',
    }
  }

  async function loadCoins() {
    listCard.innerHTML =
      '<div class="card-title">Coin Inventory</div><div class="loading-row"><div class="spinner"></div> Detecting wallet…</div>'

    const { source, sage } = await detectWalletSource()

    listCard.innerHTML = ''
    const titleRow = el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:14px' })
    titleRow.appendChild(el('div', { class: 'card-title', style: 'margin:0' }, 'Coin Inventory'))
    titleRow.appendChild(badge(source === 'sage' ? 'Sage RPC' : 'CLI', source === 'sage' ? 'green' : 'muted'))
    listCard.appendChild(titleRow)

    // Live-updating stats strip
    let statTotalEl, statSpendableEl, statLockedEl
    const statsGrid = el('div', { class: 'grid-3 mb-16' })
    ;[
      ['Total Coins',  (ref) => { statTotalEl     = ref }],
      ['Spendable',    (ref) => { statSpendableEl = ref }],
      ['Locked',       (ref) => { statLockedEl    = ref }],
    ].forEach(([label, setRef]) => {
      const s = el('div', { class: 'stat' })
      s.appendChild(el('div', { class: 'stat-label' }, label))
      const sv = el('div', { class: 'stat-value' }); sv.textContent = '0'
      setRef(sv); s.appendChild(sv); statsGrid.appendChild(s)
    })
    listCard.appendChild(statsGrid)

    // Container into which asset sections are appended as they arrive
    const assetContainer = el('div')
    listCard.appendChild(assetContainer)

    let totalCoins = 0, totalSpendable = 0

    // CAT metadata map: asset_id hex -> TokenRecord (name, ticker, icon_url, precision)
    const catMeta = new Map()
    // Price map: asset_id hex -> XCH per 1 token; plus special key 'xch_usd' = USD per 1 XCH
    const priceMap = new Map()  // asset_id → price_in_xch (from Dexie)

    // ── Render one asset group immediately, update running stats ─────────────
    function renderAssetSection(assetKey, group) {
      if (!group.length) return

      // Update running totals
      const sp = group.filter(c => c.spendable).length
      totalCoins += group.length
      totalSpendable += sp
      statTotalEl.textContent = totalCoins
      statSpendableEl.textContent = totalSpendable
      statLockedEl.textContent = totalCoins - totalSpendable

      const isXch = assetKey === 'xch'
      const meta = isXch ? null : catMeta.get(assetKey) || null
      const precision = isXch ? 12 : (meta?.precision ?? 3)
      const displayName = isXch ? 'XCH' : (meta?.name || null)
      const displayTicker = isXch ? 'XCH' : (meta?.ticker || null)
      const iconUrl = isXch ? null : (meta?.icon_url || null)

      const totalMojos = group.reduce((s, c) => s + Number(c.amount), 0)
      const fmt = (mojos) => isXch
        ? `${(mojos / Math.pow(10, precision)).toLocaleString(undefined, { maximumFractionDigits: precision <= 3 ? precision : 6 })} XCH`
        : `${(mojos / Math.pow(10, precision)).toLocaleString(undefined, { maximumFractionDigits: precision })} ${displayTicker || ''}`
      const totalFormatted = fmt(totalMojos)
      const spendableMojos = group.filter(c => c.spendable).reduce((s, c) => s + Number(c.amount), 0)
      const spendableFormatted = fmt(spendableMojos)

      // USD value for the total holding
      const xchUsd = priceMap.get('xch_usd') || 0
      let usdValue = null
      if (xchUsd > 0) {
        if (isXch) {
          usdValue = (totalMojos / 1e12) * xchUsd
        } else {
          const priceXch = priceMap.get(assetKey)
          if (priceXch != null) {
            usdValue = (totalMojos / Math.pow(10, precision)) * priceXch * xchUsd
          }
        }
      }
      const usdStr = usdValue != null
        ? ` · ≈ $${usdValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : ''

      const section = el('div', { style: 'margin-bottom:10px' })

      // All sections start collapsed
      let expanded = false

      // Asset header row — collapse toggle + logo + name + ticker + copy ID
      const hdr = el('div', {
        style: 'display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--surface2);border-radius:6px;cursor:pointer;user-select:none'
      })

      // Chevron
      const chevron = el('span', { style: `font-size:11px;color:var(--muted);transition:transform .15s;transform:${expanded ? 'rotate(90deg)' : 'rotate(0deg)'}` }, '▶')
      hdr.appendChild(chevron)

      if (iconUrl) {
        const img = el('img', { src: iconUrl, alt: displayTicker || '', loading: 'lazy' })
        img.style.cssText = 'width:22px;height:22px;border-radius:4px;object-fit:cover;flex-shrink:0'
        img.onerror = () => { img.style.display = 'none' }
        hdr.appendChild(img)
      }
      const nameSpan = el('span', { style: 'font-weight:700;font-size:13px' },
        displayName || (isXch ? 'XCH' : assetKey.slice(0, 12) + '…'))
      hdr.appendChild(nameSpan)
      if (displayTicker && displayTicker !== displayName) {
        hdr.appendChild(el('span', { style: 'font-size:11px;color:var(--muted);font-family:var(--font-mono)' },
          displayTicker))
      }
      hdr.appendChild(el('span', { style: 'font-size:11px;color:var(--muted);margin-left:auto' },
        `${group.length} coin${group.length !== 1 ? 's' : ''} · total: ${totalFormatted}${usdStr} · spendable: ${spendableFormatted}`))
      if (!isXch) {
        const copyId = el('button', {
          class: 'btn btn-secondary',
          style: 'font-size:10px;padding:1px 6px',
          onclick: (e) => { e.stopPropagation(); navigator.clipboard.writeText(assetKey); copyId.textContent = 'Copied!'; setTimeout(() => { copyId.textContent = 'Copy ID' }, 1500) }
        }, 'Copy ID')
        hdr.appendChild(copyId)
      }
      section.appendChild(hdr)

      const wrap = el('div', { class: 'tbl-wrap', style: `display:${expanded ? 'block' : 'none'};margin-top:4px` })
      const tbl = el('table')
      const headers = source === 'sage'
        ? ['', 'Asset', 'Symbol', 'Coin ID', 'Amount', 'Spendable', '']
        : ['', 'Asset', 'Symbol', 'Coin ID', 'Amount', 'State', 'Spendable', '']
      tbl.appendChild(el('thead', {}, el('tr', {}, ...headers.map((h) => { const th = el('th'); th.textContent = h; return th }))))

      const tbody = el('tbody')
      for (const c of group) {
        const row = el('tr')
        row.style.cursor = 'default'

        function td(child) {
          const t = el('td')
          if (typeof child === 'string' || typeof child === 'number') t.textContent = String(child)
          else if (child) t.appendChild(child)
          return t
        }

        // Logo cell
        const logoCell = el('td', { style: 'width:28px;text-align:center' })
        if (iconUrl) {
          const img = el('img', { src: iconUrl, alt: displayTicker || '', loading: 'lazy' })
          img.style.cssText = 'width:18px;height:18px;border-radius:3px;object-fit:cover;vertical-align:middle'
          img.onerror = () => { img.style.display = 'none' }
          logoCell.appendChild(img)
        }
        row.appendChild(logoCell)

        // Asset name cell
        row.appendChild(td(displayName || (isXch ? 'XCH' : '—')))

        // Symbol / ticker cell
        const symCell = el('td', { style: 'font-family:var(--font-mono);font-size:11px;font-weight:600' })
        symCell.textContent = displayTicker || (isXch ? 'XCH' : '—')
        row.appendChild(symCell)

        // Coin ID (monospace, truncated)
        const idWrap = el('div', { style: 'display:flex;align-items:center;gap:6px' })
        const idSpan = el('span', { style: 'font-family:var(--font-mono);font-size:11px' })
        idSpan.textContent = c.coin_id.length > 20
          ? c.coin_id.slice(0, 10) + '…' + c.coin_id.slice(-6)
          : c.coin_id
        idSpan.title = c.coin_id
        const copyBtn = el('button', {
          class: 'btn btn-secondary',
          style: 'font-size:10px;padding:1px 5px;flex-shrink:0',
          onclick: () => { navigator.clipboard.writeText(c.coin_id); copyBtn.textContent = '✓'; setTimeout(() => { copyBtn.textContent = '⎘' }, 1200) }
        }, '⎘')
        idWrap.appendChild(idSpan); idWrap.appendChild(copyBtn)
        row.appendChild(el('td', {}, idWrap))

        // Amount
        const amtMojos = Number(c.amount)
        const amtText = fmt(amtMojos)
        row.appendChild(td(amtText))

        // State (CLI only)
        if (source === 'cli') {
          const state = c.state || '?'
          const ok = state === 'spendable' || state === 'confirmed'
          row.appendChild(el('td', {}, badge(state, ok ? 'green' : 'yellow')))
        }

        // Spendable
        row.appendChild(el('td', {}, badge(c.spendable ? 'yes' : 'no', c.spendable ? 'green' : 'muted')))

        // Actions: pre-fill Split or Combine forms
        const pairHint = isXch ? 'XCH:xch' : `${displayTicker || assetKey.slice(0,8)}:xch`
        const actionsWrap = el('div', { style: 'display:flex;gap:4px' })

        const splitBtn = el('button', {
          class: 'btn btn-secondary',
          style: 'font-size:11px;padding:3px 8px',
          onclick: () => {
            if (splitCoinEl) splitCoinEl.value = c.coin_id
            if (splitPairEl && !splitPairEl.value) splitPairEl.value = pairHint
            splitCard.scrollIntoView({ behavior: 'smooth', block: 'start' })
            splitCoinEl?.focus()
          }
        }, '▸ Split')

        const combineBtn = el('button', {
          class: 'btn btn-secondary',
          style: 'font-size:11px;padding:3px 8px',
          onclick: () => {
            if (combineAssetEl) combineAssetEl.value = isXch ? 'xch' : assetKey
            if (combinePairEl && !combinePairEl.value) combinePairEl.value = pairHint
            combineCard.scrollIntoView({ behavior: 'smooth', block: 'start' })
            combineCntEl?.focus()
          }
        }, '▸ Combine')

        actionsWrap.appendChild(splitBtn)
        actionsWrap.appendChild(combineBtn)
        row.appendChild(el('td', {}, actionsWrap))

        tbody.appendChild(row)
      }
      tbl.appendChild(tbody)
      wrap.appendChild(tbl)
      section.appendChild(wrap)

      // Wire up collapse toggle on the header
      hdr.addEventListener('click', () => {
        expanded = !expanded
        wrap.style.display = expanded ? 'block' : 'none'
        chevron.style.transform = expanded ? 'rotate(90deg)' : 'rotate(0deg)'
      })

      assetContainer.appendChild(section)
    }

    // ── Sage: stream each asset as it arrives ─────────────────────────────────
    if (source === 'sage') {
      // Paginated fetch for a specific asset_id (null = XCH)
      async function fetchSageCoins(assetId) {
        const out = []
        let offset = 0
        const limit = 500
        const qs = assetId ? `&asset_id=${encodeURIComponent(assetId)}` : ''
        while (true) {
          const res = await api(`/api/sage-rpc/coins?limit=${limit}&offset=${offset}${qs}`)
          if (!res.ok) throw new Error(res.error || JSON.stringify(res))
          const batch = (res.coins || []).map(c => ({ ...normalizeSageCoin(c), asset_id: assetId }))
          out.push(...batch)
          if (batch.length < limit) break
          offset += limit
        }
        return out
      }

      // Step 1: fetch CAT metadata + prices in parallel
      const progressEl = el('div', { class: 'loading-row' })
      progressEl.innerHTML = '<div class="spinner"></div> Fetching token list & prices…'
      assetContainer.appendChild(progressEl)

      let catList = []
      await Promise.allSettled([
        api('/api/sage-rpc/cats').then(res => {
          if (res.ok) {
            catList = res.cats || []
            for (const cat of catList) {
              if (cat.asset_id) catMeta.set(cat.asset_id, cat)
            }
          }
        }),
        api('/api/prices').then(res => {
          if (res.ok) {
            if (res.xch_usd) priceMap.set('xch_usd', res.xch_usd)
            for (const t of (res.tickers || [])) {
              if (t.base_currency && t.last_price != null) {
                priceMap.set(t.base_currency, parseFloat(t.last_price))
              }
            }
          }
        }),
      ])
      progressEl.remove()

      // Step 2: XCH coins — fetch, then render immediately
      const xchProgress = el('div', { class: 'loading-row' })
      xchProgress.innerHTML = '<div class="spinner"></div> Loading XCH coins…'
      assetContainer.appendChild(xchProgress)
      try {
        const xchCoins = await fetchSageCoins(null)
        xchProgress.remove()
        renderAssetSection('xch', xchCoins)
      } catch (e) {
        xchProgress.remove()
        assetContainer.appendChild(el('div', { class: 'terminal', style: 'color:var(--red)' },
          `Sage error (XCH): ${e.message}`))
        return
      }

      // Step 3: for each active CAT — sorted by USD value desc, then fetch & render immediately
      const xchUsdForSort = priceMap.get('xch_usd') || 0
      const catUsdValue = (cat) => {
        const priceXch = priceMap.get(cat.asset_id) || 0
        const precision = catMeta.get(cat.asset_id)?.precision ?? 3
        return (Number(cat.balance) / Math.pow(10, precision)) * priceXch * xchUsdForSort
      }
      const activeCats = catList
        .filter(c => c.asset_id && Number(c.balance) > 0)
        .sort((a, b) => catUsdValue(b) - catUsdValue(a))
      for (const cat of activeCats) {
        const label = cat.ticker || cat.name || cat.asset_id.slice(0, 10) + '…'
        const catProgress = el('div', { class: 'loading-row' })
        catProgress.innerHTML = `<div class="spinner"></div> Loading ${label} coins…`
        assetContainer.appendChild(catProgress)
        try {
          const catCoins = await fetchSageCoins(cat.asset_id)
          catProgress.remove()
          renderAssetSection(cat.asset_id, catCoins)
        } catch (_) {
          catProgress.remove()
          // skip this CAT on error
        }
      }

      if (totalCoins === 0) {
        assetContainer.appendChild(el('div', { class: 'empty' }, 'No coins found.'))
      }

    } else {
      // ── CLI fallback ──────────────────────────────────────────────────────
      const res = await api('/api/coins-list')
      if (!res.parsed) {
        const t = el('div', { class: 'terminal' })
        t.textContent = res.raw || res.error || 'No output — configure cloud_wallet or enable Sage RPC'
        assetContainer.appendChild(t)
        return
      }
      const coins = (res.parsed.coins || res.parsed.results || []).map(normalizeCliCoin)
      if (!coins.length) {
        assetContainer.appendChild(el('div', { class: 'empty' }, 'No coins found.'))
        return
      }
      // Group by asset then render each group
      const byAsset = new Map()
      for (const c of coins) {
        const key = c.asset_id || 'xch'
        if (!byAsset.has(key)) byAsset.set(key, [])
        byAsset.get(key).push(c)
      }
      for (const [assetKey, group] of byAsset.entries()) {
        renderAssetSection(assetKey, group)
      }
      if (totalCoins === 0) {
        assetContainer.appendChild(el('div', { class: 'empty' }, 'No coins found.'))
      }
    }
  }

  function buildSplitForm() {
    const wrapper = el('div')
    const row1 = el('div', { class: 'form-row' })
    const fg1 = el('div', { class: 'form-group' })
    fg1.appendChild(el('label', {}, 'Pair'))
    splitPairEl = el('input', { type: 'text', placeholder: 'e.g. CARBON22:xch' })
    fg1.appendChild(splitPairEl)
    row1.appendChild(fg1)
    const fg2 = el('div', { class: 'form-group' })
    fg2.appendChild(el('label', {}, 'Amount Per Coin'))
    splitAmtEl = el('input', { type: 'number', placeholder: 'e.g. 1000' })
    fg2.appendChild(splitAmtEl)
    row1.appendChild(fg2)
    wrapper.appendChild(row1)

    const row2 = el('div', { class: 'form-row' })
    const fg3 = el('div', { class: 'form-group' })
    fg3.appendChild(el('label', {}, 'Number of Coins'))
    splitNumEl = el('input', { type: 'number', placeholder: 'e.g. 10' })
    fg3.appendChild(splitNumEl)
    row2.appendChild(fg3)
    const fg4 = el('div', { class: 'form-group' })
    fg4.appendChild(el('label', {}, 'Coin ID (optional — pre-filled from table)'))
    splitCoinEl = el('input', { type: 'text', placeholder: 'leave blank for auto-select' })
    fg4.appendChild(splitCoinEl)
    row2.appendChild(fg4)
    wrapper.appendChild(row2)

    const { term, handleEvent } = createTerminal()
    const btn = el('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        btn.disabled = true
        term.style.display = ''
        await streamPost('/api/coin-split/stream', {
          pair: splitPairEl.value.trim(),
          coin_id: splitCoinEl.value.trim(),
          amount_per_coin: +splitAmtEl.value,
          number_of_coins: +splitNumEl.value,
        }, handleEvent)
        btn.disabled = false
      },
    }, '▶ Split')
    wrapper.appendChild(el('div', { class: 'btn-group mt-16' }, btn))
    term.style.display = 'none'
    wrapper.appendChild(el('div', { class: 'mt-16' }, term))
    return wrapper
  }

  function buildCombineForm() {
    const wrapper = el('div')
    const row1 = el('div', { class: 'form-row' })
    const fg1 = el('div', { class: 'form-group' })
    fg1.appendChild(el('label', {}, 'Pair'))
    combinePairEl = el('input', { type: 'text', placeholder: 'e.g. CARBON22:xch' })
    fg1.appendChild(combinePairEl)
    row1.appendChild(fg1)
    const fg2 = el('div', { class: 'form-group' })
    fg2.appendChild(el('label', {}, 'Input Coin Count'))
    combineCntEl = el('input', { type: 'number', value: '2', placeholder: 'e.g. 10' })
    fg2.appendChild(combineCntEl)
    row1.appendChild(fg2)
    wrapper.appendChild(row1)

    const fg3 = el('div', { class: 'form-group' })
    fg3.appendChild(el('label', {}, 'Asset ID (pre-filled from table, or xch / CAT hex)'))
    combineAssetEl = el('input', { type: 'text', placeholder: 'e.g. xch or CAT asset id' })
    fg3.appendChild(combineAssetEl)
    wrapper.appendChild(fg3)

    const { term, handleEvent } = createTerminal()
    const btn = el('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        btn.disabled = true
        term.style.display = ''
        await streamPost('/api/coin-combine/stream', {
          pair: combinePairEl.value.trim(),
          input_coin_count: +combineCntEl.value,
          asset_id: combineAssetEl.value.trim(),
        }, handleEvent)
        btn.disabled = false
      },
    }, '▶ Combine')
    wrapper.appendChild(el('div', { class: 'btn-group mt-16' }, btn))
    term.style.display = 'none'
    wrapper.appendChild(el('div', { class: 'mt-16' }, term))
    return wrapper
  }

  loadCoins()
}

// ── Coin pre-flight check for market enable ────────────────────────────────

// Returns an array of side-check results for the given market.
// Each result: { side, symbol, asset_id, precision, requiredMojos, requiredCount,
//                availableMojos, availableCount, ok, rungs }
async function checkMarketCoinRequirements(market) {
  const ladders = market.ladders || {}
  const pricing = market.pricing || {}
  const results = []

  // Fetch XCH price for USD→XCH conversion on buy side
  let xchUsd = 0
  try {
    const pr = await api('/api/prices')
    if (pr.ok) xchUsd = pr.xch_usd || 0
  } catch (_) {}

  // Fetch + filter spendable coins for one asset (null = XCH)
  async function fetchSpendable(assetId) {
    const qs = assetId ? `&asset_id=${encodeURIComponent(assetId)}` : ''
    const res = await api(`/api/sage-rpc/coins?limit=500${qs}`)
    if (!res.ok) return []
    return (res.coins || []).filter(
      c => c.spent_height == null && c.transaction_id == null && c.offer_id == null
    )
  }

  // ── Sell side: base asset coins ──────────────────────────────────────────
  const sellRungs = ladders.sell || []
  if (sellRungs.length) {
    const isXchBase = !market.base_asset || market.base_asset === 'xch'
    const assetId   = isXchBase ? null : market.base_asset
    const symbol    = market.base_symbol || (isXchBase ? 'XCH' : '?')
    const precision = isXchBase ? 12 : 3  // BYC precision=3 (from Sage)

    const requiredCount = sellRungs.reduce((s, r) => s + r.target_count + r.split_buffer_count, 0)
    const requiredMojos = sellRungs.reduce(
      (s, r) => s + (r.target_count + r.split_buffer_count) * r.size_base_units * Math.pow(10, precision), 0
    )

    const coins = await fetchSpendable(assetId)
    const availableMojos = coins.reduce((s, c) => s + Number(c.amount), 0)
    const availableCount = coins.length

    results.push({ side: 'Sell', symbol, asset_id: assetId, precision, requiredMojos, requiredCount,
                   availableMojos, availableCount, ok: availableMojos >= requiredMojos, rungs: sellRungs })
  }

  // ── Buy side: quote asset coins ──────────────────────────────────────────
  const buyRungs = ladders.buy || []
  if (buyRungs.length) {
    const isXchQuote = !market.quote_asset || market.quote_asset === 'xch'
    const assetId    = isXchQuote ? null : market.quote_asset
    const symbol     = isXchQuote ? 'XCH' : (market.quote_asset || 'XCH').toUpperCase()
    const precision  = isXchQuote ? 12 : 3

    const requiredCount = buyRungs.reduce((s, r) => s + r.target_count + r.split_buffer_count, 0)

    // Compute required quote mojos for buy side
    let requiredMojos = 0
    const buyUsdPer = pricing.buy_usd_per_base
    const fixedQuote = pricing.min_price_quote_per_base || pricing.buy_min_quote_per_base
    if (buyUsdPer > 0 && xchUsd > 0 && isXchQuote) {
      const xchPerBase = buyUsdPer / xchUsd
      requiredMojos = buyRungs.reduce(
        (s, r) => s + (r.target_count + r.split_buffer_count) * r.size_base_units * xchPerBase * 1e12, 0
      )
    } else if (fixedQuote > 0) {
      requiredMojos = buyRungs.reduce(
        (s, r) => s + (r.target_count + r.split_buffer_count) * r.size_base_units * fixedQuote * Math.pow(10, precision), 0
      )
    }
    requiredMojos = Math.ceil(requiredMojos)

    const coins = await fetchSpendable(assetId)
    const availableMojos = coins.reduce((s, c) => s + Number(c.amount), 0)
    const availableCount = coins.length

    results.push({ side: 'Buy', symbol, asset_id: assetId, precision, requiredMojos, requiredCount,
                   availableMojos, availableCount, ok: availableMojos >= requiredMojos, rungs: buyRungs })
  }

  return results
}

// Show a modal with the pre-flight coin check results. Calls onConfirm() if user
// clicks "Enable anyway" or if all checks pass automatically.
function showCoinPreflight(market, results, onConfirm, onCancel) {
  const overlay = el('div', {
    style: 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px'
  })

  const modal = el('div', {
    style: 'background:var(--surface);border:1px solid var(--border);border-radius:10px;width:100%;max-width:560px;padding:24px;box-shadow:0 16px 48px rgba(0,0,0,.5)'
  })

  const allOk = results.every(r => r.ok)

  modal.appendChild(el('div', { style: 'font-weight:700;font-size:16px;margin-bottom:6px' },
    allOk ? '✅ Coins look good' : '⚠️ Coin pre-flight for ' + (market.id || 'market')))
  modal.appendChild(el('div', { style: 'font-size:12px;color:var(--muted);margin-bottom:18px' },
    allOk
      ? 'All required coins are available. Enabling the market.'
      : 'Some coin denominations may need splitting before the daemon can post all offers. Review below.'))

  const fmt = (mojos, precision) => (mojos / Math.pow(10, precision)).toLocaleString(undefined, { maximumFractionDigits: precision <= 3 ? precision : 6 })

  for (const r of results) {
    const row = el('div', {
      style: `display:flex;align-items:flex-start;gap:12px;padding:12px;border-radius:8px;margin-bottom:10px;background:${r.ok ? 'rgba(56,189,132,.08)' : 'rgba(248,106,74,.08)'};border:1px solid ${r.ok ? 'rgba(56,189,132,.2)' : 'rgba(248,106,74,.25)'}`
    })

    // Status icon
    row.appendChild(el('span', { style: 'font-size:20px;flex-shrink:0;padding-top:2px' }, r.ok ? '✅' : '⚠️'))

    const info = el('div', { style: 'flex:1;min-width:0' })
    info.appendChild(el('div', { style: 'font-weight:600;font-size:13px;margin-bottom:4px' }, `${r.side} side — ${r.symbol}`))

    // Required vs available
    const stats = el('div', { style: 'font-size:12px;color:var(--muted);line-height:1.7' })
    stats.innerHTML = `
      <span>Required total: <b>${fmt(r.requiredMojos, r.precision)} ${r.symbol}</b> across <b>≥${r.requiredCount} coins</b></span><br>
      <span>Available: <b>${fmt(r.availableMojos, r.precision)} ${r.symbol}</b> in <b>${r.availableCount} spendable coin${r.availableCount !== 1 ? 's' : ''}</b></span>
    `.trim()
    info.appendChild(stats)

    if (!r.ok) {
      const gap = r.requiredMojos - r.availableMojos
      const gapStr = fmt(Math.max(0, gap), r.precision)
      const countGap = Math.max(0, r.requiredCount - r.availableCount)

      const hint = el('div', { style: 'margin-top:8px;font-size:12px' })
      if (gap > 0) {
        hint.appendChild(el('span', { style: 'color:var(--red)' }, `Short by ${gapStr} ${r.symbol} — acquire more before enabling.`))
        hint.appendChild(el('br'))
      }
      if (countGap > 0 && gap <= 0) {
        hint.appendChild(el('span', { style: 'color:var(--yellow,#e3a700)' }, `Have enough total but need ≥${r.requiredCount} individual coins — split the large coin.`))
        hint.appendChild(el('br'))
      } else if (r.availableMojos >= r.requiredMojos && r.availableCount < r.requiredCount) {
        hint.appendChild(el('span', { style: 'color:var(--yellow,#e3a700)' }, `Total is sufficient but too few coins — split to get ${r.requiredCount} pieces.`))
        hint.appendChild(el('br'))
      }

      if (r.availableMojos >= r.requiredMojos) {
        // Can fix with split — navigate to Coins page
        const suggestCount = r.requiredCount + 2  // a couple extra as buffer
        const splitBtn = el('button', {
          class: 'btn btn-primary',
          style: 'font-size:11px;padding:3px 10px;margin-top:6px',
          onclick: () => {
            overlay.remove()
            onCancel?.()
            navigate('coins')
          }
        }, `→ Go to Coins · Split ${r.symbol} into ${suggestCount} pieces`)
        hint.appendChild(splitBtn)
      }

      info.appendChild(hint)
    }

    row.appendChild(info)
    modal.appendChild(row)
  }

  // Ladder summary
  const summaryEl = el('div', { style: 'font-size:11px;color:var(--muted);margin-top:8px;margin-bottom:16px;line-height:1.6' })
  for (const r of results) {
    const rungText = r.rungs.map(r => `${r.target_count}×${r.size_base_units}`).join(' + ')
    summaryEl.appendChild(el('div', {}, `${r.side} ladder: ${rungText} ${r.symbol} (+${r.rungs.reduce((s,x) => s + x.split_buffer_count, 0)} buffer coins)`))
  }
  modal.appendChild(summaryEl)

  // Buttons
  const btnRow = el('div', { style: 'display:flex;gap:8px;justify-content:flex-end' })

  const cancelBtn = el('button', { class: 'btn btn-secondary', onclick: () => { overlay.remove(); onCancel?.() } }, 'Cancel')
  btnRow.appendChild(cancelBtn)

  const label = allOk ? '▶ Enable' : '▶ Enable Anyway'
  const confirmBtn = el('button', {
    class: 'btn btn-primary',
    onclick: () => { overlay.remove(); onConfirm() }
  }, label)
  btnRow.appendChild(confirmBtn)
  modal.appendChild(btnRow)

  overlay.appendChild(modal)
  // Close on backdrop click
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); onCancel?.() } })
  document.body.appendChild(overlay)

  if (allOk) {
    // Auto-confirm after a brief pause so the user sees the green state
    setTimeout(() => { if (document.body.contains(overlay)) { overlay.remove(); onConfirm() } }, 1200)
  }
}

// ── Markets Management ─────────────────────────────────────────────────────
pages.markets = async function (content) {
  content.innerHTML = ''
  const topbar = document.getElementById('topbar-actions')
  topbar.innerHTML = ''
  topbar.appendChild(
    el('button', { class: 'btn btn-secondary', onclick: () => pages.markets(content) }, '↻ Refresh')
  )

  // Save full updated markets array and reload the page
  async function saveMarkets(updated, successMsg) {
    const r = await api('/api/markets-write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markets: updated }),
    })
    if (r.ok) {
      showMktToast(successMsg || 'Saved')
      pages.markets(content)
    } else {
      showMktToast('Save failed: ' + (r.error || '?'), false)
    }
    return r.ok
  }

  let _mktToastTimer = null
  function showMktToast(msg, ok = true) {
    let toast = document.getElementById('mkt-toast')
    if (!toast) {
      toast = el('div', { id: 'mkt-toast' })
      Object.assign(toast.style, {
        position: 'fixed', bottom: '24px', right: '24px', padding: '10px 18px',
        borderRadius: '8px', fontWeight: '600', fontSize: '13px', zIndex: '9999',
        transition: 'opacity .3s',
      })
      document.body.appendChild(toast)
    }
    toast.textContent = msg
    toast.style.background = ok ? 'var(--accent)' : 'rgba(248,81,73,.9)'
    toast.style.color = '#fff'
    toast.style.opacity = '1'
    if (_mktToastTimer) clearTimeout(_mktToastTimer)
    _mktToastTimer = setTimeout(() => { toast.style.opacity = '0' }, 3000)
  }

  // Loading
  const listWrap = el('div')
  content.appendChild(listWrap)
  listWrap.innerHTML = '<div class="loading-row"><div class="spinner"></div> Loading markets…</div>'

  const res = await api('/api/markets-list')
  listWrap.innerHTML = ''

  if (!res.ok) {
    const errCard = el('div', { class: 'card' })
    errCard.appendChild(el('div', { class: 'card-title' }, 'Error loading markets'))
    errCard.appendChild(el('div', { class: 'terminal', style: 'color:var(--red)' }, res.error || 'Unknown error'))
    listWrap.appendChild(errCard)
    return
  }

  const markets = res.markets || []

  // ── Stats card ──────────────────────────────────────────────────────────
  const statsCard = el('div', { class: 'card' })
  const statsHdr = el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:14px' })
  statsHdr.appendChild(el('div', { class: 'card-title', style: 'margin:0' }, 'Markets'))
  const enabledCount = markets.filter(m => m.enabled).length
  statsHdr.appendChild(badge(`${enabledCount} enabled`, enabledCount > 0 ? 'green' : 'muted'))
  statsHdr.appendChild(badge(`${markets.length} total`, 'muted'))
  statsCard.appendChild(statsHdr)
  const statsGrid = el('div', { class: 'grid-3 mb-16' })
  for (const [l, v] of [['Total', markets.length], ['Enabled', enabledCount], ['Disabled', markets.length - enabledCount]]) {
    const s = el('div', { class: 'stat' })
    s.appendChild(el('div', { class: 'stat-label' }, l))
    const sv = el('div', { class: 'stat-value' }); sv.textContent = v
    s.appendChild(sv); statsGrid.appendChild(s)
  }
  statsCard.appendChild(statsGrid)
  listWrap.appendChild(statsCard)

  // ── Build inline market edit form ────────────────────────────────────────
  function buildMarketForm(mktData, onSave, onCancel) {
    const d = mktData || {}
    const pricing = d.pricing || {}
    const inventory = d.inventory || {}
    const ladders = d.ladders || {}
    const wrap = el('div', { style: 'background:var(--surface2);border-radius:8px;padding:16px;margin-top:12px' })

    // Row 1: id + mode
    const r1 = el('div', { class: 'form-row' })
    const fgId = el('div', { class: 'form-group' })
    fgId.appendChild(el('label', {}, 'Market ID'))
    const inpId = el('input', { type: 'text', value: d.id || '', placeholder: 'e.g. carbon22_sell_xch' })
    fgId.appendChild(inpId)
    r1.appendChild(fgId)
    const fgMode = el('div', { class: 'form-group' })
    fgMode.appendChild(el('label', {}, 'Mode'))
    const selMode = el('select')
    for (const [v, t] of [['sell_only', 'Sell Only'], ['buy_only', 'Buy Only'], ['two_sided', 'Two Sided']]) {
      const o = el('option', { value: v })
      o.textContent = t
      if (d.mode === v) o.selected = true
      selMode.appendChild(o)
    }
    fgMode.appendChild(selMode); r1.appendChild(fgMode)
    wrap.appendChild(r1)

    // Enabled checkbox
    const enRow = el('div', { class: 'checkbox-row form-group' })
    const uniqId = `mkt-en-${d.id || 'new'}-${Date.now()}`
    const chkEn = el('input', { type: 'checkbox', id: uniqId })
    chkEn.checked = d.enabled !== false
    enRow.appendChild(chkEn)
    enRow.appendChild(el('label', { for: uniqId }, 'Enabled'))
    wrap.appendChild(enRow)

    // Row 2: base_asset + base_symbol
    const r2 = el('div', { class: 'form-row' })
    const fgBa = el('div', { class: 'form-group' })
    fgBa.appendChild(el('label', {}, 'Base Asset (hex or xch)'))
    const inpBa = el('input', { type: 'text', value: d.base_asset || '', placeholder: 'e.g. 4a168910…' })
    fgBa.appendChild(inpBa); r2.appendChild(fgBa)
    const fgBs = el('div', { class: 'form-group' })
    fgBs.appendChild(el('label', {}, 'Base Symbol'))
    const inpBs = el('input', { type: 'text', value: d.base_symbol || '', placeholder: 'e.g. CARBON22' })
    fgBs.appendChild(inpBs); r2.appendChild(fgBs)
    wrap.appendChild(r2)

    // Row 3: quote_asset + quote_asset_type
    const r3 = el('div', { class: 'form-row' })
    const fgQa = el('div', { class: 'form-group' })
    fgQa.appendChild(el('label', {}, 'Quote Asset'))
    const inpQa = el('input', { type: 'text', value: d.quote_asset || '', placeholder: 'xch or wUSDC.b' })
    fgQa.appendChild(inpQa); r3.appendChild(fgQa)
    const fgQt = el('div', { class: 'form-group' })
    fgQt.appendChild(el('label', {}, 'Quote Asset Type'))
    const selQt = el('select')
    for (const [v, t] of [['unstable', 'Unstable (XCH)'], ['stable', 'Stable (USD)']]) {
      const o = el('option', { value: v }); o.textContent = t
      if (d.quote_asset_type === v) o.selected = true
      selQt.appendChild(o)
    }
    fgQt.appendChild(selQt); r3.appendChild(fgQt)
    wrap.appendChild(r3)

    // Row 4: signer_key_id + receive_address
    const r4 = el('div', { class: 'form-row' })
    const fgKi = el('div', { class: 'form-group' })
    fgKi.appendChild(el('label', {}, 'Signer Key ID'))
    const inpKi = el('input', { type: 'text', value: d.signer_key_id || '', placeholder: 'e.g. key-main-1' })
    fgKi.appendChild(inpKi); r4.appendChild(fgKi)
    const fgRa = el('div', { class: 'form-group' })
    fgRa.appendChild(el('label', {}, 'Receive Address'))
    const inpRa = el('input', { type: 'text', value: d.receive_address || '', placeholder: 'xch1…' })
    fgRa.appendChild(inpRa); r4.appendChild(fgRa)
    wrap.appendChild(r4)

    // Pricing JSON
    const pricingDet = el('details', { style: 'margin-top:12px' })
    pricingDet.appendChild(el('summary', { style: 'cursor:pointer;font-weight:600;font-size:12px;color:var(--muted);padding:4px 0' }, '⚙ Pricing (JSON)'))
    const taPricing = el('textarea', { rows: '8', style: 'font-family:var(--font-mono);font-size:12px;width:100%;box-sizing:border-box;margin-top:8px' })
    taPricing.value = JSON.stringify(pricing, null, 2)
    pricingDet.appendChild(taPricing)
    wrap.appendChild(pricingDet)

    // Inventory JSON
    const invDet = el('details', { style: 'margin-top:6px' })
    invDet.appendChild(el('summary', { style: 'cursor:pointer;font-weight:600;font-size:12px;color:var(--muted);padding:4px 0' }, '📦 Inventory (JSON)'))
    const taInv = el('textarea', { rows: '6', style: 'font-family:var(--font-mono);font-size:12px;width:100%;box-sizing:border-box;margin-top:8px' })
    taInv.value = JSON.stringify(inventory, null, 2)
    invDet.appendChild(taInv); wrap.appendChild(invDet)

    // Ladders JSON
    const ladDet = el('details', { style: 'margin-top:6px' })
    ladDet.appendChild(el('summary', { style: 'cursor:pointer;font-weight:600;font-size:12px;color:var(--muted);padding:4px 0' }, '🪜 Ladders (JSON)'))
    const taLad = el('textarea', { rows: '10', style: 'font-family:var(--font-mono);font-size:12px;width:100%;box-sizing:border-box;margin-top:8px' })
    taLad.value = JSON.stringify(ladders, null, 2)
    ladDet.appendChild(taLad); wrap.appendChild(ladDet)

    // Action buttons
    const btnGroup = el('div', { class: 'btn-group mt-16' })
    const saveBtn = el('button', { class: 'btn btn-primary', onclick: () => {
      let parsedPricing, parsedInv, parsedLad
      try { parsedPricing = JSON.parse(taPricing.value || '{}') } catch (e) { showMktToast('Pricing JSON invalid: ' + e.message, false); return }
      try { parsedInv = JSON.parse(taInv.value || '{}') } catch (e) { showMktToast('Inventory JSON invalid: ' + e.message, false); return }
      try { parsedLad = JSON.parse(taLad.value || '{}') } catch (e) { showMktToast('Ladders JSON invalid: ' + e.message, false); return }
      onSave({
        id: inpId.value.trim(), enabled: chkEn.checked, mode: selMode.value,
        base_asset: inpBa.value.trim(), base_symbol: inpBs.value.trim(),
        quote_asset: inpQa.value.trim(), quote_asset_type: selQt.value,
        signer_key_id: inpKi.value.trim(), receive_address: inpRa.value.trim(),
        pricing: parsedPricing, inventory: parsedInv, ladders: parsedLad,
      })
    }}, 'Save')
    btnGroup.appendChild(saveBtn)
    if (onCancel) btnGroup.appendChild(el('button', { class: 'btn btn-secondary', onclick: onCancel }, 'Cancel'))
    wrap.appendChild(btnGroup)
    return wrap
  }

  // ── Market list cards ────────────────────────────────────────────────────
  if (!markets.length) {
    listWrap.appendChild(el('div', { class: 'card' }, el('div', { class: 'empty' }, 'No markets configured. Add one below.')))
  } else {
    for (let i = 0; i < markets.length; i++) {
      const m = markets[i]
      const card = el('div', {
        class: 'card',
        style: `border-color:${m.enabled ? 'rgba(56,189,132,.3)' : 'rgba(99,102,241,.2)'};margin-bottom:12px`
      })

      // Header
      const hdr = el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' })
      hdr.appendChild(el('span', { style: 'font-weight:700;font-size:14px' }, m.id || `market-${i}`))
      hdr.appendChild(badge(m.mode || '?', m.mode === 'sell_only' ? 'blue' : m.mode === 'two_sided' ? 'green' : 'muted'))
      hdr.appendChild(badge(m.enabled ? 'enabled' : 'disabled', m.enabled ? 'green' : 'muted'))

      const btns = el('div', { style: 'margin-left:auto;display:flex;gap:6px;flex-wrap:wrap' })

      // Toggle Enable/Disable
      const toggleBtn = el('button', {
        class: m.enabled ? 'btn btn-secondary' : 'btn btn-primary',
        style: 'font-size:12px;padding:4px 12px',
        onclick: async () => {
          toggleBtn.disabled = true

          // Disabling: no pre-flight needed
          if (m.enabled) {
            const updated = markets.map((x, j) => j === i ? { ...x, enabled: false } : x)
            await saveMarkets(updated, `Market "${m.id}" disabled`)
            return
          }

          // Enabling: run coin pre-flight check first
          toggleBtn.textContent = '⏳ Checking…'
          let requirements = []
          try {
            requirements = await checkMarketCoinRequirements(m)
          } catch (_) {
            // Sage may not be available — skip check and enable directly
            requirements = []
          }
          toggleBtn.disabled = false
          toggleBtn.textContent = '▶ Enable'

          const doEnable = async () => {
            toggleBtn.disabled = true
            const updated = markets.map((x, j) => j === i ? { ...x, enabled: true } : x)
            await saveMarkets(updated, `Market "${m.id}" enabled`)
          }

          if (!requirements.length) {
            // No Sage / no ladders — enable directly
            await doEnable()
          } else {
            showCoinPreflight(m, requirements, doEnable, () => { toggleBtn.disabled = false })
          }
        }
      }, m.enabled ? '⏸ Disable' : '▶ Enable')
      btns.appendChild(toggleBtn)

      // Build Offer (for this specific market)
      const buildOfferBtn = el('button', {
        class: 'btn btn-secondary',
        style: 'font-size:12px;padding:4px 12px',
        onclick: () => { _pendingBuildMarket = m; navigate('build') },
      }, '▸ Build Offer')
      btns.appendChild(buildOfferBtn)

      // Edit
      const editBtn = el('button', { class: 'btn btn-secondary', style: 'font-size:12px;padding:4px 12px' }, '✏ Edit')
      btns.appendChild(editBtn)

      // Delete
      const delBtn = el('button', { class: 'btn btn-danger', style: 'font-size:12px;padding:4px 12px' }, '✕ Delete')
      btns.appendChild(delBtn)

      hdr.appendChild(btns)
      card.appendChild(hdr)

      // Sub-info
      const info = el('div', { style: 'font-size:12px;color:var(--muted);margin-top:6px' })
      const pricing = m.pricing || {}
      const pricingDesc = pricing.reference_source
        ? (pricing.buy_usd_per_base != null
            ? `buy ≤$${pricing.buy_usd_per_base} / sell ≥$${pricing.sell_usd_per_base}`
            : pricing.strategy_target_spread_bps != null
              ? `${pricing.reference_source} · ${pricing.strategy_target_spread_bps}bps spread`
              : `${pricing.reference_source}`)
        : pricing.fixed_quote_per_base != null ? `fixed ${pricing.fixed_quote_per_base}` : '—'
      info.textContent = `Pair: ${m.base_symbol || m.base_asset?.slice(0,8) || '?'}:${m.quote_asset || '?'} · Pricing: ${pricingDesc} · Key: ${m.signer_key_id || '—'}`
      card.appendChild(info)

      // Edit form (toggled inline)
      let editFormEl = null
      editBtn.addEventListener('click', () => {
        if (editFormEl) {
          editFormEl.remove(); editFormEl = null
          editBtn.textContent = '✏ Edit'
          return
        }
        editBtn.textContent = '✕ Close'
        editFormEl = buildMarketForm(m,
          async (updated) => {
            if (!updated.id) { showMktToast('Market ID is required', false); return }
            const updatedList = markets.map((x, j) => j === i ? updated : x)
            await saveMarkets(updatedList, `Market "${updated.id}" saved`)
          },
          () => { editFormEl?.remove(); editFormEl = null; editBtn.textContent = '✏ Edit' }
        )
        card.appendChild(editFormEl)
      })

      delBtn.addEventListener('click', async () => {
        if (!confirm(`Delete market "${m.id}"? This cannot be undone.`)) return
        delBtn.disabled = true
        await saveMarkets(markets.filter((_, j) => j !== i), `Market "${m.id}" deleted`)
      })

      listWrap.appendChild(card)
    }
  }

  // ── Add New Market ────────────────────────────────────────────────────────
  const newCard = el('div', { class: 'card', style: 'border-color:rgba(139,148,158,.25)' })
  newCard.appendChild(el('div', { class: 'card-title' }, 'Add New Market'))
  const newDet = el('details')
  newDet.appendChild(el('summary', {
    style: 'cursor:pointer;font-size:13px;color:var(--muted);padding:6px 0'
  }, '+ Click to expand and fill in market details…'))

  const defaultMkt = {
    id: '', enabled: true, mode: 'sell_only',
    base_asset: '', base_symbol: '', quote_asset: 'xch', quote_asset_type: 'unstable',
    signer_key_id: 'key-main-1', receive_address: '',
    pricing: {
      reference_source: 'coingecko', reference_pair: 'xch_usd', side: 'sell',
      min_price_quote_per_base: 0.001, max_price_quote_per_base: 0.01,
      slippage_bps: 100, strategy_target_spread_bps: 140,
      cancel_policy_stable_vs_unstable: false,
    },
    inventory: {
      low_watermark_base_units: 100, low_inventory_alert_threshold_base_units: null,
      current_available_base_units: 0, bucket_counts: { '1': 0, '10': 0 },
    },
    ladders: {
      sell: [{ size_base_units: 1, target_count: 5, split_buffer_count: 1, combine_when_excess_factor: 2.0 }],
    },
  }

  newDet.appendChild(buildMarketForm(defaultMkt,
    async (newMkt) => {
      if (!newMkt.id) { showMktToast('Market ID is required', false); return }
      if (markets.some(m => m.id === newMkt.id)) { showMktToast(`ID "${newMkt.id}" already exists`, false); return }
      await saveMarkets([...markets, newMkt], `Market "${newMkt.id}" created`)
    },
    null
  ))

  newCard.appendChild(newDet)
  listWrap.appendChild(newCard)
}

// ── Build Offer ─────────────────────────────────────────────────────────────
pages.build = async function (content) {
  content.innerHTML = ''
  document.getElementById('topbar-actions').innerHTML = ''

  // Consume market context set by ▸ Build Offer buttons on market cards / dashboard.
  const activeMkt = _pendingBuildMarket
  _pendingBuildMarket = null

  const card = el('div', { class: 'card' })
  card.appendChild(el('div', { class: 'card-title' }, 'Build & Post Offer'))

  // Show which market we're building for, if one was passed.
  if (activeMkt) {
    card.appendChild(el('div', {
      style: 'font-size:12px;color:var(--muted);margin-bottom:14px;padding:8px 12px;background:rgba(99,102,241,.08);border-radius:6px;border:1px solid rgba(99,102,241,.2)'
    }, `Market: ${activeMkt.id} · ${activeMkt.base_symbol || '?'}:${activeMkt.quote_asset || '?'} · ${activeMkt.enabled ? '✅ enabled' :'⏸ disabled'}`))
  }

  const row1 = el('div', { class: 'form-row' })
  const fg1 = el('div', { class: 'form-group' })
  fg1.appendChild(el('label', {}, 'Pair'))
  const defaultPair = activeMkt
    ? `${activeMkt.base_symbol}:${activeMkt.quote_asset}`
    : 'CARBON22:xch'
  const inpPair = el('input', { type: 'text', placeholder: 'e.g. CARBON22:xch', value: defaultPair })
  fg1.appendChild(inpPair)
  row1.appendChild(fg1)
  const fg2 = el('div', { class: 'form-group' })
  fg2.appendChild(el('label', {}, 'Size (base units)'))
  const defaultSize = activeMkt?.ladders?.sell?.[0]?.size_base_units ?? 1
  const inpSize = el('input', { type: 'number', value: String(defaultSize), min: '1' })
  fg2.appendChild(inpSize)
  row1.appendChild(fg2)
  card.appendChild(row1)

  const row2 = el('div', { class: 'form-row' })
  const fg3 = el('div', { class: 'form-group' })
  fg3.appendChild(el('label', {}, 'Network'))
  const selNet = el('select')
  ;['mainnet', 'testnet11'].forEach((n) => {
    const o = el('option', { value: n })
    o.textContent = n
    selNet.appendChild(o)
  })
  fg3.appendChild(selNet)
  row2.appendChild(fg3)
  const fg4 = el('div', { class: 'form-group' })
  fg4.appendChild(el('label', {}, 'Venue'))
  const selVenue = el('select')
  ;[['', '(default)'], ['dexie', 'Dexie'], ['splash', 'Splash']].forEach(([v, t]) => {
    const o = el('option', { value: v })
    o.textContent = t
    selVenue.appendChild(o)
  })
  fg4.appendChild(selVenue)
  row2.appendChild(fg4)
  card.appendChild(row2)

  const chkRow = el('div', { class: 'checkbox-row mb-16' })
  const chkDry = el('input', { type: 'checkbox', id: 'dry-run-chk' })
  chkDry.checked = true
  chkRow.appendChild(chkDry)
  chkRow.appendChild(el('label', { for: 'dry-run-chk' }, 'Dry run (no actual posting)'))
  card.appendChild(chkRow)

  // Contextual hint: explain daemon vs manual offer building.
  if (activeMkt?.enabled) {
    card.appendChild(el('div', { class: 'form-hint mb-16', style: 'border-color:rgba(56,189,132,.3);background:rgba(56,189,132,.06)' },
      '✅ This market is enabled — the daemon will manage and repost offers automatically on each cycle. ' +
      'Use this form to prime the ladder immediately or post a test offer without waiting for the next daemon cycle.'))
  } else {
    card.appendChild(el('div', { class: 'form-hint mb-16' },
      '⚠ Uncheck dry run only when you have keys onboarded and a funded vault. ' +
      'Once a market is enabled, the daemon manages offers automatically — you only need this for manual or test posts.'))
  }

  const { term, handleEvent } = createTerminal()
  const btn = el('button', {
    class: 'btn btn-secondary',
    onclick: async () => {
      btn.disabled = true
      term.style.display = ''
      const isDry = chkDry.checked

      // Auto-split: only when posting for real AND we have market context.
      if (!isDry && activeMkt) {
        let reqs = []
        try { reqs = await checkMarketCoinRequirements(activeMkt) } catch (_) {}
        // Find a side that has enough total but not enough individual coins.
        const needSplit = reqs.find(
          r => !r.ok && r.availableMojos >= r.requiredMojos && r.availableCount < r.requiredCount
        )
        if (needSplit) {
          const rungs = needSplit.rungs || []
          const smallest = rungs.length
            ? rungs.reduce((a, b) => a.size_base_units <= b.size_base_units ? a : b)
            : { size_base_units: 1 }
          const amtPerCoin = smallest.size_base_units
          const numCoins = needSplit.requiredCount
          const pair = inpPair.value.trim()
          handleEvent('text_line',
            `⚙ Auto-split: need ${numCoins} coins of size ${amtPerCoin} ${needSplit.symbol} ` +
            `(have ${needSplit.availableCount}, need ${needSplit.requiredCount}). Splitting now…`)
          await streamPost('/api/coin-split/stream', {
            pair,
            amount_per_coin: amtPerCoin,
            number_of_coins: numCoins,
            network: selNet.value,
            no_wait: true,
          }, handleEvent)
          handleEvent('text_line', '⚙ Split complete. Proceeding to offer build…')
        }
      }

      await streamPost('/api/build-offer/stream', {
        pair: inpPair.value.trim(),
        size_base_units: +inpSize.value,
        network: selNet.value,
        venue: selVenue.value,
        dry_run: isDry,
      }, handleEvent)
      btn.disabled = false
    },
  }, '▶ Build Offer (dry run)')

  chkDry.addEventListener('change', () => {
    btn.textContent = chkDry.checked ? '▶ Build Offer (dry run)' : '▶ Build & Post Offer'
    btn.className = chkDry.checked ? 'btn btn-secondary' : 'btn btn-danger'
  })

  card.appendChild(el('div', { class: 'btn-group' }, btn))
  term.style.display = 'none'
  card.appendChild(el('div', { class: 'mt-16' }, term))
  content.appendChild(card)
}

// ── Config ──────────────────────────────────────────────────────────────────
pages.config = async function (content) {
  content.innerHTML = ''
  const topbar = document.getElementById('topbar-actions')
  topbar.innerHTML = ''
  const btnRefresh = el('button', { class: 'btn btn-secondary', onclick: () => pages.config(content) }, '↻ Refresh')
  const btnValidate = el('button', { class: 'btn btn-primary', onclick: () => loadValidate() }, '✓ Validate Config')
  topbar.appendChild(el('div', { class: 'btn-group' }, btnRefresh, btnValidate))

  const pathsCard = el('div', { class: 'card' })
  pathsCard.appendChild(el('div', { class: 'card-title' }, 'Config Paths & Environment'))
  pathsCard.appendChild(el('div', { class: 'loading-row' }, el('div', { class: 'spinner' }), ' Loading…'))
  content.appendChild(pathsCard)

  const validateCard = el('div', { class: 'card' })
  validateCard.style.display = 'none'
  content.appendChild(validateCard)

  const res = await api('/api/config-paths')
  pathsCard.innerHTML = '<div class="card-title">Config Paths & Environment</div>'
  const list = el('div', { class: 'check-list' })
  for (const [k, v] of Object.entries(res)) {
    const item = el('div', { class: 'check-item' })
    item.appendChild(el('span', { class: 'ci-icon' }, '📄'))
    const info = el('div')
    info.appendChild(el('div', { class: 'ci-key' }, k.replace(/_/g, ' ')))
    info.appendChild(el('div', { class: 'ci-val' }, String(v)))
    item.appendChild(info)
    list.appendChild(item)
  }
  pathsCard.appendChild(list)

  async function loadValidate() {
    validateCard.style.display = ''
    validateCard.innerHTML =
      '<div class="card-title">Config Validation</div><div class="loading-row"><div class="spinner"></div> Validating…</div>'
    const r = await api('/api/config-validate')
    validateCard.innerHTML = '<div class="card-title">Config Validation</div>'
    const hdr = el('div', { class: 'section-header mb-16' })
    hdr.appendChild(statusBadge(r.ok))
    validateCard.appendChild(hdr)
    if (r.parsed) {
      const pre = el('div', { class: 'terminal' })
      pre.appendChild(renderJson(r.parsed))
      validateCard.appendChild(pre)
    } else {
      const t = el('div', { class: 'terminal' })
      t.textContent = r.raw || r.error || ''
      validateCard.appendChild(t)
    }
  }
}

// ── Settings ───────────────────────────────────────────────────────────────
pages.settings = async function (content) {
  content.innerHTML = ''
  const topbar = document.getElementById('topbar-actions')
  topbar.innerHTML = ''
  topbar.appendChild(
    el('button', { class: 'btn btn-secondary', onclick: () => pages.settings(content) }, '↻ Refresh')
  )

  content.appendChild(el('div', { class: 'loading-row' }, el('div', { class: 'spinner' }), ' Loading config…'))
  const res = await api('/api/config-read')
  content.innerHTML = ''

  if (!res.ok) {
    const err = el('div', { class: 'card' })
    err.appendChild(el('div', { class: 'card-title' }, 'Error reading config'))
    const t = el('div', { class: 'terminal' })
    t.style.color = 'var(--red)'
    t.textContent = res.error || 'Unknown error'
    err.appendChild(t)
    content.appendChild(err)
    return
  }

  const cfg = res.config || {}
  const pathHint = el('div', { class: 'text-muted mb-16' })
  pathHint.textContent = `Editing: ${res.path}`
  content.appendChild(pathHint)

  // Toast helper
  let toastTimer = null
  function showToast(msg, ok = true) {
    let toast = document.getElementById('settings-toast')
    if (!toast) {
      toast = el('div', { id: 'settings-toast' })
      Object.assign(toast.style, {
        position: 'fixed', bottom: '24px', right: '24px', padding: '10px 18px',
        borderRadius: '8px', fontWeight: '600', fontSize: '13px', zIndex: '9999',
        transition: 'opacity .3s',
      })
      document.body.appendChild(toast)
    }
    toast.textContent = msg
    toast.style.background = ok ? 'var(--accent)' : 'rgba(248,81,73,.9)'
    toast.style.color = '#fff'
    toast.style.opacity = '1'
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toast.style.opacity = '0' }, 3000)
  }

  async function savePatches(patches) {
    const r = await api('/api/config-write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patches }),
    })
    if (r.ok) showToast('Saved successfully')
    else showToast('Save failed: ' + (r.error || '?'), false)
    return r.ok
  }

  function section(title, borderColor) {
    const c = el('div', { class: 'card' })
    if (borderColor) c.style.borderColor = borderColor
    c.appendChild(el('div', { class: 'card-title' }, title))
    return c
  }

  function inputRow(label, value, hint) {
    const fg = el('div', { class: 'form-group' })
    fg.appendChild(el('label', {}, label))
    const inp = el('input', { type: 'text', value: value || '' })
    fg.appendChild(inp)
    if (hint) fg.appendChild(el('div', { class: 'form-hint' }, hint))
    return { fg, inp }
  }

  // ── App Settings ─────────────────────────────────────────────────────────
  const appCard = section('App Settings')
  const appCfg = cfg.app || {}
  const row1 = el('div', { class: 'form-row' })
  const { fg: fgNet, inp: inpNet } = inputRow('Network', appCfg.network, 'mainnet or testnet11')
  const { fg: fgLog, inp: inpLog } = inputRow('Log Level', appCfg.log_level || 'INFO', 'DEBUG / INFO / WARNING / ERROR')
  row1.appendChild(fgNet)
  row1.appendChild(fgLog)
  appCard.appendChild(row1)

  const dryRow = el('div', { class: 'checkbox-row form-group' })
  const chkDry = el('input', { type: 'checkbox', id: 'cfg-dry-run' })
  chkDry.checked = !!(cfg.runtime || {}).dry_run
  dryRow.appendChild(chkDry)
  dryRow.appendChild(el('label', { for: 'cfg-dry-run' }, 'Dry run mode (no actual transactions)'))
  appCard.appendChild(dryRow)

  const btnSaveApp = el('button', { class: 'btn btn-primary', onclick: async () => {
    btnSaveApp.disabled = true
    await savePatches({
      'app.network': inpNet.value.trim(),
      'app.log_level': inpLog.value.trim(),
      'runtime.dry_run': chkDry.checked,
    })
    btnSaveApp.disabled = false
  }}, 'Save App Settings')
  appCard.appendChild(el('div', { class: 'btn-group mt-16' }, btnSaveApp))
  content.appendChild(appCard)

  // ── Cloud Wallet ──────────────────────────────────────────────────────────
  const cwCard = section('Cloud Wallet', 'rgba(88,166,255,.3)')
  cwCard.appendChild(el('p', { class: 'text-muted mb-16' },
    'Required for vault coin operations (coins-list, coin-split, coin-combine).'))
  const cw = cfg.cloud_wallet || {}

  const cwRows = [
    ['base_url',             'API Base URL',         cw.base_url,             'From vault.chia.net/settings.json → GRAPHQL_URI (origin only, e.g. https://api.vault.chia.net)'],
    ['user_key_id',          'User Key ID',          cw.user_key_id,          'Settings → API Keys → Key Id'],
    ['private_key_pem_path', 'Private Key PEM Path', cw.private_key_pem_path, 'Path to downloaded .pem file (e.g. ~/.greenfloor/keys/cloud-wallet-user-auth-key.pem)'],
    ['vault_id',             'Vault ID',             cw.vault_id,             'From vault URL: .../wallet/<ID>/... — use the Wallet_... value'],
  ]
  const cwInputs = {}
  for (const [key, label, value, hint] of cwRows) {
    const { fg, inp } = inputRow(label, value, hint)
    cwInputs[key] = inp
    cwCard.appendChild(fg)
  }
  const btnSaveCw = el('button', { class: 'btn btn-primary', onclick: async () => {
    btnSaveCw.disabled = true
    const patches = {}
    for (const [key, , ,] of cwRows) patches[`cloud_wallet.${key}`] = cwInputs[key].value.trim()
    await savePatches(patches)
    btnSaveCw.disabled = false
  }}, 'Save Cloud Wallet')
  cwCard.appendChild(el('div', { class: 'btn-group mt-16' }, btnSaveCw))
  content.appendChild(cwCard)

  // ── Signer Keys ───────────────────────────────────────────────────────────
  const keysCard = section('Signer Key Registry', 'rgba(188,140,255,.3)')
  keysCard.appendChild(el('p', { class: 'text-muted mb-16' },
    'Keys used to sign offers. key_id must match signer_key_id in markets config.'))

  const registry = (cfg.keys || {}).registry || []
  const keyRows = [] // [{inputs}]

  const keysList = el('div', { id: 'keys-list' })
  keysCard.appendChild(keysList)

  function renderKeysList() {
    keysList.innerHTML = ''
    keyRows.length = 0
    for (let i = 0; i < registry.length; i++) {
      const k = registry[i]
      const rowEl = el('div', { style: 'background:var(--surface2);border-radius:6px;padding:14px;margin-bottom:12px;' })
      const r1 = el('div', { class: 'form-row' })
      const { fg: fgId, inp: inpId } = inputRow('Key ID', k.key_id, '')
      const { fg: fgFp, inp: inpFp } = inputRow('Fingerprint', String(k.fingerprint || ''), 'Integer fingerprint of the Chia key')
      r1.appendChild(fgId); r1.appendChild(fgFp)
      rowEl.appendChild(r1)
      const r2 = el('div', { class: 'form-row' })
      const { fg: fgNw, inp: inpNw } = inputRow('Network', k.network || '', 'mainnet or testnet11')
      const { fg: fgKp, inp: inpKp } = inputRow('Keyring YAML Path', k.keyring_yaml_path || '', 'e.g. ~/.chia_keys/keyring.yaml')
      r2.appendChild(fgNw); r2.appendChild(fgKp)
      rowEl.appendChild(r2)
      const delBtn = el('button', { class: 'btn btn-danger', onclick: () => {
        registry.splice(i, 1)
        renderKeysList()
      }}, '✕ Remove')
      rowEl.appendChild(el('div', { class: 'btn-group mt-16' }, delBtn))
      keysList.appendChild(rowEl)
      keyRows.push({ inpId, inpFp, inpNw, inpKp })
    }
  }
  renderKeysList()

  const btnAddKey = el('button', { class: 'btn btn-secondary', onclick: () => {
    registry.push({ key_id: '', fingerprint: 0, network: 'mainnet', keyring_yaml_path: '' })
    renderKeysList()
  }}, '+ Add Key')

  const btnSaveKeys = el('button', { class: 'btn btn-primary', onclick: async () => {
    btnSaveKeys.disabled = true
    const updatedRegistry = keyRows.map(({ inpId, inpFp, inpNw, inpKp }) => ({
      key_id: inpId.value.trim(),
      fingerprint: parseInt(inpFp.value.trim(), 10) || 0,
      network: inpNw.value.trim() || null,
      keyring_yaml_path: inpKp.value.trim() || null,
    }))
    await savePatches({ 'keys.registry': updatedRegistry })
    btnSaveKeys.disabled = false
  }}, 'Save Keys')

  keysCard.appendChild(el('div', { class: 'btn-group mt-16' }, btnAddKey, btnSaveKeys))
  content.appendChild(keysCard)

  // ── Pushover Notifications ────────────────────────────────────────────────
  const notifCard = section('Pushover Notifications')
  notifCard.appendChild(el('p', { class: 'text-muted mb-16' },
    'Values are environment variable names (not the actual secrets). Set the actual values in your shell environment.'))
  const providers = ((cfg.notifications || {}).providers || [])
  const pushover = providers.find(p => p.type === 'pushover') || {}

  const pvRow = el('div', { class: 'checkbox-row form-group' })
  const chkPv = el('input', { type: 'checkbox', id: 'cfg-pv-enabled' })
  chkPv.checked = !!pushover.enabled
  pvRow.appendChild(chkPv)
  pvRow.appendChild(el('label', { for: 'cfg-pv-enabled' }, 'Enable Pushover alerts'))
  notifCard.appendChild(pvRow)

  const pvFields = [
    ['user_key_env',     'User Key Env Var',     pushover.user_key_env     || 'PUSHOVER_USER_KEY',      'Name of env var holding your Pushover user key'],
    ['app_token_env',    'App Token Env Var',    pushover.app_token_env    || 'PUSHOVER_APP_TOKEN',     'Name of env var holding your Pushover app token'],
    ['recipient_key_env','Recipient Key Env Var',pushover.recipient_key_env|| 'PUSHOVER_RECIPIENT_KEY', 'Optional recipient override env var'],
  ]
  const pvInputs = {}
  for (const [key, label, value, hint] of pvFields) {
    const { fg, inp } = inputRow(label, value, hint)
    pvInputs[key] = inp
    notifCard.appendChild(fg)
  }

  const btnSavePv = el('button', { class: 'btn btn-primary', onclick: async () => {
    btnSavePv.disabled = true
    // Find pushover index in providers array
    const pvIdx = providers.findIndex(p => p.type === 'pushover')
    const base = pvIdx >= 0 ? `notifications.providers.${pvIdx}` : 'notifications.providers.0'
    const patches = { [`${base}.enabled`]: chkPv.checked }
    for (const [key] of pvFields) patches[`${base}.${key}`] = pvInputs[key].value.trim()
    await savePatches(patches)
    btnSavePv.disabled = false
  }}, 'Save Notifications')
  notifCard.appendChild(el('div', { class: 'btn-group mt-16' }, btnSavePv))
  content.appendChild(notifCard)

  // ── Sage Wallet RPC ───────────────────────────────────────────────────────
  const sageCard = section('Sage Wallet RPC', 'rgba(56,189,132,.3)')
  sageCard.appendChild(el('p', { class: 'text-muted mb-16' },
    'Connect GreenFloor to your local Sage wallet via its RPC server. ' +
    'Enable the RPC server in Sage Settings → RPC, then configure here. ' +
    'The Python backend proxies all calls through mTLS using the local cert pair.'))

  const sageCfg = cfg.sage_rpc || {}

  // Enable toggle
  const sageEnRow = el('div', { class: 'checkbox-row form-group' })
  const chkSage = el('input', { type: 'checkbox', id: 'cfg-sage-enabled' })
  chkSage.checked = !!sageCfg.enabled
  sageEnRow.appendChild(chkSage)
  sageEnRow.appendChild(el('label', { for: 'cfg-sage-enabled' }, 'Enable Sage wallet RPC integration'))
  sageCard.appendChild(sageEnRow)

  // Port + override paths
  const sageRow1 = el('div', { class: 'form-row' })
  const { fg: fgSagePort, inp: inpSagePort } = inputRow('RPC Port', String(sageCfg.port || 9257), 'Default: 9257 — set in Sage Settings → RPC')
  sageRow1.appendChild(fgSagePort)
  sageCard.appendChild(sageRow1)

  const { fg: fgSageCert, inp: inpSageCert } = inputRow('Cert Path Override', sageCfg.cert_path || '',
    'Leave blank to auto-detect: %APPDATA%\\com.rigidnetwork.sage\\ssl\\wallet.crt (Windows)')
  const { fg: fgSageKey, inp: inpSageKey } = inputRow('Key Path Override', sageCfg.key_path || '',
    'Leave blank to auto-detect: %APPDATA%\\com.rigidnetwork.sage\\ssl\\wallet.key (Windows)')
  sageCard.appendChild(fgSageCert)
  sageCard.appendChild(fgSageKey)

  // Save button
  const btnSaveSage = el('button', { class: 'btn btn-primary', onclick: async () => {
    btnSaveSage.disabled = true
    await savePatches({
      'sage_rpc.enabled': chkSage.checked,
      'sage_rpc.port': parseInt(inpSagePort.value.trim(), 10) || 9257,
      'sage_rpc.cert_path': inpSageCert.value.trim(),
      'sage_rpc.key_path': inpSageKey.value.trim(),
    })
    btnSaveSage.disabled = false
  }}, 'Save Sage RPC Settings')

  // Connection status area
  const sageStatusBox = el('div', { style: 'margin-top:16px' })
  const btnTestSage = el('button', { class: 'btn btn-secondary', onclick: testSageConnection }, 'Test Connection')
  sageCard.appendChild(el('div', { class: 'btn-group mt-16' }, btnSaveSage, btnTestSage))
  sageCard.appendChild(sageStatusBox)

  async function testSageConnection() {
    sageStatusBox.innerHTML = ''
    const spinner = el('div', { class: 'loading-row' })
    spinner.appendChild(el('div', { class: 'spinner' }))
    spinner.appendChild(document.createTextNode(' Connecting to Sage RPC…'))
    sageStatusBox.appendChild(spinner)

    const r = await api('/api/sage-rpc/status')
    sageStatusBox.innerHTML = ''

    const statusRow = el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:12px' })
    const dotColor = r.connected ? 'var(--green)' : 'var(--red)'
    const dot = el('span', { style: `display:inline-block;width:10px;height:10px;border-radius:50%;background:${dotColor}` })
    const label = el('span', { style: 'font-weight:600' }, r.connected ? 'Connected' : 'Disconnected')
    statusRow.appendChild(dot)
    statusRow.appendChild(label)
    sageStatusBox.appendChild(statusRow)

    if (!r.connected) {
      const errMsg = el('div', { style: 'color:var(--red);font-size:13px' }, r.error || 'Unable to reach Sage RPC')
      sageStatusBox.appendChild(errMsg)
      if (!r.connected && !r.enabled) {
        sageStatusBox.appendChild(el('div', { class: 'text-muted', style: 'font-size:12px;margin-top:6px' },
          'Tip: Set enabled: true and save settings, then restart the Python API.'))
      }
      return
    }

    // Version & sync info
    if (r.version) {
      const v = r.version
      sageStatusBox.appendChild(el('div', { class: 'text-muted', style: 'font-size:12px' },
        `Sage v${v.version || '?'}`))
    }
    if (r.sync_status) {
      const s = r.sync_status
      const syncInfo = el('div', { style: 'background:var(--surface2);border-radius:6px;padding:10px;margin-top:8px;font-size:12px' })
      syncInfo.appendChild(el('div', {}, `Synced: ${s.synced ? '✓' : '…'} | Coins: ${s.synced_coins ?? '?'} | Balance: ${s.balance?.xch ?? (s.selectable_balance?.xch ?? '?')} XCH`))
      sageStatusBox.appendChild(syncInfo)
    }
    if (r.active_key) {
      const k = r.active_key
      const keyBadge = el('div', { style: 'margin-top:10px;padding:8px 12px;background:var(--surface2);border-radius:6px;font-size:12px' })
      keyBadge.appendChild(el('div', { style: 'font-weight:600;color:var(--green)' }, `Active key: ${k.name || 'Unnamed'} (fingerprint: ${k.fingerprint})`))
      keyBadge.appendChild(el('div', { class: 'text-muted' }, `Network: ${k.network_id || '?'}`))
      sageStatusBox.appendChild(keyBadge)
    }

    // Keys list with login buttons
    const keysRes = await api('/api/sage-rpc/keys')
    if (keysRes.ok && keysRes.keys && keysRes.keys.length > 0) {
      const keysHeading = el('div', { style: 'font-weight:600;margin-top:14px;margin-bottom:6px;font-size:13px' }, 'Available Keys')
      sageStatusBox.appendChild(keysHeading)
      for (const k of keysRes.keys) {
        const kRow = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--surface2);border-radius:6px;margin-bottom:6px;font-size:12px' })
        const kInfo = el('div', {})
        kInfo.appendChild(el('div', { style: 'font-weight:600' }, `${k.name || 'Unnamed'} — ${k.fingerprint}`))
        kInfo.appendChild(el('div', { class: 'text-muted' }, `Network: ${k.network_id || '?'} | Kind: ${k.kind || 'bls'}`))
        const btnLogin = el('button', { class: 'btn btn-secondary', style: 'font-size:11px;padding:4px 10px', onclick: async () => {
          btnLogin.disabled = true
          const lr = await api('/api/sage-rpc/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fingerprint: k.fingerprint }),
          })
          if (lr.ok) { showToast(`Logged in as ${k.name || k.fingerprint}`); testSageConnection() }
          else { showToast('Login failed: ' + (lr.error || '?'), false); btnLogin.disabled = false }
        }}, 'Login')
        kRow.appendChild(kInfo)
        kRow.appendChild(btnLogin)
        sageStatusBox.appendChild(kRow)
      }
    }
  }

  content.appendChild(sageCard)
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
const PAGE_TITLES = {
  dashboard: 'Dashboard',
  markets: 'Markets',
  offers: 'Offers',
  coins: 'Coins',
  build: 'Build Offer',
  config: 'Config',
  settings: 'Settings',
}

function navigate(page) {
  document.querySelectorAll('nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.page === page)
  })
  document.getElementById('page-title').textContent = PAGE_TITLES[page] || page
  const content = document.getElementById('content')
  content.innerHTML = ''
  document.getElementById('topbar-actions').innerHTML = ''
  ;(pages[page] || pages.dashboard)(content)
}

document.querySelectorAll('nav a').forEach((a) => {
  a.addEventListener('click', () => navigate(a.dataset.page))
})

// Load env info in sidebar
;(async () => {
  try {
    const r = await api('/api/config-paths')
    const name = r.manager_cmd.split('/').pop().split('\\').pop()
    document.getElementById('env-info').innerHTML =
      `<code style="color:var(--green);background:none;padding:0">${name}</code>`
  } catch {}
})()

// Boot
navigate('dashboard')
