/* =============================================================================
   SQL Estate Analyzer — application logic
   Everything runs client-side. No network calls, no storage, no data egress.
   ============================================================================= */
"use strict";

/* PRICES is injected at build time from the Azure Retail Prices API. */
const PRICES = /*__PRICES__*/{}/*__END_PRICES__*/;

/* ---------------------------------------------------------------------------
   1. Assumptions — everything the retail API cannot tell us lives here,
      visible and editable, because real customers have negotiated rates.
   --------------------------------------------------------------------------- */
const A = {
  region: "eastus",
  currency: "USD",

  // SQL Server licence list prices (2-core pack, USD). Editable.
  licEntPer2Core: 15123,
  licStdPer2Core: 3945,
  saPctOfLicense: 25,        // annual Software Assurance, % of licence list
  esuPctOfLicense: 75,       // annual Extended Security Updates, % of licence list

  // PaaS licence uplift: the delta between license-included and base (AHB) rates.
  // Retail API publishes only the base rate, so this is carried as an assumption.
  paasLicUpliftGp: 0.2094,   // $/vCore/hr added on General Purpose
  paasLicUpliftBc: 0.3940,   // $/vCore/hr added on Business Critical

  // SQL Server licence on Azure VM (per vCPU/hr), when NOT using Hybrid Benefit.
  vmSqlEntPerCoreHr: 0.5484,
  vmSqlStdPerCoreHr: 0.1370,

  sqlAhb: true,              // apply Azure Hybrid Benefit for SQL
  winAhb: false,             // apply Azure Hybrid Benefit for Windows Server
  term: "payg",              // payg | ri1y | ri3y
  hoursPerMonth: 730,
  onPremHasSA: true,         // estate-wide: SQL cannot report licensing position

  // Right-sizing
  rightSizePct: 20,          // cut this % off the source core count
  serverlessActivePct: 25,   // hours/month a serverless DB is active, not paused
  minVcores: 2,
  storageOverheadPct: 30,    // growth headroom on database size
  consolidateToMi: true,     // group an instance's DBs onto one MI

  // Baseline (stay on-prem) — used for the comparison, not a full datacentre TCO.
  includeOnPremBaseline: true,
  onPremHwPerCoreYr: 0,      // optional: hardware/hosting per core per year
};

const FMT = {
  money: (n, d = 0) => {
    if (n == null || isNaN(n)) return "—";
    const v = Number(n);
    const s = "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
    return v < 0 ? "−" + s : s;
  },
  num: (n, d = 0) => (n == null || isNaN(n)) ? "—" :
    Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }),
  gb: (n) => n == null || isNaN(n) ? "—" : (n >= 1024 ? (n / 1024).toFixed(2) + " TB" : Number(n).toFixed(1) + " GB"),
  pct: (n, d = 0) => n == null || isNaN(n) ? "—" : Number(n).toFixed(d) + "%",
};

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/* ---------------------------------------------------------------------------
   2. SQL Server lifecycle (Microsoft Lifecycle Policy)
   --------------------------------------------------------------------------- */
const LIFECYCLE = {
  8:  { name: "SQL Server 2000",    ext: "2013-04-09", esuEnd: null },
  9:  { name: "SQL Server 2005",    ext: "2016-04-12", esuEnd: null },
  10: { name: "SQL Server 2008/R2", ext: "2019-07-09", esuEnd: "2022-07-12" },
  11: { name: "SQL Server 2012",    ext: "2022-07-12", esuEnd: "2025-07-08" },
  12: { name: "SQL Server 2014",    ext: "2024-07-09", esuEnd: "2027-07-13" },
  13: { name: "SQL Server 2016",    ext: "2026-07-14", esuEnd: "2029-07-10" },
  14: { name: "SQL Server 2017",    ext: "2027-10-12", esuEnd: "2030-10-08" },
  15: { name: "SQL Server 2019",    ext: "2030-01-08", esuEnd: "2033-01-11" },
  16: { name: "SQL Server 2022",    ext: "2033-01-11", esuEnd: null },
  17: { name: "SQL Server 2025",    ext: "2035-01-09", esuEnd: null },
};

function supportState(major, today = new Date()) {
  const lc = LIFECYCLE[major];
  if (!lc) return { state: "unknown", label: "Unknown", cls: "gray", extEnd: null };
  const ext = lc.ext ? new Date(lc.ext) : null;
  if (!ext) return { state: "unknown", label: "Unknown", cls: "gray", extEnd: null };
  if (today > ext) {
    const esuEnd = lc.esuEnd ? new Date(lc.esuEnd) : null;
    if (esuEnd && today <= esuEnd) {
      return { state: "esu", label: "Out of support — ESU only", cls: "red", extEnd: ext, esuEnd };
    }
    return { state: "eol", label: "End of life", cls: "red", extEnd: ext, esuEnd };
  }
  const days = Math.round((ext - today) / 86400000);
  if (days <= 365) return { state: "ending", label: `Support ends in ${Math.round(days / 30)} mo`, cls: "amber", extEnd: ext };
  return { state: "ok", label: "In support", cls: "green", extEnd: ext };
}

