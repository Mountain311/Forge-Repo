import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// ForgeDashboard — VS Code Webview Panel for pipeline visualisation
// ---------------------------------------------------------------------------
export class ForgeDashboard {
    public static currentPanel: ForgeDashboard | undefined;
    private static readonly viewType = 'forgeDashboard';
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._panel.webview.html = this._getHtmlForWebview();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.iconPath = undefined;
    }

    public static createOrShow() {
        const column = vscode.ViewColumn.Beside;
        if (ForgeDashboard.currentPanel) {
            ForgeDashboard.currentPanel._panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            ForgeDashboard.viewType,
            '🔮 Forge Pipeline',
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        ForgeDashboard.currentPanel = new ForgeDashboard(panel);
    }

    public static sendEvent(event: any) {
        if (ForgeDashboard.currentPanel) {
            try { ForgeDashboard.currentPanel._panel.webview.postMessage(event); }
            catch (_) { /* panel may have been disposed */ }
        }
    }

    public dispose() {
        ForgeDashboard.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) { d.dispose(); }
        }
    }

    private _getHtmlForWebview(): string {
        const nonce = getNonce();
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Forge Pipeline</title>
<style>
/* ── Reset & Base ──────────────────────────────────────────────────────── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a12;--bg2:#111120;--glass:rgba(255,255,255,0.035);
  --border:rgba(255,255,255,0.07);--text:#e2e8f0;--text-dim:#64748b;
  --radius:14px;--transition:0.4s cubic-bezier(.4,0,.2,1);
  --c-orchestrator:#a855f7;--c-architecture:#3b82f6;--c-security:#ef4444;
  --c-dependencies:#f59e0b;--c-tdd_coder:#10b981;--c-pm_agent:#ec4899;
  --c-data_leakage:#06b6d4;--c-ethics:#8b5cf6;--c-review:#22c55e;
  --c-recovery:#f43f5e; /* NEW: Recovery Agent Color */
}
html,body{height:100%;overflow:hidden}
body{
  background:var(--bg); color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;
  font-size:13px; display:flex;flex-direction:column;
}

