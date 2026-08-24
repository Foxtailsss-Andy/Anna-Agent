import { contextBridge, ipcRenderer } from "electron";

import {
  parseApiBaseFromArgv,
  parseRuntimeBaseFromArgv,
} from "./runtime-service.mjs";

contextBridge.exposeInMainWorld("__ANNA_RUNTIME__", {
  apiBase: parseApiBaseFromArgv(process.argv),
  v2ApiBase: parseRuntimeBaseFromArgv(process.argv, "--anna-harness-v2-api-base="),
  restartRuntime: () => ipcRenderer.invoke("anna:restart-runtime"),
  pickFolder: () => ipcRenderer.invoke("anna:pick-folder"),
});
