import { useI18n } from "../i18n";
import { useEffect, useId, useMemo, useState } from "react";
import { ModalSurface } from "../design-system/ModalSurface";
import { ActionIcon, type ActionIconName } from "./ActionIcon";
import { formatCommandShortcut } from "./command-shortcuts";

const groups = ["view", "structure", "settings"] as const;

export interface AppCommand<Id extends string = string> {
  id: Id;
  label: string;
  keywords: string;
  group: typeof groups[number];
  icon: ActionIconName;
  available?: boolean;
  shortcut?: string;
}

export function CommandPalette<Id extends string>({ commands, onClose, onRun }: { commands: AppCommand<Id>[]; onClose: () => void; onRun: (id: Id) => void }) {
  const { t } = useI18n();

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listId = useId();
  const sections = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/);
    return groups.map((group) => ({
      group,
      commands: commands.filter((command) => command.available !== false && command.group === group
        && terms.every((term) => `${command.label} ${command.keywords}`.toLowerCase().includes(term))),
    })).filter((section) => section.commands.length);
  }, [commands, query]);
  const filtered = sections.flatMap((section) => section.commands);
  const selected = filtered[Math.min(index, filtered.length - 1)];
  const selectedId = selected && `${listId}-${selected.id}`;
  useEffect(() => {
    if (selectedId) document.getElementById(selectedId)?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId]);

  function activate(command: AppCommand<Id>) {
    onClose();
    onRun(command.id);
  }

  return (
    <ModalSurface label={t("navigation.commandPalette")} onDismiss={onClose}>
    <div className="command-palette-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="command-palette ds-surface">
        <div className="command-search">
          <ActionIcon name="search" />
          <input data-modal-focus type="search" role="combobox" aria-label={t("navigation.findACommand")}
            value={query} aria-autocomplete="list" autoComplete="off"
            aria-expanded={filtered.length > 0} aria-controls={filtered.length ? listId : undefined} aria-activedescendant={selectedId}
            onChange={(event) => { setQuery(event.target.value); setIndex(0); }} placeholder={t("navigation.typeACommand")} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || !filtered.length) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setIndex((previous) => (Math.min(previous, filtered.length - 1) + step + filtered.length) % filtered.length);
            } else if (event.key === "Home" || event.key === "End") {
              if (query) return;
              event.preventDefault();
              setIndex(event.key === "Home" ? 0 : filtered.length - 1);
            } else if (event.key === "Enter" && selected) {
              event.preventDefault();
              if (!event.repeat) activate(selected);
            }
          }} />
          <button type="button" className="command-close" aria-label={t("commands.closePalette")} onClick={onClose}>
            <ActionIcon name="close" />
          </button>
        </div>
        <div className="command-results" id={listId} role={filtered.length ? "listbox" : "status"} aria-label={t("navigation.commandPalette")}>
          {sections.map(({ group, commands: sectionCommands }) => {
            const groupId = `${listId}-${group}`;
            return <div className="command-group" role="group" aria-labelledby={groupId} key={group}>
              <div className="command-group-title" id={groupId}>{t(`commands.group.${group}`)}</div>
              {sectionCommands.map((command) => {
                const id = `${listId}-${command.id}`;
                return <button type="button" role="option" tabIndex={-1} id={id} aria-label={command.label}
                  aria-describedby={command.shortcut ? `${id}-shortcut` : undefined} aria-selected={command === selected}
                  key={command.id} onPointerMove={() => setIndex(filtered.indexOf(command))}
                  onMouseDown={(event) => event.preventDefault()} onClick={() => activate(command)}>
                  <ActionIcon name={command.icon} /><span>{command.label}</span>
                  {command.shortcut ? <kbd id={`${id}-shortcut`}>{formatCommandShortcut(command.shortcut)}</kbd> : null}
                </button>;
              })}
            </div>;
          })}
          {!filtered.length ? <p>{t("navigation.noMatchingCommands")}</p> : null}
        </div>
        <footer className="command-hints" aria-hidden="true">
          {filtered.length ? <><span><kbd>↑ ↓</kbd>{t("commands.move")}</span><span><kbd>{formatCommandShortcut("Enter")}</kbd>{t("commands.run")}</span></> : null}
          <span><kbd>{formatCommandShortcut("Escape")}</kbd>{t("commands.close")}</span>
        </footer>
      </section>
    </div>
    </ModalSurface>
  );
}
