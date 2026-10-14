import { shortAppName, type CoverageTrend } from "@qa-buddy/shared";
import { chartLayout, formatDelta, linePath, longDate, shortDate, type TrendSummary } from "./trend-model";

/**
 * A self-contained image of the current chart view for slides and documents.
 * Everything is inline (no stylesheet or web font), so it renders the same in
 * any viewer and converts cleanly to PNG.
 */
export interface TrendExportOptions {
  repositoryName: string;
  /** e.g. "Branches · Frontend · Last 30 days" */
  subtitle: string;
  trend: CoverageTrend;
  summary: TrendSummary;
  goal: number | null;
  focusedApp: string | null;
  generatedAt: Date;
}

const width = 1200;
const pad = 48;
const colors = {
  background: "#ffffff",
  text: "#292832",
  muted: "#70717e",
  faint: "#7c7e8e",
  grid: "#eeeff4",
  rule: "#e6e7ee",
  accent: "#7257cf"
};
const fontFamily = "Manrope, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

export function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "apos" }[character]};`);
}

/** Rough text width for wrapping; exact metrics are unavailable outside the DOM. */
const textWidth = (value: string, size: number) => value.length * size * 0.56;

function text(x: number, y: number, value: string, attributes: Record<string, string | number> = {}) {
  const extra = Object.entries(attributes).map(([key, attribute]) => ` ${key}="${escapeXml(String(attribute))}"`).join("");
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}"${extra}>${escapeXml(value)}</text>`;
}

