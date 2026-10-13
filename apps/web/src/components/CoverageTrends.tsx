import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import {
  buildCoverageTrend,
  shortAppName,
  type AppGroup,
  type CoverageHistoryEntry,
  type CoverageTrend,
  type CoverageTrendMetric
} from "@qa-buddy/shared";
import { api } from "../api";

/** Validated categorical order; past this many apps, lines fall back to gray. */
const seriesColors = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const metricLabels: Record<CoverageTrendMetric, string> = {
  branches: "Branches",
  functions: "Functions",
  lines: "Lines",
  statements: "Statements",
  max: "Max",
  min: "Min"
};
const metricOrder: CoverageTrendMetric[] = ["branches", "functions", "lines", "statements"];
/** Combined views, kept visually apart from the real metrics. */
const combinedMetrics: CoverageTrendMetric[] = ["max", "min"];
const metricTitles: Record<CoverageTrendMetric, string> = {
  branches: "Share of decision paths taken, such as both sides of an if/else or each switch case. Usually the strictest measure.",
  functions: "Share of functions and methods called at least once.",
  lines: "Share of executable source lines run at least once.",
  statements: "Share of statements executed. Close to lines, but counts each statement when several share a line.",
  max: "Each app's highest of the four metrics, weighted by line count. Optimistic by design.",
  min: "Each app's lowest of the four metrics, weighted by line count. Pessimistic by design."
};
const height = 260;
const margin = { top: 14, right: 64, bottom: 30, left: 44 };

function niceDomain(values: number[]): { min: number; max: number; ticks: number[] } {
  if (values.length === 0) return { min: 0, max: 100, ticks: [0, 25, 50, 75, 100] };
  let min = Math.max(0, Math.floor((Math.min(...values) - 2) / 5) * 5);
  let max = Math.min(100, Math.ceil((Math.max(...values) + 2) / 5) * 5);
  if (max - min < 10) {
    if (max + 5 <= 100) max += 5;
    if (max - min < 10) min = Math.max(0, max - 10);
  }
  const step = [5, 10, 20, 25].find((candidate) => (max - min) / candidate <= 5) ?? 25;
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let tick = min; tick <= max; tick += step) ticks.push(tick);
  return { min, max, ticks };
}

