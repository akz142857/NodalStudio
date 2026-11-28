import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { useI18n } from "../../i18n";
import { SchemaObjectMenu, type SchemaObjectMenuAction } from "../SchemaObjectMenu";

type MenuEvent = MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>;

export function isCodeContextMenuKey(event: KeyboardEvent) {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

export function useCodeContextMenu() {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{ x: number; y: number; name: string; actions: SchemaObjectMenuAction[]; trigger: HTMLElement }>();

  function show(event: MenuEvent, name: string, actions: SchemaObjectMenuAction[], trigger = event.currentTarget) {
    event.preventDefault();
    event.stopPropagation();
    const anchor = trigger.getBoundingClientRect();
    const mouse = event.type === "contextmenu" && "clientX" in event && (event.clientX !== 0 || event.clientY !== 0);
    setMenu({ x: mouse ? event.clientX : anchor.left, y: mouse ? event.clientY : anchor.bottom, name, actions, trigger });
  }

  const showFinder = (event: MenuEvent, name: string, reveal: () => void) => show(event, name, [{
    label: t("codeReview.files.revealFinder"), run: reveal,
  }]);
  return { show, showFinder, close: () => setMenu(undefined), trigger: menu?.trigger, surface: menu && <SchemaObjectMenu {...menu}
    portalHost={menu.trigger.closest<HTMLElement>("dialog[open]") ?? undefined} onClose={(restoreFocus) => {
    setMenu(undefined);
    if (restoreFocus && menu.trigger.isConnected) menu.trigger.focus({ preventScroll: true });
  }} /> };
}
