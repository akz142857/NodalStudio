import type { CapabilityId, CapabilityTarget, CapabilityStatus } from "../platform/capabilities";
import type { MessageKey } from "./messages";

export const capabilityMessages = {
  "database-connection": {
    "name": "capabilities.databaseConnection.name",
    "category": "capabilities.databaseConnection.category",
    "targets": {
      "desktop-postgres": "capabilities.databaseConnection.desktopPostgres.scope",
      "desktop-mysql": "capabilities.databaseConnection.desktopMysql.scope",
      "web-postgres": "capabilities.databaseConnection.webPostgres.scope",
      "web-mysql": "capabilities.databaseConnection.webPostgres.scope"
    }
  },
  "schema-capture": {
    "name": "capabilities.schemaCapture.name",
    "category": "capabilities.databaseConnection.category",
    "targets": {
      "desktop-postgres": "capabilities.schemaCapture.desktopPostgres.scope",
      "desktop-mysql": "capabilities.schemaCapture.desktopMysql.scope",
      "web-postgres": "capabilities.schemaCapture.webPostgres.scope",
      "web-mysql": "capabilities.schemaCapture.webMysql.scope"
    }
  },
  "diagram": {
    "name": "capabilities.diagram.name",
    "category": "capabilities.diagram.category",
    "targets": {
      "desktop-postgres": "capabilities.diagram.desktopPostgres.scope",
      "desktop-mysql": "capabilities.diagram.desktopPostgres.scope",
      "web-postgres": "capabilities.diagram.desktopPostgres.scope",
      "web-mysql": "capabilities.diagram.desktopPostgres.scope"
    }
  },
  "snapshot-history": {
    "name": "capabilities.snapshotHistory.name",
    "category": "capabilities.snapshotHistory.category",
    "targets": {
      "desktop-postgres": "capabilities.snapshotHistory.desktopPostgres.scope",
      "desktop-mysql": "capabilities.snapshotHistory.desktopMysql.scope",
      "web-postgres": "capabilities.snapshotHistory.webPostgres.scope",
      "web-mysql": "capabilities.snapshotHistory.webPostgres.scope"
    }
  },
  "comparison-details": {
    "name": "capabilities.comparisonDetails.name",
    "category": "capabilities.snapshotHistory.category",
    "targets": {
      "desktop-postgres": "capabilities.comparisonDetails.desktopPostgres.scope",
      "desktop-mysql": "capabilities.comparisonDetails.desktopPostgres.scope",
      "web-postgres": "capabilities.comparisonDetails.webPostgres.scope",
      "web-mysql": "capabilities.comparisonDetails.webPostgres.scope"
    }
  },
  "diagram-export": {
    "name": "capabilities.diagramExport.name",
    "category": "capabilities.diagramExport.category",
    "targets": {
      "desktop-postgres": "capabilities.diagramExport.desktopPostgres.scope",
      "desktop-mysql": "capabilities.diagramExport.desktopPostgres.scope",
      "web-postgres": "capabilities.diagramExport.webPostgres.scope",
      "web-mysql": "capabilities.diagramExport.webPostgres.scope"
    }
  },
  "schema-report": {
    "name": "capabilities.schemaReport.name",
    "category": "capabilities.diagramExport.category",
    "targets": {
      "desktop-postgres": "capabilities.schemaReport.desktopPostgres.scope",
      "desktop-mysql": "capabilities.schemaReport.desktopPostgres.scope",
      "web-postgres": "capabilities.schemaReport.webPostgres.scope",
      "web-mysql": "capabilities.schemaReport.webPostgres.scope"
    }
  },
  "offline-viewer": {
    "name": "capabilities.offlineViewer.name",
    "category": "capabilities.diagramExport.category",
    "targets": {
      "desktop-postgres": "capabilities.offlineViewer.desktopPostgres.scope",
      "desktop-mysql": "capabilities.offlineViewer.desktopMysql.scope",
      "web-postgres": "capabilities.offlineViewer.webPostgres.scope",
      "web-mysql": "capabilities.offlineViewer.webPostgres.scope"
    }
  },
  "semantic-edit": {
    "name": "capabilities.semanticEdit.name",
    "category": "capabilities.semanticEdit.category",
    "targets": {
      "desktop-postgres": "capabilities.semanticEdit.desktopPostgres.scope",
      "desktop-mysql": "capabilities.semanticEdit.desktopMysql.scope",
      "web-postgres": "capabilities.semanticEdit.webPostgres.scope",
      "web-mysql": "capabilities.semanticEdit.webPostgres.scope"
    }
  },
  "logical-relationships": {
    "name": "capabilities.logicalRelationships.name",
    "category": "capabilities.semanticEdit.category",
    "targets": {
      "desktop-postgres": "capabilities.logicalRelationships.desktopPostgres.scope",
      "desktop-mysql": "capabilities.logicalRelationships.desktopMysql.scope",
      "web-postgres": "capabilities.logicalRelationships.webPostgres.scope",
      "web-mysql": "capabilities.logicalRelationships.webPostgres.scope"
    }
  },
  "layout-tools": {
    "name": "capabilities.layoutTools.name",
    "category": "capabilities.diagram.category",
    "targets": {
      "desktop-postgres": "capabilities.layoutTools.desktopPostgres.scope",
      "desktop-mysql": "capabilities.layoutTools.desktopPostgres.scope",
      "web-postgres": "capabilities.layoutTools.webPostgres.scope",
      "web-mysql": "capabilities.layoutTools.webPostgres.scope"
    }
  },
  "layout-persistence": {
    "name": "capabilities.layoutPersistence.name",
    "category": "capabilities.diagram.category",
    "targets": {
      "desktop-postgres": "capabilities.layoutPersistence.desktopPostgres.scope",
      "desktop-mysql": "capabilities.layoutPersistence.desktopPostgres.scope",
      "web-postgres": "capabilities.layoutPersistence.webPostgres.scope",
      "web-mysql": "capabilities.layoutPersistence.webPostgres.scope"
    }
  },
  "structure-preflight": {
    "name": "capabilities.structurePreflight.name",
    "category": "capabilities.structurePreflight.category",
    "targets": {
      "desktop-postgres": "capabilities.structurePreflight.desktopPostgres.scope",
      "desktop-mysql": "capabilities.structurePreflight.desktopMysql.scope",
      "web-postgres": "capabilities.structurePreflight.desktopPostgres.scope",
      "web-mysql": "capabilities.structurePreflight.desktopMysql.scope"
    }
  },
  "preflight-reviews": {
    "name": "capabilities.preflightReviews.name",
    "category": "capabilities.structurePreflight.category",
    "targets": {
      "desktop-postgres": "capabilities.preflightReviews.desktopPostgres.scope",
      "desktop-mysql": "capabilities.preflightReviews.desktopMysql.scope",
      "web-postgres": "capabilities.preflightReviews.webPostgres.scope",
      "web-mysql": "capabilities.preflightReviews.webPostgres.scope"
    }
  },
  "read-only-query": {
    "name": "capabilities.readOnlyQuery.name",
    "category": "capabilities.databaseConnection.category",
    "targets": {
      "desktop-postgres": "capabilities.readOnlyQuery.desktopPostgres.scope",
      "desktop-mysql": "capabilities.readOnlyQuery.desktopMysql.scope",
      "web-postgres": "capabilities.readOnlyQuery.webPostgres.scope",
      "web-mysql": "capabilities.readOnlyQuery.webPostgres.scope"
    }
  },
  "event-trigger": {
    "name": "capabilities.eventTrigger.name",
    "category": "capabilities.databaseConnection.category",
    "targets": {
      "desktop-postgres": "capabilities.eventTrigger.desktopPostgres.scope",
      "desktop-mysql": "capabilities.eventTrigger.desktopMysql.scope",
      "web-postgres": "capabilities.databaseConnection.webPostgres.scope",
      "web-mysql": "capabilities.databaseConnection.webPostgres.scope"
    }
  },
  "ai-explanation": {
    "name": "capabilities.aiExplanation.name",
    "category": "capabilities.aiExplanation.category",
    "targets": {
      "desktop-postgres": "capabilities.aiExplanation.desktopPostgres.scope",
      "desktop-mysql": "capabilities.aiExplanation.desktopMysql.scope",
      "web-postgres": "capabilities.aiExplanation.webPostgres.scope",
      "web-mysql": "capabilities.aiExplanation.webPostgres.scope"
    }
  },
  "git-workspace": {
    "name": "capabilities.gitWorkspace.name",
    "category": "capabilities.aiExplanation.category",
    "targets": {
      "desktop-postgres": "capabilities.gitWorkspace.desktopPostgres.scope",
      "desktop-mysql": "capabilities.gitWorkspace.desktopMysql.scope",
      "web-postgres": "capabilities.databaseConnection.webPostgres.scope",
      "web-mysql": "capabilities.databaseConnection.webPostgres.scope"
    }
  },
  "cloud-publish": {
    "name": "capabilities.cloudPublish.name",
    "category": "capabilities.aiExplanation.category",
    "targets": {
      "desktop-postgres": "capabilities.cloudPublish.desktopPostgres.scope",
      "desktop-mysql": "capabilities.cloudPublish.desktopMysql.scope",
      "web-postgres": "capabilities.cloudPublish.webPostgres.scope",
      "web-mysql": "capabilities.cloudPublish.webPostgres.scope"
    }
  },
  "shared-view": {
    "name": "capabilities.sharedView.name",
    "category": "capabilities.diagramExport.category",
    "targets": {
      "desktop-postgres": "capabilities.sharedView.desktopPostgres.scope",
      "desktop-mysql": "capabilities.sharedView.desktopPostgres.scope",
      "web-postgres": "capabilities.sharedView.webPostgres.scope",
      "web-mysql": "capabilities.sharedView.webPostgres.scope"
    }
  },
  "portable-backup": {
    "name": "capabilities.portableBackup.name",
    "category": "capabilities.diagramExport.category",
    "targets": {
      "desktop-postgres": "capabilities.portableBackup.desktopPostgres.scope",
      "desktop-mysql": "capabilities.portableBackup.desktopMysql.scope",
      "web-postgres": "capabilities.databaseConnection.webPostgres.scope",
      "web-mysql": "capabilities.databaseConnection.webPostgres.scope"
    }
  },
  "ddl-import": {
    "name": "capabilities.ddlImport.name",
    "category": "capabilities.databaseConnection.category",
    "targets": {
      "desktop-postgres": "capabilities.ddlImport.desktopPostgres.scope",
      "desktop-mysql": "capabilities.ddlImport.desktopMysql.scope",
      "web-postgres": "capabilities.ddlImport.webPostgres.scope",
      "web-mysql": "capabilities.ddlImport.webMysql.scope"
    }
  },
  "physical-edit": {
    "name": "capabilities.physicalEdit.name",
    "category": "capabilities.databaseConnection.category",
    "targets": {
      "desktop-postgres": "capabilities.physicalEdit.desktopPostgres.scope",
      "desktop-mysql": "capabilities.physicalEdit.desktopMysql.scope",
      "web-postgres": "capabilities.physicalEdit.webPostgres.scope",
      "web-mysql": "capabilities.physicalEdit.webPostgres.scope"
    }
  }
} as const satisfies Record<CapabilityId, { name: MessageKey; category: MessageKey; targets: Record<CapabilityTarget, MessageKey> }>;

export const capabilityTargetMessages = {
  "desktop-postgres": "capabilities.target.desktopPostgres",
  "desktop-mysql": "capabilities.target.desktopMysql",
  "web-postgres": "capabilities.target.webPostgres",
  "web-mysql": "capabilities.target.webMysql"
} as const;
export const capabilityStatusMessages = {
  "supported": "capabilities.status.supported",
  "partial": "capabilities.status.partial",
  "unavailable": "capabilities.status.unavailable"
} as const satisfies Record<CapabilityStatus, MessageKey>;
