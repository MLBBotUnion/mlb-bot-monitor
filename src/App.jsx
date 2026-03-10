import { useState, useEffect, useCallback } from 'react'

// ─── Constants ────────────────────────────────────────────────────────────────
const STATUS_COLOR = {
  HEALTHY: '#00ff88',
  WARNING: '#ffcc00',
  ERROR:   '#ff3b5c',
  UNKNOWN: '#555566',
}
const STATUS_BG = {
  HEALTHY: 'rgba(0,255,136,0.07)',
  WARNING: 'rgba(255,204,0,0.07)',
  ERROR:   'rgba(255,59,92,0.07)',
  UNKNOWN: 'rgba(100,100,120,0.05)',
}

// Bot metadata not stored in status.json
const BOT_META = {
  'acuna-hr':     { checks: ['mlb_api','statcast','twitter_api','gcp_function'] },
  'dont-jinx-it': { checks: ['mlb_live','twitter_api','gcp_pubsub','gcp_function'] },
  '4040-tracker': { checks: ['mlb_api','twitter_api','gcp_scheduler','gcp_function'] },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function timeAgo(iso) {
  if (!iso) return 'never'
  const secs = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (secs < 60)   return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs/60)}m ago`
  return `${Math.floor(secs/3600)}h ago`
}

function fmtLatency(ms) {
  if (ms == null) return '—'
  return ms < 1000 ? `${ms}ms` : `${(ms/1000).toFixed(1)}s`
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function Dot({ status, size = 9, pulse }) {
  const c = STATUS_COLOR[status] || STATUS_COLOR.UNKNOWN
  return (
    <span style={{ position:'relative', display:'inline-flex', alignItems:'center', justifyContent:'center' }}>
      {pulse && status === 'HEALTHY' && (
        <span style={{
          position:'absolute', width: size*2.8, height: size*2.8, borderRadius:'50%',
          background: c, opacity: 0.12, animation: 'ping 2.4s ease infinite',
        }} />
      )}
      <span style={{
        display:'inline-block', width: size, height: size, borderRadius:'50%',
        background: c, boxShadow: `0 0 ${size+2}px ${c}66`,
      }} />
    </span>
  )
}

function CheckRow({ id, data }) {
  const s = data?.status || 'UNKNOWN'
  const c = STATUS_COLOR[s]
  return (
    <div style={{
      display:'flex', alignItems:'center', justifyContent:'space-between',
      padding:'7px 11px', borderRadius:6, marginBottom:5,
      background: STATUS_BG[s], border:`1px solid ${c}1a`,
      transition:'background 0.3s',
    }}>
      <div style={{ display:'flex', alignItems:'center', gap:9 }}>
        <Dot status={s} size={7} />
        <span style={{ color:'#bbb', fontSize:12, fontFamily:"'IBM Plex Mono',monospace" }}>
          {data?.label || id}
        </span>
        {data?.error && (
          <span style={{ color:'#ff3b5c', fontSize:10, fontFamily:"'IBM Plex Mono',monospace" }}>
            · {data.error}
          </span>
        )}
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:14 }}>
        <span style={{ color:'#444', fontSize:11, fontFamily:"'IBM Plex Mono',monospace" }}>
          {fmtLatency(data?.latency)}
        </span>
        <span style={{ color:c, fontSize:11, fontWeight:700, letterSpacing:1, fontFamily:"'IBM Plex Mono',monospace" }}>
          {s}
        </span>
      </div>
    </div>
  )
}

function AIDiagnosis({ bot, checkData }) {
  const [text, setText]         = useState('')
  const [loading, setLoading]   = useState(false)
  const [ran, setRan]           = useState(false)

  const run = async () => {
    setLoading(true); setText(''); setRan(true)
    const summary = Object.entries(checkData || {}).map(([id, d]) =>
      `- ${d?.label || id}: ${d?.status || 'UNKNOWN'} ${d?.latency ? `[${d.latency}ms]` : ''} ${d?.error ? `| error: ${d.error}` : ''}`
    ).join('\n')

    try {
      const res = await fetch('https://anthropic-proxy-255785929699.us-central1.run.app/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: `You are a senior DevOps engineer who specializes in GCP-hosted Twitter bots using the MLB Stats API. 