/* ---------------------------------------------------------------------------
   3. Column auto-detection — accepts our template and most hand-built inventories.
   --------------------------------------------------------------------------- */
const FIELDS = [
  { key: "server",      label: "Server / host",     req: true,  aliases: ["servername", "server", "host", "hostname", "machinename", "computername", "sqlserver", "sourceserver"] },
  { key: "instance",    label: "Instance",          req: false, aliases: ["instancename", "instance", "sqlinstance", "namedinstance"] },
  { key: "database",    label: "Database",          req: true,  aliases: ["databasename", "database", "dbname", "db", "name"] },
  { key: "version",     label: "SQL version",       req: false, aliases: ["sqlversion", "version", "sqlserverversion", "productname", "release"] },
  { key: "productver",  label: "Product version",   req: false, aliases: ["productversion", "buildnumber", "build", "versionnumber"] },
  { key: "edition",     label: "Edition",           req: false, aliases: ["edition", "sqledition", "sqlserveredition"] },
  { key: "cores",       label: "Cores",             req: false, aliases: ["logicalcores", "cores", "cpucount", "corecount", "vcpu", "vcpus", "numberofcores", "cpu", "processors"] },
  { key: "memoryGb",    label: "Memory (GB)",       req: false, aliases: ["physicalmemorygb", "memorygb", "ramgb", "memory", "ram", "servermemorygb"] },
  { key: "sizeGb",      label: "DB size (GB)",      req: true,  aliases: ["totalsizegb", "sizegb", "databasesizegb", "dbsizegb", "size", "datasizegb", "sizemb"] },
  { key: "dataGb",      label: "Data size (GB)",    req: false, aliases: ["datasizegb", "datagb", "rowsizegb"] },
  { key: "logGb",       label: "Log size (GB)",     req: false, aliases: ["logsizegb", "loggb", "translogsizegb"] },
  { key: "cpuPct",      label: "Avg CPU %",         req: false, aliases: ["avgcpupct", "cpupct", "avgcpu", "cpuutilization", "avgcpupercent"] },
  { key: "peakCpuPct",  label: "Peak CPU %",        req: false, aliases: ["peakcpupct", "maxcpupct", "maxcpu", "peakcpu"] },
  { key: "readIops",    label: "Read IOPS",         req: false, aliases: ["readiops", "reads"] },
  { key: "writeIops",   label: "Write IOPS",        req: false, aliases: ["writeiops", "writes"] },
  { key: "compat",      label: "Compatibility lvl", req: false, aliases: ["compatibilitylevel", "compatlevel", "compat"] },
  { key: "os",          label: "OS platform",       req: false, aliases: ["osplatform", "os", "operatingsystem", "platform"] },
  { key: "uptimeHours", label: "Uptime (hours)",    req: false, aliases: ["uptimehours", "uptime"] },
  { key: "cpuSamples",  label: "CPU samples",       req: false, aliases: ["cpusamplecount", "cpusamples"] },
  { key: "memTargetGb", label: "SQL memory target", req: false, aliases: ["sqlmemorytargetgb", "memorytargetgb"] },
  { key: "memInUseGb",  label: "SQL memory in use", req: false, aliases: ["sqlmemoryinusegb", "memoryinusegb"] },
  { key: "bufferPoolMb",label: "Buffer pool (MB)",  req: false, aliases: ["bufferpoolmb", "bufferpool"] },
  { key: "qsCores",     label: "Query Store cores", req: false, aliases: ["qsavgcpucores", "querystoreavgcpucores"] },
  { key: "qsWindowHrs", label: "Query Store window",req: false, aliases: ["qswindowhours", "querystorewindowhours"] },
  { key: "cpuPressure", label: "CPU pressure %",    req: false, aliases: ["cpupressurepct"] },
];

/* Boolean feature flags that drive target eligibility. */
const FEATURES = [
  { key: "fileStream",   label: "FILESTREAM",            aliases: ["hasfilestream", "filestream"] },
  { key: "fileTable",    label: "FileTable",             aliases: ["hasfiletable", "filetable"] },
  { key: "memOpt",       label: "In-Memory OLTP",        aliases: ["hasmemoryoptimized", "memoryoptimized", "inmemoryoltp", "hekaton"] },
  { key: "clr",          label: "SQLCLR assemblies",     aliases: ["hasclrassembly", "clr", "hasclr", "sqlclr"] },
  { key: "fullText",     label: "Full-text search",      aliases: ["hasfulltextcatalog", "fulltext", "hasfulltext"] },
  { key: "columnStore",  label: "Columnstore index",     aliases: ["hascolumnstoreindex", "columnstore"] },
  { key: "partitioning", label: "Table partitioning",    aliases: ["haspartitioning", "partitioning", "partitioned"] },
  { key: "temporal",     label: "Temporal tables",       aliases: ["hastemporaltable", "temporal"] },
  { key: "external",     label: "PolyBase / external",   aliases: ["hasexternaltable", "external", "polybase"] },
  { key: "crossDb",      label: "Cross-database refs",   aliases: ["hascrossdbdependency", "crossdb", "crossdatabase"] },
  { key: "linkedSrvDep", label: "Linked-server refs",    aliases: ["haslinkedsvrdependency", "linkedserverdependency"] },
  { key: "broker",       label: "Service Broker",        aliases: ["hasservicebroker", "servicebroker", "isbrokerenabled"] },
  { key: "cdc",          label: "Change Data Capture",   aliases: ["haschangedatacapture", "cdc", "iscdcenabled"] },
  { key: "changeTrack",  label: "Change Tracking",       aliases: ["haschangetracking", "changetracking"] },
  { key: "tde",          label: "TDE encryption",        aliases: ["istdeencrypted", "tde", "encrypted", "isencrypted"] },
  { key: "published",    label: "Replication publisher", aliases: ["ispublished", "published"] },
  { key: "subscribed",   label: "Replication subscriber",aliases: ["issubscribed", "subscribed"] },
  { key: "mergePub",     label: "Merge replication",     aliases: ["ismergepublished", "mergepublished"] },
  { key: "inAg",         label: "Availability Group",    aliases: ["isinavailabilitygroup", "availabilitygroup", "inag"] },
];

