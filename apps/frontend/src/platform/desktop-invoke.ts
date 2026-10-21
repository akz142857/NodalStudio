import { invoke as nativeInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { assertUpdateCanRestart } from "./update-guard";

let active = 0;
let installing = false;
/** One bridge for all application IPC, including long-running imports and exports. */
export async function invoke<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  const call = () => options !== undefined ? nativeInvoke<T>(command, args, options) : args !== undefined ? nativeInvoke<T>(command, args) : nativeInvoke<T>(command);
  if (command === "get_update_status") return call();
  if (installing) throw new Error("An update is being installed. Please wait for the app to restart.");
  const install = command === "install_update";
  if (install) {
    assertUpdateCanRestart();
    if (active) throw new Error("Wait for running operations to finish, then retry installing.");
    installing = true;
  }
  active += 1;
  try { return await call(); }
  finally { active -= 1; if (install) installing = false; }
}