Diagnose issues with surgical precision. Keep your response under 100 words, plain text only, no markdown.
Use exactly 3 labeled lines:
ASSESSMENT: <one sentence>
ROOT CAUSE: <most likely cause, or "All systems nominal">
ACTION: <specific fix command or GCP console path, or "No action needed">`,
          messages: [{
            role: 'user',
            content: `Bot: ${bot.name} (${bot.emoji})\nGCP: ${bot.gcpService}\nOverall: ${bot.overall}\n\nChecks:\n${summary}`,
          }],
        }),
      })
      const data = await res.json()
      setText(data.content?.find(c => c.type === 'text')?.text || 'No response.')
    } catch (e) {
      setText(`Diagnosis failed: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  const c = STATUS_COLOR[bot.overall] || STATUS_COLOR.UNKNOWN
  return (
    <div style={{ background:'#08080f', borderRadius:8, border:'1px solid #111120', padding:14 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: ran ? 12 : 0 }}>
        <span style={{ color:'#333', fontSize:10, letterSpacing:2, fontFamily:"'IBM Plex Mono',monospace" }}>
          AI DIAGNOSIS
        </span>
        <button onClick={run} disabled={loading} style={{
          background: loading ? '#0e0e1a' : `linear-gradient(135deg,${c}18,${c}09)`,
          border: `1px solid ${loading ? '#1a1a2e' : c+'44'}`,
          color: loading ? '#444' : c,
          padding:'5px 13px', borderRadius:5, cursor: loading ? 'not-allowed' : 'pointer',
          fontSize:11, fontFamily:"'IBM Plex Mono',monospace", letterSpacing:1,
          transition:'all 0.2s',
        }}>
          {loading ? 'ANALYZING…' : ran ? '↻ RE-RUN' : '▶ RUN DIAGNOSIS'}
        </button>
      </div>
      {text && (
        <div style={{
          borderTop:'1px solid #111120', paddingTop:12,
          color:'#999', fontSize:12, lineHeight:1.8,
          fontFamily:"'IBM Plex Mono',monospace", whiteSpace:'pre-wrap',
          animation:'fadeIn 0.3s ease',
        }}>{text}</div>
      )}
      {!ran && (
        <div style={{ color:'#2a2a3a', fontSize:11, fontFamily:"'IBM Plex Mono',monospace", marginTop:4 }}>
          Run AI-powered root cause analysis on this bot's health data.
        </div>
      )}
    </div>
  )
}

