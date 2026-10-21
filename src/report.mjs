// One self-contained HTML page from what is already on disk under .sma/. No server,
// no assets — open it in a browser, or upload it as a CI artifact.
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ORDER = { breaking: 0, unknown: 1, warning: 2, safe: 3 };
const where = (i) => [i.method, i.path].filter(Boolean).join(' ') || '(whole spec)';

function finding(i) {
  const sites = i.sites?.length
    ? `<ul class="sites">${i.sites
        .map(
          (s) =>
            `<li><code class="loc">${esc(s.file)}:${s.line}</code><code class="snip">${esc(s.snippet)}</code>${
              s.kind === 'caller' ? `<span class="via">via ${esc(s.via)}()</span>` : ''
            }</li>`,
        )
        .join('')}</ul>`
    : `<p class="none">No call sites in this repo — not affected.</p>`;
  return `<article class="finding sev-${esc(i.severity)}">
  <header><span class="badge">${esc(i.severity)}</span><code class="rule">${esc(i.rule)}</code><code class="ep">${esc(where(i))}</code><span class="api">${esc(i.api)}</span></header>
  <p class="reason">${esc(i.reason)}</p>
  ${sites}
</article>`;
}

function runRow(r) {
  const status = r.needsHuman ? '<span class="pill warn">needs human</span>' : '<span class="pill ok">ready to review</span>';
  const pr = r.pr ? `<a href="${esc(r.pr)}">${esc(r.pr.replace(/^https:\/\/github\.com\//, ''))}</a>` : '<span class="mute">local only</span>';
  return `<tr><td>${esc(new Date(r.at).toLocaleString())}</td><td>${esc(r.api)}</td><td>${r.rules.map((x) => `<code>${esc(x)}</code>`).join(' ')}</td><td><code>${esc(r.branch)}</code></td><td>${r.testsPass ? '<span class="pill ok">pass</span>' : '<span class="pill bad">fail</span>'}</td><td>${status}</td><td>${pr}</td></tr>`;
}

