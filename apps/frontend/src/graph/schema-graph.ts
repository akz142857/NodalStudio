import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type {
  DatabaseSnapshot,
  DomainGroup,
  LogicalRelationship,
  LogicalRelationshipStatus,
  ObjectAnnotation,
  SchemaChangeSet,
  TableDefinition,
} from "../platform";

export type ChangeStatus = "added" | "modified";

export interface TableNodeData extends Record<string, unknown> {
  schema: string;
  table: TableDefinition;
  changeStatus?: ChangeStatus;
  isCore?: boolean;
  domainColor?: string;
  annotation?: ObjectAnnotation;
  inferredForeignKeyColumns?: string[];
  logicalForeignKeyColumns?: string[];
  referencedForeignKeyColumns?: string[];
  onOpenQuery?: (table: TableDefinition) => void;
  relationshipsEditable?: boolean;
  relationshipHighlighted?: boolean;
  relationshipColumn?: string;
  relationshipConnectTargets?: Record<string, "valid" | "warning" | "invalid">;
}

export type TableNode = Node<TableNodeData, "table">;

export interface FieldEdgeData extends Record<string, unknown> {
  relationshipKind: "physical" | "logical" | "inferred";
  relationshipId?: string;
  relationshipStatus?: LogicalRelationshipStatus;
  sourceColumn: string;
  targetColumn: string;
  constraintName?: string;
  cardinality?: string;
  note?: string;
  confidence?: number;
  evidence?: string[];
  fieldLevel: boolean;
  onUpdate?: string;
  onDelete?: string;
}

export type FieldEdge = Edge<FieldEdgeData>;

export interface SchemaGraph {
  nodes: TableNode[];
  edges: FieldEdge[];
  physicalRelationshipCount: number;
  logicalRelationshipCount: number;
  inferredRelationshipCount: number;
}

export interface SchemaGraphOptions {
  query?: string;
  focusNodeId?: string;
  selectedNodeId?: string;
  rootNodeIds?: string[];
  relationshipDepth?: number;
  changeSet?: SchemaChangeSet;
  annotations?: ObjectAnnotation[];
  domainGroups?: DomainGroup[];
  includeInferredRelationships?: boolean;
  includePhysicalRelationships?: boolean;
  includeLogicalRelationships?: boolean;
  includeInvalidLogicalRelationships?: boolean;
  showRelationshipLabels?: boolean;
  edgeStyle?: "orthogonal" | "curved";
  fieldLevelEdges?: boolean;
  showCardinality?: boolean;
  showReferentialActions?: boolean;
  relationshipHighlightDepth?: number;
  highContrastRelations?: boolean;
  colorBlindPalette?: boolean;
  maxInitialColumns?: number;
  indexes?: "expanded" | "collapsed" | "hidden";
  showTableComments?: boolean;
  logicalRelationships?: LogicalRelationship[];
  ignoredRelationshipKeys?: string[];
  relationshipsEditable?: boolean;
}

export interface InferredRelationship {
  sourceId: string;
  targetId: string;
  column: string;
  referencedColumn: string;
  relationshipKey: string;
  confidence: number;
  evidence: string[];
}

export function tableNodeId(schema: string, table: string): string {
  return `${schema}.${table}`;
}

export function logicalRelationshipKey(
  sourceId: string,
  sourceColumn: string,
  targetId: string,
  targetColumn: string,
): string {
  return `${sourceId}[${sourceColumn}]->${targetId}[${targetColumn}]`;
}

export function inferredRelationshipRuleKey(relationship: Pick<InferredRelationship, "sourceId" | "column">) {
  return `rule:naming-id:${relationship.sourceId}.${relationship.column}`;
}

