import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Locate the desktop Runtime written by Electron.
 *
 * Development runs keep state inside the repository so that a checkout is
 * self-contained. Installed builds continue to use the platform user-data
 * directory. Explicit ANNA_RUNTIME_INFO_PATH / ANNA_API_BASE overrides are
 * resolved by each caller before this fallback is used.
 */
export function defaultRuntimeInfoPath(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const fileExists = options.existsSync ?? existsSync;
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? homedir();
  const env = options.env ?? process.env;

  const projectLocalPath = join(cwd, ".anna", "runtime-info-electron.json");
  if (fileExists(projectLocalPath)) {
    return projectLocalPath;
  }

  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Anna", "runtime-info.json");
  }
  if (platform === "win32") {
    return join(
      env.APPDATA ?? join(home, "AppData", "Roaming"),
      "Anna",
      "runtime-info.json",
    );
  }
  return join(
    env.XDG_CONFIG_HOME ?? join(home, ".config"),
    "Anna",
    "runtime-info.json",
  );
}
