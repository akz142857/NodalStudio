import type { QueryExecutionResult } from "../../platform";
import { profileResult } from "./result-profile";
self.onmessage = (event: MessageEvent<QueryExecutionResult>) => {
  try { self.postMessage({ profiles: profileResult(event.data) }); }
  catch { self.postMessage({ error: "Unable to profile this result. Reduce the row limit and retry." }); }
};
