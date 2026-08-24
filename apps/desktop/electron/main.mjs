import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { runtimeFailureDataUrl } from "./runtime-failure-page.mjs";
import {
  createDesktopRuntime,
  resolveProjectRoot,
  restartDesktopRuntime,
} from "./runtime-service.mjs";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
// BrowserWindow's icon option is used on Windows/Linux. macOS takes the app
// icon from the packaged bundle; passing an .icns here produces a nativeImage
// warning during source-checkout development.
const appIconPath =
  process.platform === "darwin"
    ? undefined
    : path.join(electronDir, "..", "..", "..", "build", "icon.ico");
let runtime;
let runtimeOptions;
let mainWindow;

async function createWindow() {
  const projectRoot = resolveProjectRoot(import.meta.url);
  runtimeOptions = {
    projectRoot,
    userDataPath: app.getPath("userData"),
    onExit: ({ code, signal, stderr }) => {
      const reason = code === null ? `signal ${signal}` : `code ${code}`;
      console.error(`Anna runtime exited with ${reason}: ${stderr}`);
      showRuntimeFailure({
        message: `Anna runtime exited with ${reason}`,
        details: stderr,
      });
    },
  };
  runtime = await createDesktopRuntime(runtimeOptions);

  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 700,
    title: "Anna",
    ...(appIconPath && existsSync(appIconPath) ? { icon: appIconPath } : {}),
    backgroundColor: "#f7f8fa",
    webPreferences: {
      preload: path.join(electronDir, "preload.mjs"),
      additionalArguments: [
        `--anna-api-base=${runtime.apiBase}`,
        `--anna-harness-v2-api-base=${runtime.harnessV2ApiBase ?? ""}`,
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow = window;

  if (process.env.VITE_DEV_SERVER_URL) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }

  await window.loadURL(runtime.apiBase);
}

app.whenReady().then(createWindow).catch((error) => {
  createRuntimeFailureWindow(error);
});

app.on("window-all-closed", () => {
  runtime?.stop();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  runtime?.stop();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.handle("anna:restart-runtime", async () => {
  if (!runtimeOptions) {
    throw new Error("Anna runtime options are not initialized");
  }
  runtime = await restartDesktopRuntime(runtime, runtimeOptions);
  return {
    apiBase: runtime.apiBase,
    appUrl: process.env.VITE_DEV_SERVER_URL ?? runtime.apiBase,
  };
});

// Home 合并轮 M2 — 工作空间选文件夹(V2 H-07:Electron 原生对话框)。
ipcMain.handle("anna:pick-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择工作空间文件夹",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

function createRuntimeFailureWindow(error) {
  const window = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 760,
    minHeight: 520,
    title: "Anna runtime 启动失败",
    ...(appIconPath && existsSync(appIconPath) ? { icon: appIconPath } : {}),
    backgroundColor: "#f7f8fa",
  });
  mainWindow = window;
  const details = error instanceof Error ? error.stack : String(error);
  showRuntimeFailure({
    message: error instanceof Error ? error.message : String(error),
    details,
  });
}

function showRuntimeFailure(error) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.loadURL(runtimeFailureDataUrl(error));
}
