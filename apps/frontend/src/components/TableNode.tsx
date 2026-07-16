import {
  Handle,
  NodeResizer,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from "@xyflow/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TableNode as TableNodeType } from "../graph/schema-graph";
import { useCanvasInteraction } from "./CanvasInteractionContext";
import { useCanvasSettings } from "./CanvasSettingsContext";

export function TableNode({ id, data, selected, width, height }: NodeProps<TableNodeType>) {
  const settings = useCanvasSettings();
  const { spacePanMode } = useCanvasInteraction();
  const updateNodeInternals = useUpdateNodeInternals();
  const [indexesExpanded, setIndexesExpanded] = useState(settings.indexes === "expanded");
  const [actionsOpen, setActionsOpen] = useState(false);
  const [hoveredColumn, setHoveredColumn] = useState<string>();
  const [columnCenters, setColumnCenters] = useState<Record<string, number>>({});
  const tableNodeRef = useRef<HTMLElement>(null);
  const columnRefs = useRef(new Map<string, HTMLDivElement>());
  const hoverClearTimer = useRef<number | undefined>(undefined);
  const visibleColumns = useMemo(
    () => data.table.columns.slice(0, settings.maxInitialColumns),
    [data.table.columns, settings.maxInitialColumns],
  );
  const primaryColumns = new Set(data.table.primaryKey?.columns ?? []);
  const foreignColumns = new Set(data.table.foreignKeys.flatMap((key) => key.columns));
  const inferredColumns = new Set(data.inferredForeignKeyColumns ?? []);
  const logicalColumns = new Set(data.logicalForeignKeyColumns ?? []);
  const referencedColumns = new Set(data.referencedForeignKeyColumns ?? []);
  const uniqueColumns = new Set(data.table.indexes.filter((index) => index.unique).flatMap((index) => index.columns));
  const indexedColumns = new Set(data.table.indexes.flatMap((index) => index.columns));

  useEffect(() => {
    updateNodeInternals(id);
  }, [height, id, updateNodeInternals, width]);

  const measureColumnCenters = useCallback(() => {
    const tableNode = tableNodeRef.current;
    if (!tableNode) return;
    const next = Object.fromEntries(visibleColumns.flatMap((column) => {
      const row = columnRefs.current.get(column.name);
      if (!row) return [];
      // React Flow applies zoom with a CSS transform. Bounding client rects are
      // therefore screen-scaled, while Handle positions are node-local CSS
      // coordinates. offsetTop/offsetHeight keep both values in the same,
      // unscaled coordinate system and prevent handles drifting as zoom changes.
      return [[column.name, row.offsetTop - tableNode.offsetTop + row.offsetHeight / 2]];
    }));
    setColumnCenters((current) => {
      const keys = Object.keys(next);
      const unchanged = keys.length === Object.keys(current).length
        && keys.every((key) => Math.abs((current[key] ?? -1) - next[key]) < 0.5);
      return unchanged ? current : next;
    });
  }, [visibleColumns]);

  useLayoutEffect(() => {
    measureColumnCenters();
    const tableNode = tableNodeRef.current;
    if (!tableNode || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureColumnCenters);
    observer.observe(tableNode);
    return () => observer.disconnect();
  }, [height, measureColumnCenters, settings.showTableComments, width]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [columnCenters, id, updateNodeInternals]);

  useEffect(() => () => {
    if (hoverClearTimer.current !== undefined) window.clearTimeout(hoverClearTimer.current);
  }, []);

  const showColumnHandles = useCallback((column: string) => {
    if (hoverClearTimer.current !== undefined) window.clearTimeout(hoverClearTimer.current);
    hoverClearTimer.current = undefined;
    setHoveredColumn(column);
  }, []);

  const hideColumnHandlesSoon = useCallback((column: string) => {
    if (hoverClearTimer.current !== undefined) window.clearTimeout(hoverClearTimer.current);
    hoverClearTimer.current = window.setTimeout(() => {
      setHoveredColumn((current) => current === column ? undefined : current);
      hoverClearTimer.current = undefined;
    }, 80);
  }, []);

  return (
    <>
      <NodeResizer
        isVisible={selected && !spacePanMode}
        minWidth={240}
        minHeight={120}
        maxWidth={920}
        maxHeight={1_600}
        handleClassName="table-resize-handle"
        lineClassName="table-resize-line"
      />
      <article
        ref={tableNodeRef}
        className="table-node"
        data-selected={selected || undefined}
        data-change={data.changeStatus}
        data-core={data.isCore || undefined}
        data-relationship-highlighted={data.relationshipHighlighted || undefined}
        style={data.domainColor ? { borderTopColor: data.domainColor } : undefined}
      >
      {!settings.fieldLevelEdges ? <><Handle id="table-target-left" type="target" position={Position.Left} isConnectable={false} /><Handle id="table-target-right" type="target" position={Position.Right} isConnectable={false} /><Handle id="table-source-left" type="source" position={Position.Left} isConnectable={false} /><Handle id="table-source-right" type="source" position={Position.Right} isConnectable={false} /></> : null}
      <header>
        {settings.showSchema ? <span>{data.schema}</span> : null}
        <strong>{data.isCore ? "★ " : ""}{data.table.key.name}</strong>
        {data.onOpenQuery ? <div className="table-node-actions nodrag nopan">
          <button type="button" aria-label={`Query ${data.table.key.name}`} aria-expanded={actionsOpen} onClick={(event) => { event.stopPropagation(); setActionsOpen((value) => !value); }}>•••</button>
          {actionsOpen ? <div role="menu"><button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); setActionsOpen(false); data.onOpenQuery?.(data.table); }}>Preview rows</button><button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); setActionsOpen(false); data.onOpenQuery?.(data.table); }}>Open in Query</button></div> : null}
        </div> : null}
      </header>
      {settings.showTableComments && data.table.comment ? (
        <p className="table-node-comment">{data.table.comment}</p>
      ) : null}
      <div className="table-columns">
        {visibleColumns.map((column) => (
          <div
            className="table-column"
            key={column.name}
            ref={(element) => {
              if (element) columnRefs.current.set(column.name, element);
              else columnRefs.current.delete(column.name);
            }}
            data-column-name={column.name}
            data-relationship-column={data.relationshipColumn === column.name || undefined}
            data-connect-target={data.relationshipConnectTargets?.[column.name]}
            onMouseEnter={() => showColumnHandles(column.name)}
            onMouseLeave={() => hideColumnHandlesSoon(column.name)}
          >
            <span className="column-name">
              {settings.showKeyBadges && primaryColumns.has(column.name) ? <b title="Primary key">PK</b> : null}
              {settings.showKeyBadges && foreignColumns.has(column.name) ? <b className="fk-badge" title="Physical foreign key">FK</b> : null}
              {settings.showKeyBadges && !primaryColumns.has(column.name) && uniqueColumns.has(column.name) ? <b title="Unique index member">UQ</b> : null}
              {settings.showKeyBadges && !primaryColumns.has(column.name) && !uniqueColumns.has(column.name) && indexedColumns.has(column.name) ? <b title="Index member">IX</b> : null}
              {settings.showKeyBadges && !foreignColumns.has(column.name) && !logicalColumns.has(column.name) && inferredColumns.has(column.name) ? (
                <b className="inferred-fk-badge" title="Inferred from naming; not a database constraint">?FK</b>
              ) : null}
              {settings.showKeyBadges && !foreignColumns.has(column.name) && logicalColumns.has(column.name) ? (
                <b className="logical-fk-badge" title="Logical relationship; no database constraint">LR</b>
              ) : null}
              {settings.showKeyBadges && column.generated ? <b title="Generated column">GEN</b> : null}
              {settings.showKeyBadges && /(?:@deprecated|\bdeprecated\b)/i.test(column.comment ?? "") ? <b title="Deprecated column marker">DEP</b> : null}
              {column.name}
            </span>
            <span className="column-type">
              {settings.showColumnTypes ? column.formattedType : ""}
              {settings.showColumnNullable && !column.nullable ? " · NN" : ""}
            </span>
            {settings.showColumnDefaults && column.defaultValue ? (
              <small className="column-default">default {column.defaultValue}</small>
            ) : null}
            {settings.showColumnComments && column.comment ? (
              <small className="column-comment">{column.comment}</small>
            ) : null}
          </div>
        ))}
        {data.table.columns.length > settings.maxInitialColumns ? (
          <p className="table-columns-more">+{data.table.columns.length - settings.maxInitialColumns} more fields</p>
        ) : null}
      </div>
      {data.table.indexes.length > 0 && settings.indexes !== "hidden" ? (
        <div className="table-indexes" aria-label="Indexes">
          {settings.indexes === "collapsed" ? (
            <button type="button" className="table-index-toggle" onClick={() => setIndexesExpanded((value) => !value)}>
              {indexesExpanded ? "Hide" : "Show"} {data.table.indexes.length} indexes
            </button>
          ) : null}
          {indexesExpanded || settings.indexes === "expanded" ? data.table.indexes.slice(0, 5).map((index) => (
            <div key={index.name} title={`${index.name} (${index.columns.join(", ")})`}>
              <b>{index.primary ? "PK" : index.unique ? "UQ" : "IX"}</b>
              <span>{index.name}</span>
              <small>{index.columns.join(", ")}</small>
            </div>
          )) : null}
          {(indexesExpanded || settings.indexes === "expanded") && data.table.indexes.length > 5 ? (
            <p>+{data.table.indexes.length - 5} more indexes</p>
          ) : null}
        </div>
      ) : null}
      </article>
      {visibleColumns.map((column) => {
        const top = columnCenters[column.name];
        if (!Number.isFinite(top)) return null;
        const targetEnabled = (settings.fieldLevelEdges || data.relationshipsEditable)
          && (referencedColumns.has(column.name) || data.relationshipsEditable);
        const sourceEnabled = (settings.fieldLevelEdges || data.relationshipsEditable)
          && (foreignColumns.has(column.name) || inferredColumns.has(column.name) || logicalColumns.has(column.name) || data.relationshipsEditable);
        return <div className="field-handle-row" key={column.name} style={{ top }}>
          {targetEnabled ? <>
            <Handle id={`target:${column.name}:left`} className="field-handle field-handle-left field-handle-target" type="target" position={Position.Left} isConnectable={data.relationshipsEditable} />
            <Handle id={`target:${column.name}:right`} className="field-handle field-handle-right field-handle-target" type="target" position={Position.Right} isConnectable={data.relationshipsEditable} />
          </> : null}
          {sourceEnabled ? <>
            <Handle id={`source:${column.name}:left`} className={`field-handle field-handle-left field-handle-source${hoveredColumn === column.name ? " field-handle-visible" : ""}`} type="source" position={Position.Left} isConnectable={data.relationshipsEditable} onMouseEnter={() => showColumnHandles(column.name)} onMouseLeave={() => hideColumnHandlesSoon(column.name)} />
            <Handle id={`source:${column.name}:right`} className={`field-handle field-handle-right field-handle-source${hoveredColumn === column.name ? " field-handle-visible" : ""}`} type="source" position={Position.Right} isConnectable={data.relationshipsEditable} onMouseEnter={() => showColumnHandles(column.name)} onMouseLeave={() => hideColumnHandlesSoon(column.name)} />
          </> : null}
        </div>;
      })}
    </>
  );
}
