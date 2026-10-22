import type { QueryCell, QueryExecutionResult } from "../../platform";
export interface ColumnProfile {
  total: number; nulls: number; empty: number; incomplete: number;
  distinct: number | null; unique: number | null;
  top: { label: string; count: number }[];
  numeric?: { min: string; max: string; mean: string; bins: { label: string; count: number }[] };
  dates?: { min: string; max: string };
  note?: string;
}
export function resultCellText(cell: QueryCell): string {
  switch (cell.kind) {
    case "null": return "NULL";
    case "boolean": return String(cell.value);
    case "number": return String(cell.value);
    case "text": return `${cell.value}${cell.truncated ? "… [truncated]" : ""}`;
    case "json": return `${cell.raw ?? JSON.stringify(cell.value)}${cell.truncated ? "… [truncated]" : ""}`;
    case "binary": return `[Binary not loaded · ${cell.byteLength} bytes]`;
  }
}
export function incompleteCell(cell: QueryCell): boolean { return cell.kind === "binary" || ((cell.kind === "text" || cell.kind === "json") && cell.truncated); }
function decimal(value: string): { units: bigint; scale: number } | undefined {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!match || value.length > 1000) return;
  const exponent = Number(match[4] ?? 0); if (!Number.isInteger(exponent) || Math.abs(exponent) > 1000) return;
  let scale = (match[3]?.length ?? 0) - exponent;
  let units = BigInt(`${match[1] === "-" ? "-" : ""}${match[2]}${match[3] ?? ""}`);
  if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
  return { units, scale };
}
function displayDecimal(units: bigint, scale: number): string {
  const negative = units < 0n; const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const value = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "") : digits;
  return `${negative ? "-" : ""}${value || "0"}`;
}
export function profileColumn(result: QueryExecutionResult, column: number): ColumnProfile {
  const cells = result.rows.map((r) => r[column]);
  const type = result.columns[column].databaseType.toLowerCase();
  const numericType = /^(int[248]?|smallint|integer|bigint|numeric|decimal|float[48]?|real|double precision)(\b|\()/i.test(type);
  const p: ColumnProfile = { total: cells.length, nulls: 0, empty: 0, incomplete: 0, distinct: 0, unique: 0, top: [] };
  const frequency = new Map<string, { label: string; count: number }>();
  for (const cell of cells) {
    if (cell.kind === "null") { p.nulls++; continue; }
    if (incompleteCell(cell)) { p.incomplete++; continue; }
    if (cell.kind === "text" && cell.value === "") p.empty++;
    if (cell.kind === "json" || cell.kind === "binary") continue;
    const numericValue = numericType ? decimal(resultCellText(cell)) : undefined;
    const key = numericValue ? `numeric:${displayDecimal(numericValue.units, numericValue.scale)}` : JSON.stringify([cell.kind, cell.value]);
    const old = frequency.get(key);
    if (old) old.count++; else frequency.set(key, { label: cell.kind === "text" && cell.value === "" ? "(empty string)" : resultCellText(cell), count: 1 });
  }
  if (p.incomplete || /json|bytea|binary|blob/.test(type)) {
    p.distinct = p.unique = null; p.note = p.incomplete ? "Values are truncated or not loaded. Distinct counts and distribution are unavailable." : "Content distribution is not calculated for JSON or binary columns.";
    return p;
  }
  p.distinct = frequency.size; p.unique = [...frequency.values()].filter((v) => v.count === 1).length;
  p.top = [...frequency.values()].sort((a, b) => b.count - a.count).slice(0, 5);
  if (/^(int[248]?|smallint|integer|bigint|numeric|decimal|float[48]?|real|double precision)(\b|\()/i.test(type)) {
    const nonnull = cells.filter((c) => c.kind !== "null");
    const parsed = nonnull.map((c) => decimal(resultCellText(c)));
    if (parsed.length && parsed.every((n) => n !== undefined)) {
      const scale = Math.max(...parsed.map((n) => n.scale));
      const units = parsed.map((n) => n.units * 10n ** BigInt(scale - n.scale));
      const min = units.reduce((a,b) => a < b ? a : b); const max = units.reduce((a,b) => a > b ? a : b);
      const sum = units.reduce((a,b) => a+b, 0n); const denominator = BigInt(units.length);
      const extra = 6; const numerator = sum * 10n ** BigInt(extra);
      const mean = `${numerator % denominator ? "≈ " : ""}${displayDecimal(numerator / denominator, scale + extra)}`;
      const counts = Array.from({ length: min === max ? 1 : 8 }, () => 0);
      for (const n of units) { const bucket = min === max ? 0 : Math.min(7, Number((n-min)*8n/(max-min))); counts[bucket]++; }
      p.numeric = { min: displayDecimal(min,scale), max: displayDecimal(max,scale), mean, bins: counts.map((count, i) => ({ count, label: min === max ? displayDecimal(min, scale) : `${displayDecimal(min*1000n+(max-min)*1000n*BigInt(i)/8n,scale+3)} – ${displayDecimal(min*1000n+(max-min)*1000n*BigInt(i+1)/8n,scale+3)}` })) };
    } else if (parsed.length) p.note = "Numeric range and mean are unavailable for non-finite or unsupported numeric values.";
  }
  if (/^(date|timestamp|timestamptz|datetime)/.test(type)) {
    const values = cells.filter((c) => c.kind !== "null").map(resultCellText);
    const dated = values.map((text) => ({ text, time: Date.parse(text) }));
    if (dated.length && dated.every((d) => Number.isFinite(d.time))) {
      dated.sort((a,b) => a.time - b.time); p.dates = { min: dated[0].text, max: dated.at(-1)!.text };
      p.note = "Date ordering uses millisecond precision. Original values are shown; timestamps without a zone use the local timezone.";
    } else if (dated.length) p.note = "Date range is unavailable for unsupported date values.";
  }
  return p;
}
export function profileResult(result: QueryExecutionResult): ColumnProfile[] { return result.columns.map((_, index) => profileColumn(result,index)); }