/* Instance-scope signals. */
const INSTANCE_FIELDS = [
  { key: "agentJobs",     aliases: ["agentjobcount", "agentjobs", "sqlagentjobs"] },
  { key: "linkedServers", aliases: ["linkedservercount", "linkedservers"] },
  { key: "ssis",          aliases: ["hasssiscatalog", "ssis", "ssiscatalog"] },
  { key: "ssrs",          aliases: ["hasssrs", "ssrs", "reportingservices"] },
  { key: "distributor",   aliases: ["isreplicationdistributor", "isdistributor", "distributor"] },
  { key: "fci",           aliases: ["isfailovercluster", "isclustered", "failovercluster"] },
  { key: "alwaysOn",      aliases: ["isalwaysonenabled", "alwayson", "hadrenabled"] },
  { key: "agCount",       aliases: ["availabilitygroupcount", "agcount"] },
  { key: "dbMail",        aliases: ["hasdatabasemail", "databasemail"] },
  { key: "proxies",       aliases: ["agentproxycount", "proxycount"] },
];

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function autoMap(headers) {
  const map = {};
  const used = new Set();
  const all = [...FIELDS, ...FEATURES.map(f => ({ key: "f_" + f.key, aliases: f.aliases })),
                          ...INSTANCE_FIELDS.map(f => ({ key: "i_" + f.key, aliases: f.aliases }))];
  for (const f of all) {
    const hit = headers.find(h => !used.has(h) && f.aliases.includes(norm(h)));
    if (hit) { map[f.key] = hit; used.add(hit); }
  }
  return map;
}

const truthy = (v) => {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y" || s === "t" || s === "on" || s === "enabled";
};

function numOf(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ""));
  return isNaN(n) ? null : n;
}

function majorFrom(row) {
  const pv = String(row.productver || "");
  const m = pv.match(/^(\d+)\./);
  if (m) return parseInt(m[1], 10);
  const v = String(row.version || "");
  const y = v.match(/(2000|2005|2008|2012|2014|2016|2017|2019|2022|2025)/);
  if (y) {
    const map = { "2000": 8, "2005": 9, "2008": 10, "2012": 11, "2014": 12,
                  "2016": 13, "2017": 14, "2019": 15, "2022": 16, "2025": 17 };
    return map[y[1]];
  }
  return null;
}

function editionKind(ed) {
  const s = String(ed || "").toLowerCase();
  if (s.includes("enterprise") || s.includes("developer")) return "Enterprise";
  if (s.includes("standard")) return "Standard";
  if (s.includes("express")) return "Express";
  if (s.includes("web")) return "Web";
  return "Standard";
}

/* Everything is priced as production. The collector cannot tell a dev database
   from a production one, and rather than invite a human to annotate the CSV we
   keep the inventory purely machine-generated and price conservatively. */

/* Signals the collector reports but which can legitimately come back empty — a
   recently restarted instance has no ring-buffer CPU history, for example.
   Surfaced on the summary so a fallback is never mistaken for a measurement. */
function dataCoverage() {
  const n = S.rows.length || 1;
  const has = (f) => S.rows.filter(f).length;
  return [
    { key: "cores", label: "Cores",
      n: has(r => r.cores > 0),
      effect: "sizing falls back to the minimum vCore count — right-sizing has nothing to reduce" },
    { key: "memoryGb", label: "Memory",
      n: has(r => r.memoryGb > 0),
      effect: "VM selection cannot honour a memory requirement" },
    { key: "sizeGb", label: "Database size",
      n: has(r => r.sizeGb > 0),
      effect: "storage cost and the size-based target limits cannot be evaluated" },
  ].map(f => ({ ...f, total: S.rows.length, pct: 100 * f.n / n, kind: "missing" }));
}

/* ---------------------------------------------------------------------------
   4. Target-fit rules engine
   --------------------------------------------------------------------------- */
const TARGETS = {
  sqldb: { name: "Azure SQL Database",       short: "SQL DB", managed: 3 },
  sl:    { name: "SQL DB Serverless",        short: "Serverless", managed: 3 },
  hs:    { name: "SQL DB Hyperscale",        short: "Hyperscale", managed: 3 },
  mi:    { name: "SQL Managed Instance",     short: "SQL MI", managed: 2 },
  vm:    { name: "SQL Server on Azure VM",   short: "SQL VM", managed: 1 },
};

