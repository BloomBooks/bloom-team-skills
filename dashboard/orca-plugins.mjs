#!/usr/bin/env node
// Loads the dashboard's two Orca plugins from this clone: the Bloom Dashboard button in Orca's
// status bar (orca-plugin/) and the Worktree panel in its right sidebar (this folder).
//
//   node orca-plugins.mjs            Load both. Prints each plugin's state and, for one that Orca
//                                    has not approved, the access it asks for. Exit code 3 when
//                                    one waits for approval.
//   node orca-plugins.mjs --approve  Load both and approve the access that Orca lists for each.
//   node orca-plugins.mjs --json     The same, as JSON.
//
// Orca runs a plugin's code only after an approval tied to its files and its access, so a load
// without --approve leaves the folder listed in Settings > Plugins with nothing running. A plugin
// loaded this way runs from the clone, so a pull updates it; Orca asks again only when a pull
// changes the access a plugin asks for, or its button or panel.
//
// update-team-skills/auto-update.mjs imports loadOrcaPlugins for its daily load.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const PLUGINS = [
    { key: "local.bloom-dashboard", name: "Bloom Dashboard button", dir: path.join(here, "orca-plugin") },
    { key: "local.bloom-worktree", name: "Worktree panel", dir: here },
];

function orcaJson(args) {
    const env = { ...process.env };
    // Claude Code sets this in its child processes; with it Windows stops finding orca.cmd's target.
    delete env.NoDefaultCurrentDirectoryInExePath;
    const r = spawnSync(process.env.ORCA_CLI_COMMAND || "orca", [...args, "--json"], {
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true,
        env,
    });
    if (r.error) return { missing: r.error.code === "ENOENT", error: { code: "spawn", message: r.error.message } };
    try {
        return JSON.parse(r.stdout);
    } catch {
        return { error: { code: "unreadable", message: `${r.stdout}${r.stderr}`.trim().split("\n")[0] || `orca exited ${r.status}` } };
    }
}

/**
 * What one `orca plugin dev load <dir> --json` reply says about a plugin:
 * { state: "running" | "needs-approval" | "error", fingerprint?, access?, message? }.
 * `access` is the lines to show a developer before they approve.
 */
export function readLoadReply(reply) {
    if (reply?.ok) {
        const plugin = reply.result?.plugin ?? {};
        if (plugin.error) return { state: "error", message: plugin.error };
        return { state: "running" };
    }
    const { code, message, data } = reply?.error ?? {};
    if ((code === "approval_required" || code === "approval_stale") && data?.approvalFingerprint) {
        const grants = data.grants ?? {};
        return {
            state: "needs-approval",
            fingerprint: data.approvalFingerprint,
            access: [
                grants.executionDescription,
                ...(grants.capabilities ?? []).map((c) => c.description || c.kind),
                ...(grants.contributions ?? []).map((c) => `Adds to Orca: ${c.kind} "${c.name}"`),
            ].filter(Boolean),
        };
    }
    return { state: "error", message: `${code || "failed"}: ${message || "orca gave no reason"}` };
}

/**
 * Loads both plugins. Returns { orca: false } when the orca CLI is not installed, otherwise
 * { orca: true, plugins: [{ key, name, dir, state, access?, message? }] }. With `approve`, a
 * plugin that waits for approval is loaded again with the fingerprint that Orca gave for it.
 */
export function loadOrcaPlugins({ approve = false } = {}) {
    const plugins = [];
    for (const plugin of PLUGINS) {
        let reply = orcaJson(["plugin", "dev", "load", plugin.dir]);
        if (reply.missing) return { orca: false, plugins: [] };
        let result = readLoadReply(reply);
        if (approve && result.state === "needs-approval") {
            const access = result.access;
            reply = orcaJson(["plugin", "dev", "load", plugin.dir, "--approve", result.fingerprint]);
            result = { ...readLoadReply(reply), access, approved: true };
        }
        delete result.fingerprint;
        plugins.push({ ...plugin, ...result });
    }
    return { orca: true, plugins };
}

/** One line per plugin, for a log or a report. */
export function describe(result) {
    if (!result.orca) return ["orca is not installed, so its plugins were not loaded"];
    return result.plugins.map((p) => {
        if (p.state === "running") return `${p.name}: ${p.approved ? "approved and running" : "running"}`;
        if (p.state === "needs-approval") return `${p.name}: waiting for approval`;
        return `${p.name}: ${p.message}`;
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const result = loadOrcaPlugins({ approve: args.includes("--approve") });
    if (args.includes("--json")) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        const lines = describe(result);
        result.plugins.forEach((p, i) => {
            console.log(lines[i]);
            if (p.access && (p.state === "needs-approval" || p.approved)) {
                for (const line of p.access) console.log(`    ${line}`);
            }
        });
        if (!result.orca) console.log(lines[0]);
        if (result.plugins.some((p) => p.state === "needs-approval")) {
            console.log(`\nTo approve that access: node "${fileURLToPath(import.meta.url)}" --approve`);
        }
    }
    process.exitCode = result.plugins.some((p) => p.state === "error")
        ? 1
        : result.plugins.some((p) => p.state === "needs-approval")
          ? 3
          : 0;
}
