import { useI18n } from "../i18n";
import { useEffect, useId, useMemo, useState } from "react";
import { ModalSurface } from "../design-system/ModalSurface";

export interface AppCommand {
  id: string;
  label: string;
  keywords: string;
  shortcut?: string;
  run: () => void;
}

export function CommandPalette({ commands, onClose }: { commands: AppCommand[]; onClose: () => void }) {
  const { t } = useI18n();

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listId = useId();
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? commands.filter((command) => `${command.label} ${command.keywords}`.toLowerCase().includes(normalized))
      : commands;
  }, [commands, query]);
  const selected = filtered[Math.min(index, filtered.length - 1)];
  const selectedId = selected && `${listId}-${selected.id}`;
  useEffect(() => {
    if (selectedId) document.getElementById(selectedId)?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId]);

  function activate(command: AppCommand) {
    command.run();
    onClose();
  }

  return (
    <ModalSurface label={t("navigation.commandPalette")} onDismiss={onClose}>
    <div className="command-palette-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="command-palette">
        <label>
          <span>{t("navigation.findACommand")}</span>
          <input data-modal-focus type="search" role="combobox" value={query} aria-autocomplete="list" autoComplete="off"
            aria-expanded={filtered.length > 0} aria-controls={filtered.length ? listId : undefined} aria-activedescendant={selectedId}
            onChange={(event) => { setQuery(event.target.value); setIndex(0); }} placeholder={t("navigation.typeACommand")} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || !filtered.length) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setIndex((previous) => (Math.min(previous, filtered.length - 1) + step + filtered.length) % filtered.length);
            } else if (event.key === "Enter" && selected) {
              event.preventDefault();
              activate(selected);
            }
          }} />
        </label>
        <div className="command-results" id={listId} role={filtered.length ? "listbox" : "status"} aria-label={t("navigation.commandPalette")}>
          {filtered.map((command) => <button type="button" role="option" tabIndex={-1} id={`${listId}-${command.id}`}
            aria-selected={command === selected} key={command.id} onMouseDown={(event) => event.preventDefault()} onClick={() => activate(command)}>
            <span>{command.label}</span>{command.shortcut ? <kbd>{command.shortcut}</kbd> : null}</button>)}
          {filtered.length === 0 ? <p>{t("navigation.noMatchingCommands")}</p> : null}
        </div>
      </section>
    </div>
    </ModalSurface>
  );
}