/* Provisionable vCore sizes. These are not a generic ladder: Managed Instance
   on standard-series (Gen5) offers only these counts, and a quote at 6 or 12
   vCores is not something the customer can actually buy.
   learn.microsoft.com/azure/azure-sql/managed-instance/resource-limits */
const VCORE_STEPS = {
  mi:    [4, 8, 16, 24, 32, 40, 64, 80],       // Gen5 GP and BC; 2 only in instance pools
  sqldb: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 40, 80],
  hs:    [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 40, 80],
  sl:    [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 40, 80],
  vm:    [2, 4, 8, 16, 32, 48, 64],
};

/* Azure Hybrid Benefit converts owned on-premises cores into an ENTITLEMENT to
   run a number of vCores at the base (compute-only) rate. It is not a blanket
   discount — beyond the entitlement, vCores pay the licence-included rate.

   learn.microsoft.com/azure/azure-sql/azure-hybrid-benefit
     Enterprise + SA:  1 core -> 4 vCores General Purpose,  1 core -> 1 vCore Business Critical
     Standard   + SA:  1 core -> 1 vCore General Purpose,  4 cores -> 1 vCore Business Critical

   AHB does not apply to the serverless compute tier or the DTU model. */
const AHB_RATIO = {
  Enterprise: { gp: 4,    bc: 1 },
  Standard:   { gp: 1,    bc: 0.25 },
};

function ahbVcoreEntitlement(cores, edition, tier) {
  if (!A.sqlAhb || !A.onPremHasSA || !cores) return 0;
  const r = AHB_RATIO[editionKind(edition) === "Enterprise" ? "Enterprise" : "Standard"];
  return cores * (tier === "bc" ? r.bc : r.gp);
}

/* Each rule: which targets it rules out, and why. */
const RULES = [
  { id: "filestream",  test: r => r.f.fileStream,   blocks: ["sqldb", "hs", "mi"], why: "FILESTREAM is not supported on Azure SQL Database or Managed Instance" },
  { id: "filetable",   test: r => r.f.fileTable,    blocks: ["sqldb", "hs", "mi"], why: "FileTable is not supported on Azure SQL Database or Managed Instance" },
  { id: "external",    test: r => r.f.external,     blocks: ["sqldb", "hs", "mi"], why: "PolyBase / external tables require SQL Server on a VM" },
  { id: "mergerepl",   test: r => r.f.mergePub,     blocks: ["sqldb", "hs", "mi"], why: "Merge replication is not supported on Azure SQL PaaS" },
  { id: "distributor", test: r => r.i.distributor,  blocks: ["sqldb", "hs"],       why: "Replication distributor role requires Managed Instance or VM" },
  { id: "txpub",       test: r => r.f.published,    blocks: ["sqldb", "hs"],       why: "Azure SQL Database cannot act as a replication publisher — Managed Instance or VM required" },
  { id: "ssrs",        test: r => r.i.ssrs,         blocks: ["sqldb", "hs", "mi"], why: "SSRS report server databases require SQL Server on a VM" },
  { id: "ssis",        test: r => r.i.ssis,         blocks: ["sqldb", "hs"],       why: "SSIS catalog (SSISDB) requires Managed Instance or VM" },
  { id: "clr",         test: r => r.f.clr,          blocks: ["sqldb", "hs"],       why: "SQLCLR assemblies require Managed Instance or VM" },
  { id: "broker",      test: r => r.f.broker,       blocks: ["sqldb", "hs"],       why: "Service Broker requires Managed Instance or VM" },
  { id: "crossdb",     test: r => r.f.crossDb,      blocks: ["sqldb", "hs"],       why: "Cross-database queries require Managed Instance or VM" },
  { id: "linked",      test: r => r.f.linkedSrvDep, blocks: ["sqldb", "hs"],       why: "Linked-server references require Managed Instance or VM" },
  { id: "agentjobs",   test: r => (r.i.agentJobs || 0) > 0, blocks: ["sqldb", "hs"], why: "SQL Agent jobs require Managed Instance or VM (or rework as Elastic Jobs)" },
  { id: "cdc",         test: r => r.f.cdc,          blocks: [],                    why: "" },
  { id: "memopt_hs",   test: r => r.f.memOpt,       blocks: ["hs"],                why: "In-Memory OLTP is not available on Hyperscale" },
  // Serverless is General Purpose / Hyperscale only, standard-series hardware only.
  // learn.microsoft.com/azure/azure-sql/database/serverless-tier-overview
  { id: "sl_memopt",   test: r => r.f.memOpt,       blocks: ["sl"],                why: "In-Memory OLTP needs Business Critical, which the serverless compute tier does not offer" },
  { id: "sl_bc",       test: r => r.i.fci || r.i.alwaysOn || r.f.inAg, blocks: ["sl"], why: "Always On / clustering implies Business Critical, which serverless does not offer" },
  { id: "sl_size",     test: r => r.sizeGb > 4096,  blocks: ["sl"],                why: "Database exceeds the 4 TB serverless General Purpose limit" },
  { id: "size_db",     test: r => r.sizeGb > 4096,  blocks: ["sqldb"],             why: "Database exceeds the 4 TB single-database limit — use Hyperscale, MI or VM" },
  { id: "size_mi",     test: r => r.sizeGb > 16384, blocks: ["mi"],                why: "Database exceeds the 16 TB Managed Instance limit" },
];

