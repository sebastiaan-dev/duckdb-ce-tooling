import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  Code2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  PackageCheck,
  RefreshCw,
  Search,
  Server,
  XCircle,
} from "lucide-react";
import { Status, type StatusKind } from "./status";
import { ApiPaths, type BinaryStatus, type CatalogResponse, type Extension } from "@ce-map/contracts";
import "./styles.css";

type Check = BinaryStatus;
type CheckStatus = Exclude<StatusKind, "checking" | "pending" | "recheck">;
type Catalog = CatalogResponse;
type ScanState = { active: boolean; completed: number; total: number; label: string };

const AUDIT_CACHE_KEY = "ce-map:audit-cache:v2";
const CLIENT_CACHE_TTL = 30 * 60_000;

const PAGE_SIZE = 15;
const keyFor = (extension: string, platform: string) => `${extension}/${platform}`;
const requestKey = (extension: Extension, platform: string) => `${extension.name}/${platform}/${extension.ref}/${extension.descriptorSha}`;
const isRecheckRequired = (check: Check | "checking" | undefined, extension: Extension) => Boolean(check && check !== "checking" && check.checkedDescriptorSha !== extension.descriptorSha);

function formatPlatform(platform: string) {
  return platform.replace("_", " · ").replace("amd64", "x64").replace("osx", "macOS");
}