function BotCard({ bot }) {
  const [open, setOpen] = useState(false)
  const c = STATUS_COLOR[bot.overall] || STATUS_COLOR.UNKNOWN
  const checkIds = BOT_META[bot.id]?.checks || Object.keys(bot.checks || {})

  return (
    <div style={{
      background:'linear-gradient(135deg,#0d0d12,#111118)',
      border:`1px solid ${c}2a`, borderRadius:12, overflow:'hidden',
      boxShadow:`0 0 50px ${c}0a, inset 0 1px 0 ${c}18`,
      transition:'border-color 0.4s, box-shadow 0.4s',
    }}>
      {/* Header */}
      <div onClick={() => setOpen(o => !o)} style={{
        padding:'17px 20px', cursor:'pointer',
        display:'flex', alignItems:'center', justifyContent:'space-between',
        borderBottom: open ? `1px solid ${c}18` : 'none',
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:13 }}>
          <span style={{ fontSize:24 }}>{bot.emoji}</span>
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:3 }}>
              <span style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:20, letterSpacing:2, color:'#eee' }}>
                {bot.name}
              </span>
              <span style={{
                fontSize:9, color:'#555', fontFamily:"'IBM Plex Mono',monospace",
                border:'1px solid #1e1e2e', borderRadius:3, padding:'2px 6px',
              }}>
                {bot.gcpService}
              </span>
            </div>
            <div style={{ color:'#444', fontSize:11, fontFamily:"'IBM Plex Mono',monospace" }}>
              {bot.description}
            </div>
          </div>
        </div>

        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          <div style={{ textAlign:'right' }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, justifyContent:'flex-end', marginBottom:4 }}>
              <Dot status={bot.overall} size={11} pulse />
              <span style={{ color:c, fontSize:13, fontWeight:700, fontFamily:"'IBM Plex Mono',monospace", letterSpacing:1 }}>
                {bot.overall}
              </span>
            </div>
            <div style={{ color:'#333', fontSize:10, fontFamily:"'IBM Plex Mono',monospace" }}>
              scanned {timeAgo(bot.scannedAt)}
            </div>
          </div>
          <span style={{ color:'#333', fontSize:16 }}>{open ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Body */}
      {open && (
        <div style={{ padding:'15px 20px 20px', animation:'fadeIn 0.2s ease' }}>
          <div style={{
            fontSize:9, color:'#333', letterSpacing:2,
            fontFamily:"'IBM Plex Mono',monospace", marginBottom:9, textTransform:'uppercase',
          }}>Health Checks</div>
          {checkIds.map(id => (
            <CheckRow key={id} id={id} data={bot.checks?.[id]} />
          ))}
          <div style={{ marginTop:14 }}>
            <AIDiagnosis bot={bot} checkData={bot.checks} />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [statusData, setStatusData] = useState(null)
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState(null)
  const [lastFetch, setLastFetch]   = useState(null)

  const fetchStatus = useCallback(async () => {
    try {
      // Cache-bust so GitHub Pages doesn't serve stale status.json
      const res = await fetch(`/mlb-bot-monitor/status.json?t=${Date.now()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setStatusData(data)
      setLastFetch(new Date())
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch on mount, then every 60 seconds
  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 60000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  const bots    = statusData ? Object.values(statusData.bots) : []
  const healthy = bots.filter(b => b.overall === 'HEALTHY').length
  const warning = bots.filter(b => b.overall === 'WARNING').length
  const errored = bots.filter(b => b.overall === 'ERROR').length

  return (
    <div style={{ minHeight:'100vh', background:'#06060a', color:'#f0f0f0', fontFamily:"'IBM Plex Mono',monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;700&display=swap');
        @keyframes ping    { 0%,100%{transform:scale(1);opacity:.12} 50%{transform:scale(2.8);opacity:0} }
        @keyframes fadeIn  { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
        @keyframes ticker  { from{transform:translateX(0)} to{transform:translateX(-50%)} }
        * { box-sizing:border-box; margin:0; padding:0 }
        ::-webkit-scrollbar { width:4px }
        ::-webkit-scrollbar-track { background:#0a0a0f }
        ::-webkit-scrollbar-thumb { background:#1a1a2e; border-radius:2px }
      `}</style>

      {/* ── Header ── */}
      <div style={{ padding:'22px 28px 0', borderBottom:'1px solid #0e0e18' }}>
        <div style={{ display:'flex', alignItems:'flex-end', justifyContent:'space-between', paddingBottom:16 }}>
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:5 }}>
              <span style={{ fontSize:24 }}>⚾</span>
              <h1 style={{
                fontFamily:"'Bebas Neue',sans-serif", fontSize:30,
                letterSpacing:4, color:'#f0f0f0',
                textShadow:'0 0 40px rgba(0,200,255,0.12)',
              }}>MLB BOT MONITOR</h1>
              <span style={{
                fontSize:9, color:'#2a2a3a', border:'1px solid #1a1a2e',
                borderRadius:3, padding:'2px 7px', alignSelf:'center',
              }}>AGENT v2 · GCP + GITHUB</span>
            </div>
            <div style={{ color:'#2a2a3a', fontSize:10, letterSpacing:1 }}>
              GITHUB ACTIONS CRON · GCP CLOUD RUN · AUTO-REFRESH 60s
            </div>
          </div>

          {/* Counts */}
          <div style={{ display:'flex', gap:24, paddingBottom:4 }}>
            {[
              ['HEALTHY', healthy, STATUS_COLOR.HEALTHY],
              ['WARNING', warning, STATUS_COLOR.WARNING],
              ['ERROR',   errored, STATUS_COLOR.ERROR],
            ].map(([label, count, color]) => (
              <div key={label} style={{ textAlign:'center' }}>
                <div style={{
                  fontFamily:"'Bebas Neue',sans-serif", fontSize:38,
                  color: count > 0 ? color : '#1a1a2a', lineHeight:1,
                  textShadow: count > 0 ? `0 0 24px ${color}44` : 'none',
                  transition:'all 0.4s',
                }}>{count}</div>
                <div style={{ fontSize:9, color:'#2a2a3a', letterSpacing:2 }}>{label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Status bar ── */}
      <div style={{
        padding:'10px 28px', borderBottom:'1px solid #0e0e18',
        display:'flex', justifyContent:'space-between', alignItems:'center',
      }}>
        <div style={{ color:'#2a2a3a', fontSize:10 }}>
          {statusData
            ? `STATUS.JSON GENERATED: ${timeAgo(statusData.generatedAt)}`
            : loading ? 'LOADING STATUS…' : `ERROR: ${error}`
          }
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:16 }}>
          <span style={{ color:'#2a2a3a', fontSize:10 }}>
            DASHBOARD FETCHED: {lastFetch ? timeAgo(lastFetch.toISOString()) : '—'}
          </span>
          <button onClick={fetchStatus} style={{
            background:'#0e0e1a', border:'1px solid #4db8ff33',
            color:'#4db8ff', padding:'6px 16px', borderRadius:5,
            cursor:'pointer', fontSize:10, letterSpacing:2,
          }}>↻ REFRESH</button>
        </div>
      </div>

      {/* ── Bot Cards ── */}
      <div style={{ padding:'20px 28px', display:'flex', flexDirection:'column', gap:13 }}>
        {loading && (
          <div style={{ color:'#2a2a3a', textAlign:'center', padding:60, fontSize:13 }}>
            LOADING BOT STATUS…
          </div>
        )}
        {error && !loading && (
          <div style={{
            background:'rgba(255,59,92,0.07)', border:'1px solid #ff3b5c2a',
            borderRadius:10, padding:24, textAlign:'center',
          }}>
            <div style={{ color:'#ff3b5c', fontSize:14, marginBottom:8 }}>⚠ Could not load status.json</div>
            <div style={{ color:'#555', fontSize:11 }}>
              {error} — Make sure GitHub Actions has run at least once.
            </div>
          </div>
        )}
        {bots.map((bot, i) => (
          <div key={bot.id} style={{ animation:`fadeIn 0.35s ease ${i*0.08}s both` }}>
            <BotCard bot={bot} />
          </div>
        ))}
      </div>

      {/* ── Footer ── */}
      <div style={{
        padding:'16px 28px', borderTop:'1px solid #0a0a12',
        display:'flex', justifyContent:'space-between',
      }}>
        <span style={{ color:'#1a1a2a', fontSize:10 }}>MLB BOT MONITOR · FREE TIER · GITHUB PAGES + ACTIONS</span>
        <span style={{ color:'#1a1a2a', fontSize:10 }}>MLB STATS API · X/TWITTER · GCP · CLAUDE AI</span>
      </div>
    </div>
  )
}