/* Non-blocking concerns: the database can move to this target, but something
   needs attention first. This is the "Ready with warnings" category used by the
   migration readiness assessment in SSMS — see
   learn.microsoft.com/ssms/migrate/migrate-sql-server-azure-sql */
const WARNINGS = [
  { id: "w_cdc",      test: r => r.f.cdc,          warns: ["sqldb", "hs", "mi"], why: "Change data capture must be re-enabled after migration, and needs General Purpose or above on Azure SQL Database" },
  { id: "w_ct",       test: r => r.f.changeTrack,  warns: ["sqldb", "hs", "mi"], why: "Change tracking must be re-enabled on the target after migration" },
  { id: "w_fulltext", test: r => r.f.fullText,     warns: ["sqldb", "hs", "mi"], why: "Full-text search is supported, but custom word breakers, thesaurus files and filters do not carry over" },
  { id: "w_tde",      test: r => r.f.tde,          warns: ["sqldb", "hs", "mi"], why: "TDE is supported but key management changes — plan for service-managed or customer-managed keys in Key Vault" },
  { id: "w_txpub_mi", test: r => r.f.published,    warns: ["mi"],                why: "Replication publishing must be reconfigured against the Managed Instance after migration" },
  { id: "w_sub",      test: r => r.f.subscribed,   warns: ["sqldb", "hs", "mi"], why: "Replication subscriptions must be recreated; Azure SQL Database can only be a push subscriber" },
  { id: "w_memopt",   test: r => r.f.memOpt,       warns: ["sqldb", "mi"],       why: "In-Memory OLTP requires a Business Critical or Premium service tier on the target" },
  { id: "w_colstore", test: r => r.f.columnStore,  warns: ["sqldb"],             why: "Columnstore indexes are not available on Basic or Standard S0–S2 service objectives" },
  { id: "w_compat",   test: r => r.compat && r.compat < 100, warns: ["sqldb", "hs", "mi"], why: "Compatibility level is below 100 and must be raised — Azure SQL supports 100 and above" },
  { id: "w_broker",   test: r => r.f.broker,       warns: ["mi"],                why: "Service Broker works on Managed Instance, but cross-instance conversations do not" },
  { id: "w_hadr",     test: r => r.i.alwaysOn || r.f.inAg || r.i.fci, warns: ["sqldb", "hs", "mi"], why: "Always On and failover clustering are replaced by built-in HA — use Business Critical and auto-failover groups" },
  { id: "w_dbmail",   test: r => r.i.dbMail,       warns: ["sqldb", "hs"],       why: "Database Mail is not available on Azure SQL Database — rework to Logic Apps or an external mail service" },
  { id: "w_linked",   test: r => (r.i.linkedServers || 0) > 0, warns: ["mi"],    why: "Linked servers on Managed Instance can only target SQL Server and Azure SQL" },
  { id: "w_eol_vm",   test: r => r.support && (r.support.state === "eol" || r.support.state === "esu"), warns: ["vm"], why: "Lifting this version as-is to a VM carries an unsupported SQL Server build — plan an in-place upgrade" },
];

const READINESS = {
  ready:   { label: "Ready",        pill: "green" },
  warn:    { label: "Needs review", pill: "amber" },
  blocked: { label: "Not ready",    pill: "red" },
};

/* Readiness for one target, in the same three categories SSMS reports. */
function readinessFor(r, target) {
  if (r.blocked?.[target]?.length) return "blocked";
  if (r.warned?.[target]?.length) return "warn";
  return "ready";
}

function evaluateRow(r) {
  const empty = () => Object.fromEntries(Object.keys(TARGETS).map(k => [k, []]));
  const blocked = empty();
  const warned  = empty();
  const fired = [];
  const warnFired = [];
  for (const rule of RULES) {
    let hit = false;
    try { hit = !!rule.test(r); } catch { hit = false; }
    if (!hit || !rule.blocks.length) continue;
    fired.push(rule);
    for (const t of rule.blocks) blocked[t].push(rule.why);
  }
  for (const rule of WARNINGS) {
    let hit = false;
    try { hit = !!rule.test(r); } catch { hit = false; }
    if (!hit) continue;
    warnFired.push(rule);
    // A blocker outranks a warning: no point telling someone to plan around a
    // feature on a target they cannot use at all.
    for (const t of rule.warns) if (!blocked[t].length) warned[t].push(rule.why);
  }
  // Most-managed target with no blockers wins. Hyperscale is only proposed for
  // large databases — otherwise plain SQL DB is the simpler choice.
  const order = ["sqldb", "hs", "mi", "vm"];
  let rec = "vm";
  for (const t of order) {
    if (blocked[t].length) continue;
    if (t === "hs" && r.sizeGb <= 4096) continue;
    rec = t; break;
  }
  return { blocked, warned, fired, warnFired, rec };
}

