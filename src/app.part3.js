/* =============================================================================
   Part 3 — cost / risk / inventory / mapping / assumptions panels, export, boot
   ============================================================================= */

function renderCost() {
  const t = totals();
  const op = onPremTotals();

  // Scenario grid: term × Hybrid Benefit, recomputed without disturbing UI state.
  const saved = { term: A.term, sqlAhb: A.sqlAhb };
  const scenarios = [];
  for (const term of ["payg", "ri1y", "ri3y"]) {
    for (const ahb of [true, false]) {
      A.term = term; A.sqlAhb = ahb;
      computeEstate();
      let sum = 0;
      for (const r of S.rows) sum += r.cost.total;
      scenarios.push({ term, ahb, monthly: sum });
    }
  }
  A.term = saved.term; A.sqlAhb = saved.sqlAhb;
  recompute();

  const best = Math.min(...scenarios.map(s => s.monthly));
  const worst = Math.max(...scenarios.map(s => s.monthly));
  const termName = { payg: "Pay-as-you-go", ri1y: "1-year reserved", ri3y: "3-year reserved" };

  const byTarget = {};
  const seenDeploy = new Set();
  for (const r of S.rows) {
    const k = r.cost.target;
    (byTarget[k] ||= { n: 0, compute: 0, storage: 0, license: 0, total: 0, vcores: 0 });
    const b = byTarget[k];
    b.n++; b.compute += r.cost.compute; b.storage += r.cost.storage;
    b.license += r.cost.license; b.total += r.cost.total;
    if (r.cost.shared) {
      const dk = r.instKey + "|" + k + "|" + r.cost.tier;
      if (!seenDeploy.has(dk)) { seenDeploy.add(dk); b.vcores += r.cost.groupVcores; }
    } else b.vcores += r.cost.vcores;
  }

  $("#panel-cost").innerHTML = `
    <div class="controls">
      <div class="ctl"><label>Azure region</label>
        <select id="cRegion">${Object.keys(PRICES.regions || {}).map(r =>
          `<option value="${r}" ${A.region === r ? "selected" : ""}>${r}</option>`).join("")}</select></div>
      <div class="ctl"><label>Pricing term</label>
        <select id="cTerm">${Object.entries(termName).map(([k, v]) =>
          `<option value="${k}" ${A.term === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      <label class="chk"><input type="checkbox" id="cSqlAhb" ${A.sqlAhb ? "checked" : ""}> SQL Hybrid Benefit</label>
      <label class="chk"><input type="checkbox" id="cWinAhb" ${A.winAhb ? "checked" : ""}> Windows Hybrid Benefit</label>
      <div class="ctl" style="min-width:230px">
        <label>Right-sizing <span id="cRsLabel" class="src-tag">${A.rightSizePct}% smaller than source</span></label>
        <input type="range" id="cRightSize" value="${A.rightSizePct}" min="0" max="60" step="5" style="width:100%">
      </div>
      <div class="ctl" style="min-width:230px">
        <label>Serverless active <span id="cSlLabel" class="src-tag">${A.serverlessActivePct}% of the month</span></label>
        <input type="range" id="cServerless" value="${A.serverlessActivePct}" min="5" max="100" step="5" style="width:100%">
      </div>
      <div class="ctl"><label>Storage growth %</label><input type="number" id="cStor" value="${A.storageOverheadPct}" min="0" max="200" step="5"></div>
      <label class="chk"><input type="checkbox" id="cConsol" ${A.consolidateToMi ? "checked" : ""}> Consolidate databases per instance</label>
      <div class="spacer"></div>
      <button id="btnExportCsv">Export CSV</button>
      <button id="btnExportXls">Export Excel</button>
    </div>

    <div class="kpis">
      ${kpi("Azure monthly", FMT.money(t.monthly), { cls: "accent", foot: termName[A.term] + (A.sqlAhb ? " · with AHB" : " · licence included") })}
      ${kpi("Annual", FMT.money(t.monthly * 12))}
      ${kpi("3-year", FMT.money(t.monthly * 36))}
      ${kpi("Total vCores", FMT.num(t.vcores), { foot: `${t.deployments} deployment${t.deployments === 1 ? "" : "s"} · ${A.rightSizePct ? A.rightSizePct + "% right-sized" : "matched to source"}` })}
      ${kpi("vs on-prem / mo", FMT.money(op.monthly - t.monthly), { cls: (op.monthly - t.monthly) >= 0 ? "good" : "bad", foot: (op.monthly - t.monthly) >= 0 ? "saving" : "increase" })}
    </div>

    <div class="split">
      <div class="card">
        <h3>Scenario comparison <span class="hint">whole estate, per month</span></h3>
        <div class="tbl-wrap">
          <table>
            <thead><tr><th class="nosort">Term</th><th class="nosort">Hybrid Benefit</th><th class="nosort num">Monthly</th><th class="nosort num">Annual</th><th class="nosort">vs most expensive</th></tr></thead>
            <tbody>
              ${scenarios.map(s => {
                const savePct = worst > 0 ? 100 * (worst - s.monthly) / worst : 0;
                const isCur = s.term === A.term && s.ahb === A.sqlAhb;
                return `<tr${isCur ? ' style="background:var(--cp-accent-soft)"' : ""}>
                  <td>${termName[s.term]}${isCur ? ' <span class="pill accent">current</span>' : ""}</td>
                  <td>${s.ahb ? '<span class="pill green">Applied</span>' : '<span class="pill gray">None</span>'}</td>
                  <td class="num">${FMT.money(s.monthly)}</td>
                  <td class="num">${FMT.money(s.monthly * 12)}</td>
                  <td><div style="display:flex;align-items:center;gap:8px">
                    <div class="bar-track" style="flex:1"><div class="bar-fill" style="width:${savePct}%"></div></div>
                    <span style="font-size:11.5px;min-width:38px">${savePct > 0 ? "−" + FMT.pct(savePct) : "—"}</span>
                  </div></td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>
        <div class="note">
          Lowest modelled cost is <b>${FMT.money(best)}/mo</b> — ${FMT.pct(worst > 0 ? 100 * (worst - best) / worst : 0)}
          below the most expensive combination. Reserved-instance and Hybrid Benefit choices are
          usually the single largest lever on an Azure SQL estate.
        </div>
      </div>

      <div class="card">
        <h3>Cost by target platform</h3>
        <div class="tbl-wrap">
          <table>
            <thead><tr><th class="nosort">Target</th><th class="nosort num">DBs</th><th class="nosort num">vCores</th><th class="nosort num">Compute</th><th class="nosort num">Storage</th><th class="nosort num">Licence</th><th class="nosort num">Total</th></tr></thead>
            <tbody>
              ${Object.entries(byTarget).map(([k, b]) => `<tr>
                <td><b>${TARGETS[k].name}</b></td>
                <td class="num">${b.n}</td><td class="num">${FMT.num(b.vcores)}</td>
                <td class="num">${FMT.money(b.compute)}</td><td class="num">${FMT.money(b.storage)}</td>
                <td class="num">${b.license > 0 ? FMT.money(b.license) : "—"}</td>
                <td class="num"><b>${FMT.money(b.total)}</b></td></tr>`).join("")}
              <tr style="border-top:2px solid var(--cp-border)">
                <td><b>Total</b></td><td class="num"><b>${t.dbs}</b></td><td class="num"><b>${FMT.num(t.vcores)}</b></td>
                <td class="num"><b>${FMT.money(t.compute)}</b></td><td class="num"><b>${FMT.money(t.storage)}</b></td>
                <td class="num"><b>${t.license > 0 ? FMT.money(t.license) : "—"}</b></td>
                <td class="num"><b>${FMT.money(t.monthly)}</b></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>Per-database cost detail</h3>
      <div class="tbl-wrap">
        <table id="costTable">
          <thead><tr>
            <th data-sort="instKey">Instance</th><th data-sort="database">Database</th>
            <th class="nosort">Target &amp; size</th><th class="num" data-sort="sizeGb">Data</th>
            <th class="nosort num">Compute</th><th class="nosort num">Storage</th>
            <th class="nosort num">Licence</th><th class="nosort num">Monthly</th>
          </tr></thead>
          <tbody>
            ${filtered().map(r => `<tr>
              <td>${esc(r.instKey)}</td><td><b>${esc(r.database)}</b></td>
              <td><span class="src-tag">${esc(r.cost.detail)}</span></td>
              <td class="num">${FMT.gb(r.sizeGb)}</td>
              <td class="num">${FMT.money(r.cost.compute)}</td>
              <td class="num">${FMT.money(r.cost.storage)}</td>
              <td class="num">${r.cost.license > 0 ? FMT.money(r.cost.license) : "—"}</td>
              <td class="num"><b>${FMT.money(r.cost.total)}</b></td></tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>

    <div class="note info">
      <b>Where these prices come from.</b> Compute, storage and reservation rates are pulled from the
      public <b>Azure Retail Prices API</b> (snapshot: ${esc((PRICES.generated || "").slice(0, 10))}).
      That API publishes only the <i>base</i> rate for Azure SQL PaaS — the rate that already assumes
      Azure Hybrid Benefit. The SQL Server licence component, and SQL licences on Azure VM, are
      editable assumptions on the <b>Assumptions</b> tab. All figures are list price in USD and exclude
      any negotiated discount.
    </div>`;

  $("#cRegion").onchange = e => { A.region = e.target.value; renderAll(); };
  $("#cTerm").onchange = e => { A.term = e.target.value; renderAll(); };
  $("#cSqlAhb").onchange = e => { A.sqlAhb = e.target.checked; renderAll(); };
  $("#cWinAhb").onchange = e => { A.winAhb = e.target.checked; renderAll(); };
  // Live label while dragging; only recompute on release, since a full re-render
  // per pixel would make the slider feel sticky on a large estate.
  const rs = $("#cRightSize");
  rs.oninput = e => {
    const v = +e.target.value;
    $("#cRsLabel").textContent = v === 0
      ? "same core count as source"
      : `${v}% smaller than source`;
  };
  rs.onchange = e => { A.rightSizePct = +e.target.value || 0; renderAll(); };

  const sl = $("#cServerless");
  sl.oninput = e => { $("#cSlLabel").textContent = `${e.target.value}% of the month`; };
  sl.onchange = e => { A.serverlessActivePct = +e.target.value || 25; renderAll(); };
  $("#cStor").onchange = e => { A.storageOverheadPct = +e.target.value || 0; renderAll(); };
  $("#cConsol").onchange = e => { A.consolidateToMi = e.target.checked; renderAll(); };
  $("#btnExportCsv").onclick = exportCsv;
  $("#btnExportXls").onclick = exportXls;
  wireSort("#costTable", renderCost);
}

function renderInventory() {
  $("#panel-inventory").innerHTML = `
    <div class="card">
      <h3>Full inventory <span class="hint">${S.rows.length} databases as interpreted by the analyzer</span></h3>
      <div class="tbl-wrap">
        <table id="invTable">
          <thead><tr>
            <th data-sort="server">Server</th><th data-sort="instance">Instance</th>
            <th data-sort="database">Database</th><th data-sort="version">Version</th>
            <th data-sort="edition">Edition</th><th class="num" data-sort="cores">Cores</th>
            <th class="num" data-sort="memoryGb">Memory</th><th class="num" data-sort="sizeGb">Size</th>
            <th class="num" data-sort="bufferPoolMb">Working set</th>
            <th class="num" data-sort="cpuPct">CPU %</th><th data-sort="compat">Compat</th>
            <th class="nosort">Features</th>
          </tr></thead>
          <tbody>
            ${filtered().map(r => `<tr>
              <td>${esc(r.server)}</td><td>${esc(r.instance || "—")}</td>
              <td><b>${esc(r.database)}</b></td><td>${esc(r.version || "—")}</td>
              <td>${esc(r.edition || "—")}</td><td class="num">${FMT.num(r.cores)}</td>
              <td class="num">${r.memoryGb ? FMT.num(r.memoryGb) + " GB" : "—"}</td>
              <td class="num">${FMT.gb(r.sizeGb)}</td>
              <td class="num">${r.bufferPoolMb != null ? (r.bufferPoolMb >= 1024 ? (r.bufferPoolMb / 1024).toFixed(1) + " GB" : Math.round(r.bufferPoolMb) + " MB") : "—"}</td>
              <td class="num">${r.cpuPct != null ? FMT.pct(r.cpuPct) : "—"}</td>
              <td class="num">${r.compat || "—"}</td>
              <td class="wrap-cell">${FEATURES.filter(f => r.f[f.key]).map(f => `<span class="pill gray">${esc(f.label)}</span>`).join(" ") || '<span class="src-tag">—</span>'}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
  wireSort("#invTable", renderInventory);
}


function renderAssumptions() {
  const fields = [
    { k: "licEntPer2Core", label: "SQL Enterprise licence (2-core pack)", pre: "$" },
    { k: "licStdPer2Core", label: "SQL Standard licence (2-core pack)", pre: "$" },
    { k: "saPctOfLicense", label: "Software Assurance (% of licence / yr)", pre: "%" },
    { k: "esuPctOfLicense", label: "Extended Security Updates (% of licence / yr)", pre: "%" },
    { k: "paasLicUpliftGp", label: "PaaS licence uplift — General Purpose ($/vCore/hr)", pre: "$" },
    { k: "paasLicUpliftBc", label: "PaaS licence uplift — Business Critical ($/vCore/hr)", pre: "$" },
    { k: "vmSqlEntPerCoreHr", label: "SQL Enterprise on VM ($/vCPU/hr)", pre: "$" },
    { k: "vmSqlStdPerCoreHr", label: "SQL Standard on VM ($/vCPU/hr)", pre: "$" },
    { k: "onPremHwPerCoreYr", label: "On-prem hardware/hosting ($/core/yr)", pre: "$" },
    { k: "minVcores", label: "Minimum vCores per database", pre: "" },
  ];

  $("#panel-assumptions").innerHTML = `
    <div class="note info">
      <b>Why these are editable.</b> The Azure Retail Prices API publishes compute, storage and
      reservation rates, but <i>not</i> SQL Server licence costs — neither the licence component of
      Azure SQL PaaS nor SQL licences on Azure VM. Those are listed here as explicit assumptions so
      you can replace them with the customer's actual negotiated rates rather than list price.
    </div>

    <div class="card">
      <h3>Estate-wide assumptions <span class="hint">things SQL Server cannot report about itself</span></h3>
      <label class="chk">
        <input type="checkbox" id="assumeSA" ${A.onPremHasSA ? "checked" : ""}>
        Software Assurance is active on the on-premises estate
      </label>
      <div class="note">
        The collector reads the engine, not the licensing agreement, so this is a judgement you set
        rather than a column in the inventory. It only affects the <b>on-premises</b> side of the
        comparison: with it off, the Software Assurance renewal and the ESU line both drop to zero,
        since ESU cannot be purchased without active SA. Leaving it on is the conservative choice —
        it makes the on-premises run-rate look higher, and therefore Azure look better, so turn it
        off if the customer is not under SA.
      </div>
    </div>

    <div class="split">
      <div class="card">
        <h3>Licensing &amp; cost assumptions</h3>
        <div class="tbl-wrap"><table>
          <thead><tr><th class="nosort">Assumption</th><th class="nosort num">Value</th></tr></thead>
          <tbody>
            ${fields.map(f => `<tr>
              <td>${esc(f.label)}</td>
              <td class="num"><input type="number" data-assume="${f.k}" value="${A[f.k]}" step="any" style="width:130px;text-align:right"></td>
            </tr>`).join("")}
          </tbody>
        </table></div>
        <div style="margin-top:11px"><button class="primary" id="btnApplyAssume">Apply</button></div>
      </div>

      <div class="card">
        <h3>Price snapshot <span class="hint">from the Azure Retail Prices API</span></h3>
        <table>
          <tbody>
            <tr><td>Snapshot taken</td><td class="num">${esc((PRICES.generated || "—").slice(0, 10))}</td></tr>
            <tr><td>Regions included</td><td class="num">${Object.keys(PRICES.regions || {}).length}</td></tr>
            <tr><td>Currency</td><td class="num">${esc(PRICES.currency || "USD")}</td></tr>
            <tr><td>Selected region</td><td class="num"><b>${esc(A.region)}</b></td></tr>
          </tbody>
        </table>
        <h3 style="margin-top:16px">Rates in ${esc(A.region)} <span class="hint">$/vCore/hr, base (AHB) rate</span></h3>
        <div class="tbl-wrap"><table>
          <thead><tr><th class="nosort">Tier</th><th class="nosort num">PAYG</th><th class="nosort num">1-yr RI</th><th class="nosort num">3-yr RI</th></tr></thead>
          <tbody>
            ${[["mi_gp_gen5", "SQL MI — General Purpose"], ["mi_bc_gen5", "SQL MI — Business Critical"],
               ["db_gp_gen5", "SQL DB — General Purpose"], ["db_bc_gen5", "SQL DB — Business Critical"],
               ["db_hs_gen5", "SQL DB — Hyperscale"]].map(([k, label]) => {
              const p = px();
              return `<tr><td>${label}</td>
                <td class="num">${p.paas?.[k] != null ? "$" + p.paas[k].toFixed(4) : "—"}</td>
                <td class="num">${p.ri?.[k + "_1y"] != null ? "$" + p.ri[k + "_1y"].toFixed(4) : "—"}</td>
                <td class="num">${p.ri?.[k + "_3y"] != null ? "$" + p.ri[k + "_3y"].toFixed(4) : "—"}</td></tr>`;
            }).join("")}
          </tbody>
        </table></div>
      </div>
    </div>

    <div class="card">
      <h3>Methodology</h3>
      <details class="acc"><summary>How targets are chosen</summary>
        <p style="font-size:12.5px;color:var(--cp-text-muted)">Each database is tested against a rule set covering
        features that are unsupported on specific Azure targets. The analyzer selects the most managed
        platform with no violations, preferring Azure SQL Database, then Managed Instance, then SQL Server
        on Azure VM. Hyperscale is proposed only where a database exceeds the 4 TB single-database limit.
        Business Critical is selected where the source uses In-Memory OLTP, is clustered, participates in an
        availability group, or runs Enterprise edition. The inventory is entirely machine-generated, so
        the model never assumes a database is non-production: everything is priced at full production
        hours.</p></details>
      <details class="acc"><summary>How readiness is categorised</summary>
        <p style="font-size:12.5px;color:var(--cp-text-muted)">Every database is reported against every target
        in the categories used by the Azure portal and SSMS migration assessments.
        <b>Ready</b> — nothing detected that needs changing. <b>Needs review</b>, which the SSMS report words
        <i>Ready with warnings</i> — it can move, but something needs attention first: a service tier
        requirement (In-Memory OLTP needs Business Critical, columnstore is unavailable below Standard S3),
        a feature to re-enable afterwards (CDC, change tracking, replication), key management to plan (TDE),
        or a compatibility level below 100 to raise.
        <b>Not ready</b> — a feature rules the target out entirely until it is removed or reworked.
        Where a target is blocked, its warnings are suppressed: there is no value in planning around a
        feature on a platform you cannot use at all. These categories are derived from inventory flags, so
        treat them as triage — confirm the databases you decide to move with the SSMS assessment, which
        applies the full rule set and tells you how to remediate.</p></details>
      <details class="acc"><summary>How sizing is derived</summary>
        <p style="font-size:12.5px;color:var(--cp-text-muted)">Target vCores are the source core count
        reduced by the <b>right-sizing</b> percentage on the Cost model tab, rounded up to a purchasable
        size. The default is 20%, on the basis that SQL Server estates are routinely provisioned for a peak
        that never arrives; set it to 0 to model a straight lift-and-shift, or higher where you have grounds.
        <br><br>
        This is deliberately a judgement you set rather than a figure inferred from telemetry. The engine
        does not keep utilisation history the way vCenter does: Query Store is off on most estates, and the
        scheduler ring buffer covers only the last few hours of a single instance, so a percentage derived
        from it would look measured without being reliable. The collector still gathers that evidence —
        CPU, CPU pressure, memory target versus in use, and per-database working set, all on the Inventory
        tab — so the number you choose can be argued from something. Storage is the database size plus the
        configured growth allowance.</p></details>
      <details class="acc"><summary>What this does not cover</summary>
        <p style="font-size:12.5px;color:var(--cp-text-muted)">Networking and egress, backup storage beyond the
        included allowance, geo-replication or failover groups, Defender for SQL, Purview, migration effort and
        licensing for non-SQL software on the same hosts. The on-premises comparison covers SQL Server SA and
        ESU only — it is not a full datacentre TCO, so real-world savings are usually understated.</p></details>
    </div>`;

  $("#btnApplyAssume").onclick = () => {
    $$("[data-assume]").forEach(i => { A[i.dataset.assume] = parseFloat(i.value) || 0; });
    renderAll();
  };
  $("#assumeSA").onchange = (e) => { A.onPremHasSA = e.target.checked; renderAll(); };
}

/* ---------------------------------------------------------------------------
   10. Export
   --------------------------------------------------------------------------- */
const EXPORT_COLS = [
  ["Server", r => r.server], ["Instance", r => r.instance], ["Database", r => r.database],
  ["SQL version", r => r.version], ["Edition", r => r.edition],
  ["Support status", r => r.support.label], ["Cores", r => r.cores],
  ["Memory GB", r => r.memoryGb], ["Size GB", r => (r.sizeGb || 0).toFixed(1)],
  ["Avg CPU %", r => r.cpuPct], ["Working set MB", r => r.bufferPoolMb],
  ["Recommended target", r => TARGETS[r.cost.target].name],
  ["Readiness — SQL DB", r => READINESS[readinessFor(r, "sqldb")].label],
  ["Readiness — SQL MI", r => READINESS[readinessFor(r, "mi")].label],
  ["Readiness — SQL VM", r => READINESS[readinessFor(r, "vm")].label],
  ["Service tier", r => r.cost.target === "vm" ? "IaaS" : r.cost.tier === "bc" ? "Business Critical" : r.cost.target === "hs" ? "Hyperscale" : "General Purpose"],
  ["Sizing", r => r.cost.detail], ["vCores", r => r.cost.vcores],
  ["Storage GB", r => r.cost.storeGb],
  ["Compute $/mo", r => r.cost.compute.toFixed(2)],
  ["Storage $/mo", r => r.cost.storage.toFixed(2)],
  ["Licence $/mo", r => r.cost.license.toFixed(2)],
  ["Total $/mo", r => r.cost.total.toFixed(2)],
  ["Total $/yr", r => (r.cost.total * 12).toFixed(2)],
  ["Blockers — SQL DB", r => (r.blocked.sqldb || []).join("; ")],
  ["Blockers — SQL MI", r => (r.blocked.mi || []).join("; ")],
  ["Warnings — SQL DB", r => (r.warned?.sqldb || []).join("; ")],
  ["Warnings — SQL MI", r => (r.warned?.mi || []).join("; ")],
  ["Features", r => FEATURES.filter(f => r.f[f.key]).map(f => f.label).join("; ")],
];

function download(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportCsv() {
  const q = v => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [EXPORT_COLS.map(c => q(c[0])).join(",")];
  for (const r of S.rows) lines.push(EXPORT_COLS.map(c => q(c[1](r))).join(","));
  download(`sql-estate-analysis-${new Date().toISOString().slice(0, 10)}.csv`,
           "\uFEFF" + lines.join("\r\n"), "text/csv;charset=utf-8");
}

/* Excel export via SpreadsheetML 2003 — opens natively in Excel, no library needed. */
function exportXls() {
  const t = totals(), op = onPremTotals();
  const cell = (v, type) => {
    const isNum = type === "Number" && v !== "" && v != null && !isNaN(v);
    return `<Cell><Data ss:Type="${isNum ? "Number" : "String"}">${esc(isNum ? v : (v ?? ""))}</Data></Cell>`;
  };
  const sheet = (name, headers, rows) => `
    <Worksheet ss:Name="${esc(name)}"><Table>
      <Row>${headers.map(h => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${esc(h)}</Data></Cell>`).join("")}</Row>
      ${rows.map(r => `<Row>${r.map(c => cell(c.v, c.t)).join("")}</Row>`).join("")}
    </Table></Worksheet>`;

  const detail = S.rows.map(r => EXPORT_COLS.map(c => {
    const v = c[1](r);
    return { v, t: (typeof v === "number" || /\$\/|GB$|vCores|Cores/.test(c[0])) && !isNaN(parseFloat(v)) ? "Number" : "String" };
  }));

  const summaryRows = [
    ["Databases", S.rows.length], ["Instances", S.instances.length],
    ["Total size (GB)", +t.sizeGb.toFixed(1)], ["Total vCores", t.vcores],
    ["Region", A.region], ["Pricing term", A.term],
    ["SQL Hybrid Benefit", A.sqlAhb ? "Applied" : "Not applied"],
    ["Azure compute $/mo", +t.compute.toFixed(2)], ["Azure storage $/mo", +t.storage.toFixed(2)],
    ["Azure licence $/mo", +t.license.toFixed(2)], ["Azure total $/mo", +t.monthly.toFixed(2)],
    ["Azure total $/yr", +(t.monthly * 12).toFixed(2)],
    ["On-prem SA $/yr", +op.sa.toFixed(2)], ["On-prem ESU $/yr", +op.esu.toFixed(2)],
    ["On-prem total $/yr", +op.yr.toFixed(2)],
    ["Price snapshot", (PRICES.generated || "").slice(0, 10)],
    ["Generated", new Date().toISOString().slice(0, 16).replace("T", " ")],
  ].map(([k, v]) => [{ v: k, t: "String" }, { v, t: typeof v === "number" ? "Number" : "String" }]);

  const xml = `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="hdr"><Font ss:Bold="1"/>
<Interior ss:Color="#DDDDDD" ss:Pattern="Solid"/></Style></Styles>
${sheet("Summary", ["Metric", "Value"], summaryRows)}
${sheet("Analysis", EXPORT_COLS.map(c => c[0]), detail)}
</Workbook>`;
  download(`sql-estate-analysis-${new Date().toISOString().slice(0, 10)}.xls`,
           xml, "application/vnd.ms-excel");
}

/* ---------------------------------------------------------------------------
   11. Demo estate — representative of a real mixed SQL Server environment
   --------------------------------------------------------------------------- */
function demoCsv() {
  const hdr = ["ServerName","InstanceName","SqlVersion","ProductVersion","Edition","OsPlatform","LogicalCores",
    "PhysicalMemoryGB","AvgCpuPct","PeakCpuPct","IsFailoverCluster","IsAlwaysOnEnabled","AgentJobCount",
    "LinkedServerCount","HasSsisCatalog","HasSsrs","IsReplicationDistributor","DatabaseName","CompatibilityLevel",
    "TotalSizeGB","HasFileStream","HasFileTable","HasMemoryOptimized","HasClrAssembly",
    "HasFullTextCatalog","HasColumnStoreIndex","HasPartitioning","HasTemporalTable","HasExternalTable",
    "HasCrossDbDependency","HasLinkedSvrDependency","HasServiceBroker","HasChangeDataCapture","HasChangeTracking",
    "IsTdeEncrypted","IsPublished","IsSubscribed","IsMergePublished","IsInAvailabilityGroup"];

  const d = (o) => hdr.map(h => o[h] ?? "0").join(",");
  const rows = [
    // Legacy 2014 Enterprise cluster — ESU exposure, CLR + cross-db block PaaS
    { ServerName:"SQLPROD01", InstanceName:"MSSQLSERVER", SqlVersion:"SQL Server 2014", ProductVersion:"12.0.6449.1",
      Edition:"Enterprise Edition (64-bit)", OsPlatform:"Windows", LogicalCores:"24", PhysicalMemoryGB:"256",
      AvgCpuPct:"38", PeakCpuPct:"81", IsFailoverCluster:"1", IsAlwaysOnEnabled:"1", AgentJobCount:"18",
      LinkedServerCount:"3", DatabaseName:"SalesOrders", CompatibilityLevel:"120", TotalSizeGB:"1240", HasClrAssembly:"1", HasCrossDbDependency:"1",
      HasColumnStoreIndex:"1", HasPartitioning:"1", IsTdeEncrypted:"1", IsInAvailabilityGroup:"1" },
    { ServerName:"SQLPROD01", InstanceName:"MSSQLSERVER", SqlVersion:"SQL Server 2014", ProductVersion:"12.0.6449.1",
      Edition:"Enterprise Edition (64-bit)", OsPlatform:"Windows", LogicalCores:"24", PhysicalMemoryGB:"256",
      AvgCpuPct:"38", PeakCpuPct:"81", IsFailoverCluster:"1", IsAlwaysOnEnabled:"1", AgentJobCount:"18",
      LinkedServerCount:"3", DatabaseName:"CustomerMaster", CompatibilityLevel:"120", TotalSizeGB:"380", HasCrossDbDependency:"1", IsTdeEncrypted:"1",
      IsInAvailabilityGroup:"1" },

    // 2016 Standard — clean, PaaS-ready
    { ServerName:"SQLAPP02", InstanceName:"MSSQLSERVER", SqlVersion:"SQL Server 2016", ProductVersion:"13.0.7016.1",
      Edition:"Standard Edition (64-bit)", OsPlatform:"Windows", LogicalCores:"8", PhysicalMemoryGB:"64",
      AvgCpuPct:"14", PeakCpuPct:"42", AgentJobCount:"0", DatabaseName:"WebContent", CompatibilityLevel:"130",
      TotalSizeGB:"85", HasFullTextCatalog:"1" },
    { ServerName:"SQLAPP02", InstanceName:"MSSQLSERVER", SqlVersion:"SQL Server 2016", ProductVersion:"13.0.7016.1",
      Edition:"Standard Edition (64-bit)", OsPlatform:"Windows", LogicalCores:"8", PhysicalMemoryGB:"64",
      AvgCpuPct:"14", PeakCpuPct:"42", AgentJobCount:"0", DatabaseName:"Sessions", CompatibilityLevel:"130",
      TotalSizeGB:"12" },

    // 2012 EOL with FILESTREAM — VM only
    { ServerName:"SQLDOC03", InstanceName:"DOCS", SqlVersion:"SQL Server 2012", ProductVersion:"11.0.7507.2",
      Edition:"Standard Edition (64-bit)", OsPlatform:"Windows", LogicalCores:"12", PhysicalMemoryGB:"96",
      AvgCpuPct:"22", PeakCpuPct:"58", AgentJobCount:"6", DatabaseName:"DocumentStore", CompatibilityLevel:"110",
      TotalSizeGB:"2400", HasFileStream:"1",
      HasFileTable:"1", HasFullTextCatalog:"1" },

    // 2019 Enterprise data warehouse — very large, Hyperscale candidate
    { ServerName:"SQLDW04", InstanceName:"MSSQLSERVER", SqlVersion:"SQL Server 2019", ProductVersion:"15.0.4345.5",
      Edition:"Enterprise Edition (64-bit)", OsPlatform:"Windows", LogicalCores:"32", PhysicalMemoryGB:"512",
      AvgCpuPct:"52", PeakCpuPct:"94", AgentJobCount:"24", HasSsisCatalog:"1", DatabaseName:"EnterpriseDW",
      CompatibilityLevel:"150", TotalSizeGB:"6800",
      HasColumnStoreIndex:"1", HasPartitioning:"1", HasExternalTable:"1" },

    // 2017 reporting + SSRS — VM only
    { ServerName:"SQLRPT05", InstanceName:"MSSQLSERVER", SqlVersion:"SQL Server 2017", ProductVersion:"14.0.3465.1",
      Edition:"Standard Edition (64-bit)", OsPlatform:"Windows", LogicalCores:"8", PhysicalMemoryGB:"64",
      AvgCpuPct:"18", PeakCpuPct:"63", AgentJobCount:"9", HasSsrs:"1", DatabaseName:"ReportServer",
      CompatibilityLevel:"140", TotalSizeGB:"45" },

    // Dev/test — low utilisation
    { ServerName:"SQLDEV06", InstanceName:"DEV", SqlVersion:"SQL Server 2019", ProductVersion:"15.0.4345.5",
      Edition:"Developer Edition (64-bit)", OsPlatform:"Linux", LogicalCores:"8", PhysicalMemoryGB:"32",
      AvgCpuPct:"6", PeakCpuPct:"28", AgentJobCount:"2", DatabaseName:"SalesOrders_Dev",
      CompatibilityLevel:"150", TotalSizeGB:"210",
      HasClrAssembly:"1" },
    { ServerName:"SQLDEV06", InstanceName:"DEV", SqlVersion:"SQL Server 2019", ProductVersion:"15.0.4345.5",
      Edition:"Developer Edition (64-bit)", OsPlatform:"Linux", LogicalCores:"8", PhysicalMemoryGB:"32",
      AvgCpuPct:"6", PeakCpuPct:"28", AgentJobCount:"2", DatabaseName:"WebContent_Test",
      CompatibilityLevel:"150", TotalSizeGB:"40" },

    // In-Memory OLTP — Business Critical
    { ServerName:"SQLTRD07", InstanceName:"MSSQLSERVER", SqlVersion:"SQL Server 2022", ProductVersion:"16.0.4125.3",
      Edition:"Enterprise Edition (64-bit)", OsPlatform:"Windows", LogicalCores:"16", PhysicalMemoryGB:"256",
      AvgCpuPct:"61", PeakCpuPct:"92", IsAlwaysOnEnabled:"1", AgentJobCount:"5", DatabaseName:"TradingEngine",
      CompatibilityLevel:"160", TotalSizeGB:"640",
      HasMemoryOptimized:"1", HasTemporalTable:"1", IsTdeEncrypted:"1", IsInAvailabilityGroup:"1" },

    // Merge replication — VM only
    { ServerName:"SQLBR08", InstanceName:"MSSQLSERVER", SqlVersion:"SQL Server 2016", ProductVersion:"13.0.7016.1",
      Edition:"Standard Edition (64-bit)", OsPlatform:"Windows", LogicalCores:"8", PhysicalMemoryGB:"48",
      AvgCpuPct:"11", PeakCpuPct:"39", AgentJobCount:"14", IsReplicationDistributor:"1",
      DatabaseName:"BranchSync", CompatibilityLevel:"130", TotalSizeGB:"95", IsMergePublished:"1", IsPublished:"1" },
  ];
  return "\uFEFF" + hdr.join(",") + "\r\n" + rows.map(d).join("\r\n") + "\r\n";
}

/* ---------------------------------------------------------------------------
   13. Load & boot
   --------------------------------------------------------------------------- */
async function loadFiles(fileList) {
  S.loadErrors = [];
  const merged = [];
  let headers = [];

  for (const file of fileList) {
    try {
      let parsed;
      if (/\.xlsx?$/i.test(file.name)) {
        parsed = await parseXlsx(await file.arrayBuffer());
      } else {
        parsed = parseDelimited(await file.text());
      }
      if (!parsed.records.length) { S.loadErrors.push(`${file.name}: no data rows found.`); continue; }
      // Union the headers so mixed-shape files still line up.
      for (const h of parsed.headers) if (!headers.includes(h)) headers.push(h);
      merged.push(...parsed.records);
    } catch (e) {
      S.loadErrors.push(`${file.name}: ${e.message}`);
    }
  }

  if (!merged.length) {
    $("#loadErrors").innerHTML = `<ul class="err-list">${S.loadErrors.map(e => `<li>${esc(e)}</li>`).join("")}
      <li>Check the file has a header row and at least one data row.</li></ul>`;
    return;
  }

  S.rawHeaders = headers;
  S.rawRecords = merged;
  S.map = autoMap(headers);

  const missing = FIELDS.filter(f => f.req && !S.map[f.key]);
  buildRows();

  if (!S.rows.length) {
    $("#loadErrors").innerHTML = `<ul class="err-list">
      <li>No usable database rows were found after mapping.</li>
      ${missing.length ? `<li>Could not auto-detect these required columns: ${missing.map(m => esc(m.label)).join(", ")}.</li>` : ""}
      <li>Rename the columns in your file to match the CSV template and load it again.</li></ul>`;
    return;
  }

  $("#loadErrors").innerHTML = "";
  $("#uploadView").classList.add("hidden");
  $("#resultsView").classList.remove("hidden");
  renderAll();
  if (missing.length) {
    setTimeout(() => alert(
      `Loaded ${S.rows.length} databases, but these columns were not auto-detected:\n\n` +
      missing.map(m => "  • " + m.label).join("\n") +
      `\n\nResults will be incomplete. Rename them to match the CSV template and load the file again.`), 200);
  }
}

function boot() {
  $("#btnPick").onclick = () => $("#file").click();
  $("#file").onchange = e => { if (e.target.files.length) loadFiles(Array.from(e.target.files)); };

  const drop = $("#drop");
  ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation(); drop.classList.add("over");
  }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation();
    if (ev === "dragleave" && drop.contains(e.relatedTarget)) return;
    drop.classList.remove("over");
  }));
  drop.addEventListener("drop", e => {
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) loadFiles(files);
  });

  $("#btnDemo").onclick = () => {
    const blob = new File([demoCsv()], "demo-estate.csv", { type: "text/csv" });
    loadFiles([blob]);
  };
  $("#btnScript").onclick = () => {
    // Navigation only — no estate data is transmitted. Opens the repo folder
    // holding SqlEstateDiscovery.sql and Invoke-SqlEstateDiscovery.ps1.
    window.open("https://github.com/krishna-sunkavalli/sql-modernization-azure/tree/main/discovery", "_blank", "noopener");
  };

  $("#tabs").onclick = e => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    $$("#tabs button").forEach(x => x.classList.toggle("on", x === b));
    $$(".panel").forEach(p => p.classList.toggle("on", p.id === "panel-" + b.dataset.tab));
  };

  $("#btnTheme").onclick = () => {
    const cur = document.documentElement.getAttribute("data-theme");
    document.documentElement.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
  };
}

document.addEventListener("DOMContentLoaded", boot);
