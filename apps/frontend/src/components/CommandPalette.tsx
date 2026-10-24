import { useI18n } from "../i18n";
import { useMemo, useState } from "react";

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
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? commands.filter((command) => `${command.label} ${command.keywords}`.toLowerCase().includes(normalized))
      : commands;
  }, [commands, query]);

  return (
    <div className="command-palette-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label={t("navigation.commandPalette")}>
        <label>
          <span>{t("navigation.findACommand")}</span>
          <input autoFocus type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("navigation.typeACommand")} onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "Enter" && filtered.length === 1) {
              filtered[0]?.run();
              onClose();
            }
          }} />
        </label>
        <div className="command-results">
          {filtered.map((command) => <button type="button" key={command.id} onClick={() => { command.run(); onClose(); }}><span>{command.label}</span>{command.shortcut ? <kbd>{command.shortcut}</kbd> : null}</button>)}
          {filtered.length === 0 ? <p>{t("navigation.noMatchingCommands")}</p> : null}
        </div>
      </section>
    </div>
  );
}
