import type { ComponentPropsWithRef } from "react";

type ButtonProps = ComponentPropsWithRef<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "normal" | "small";
  busy?: boolean;
};

/** Place in a ds-surface. Pending controls remain named and cannot submit twice. */
export function Button({ variant = "secondary", size = "normal", busy, disabled, className = "", type = "button", ...props }: ButtonProps) {
  return <button {...props} type={type} className={`ds-button ${variant === "primary" ? "ds-primary" : ""} ${className}`} data-variant={variant} data-size={size} disabled={disabled || busy} aria-busy={busy || undefined} />;
}