export function buildSchemaGraph(
  snapshot: DatabaseSnapshot,
  options: SchemaGraphOptions = {},
): SchemaGraph {
  const allTables = snapshot.schemas.flatMap((schema) =>
    schema.tables.map((table) => ({ schema: schema.name, table })),
  );

  const normalizedQuery = options.query?.trim().toLocaleLowerCase() ?? "";
  let includedIds = new Set(
    allTables
      .filter(({ schema, table }) => tableMatches(schema, table, normalizedQuery))
      .map(({ schema, table }) => tableNodeId(schema, table.key.name)),
  );

  const allTableIds = new Set(
    allTables.map(({ schema, table }) => tableNodeId(schema, table.key.name)),
  );

  if (options.focusNodeId && allTableIds.has(options.focusNodeId)) {
    const focusedIds = relatedTableIds(allTables, [options.focusNodeId], 1, options.logicalRelationships);
    includedIds = new Set([...includedIds].filter((id) => focusedIds.has(id)));
  }

  if (options.rootNodeIds?.length) {
    const viewIds = relatedTableIds(
      allTables,
      options.rootNodeIds,
      options.relationshipDepth ?? 1,
      options.logicalRelationships,
    );
    includedIds = new Set([...includedIds].filter((id) => viewIds.has(id)));
  }

  const tables = allTables.filter(({ schema, table }) =>
    includedIds.has(tableNodeId(schema, table.key.name)),
  );
  const ignoredRelationshipKeys = new Set(options.ignoredRelationshipKeys ?? []);
  const inferredRelationships = inferRelationships(allTables).filter(
    (relationship) =>
      includedIds.has(relationship.sourceId)
      && includedIds.has(relationship.targetId)
      && !ignoredRelationshipKeys.has(relationship.relationshipKey)
      && !ignoredRelationshipKeys.has(inferredRelationshipRuleKey(relationship)),
  );
  const inferredColumns = new Map<string, string[]>();
  const logicalColumns = new Map<string, string[]>();
  const highlightedRelationshipIds = options.selectedNodeId
    ? relatedTableIds(allTables, [options.selectedNodeId], options.relationshipHighlightDepth ?? 1, options.logicalRelationships)
    : null;
  const referencedColumns = new Map<string, Set<string>>();
  let physicalRelationshipCount = 0;
  for (const { table } of tables) {
    for (const foreignKey of table.foreignKeys) {
      const targetId = tableNodeId(
        foreignKey.referencedSchema,
        foreignKey.referencedTable,
      );
      if (!includedIds.has(targetId)) continue;
      physicalRelationshipCount += 1;
      const targetColumns = referencedColumns.get(targetId) ?? new Set<string>();
      foreignKey.referencedColumns.forEach((column) => targetColumns.add(column));
      referencedColumns.set(targetId, targetColumns);
    }
  }
  if (options.includeInferredRelationships) {
    for (const relationship of inferredRelationships) {
      const columns = inferredColumns.get(relationship.sourceId) ?? [];
      columns.push(relationship.column);
      inferredColumns.set(relationship.sourceId, columns);
      const targets = referencedColumns.get(relationship.targetId) ?? new Set<string>();
      targets.add(relationship.referencedColumn);
      referencedColumns.set(relationship.targetId, targets);
    }
  }
  if (options.includeLogicalRelationships !== false) {
    for (const relationship of options.logicalRelationships ?? []) {
      if (relationship.status === "disabled" || relationship.status === "orphaned") continue;
      const sourceId = tableNodeId(relationship.source.schema, relationship.source.table);
      const targetId = tableNodeId(relationship.target.schema, relationship.target.table);
      if (!includedIds.has(sourceId) || !includedIds.has(targetId)) continue;
      const sources = logicalColumns.get(sourceId) ?? [];
      sources.push(...relationship.source.columns);
      logicalColumns.set(sourceId, sources);
      const targets = referencedColumns.get(targetId) ?? new Set<string>();
      relationship.target.columns.forEach((column) => targets.add(column));
      referencedColumns.set(targetId, targets);
    }
  }

  const nodes: TableNode[] = tables.map(({ schema, table }, index) => ({
    id: tableNodeId(schema, table.key.name),
    type: "table",
    selected: options.selectedNodeId === tableNodeId(schema, table.key.name),
    position: {
      x: (index % 4) * 320,
      y: Math.floor(index / 4) * 300,
    },
    style: {
      width: 280,
      height: estimatedTableNodeHeight(table, {
        maxInitialColumns: options.maxInitialColumns,
        indexes: options.indexes,
        showTableComments: options.showTableComments,
      }),
      cursor: "default",
    },
    data: {
      schema,
      table,
      changeStatus: tableChangeStatus(schema, table.key.name, options.changeSet),
      ...tableSemantics(schema, table.key.name, options.annotations, options.domainGroups),
      inferredForeignKeyColumns: inferredColumns.get(tableNodeId(schema, table.key.name)),
      logicalForeignKeyColumns: logicalColumns.get(tableNodeId(schema, table.key.name)),
      referencedForeignKeyColumns: [
        ...(referencedColumns.get(tableNodeId(schema, table.key.name)) ?? []),
      ],
      relationshipsEditable: options.relationshipsEditable,
    },
  }));

  const physicalEdges: FieldEdge[] = options.includePhysicalRelationships === false ? [] : tables.flatMap(({ schema, table }) =>
    table.foreignKeys
      .filter((foreignKey) =>
        includedIds.has(tableNodeId(foreignKey.referencedSchema, foreignKey.referencedTable)),
      )
      .flatMap((foreignKey) =>
        foreignKey.columns.flatMap((sourceColumn, columnIndex) => {
          const targetColumn = foreignKey.referencedColumns[columnIndex];
          if (!targetColumn) return [];
          return [{
            id: `${schema}.${table.key.name}.${foreignKey.name}.${columnIndex}`,
            source: tableNodeId(schema, table.key.name),
            target: tableNodeId(foreignKey.referencedSchema, foreignKey.referencedTable),
            sourceHandle: options.fieldLevelEdges === false ? "table-source-right" : fieldHandleId("source", sourceColumn, "right"),
            targetHandle: options.fieldLevelEdges === false ? "table-target-left" : fieldHandleId("target", targetColumn, "left"),
            type: options.edgeStyle === "curved" ? "default" : "smoothstep",
            label: relationshipLabel(options, foreignKey.name, sourceColumn, foreignKey.referencedTable, targetColumn, foreignKey.onDelete, foreignKey.onUpdate),
            markerEnd: { type: MarkerType.ArrowClosed, color: options.colorBlindPalette ? "#0072b2" : "#2563eb" },
            style: { stroke: options.colorBlindPalette ? "#0072b2" : "#2563eb", strokeWidth: options.highContrastRelations ? 3 : 1.8, opacity: relationshipOpacity(highlightedRelationshipIds, tableNodeId(schema, table.key.name), tableNodeId(foreignKey.referencedSchema, foreignKey.referencedTable)) },
            labelStyle: { fill: "#1e40af", fontSize: 9, fontWeight: 600 },
            labelBgStyle: { fill: "#eff6ff", fillOpacity: 0.94 },
            labelBgPadding: [4, 2] as [number, number],
            labelBgBorderRadius: 3,
            zIndex: 2,
            interactionWidth: 20,
            data: {
              relationshipKind: "physical" as const,
              constraintName: foreignKey.name,
              sourceColumn,
              targetColumn,
              fieldLevel: options.fieldLevelEdges !== false,
              onDelete: foreignKey.onDelete,
              onUpdate: foreignKey.onUpdate,
            },
          }];
        }),
      ),
  );
  const physicalKeys = new Set(physicalEdges.map((edge) => logicalRelationshipKey(
    edge.source,
    edge.data?.sourceColumn ?? "",
    edge.target,
    edge.data?.targetColumn ?? "",
  )));
  const logicalEdges: FieldEdge[] = options.includeLogicalRelationships === false
    ? []
    : (options.logicalRelationships ?? []).flatMap((relationship) => {
        if (relationship.status === "disabled" && !options.includeInvalidLogicalRelationships) return [];
        if (
          relationship.status === "orphaned"
          || relationship.status === "supersededByPhysical"
        ) {
          if (!options.includeInvalidLogicalRelationships) return [];
        }
        const sourceId = tableNodeId(relationship.source.schema, relationship.source.table);
        const targetId = tableNodeId(relationship.target.schema, relationship.target.table);
        if (!includedIds.has(sourceId) || !includedIds.has(targetId)) return [];
        return relationship.source.columns.flatMap((sourceColumn, columnIndex) => {
          const targetColumn = relationship.target.columns[columnIndex];
          if (!targetColumn) return [];
          const key = logicalRelationshipKey(sourceId, sourceColumn, targetId, targetColumn);
          if (physicalKeys.has(key) && !options.includeInvalidLogicalRelationships) return [];
          const invalid = relationship.status === "disabled"
            || relationship.status === "orphaned"
            || relationship.status === "conflicted"
            || relationship.status === "supersededByPhysical";
          return [{
            id: `logical.${relationship.id}.${columnIndex}`,
            source: sourceId,
            target: targetId,
            sourceHandle: options.fieldLevelEdges === false ? "table-source-right" : fieldHandleId("source", sourceColumn, "right"),
            targetHandle: options.fieldLevelEdges === false ? "table-target-left" : fieldHandleId("target", targetColumn, "left"),
            type: options.edgeStyle === "curved" ? "default" : "smoothstep",
            label: logicalRelationshipLabel(options, relationship.name, relationship.cardinality),
            markerEnd: { type: MarkerType.ArrowClosed, color: invalid ? "#94a3b8" : "#7c3aed" },
            style: {
              stroke: invalid ? "#94a3b8" : "#7c3aed",
              strokeWidth: options.highContrastRelations ? 3 : 2,
              strokeDasharray: invalid ? "3 5" : "8 5",
              opacity: relationshipOpacity(highlightedRelationshipIds, sourceId, targetId),
            },
            labelStyle: { fill: invalid ? "#64748b" : "#6d28d9", fontSize: 9, fontWeight: 600 },
            labelBgStyle: { fill: "#f5f3ff", fillOpacity: 0.94 },
            labelBgPadding: [4, 2] as [number, number],
            labelBgBorderRadius: 3,
            zIndex: 2,
            interactionWidth: 20,
            data: {
              relationshipKind: "logical" as const,
              relationshipId: relationship.id,
              relationshipStatus: relationship.status,
              constraintName: relationship.name,
              sourceColumn,
              targetColumn,
              cardinality: relationship.cardinality,
              note: relationship.note ?? undefined,
              fieldLevel: options.fieldLevelEdges !== false,
            },
          }];
        });
      });
  const logicalKeys = new Set((options.logicalRelationships ?? []).flatMap((relationship) => {
    if (relationship.status === "disabled" || relationship.status === "orphaned") return [];
    const sourceId = tableNodeId(relationship.source.schema, relationship.source.table);
    const targetId = tableNodeId(relationship.target.schema, relationship.target.table);
    return relationship.source.columns.flatMap((column, index) => relationship.target.columns[index]
      ? [logicalRelationshipKey(sourceId, column, targetId, relationship.target.columns[index])]
      : []);
  }));
  const availableInferredRelationships = inferredRelationships.filter((relationship) =>
    !physicalKeys.has(relationship.relationshipKey) && !logicalKeys.has(relationship.relationshipKey));
  const inferredEdges: FieldEdge[] = options.includeInferredRelationships
    ? availableInferredRelationships.map((relationship) => ({
        id: `inferred.${relationship.sourceId}.${relationship.column}.${relationship.targetId}`,
        source: relationship.sourceId,
        target: relationship.targetId,
        sourceHandle: options.fieldLevelEdges === false ? "table-source-right" : fieldHandleId("source", relationship.column, "right"),
        targetHandle: options.fieldLevelEdges === false ? "table-target-left" : fieldHandleId("target", relationship.referencedColumn, "left"),
        type: options.edgeStyle === "curved" ? "default" : "smoothstep",
        label: options.showRelationshipLabels
          ? `? ${relationship.column} → ${relationship.referencedColumn}`
          : undefined,
        markerEnd: { type: MarkerType.ArrowClosed, color: options.colorBlindPalette ? "#d55e00" : "#b7791f" },
        style: { stroke: options.colorBlindPalette ? "#d55e00" : "#b7791f", strokeWidth: options.highContrastRelations ? 2.6 : 1.4, strokeDasharray: "6 4", opacity: relationshipOpacity(highlightedRelationshipIds, relationship.sourceId, relationship.targetId) },
        labelStyle: { fill: "#92400e", fontSize: 8 },
        labelBgStyle: { fill: "#fffbeb", fillOpacity: 0.94 },
        labelBgPadding: [3, 2] as [number, number],
        labelBgBorderRadius: 3,
        zIndex: 1,
        interactionWidth: 20,
        data: {
          relationshipKind: "inferred",
          sourceColumn: relationship.column,
          targetColumn: relationship.referencedColumn,
          fieldLevel: options.fieldLevelEdges !== false,
          confidence: relationship.confidence,
          evidence: relationship.evidence,
        },
      }))
    : [];

  return {
    nodes,
    edges: [...physicalEdges, ...logicalEdges, ...inferredEdges],
    physicalRelationshipCount,
    logicalRelationshipCount: (options.logicalRelationships ?? []).filter((relationship) => relationship.status !== "disabled").length,
    inferredRelationshipCount: availableInferredRelationships.length,
  };
}

