import { fireEvent, screen } from "@testing-library/react";

/** Follow the public disclosure before exercising an advanced canvas command. */
export function canvasToolButton(name: string) {
  const restore = screen.queryByRole("button", { name: "Expand canvas toolbar" });
  if (restore) fireEvent.click(restore);
  const trigger = screen.getByRole("button", { name: "Canvas tools" });
  if (trigger.getAttribute("aria-expanded") !== "true" && !trigger.hasAttribute("disabled")) fireEvent.click(trigger);
  return screen.getByRole("button", { name, hidden: trigger.hasAttribute("disabled") });
}
