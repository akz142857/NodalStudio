import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ActionIcon, type ActionIconName } from "./ActionIcon";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "title" | "aria-label"> {
  label: string;
  description?: string;
  icon: ActionIconName;
  children?: ReactNode;
}

/** A named action with a tooltip for both pointer and keyboard users, including when disabled. */
export function IconButton({ label, description, icon, className = "", children, onFocus, onBlur, onKeyDown, onClick, ...props }: IconButtonProps) {
  const tooltipId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showTooltip = (hovered || focused) && !dismissed;

  function cancelHover() {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = undefined;
  }

  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  useEffect(() => {
    if (!showTooltip) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") setDismissed(true); };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [showTooltip]);

  return <span className="icon-action" onPointerEnter={() => {
    cancelHover();
    setDismissed(false);
    hoverTimer.current = setTimeout(() => setHovered(true), 400);
  }} onPointerLeave={() => { cancelHover(); setHovered(false); }}>
    <button {...props} type={props.type ?? "button"} className={`icon-button ${className}`} aria-label={label} aria-describedby={showTooltip ? tooltipId : undefined}
      onFocus={(event) => { cancelHover(); setFocused(true); setDismissed(false); onFocus?.(event); }}
      onBlur={(event) => { setFocused(false); onBlur?.(event); }}
      onKeyDown={(event) => { if (event.key === "Escape") setDismissed(true); onKeyDown?.(event); }}
      onClick={(event) => { cancelHover(); setDismissed(true); onClick?.(event); }}>
      <ActionIcon name={icon} />{children}
    </button>
    <span id={tooltipId} className="icon-action-tooltip" role="tooltip" hidden={!showTooltip}>
      <strong>{label}</strong>{description ? <> <span>{description}</span></> : null}
    </span>
  </span>;
}
