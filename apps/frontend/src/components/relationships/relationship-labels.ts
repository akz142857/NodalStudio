import type { LogicalRelationshipStatus } from "../../platform";

export const relationshipStatusLabels: Record<LogicalRelationshipStatus, string> = {
  active: "Active", disabled: "Disabled", orphaned: "Missing endpoint", conflicted: "Needs review", supersededByPhysical: "Physical FK exists",
};
export function relationshipCardinalityLabel(value: string) {
  return ({ oneToOne: "One to one", oneToMany: "One to many", manyToOne: "Many to one", manyToMany: "Many to many", unspecified: "Unspecified" } as Record<string, string>)[value] ?? value;
}
