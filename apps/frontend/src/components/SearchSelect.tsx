import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { ActionIcon } from "./ActionIcon";
import "./search-select.css";

export interface SearchChoice {
  value: string;
  label: string;
  optionLabel?: string;
  detail?: string;
  searchName?: string;
}

interface Props {
  label: string;
  value: string;
  options: readonly SearchChoice[];
  placeholder?: string;
  searchPlaceholder?: string;
  missingLabel?: string;
  describedBy?: string;
  disabled?: boolean;
  required?: boolean;
  onChange: (value: string) => void;
}

const resultLimit = 40;
const popupHeight = 300;
const popupMinWidth = 280;
const popupGap = 6;
const viewportInset = 8;

function matchingChoices(options: readonly SearchChoice[], query: string) {
  const search = query.trim().toLowerCase();
  if (!search) return options;
  const words = search.split(/\s+/);
  return options.flatMap((option) => {
    const label = option.label.toLowerCase();
    const name = option.searchName?.toLowerCase() ?? label;
    const searchable = `${label} ${option.detail?.toLowerCase() ?? ""}`;
    if (!words.every((word) => searchable.includes(word))) return [];
    const rank = search === label || search === name ? 0
      : label.startsWith(search) || name.startsWith(search) ? 1 : 2;
    return [{ option, rank }];
  }).sort((left, right) => left.rank - right.rank).map(({ option }) => option);
}

export function SearchSelect({ label, value, options, placeholder, searchPlaceholder, missingLabel, describedBy, disabled, required, onChange }: Props) {
  const { t } = useI18n();
  const id = useId();
  const listId = `${id}-options`;
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement>();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const open = Boolean(host && !disabled);
  const search = open ? query : "";
  const matches = useMemo(() => matchingChoices(options, search), [options, search]);
  const visible = matches.slice(0, resultLimit);
  const active = Math.min(index, visible.length - 1);
  const activeId = open && active >= 0 ? `${listId}-${active}` : undefined;
  const selected = options.find((option) => option.value === value);
  const selectedLabel = selected?.label ?? (value ? missingLabel ?? t("business.missing", { value0: value }) : "");
  const prompt = searchPlaceholder ?? t("business.search", { value0: label.toLocaleLowerCase() });

  function expand(input: HTMLInputElement, last = false) {
    setQuery("");
    setIndex(last ? Math.min(options.length, resultLimit) - 1 : 0);
    setHost(input.closest("dialog") ?? document.body);
  }

  function choose(option: SearchChoice) {
    setHost(undefined);
    if (option.value !== value) onChange(option.value);
  }

  useLayoutEffect(() => {
    const input = inputRef.current;
    const popup = popupRef.current;
    const list = listRef.current;
    if (!open || !input || !popup || !list) return;
    const update = () => {
      const scale = popup.offsetWidth ? popup.getBoundingClientRect().width / popup.offsetWidth || 1 : 1;
      const bounds = input.getBoundingClientRect();
      const viewportWidth = window.innerWidth / scale;
      const viewportHeight = window.innerHeight / scale;
      const top = bounds.top / scale;
      const bottom = bounds.bottom / scale;
      const width = Math.min(Math.max(bounds.width / scale, popupMinWidth), viewportWidth - 2 * viewportInset);
      popup.style.width = `${width}px`;
      popup.style.left = `${Math.max(viewportInset, Math.min(bounds.left / scale, viewportWidth - width - viewportInset))}px`;
      const above = top - viewportInset - popupGap;
      const below = viewportHeight - bottom - viewportInset - popupGap;
      const contentHeight = popup.offsetHeight + list.scrollHeight - list.clientHeight;
      const upward = below < Math.min(popupHeight, contentHeight) && above > below;
      popup.style.maxHeight = `${Math.max(0, Math.min(popupHeight, upward ? above : below))}px`;
      popup.style.top = upward ? "auto" : `${bottom + popupGap}px`;
      popup.style.bottom = upward ? `${viewportHeight - top + popupGap}px` : "auto";
    };
    update();
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    resize?.observe(input);
    resize?.observe(popup);
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && event.target !== input && !popup.contains(event.target)) setHost(undefined);
    };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", dismissOutside, true);
    document.addEventListener("pointerdown", dismissOutside);
    return () => {
      resize?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", dismissOutside, true);
      document.removeEventListener("pointerdown", dismissOutside);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId, search]);

  return <div className="search-select">
    <label htmlFor={id}>{label}</label>
    <div className="search-select-anchor">
      <input id={id} ref={inputRef} role="combobox" autoComplete="off" spellCheck={false}
        aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined}
        aria-activedescendant={activeId} aria-required={required} aria-describedby={describedBy}
        aria-invalid={Boolean(value && !selected) || undefined} disabled={disabled}
        placeholder={open ? prompt : placeholder ?? prompt} value={open ? query : selectedLabel}
        title={open ? undefined : selectedLabel || undefined}
        onFocus={(event) => expand(event.currentTarget)}
        onClick={(event) => { if (!open) expand(event.currentTarget); }}
        onBlur={() => setHost(undefined)}
        onChange={(event) => {
          if (!open) expand(event.currentTarget);
          setQuery(event.target.value);
          setIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setHost(undefined);
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            if (visible[active]) choose(visible[active]);
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const down = event.key === "ArrowDown";
            if (!open) expand(event.currentTarget, !down);
            else setIndex(Math.max(0, Math.min(visible.length - 1, active + (down ? 1 : -1))));
          }
        }} />
      <ActionIcon name={open ? "chevronUp" : "chevronDown"} />
    </div>
    {open && host ? createPortal(<div className="search-select-popup" ref={popupRef}>
      <div id={listId} ref={listRef} role="listbox" aria-label={t("business.options", { value0: label })}>
        {visible.map((option, position) => <button type="button" role="option" tabIndex={-1} key={option.value}
          id={`${listId}-${position}`} aria-selected={option.value === value} data-active={position === active}
          aria-label={option.optionLabel ? option.label : undefined} title={option.label}
          className="search-select-option" onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option)}>
          <span><span>{option.optionLabel ?? option.label}</span>{option.detail ? <small>{option.detail}</small> : null}</span>
          {option.value === value ? <ActionIcon name="check" /> : null}
        </button>)}
      </div>
      {!visible.length ? <div className="search-select-status" role="status">{t("searchSelect.noMatches")}</div>
        : matches.length > resultLimit ? <div className="search-select-status" role="status">
          {t("searchSelect.refine", { value0: resultLimit, value1: matches.length })}
        </div> : null}
    </div>, host) : null}
  </div>;
}