/* ── Header & Layout (Truncated for brevity, keep your existing styles) ── */
.header{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:linear-gradient(135deg,rgba(168,85,247,.08),rgba(59,130,246,.06));border-bottom:1px solid var(--border);flex-shrink:0;}
.header-left{display:flex;align-items:center;gap:10px}
.logo{font-size:22px}
.header h1{font-size:15px;font-weight:700;letter-spacing:-.3px;background:linear-gradient(135deg,#a855f7,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.subtitle{font-size:11px;color:var(--text-dim);margin-left:2px}
.header-right{display:flex;align-items:center;gap:16px}
.status{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.status-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.status.idle .status-dot{background:#64748b}
.status.running .status-dot{background:#22c55e;box-shadow:0 0 8px #22c55e;animation:pulse-dot 1.5s infinite}
.status.complete .status-dot{background:#3b82f6}
.status.error .status-dot{background:#ef4444;box-shadow:0 0 8px #ef4444}
.timer{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:13px;font-weight:600;color:#a855f7;min-width:42px;text-align:right}
@keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:.4}}
.phase-bar{display:flex;align-items:center;gap:0;padding:12px 20px;flex-shrink:0;background:var(--bg2);border-bottom:1px solid var(--border);}
.phase{flex:1;display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:8px;opacity:.35;transition:all var(--transition);cursor:default;}
.phase.active{opacity:1;background:rgba(168,85,247,.1)}
.phase.done{opacity:.7}
.phase-num{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:1.5px solid rgba(255,255,255,.15);transition:all var(--transition);}
.phase.active .phase-num{background:#a855f7;border-color:#a855f7;color:#fff}
.phase.done .phase-num{background:#22c55e;border-color:#22c55e;color:#fff}
.phase-label{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase}
.phase-connector{width:24px;height:2px;background:rgba(255,255,255,.08);flex-shrink:0;transition:background var(--transition)}
.phase-connector.lit{background:linear-gradient(90deg,#a855f7,#3b82f6)}
.pipeline{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px;min-height:0;}
.orchestrator-section{display:flex;justify-content:center}
.orchestrator-card{max-width:320px;width:100%;padding:14px 20px;background:linear-gradient(135deg,rgba(168,85,247,.08),rgba(99,102,241,.05));border:1.5px solid rgba(168,85,247,.2);border-radius:var(--radius);display:flex;align-items:center;gap:14px;transition:all var(--transition);position:relative;overflow:hidden;}
.orchestrator-card.active{border-color:rgba(168,85,247,.6);box-shadow:0 0 30px rgba(168,85,247,.15),inset 0 0 30px rgba(168,85,247,.03);animation:card-glow-orch 2s ease-in-out infinite;}
.orchestrator-card.done{border-color:rgba(34,197,94,.4);box-shadow:0 0 15px rgba(34,197,94,.08)}
@keyframes card-glow-orch{0%,100%{box-shadow:0 0 25px rgba(168,85,247,.12)}50%{box-shadow:0 0 40px rgba(168,85,247,.22)}}
.connector{width:2px;height:20px;margin:0 auto;background:linear-gradient(to bottom,rgba(168,85,247,.3),rgba(168,85,247,.05));transition:all var(--transition)}
.connector.lit{background:linear-gradient(to bottom,#a855f7,rgba(59,130,246,.3));height:24px}
.agent-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;}
.agent-card{background:var(--glass);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;display:flex;align-items:center;gap:12px;transition:all var(--transition);position:relative;overflow:hidden;opacity:.55;}
.agent-card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent);opacity:.25;transition:opacity var(--transition);}
.agent-card.active{opacity:1;background:rgba(255,255,255,.055);border-color:var(--accent);transform:translateY(-2px) scale(1.01);box-shadow:0 8px 24px rgba(0,0,0,.25),0 0 0 1px var(--accent);}
.agent-card.active::before{opacity:1}
.agent-card.active .agent-indicator{background:var(--accent);box-shadow:0 0 8px var(--accent);animation:pulse-dot 1.5s infinite}
.agent-card.done{opacity:.85;border-color:rgba(34,197,94,.3)}
.agent-card.done::before{background:#22c55e;opacity:.6}
.agent-card.done .agent-indicator{background:#22c55e}
.agent-card.done .agent-name::after{content:' ✓';color:#22c55e;font-size:12px}
.agent-card.error{opacity:1;border-color:rgba(239,68,68,.4)}
.agent-card.error::before{background:#ef4444;opacity:.8}
.agent-icon{font-size:20px;flex-shrink:0;line-height:1}
.agent-info{flex:1;min-width:0}
.agent-name{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent-status{font-size:10px;color:var(--text-dim);margin-top:2px;transition:color var(--transition)}
.agent-card.active .agent-status{color:var(--accent)}
.agent-indicator{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.15);flex-shrink:0;transition:all var(--transition)}
.tool-count{position:absolute;top:6px;right:8px;font-size:9px;font-weight:700;background:rgba(255,255,255,.08);border-radius:10px;padding:2px 6px;color:var(--text-dim);display:none;}
.agent-card.active .tool-count,.agent-card.done .tool-count{display:block}
.stats-bar{display:flex;gap:16px;padding:10px 20px;flex-shrink:0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);background:var(--bg2);}
.stat{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim)}
.stat-val{font-weight:700;color:var(--text);font-family:'SF Mono',Menlo,monospace}
.event-log{flex-shrink:0;height:180px;display:flex;flex-direction:column;border-top:1px solid var(--border);}
.log-header{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;background:var(--bg2);border-bottom:1px solid var(--border);font-size:11px;font-weight:700;color:var(--text-dim);letter-spacing:.5px;}
.clear-btn{background:none;border:1px solid rgba(255,255,255,.1);color:var(--text-dim);font-size:10px;padding:2px 8px;border-radius:4px;cursor:pointer;transition:all .2s;}
.clear-btn:hover{border-color:#a855f7;color:#a855f7}
.log-entries{flex:1;overflow-y:auto;padding:6px 0;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px}
.log-entry{padding:3px 16px;border-left:2px solid transparent;transition:background .2s;white-space:pre-wrap;word-break:break-all}
.log-entry:hover{background:rgba(255,255,255,.02)}
.log-entry.system{color:#8b5cf6;border-left-color:#8b5cf6}
.log-entry.info{color:#94a3b8}
.log-entry.success{color:#22c55e;border-left-color:#22c55e}
.log-entry.tool{color:#f59e0b;border-left-color:#f59e0b}
.log-entry.routing{color:#3b82f6;border-left-color:#3b82f6}
.log-entry.error{color:#ef4444;border-left-color:#ef4444}
.log-ts{color:#475569;margin-right:8px}
@keyframes card-glow{0%,100%{box-shadow:0 8px 24px rgba(0,0,0,.25),0 0 15px var(--glow)}50%{box-shadow:0 8px 24px rgba(0,0,0,.25),0 0 30px var(--glow)}}
.agent-card.active{animation:card-glow 2s ease-in-out infinite}
::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:4px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.2)}
</style>
</head>
<body>

<header class="header">
  <div class="header-left">
    <span class="logo">🔮</span>
    <h1>GuardianCoder</h1>
    <span class="subtitle">Pipeline Dashboard</span>
  </div>
  <div class="header-right">
    <span id="status" class="status idle">
      <span class="status-dot"></span>
      <span id="status-text">Waiting</span>
    </span>
    <span id="timer" class="timer">00:00</span>
  </div>
</header>

<div class="phase-bar">
  <div class="phase" data-phase="1"><span class="phase-num">1</span><span class="phase-label">Plan</span></div>
  <div class="phase-connector"></div>
  <div class="phase" data-phase="2"><span class="phase-num">2</span><span class="phase-label">Build</span></div>
  <div class="phase-connector"></div>
  <div class="phase" data-phase="3"><span class="phase-num">3</span><span class="phase-label">Validate</span></div>
  <div class="phase-connector"></div>
  <div class="phase" data-phase="4"><span class="phase-num">4</span><span class="phase-label">Deliver</span></div>
</div>

<div class="pipeline">
  <div class="orchestrator-section">
    <div class="orchestrator-card" id="card-orchestrator" data-agent="orchestrator">
      <span class="agent-icon">🎯</span>
      <div class="agent-info">
        <div class="agent-name">Orchestrator</div>
        <div class="agent-status" id="status-orchestrator">Idle</div>
      </div>
      <div class="agent-indicator"></div>
      <span class="tool-count" id="tools-orchestrator"></span>
    </div>
  </div>

  <div class="connector" id="connector"></div>

  <div class="agent-grid">
    <div class="agent-card" id="card-architecture" data-agent="architecture" style="--accent:var(--c-architecture);--glow:rgba(59,130,246,.2)">
      <span class="agent-icon">🏗️</span>
      <div class="agent-info"><div class="agent-name">Architecture</div><div class="agent-status" id="status-architecture">Idle</div></div>
      <div class="agent-indicator"></div><span class="tool-count" id="tools-architecture"></span>
    </div>
    <div class="agent-card" id="card-security" data-agent="security" style="--accent:var(--c-security);--glow:rgba(239,68,68,.2)">
      <span class="agent-icon">🛡️</span>
      <div class="agent-info"><div class="agent-name">Security</div><div class="agent-status" id="status-security">Idle</div></div>
      <div class="agent-indicator"></div><span class="tool-count" id="tools-security"></span>
    </div>
    <div class="agent-card" id="card-dependencies" data-agent="dependencies" style="--accent:var(--c-dependencies);--glow:rgba(245,158,11,.2)">
      <span class="agent-icon">📦</span>
      <div class="agent-info"><div class="agent-name">Dependencies</div><div class="agent-status" id="status-dependencies">Idle</div></div>
      <div class="agent-indicator"></div><span class="tool-count" id="tools-dependencies"></span>
    </div>
    <div class="agent-card" id="card-tdd_coder" data-agent="tdd_coder" style="--accent:var(--c-tdd_coder);--glow:rgba(16,185,129,.2)">
      <span class="agent-icon">🧪</span>
      <div class="agent-info"><div class="agent-name">TDD Coder</div><div class="agent-status" id="status-tdd_coder">Idle</div></div>
      <div class="agent-indicator"></div><span class="tool-count" id="tools-tdd_coder"></span>
    </div>
    <div class="agent-card" id="card-pm_agent" data-agent="pm_agent" style="--accent:var(--c-pm_agent);--glow:rgba(236,72,153,.2)">
      <span class="agent-icon">📋</span>
      <div class="agent-info"><div class="agent-name">PM Agent</div><div class="agent-status" id="status-pm_agent">Idle</div></div>
      <div class="agent-indicator"></div><span class="tool-count" id="tools-pm_agent"></span>
    </div>
    <div class="agent-card" id="card-recovery_agent" data-agent="recovery_agent" style="--accent:var(--c-recovery);--glow:rgba(244,63,94,.2)">
      <span class="agent-icon">🚑</span>
      <div class="agent-info"><div class="agent-name">Recovery Agent</div><div class="agent-status" id="status-recovery_agent">Idle</div></div>
      <div class="agent-indicator"></div><span class="tool-count" id="tools-recovery_agent"></span>
    </div>
    <div class="agent-card" id="card-data_leakage" data-agent="data_leakage" style="--accent:var(--c-data_leakage);--glow:rgba(6,182,212,.2)">
      <span class="agent-icon">🔒</span>
      <div class="agent-info"><div class="agent-name">Data Leakage</div><div class="agent-status" id="status-data_leakage">Idle</div></div>
      <div class="agent-indicator"></div><span class="tool-count" id="tools-data_leakage"></span>
    </div>
    <div class="agent-card" id="card-ethics" data-agent="ethics" style="--accent:var(--c-ethics);--glow:rgba(139,92,246,.2)">
      <span class="agent-icon">⚖️</span>
      <div class="agent-info"><div class="agent-name">Ethics</div><div class="agent-status" id="status-ethics">Idle</div></div>
      <div class="agent-indicator"></div><span class="tool-count" id="tools-ethics"></span>
    </div>
    <div class="agent-card" id="card-review" data-agent="review" style="--accent:var(--c-review);--glow:rgba(34,197,94,.2)">
      <span class="agent-icon">✅</span>
      <div class="agent-info"><div class="agent-name">Review</div><div class="agent-status" id="status-review">Idle</div></div>
      <div class="agent-indicator"></div><span class="tool-count" id="tools-review"></span>
    </div>
  </div>
</div>

<div class="stats-bar">
  <div class="stat">Agents run <span class="stat-val" id="stat-agents">0</span></div>
  <div class="stat">Tool calls <span class="stat-val" id="stat-tools">0</span></div>
  <div class="stat">Current phase <span class="stat-val" id="stat-phase">—</span></div>
</div>

<div class="event-log">
  <div class="log-header">
    <span>📋 LIVE EVENT LOG</span>
    <button class="clear-btn" id="clear-log">Clear</button>
  </div>
  <div class="log-entries" id="log-entries">
    <div class="log-entry system"><span class="log-ts">--:--:--</span>Dashboard ready. Waiting for pipeline\u2026</div>
  </div>
</div>

<script nonce="${nonce}">
(function() {
    var agents = {
        orchestrator:  { emoji: '🎯', label: 'Orchestrator' },
        architecture:  { emoji: '🏗️', label: 'Architecture' },
        security:      { emoji: '🛡️', label: 'Security' },
        dependencies:  { emoji: '📦', label: 'Dependencies' },
        tdd_coder:     { emoji: '🧪', label: 'TDD Coder' },
        pm_agent:      { emoji: '📋', label: 'PM Agent' },
        data_leakage:  { emoji: '🔒', label: 'Data Leakage' },
        ethics:        { emoji: '⚖️', label: 'Ethics' },
        review:        { emoji: '✅', label: 'Review' },
        recovery_agent: { emoji: '🚑', label: 'Recovery Agent' } // 🔥 NEW: Added mapping
    };

    var toolCounts = {};
    var agentsRunSet = {};
    var totalTools = 0;
    var startTime = null;
    var timerInterval = null;

    /* ── Helpers ──────────────────────────────────────────────────────── */
    function ts() {
        var d = new Date();
        return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)+':'+('0'+d.getSeconds()).slice(-2);
    }
    function getLabel(agent) { return agents[agent] ? agents[agent].label : agent; }
    function getEmoji(agent) { return agents[agent] ? agents[agent].emoji : '🤖'; }

    /* ── Timer ────────────────────────────────────────────────────────── */
    function startTimer() {
        if (timerInterval) return;
        startTime = Date.now();
        timerInterval = setInterval(function() {
            var s = Math.floor((Date.now() - startTime) / 1000);
            var m = Math.floor(s / 60);
            s = s % 60;
            document.getElementById('timer').textContent = ('0'+m).slice(-2) + ':' + ('0'+s).slice(-2);
        }, 500);
    }
    function stopTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }

    /* ── Status ───────────────────────────────────────────────────────── */
    function setStatus(state, text) {
        var el = document.getElementById('status');
        el.className = 'status ' + state;
        document.getElementById('status-text').textContent = text;
    }

    /* ── Phase ────────────────────────────────────────────────────────── */
    function setPhase(phase) {
        var phases = document.querySelectorAll('.phase');
        var connectors = document.querySelectorAll('.phase-connector');
        for (var i = 0; i < phases.length; i++) {
            var p = parseInt(phases[i].getAttribute('data-phase'));
            phases[i].className = 'phase' + (p < phase ? ' done' : (p === phase ? ' active' : ''));
        }
        for (var j = 0; j < connectors.length; j++) {
            connectors[j].className = 'phase-connector' + (j < phase - 1 ? ' lit' : '');
        }
        document.getElementById('stat-phase').textContent = phase;
    }

    /* ── Agent State ──────────────────────────────────────────────────── */
    function setAgentState(agent, state) {
        var card = document.getElementById('card-' + agent);
        if (!card) return;
        card.className = card.className.replace(/ (active|done|error)/g, '');
        if (state) card.className += ' ' + state;

        var statusEl = document.getElementById('status-' + agent);
        if (statusEl) {
            var labels = { active: 'Running\u2026', done: 'Complete', error: 'Error', idle: 'Idle' };
            statusEl.textContent = labels[state] || 'Idle';
        }

        if (state === 'active') {
            agentsRunSet[agent] = true;
            document.getElementById('stat-agents').textContent = Object.keys(agentsRunSet).length;
            var conn = document.getElementById('connector');
            if (conn) conn.className = 'connector lit';
        }
    }

    function resetAllAgents() {
        var keys = Object.keys(agents);
        for (var k = 0; k < keys.length; k++) {
            setAgentState(keys[k], '');
            toolCounts[keys[k]] = 0;
            var badge = document.getElementById('tools-' + keys[k]);
            if (badge) badge.textContent = '';
        }
        agentsRunSet = {};
        totalTools = 0;
        document.getElementById('stat-agents').textContent = '0';
        document.getElementById('stat-tools').textContent = '0';
        document.getElementById('stat-phase').textContent = '—';
    }

    /* ── Tool Count Badge ─────────────────────────────────────────────── */
    function addToolCall(agent) {
        if (!toolCounts[agent]) toolCounts[agent] = 0;
        toolCounts[agent]++;
        totalTools++;
        var badge = document.getElementById('tools-' + agent);
        if (badge) badge.textContent = toolCounts[agent] + ' tool' + (toolCounts[agent] > 1 ? 's' : '');
        document.getElementById('stat-tools').textContent = totalTools;
    }

    /* ── Event Log ────────────────────────────────────────────────────── */
    function addLog(type, message) {
        var container = document.getElementById('log-entries');
        var entry = document.createElement('div');
        entry.className = 'log-entry ' + type;
        entry.innerHTML = '<span class="log-ts">' + ts() + '</span>' + escapeHtml(message);
        container.appendChild(entry);
        container.scrollTop = container.scrollHeight;
        while (container.children.length > 200) container.removeChild(container.firstChild);
    }
    function escapeHtml(s) {
        var d = document.createElement('span');
        d.textContent = s;
        return d.innerHTML;
    }

    document.getElementById('clear-log').addEventListener('click', function() {
        document.getElementById('log-entries').innerHTML = '';
    });

    /* ── Message Handler ──────────────────────────────────────────────── */
    window.addEventListener('message', function(event) {
        var m = event.data;
        if (!m || !m.type) return;

        switch (m.type) {
            case 'pipeline_start':
                resetAllAgents();
                startTimer();
                setStatus('running', 'Running');
                addLog('system', '🚀 Pipeline started — "' + (m.data && m.data.prompt ? m.data.prompt.slice(0,60) : '') + '"');
                break;
            case 'agent_start':
                setAgentState(m.agent, 'active');
                addLog('info', getEmoji(m.agent) + ' ' + getLabel(m.agent) + ' started');
                break;
            case 'agent_done':
                setAgentState(m.agent, 'done');
                addLog('success', '✓ ' + getLabel(m.agent) + ' completed');
                break;
            case 'tool_call':
                addToolCall(m.agent);
                addLog('tool', '⚙ ' + getLabel(m.agent) + ' → ' + (m.data ? m.data.name : '?') + '()');
                break;
            case 'tool_result':
                addLog('tool', '  ← ' + (m.data ? m.data.name : '?') + ' responded');
                break;
            case 'routing':
                if (m.data && m.data.from) setAgentState(m.data.from, 'done');
                if (m.data && m.data.to) setAgentState(m.data.to, 'active');
                addLog('routing', '→ ' + (m.data ? m.data.from || 'start' : '?') + ' → ' + (m.data ? m.data.to || 'done' : '?'));
                break;
            case 'phase_update':
                setPhase(m.data ? m.data.phase : 0);
                addLog('system', '📍 Phase ' + (m.data ? m.data.phase : '?') + ': ' + (m.data ? m.data.name || '' : ''));
                break;
            case 'pipeline_complete':
                stopTimer();
                setStatus('complete', 'Complete');
                addLog('system', '🎉 Pipeline complete');
                break;
            case 'error':
                setStatus('error', 'Error');
                if (m.agent) setAgentState(m.agent, 'error');
                addLog('error', '✗ ' + (m.data ? m.data.message || 'Unknown error' : 'Unknown error'));
                break;
        }
    });
})();
</script>
</body>
</html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}