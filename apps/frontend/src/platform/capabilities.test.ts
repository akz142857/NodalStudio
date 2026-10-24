import { describe, expect, it } from "vitest";
import { capabilityDefinitions, capabilityTargets, currentCapabilityTarget, resolveCapability } from "./capabilities";
import type { DatabaseInfo, RuntimeInfo } from "./types";

describe("declared capability matrix", () => {
  it("defines every feature once, with all four combinations and an explicit scope", () => {
    expect(new Set(capabilityDefinitions.map((definition) => definition.id)).size).toBe(capabilityDefinitions.length);
    expect(capabilityDefinitions).toHaveLength(23);
    for (const definition of capabilityDefinitions) {
      expect(Object.keys(definition.targets).sort()).toEqual(capabilityTargets.map((target) => target.id).sort());
      for (const target of capabilityTargets) {
        expect(["supported", "partial", "unavailable"]).toContain(definition.targets[target.id].status);
        expect(definition.targets[target.id].scope.trim()).not.toBe("");
        expect(resolveCapability(definition.id, target.runtime, target.database)).toBe(definition.targets[target.id]);
      }
    }
  });
  it.each(capabilityTargets)("supports database capture separately from query execution for $label", (target) => {
    expect(currentCapabilityTarget(target.runtime, target.database)).toBe(target.id);
    expect(resolveCapability("database-connection", target.runtime, target.database).status).toBe(target.runtime === "desktop" ? "supported" : "unavailable");
    expect(resolveCapability("read-only-query", target.runtime, target.database).status).toBe(target.runtime === "desktop" ? "supported" : "unavailable");
  });
  it.each(capabilityTargets.filter((target) => target.runtime === "web"))("keeps Web writes/history/AI unavailable while allowing temporary layouts and local exports for $label", (target) => {
    for (const id of ["semantic-edit", "logical-relationships", "layout-persistence", "snapshot-history", "cloud-publish", "git-workspace", "portable-backup", "ai-explanation"] as const) expect(resolveCapability(id, target.runtime, target.database).status).toBe("unavailable");
    for (const id of ["layout-tools", "diagram-export", "schema-report", "offline-viewer", "shared-view", "preflight-reviews"] as const) expect(resolveCapability(id, target.runtime, target.database).status).toBe("supported");
    expect(resolveCapability("comparison-details", target.runtime, target.database).status).toBe("partial");
    expect(resolveCapability("comparison-details", target.runtime, target.database).scope).toContain("Before history");
  });
  it("explains adapter and preflight omissions without upgrading captured metadata to full compatibility", () => {
    expect(resolveCapability("schema-capture", "desktop", "mySql").status).toBe("partial");
    expect(resolveCapability("schema-capture", "desktop", "mySql").scope).toContain("CHECK constraints and enum objects are not collected");
    expect(resolveCapability("schema-capture", "desktop", "mySql").scope).toContain("current DATABASE()");
    expect(resolveCapability("structure-preflight", "desktop", "mySql").scope).toContain("character set/collation");
    expect(resolveCapability("structure-preflight", "desktop", "postgreSql").scope).toContain("Cross-type operators");
    expect(resolveCapability("event-trigger", "desktop", "postgreSql").status).toBe("partial");
    expect(resolveCapability("event-trigger", "desktop", "mySql").status).toBe("unavailable");
  });
  it.each([[undefined, undefined], ["desktop", undefined], [undefined, "postgreSql"], ["unknown", "postgreSql"], ["desktop", "unknown"]])("does not assume support for missing/unknown context %s/%s", (runtime, database) => {
    expect(currentCapabilityTarget(runtime as RuntimeInfo["kind"], database as DatabaseInfo["databaseType"])).toBeUndefined();
    expect(resolveCapability("read-only-query", runtime as RuntimeInfo["kind"], database as DatabaseInfo["databaseType"]).status).toBe("unknown");
  });
  it("bounds DDL import to temporary previews while keeping physical editing and execution unavailable", () => {
    for (const target of capabilityTargets) {
      expect(resolveCapability("ddl-import", target.runtime, target.database).status).toBe("partial");
      expect(resolveCapability("physical-edit", target.runtime, target.database).status).toBe("unavailable");
    }
  });
  it("declares portable read-only Viewer scope for all four targets without implying shared history or revocation", () => {
    for (const target of capabilityTargets) expect(resolveCapability("offline-viewer", target.runtime, target.database).status).toBe("supported");
    expect(resolveCapability("offline-viewer", "desktop", "postgreSql").scope).toContain("500 tables");
    expect(resolveCapability("offline-viewer", "web", "postgreSql").scope).toContain("only the loaded shared snapshot");
    expect(resolveCapability("offline-viewer", "web", "mySql").scope).toContain("no token expiry/revocation");
  });
});
