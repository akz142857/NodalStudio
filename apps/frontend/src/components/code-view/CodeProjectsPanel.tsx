import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Button } from "../../design-system/Button";
import { ModalSurface } from "../../design-system/ModalSurface";
import { useI18n } from "../../i18n";
import type { CodeProjectGroupAction, CodeProjectGroupColor, CodeSavedProject, CodeSavedProjectGroup } from "../../platform/code-review";
import { ActionIcon } from "../ActionIcon";
import { IconButton } from "../IconButton";
import { SchemaObjectMenu, type SchemaObjectMenuAction } from "../SchemaObjectMenu";
import { isCodeContextMenuKey, useCodeContextMenu } from "./use-code-context-menu";

const groupColors: readonly CodeProjectGroupColor[] = ["red", "orange", "yellow", "green", "blue", "purple", "gray"];

function GroupColor({ color }: { color: CodeProjectGroupColor | null }) {
  return <span className="code-project-group-color" data-color={color ?? undefined} aria-hidden="true" />;
}

export type ProjectAction =
  | { kind: "add"; quickOpen?: boolean }
  | { kind: "open"; id: string; fromFiles?: boolean }
  | { kind: "relocate" | "remove"; id: string }
  | { kind: "pin"; id: string; pinned: boolean }
  | { kind: "group"; input: CodeProjectGroupAction }
  | { kind: "pasteProjects" };

function projectLocation(project: CodeSavedProject, projects: readonly CodeSavedProject[]) {
  if (!projects.some(({ id, name }) => id !== project.id && name === project.name)) return undefined;
  return project.path.replace(/[\\/]$/, "").replace(/[\\/][^\\/]+$/, "");
}

export function CodeProjectSwitcher({ projects, currentId, name, busy, onAction, onManage }: {
  projects: readonly CodeSavedProject[];
  currentId: string | null | undefined;
  name: string;
  busy: boolean;
  onAction: (action: ProjectAction) => void;
  onManage: () => void;
}) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLButtonElement>();
  const label = t("codeReview.projects.switchFromFiles", { name });
  const ordered = [...projects.filter((project) => project.pinned), ...projects.filter((project) => !project.pinned)];
  return <h2 className="code-review-project-name code-review-project-heading">
    <button type="button" className="code-review-project-trigger" data-code-project-switcher="" title={name}
      aria-label={label} aria-haspopup="menu" aria-expanded={Boolean(anchor)}
      aria-busy={busy || undefined} aria-disabled={busy || undefined}
      onClick={(event) => { if (!busy) setAnchor(anchor ? undefined : event.currentTarget); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" && !busy) {
          event.preventDefault();
          setAnchor(event.currentTarget);
        }
      }}>
      <span>{name}</span><ActionIcon name="chevronDown" />
    </button>
    {anchor && <SchemaObjectMenu anchor={anchor} name={label} showName={false} align="start" className="code-review-project-menu"
      actions={[
        ...ordered.map((project, index) => {
          const location = projectLocation(project, projects);
          return {
            id: project.id,
            label: location ? `${project.name} · ${location}` : project.name,
            description: project.path,
            checked: currentId === project.id,
            separatorBefore: !project.pinned && ordered[index - 1]?.pinned,
            run: () => { if (currentId !== project.id) onAction({ kind: "open", id: project.id, fromFiles: true }); },
          };
        }),
        { label: t("codeReview.projects.manage"), separatorBefore: ordered.length > 0, run: onManage },
      ]} onClose={(restoreFocus) => {
        setAnchor(undefined);
        if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
      }} />}
  </h2>;
}