export function estimatedTableNodeHeight(
  table: TableDefinition,
  options: {
    maxInitialColumns?: number;
    indexes?: "expanded" | "collapsed" | "hidden";
    showTableComments?: boolean;
  } = {},
): number {
  const visibleColumns = Math.min(
    table.columns.length,
    options.maxInitialColumns ?? table.columns.length,
  );
  const truncatedColumns = table.columns.length > visibleColumns ? 23 : 0;
  const indexRows = options.indexes === "hidden"
    ? 0
    : options.indexes === "collapsed"
      ? (table.indexes.length ? 32 : 0)
      : Math.min(table.indexes.length, 5) * 24 + (table.indexes.length > 5 ? 23 : 0);
  return Math.max(
    120,
    42
      + visibleColumns * 27
      + truncatedColumns
      + indexRows
      + (table.comment && options.showTableComments !== false ? 36 : 0),
  );
}

function relationshipOpacity(highlighted: Set<string> | null, source: string, target: string): number {
  return !highlighted || (highlighted.has(source) && highlighted.has(target)) ? 1 : 0.16;
}

export function fieldHandleId(
  kind: "source" | "target",
  column: string,
  side: "left" | "right",
): string {
  return `${kind}:${column}:${side}`;
}

export function orientFieldEdges(edges: FieldEdge[], nodes: TableNode[]): FieldEdge[] {
  const positions = new Map(nodes.map((node) => [node.id, node.position]));
  return edges.map((edge) => {
    if (!edge.data) return edge;
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) return edge;
    const verticallyAligned = Math.abs(source.x - target.x) < 80;
    const sourceSide = verticallyAligned || source.x < target.x ? "right" : "left";
    const targetSide = verticallyAligned ? "right" : sourceSide === "right" ? "left" : "right";
    if (!edge.data.fieldLevel) {
      return {
        ...edge,
        sourceHandle: `table-source-${sourceSide}`,
        targetHandle: `table-target-${targetSide}`,
      };
    }
    return {
      ...edge,
      sourceHandle: fieldHandleId("source", edge.data.sourceColumn, sourceSide),
      targetHandle: fieldHandleId("target", edge.data.targetColumn, targetSide),
    };
  });
}