export function buildTrendExportSvg(options: TrendExportOptions): string {
  const { trend, summary, goal, focusedApp } = options;
  const parts: string[] = [];
  let cursor = pad;

  // Title
  cursor += 26;
  parts.push(text(pad, cursor, `${options.repositoryName} · Coverage trend`, { "font-size": 26, "font-weight": 800, fill: colors.text }));
  cursor += 28;
  parts.push(text(pad, cursor, options.subtitle, { "font-size": 15, fill: colors.muted }));
  cursor += 36;

  // Stats: each detail splits on " · " so long lines stack inside narrow columns.
  const columnWidth = (width - pad * 2) / summary.stats.length;
  let statsBottom = cursor;
  summary.stats.forEach((stat, index) => {
    const x = pad + index * columnWidth;
    let y = cursor;
    parts.push(text(x, y, stat.label.toUpperCase(), { "font-size": 11, "font-weight": 800, "letter-spacing": 1.2, fill: colors.faint }));
    y += 36;
    parts.push(text(x, y, stat.value, { "font-size": 30, "font-weight": 800, fill: colors.text }));
    for (const line of stat.details.flatMap((detail) => detail.split(" · "))) {
      y += 20;
      parts.push(text(x, y, line, { "font-size": 13, fill: colors.muted }));
    }
    if (stat.note) {
      y += 20;
      parts.push(text(x, y, stat.note, { "font-size": 13, "font-weight": 800, fill: colors.text }));
    }
    statsBottom = Math.max(statsBottom, y);
  });
  cursor = statsBottom + 28;

  // Movers
  if (summary.movers) {
    parts.push(`<line x1="${pad}" x2="${width - pad}" y1="${cursor}" y2="${cursor}" stroke="${colors.rule}" />`);
    cursor += 30;
    const columns = [
      { label: "Most improved", list: summary.movers.improved, empty: "No app improved in this range" },
      { label: "Most declined", list: summary.movers.declined, empty: "No app declined in this range" }
    ];
    const moverWidth = (width - pad * 2 - 48) / 2;
    let moversBottom = cursor;
    columns.forEach((column, index) => {
      const x = pad + index * (moverWidth + 48);
      let y = cursor;
      parts.push(text(x, y, column.label.toUpperCase(), { "font-size": 11, "font-weight": 800, "letter-spacing": 1.2, fill: colors.faint }));
      if (column.list.length === 0) {
        y += 24;
        parts.push(text(x, y, column.empty, { "font-size": 14, fill: colors.muted }));
      }
      for (const mover of column.list) {
        y += 24;
        parts.push(text(x, y, shortAppName(mover.appName), { "font-size": 14, fill: colors.muted }));
        parts.push(text(x + moverWidth, y, formatDelta(mover.delta, "pts"), { "font-size": 14, "font-weight": 800, fill: colors.text, "text-anchor": "end" }));
      }
      moversBottom = Math.max(moversBottom, y);
    });
    cursor = moversBottom + 22;
    parts.push(`<line x1="${pad}" x2="${width - pad}" y1="${cursor}" y2="${cursor}" stroke="${colors.rule}" />`);
    cursor += 24;
  }

  // Chart
  const chartHeight = 380;
  const margin = { top: 12, right: 72, bottom: 32, left: 48 };
  const layout = chartLayout(trend, goal, width - pad * 2, chartHeight, margin);
  const chart: string[] = [];
  for (const tick of layout.domain.ticks) {
    chart.push(`<line x1="${margin.left}" x2="${width - pad * 2 - margin.right}" y1="${layout.y(tick).toFixed(1)}" y2="${layout.y(tick).toFixed(1)}" stroke="${colors.grid}" />`);
    chart.push(text(margin.left - 10, layout.y(tick) + 4, `${tick}%`, { "font-size": 12, fill: colors.faint, "text-anchor": "end" }));
  }
  for (const index of layout.labelIndexes) {
    chart.push(text(layout.x(index), chartHeight - 8, shortDate(trend.points[index]!.recordedAt), { "font-size": 12, fill: colors.faint, "text-anchor": layout.labelAnchor(index) }));
  }
  if (goal !== null) {
    chart.push(`<line x1="${margin.left}" x2="${width - pad * 2 - margin.right}" y1="${layout.y(goal).toFixed(1)}" y2="${layout.y(goal).toFixed(1)}" stroke="${colors.text}" stroke-opacity="0.55" stroke-width="1.25" stroke-dasharray="6 4" />`);
    chart.push(text(margin.left + 6, layout.y(goal) - 7, `Goal ${goal}%`, { "font-size": 12, "font-weight": 700, fill: colors.muted, stroke: colors.background, "stroke-width": 4, "paint-order": "stroke" }));
  }
  trend.apps.forEach((app, index) => {
    const dimmed = focusedApp !== null && focusedApp !== app.appName;
    const opacity = dimmed ? (layout.colored ? 0.2 : 0.5) : 1;
    chart.push(`<path d="${linePath(app.values, layout.x, layout.y)}" fill="none" stroke="${layout.appColor(index)}" stroke-width="${layout.colored ? 2 : 1.25}" stroke-opacity="${opacity}" stroke-linejoin="round" stroke-linecap="round" />`);
  });
  const focused = !layout.colored && focusedApp ? trend.apps.find((app) => app.appName === focusedApp) : undefined;
  if (focused) {
    chart.push(`<path d="${linePath(focused.values, layout.x, layout.y)}" fill="none" stroke="${colors.accent}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`);
  }
  chart.push(`<path d="${linePath(layout.totals, layout.x, layout.y)}" fill="none" stroke="${colors.text}" stroke-width="2.75" stroke-linejoin="round" stroke-linecap="round" />`);
  if (trend.points.length <= 40) {
    layout.totals.forEach((value, index) => {
      if (value !== null) chart.push(`<circle cx="${layout.x(index).toFixed(1)}" cy="${layout.y(value).toFixed(1)}" r="3" fill="${colors.text}" stroke="${colors.background}" stroke-width="2" />`);
    });
  }
  if (layout.lastTotalIndex < layout.totals.length) {
    chart.push(text(layout.x(layout.lastTotalIndex) + 9, layout.y(layout.totals[layout.lastTotalIndex]!) + 4, "Total", { "font-size": 13, "font-weight": 800, fill: colors.text }));
  }
  parts.push(`<g transform="translate(${pad} ${cursor})">${chart.join("")}</g>`);
  cursor += chartHeight + 24;

  // Legend: every app when colored; otherwise the total, the highlighted app and a gray "other apps" key.
  const legend: Array<{ label: string; color: string; dashed?: boolean; bold?: boolean }> = [{ label: "Weighted total", color: colors.text, bold: true }];
  if (layout.colored) {
    trend.apps.forEach((app, index) => legend.push({ label: shortAppName(app.appName), color: layout.appColor(index) }));
  } else {
    if (focused) legend.push({ label: shortAppName(focused.appName), color: colors.accent });
    const others = trend.apps.length - (focused ? 1 : 0);
    legend.push({ label: `${focused ? "Other apps" : "Individual apps"} (${others})`, color: "#b9bac7" });
  }
  if (goal !== null) legend.push({ label: `Goal ${goal}%`, color: colors.text, dashed: true });
  let legendX = pad;
  cursor += 6;
  for (const item of legend) {
    const itemWidth = 22 + textWidth(item.label, 13) + 22;
    if (legendX + itemWidth > width - pad && legendX > pad) {
      legendX = pad;
      cursor += 24;
    }
    parts.push(`<line x1="${legendX}" x2="${legendX + 14}" y1="${cursor - 4}" y2="${cursor - 4}" stroke="${item.color}" stroke-width="${item.dashed ? 1.5 : 2.5}"${item.dashed ? ` stroke-dasharray="4 3"` : ""} stroke-linecap="round" />`);
    parts.push(text(legendX + 22, cursor, item.label, { "font-size": 13, fill: item.bold ? colors.text : colors.muted, "font-weight": item.bold ? 800 : 600 }));
    legendX += itemWidth;
  }

  // Footer
  cursor += 40;
  parts.push(`<line x1="${pad}" x2="${width - pad}" y1="${cursor - 20}" y2="${cursor - 20}" stroke="${colors.rule}" />`);
  parts.push(text(pad, cursor, `Generated ${longDate(options.generatedAt.toISOString())} · Completed runs only · QA Buddy`, { "font-size": 12, fill: colors.faint }));
  const height = cursor + pad;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${escapeXml(fontFamily)}">`,
    `<title>${escapeXml(`${options.repositoryName} coverage trend · ${options.subtitle}`)}</title>`,
    `<rect width="${width}" height="${height}" fill="${colors.background}" />`,
    ...parts,
    "</svg>"
  ].join("\n");
}

export function exportFileName(repositoryName: string, subtitle: string, generatedAt: Date, extension: "svg" | "png") {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug(`${repositoryName} ${subtitle}`)}-${generatedAt.toISOString().slice(0, 10)}.${extension}`;
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function downloadSvg(svg: string, fileName: string) {
  download(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), fileName);
}

/** Rasterises at 2x so the image stays sharp on projectors and high-density screens. */
export async function downloadPng(svg: string, fileName: string, scale = 2) {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth * scale;
  canvas.height = image.naturalHeight * scale;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot create a PNG");
  context.scale(scale, scale);
  context.drawImage(image, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("This browser cannot create a PNG");
  download(blob, fileName);
}
