export function renderMeshDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mesh Dashboard</title>
  <style>
    :root {
      --bg: #0f172a;
      --panel: #111827;
      --card: #1f2937;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --ok: #22c55e;
      --warn: #f59e0b;
      --bad: #ef4444;
      --accent: #38bdf8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Noto Sans", sans-serif;
      background: radial-gradient(1200px 600px at 20% -10%, #1d4ed8 0%, transparent 45%), var(--bg);
      color: var(--text);
    }
    .wrap {
      max-width: 1100px;
      margin: 0 auto;
      padding: 18px;
      display: grid;
      gap: 14px;
    }
    .card {
      background: linear-gradient(160deg, rgba(56,189,248,0.08), rgba(30,41,59,0.45)), var(--card);
      border: 1px solid rgba(148,163,184,0.25);
      border-radius: 12px;
      padding: 14px;
    }
    .title {
      margin: 0 0 10px 0;
      font-size: 18px;
    }
    .row {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }
    .kpi {
      background: rgba(15,23,42,0.6);
      border-radius: 10px;
      border: 1px solid rgba(148,163,184,0.18);
      padding: 10px;
    }
    .kpi .k { color: var(--muted); font-size: 12px; }
    .kpi .v { font-size: 20px; font-weight: 700; margin-top: 4px; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      border-bottom: 1px solid rgba(148,163,184,0.2);
      padding: 8px 6px;
      vertical-align: top;
    }
    .tag {
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      display: inline-block;
      border: 1px solid rgba(148,163,184,0.35);
      color: var(--text);
      background: rgba(15,23,42,0.5);
    }
    .online { color: var(--ok); }
    .suspect { color: var(--warn); }
    .offline { color: var(--bad); }
    .muted { color: var(--muted); }
    .small { font-size: 12px; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.45;
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <h1 class="title">Mesh Node</h1>
      <div id="node" class="row"></div>
    </section>

    <section class="card">
      <h2 class="title">Neighbors</h2>
      <div id="neighbors"></div>
    </section>

    <section class="card">
      <h2 class="title">Tasks</h2>
      <div id="tasks"></div>
    </section>
  </main>
  <script>
    async function load() {
      const res = await fetch('/a2a/mesh/state');
      const data = await res.json();
      renderNode(data.node || {});
      renderNeighbors(data.neighbors || []);
      renderTasks(data.tasks || []);
    }

    function renderNode(node) {
      const metrics = [
        ['Node ID', node.nodeId || '-'],
        ['Runtime', node.runtimeType || '-'],
        ['Started', String(Boolean(node.started))],
        ['Neighbors', String(node.neighbors?.total ?? 0)],
        ['Online', String(node.neighbors?.online ?? 0)],
        ['Active Tasks', String(node.tasks?.active ?? 0)],
      ];
      document.getElementById('node').innerHTML = metrics.map(([k, v]) =>
        '<div class="kpi"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>'
      ).join('');
    }

    function renderNeighbors(rows) {
      if (!rows.length) {
        document.getElementById('neighbors').innerHTML = '<div class="muted">No neighbors yet.</div>';
        return;
      }
      const body = rows.map((n) => {
        const cls = n.status || 'offline';
        return '<tr>'
          + '<td>'+n.nodeId+'</td>'
          + '<td><span class="tag">'+(n.runtimeType || '-')+'</span></td>'
          + '<td class="'+cls+'">'+cls+'</td>'
          + '<td>'+(Array.isArray(n.skills) ? n.skills.join(', ') : '-')+'</td>'
          + '<td>'+(n.peerName || '-')+'</td>'
          + '<td>'+(n.latencyMs ?? '-')+'</td>'
          + '<td>'+(n.missCount ?? 0)+'</td>'
          + '</tr>';
      }).join('');
      document.getElementById('neighbors').innerHTML =
        '<table><thead><tr><th>Node</th><th>Runtime</th><th>Status</th><th>Skills</th><th>Peer</th><th>Latency</th><th>Miss</th></tr></thead><tbody>'
        + body
        + '</tbody></table>';
    }

    function renderTasks(rows) {
      if (!rows.length) {
        document.getElementById('tasks').innerHTML = '<div class="muted">No mesh tasks yet.</div>';
        return;
      }
      const body = rows.slice().reverse().map((t) => {
        const stages = (t.stages || []).map((s) => {
          const results = Array.isArray(s.results) ? s.results : [];
          const assigned = Array.isArray(s.assignedNodeIds) ? s.assignedNodeIds.join(", ") : "-";
          const okCount = results.filter((r) => r && r.ok).length;
          const failCount = results.filter((r) => r && !r.ok).length;
          return '- '+s.stageId+' ['+s.status+'] '+assigned
            +' attempts='+(s.attempts ?? 0)
            +' ok='+okCount
            +' fail='+failCount;
        }).join('\\n');
        return '<tr>'
          + '<td>'+t.meshTaskId+'</td>'
          + '<td><span class="tag">'+t.template+'</span></td>'
          + '<td><span class="tag">'+t.selectedTopology+'</span></td>'
          + '<td>'+t.state+'</td>'
          + '<td class="small">'+(t.selectedNodes || []).join(', ')+'</td>'
          + '<td><pre>'+stages+'</pre></td>'
          + '</tr>';
      }).join('');
      document.getElementById('tasks').innerHTML =
        '<table><thead><tr><th>Task</th><th>Template</th><th>Topology</th><th>State</th><th>Nodes</th><th>DAG</th></tr></thead><tbody>'
        + body
        + '</tbody></table>';
    }

    load().catch((err) => {
      document.body.innerHTML = '<pre>'+String(err)+'</pre>';
    });
    setInterval(() => load().catch(() => {}), 2000);
  </script>
</body>
</html>`;
}