function relationshipLabel(
  options: SchemaGraphOptions,
  constraint: string,
  sourceColumn: string,
  targetTable: string,
  targetColumn: string,
  onDelete: string,
  onUpdate: string,
) {
  const parts = [];
  if (options.showRelationshipLabels) {
    parts.push(`${constraint}: ${sourceColumn} → ${targetTable}.${targetColumn}`);
  }
  if (options.showCardinality) parts.push("N → 1");
  if (options.showReferentialActions) parts.push(`DELETE ${onDelete} · UPDATE ${onUpdate}`);
  return parts.length ? parts.join(" · ") : undefined;
}

function logicalRelationshipLabel(
  options: SchemaGraphOptions,
  name: string,
  cardinality: LogicalRelationship["cardinality"],
) {
  const cardinalityLabel: Record<LogicalRelationship["cardinality"], string> = {
    oneToOne: "1 → 1",
    oneToMany: "1 → N",
    manyToOne: "N → 1",
    manyToMany: "N ↔ N",
    unspecified: "? → ?",
  };
  const parts = [];
  if (options.showRelationshipLabels) parts.push(name);
  if (options.showCardinality) parts.push(cardinalityLabel[cardinality]);
  return parts.length ? parts.join(" · ") : undefined;
}

export function inferRelationships(
  tables: Array<{ schema: string; table: TableDefinition }>,
): InferredRelationship[] {
  const candidates = tables.filter(({ table }) =>
    table.primaryKey?.columns.includes("id"),
  );
  const relationships: InferredRelationship[] = [];
  for (const { schema, table } of tables) {
    const declaredColumns = new Set(table.foreignKeys.flatMap((key) => key.columns));
    for (const column of table.columns) {
      if (!column.name.endsWith("_id") || declaredColumns.has(column.name)) continue;
      const stem = column.name.slice(0, -3);
      const resolved = resolveInferredTarget(candidates, schema, table.key.name, stem);
      if (!resolved) continue;
      const targetColumn = resolved.table.columns.find((candidate) => candidate.name === "id");
      const typeMatches = targetColumn?.typeName === column.typeName
        && targetColumn.typeSchema === column.typeSchema;
      const sourceId = tableNodeId(schema, table.key.name);
      const targetId = tableNodeId(resolved.schema, resolved.table.key.name);
      relationships.push({
        sourceId,
        targetId,
        column: column.name,
        referencedColumn: "id",
        relationshipKey: logicalRelationshipKey(sourceId, column.name, targetId, "id"),
        confidence: typeMatches ? 0.92 : 0.68,
        evidence: [
          `Column name ${column.name} matches ${resolved.table.key.name}.id`,
          typeMatches ? "Source and target column types match" : "Source and target column types differ",
          "Target column is a primary key",
        ],
      });
    }
  }
  return relationships;
}

