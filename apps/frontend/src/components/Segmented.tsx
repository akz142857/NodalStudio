export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  /** Native tooltip, typically the reason a segment is disabled. */
  title?: string;
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
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