/* Service tier: Business Critical where the estate signals it needs it. */
function tierFor(r, target) {
  if (target === "vm" || target === "hs" || target === "sl") return "gp";
  // Business Critical on standard-series tops out at 4 TB of instance storage, so
  // a database above that cannot be placed there however much it wants the tier.
  // learn.microsoft.com/azure/azure-sql/managed-instance/resource-limits
  if (target === "mi" && r.sizeGb > 4096) return "gp";
  const needsBc = r.f.memOpt || r.i.fci || r.i.alwaysOn || r.f.inAg ||
                  editionKind(r.edition) === "Enterprise";
  return needsBc ? "bc" : "gp";
}

/* Sizing is a deliberate, visible judgement rather than an inferred one.

   The alternative was to right-size from collected CPU, but the evidence is too
   uneven to carry that weight: Query Store is off on most estates, and the
   scheduler ring buffer covers only the last few hours of a single instance. A
   number derived from four hours of idle sampling looks measured and is not.

   So: take the source core count, cut it by an explicit percentage the user sets
   and can defend, then round UP to a size the target can actually be provisioned
   at — which differs per platform. 20% is the default because SQL Server estates
   are routinely provisioned for a peak that never arrives. */
function vcoresFor(r, target) {
  const base = r.cores || A.minVcores;
  let v = base * (1 - (A.rightSizePct || 0) / 100);
  v = Math.max(A.minVcores, v);
  const steps = VCORE_STEPS[target] || VCORE_STEPS.sqldb;
  return steps.find(s => s >= v) || steps[steps.length - 1];
}

/* ---------------------------------------------------------------------------
   5. Sizing
   --------------------------------------------------------------------------- */
/* Query Store gives per-database CPU over a real window — 30 days by default,
   against the ring buffer's four hours. It is not used to size anything: it is
   reported as evidence so the right-sizing percentage can be argued from
   something, rather than being a number pulled out of the air. */
function qsCoresFor(r) {
  if (r.qsCores == null || !(r.qsWindowHrs > 1)) return null;
  return r.qsCores;
}

const VM_CATALOG = [
  { sku: "Standard_E2bds_v5", vcpu: 2, memGb: 16 }, { sku: "Standard_E4bds_v5", vcpu: 4, memGb: 32 },
  { sku: "Standard_E8bds_v5", vcpu: 8, memGb: 64 }, { sku: "Standard_E16bds_v5", vcpu: 16, memGb: 128 },
  { sku: "Standard_E32bds_v5", vcpu: 32, memGb: 256 }, { sku: "Standard_E48bds_v5", vcpu: 48, memGb: 384 },
  { sku: "Standard_E64bds_v5", vcpu: 64, memGb: 512 },
];

function vmFor(vcores, memGb) {
  return VM_CATALOG.find(v => v.vcpu >= vcores && (!memGb || v.memGb >= memGb * 0.75)) ||
         VM_CATALOG[VM_CATALOG.length - 1];
}

const DISK_CATALOG = [
  { sku: "P4", gb: 32 }, { sku: "P6", gb: 64 }, { sku: "P10", gb: 128 }, { sku: "P15", gb: 256 },
  { sku: "P20", gb: 512 }, { sku: "P30", gb: 1024 }, { sku: "P40", gb: 2048 },
  { sku: "P50", gb: 4096 }, { sku: "P60", gb: 8192 }, { sku: "P70", gb: 16384 }, { sku: "P80", gb: 32767 },
];

function disksFor(gb) {
  const out = [];
  let remaining = gb;
  let guard = 0;
  while (remaining > 0 && guard++ < 40) {
    const d = DISK_CATALOG.find(x => x.gb >= remaining) || DISK_CATALOG[DISK_CATALOG.length - 1];
    out.push(d);
    remaining -= d.gb;
  }
  return out.length ? out : [DISK_CATALOG[0]];
}

/* ---------------------------------------------------------------------------
   6. Cost model
   --------------------------------------------------------------------------- */
function px() { return PRICES.regions?.[A.region] || {}; }

/* Returns the BASE (compute-only) rate. The licence component is added by
   costRow() against the portion of vCores not covered by an AHB entitlement,
   so it must not be folded in here. */
function paasRate(target, tier) {
  const p = px();
  const key = target === "mi" ? (tier === "bc" ? "mi_bc_gen5" : "mi_gp_gen5")
            : target === "hs" ? "db_hs_gen5"
            : (tier === "bc" ? "db_bc_gen5" : "db_gp_gen5");
  if (A.term === "ri1y")      return p.ri?.[key + "_1y"] ?? p.paas?.[key] ?? 0;
  if (A.term === "ri3y")      return p.ri?.[key + "_3y"] ?? p.paas?.[key] ?? 0;
  return p.paas?.[key] ?? 0;
}

function storageRate(target, tier) {
  const s = px().storage || {};
  if (target === "mi") return tier === "bc" ? (s.mi_bc_per_gb_mo ?? 0.25) : (s.mi_gp_per_gb_mo ?? 0.115);
  if (target === "hs") return s.db_hs_per_gb_mo ?? 0.08;
  return tier === "bc" ? (s.db_bc_per_gb_mo ?? 0.25) : (s.db_gp_per_gb_mo ?? 0.115);
}

