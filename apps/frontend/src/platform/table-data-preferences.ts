import { z } from "zod";
import { tableFilterSchema, tableFilterSettingsFromLegacy, tableFilterSettingsSchema, type TableFilter, type TableFilterSettings } from "./table-data-filter";

export const DEFAULT_ROW_PANEL_WIDTH = 336;
export const MIN_ROW_PANEL_WIDTH = 260;
export const MAX_ROW_PANEL_WIDTH = 640;
export const MIN_COLUMN_WIDTH = 72;
export const MAX_COLUMN_WIDTH = 640;
export const TABLE_PAGE_SIZES = [10, 25, 50, 100, 200] as const;
export type TablePageSize = typeof TABLE_PAGE_SIZES[number];
export const DEFAULT_TABLE_PAGE_SIZE = 100;

const ROW_PANEL_WIDTH_KEY = "nodalstudio:table-data:row-panel-width";
const COLUMN_WIDTHS_PREFIX = "nodalstudio:table-data:column-widths:";
const FILTER_PREFIX = "nodalstudio:table-data:filter:";
const SORT_PREFIX = "nodalstudio:table-data:sort:";
const PAGE_SIZE_PREFIX = "nodalstudio:table-data:page-size:";
const PAGE_NUMBER_PREFIX = "nodalstudio:table-data:page-number:";

const tableSortSchema = z.object({ column: z.string(), direction: z.enum(["asc", "desc"]) });
export type TableSort = z.infer<typeof tableSortSchema>;

export function readRowPanelWidth() {
  try {
    const width = Number(localStorage.getItem(ROW_PANEL_WIDTH_KEY));
    if (Number.isInteger(width) && width >= MIN_ROW_PANEL_WIDTH && width <= MAX_ROW_PANEL_WIDTH) return width;
  } catch { /* The running app can still resize without local storage. */ }
  return DEFAULT_ROW_PANEL_WIDTH;
}

export function saveRowPanelWidth(width: number) {
  try {
    if (width === DEFAULT_ROW_PANEL_WIDTH) localStorage.removeItem(ROW_PANEL_WIDTH_KEY);
    else localStorage.setItem(ROW_PANEL_WIDTH_KEY, String(width));
  } catch { /* The running app can still resize without local storage. */ }
}

export function tableColumnWidthsKey(sourceId: string, schema: string, table: string) {
  return COLUMN_WIDTHS_PREFIX + JSON.stringify([sourceId, schema, table]);
}

export function tableFilterKey(sourceId: string, schema: string, table: string) {
  return FILTER_PREFIX + JSON.stringify([sourceId, schema, table]);
}

export function readTableFilter(key: string): TableFilterSettings | undefined {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    const settings = tableFilterSettingsSchema.safeParse(stored);
    if (settings.success) return settings.data;
    const legacy = tableFilterSchema.safeParse(stored);
    return legacy.success ? tableFilterSettingsFromLegacy(legacy.data) : undefined;
  } catch { /* Ignore unavailable or malformed local preferences. */ }
}

export function saveTableFilter(key: string, filter?: TableFilterSettings | TableFilter) {
  try {
    if (filter) localStorage.setItem(key, JSON.stringify(filter));
    else localStorage.removeItem(key);
  } catch { /* Filtering still works for the current workspace. */ }
}

export function tableSortKey(sourceId: string, schema: string, table: string) {
  return SORT_PREFIX + JSON.stringify([sourceId, schema, table]);
}

export function readTableSort(key: string): TableSort | undefined {
  try {
    return tableSortSchema.safeParse(JSON.parse(localStorage.getItem(key) ?? "null")).data;
  } catch { /* Ignore unavailable or malformed local preferences. */ }
}

export function saveTableSort(key: string, sort?: TableSort) {
  try {
    if (sort) localStorage.setItem(key, JSON.stringify(sort));
    else localStorage.removeItem(key);
  } catch { /* Sorting still works for the current workspace. */ }
}

export function tablePageSizeKey(sourceId: string, schema: string, table: string) {
  return PAGE_SIZE_PREFIX + JSON.stringify([sourceId, schema, table]);
}

export function readTablePageSize(key: string): TablePageSize {
  try {
    const saved = Number(localStorage.getItem(key));
    return TABLE_PAGE_SIZES.find((size) => size === saved) ?? DEFAULT_TABLE_PAGE_SIZE;
  } catch {
    return DEFAULT_TABLE_PAGE_SIZE;
  }
}

export function saveTablePageSize(key: string, size: TablePageSize) {
  try {
    if (size === DEFAULT_TABLE_PAGE_SIZE) localStorage.removeItem(key);
    else localStorage.setItem(key, String(size));
  } catch { /* Page sizing still works for the current workspace. */ }
}

// Reserve space for one page in SQLite's u32 row offset.
export function maxTablePage(pageSize: TablePageSize) {
  return Math.floor((0xffff_ffff - pageSize) / pageSize) + 1;
}

export function tablePageNumberKey(sourceId: string, schema: string, table: string) {
  return PAGE_NUMBER_PREFIX + JSON.stringify([sourceId, schema, table]);
}

const tablePagePositionSchema = z.object({
  page: z.number().int().min(1),
  left: z.number().min(0),
  top: z.number().min(0),
});
export type TablePagePosition = z.infer<typeof tablePagePositionSchema>;

export const FIRST_TABLE_PAGE = { page: 1, left: 0, top: 0 } satisfies TablePagePosition;

export function readTablePagePosition(key: string, pageSize: TablePageSize): TablePagePosition {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    // Older preferences stored only the page number.
    const position = tablePagePositionSchema.safeParse(typeof saved === "number" ? { page: saved, left: 0, top: 0 } : saved);
    if (position.success && position.data.page <= maxTablePage(pageSize)) return position.data;
  } catch { /* The table can still open if preferences are unavailable. */ }
  return FIRST_TABLE_PAGE;
}

export function saveTablePagePosition(key: string, position: TablePagePosition) {
  try {
    if (!position.left && !position.top) {
      if (position.page === 1) localStorage.removeItem(key);
      else localStorage.setItem(key, String(position.page));
    } else {
      localStorage.setItem(key, JSON.stringify(position));
    }
  } catch { /* Pagination still works for the current workspace. */ }
}

export function readTableColumnWidths(key: string): Map<string, number> {
  const widths = new Map<string, number>();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      for (const [column, width] of Object.entries(stored)) {
        if (typeof width === "number" && Number.isInteger(width) && width >= MIN_COLUMN_WIDTH && width <= MAX_COLUMN_WIDTH) {
          widths.set(column, width);
        }
      }
    }
  } catch { /* A missing or malformed preference falls back to the default widths. */ }
  return widths;
}

export function saveTableColumnWidth(key: string, column: string, width: number) {
  try {
    const widths = readTableColumnWidths(key);
    widths.set(column, width);
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(widths)));
  } catch { /* Column resizing still works if local storage is unavailable. */ }
}

export function clearTableDataPreferences() {
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key && (key.startsWith(COLUMN_WIDTHS_PREFIX) || key.startsWith(FILTER_PREFIX) || key.startsWith(SORT_PREFIX)
        || key.startsWith(PAGE_SIZE_PREFIX) || key.startsWith(PAGE_NUMBER_PREFIX))) {
        localStorage.removeItem(key);
      }
    }
  } catch { /* Local storage can be unavailable. */ }
}
