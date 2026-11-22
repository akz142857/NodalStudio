import { useCallback, useState } from "react";
import {
  readTablePagePosition, readTablePageSize, saveTablePageSize,
  tablePageNumberKey, tablePageSizeKey, type TablePageSize,
} from "../platform/table-data-preferences";
import { useTablePageScroll } from "./use-table-page-scroll";

const FIRST_PAGE = { page: 1, restoring: false };

export function useTablePagination<Cursor>(sourceId: string, schema: string, table: string) {
  const sizeKey = tablePageSizeKey(sourceId, schema, table);
  const pageKey = tablePageNumberKey(sourceId, schema, table);
  const [pageSize, setPageSize] = useState(() => readTablePageSize(sizeKey));
  const [saved] = useState(() => readTablePagePosition(pageKey, pageSize));
  const [{ page, restoring }, setPosition] = useState(() => ({ page: saved.page, restoring: saved.page > 1 }));
  const [starts, setStarts] = useState(() => new Map<number, Cursor>());
  const { scrollRef, restore: restoreScroll, reset: resetScroll } = useTablePageScroll(pageKey, saved);

  const reset = useCallback(({ keepScroll = false }: { keepScroll?: boolean } = {}) => {
    resetScroll(keepScroll);
    setPosition(FIRST_PAGE);
    setStarts(new Map());
  }, [resetScroll]);

  function changePageSize(size: TablePageSize) {
    reset();
    setPageSize(size);
    saveTablePageSize(sizeKey, size);
  }

  function goTo(page: number) {
    setPosition({ page, restoring: false });
  }

  function goToCountedPage(page: number) {
    // A fresh count can reflect writes made since the cursor boundaries were loaded.
    setStarts(new Map());
    goTo(page);
  }

  const confirm = useCallback((visiblePage: number, hasRows: boolean) => {
    if (visiblePage !== page) return;
    if (page === 1 || hasRows) {
      return restoreScroll(page);
    } else if (restoring) {
      // The table may have shrunk. Restart at page one using a regular read.
      reset();
    }
  }, [page, reset, restoreScroll, restoring]);

  function next(start?: Cursor) {
    setStarts((previous) => {
      const nextStarts = new Map(previous);
      if (start !== undefined) nextStarts.set(page + 1, start);
      else nextStarts.delete(page + 1);
      return nextStarts;
    });
    goTo(page + 1);
  }

  return { page, pageSize, start: starts.get(page), goTo, goToCountedPage, next, reset, changePageSize, confirm, scrollRef };
}