export function renderReport({ cfg, impacts, inventory, runs, generatedAt = new Date() }) {
  const items = [...(impacts ?? [])].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const breaking = items.filter((i) => i.severity === 'breaking');
  const affected = breaking.filter((i) => i.affected);
  const sites = inventory?.sites ?? [];
  const tiles = [
    ['APIs watched', cfg.apis.length],
    ['Call sites found', sites.length],
    ['Spec changes', items.length],
    ['Breaking', breaking.length],
    ['Breaking & used here', affected.length],
    ['Repair runs', runs.length],
  ];
  // A repair that covers every affected rule means the break is handled, pending review.
  const last = runs.at(-1);
  const patched = last && affected.every((i) => i.api === last.api && last.rules.includes(i.rule));
  const verdict = !impacts
    ? ['idle', 'No check has run yet.']
    : affected.length && patched
      ? [
          last.needsHuman ? 'warn' : 'ok',
          `${affected.length} breaking change(s) reach this repo — patched on ${last.branch}, tests ${last.testsPass ? 'pass' : 'FAIL'}, ${last.needsHuman ? 'needs a human' : 'awaiting review'}.`,
        ]
    : affected.length
      ? ['bad', `${affected.length} breaking change(s) reach this repo.`]
      : breaking.length
        ? ['warn', `${breaking.length} breaking change(s) upstream — none touch code in this repo.`]
        : ['ok', 'Nothing in the latest check breaks this repo.'];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sma report</title>
<style>
:root{--bg:#fbfbfa;--card:#fff;--fg:#17181a;--mute:#5d6168;--line:#e2e2dc;--code:#f2f2ef;--bad:#b42318;--bad-bg:#fdecea;--warn:#8a5a00;--warn-bg:#fdf3dc;--ok:#1f7a45;--ok-bg:#e6f4ec;--unk:#5b4fc4;--unk-bg:#efedfc;--accent:#9a3412}
@media (prefers-color-scheme:dark){:root{--bg:#101114;--card:#171a1e;--fg:#e7e9ec;--mute:#9aa0a8;--line:#2a2e34;--code:#0c0d10;--bad:#f08b84;--bad-bg:#3a1714;--warn:#e0b25a;--warn-bg:#33270e;--ok:#7cc79a;--ok-bg:#12291c;--unk:#aaa1f5;--unk-bg:#221e3d;--accent:#e8a06a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
code{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
main{max-width:1080px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:22px;margin:0}h2{font-size:16px;margin:36px 0 12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute)}
.top{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px}.top p{margin:4px 0 0;color:var(--mute)}
.verdict{margin:20px 0;padding:14px 16px;border-radius:10px;font-weight:600}
.verdict.bad{background:var(--bad-bg);color:var(--bad)}.verdict.warn{background:var(--warn-bg);color:var(--warn)}.verdict.ok{background:var(--ok-bg);color:var(--ok)}.verdict.idle{background:var(--code);color:var(--mute)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.tile b{display:block;font-size:26px;font-variant-numeric:tabular-nums}.tile span{color:var(--mute);font-size:13px}
.pipe{display:flex;flex-wrap:wrap;gap:6px;align-items:center;color:var(--mute);font-size:13px}.pipe span{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:3px 10px}
.finding{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:10px;padding:12px 16px;margin-bottom:10px}
.finding header{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.badge{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:2px 8px;border-radius:999px}
.sev-breaking{border-left-color:var(--bad)}.sev-breaking .badge{background:var(--bad-bg);color:var(--bad)}
.sev-warning{border-left-color:var(--warn)}.sev-warning .badge{background:var(--warn-bg);color:var(--warn)}
.sev-safe{border-left-color:var(--ok)}.sev-safe .badge{background:var(--ok-bg);color:var(--ok)}
.sev-unknown{border-left-color:var(--unk)}.sev-unknown .badge{background:var(--unk-bg);color:var(--unk)}
.rule{font-weight:600}.ep{color:var(--accent)}.api{margin-left:auto;color:var(--mute);font-size:13px}
.reason{margin:6px 0}.none{margin:4px 0;color:var(--mute);font-size:13px}
.sites{list-style:none;margin:6px 0 0;padding:0}.sites li{display:flex;flex-wrap:wrap;gap:4px 10px;padding:4px 0;border-top:1px dashed var(--line)}
.loc{color:var(--mute);min-width:180px}.snip{background:var(--code);padding:1px 6px;border-radius:4px;overflow-wrap:anywhere}.via{font-size:12px;color:var(--mute)}
.table{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mute);font-weight:600;font-size:12px;text-transform:uppercase}
tr:last-child td{border-bottom:0}.mute{color:var(--mute)}a{color:var(--accent)}
.pill{font-size:12px;padding:2px 8px;border-radius:999px;white-space:nowrap}.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.bad{background:var(--bad-bg);color:var(--bad)}.pill.warn{background:var(--warn-bg);color:var(--warn)}
</style>
</head>
<body>
<main>
<div class="top"><div><h1>Self-maintaining API report</h1><p>${esc(cfg.repoPath)}</p></div><p>generated ${esc(generatedAt.toLocaleString())}</p></div>
<div class="verdict ${verdict[0]}">${esc(verdict[1])}</div>
<div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><b>${v}</b><span>${esc(k)}</span></div>`).join('')}</div>
<h2>Pipeline</h2>
<div class="pipe"><span>fetch spec</span>→<span>diff vs baseline</span>→<span>17 rules</span>→<span>AST call sites</span>→<span>impact</span>→<span>agent patch</span>→<span>harness runs tests</span>→<span>PR</span></div>
<h2>Watched APIs</h2>
<div class="table"><table><tr><th>Name</th><th>Spec</th><th>Call sites</th></tr>${cfg.apis
    .map(
      (a) =>
        `<tr><td><b>${esc(a.name)}</b></td><td><code>${esc(a.specShown ?? a.spec)}</code></td><td>${sites.filter((s) => s.api === a.name).length}</td></tr>`,
    )
    .join('')}</table></div>
<h2>Latest findings</h2>
${items.length ? items.map(finding).join('\n') : '<p class="mute">No changes in the latest check.</p>'}
<h2>Repair runs</h2>
${runs.length ? `<div class="table"><table><tr><th>When</th><th>API</th><th>Changes</th><th>Branch</th><th>Tests</th><th>Status</th><th>PR</th></tr>${[...runs].reverse().map(runRow).join('')}</table></div>` : '<p class="mute">No repairs yet. Run <code>sma fix</code>.</p>'}
</main>
</body>
</html>
`;
}