function App() {
  const [catalog, setCatalog] = useState<Catalog>();
  const [checks, setChecks] = useState<Record<string, Check | "checking">>({});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | CheckStatus | "pending" | "recheck">("all");
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [scan, setScan] = useState<ScanState>({ active: false, completed: 0, total: 0, label: "" });
  const requested = useRef(new Set<string>());
  const scanController = useRef<AbortController | null>(null);
  const scanId = useRef(0);
  const fullScan = useRef(false);

  async function refreshCatalog(force = false) {
    setRefreshingCatalog(true);
    setError("");
    try {
      const response = await fetch(`${ApiPaths.catalog}${force ? "?refresh=1" : ""}`);
      const body = await response.json() as Catalog & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Catalog request failed");
      setCatalog(body);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load catalog");
    } finally {
      setRefreshingCatalog(false);
    }
  }

  useEffect(() => {
    void refreshCatalog();
  }, []);

  useEffect(() => {
    if (!catalog) return;
    try {
      const raw = window.localStorage.getItem(AUDIT_CACHE_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw) as { duckdbVersion?: string; entries?: Record<string, Check> };
      if (stored.duckdbVersion !== catalog.duckdbVersion || !stored.entries) return;
      const now = Date.now();
      const restored: Record<string, Check> = {};
      for (const extension of catalog.extensions) {
        for (const platform of extension.platforms) {
          const key = keyFor(extension.name, platform);
          const check = stored.entries[key];
          const checkedAt = Date.parse(check?.checkedAt ?? "");
          if (!check || !Number.isFinite(checkedAt) || now - checkedAt > CLIENT_CACHE_TTL) continue;
          restored[key] = check;
          if (!isRecheckRequired(check, extension)) requested.current.add(requestKey(extension, platform));
        }
      }
      setChecks((current) => ({ ...restored, ...current }));
    } catch {
      window.localStorage.removeItem(AUDIT_CACHE_KEY);
    }
  }, [catalog]);

  useEffect(() => {
    if (!catalog) return;
    const timeout = window.setTimeout(() => {
      const entries: Record<string, Check> = {};
      for (const [key, value] of Object.entries(checks)) {
        if (value !== "checking") entries[key] = value;
      }
      try {
        window.localStorage.setItem(AUDIT_CACHE_KEY, JSON.stringify({ duckdbVersion: catalog.duckdbVersion, entries }));
      } catch {
        // Local storage is an optimization; an unavailable or full store must not break audits.
      }
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [catalog, checks]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (catalog?.extensions ?? []).filter((extension) => {
      const matchesQuery = !normalized || extension.name.toLowerCase().includes(normalized) || extension.description.toLowerCase().includes(normalized) || extension.repo.toLowerCase().includes(normalized);
      if (!matchesQuery || filter === "all") return matchesQuery;
      return extension.platforms.some((platform) => {
        const check = checks[keyFor(extension.name, platform)];
        const needsRecheck = isRecheckRequired(check, extension);
        if (filter === "pending") return !check;
        if (filter === "recheck") return needsRecheck;
        return Boolean(check && check !== "checking" && !needsRecheck && check.status === filter);
      });
    });
  }, [catalog, checks, filter, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const availablePlatforms = useMemo(() => [...new Set((catalog?.extensions ?? []).flatMap((extension) => extension.platforms))], [catalog]);
  const platformGroups = ["linux", "osx", "windows", "wasm"].map((family) => ({
    family,
    platforms: availablePlatforms.filter((platform) => platform.startsWith(`${family}_`)),
  })).filter((group) => group.platforms.length);
  const platformColumns = platformGroups.flatMap((group) => group.platforms);


  useEffect(() => setPage(0), [filter, query]);
  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);

  function cancelAudit() {
    scanController.current?.abort();
    scanController.current = null;
    scanId.current += 1;
    fullScan.current = false;
    setChecks((current) => {
      const next: Record<string, Check | "checking"> = {};
      for (const [key, value] of Object.entries(current)) {
        if (value !== "checking") next[key] = value;
      }
      return next;
    });
    setScan((current) => ({ ...current, active: false, label: "Audit cancelled" }));
  }

  async function audit(keys: Array<{ extension: Extension; platform: string }>, force = false, label = "Checking visible page", scope: "page" | "all" = "page") {
    scanController.current?.abort();
    const controller = new AbortController();
    const run = scanId.current + 1;
    scanId.current = run;
    fullScan.current = scope === "all";
    scanController.current = controller;
    const queue = keys.filter(({ extension, platform }) => force || !requested.current.has(requestKey(extension, platform)));
    if (!queue.length) {
      setScan({ active: false, completed: 0, total: 0, label: "Already checked" });
      scanController.current = null;
      fullScan.current = false;
      return;
    }
    setChecks((current) => {
      const next = { ...current };
      for (const { extension, platform } of queue) next[keyFor(extension.name, platform)] = "checking";
      return next;
    });
    setScan({ active: true, completed: 0, total: queue.length, label });

    let cursor = 0;
    let completed = 0;
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (cursor < queue.length) {
        if (controller.signal.aborted || scanId.current !== run) return;
        const item = queue[cursor++];
        if (!item) return;
        const key = keyFor(item.extension.name, item.platform);
        try {
          const response = await fetch(`${ApiPaths.check}?extension=${encodeURIComponent(item.extension.name)}&platform=${encodeURIComponent(item.platform)}`, { signal: controller.signal });
          const result = await response.json() as Check & { error?: string };
          if (!response.ok) throw new Error(result.error ?? "Audit request failed");
          if (controller.signal.aborted || scanId.current !== run) return;
          requested.current.add(requestKey(item.extension, item.platform));
          completed += 1;
          setChecks((current) => ({ ...current, [key]: result }));
          setScan((current) => scanId.current === run ? { ...current, completed } : current);
        } catch (reason) {
          if (controller.signal.aborted || scanId.current !== run) return;
          requested.current.add(requestKey(item.extension, item.platform));
          completed += 1;
          setChecks((current) => ({ ...current, [key]: { status: "error", checkedDescriptorRef: item.extension.ref, checkedDescriptorSha: item.extension.descriptorSha, checkedAt: new Date().toISOString(), detail: reason instanceof Error ? reason.message : "Audit failed" } }));
          setScan((current) => scanId.current === run ? { ...current, completed } : current);
        }
      }
    }));
    if (scanId.current === run) {
      fullScan.current = false;
      scanController.current = null;
      setScan({ active: false, completed: queue.length, total: queue.length, label: `${label} complete` });
    }
  }

  useEffect(() => {
    if (fullScan.current) return;
    void audit(visible.flatMap((extension) => extension.platforms.map((platform) => ({ extension, platform }))));
  }, [catalog, page, query, filter]);

  const completed = Object.values(checks).filter((item): item is Check => item !== "checking");
  const counts = { current: 0, stale: 0, missing: 0, error: 0, recheck: 0 };
  for (const extension of catalog?.extensions ?? []) {
    for (const platform of extension.platforms) {
      const check = checks[keyFor(extension.name, platform)];
      if (!check || check === "checking") continue;
      if (isRecheckRequired(check, extension)) counts.recheck += 1;
      else counts[check.status] += 1;
    }
  }
  const totalBinaries = catalog?.extensions.reduce((sum, extension) => sum + extension.platforms.length, 0) ?? 0;

  function auditAll() {
    if (!catalog) return;
    if (scan.active) {
      cancelAudit();
      return;
    }
    void audit(
      catalog.extensions.flatMap((extension) => extension.platforms.map((platform) => ({ extension, platform }))),
      true,
      "Auditing full catalog",
      "all",
    );
  }

  function auditChanged() {
    if (!catalog || scan.active) return;
    const changed = catalog.extensions.flatMap((extension) => extension.platforms
      .map((platform) => ({ extension, platform }))
      .filter(({ extension, platform }) => isRecheckRequired(checks[keyFor(extension.name, platform)], extension)));
    void audit(changed, true, "Rechecking changed descriptors", "all");
  }
  const scanPercent = scan.total ? Math.round((scan.completed / scan.total) * 100) : 0;

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Community Extension Map home">
          <span className="brand__mark"><PackageCheck size={19} /></span>
          <span><strong>CE Map</strong><small>Binary observability</small></span>
        </a>
        <nav aria-label="Primary navigation">
          <a className="nav-item nav-item--active" href="#overview"><Box size={17} /> Overview</a>
          <a className="nav-item" href="https://github.com/duckdb/community-extensions/actions" target="_blank"><Server size={17} /> CI runs <ExternalLink size={13} /></a>
        </nav>
        <div className="sidebar__foot">
          <a href="https://github.com/duckdb/community-extensions" target="_blank"><Code2 size={16} /> duckdb/community-extensions</a>
          <span>Reads deployed binary metadata directly.</span>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div className="mobile-brand"><span className="brand__mark"><PackageCheck size={18} /></span><strong>CE Map</strong></div>
          <div className="release"><span className="release__dot" /> DuckDB {catalog?.duckdbVersion ?? "…"}</div>
          <a className="icon-button" href="https://github.com/duckdb/community-extensions" target="_blank" aria-label="Open repository"><Code2 size={18} /></a>
        </header>

        <div className="content" id="overview">
          <section className="heading">
            <div><p className="eyebrow">Deployment integrity</p><h1>Community extension binaries</h1><p>Compare every deployed platform artifact with the source commit pinned in its descriptor.</p></div>
            <div className="heading__actions">
              <button className="secondary-button" onClick={() => void refreshCatalog(true)} disabled={refreshingCatalog || scan.active}><RefreshCw size={15} className={refreshingCatalog ? "spin" : ""} /> {refreshingCatalog ? "Refreshing" : "Refresh descriptors"}</button>
              <button className="secondary-button" onClick={auditChanged} disabled={!catalog || scan.active || counts.recheck === 0}><RefreshCw size={15} /> Recheck changed ({counts.recheck})</button>
              <button className="primary-button" onClick={auditAll} disabled={!catalog}>
                <RefreshCw size={16} className={scan.active ? "spin" : ""} /> {scan.active ? "Cancel audit" : "Run full audit"}
              </button>
            </div>
          </section>

          {error && <div className="error-banner" role="alert"><AlertTriangle size={18} /> <span><strong>Catalog unavailable</strong>{error}</span></div>}

          <section className="metrics" aria-label="Audit summary">
            <Metric icon={<CheckCircle2 />} label="Up to date" value={counts.current} tone="green" />
            <Metric icon={<AlertTriangle />} label="Out of date" value={counts.stale} tone="amber" />
            <Metric icon={<RefreshCw />} label="Recheck required" value={counts.recheck} tone="blue" />
            <Metric icon={<XCircle />} label="Missing" value={counts.missing} tone="red" />
            <Metric icon={<CircleHelp />} label="Checked" value={`${completed.length} / ${totalBinaries || "–"}`} tone="neutral" />
          </section>

          <section className="panel">
            <div className="panel__head">
              <div><h2>Extension matrix</h2><p>{catalog ? `${filtered.length} of ${catalog.extensions.length} extensions` : "Loading descriptors…"}</p></div>
              <div className="controls">
                <label className="search"><Search size={16} /><span className="sr-only">Search extensions</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search extension or repo…" /></label>
                <label><span className="sr-only">Filter status</span><select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">All statuses</option><option value="current">Up to date</option><option value="stale">Out of date</option><option value="recheck">Recheck required</option><option value="missing">Missing</option><option value="error">Errors</option><option value="pending">Not checked</option></select></label>
              </div>
            </div>
            {scan.total > 0 && <div className={`scan-progress ${scan.active ? "scan-progress--active" : ""}`} aria-live="polite">
              <div className="scan-progress__bar"><span style={{ width: `${scanPercent}%` }} /></div>
              <span>{scan.label} · {scan.completed}/{scan.total}</span>
            </div>}

            <div className="table-wrap">
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th rowSpan={2}>Extension</th>
                    <th rowSpan={2}>Descriptor ref</th>
                    {platformGroups.map((group) => <th className="platform-family" colSpan={group.platforms.length} key={group.family}>{group.family === "osx" ? "macOS" : group.family}</th>)}
                    <th rowSpan={2}><span className="sr-only">Actions</span></th>
                  </tr>
                  <tr className="platform-headings">
                    {platformColumns.map((platform) => <th key={platform}>{platform.replace(/^[^_]+_/, "")}</th>)}
                  </tr>
</thead>
<tbody>
                  {visible.map((extension) => (
                    <tr key={extension.name}>
                      <td><div className="extension-name"><span className="extension-icon">{extension.name.slice(0, 2).toUpperCase()}</span><span><strong>{extension.name}</strong><small>{extension.repo || extension.description}</small></span></div></td>
                      <td><a className="sha" href={`https://github.com/${extension.repo}/commit/${extension.ref}`} target="_blank">{extension.ref.slice(0, 9)} <ExternalLink size={12} /></a></td>
                      {platformColumns.map((platform) => {
                        if (!extension.platforms.includes(platform)) return <td className="matrix-cell matrix-cell--na" title="Not targeted by this descriptor" key={platform}>—</td>;
                        const check = checks[keyFor(extension.name, platform)];
                        const needsRecheck = isRecheckRequired(check, extension);
                        const kind: StatusKind = !check ? "pending" : check === "checking" ? "checking" : needsRecheck ? "recheck" : check.status;
                        const title = !check ? formatPlatform(platform) : check === "checking" ? formatPlatform(platform) : needsRecheck ? `${formatPlatform(platform)}: descriptor changed since last check (${check.checkedDescriptorSha.slice(0, 9)} → ${extension.descriptorSha.slice(0, 9)})` : `${formatPlatform(platform)}: ${check.builtRef ? `built from ${check.builtRef}` : check.detail ?? check.status}`;
                        return <td className="matrix-cell" key={platform}><Status kind={kind} title={title}><span className="sr-only">{kind}</span></Status></td>;
                      })}
                      <td><button className="row-button" onClick={() => void audit(extension.platforms.map((platform) => ({ extension, platform })), true, `Checking ${extension.name}`)} aria-label={`Recheck ${extension.name}`}><RefreshCw size={15} /></button></td>
                    </tr>
                  ))}
                  {catalog && !visible.length && <tr><td colSpan={platformColumns.length + 3} className="empty">No extensions match this view.</td></tr>}
                </tbody>
              </table>
            </div>

            <div className="pagination"><span>Page {page + 1} of {pageCount}</span><div><button onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={page === 0} aria-label="Previous page"><ChevronLeft size={16} /></button><button onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} disabled={page >= pageCount - 1} aria-label="Next page"><ChevronRight size={16} /></button></div></div>
          </section>
        </div>
      </main>
    </div>
  );
}

function Metric({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number | string; tone: string }) {
  return <article className="metric"><span className={`metric__icon metric__icon--${tone}`}>{icon}</span><span><small>{label}</small><strong>{value}</strong></span></article>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