function tableNameMatchesStem(tableName: string, stem: string): boolean {
  const plural = stem.endsWith("y") ? `${stem.slice(0, -1)}ies` : `${stem}s`;
  return tableName === stem || tableName === plural || tableName.endsWith(`_${plural}`);
}

function resolveInferredTarget(
  candidates: Array<{ schema: string; table: TableDefinition }>,
  sourceSchema: string,
  sourceTable: string,
  stem: string,
): { schema: string; table: TableDefinition } | undefined {
  const scored = candidates
    .filter(({ table }) => tableNameMatchesStem(table.key.name, stem))
    .map((candidate) => ({
      candidate,
      score:
        commonPrefixSegments(sourceTable, candidate.table.key.name) * 10 +
        (candidate.schema === sourceSchema ? 2 : 0) +
        (candidate.table.key.name === stem || candidate.table.key.name === `${stem}s` ? 1 : 0),
    }))
    .sort((left, right) => right.score - left.score);
  if (!scored[0] || scored[0].score === scored[1]?.score) return undefined;
  return scored[0].candidate;
}

function commonPrefixSegments(left: string, right: string): number {
  const leftParts = left.split("_");
  const rightParts = right.split("_");
  let count = 0;
  while (leftParts[count] && leftParts[count] === rightParts[count]) count += 1;
  return count;
}

