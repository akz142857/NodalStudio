import { ActionIcon, type ActionIconName } from "./ActionIcon";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ActionIconName;
  disabled?: boolean;
  /** Native tooltip, typically the reason a segment is disabled. */
  title?: string;
  ariaKeyShortcuts?: string;
}

interface SegmentedProps<T extends string> {
  /** Names the group for assistive technology, e.g. "View mode". */
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  /** Extra class on the container, for per-instance sizing. */
  className?: string;
}

/**
 * One-of-N control drawn as a row of segments with the active one filled.
 *
 * Shared so the top bar and the inspector read as the same control rather than
 * two look-alikes: the inspector's segments are the next thing to use it.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: SegmentedProps<T>) {
  const enabled = options.filter((option) => !option.disabled);
  const focusValue = enabled.some((option) => option.value === value) ? value : enabled[0]?.value;
  return (
    <div
      role="group"
      aria-label={label}
      className={["segmented", className].filter(Boolean).join(" ")}
    >
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={option.value === value ? "active" : ""}
          aria-pressed={option.value === value}
          disabled={option.disabled}
          tabIndex={option.value === focusValue ? 0 : -1}
          title={option.title}
          aria-keyshortcuts={option.ariaKeyShortcuts}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            const { key } = event;
            if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
            const group = event.currentTarget.parentElement;
            if (!group) return;
            event.preventDefault();
            const buttons = [...group.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
            const index = buttons.indexOf(event.currentTarget);
            const direction = getComputedStyle(group).direction === "rtl" ? -1 : 1;
            const step = key === "ArrowRight" ? direction : -direction;
            const next = key === "Home" ? 0 : key === "End" ? buttons.length - 1 : (index + step + buttons.length) % buttons.length;
            buttons[next]?.focus();
            if (next !== index) onChange(enabled[next].value);
          }}
        >
          {option.icon && <ActionIcon name={option.icon} />}
          {option.label}
        </button>
      ))}
    </div>
  );
}
