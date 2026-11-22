import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useLayoutEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { normalizeQueryError } from "../i18n/query-errors";
import type { DatabaseSnapshot, NodalStudioPlatform, QueryExecutionResult, TableDefinition, ViewDefinition } from "../platform/types";
import type { TableSort } from "../platform/table-data-preferences";
import { TABLE_PREVIEW_ROW_LIMIT, tableCountSql, tablePreviewSql } from "./query/query-format";
import { readTableUniqueKeys, tableOffsetOrder, tablePagePlan, tablePageResult, tablePrimaryKeyApplies, tableUniqueKeysSql, type TableCursor } from "./query/table-page";
import { executeTableQuery } from "./query/table-query";
import { QueryResultGrid } from "./query/QueryResultGrid";
import { TableFilterEditor } from "./TableFilterEditor";
import { TableDataPagination } from "./TableDataPagination";
import { TableDataFooter } from "./TableDataFooter";
import { IconButton } from "./IconButton";
import { useTableColumnWidths } from "./use-table-column-widths";
import { useTableFilter } from "./use-table-filter";
import { useTableSort } from "./use-table-sort";
import { useTablePagination } from "./use-table-pagination";
import "./sqlite-table-workspace.css";

export function TableDataPreview({ platform, snapshot, table, onShowDefinition, onShowDdl, connectionRevision, quickQuery }: {
  platform: NodalStudioPlatform;
  snapshot: DatabaseSnapshot;
  table: TableDefinition | ViewDefinition;
  onShowDefinition?: () => void;
  onShowDdl?: () => void;
  connectionRevision?: string;
  quickQuery?: { result: QueryExecutionResult; sql: string; onReturn: () => void };
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { sourceId } = snapshot;
  const { databaseType } = snapshot.database;
  const { schema, name } = table.key;
  const qualifiedName = `${schema}.${name}`;
  const columnWidths = useTableColumnWidths(sourceId, schema, name);
  const columns = "columns" in table ? table.columns : undefined;
  const columnComments = useMemo(() => new Map(columns?.map(({ name, comment }) => [name, comment])), [columns]);
  const filterId = useId();
  const [filterOpen, setFilterOpen] = useState(false);
  const { filter, settings: filterSettings, changeFilter } = useTableFilter(sourceId, schema, name);
  const [sort, setSort] = useTableSort(sourceId, schema, name);
  const pagination = useTablePagination<TableCursor>(sourceId, schema, name);
  const { page: pageNumber, pageSize, start: cursor, confirm, scrollRef } = pagination;
  const pagedTable = "columns" in table && databaseType !== "sqlite" ? { table, dialect: databaseType } : undefined;
  const [lastResult, setLastResult] = useState<{
    data: QueryExecutionResult; sql: string; sort?: TableSort; page: number; pageSize: number; nextCursor?: TableCursor; hasMore: boolean; offsetPaging: boolean;
    primaryKeyApplies: boolean;
  }>();
  const filterColumns = columns ?? lastResult?.data.columns.map(({ name, databaseType }) => ({ name, typeName: databaseType }));
  const preview = useQuery({
    queryKey: ["table-data-preview", sourceId, snapshot.id, connectionRevision, schema, name, sort, filter, pageSize, pageNumber, cursor],
    enabled: !quickQuery,
    queryFn: async ({ signal }) => {
      let typedColumns = filterColumns;
      const limit = pagedTable ? pageSize + 1 : TABLE_PREVIEW_ROW_LIMIT;
      const execute = (sql: string) => executeTableQuery(platform, { sourceId, sql, rowLimit: limit, timeoutMs: 30_000, tableBrowse: true }, signal);
      let plan: ReturnType<typeof tablePagePlan>;
      let primaryKeyApplies = false;
      if (pagedTable) {
        const { table, dialect } = pagedTable;
        plan = tablePagePlan(table, dialect, sort, cursor);
        let keys: string[][] = [];
        if (!plan && table.tableKind !== "foreign" && !(dialect === "postgreSql" && table.includesInheritedRows) && !tablePagePlan(table, dialect)) {
          keys = await queryClient.fetchQuery({
            queryKey: ["table-browse-unique-keys", sourceId, snapshot.id, connectionRevision, schema, name],
            staleTime: Infinity,
            retry: false,
            queryFn: async ({ signal: catalogSignal }) => {
              try {
                const result = await executeTableQuery(platform, {
                  sourceId, sql: tableUniqueKeysSql(table.key, dialect), rowLimit: 5_000, timeoutMs: 10_000, tableBrowse: true,
                }, catalogSignal);
                return readTableUniqueKeys(result);
              } catch (error) {
                if (catalogSignal.aborted) throw error;
                return [];
              }
            },
          });
          signal.throwIfAborted();
          plan = tablePagePlan(table, dialect, sort, cursor, keys);
        }
        primaryKeyApplies = tablePrimaryKeyApplies(table, dialect, keys);
      }
      // A restored MySQL view filter needs column types before comparing numbers.
      if (filter && !typedColumns && databaseType === "mySql") {
        const metadata = await execute(tablePreviewSql(table, 0, databaseType));
        typedColumns = metadata.columns.map(({ name, databaseType }) => ({ name, typeName: databaseType }));
      }
      const useCursor = plan?.usable && (pageNumber === 1 || cursor !== undefined);
      const offsetPaging = Boolean(pagedTable && !useCursor);
      const pageOptions = useCursor ? plan : pagedTable && {
        columns: plan?.columns,
        order: plan?.order ?? tableOffsetOrder(pagedTable.table, pagedTable.dialect, sort),
        offset: (pageNumber - 1) * pageSize,
      };
      const sql = tablePreviewSql({ key: table.key, columns: typedColumns }, pagedTable ? limit : limit + 1, databaseType, sort, filter, pageOptions);
      const result = await execute(sql);
      const page = pagedTable ? tablePageResult(result, plan?.aliases, pageSize)
        : { data: result, nextCursor: undefined, hasMore: false };
      return { ...page, sql, page: pageNumber, pageSize, sort, offsetPaging, primaryKeyApplies };
    },
    networkMode: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    gcTime: 0,
  });
  if (preview.data && preview.data !== lastResult) setLastResult(preview.data);
  const shownPage = preview.data ?? lastResult;
  const displayed = quickQuery?.result ?? shownPage?.data;
  const shownPageNumber = shownPage?.page ?? pageNumber;
  const showPager = !quickQuery && Boolean(pagedTable);
  const sql = quickQuery?.sql ?? shownPage?.sql;
  useLayoutEffect(() => {
    if (showPager && preview.isSuccess && !preview.isFetching) {
      return confirm(preview.data.page, preview.data.data.rowCount > 0);
    }
  }, [confirm, preview.data, preview.isFetching, preview.isSuccess, showPager]);

  function reload() {
    pagination.reset({ keepScroll: true });
    if (pageNumber === 1) void preview.refetch();
  }
  function changeSort(next?: TableSort) {
    pagination.reset();
    setSort(next);
  }

  async function countRows(signal: AbortSignal) {
    const sql = tableCountSql({ key: table.key, columns }, databaseType, filter);
    const count = await executeTableQuery(platform, { sourceId, sql, rowLimit: 1, timeoutMs: 15_000, tableBrowse: true }, signal);
    const cell = count.rows[0]?.[0];
    if (cell?.kind !== "text" || cell.truncated) throw new Error(t("tableData.invalidRowCount"));
    return cell.value;
  }

  return (
    <section className="table-data-workspace ds-surface" aria-label={t("tableData.workspace")}>
      <header className="table-data-toolbar">
        <div className="table-data-title"><h2 title={qualifiedName}>{qualifiedName}</h2><small>{t(quickQuery ? "tableData.quickQueryResults" : "tableData.readOnlyPreview")}</small></div>
        <div className="table-data-actions table-data-controls">
          {onShowDefinition && <button type="button" onClick={onShowDefinition}>{t("document.definition")}</button>}
          {quickQuery ? <button type="button" onClick={quickQuery.onReturn}>{t("tableData.returnToData")}</button> :
            <button type="button" aria-expanded={filterOpen} aria-controls={filterId} data-filter-active={Boolean(filter)}
              onClick={() => setFilterOpen(!filterOpen)}>
              {filter ? t("tableData.filterCount", { value0: filter.rules.length }) : t("tableData.filters")}
            </button>}
          {!quickQuery && onShowDdl && <button type="button" onClick={onShowDdl}>{t("tableDdl.view")}</button>}
        </div>
      </header>
      <TableFilterEditor id={filterId} columns={(filterColumns ?? []).map(({ name }) => name)} hidden={Boolean(quickQuery) || !filterOpen}
        applied={filterSettings} busy={preview.isFetching} failed={preview.isError} onChange={(next) => {
          if (changeFilter(next)) pagination.reset();
        }} />
      {!quickQuery && preview.isFetching && <p role="status">{t(displayed ? "tableData.updating" : "tableData.loading")}</p>}
      {!quickQuery && preview.isError && <div className="table-data-feedback">
        <p role="alert">{t(displayed ? "tableData.updateFailed" : "tableData.loadFailed")} {normalizeQueryError(t, preview.error).message}</p>
        {sort && <button type="button" onClick={() => changeSort()}>{t("tableData.clearSort")}</button>}
      </div>}
      {displayed && <>
        {!quickQuery && !preview.isFetching && !preview.isError && displayed.rowCount === 0 &&
          <p>{t(shownPageNumber > 1 ? "tableData.emptyPage" : filter ? "tableData.noMatches" : "tableData.empty")}</p>}
        <div className="table-data-preview-result" aria-busy={!quickQuery && preview.isFetching}><QueryResultGrid result={displayed} platform={platform}
          scrollRef={showPager ? scrollRef : undefined}
          tableColumnWidths={quickQuery ? undefined : columnWidths} columnComments={quickQuery ? undefined : columnComments}
          statementTable={!quickQuery && pagedTable && pagedTable.table.tableKind !== "foreign"
            ? { table: shownPage?.primaryKeyApplies ? pagedTable.table : { ...pagedTable.table, primaryKey: null }, dialect: pagedTable.dialect } : undefined}
          tablePage={showPager && shownPage ? { rowOffset: (shownPage.page - 1) * shownPage.pageSize } : undefined}
          columnSort={quickQuery ? undefined : { applied: shownPage?.sort, requested: sort, onChange: changeSort }} /></div>
      </>}
      <TableDataFooter statement={sql ? { sql } : undefined}
        actions={!quickQuery && <IconButton icon="refresh" label={t(preview.isError ? "tableData.retry" : "tableData.reload")}
          onClick={preview.isError ? () => void preview.refetch() : reload} disabled={preview.isFetching} />}>
        {showPager && <TableDataPagination page={shownPageNumber} pageSize={pageSize} busy={preview.isFetching}
          canNext={!preview.isError && Boolean(shownPage?.hasMore)} offsetPaging={shownPage?.offsetPaging}
          lastPage={{ scope: JSON.stringify([snapshot.id, filter, sort, pageNumber, pageSize]),
            available: !preview.isError && Boolean(shownPage), count: countRows, goTo: pagination.goToCountedPage }}
          onPageSizeChange={pagination.changePageSize} onJump={pagination.goTo}
          onPrevious={() => pagination.goTo(shownPageNumber - 1)} onNext={() => pagination.next(shownPage?.nextCursor)} />}
      </TableDataFooter>
    </section>
  );
}