/* Reserved-instance discounts for VM compute. The retail API exposes VM
   reservations under separate meters; we apply published indicative ratios so
   the term toggle stays meaningful for VM targets too. */
const VM_RI_FACTOR = { payg: 1, ri1y: 0.58, ri3y: 0.38 };

/* Per-database cost. For SQL Database each database is billed independently, but
   Managed Instance and SQL-on-VM are INSTANCE-level products: every database on
   one source instance lands on a single MI/VM, so compute must be charged once
   and shared, not billed per database. computeEstate() handles that grouping;
   this function prices a standalone deployment. */
function costRow(r, share, forceTarget) {
  const target = forceTarget || r.override || r.rec;
  const tier = tierFor(r, target);
  const vcores = vcoresFor(r, target);
  const storeGb = Math.max(1, Math.ceil((r.sizeGb || 1) * (1 + A.storageOverheadPct / 100)));
  const hours = A.hoursPerMonth;

  let compute = 0, storage = 0, license = 0, detail = "", shared = false, groupVcores = vcores;

  if (target === "vm") {
    const vm = vmFor(vcores, r.memoryGb);
    const vmp = px().vm?.[vm.sku] || {};
    const osLinux = String(r.os || "").toLowerCase().includes("linux");
    // Windows AHB removes the Windows licence component -> use the Linux rate.
    const rate = (osLinux || A.winAhb) ? (vmp.linux ?? 0) : (vmp.windows ?? vmp.linux ?? 0);
    compute = rate * hours * VM_RI_FACTOR[A.term];

    if (!A.sqlAhb) {
      const perCore = editionKind(r.edition) === "Enterprise" ? A.vmSqlEntPerCoreHr : A.vmSqlStdPerCoreHr;
      license = perCore * vm.vcpu * hours;
    }
    const disks = disksFor(storeGb);
    const dp = px().storage?.premium_ssd_lrs_per_disk_mo || {};
    storage = disks.reduce((a, d) => a + (dp[d.sku] ?? 0), 0);
    detail = `${vm.sku} · ${vm.vcpu} vCPU / ${vm.memGb} GB · ${disks.length}× ${disks[0].sku}`;
    groupVcores = vm.vcpu;

  } else if (target === "sl") {
    // Serverless bills per second on vCores actually used, and drops to storage
    // only while paused. Azure Hybrid Benefit does not apply, so the published
    // rate already includes the licence — no uplift and no entitlement offset.
    // learn.microsoft.com/azure/azure-sql/database/serverless-tier-overview
    const activeHrs = hours * (A.serverlessActivePct / 100);
    compute = (px().paas?.db_sl_gen5 ?? 0) * vcores * activeHrs;
    storage = storageRate("sqldb", "gp") * storeGb;
    detail = `Serverless · General Purpose · up to ${vcores} vCore · ${A.serverlessActivePct}% active`;

  } else {
    // Provisioned PaaS. AHB is an entitlement earned from owned cores, not a
    // blanket discount: vCores inside the entitlement pay the base rate, and
    // anything beyond it pays the licence-included rate.
    const baseRate = paasRate(target, tier);
    const entitled = Math.min(vcores, ahbVcoreEntitlement(r.cores, r.edition, tier));
    const uplift = tier === "bc" ? A.paasLicUpliftBc : A.paasLicUpliftGp;
    compute = baseRate * vcores * hours;
    license = uplift * Math.max(0, vcores - entitled) * hours;
    storage = storageRate(target, tier) * storeGb;
    const tierName = target === "hs" ? "Hyperscale" : (tier === "bc" ? "Business Critical" : "General Purpose");
    detail = `${TARGETS[target].short} · ${tierName} · ${vcores} vCore`
           + (entitled > 0 ? ` · AHB covers ${Math.floor(entitled)}` : "");
  }

  // Shared deployment: this row carries only its slice of the instance compute.
  if (share) {
    compute *= share.frac;
    license *= share.frac;
    shared = true;
    detail = `${share.detail} · shared (${FMT.pct(share.frac * 100)})`;
  }

  let total = compute + storage + license;

  return { target, tier, vcores, groupVcores, storeGb, compute, storage, license, total, detail, shared };
}

/* Prices the whole estate, consolidating instance-level targets (MI and VM)
   so a source instance's databases share one deployment. */
function computeEstate() {
  // First pass: resolve each row's target so grouping can see it.
  for (const r of S.rows) r._target = r.override || r.rec;

  const groups = {};
  for (const r of S.rows) {
    if (r._target !== "mi" && r._target !== "vm") continue;
    if (!A.consolidateToMi) continue;
    const key = r.instKey + "|" + r._target + "|" + tierFor(r, r._target);
    (groups[key] ||= []).push(r);
  }

  const handled = new Set();
  for (const key in groups) {
    const g = groups[key];
    if (g.length < 2) continue;               // single database: no sharing to model

    // Size the shared deployment from the instance, not the sum of its databases.
    const lead = g.reduce((a, b) => (b.sizeGb || 0) > (a.sizeGb || 0) ? b : a, g[0]);
    const proto = costRow(lead);
    const totalSize = g.reduce((a, r) => a + (r.sizeGb || 0), 0) || 1;

    for (const r of g) {
      const frac = (r.sizeGb || 0) / totalSize;
      r.cost = costRow(r, { frac, detail: proto.detail });
      r.cost.groupVcores = proto.groupVcores;
      handled.add(r);
    }
  }

  for (const r of S.rows) if (!handled.has(r)) r.cost = costRow(r);
}

