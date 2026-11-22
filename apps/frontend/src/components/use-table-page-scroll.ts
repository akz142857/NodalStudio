import { useCallback, useRef } from "react";
import { FIRST_TABLE_PAGE, saveTablePagePosition, type TablePagePosition } from "../platform/table-data-preferences";

const SCROLL_SAVE_INTERVAL = 120;

export function useTablePageScroll(key: string, initialPosition: TablePagePosition) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const position = useRef(initialPosition);

  const reset = useCallback((keepScroll: boolean) => {
    const previous = position.current;
    position.current = keepScroll
      ? { page: 1, left: previous.left, top: previous.page === 1 ? previous.top : 0 }
      : FIRST_TABLE_PAGE;
    saveTablePagePosition(key, position.current);
    if (!keepScroll && scrollRef.current) {
      scrollRef.current.scrollLeft = 0;
      scrollRef.current.scrollTop = 0;
    }
  }, [key]);

  const restore = useCallback((page: number) => {
    const element = scrollRef.current;
    if (!element) {
      position.current = { ...FIRST_TABLE_PAGE, page };
      saveTablePagePosition(key, position.current);
      return;
    }

    const previous = position.current;
    element.scrollLeft = previous.left;
    element.scrollTop = previous.page === page ? previous.top : 0;
    const readPosition = (): TablePagePosition => ({
      page, left: Math.max(0, element.scrollLeft), top: Math.max(0, element.scrollTop),
    });
    position.current = readPosition();
    saveTablePagePosition(key, position.current);

    let timer: number | undefined;
    function flush() {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
      if (position.current.page === page) saveTablePagePosition(key, position.current);
    }
    function capture() {
      const current = position.current;
      if (current.page !== page) return;
      const next = readPosition();
      if (current.left === next.left && current.top === next.top) return;
      position.current = next;
      timer ??= window.setTimeout(flush, SCROLL_SAVE_INTERVAL);
    }
    const closePage = () => {
      // A hidden grid can report both axes as zero. Keep the last visible offset.
      if (element.getClientRects().length) capture();
      flush();
    };
    element.addEventListener("scroll", capture, { passive: true });
    window.addEventListener("pagehide", closePage);
    return () => {
      element.removeEventListener("scroll", capture);
      window.removeEventListener("pagehide", closePage);
      closePage();
    };
  }, [key]);

  return { scrollRef, restore, reset };
}
