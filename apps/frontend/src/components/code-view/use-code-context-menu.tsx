import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { SchemaObjectMenu, type SchemaObjectMenuAction } from "../SchemaObjectMenu";

type MenuEvent = MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>;

export function isCodeContextMenuKey(event: KeyboardEvent) {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

export function useCodeContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; name: string; actions: SchemaObjectMenuAction[]; trigger: HTMLElement }>();

  function show(event: MenuEvent, name: string, actions: SchemaObjectMenuAction[], trigger = event.currentTarget) {
    event.preventDefault();
    event.stopPropagation();
    const anchor = trigger.getBoundingClientRect();
    const mouse = event.type === "contextmenu" && "clientX" in event && (event.clientX !== 0 || event.clientY !== 0);
    setMenu({ x: mouse ? event.clientX : anchor.left, y: mouse ? event.clientY : anchor.bottom, name, actions, trigger });
  }

  return { show, trigger: menu?.trigger, surface: menu && <SchemaObjectMenu {...menu} onClose={(restoreFocus) => {
    setMenu(undefined);
    if (restoreFocus && menu.trigger.isConnected) menu.trigger.focus({ preventScroll: true });
  }} /> };
}