function linePath(values: Array<number | null>, x: (index: number) => number, y: (value: number) => number) {
  let path = "";
  let drawing = false;
  values.forEach((value, index) => {
    if (value === null) {
      drawing = false;
      return;
    }
    path += `${drawing ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
    drawing = true;
  });
  return path;
}

/** Rounded, human length of the charted period; the exact range sits beneath it. */
export function formatSpan(from: string, to: string) {
  const days = Math.max(0, (Date.parse(to) - Date.parse(from)) / 86_400_000);
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  if (days < 1) return "Under a day";
  if (days < 14) return plural(Math.round(days), "day");
  if (days < 61) return plural(Math.round(days / 7), "week");
  if (days < 548) return plural(Math.round(days / 30.44), "month");
  return `${(Math.round((days / 365.25) * 10) / 10).toLocaleString()} years`;
}

export function formatDateRange(from: string, to: string) {
  const start = new Date(from);
  const end = new Date(to);
  const withYear = start.getFullYear() !== end.getFullYear() || end.getFullYear() !== new Date().getFullYear();
  const format = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) });
  return `${format.format(start)} – ${format.format(end)}`;
}

const shortDate = (value: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
const longDate = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const formatPercent = (value: number | null | undefined) => (value == null ? "—" : `${value.toFixed(1)}%`);
function formatDelta(value: number, unit: string) {
  const rounded = unit === "pts" ? Math.round(value * 10) / 10 : value;
  if (rounded === 0) return `No change`;
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toLocaleString()} ${unit}`;
}

function TrendChart({ trend, metric }: { trend: CoverageTrend; metric: CoverageTrendMetric }) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hovered, setHovered] = useState<number | null>(null);
  const [focusedApp, setFocusedApp] = useState<string | null>(null);

  useEffect(() => {
    const element = wrapper.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { points, apps } = trend;
  const colored = apps.length <= seriesColors.length;
  const totals = points.map((point) => point.total?.percent ?? null);
  const domain = niceDomain([...totals, ...apps.flatMap((app) => app.values)].filter((value): value is number => value !== null));
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const step = points.length > 1 ? plotWidth / (points.length - 1) : 0;
  const x = (index: number) => margin.left + (points.length > 1 ? index * step : plotWidth / 2);
  const y = (value: number) => margin.top + (1 - (value - domain.min) / (domain.max - domain.min)) * plotHeight;
  const labelCount = Math.min(points.length, Math.max(2, Math.floor(plotWidth / 110)));
  const labelIndexes = [...new Set(Array.from({ length: labelCount }, (_, index) =>
    labelCount === 1 ? 0 : Math.round((index * (points.length - 1)) / (labelCount - 1))
  ))];
  const lastTotalIndex = totals.length - 1 - [...totals].reverse().findIndex((value) => value !== null);
  const appColor = (index: number) => (colored ? seriesColors[index]! : "#d3d4de");
  const isDimmed = (appName: string) => focusedApp !== null && focusedApp !== appName;

  const pointerIndex = (event: PointerEvent<SVGRectElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - bounds.left;
    return points.length > 1 ? Math.min(points.length - 1, Math.max(0, Math.round(offset / step))) : 0;
  };
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current = hovered ?? (event.key === "ArrowLeft" ? points.length : -1);
    setHovered(Math.min(points.length - 1, Math.max(0, current + (event.key === "ArrowRight" ? 1 : -1))));
  };

  const active = hovered === null ? null : points[hovered]!;
  const tooltipApps =
    hovered === null
      ? []
      : apps
          .map((app, index) => ({ app, index, value: app.values[hovered] ?? null, source: app.sources[hovered] ?? null }))
          .filter(({ app, value }) => value !== null && (colored || app.appName === focusedApp));

  return (
    <div className="trend-chart" ref={wrapper}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${metricLabels[metric]} coverage over ${points.length} completed runs. Use the arrow keys to step through runs.`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setHovered(null)}
      >
        {domain.ticks.map((tick) => (
          <g key={tick}>
            <line className="trend-grid" x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />
            <text className="trend-axis" x={margin.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">{tick}%</text>
          </g>
        ))}
        {labelIndexes.map((index) => (
          <text key={index} className="trend-axis" x={x(index)} y={height - 8} textAnchor={points.length === 1 ? "middle" : index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}>
            {shortDate(points[index]!.recordedAt)}
          </text>
        ))}
        {apps.map((app, index) => (
          <path
            key={app.appName}
            className={`trend-line ${colored ? "" : "trend-line-muted"} ${isDimmed(app.appName) ? "trend-line-dimmed" : ""}`}
            d={linePath(app.values, x, y)}
            stroke={appColor(index)}
          />
        ))}
        {!colored && focusedApp && apps.filter((app) => app.appName === focusedApp).map((app) => (
          <path key={app.appName} className="trend-line trend-line-focused" d={linePath(app.values, x, y)} />
        ))}
        <path className="trend-line trend-line-total" d={linePath(totals, x, y)} />
        {totals.map((value, index) => value !== null && (
          <circle key={index} className="trend-total-dot" cx={x(index)} cy={y(value)} r={points.length > 40 ? 0 : 3} />
        ))}
        {lastTotalIndex < totals.length && (
          <text className="trend-direct-label" x={x(lastTotalIndex) + 8} y={y(totals[lastTotalIndex]!)} dy="0.32em">
            Total
          </text>
        )}
        {active && hovered !== null && (
          <g className="trend-hover" aria-hidden="true">
            <line className="trend-crosshair" x1={x(hovered)} x2={x(hovered)} y1={margin.top} y2={margin.top + plotHeight} />
            {tooltipApps.map(({ app, index, value }) => (
              <circle key={app.appName} cx={x(hovered)} cy={y(value!)} r={4} fill={colored ? appColor(index) : "var(--accent)"} />
            ))}
            {active.total?.percent != null && <circle cx={x(hovered)} cy={y(active.total.percent)} r={5} fill="var(--text)" />}
          </g>
        )}
        <rect
          className="trend-hit"
          x={margin.left - Math.max(step / 2, 12)}
          y={margin.top}
          width={plotWidth + Math.max(step, 24)}
          height={plotHeight}
          onPointerMove={(event) => setHovered(pointerIndex(event))}
          onPointerLeave={() => setHovered(null)}
        />
      </svg>
      {active && hovered !== null && (
        <div
          className="trend-tooltip"
          style={x(hovered) > width / 2 ? { right: width - x(hovered) + 12 } : { left: x(hovered) + 12 }}
          role="status"
        >
          <span className="trend-tooltip-date">{longDate(active.recordedAt)}</span>
          <span className="trend-tooltip-ref"><code>{active.useLocalWorkingTree ? "local working tree" : active.requestedRef}</code>{active.resolvedSha ? <code> · {active.resolvedSha.slice(0, 8)}{active.dirty ? "+dirty" : ""}</code> : null}</span>
          <span className="trend-tooltip-row trend-tooltip-total"><i style={{ background: "var(--text)" }} /><strong>{formatPercent(active.total?.percent)}</strong><span>Total</span></span>
          {tooltipApps.map(({ app, index, value, source }) => (
            <span key={app.appName} className="trend-tooltip-row"><i style={{ background: colored ? appColor(index) : "var(--accent)" }} /><strong>{formatPercent(value)}</strong><span title={app.appName}>{shortAppName(app.appName)}{source && source !== metric ? ` (${source})` : ""}{active.ranApps.some((name) => name.toLowerCase() === app.appName.toLowerCase()) ? "" : " (carried forward)"}</span></span>
          ))}
          <span className="trend-tooltip-foot">
            {active.testsTotal === null ? "No test counts" : `${active.testsTotal.toLocaleString()} tests`} · {active.ranApps.length} of {apps.length} {apps.length === 1 ? "app" : "apps"} ran
          </span>
        </div>
      )}
      <div className="trend-legend" aria-label="Chart legend">
        <span className="trend-legend-item trend-legend-total"><i style={{ background: "var(--text)" }} />Weighted total</span>
        {apps.map((app, index) => (
          <button
            type="button"
            key={app.appName}
            className={`trend-legend-item ${focusedApp === app.appName ? "selected" : ""} ${isDimmed(app.appName) ? "dimmed" : ""}`}
            aria-pressed={focusedApp === app.appName}
            title={app.appName}
            onClick={() => setFocusedApp((current) => (current === app.appName ? null : app.appName))}
          >
            <i style={{ background: colored ? appColor(index) : focusedApp === app.appName ? "var(--accent)" : "#b9bac7" }} />
            {shortAppName(app.appName)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function CoverageTrends({ repositoryId, groups, refreshKey }: { repositoryId: string; groups: AppGroup[]; refreshKey: string | null }) {
  const [entries, setEntries] = useState<CoverageHistoryEntry[] | null>(null);
  const [error, setError] = useState("");
  const [metric, setMetric] = useState<CoverageTrendMetric>("branches");
  const [groupId, setGroupId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ entries: CoverageHistoryEntry[] }>(`/api/repositories/${repositoryId}/coverage/history`)
      .then(({ entries: result }) => {
        if (cancelled) return;
        setEntries(result);
        setError("");
      })
      .catch((caught: Error) => !cancelled && setError(caught.message));
    return () => { cancelled = true; };
  }, [repositoryId, refreshKey]);

  const group = groups.find((candidate) => candidate.id === groupId) ?? null;
  const trend = entries ? buildCoverageTrend(entries, metric, group?.appNames ?? null) : null;
  const first = trend?.points.find((point) => point.total?.percent != null);
  const last = trend && [...trend.points].reverse().find((point) => point.total?.percent != null);
  const firstTestsPoint = trend?.points.find((point) => point.testsTotal !== null);
  const lastTests = (trend && [...trend.points].reverse().find((point) => point.testsTotal !== null)?.testsTotal) ?? null;

  return (
    <section className="panel detail-section coverage-trends">
      <div className="panel-heading">
        <div><span className="eyebrow">Completed runs</span><h2>Coverage trend</h2></div>
        <div className="filter-tabs" role="group" aria-label="Coverage metric">
          {[...metricOrder, ...combinedMetrics].map((name) => (
            <button
              type="button"
              key={name}
              className={`${metric === name ? "selected" : ""} ${name === combinedMetrics[0] ? "trend-metric-combined-start" : ""}`}
              aria-pressed={metric === name}
              title={metricTitles[name]}
              onClick={() => setMetric(name)}
            >
              {metricLabels[name]}
            </button>
          ))}
        </div>
      </div>
      <div className="trend-body">
        {groups.length > 0 && (
          <div className="trend-tabs" role="tablist" aria-label="Application group">
            {[{ id: null, name: "All" }, ...groups].map((tab) => (
              <button type="button" role="tab" key={tab.id ?? "all"} aria-selected={groupId === tab.id} className={groupId === tab.id ? "selected" : ""} onClick={() => setGroupId(tab.id)}>
                {tab.name}
              </button>
            ))}
          </div>
        )}
        {error && <p className="inline-error" role="alert">{error}</p>}
        {!trend ? (
          !error && <p className="empty-copy">Loading coverage history…</p>
        ) : trend.points.length === 0 ? (
          <p className="empty-copy">{group ? `No completed runs have reported coverage for ${group.name} yet.` : "Coverage history appears here once a run completes."}</p>
        ) : (
          <>
            <div className="trend-summary">
              <div>
                <span className="trend-summary-label">{metric === "max" || metric === "min" ? `${metricLabels[metric]} of four` : metricLabels[metric]} · {group?.name ?? "All apps"}</span>
                <strong>{formatPercent(last?.total?.percent)}</strong>
                <span>{first && last && first !== last ? `${formatDelta(last.total!.percent! - first.total!.percent!, "pts")} since ${shortDate(first.recordedAt)}` : "Trends appear after a second completed run"}</span>
              </div>
              <div>
                <span className="trend-summary-label">Tests</span>
                <strong>{lastTests === null ? "—" : lastTests.toLocaleString()}</strong>
                <span>{firstTestsPoint && lastTests !== null && trend.points.length > 1 ? `${formatDelta(lastTests - firstTestsPoint.testsTotal!, "tests")} since ${shortDate(firstTestsPoint.recordedAt)}` : "Across apps with test results"}</span>
              </div>
              <div>
                <span className="trend-summary-label">Time span</span>
                <strong>{trend.points.length > 1 ? formatSpan(trend.points[0]!.recordedAt, trend.points[trend.points.length - 1]!.recordedAt) : "—"}</strong>
                <span>{trend.points.length > 1 ? `${formatDateRange(trend.points[0]!.recordedAt, trend.points[trend.points.length - 1]!.recordedAt)} · ${trend.points.length} runs` : "1 completed run so far"}</span>
              </div>
            </div>
            <TrendChart key={`${groupId ?? "all"}-${metric}`} trend={trend} metric={metric} />
            <details className="trend-table">
              <summary>View as table</summary>
              <div className="table-scroll"><table className="history-table"><thead><tr><th>Completed</th><th>Ref</th><th>{metricLabels[metric]}</th><th>Tests</th><th>Apps run</th></tr></thead><tbody>
                {[...trend.points].reverse().map((point) => (
                  <tr key={point.runId}><td>{longDate(point.recordedAt)}</td><td><code>{point.useLocalWorkingTree ? "local working tree" : point.requestedRef}</code></td><td>{formatPercent(point.total?.percent)}</td><td>{point.testsTotal?.toLocaleString() ?? "—"}</td><td>{point.ranApps.length} of {trend.apps.length}</td></tr>
                ))}
              </tbody></table></div>
            </details>
          </>
        )}
      </div>
    </section>
  );
}