export function CodeProjectsPanel({ projects, groups, currentId, failedId, busy, loading, loadFailed, finderActions, allowPasteProjects, onRetry, onAction, onActionAsync,
  filter, onFilterChange, scrollTopRef }: {
  projects: readonly CodeSavedProject[];
  groups: readonly CodeSavedProjectGroup[];
  currentId: string | null | undefined;
  failedId: string | undefined;
  busy: boolean;
  loading: boolean;
  loadFailed: boolean;
  finderActions?: (id: string) => SchemaObjectMenuAction[];
  allowPasteProjects?: boolean;
  onRetry: () => void;
  onAction: (action: ProjectAction) => void;
  onActionAsync?: (action: ProjectAction) => Promise<unknown>;
  filter: string;
  onFilterChange: (filter: string) => void;
  scrollTopRef: RefObject<number>;
}) {
  const { t } = useI18n();
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (list.current && !loading && !loadFailed) list.current.scrollTop = scrollTopRef.current;
  }, [scrollTopRef, loading, loadFailed]);
  const [menu, setMenu] = useState<{ title: string; anchor: HTMLButtonElement; actions: SchemaObjectMenuAction[]; groupId?: string; projectId?: string; panel?: boolean }>();
  const [editing, setEditing] = useState<{ group?: CodeSavedProjectGroup; value: string; error?: string }>();
  const contextMenu = useCodeContextMenu();
  const query = filter.trim().toLocaleLowerCase();
  const entries = projects.filter(({ name, path, groupId }) =>
    name.toLocaleLowerCase().includes(query) || path.toLocaleLowerCase().includes(query)
      || (groupId && groups.some((group) => group.id === groupId && group.name.toLocaleLowerCase().includes(query))));
  const addLabel = t("codeReview.projects.add");
  const colorName = (color: CodeProjectGroupColor | null | undefined) => t(color ? `codeReview.projects.color.${color}` : "codeReview.projects.color.none");
  const toggleMenu = (anchor: HTMLButtonElement, title: string, actions: SchemaObjectMenuAction[], meta?: { groupId?: string; projectId?: string; panel?: boolean }) => {
    setMenu((current) => current?.anchor === anchor ? undefined : { anchor, title, actions, ...meta });
  };
  const panelActions: SchemaObjectMenuAction[] = [
    { label: t("codeReview.projects.newGroup"), run: () => setEditing({ value: "" }) },
    ...(allowPasteProjects ? [{ label: t("codeReview.projects.pasteFolders"), run: () => onAction({ kind: "pasteProjects" }) }] : []),
  ];
  const rowActions = (project: CodeSavedProject): SchemaObjectMenuAction[] => [
    { label: t(project.pinned ? "codeReview.projects.unpin" : "codeReview.projects.pin"),
      run: () => onAction({ kind: "pin", id: project.id, pinned: !project.pinned }) },
    { label: t("codeReview.projects.moveGroup"), children: [
      { id: "ungrouped", label: t("codeReview.projects.ungrouped"), checked: project.groupId == null,
        run: () => onAction({ kind: "group", input: { kind: "move", projectId: project.id, groupId: null } }) },
      ...groups.map((group) => ({ id: group.id, label: group.name, checked: project.groupId === group.id,
        leading: group.color ? <GroupColor color={group.color} /> : undefined,
        run: () => onAction({ kind: "group", input: { kind: "move", projectId: project.id, groupId: group.id } }) })),
    ], disabled: groups.length === 0 },
    ...(finderActions?.(project.id) ?? []),
    { label: t("codeReview.projects.relocate"), run: () => onAction({ kind: "relocate", id: project.id }) },
    { label: t("codeReview.projects.remove"), separatorBefore: true, run: () => onAction({ kind: "remove", id: project.id }) },
  ];
  const groupActions = (group: CodeSavedProjectGroup): SchemaObjectMenuAction[] => [
    { label: t("codeReview.projects.renameGroup"), run: () => setEditing({ group, value: group.name }) },
    { label: t("codeReview.projects.groupColor"), className: "code-project-color-menu", children: [null, ...groupColors].map((color) => ({
      id: color ?? "none",
      label: colorName(color),
      checked: (group.color ?? null) === color,
      leading: <GroupColor color={color} />,
      run: () => {
        if ((group.color ?? null) !== color) onAction({ kind: "group", input: { kind: "color", id: group.id, color } });
      },
    })) },
    { label: t("codeReview.projects.removeGroup"), separatorBefore: true, run: () => onAction({ kind: "group", input: { kind: "remove", id: group.id } }) },
  ];
  const renderEntries = (items: readonly CodeSavedProject[]) => items.length > 0 && <ul>
        {items.map((project) => {
          const { id, name, path } = project;
          const location = projectLocation(project, projects);
          return <li key={id} className="code-project-row" data-active={currentId === id || undefined}>
            <button type="button" className="code-project-open" aria-current={currentId === id ? "true" : undefined}
              aria-haspopup="menu" aria-keyshortcuts="Shift+F10" disabled={busy} title={path} onClick={() => onAction({ kind: "open", id })}
              onContextMenu={(event) => { if (!busy) contextMenu.show(event, name, rowActions(project)); }}
              onKeyDown={(event) => { if (!busy && isCodeContextMenuKey(event)) contextMenu.show(event, name, rowActions(project)); }}>
              <ActionIcon name="folder" />
              <span className="code-project-name"><strong>{name}</strong>
                {failedId === id ? <small>{t("codeReview.projects.unavailable")}</small>
                  : location ? <small>{location}</small> : null}
              </span>
            </button>
            <IconButton className="code-review-tool code-project-actions" icon="more" label={t("codeReview.projects.actions", { name })}
              disabled={busy} aria-haspopup="menu" aria-expanded={menu?.projectId === id}
              onClick={(event) => toggleMenu(event.currentTarget, name, rowActions(project), { projectId: id })} />
          </li>;
        })}
      </ul>;
  const staticGroup = (label: string, items: readonly CodeSavedProject[]) => items.length > 0 && <section className="code-project-group" aria-label={label}>
    <h2>{label}</h2>{renderEntries(items)}
  </section>;
  const renderGroup = (group: CodeSavedProjectGroup) => {
    const members = entries.filter((entry) => entry.groupId === group.id);
    if (query && !members.length && !group.name.toLocaleLowerCase().includes(query)) return null;
    const collapsed = !query && group.collapsed;
    return <section key={group.id} className="code-project-group" aria-label={group.name}>
      <div className="code-project-group-heading">
        <h2><button type="button" aria-expanded={!collapsed} disabled={busy || Boolean(query)}
          aria-description={group.color ? colorName(group.color) : undefined}
          onClick={() => onAction({ kind: "group", input: { kind: "collapse", id: group.id, collapsed: !group.collapsed } })}>
          <ActionIcon name={collapsed ? "chevronRight" : "chevronDown"} />
          {group.color && <GroupColor color={group.color} />}
          <span className="code-project-group-name">{group.name}</span>
        </button></h2>
        <IconButton className="code-review-tool code-project-actions" icon="more" label={t("codeReview.projects.groupActions", { name: group.name })}
          aria-haspopup="menu" aria-disabled={busy || undefined}
          aria-expanded={menu?.groupId === group.id}
          onClick={(event) => { if (!busy) toggleMenu(event.currentTarget, group.name, groupActions(group), { groupId: group.id }); }} />
      </div>
      {!collapsed && renderEntries(members)}
    </section>;
  };
  const groupTitle = t(editing?.group ? "codeReview.projects.renameGroup" : "codeReview.projects.newGroup");
  const matchingGroup = groups.some((group) => group.name.toLocaleLowerCase().includes(query));
  return <>
    <header className="code-review-header">
      <div className="code-review-header-actions" role="group" aria-label={t("codeReview.panelActions", { name: t("codeReview.projects.title") })}>
        <IconButton className="code-review-tool" icon="add" label={addLabel} disabled={busy || loadFailed}
          onClick={() => onAction({ kind: "add" })} />
        <IconButton className="code-review-tool" icon="more" label={t("codeReview.projects.panelActions")} aria-haspopup="menu"
          aria-expanded={Boolean(menu?.panel)} disabled={busy || loadFailed}
          onClick={(event) => toggleMenu(event.currentTarget, t("codeReview.projects.title"), panelActions, { panel: true })} />
      </div>
    </header>
    {(projects.length > 0 || groups.length > 0) && <div className="code-review-sidebar-controls">
      <div className="code-review-filter">
        <ActionIcon name="search" />
        <input type="search" data-code-project-filter aria-label={t("codeReview.projects.filter")} placeholder={t("codeReview.projects.filter")}
          value={filter} onChange={(event) => {
            scrollTopRef.current = 0;
            if (list.current) list.current.scrollTop = 0;
            onFilterChange(event.target.value);
          }} />
      </div>
    </div>}
    <div ref={list} className="code-project-list" aria-busy={busy || loading}
      onScroll={(event) => { scrollTopRef.current = event.currentTarget.scrollTop; }}
      onContextMenu={(event) => { if (!busy && !loadFailed) contextMenu.show(event, t("codeReview.projects.title"), panelActions); }}>
      {loading ? <p role="status">{t("navigation.loadingWorkspace")}</p>
        : loadFailed ? <div className="code-project-empty">
          <p role="alert">{t("codeReview.projects.loadFailed")}</p>
          <Button size="small" onClick={onRetry}>{t("codeReview.projects.retry")}</Button>
        </div>
          : entries.length || matchingGroup ? <>
            {staticGroup(t("codeReview.projects.pinned"), entries.filter((entry) => entry.pinned))}
            {groups.map(renderGroup)}
            {staticGroup(t("codeReview.projects.saved"), entries.filter((entry) => !entry.pinned && !entry.groupId))}
          </> : <p>{t(projects.length || groups.length ? "codeReview.projects.noMatches" : "codeReview.projects.empty")}</p>}
    </div>
    {menu && <SchemaObjectMenu anchor={menu.anchor} name={menu.title} showName={false} actions={menu.actions}
      className={menu.groupId ? "code-project-group-menu" : undefined} onClose={(restoreFocus) => {
        setMenu(undefined);
        if (restoreFocus && menu.anchor.isConnected) menu.anchor.focus({ preventScroll: true });
      }} />}
    {contextMenu.surface}
    {editing && <ModalSurface label={groupTitle} onDismiss={() => { if (!busy) setEditing(undefined); }}>
      <form className="code-project-group-form ds-surface" onSubmit={(event) => {
        event.preventDefault();
        const name = editing.value.trim();
        if (!name || busy) return;
        const input: ProjectAction = { kind: "group", input: editing.group ? { kind: "rename", id: editing.group.id, name } : { kind: "create", name } };
        if (onActionAsync) {
          setEditing({ ...editing, error: undefined });
          void onActionAsync(input).then(() => setEditing(undefined), (error: unknown) => {
            const key = String(error) === "codeReviewDuplicateGroupName" ? "codeReview.projects.duplicateGroup"
              : String(error) === "codeReviewInvalidGroupName" ? "codeReview.projects.invalidGroup"
                : "codeReview.projects.actionFailed";
            setEditing((current) => current ? { ...current, error: t(key) } : current);
          });
        } else {
          onAction(input);
          setEditing(undefined);
        }
      }}>
        <h2>{groupTitle}</h2>
        <label>{t("codeReview.projects.groupName")}<input type="text" value={editing.value} maxLength={80} data-modal-focus
          aria-invalid={editing.error ? "true" : undefined}
          onChange={(event) => setEditing({ ...editing, value: event.target.value, error: undefined })} /></label>
        {editing.error && <p role="alert">{editing.error}</p>}
        <div className="code-review-note-actions">
          <Button disabled={busy} onClick={() => setEditing(undefined)}>{t("codeReview.cancel")}</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!editing.value.trim()}>{t("settings.save")}</Button>
        </div>
      </form>
    </ModalSurface>}
  </>;
}