function relatedTableIds(
  tables: Array<{ schema: string; table: TableDefinition }>,
  roots: string[],
  depth: number,
  logicalRelationships: LogicalRelationship[] = [],
): Set<string> {
  const adjacency = new Map<string, Set<string>>();
  for (const { schema, table } of tables) {
    const sourceId = tableNodeId(schema, table.key.name);
    adjacency.set(sourceId, adjacency.get(sourceId) ?? new Set());
    for (const foreignKey of table.foreignKeys) {
      const targetId = tableNodeId(foreignKey.referencedSchema, foreignKey.referencedTable);
      adjacency.set(targetId, adjacency.get(targetId) ?? new Set());
      adjacency.get(sourceId)?.add(targetId);
      adjacency.get(targetId)?.add(sourceId);
    }
  }
  for (const relationship of logicalRelationships) {
    if (relationship.status === "disabled" || relationship.status === "orphaned") continue;
    const sourceId = tableNodeId(relationship.source.schema, relationship.source.table);
    const targetId = tableNodeId(relationship.target.schema, relationship.target.table);
    if (!adjacency.has(sourceId) || !adjacency.has(targetId)) continue;
    adjacency.get(sourceId)?.add(targetId);
    adjacency.get(targetId)?.add(sourceId);
  }
  const included = new Set(roots);
  let frontier = new Set(roots);
  for (let level = 0; level < depth; level += 1) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!included.has(neighbor)) next.add(neighbor);
        included.add(neighbor);
      }
    }
    frontier = next;
  }
  return included;
}

