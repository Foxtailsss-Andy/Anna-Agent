import { contextBridge, ipcRenderer } from "electron";

import { parseApiBaseFromArgv } from "./runtime-service.mjs";

contextBridge.exposeInMainWorld("__ANNA_RUNTIME__", {
  apiBase: parseApiBaseFromArgv(process.argv),
  mode: "product",
  restartRuntime: () => ipcRenderer.invoke("anna:restart-runtime"),
  pickFolder: () => ipcRenderer.invoke("anna:pick-folder"),
});
