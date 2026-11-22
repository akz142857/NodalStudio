import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../design-system/Button";
import { useI18n } from "../i18n";
import { normalizeQueryError } from "../i18n/query-errors";
import { maxTablePage, TABLE_PAGE_SIZES, type TablePageSize } from "../platform/table-data-preferences";
import { IconButton } from "./IconButton";

export function TableDataPagination({ page, pageSize, onPageSizeChange, onJump, onPrevious, onNext, canNext, lastPage, busy, offsetPaging }: {
  page: number;
  pageSize: TablePageSize;
  onPageSizeChange: (size: TablePageSize) => void;
  onJump: (page: number) => void;
  onPrevious: () => void;
  onNext: () => void;
  canNext: boolean;
  lastPage: {
    scope: string;
    available: boolean;
    count: (signal: AbortSignal) => Promise<string>;
    goTo: (page: number) => void;
  };
  busy: boolean;
  offsetPaging?: boolean;
}) {
  const { t } = useI18n();
  const [destination, setDestination] = useState("");
  const scope = useMemo(() => [lastPage.scope, lastPage.available, busy] as const, [lastPage.scope, lastPage.available, busy]);
  const request = useRef<AbortController | undefined>(undefined);
  const [countState, setCountState] = useState<{ scope: typeof scope; error?: string }>();
  const currentCount = countState?.scope === scope ? countState : undefined;
  const counting = currentCount !== undefined && currentCount.error === undefined;
  const controlsBusy = busy || counting;
  const maxPage = maxTablePage(pageSize);
  const target = Number(destination);
  const valid = Number.isInteger(target) && target >= 1 && target <= maxPage && target !== page;

  useLayoutEffect(() => () => {
    request.current?.abort();
    request.current = undefined;
  }, [scope]);

  async function jumpToLastPage() {
    if (busy || !lastPage.available || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setCountState({ scope });
    try {
      const count = await lastPage.count(controller.signal);
      if (controller.signal.aborted) return;
      if (!/^\d{1,20}$/.test(count)) throw new Error(t("tableData.invalidRowCount"));
      const size = BigInt(pageSize);
      const pages = (BigInt(count) + size - 1n) / size;
      if (pages > BigInt(maxPage)) throw new Error(t("tableData.lastPageOutOfRange"));
      const last = Math.max(1, Number(pages));
      setCountState(undefined);
      setDestination("");
      if (last !== page) lastPage.goTo(last);
    } catch (error) {
      if (!controller.signal.aborted) setCountState({ scope, error: normalizeQueryError(t, error).message });
    } finally {
      if (request.current === controller) request.current = undefined;
    }
  }

  return (
    <div className="table-data-pagination" role="group" aria-label={t("tableData.pagination")}>
      <div className="table-page-navigation">
        <IconButton icon="firstPage" label={t("tableData.firstPage")} disabled={controlsBusy || page === 1} onClick={() => onJump(1)} />
        <IconButton icon="chevronLeft" label={t("tableData.previousPage")} disabled={controlsBusy || page === 1} onClick={onPrevious} />
        <span className="table-page-current" aria-live="polite" title={offsetPaging ? t("tableData.offsetPaging") : undefined}>{t("tableData.page", { value0: page })}</span>
        <IconButton icon="chevronRight" label={t("tableData.nextPage")} disabled={controlsBusy || !canNext || page >= maxPage} onClick={onNext} />
        <IconButton icon={counting ? "refresh" : "lastPage"} label={t("tableData.lastPage")}
          className={counting ? "refresh-button" : undefined} aria-busy={counting || undefined}
          disabled={controlsBusy || !lastPage.available} onClick={() => void jumpToLastPage()} />
        {counting && <span role="status" className="visually-hidden">{t("tableData.countingRows")}</span>}
      </div>
      <form className="table-page-jump" onSubmit={(event) => {
        event.preventDefault();
        if (controlsBusy || !valid) return;
        setDestination("");
        onJump(target);
      }}>
        <input type="number" inputMode="numeric" min={1} max={maxPage} step={1}
          aria-label={t("tableData.goToPage")} placeholder={t("tableData.pageNumber")} value={destination}
          onChange={(event) => setDestination(event.target.value)} />
        <Button variant="ghost" type="submit" disabled={controlsBusy || !valid}>{t("tableData.go")}</Button>
      </form>
      <label className="table-page-size">
        <span className="table-page-size-label">{t("tableData.rowsPerPage")}</span>
        <select className="ds-select" aria-label={t("tableData.rowsPerPage")} value={pageSize} disabled={controlsBusy} onChange={(event) => {
          const size = TABLE_PAGE_SIZES.find((choice) => choice === Number(event.target.value));
          if (size) {
            setDestination("");
            onPageSizeChange(size);
          }
        }}>
          {TABLE_PAGE_SIZES.map((size) => <option value={size} key={size}>{size}</option>)}
        </select>
      </label>
      {currentCount?.error && <p className="table-page-count-error" role="alert">{t("tableData.lastPageFailed", { value0: currentCount.error })}</p>}
    </div>
  );
}
