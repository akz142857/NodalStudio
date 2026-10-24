import { fireEvent, screen } from "@testing-library/react";

/** Open the public tools panel, including its directly visible relationship filters. */
export function openCanvasTools() {
  const restore = screen.queryByRole("button", { name: "Expand canvas toolbar" });
  if (restore) fireEvent.click(restore);
  const trigger = screen.getByRole("button", { name: "Canvas tools" });
  if (trigger.getAttribute("aria-expanded") !== "true" && !trigger.hasAttribute("disabled")) fireEvent.click(trigger);
  return trigger;
}

/** Follow the public disclosure before exercising an advanced canvas command. */
export function canvasToolButton(name: string) {
  const trigger = openCanvasTools();
  return screen.getByRole("button", { name, hidden: trigger.hasAttribute("disabled") });
}
