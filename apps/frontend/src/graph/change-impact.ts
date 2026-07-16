import type { CodeUsageResult, DatabaseSnapshot, ObjectKey, ProjectEdge, ProjectNode, NodalStudioPlatform, SchemaChangeSet, SchemaOperation } from "../platform";

export interface ChangeImpact { operation: SchemaOperation; target: ObjectKey; nodes: ProjectNode[]; edges: ProjectEdge[]; potential: boolean; }

function tableCandidates(snapshot: DatabaseSnapshot, operation: SchemaOperation): ObjectKey[] {
  if (operation.object.kind === "table") return [operation.object];
  if (operation.object.kind !== "column") return [];
  return snapshot.schemas.flatMap((schema) => schema.tables
    .filter((table) => `${table.key.schema}.${table.key.name}` === operation.object.schema && table.columns.some((column) => column.name === operation.object.name))
    .map((table) => table.key));
}

function hasCode(usage: CodeUsageResult) {
  return usage.nodes.some((node) => node.kind !== "table" && node.kind !== "column");
}

export async function loadChangeImpacts(platform: NodalStudioPlatform, snapshot: DatabaseSnapshot, changeSet: SchemaChangeSet): Promise<ChangeImpact[]> {
  const before = await platform.getSnapshot(changeSet.beforeSnapshotId).catch(() => null);
  const impacts = await Promise.all(changeSet.operations.map(async (operation) => {
    const exact = await platform.getDatabaseCodeUsage(snapshot.sourceId, operation.object);
    if (hasCode(exact)) {
      const paths = await platform.getChangeImpact(snapshot.sourceId, [operation.object]);
      return [{ operation, target: operation.object, ...exact, potential: paths.length > 0 && paths.every((path) => path.potential) }];
    }
    const targets = [...tableCandidates(snapshot, operation), ...(before ? tableCandidates(before, operation) : [])]
      .filter((target, index, all) => all.findIndex((candidate) => candidate.schema === target.schema && candidate.name === target.name) === index);
    return Promise.all(targets.map(async (target) => {
      const [usage, paths] = await Promise.all([platform.getDatabaseCodeUsage(snapshot.sourceId, target), platform.getChangeImpact(snapshot.sourceId, [target])]);
      return { operation, target, ...usage, potential: operation.object.kind === "column" || paths.length > 0 && paths.every((path) => path.potential) };
    }));
  }));
  return impacts.flat().filter(hasCode);
}