function tableSemantics(
  schema: string,
  table: string,
  annotations: ObjectAnnotation[] | undefined,
  groups: DomainGroup[] | undefined,
): Pick<TableNodeData, "annotation" | "domainColor" | "isCore"> {
  const annotation = annotations?.find(
    (item) =>
      item.objectKey.kind === "table" &&
      item.objectKey.schema === schema &&
      item.objectKey.name === table,
  );
  const group = groups?.find((item) =>
    item.tableKeys.some(
      (key) => key.kind === "table" && key.schema === schema && key.name === table,
    ),
  );
  return {
    annotation,
    isCore: annotation?.isCore,
    domainColor: group?.color,
  };
}

function tableMatches(schema: string, table: TableDefinition, query: string): boolean {
  if (!query) return true;
  return (
    schema.toLocaleLowerCase().includes(query) ||
    table.key.name.toLocaleLowerCase().includes(query) ||
    table.comment?.toLocaleLowerCase().includes(query) === true ||
    table.columns.some(
      (column) =>
        column.name.toLocaleLowerCase().includes(query) ||
        column.formattedType.toLocaleLowerCase().includes(query),
    )
  );
}

function tableChangeStatus(
  schema: string,
  table: string,
  changeSet: SchemaChangeSet | undefined,
): ChangeStatus | undefined {
  const tableId = tableNodeId(schema, table);
  const operations = changeSet?.operations.filter((operation) => {
    const operationTableId =
      operation.object.kind === "table"
        ? tableNodeId(operation.object.schema, operation.object.name)
        : operation.object.schema;
    return operationTableId === tableId;
  });
  if (!operations?.length) return undefined;
  return operations.some((operation) => operation.operationType === "addTable")
    ? "added"
    : "modified";
}
