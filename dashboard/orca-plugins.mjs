#!/usr/bin/env node
// The loader's path before the dashboard moved to orca-bloom-dashboard-plugin/. A teammate whose
// auto-update.mjs or update-team-skills text predates the move pulls the move and then loads this
// path, so it hands over to the loader in its new place: that sets up the dashboard service,
// unloads the two plugins that this folder used to hold, and loads the Bloom plugin.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export { loadOrcaPlugins, describe } from "../orca-bloom-dashboard-plugin/orca-plugins.mjs";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const loader = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "orca-bloom-dashboard-plugin", "orca-plugins.mjs");
    const r = spawnSync(process.execPath, [loader, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
    process.exitCode = r.status ?? 1;
}