/* Prices the whole estate under a modernization appetite. The appetite is a
   FLOOR on how managed a platform the customer is willing to accept, not an
   exclusive choice: "balanced" means Managed Instance wherever a database can
   reach it and SQL-on-VM for the rest, so every database is housed and the three
   options are directly comparable.

   Costing only the eligible databases per platform would understate the managed
   options, because the databases they cannot take still have to run somewhere. */
function estateCostForAppetite(appetite) {
  const ladder = appetite === "vm"    ? ["vm"]
               : appetite === "mi"    ? ["mi", "vm"]
               :                        ["sqldb", "hs", "mi", "vm"];

  const placed = S.rows.map(r => {
    for (const t of ladder) {
      if (r.blocked[t]?.length) continue;
      if (t === "hs" && r.sizeGb <= 4096) continue;
      return { r, target: t };
    }
    return { r, target: "vm" };      // VM is the universal fallback
  });

  // Instance-level products share one deployment per source instance.
  let monthly = 0;
  const groups = {};
  const singles = [];
  for (const p of placed) {
    if ((p.target === "mi" || p.target === "vm") && A.consolidateToMi) {
      (groups[p.r.instKey + "|" + p.target + "|" + tierFor(p.r, p.target)] ||= []).push(p);
    } else singles.push(p);
  }
  for (const p of singles) monthly += costRow(p.r, null, p.target).total;
  for (const k in groups) {
    const g = groups[k];
    if (g.length < 2) { monthly += costRow(g[0].r, null, g[0].target).total; continue; }
    const lead = g.reduce((a, b) => (b.r.sizeGb || 0) > (a.r.sizeGb || 0) ? b : a, g[0]);
    const proto = costRow(lead.r, null, lead.target);
    const totalSize = g.reduce((a, p) => a + (p.r.sizeGb || 0), 0) || 1;
    for (const p of g) {
      monthly += costRow(p.r, { frac: (p.r.sizeGb || 0) / totalSize, detail: proto.detail }, p.target).total;
    }
  }

  const mix = {};
  for (const p of placed) mix[p.target] = (mix[p.target] || 0) + 1;
  return { monthly, mix, placed };
}

/* What the estate would cost if it all went to ONE target, counting only the
   databases that can actually land there. Mirrors the sharing rule above: MI and
   VM are instance-level, so their databases share a deployment. Used by the
   per-target cards, which compare platforms the way the Azure portal assessment
   does rather than only pricing the recommended plan. */
function estateCostForTarget(target) {
  const eligible = S.rows.filter(r => !r.blocked[target]?.length);
  if (!eligible.length) return { monthly: 0, dbs: 0 };

  let monthly = 0;
  if (target === "mi" || target === "vm") {
    const groups = {};
    for (const r of eligible) (groups[r.instKey + "|" + tierFor(r, target)] ||= []).push(r);
    for (const k in groups) {
      const g = groups[k];
      if (g.length < 2 || !A.consolidateToMi) {
        for (const r of g) monthly += costRow(r, null, target).total;
        continue;
      }
      const lead = g.reduce((a, b) => (b.sizeGb || 0) > (a.sizeGb || 0) ? b : a, g[0]);
      const proto = costRow(lead, null, target);
      const totalSize = g.reduce((a, r) => a + (r.sizeGb || 0), 0) || 1;
      for (const r of g) {
        monthly += costRow(r, { frac: (r.sizeGb || 0) / totalSize, detail: proto.detail }, target).total;
      }
    }
  } else {
    for (const r of eligible) monthly += costRow(r, null, target).total;
  }
  return { monthly, dbs: eligible.length };
}

/* On-prem baseline: SA renewal + ESU where out of support. Licence cost is
   attributed per instance (not per database) and split across its databases. */
function onPremInstanceCost(rows) {
  const r0 = rows[0];
  const cores = Math.max(4, r0.cores || 4);          // SQL Server core-licence minimum
  const packs = Math.ceil(cores / 2);
  const isEnt = editionKind(r0.edition) === "Enterprise";
  const listPerPack = isEnt ? A.licEntPer2Core : A.licStdPer2Core;
  const licList = packs * listPerPack;

  const saYr = A.onPremHasSA ? licList * (A.saPctOfLicense / 100) : 0;
  const sup = supportState(majorFrom(r0));
  // ESU is only purchasable with active SA (or through Arc), so without SA there
  // is no ESU line either — the exposure is that the estate simply runs unpatched.
  const esuYr = (A.onPremHasSA && (sup.state === "esu" || sup.state === "eol"))
    ? licList * (A.esuPctOfLicense / 100) : 0;
  const hwYr = (A.onPremHwPerCoreYr || 0) * cores;

  return { cores, packs, isEnt, licList, saYr, esuYr, hwYr, totalYr: saYr + esuYr + hwYr, sup };
}
