import { createDdlPreview } from "./ddl-preview";
import type { DdlRequest } from "./ddl-types";
self.onmessage = (event: MessageEvent<DdlRequest>) => {
  void createDdlPreview(event.data).then((preview) => self.postMessage({ preview }), (reason: unknown) => self.postMessage({ error: reason instanceof Error ? reason.message : "Unable to parse DDL." }));
};
