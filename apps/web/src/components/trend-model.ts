import {
  trendMovers,
  trendReliability,
  type CoverageTrend,
  type CoverageTrendMetric,
  type CoverageTrendMover,
  type CoverageTrendPoint
} from "@qa-buddy/shared";

/**
 * Shared by the on-page chart and the exported image so the two always show
 * the same numbers and geometry.
 */

/** Validated categorical order; past this many apps, lines fall back to gray. */
export const seriesColors = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
export const mutedSeriesColor = "#d3d4de";

export const metricLabels: Record<CoverageTrendMetric, string> = {
  branches: "Branches",
  functions: "Functions",
  lines: "Lines",
  statements: "Statements",
  max: "Max",
  min: "Min"
};

export const isCombinedMetric = (metric: CoverageTrendMetric) => metric === "max" || metric === "min";
export const metricHeading = (metric: CoverageTrendMetric) =>
  isCombinedMetric(metric) ? `${metricLabels[metric]} of four` : metricLabels[metric];

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

export const shortDate = (value: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
export const longDate = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
export const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toLocaleString()}`;
export const formatPercent = (value: number | null | undefined) => (value == null ? "—" : `${value.toFixed(1)}%`);
export function formatDelta(value: number, unit: string) {
  const rounded = unit === "pts" ? Math.round(value * 10) / 10 : value;
  if (rounded === 0) return `No change`;
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toLocaleString()} ${unit}`;
}

export function niceDomain(values: number[]): { min: number; max: number; ticks: number[] } {
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

export function linePath(values: Array<number | null>, x: (index: number) => number, y: (value: number) => number) {
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

export interface ChartMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Scales and label positions for one chart size. */
export function chartLayout(trend: CoverageTrend, goal: number | null, width: number, height: number, margin: ChartMargin) {
  const { points, apps } = trend;
  const totals = points.map((point) => point.total?.percent ?? null);
  const domain = niceDomain([...totals, ...apps.flatMap((app) => app.values), goal].filter((value): value is number => value != null));
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const step = points.length > 1 ? plotWidth / (points.length - 1) : 0;
  const x = (index: number) => margin.left + (points.length > 1 ? index * step : plotWidth / 2);
  const y = (value: number) => margin.top + (1 - (value - domain.min) / (domain.max - domain.min)) * plotHeight;
  const labelCount = Math.min(points.length, Math.max(2, Math.floor(plotWidth / 110)));
  const labelIndexes = [...new Set(Array.from({ length: labelCount }, (_, index) =>
    labelCount === 1 ? 0 : Math.round((index * (points.length - 1)) / (labelCount - 1))
  ))];
  const labelAnchor = (index: number) =>
    points.length === 1 ? "middle" : index === 0 ? "start" : index === points.length - 1 ? "end" : "middle";
  const lastTotalIndex = totals.length - 1 - [...totals].reverse().findIndex((value) => value !== null);
  const colored = apps.length <= seriesColors.length;
  const appColor = (index: number) => (colored ? seriesColors[index]! : mutedSeriesColor);
  return { totals, domain, plotWidth, plotHeight, step, x, y, labelIndexes, labelAnchor, lastTotalIndex, colored, appColor };
}

export interface TrendStat {
  label: string;
  value: string;
  details: string[];
  /** Emphasised line, used for the goal. */
  note?: string;
  title?: string;
}

export interface TrendSummary {
  stats: TrendStat[];
  /** Null when there are fewer than two comparable points. */
  movers: { improved: CoverageTrendMover[]; declined: CoverageTrendMover[] } | null;
}

export function summarizeTrend(trend: CoverageTrend, metric: CoverageTrendMetric, scopeName: string, goal: number | null): TrendSummary {
  const { points } = trend;
  const first = points.find((point) => point.total?.percent != null);
  const last = [...points].reverse().find((point) => point.total?.percent != null);
  const comparable = Boolean(first && last && first !== last);
  const firstTestsPoint = points.find((point) => point.testsTotal !== null);
  const lastTests = [...points].reverse().find((point) => point.testsTotal !== null)?.testsTotal ?? null;
  const unit = metricLabels[metric].toLowerCase();
  const uncovered = (point: CoverageTrendPoint | undefined) => (point?.total ? point.total.total - point.total.covered : null);
  const growth = comparable && first!.total!.total ? ((last!.total!.total - first!.total!.total) / first!.total!.total) * 100 : null;
  const reliability = trendReliability(trend);
  const lastPercent = last?.total?.percent ?? null;

  const stats: TrendStat[] = [
    {
      label: `${metricHeading(metric)} · ${scopeName}`,
      value: formatPercent(lastPercent),
      details: [comparable ? `${formatDelta(lastPercent! - first!.total!.percent!, "pts")} since ${shortDate(first!.recordedAt)}` : "Only one completed run in this range"],
      note:
        goal === null || lastPercent === null
          ? undefined
          : lastPercent >= goal
            ? `Meets the ${goal}% goal`
            : `${(Math.round((goal - lastPercent) * 10) / 10).toLocaleString()} pts to ${goal}% goal`
    }
  ];
  if (!isCombinedMetric(metric)) {
    stats.push({
      label: `Uncovered ${unit}`,
      value: uncovered(last)?.toLocaleString() ?? "—",
      details: [
        comparable
          ? `${signed(uncovered(last)! - uncovered(first)!)} since ${shortDate(first!.recordedAt)} · codebase ${growth === null || Math.round(growth * 10) === 0 ? "unchanged" : `${signed(Math.round(growth * 10) / 10)}%`}`
          : `Of ${last?.total?.total.toLocaleString() ?? "—"} total ${unit}`
      ],
      title: comparable ? `Total ${unit} went from ${first!.total!.total.toLocaleString()} to ${last!.total!.total.toLocaleString()} as code was added or apps joined.` : undefined
    });
  }
  stats.push(
    {
      label: "Tests",
      value: lastTests === null ? "—" : lastTests.toLocaleString(),
      details: [firstTestsPoint && lastTests !== null && points.length > 1 ? `${formatDelta(lastTests - firstTestsPoint.testsTotal!, "tests")} since ${shortDate(firstTestsPoint.recordedAt)}` : "Across apps with test results"]
    },
    {
      label: "Pass rate",
      value: formatPercent(reliability.passRate),
      details: [
        !reliability.runsWithTests
          ? "No test results in this range"
          : reliability.runsWithFailures
            ? `${reliability.runsWithFailures} of ${reliability.runsWithTests} runs had failures`
            : `No failures in ${reliability.runsWithTests} ${reliability.runsWithTests === 1 ? "run" : "runs"}`
      ],
      title: "Passed tests out of passed plus failed, counting only apps that ran in each run. Skipped tests are excluded."
    },
    {
      label: "Time span",
      value: points.length > 1 ? formatSpan(points[0]!.recordedAt, points[points.length - 1]!.recordedAt) : "—",
      details: [points.length > 1 ? `${formatDateRange(points[0]!.recordedAt, points[points.length - 1]!.recordedAt)} · ${points.length} runs` : "1 completed run in this range"]
    }
  );

  return { stats, movers: comparable ? trendMovers(trend) : null };
}
