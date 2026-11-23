// Gathers what an agent needs to say whether Bloom's next beta and release can be published, and
// prints it as JSON:
//
//   node readiness.mjs              Bloom Desktop
//   node readiness.mjs blorg        Bloom Library (bloomlibrary.org)
//   node readiness.mjs b-p          bloom-player
//
// For Bloom Desktop: for every Beta Publish and Release Publish build configuration that is not
// paused in TeamCity's Bloom / Publish project, it reads the changes waiting for the next publish,
// looks up every YouTrack card those changes name, and lists the unresolved cards whose summary
// starts with that version's prefix ("[6.5]", "[6.5 Regression]") but whose code is not among the
// waiting changes.
//
// For Bloom Library and bloom-player, a release is a merge of one branch into another (REPOS), so
// the waiting changes are the commits on the first that the second lacks, from GitHub. Their cards
// carry no version prefix, so there is no list of cards not in yet.
//
// SKILL.md beside this file says how to turn the JSON into a report.
//
// TeamCity is read as a guest, GitHub through `gh`. YouTrack is read through the team's tool
// server (bloom-services), so no token is needed.
import { execFileSync } from "node:child_process";
import { callService, configure } from "../bloom-services/sources.mjs";

// The repos released by merging a branch: `from` is the one that deploys continuously (alpha),
// `to` the one whose push publishes the release.
const REPOS = {
    blorg: { name: "Bloom Library release", repo: "BloomBooks/BloomLibrary2", from: "master", to: "release" },
    "b-p": { name: "bloom-player release", repo: "BloomBooks/bloom-player", from: "master", to: "release" },
};
// What uses bloom-player, and where each records the version it ships: a lockfile on the branch
// or tag it publishes from. `ref` "latest release" is the repo's latest GitHub release; "beta" is
// the BloomDesktop branch of the live Beta Publish config in TeamCity.
const PLAYER_CONSUMERS = [
    { name: "Bloom Library", repo: "BloomBooks/BloomLibrary2", ref: "release", lock: "pnpm-lock.yaml" },
    { name: "Bloom Desktop beta", repo: "BloomBooks/BloomDesktop", ref: "beta", lock: "src/BloomBrowserUI/pnpm-lock.yaml" },
    { name: "Bloom Reader", repo: "BloomBooks/BloomReader", ref: "release", lock: "app/yarn.lock" },
    { name: "BloomPUB Viewer", repo: "BloomBooks/bloompub-viewer", ref: "latest release", lock: "pnpm-lock.yaml" },
];
const ALIASES ={ bloomlibrary: "blorg", "bloomlibrary.org": "blorg", bloomlibrary2: "blorg", bp: "b-p", "bloom-player": "b-p", bloomplayer: "b-p" };

const TEAMCITY = "https://build.palaso.org/guestAuth/app/rest";
const PUBLISH_PROJECT = "Bloom_Publish";
const CARD_ID = /\bBL-\d+\b/g;
// How many of a card's latest comments to include for a card whose code is not waiting, so the
// agent can say what holds it up.
const COMMENTS_PER_CARD = 4;
const PARKED_BOARD = "Issues We'll Live With for now";

/** GETs a TeamCity REST path as a guest and returns its JSON, throwing on any failure. */
async function teamcity(p) {
    const response = await fetch(`${TEAMCITY}${p}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`TeamCity answered HTTP ${response.status} to ${p}: ${(await response.text()).slice(0, 300)}`);
    return response.json();
}

/** GETs a YouTrack REST path through the tool server and returns its JSON. */
async function youtrack(p) {
    return (await callService("youtrack", p)).json();
}

/** The Beta Publish and Release Publish configs that are live, each with its version and channel,
 * release first and then by version. */
async function publishConfigs() {
    const { buildType } = await teamcity(`/buildTypes?locator=affectedProject:(id:${PUBLISH_PROJECT}),paused:false&fields=buildType(id,name,projectId)`);
    return buildType
        .filter((b) => b.projectId === PUBLISH_PROJECT)
        .map((b) => {
            const m = /^Bloom (\d+\.\d+) (Beta|Release) Publish$/.exec(b.name);
            return m && { id: b.id, name: b.name, version: m[1], channel: m[2].toLowerCase() };
        })
        .filter(Boolean)
        .sort((a, b) => (a.channel === b.channel ? a.version.localeCompare(b.version, undefined, { numeric: true }) : a.channel === "release" ? -1 : 1));
}

/** The config's changes: those waiting for its next build, and every one it has ever built. */
async function changes(configId) {
    const fields = "fields=change(version,username,date,comment)";
    const pending = (await teamcity(`/changes?locator=buildType:(id:${configId}),pending:true,count:2000&${fields}`)).change ?? [];
    const all = (await teamcity(`/changes?locator=buildType:(id:${configId}),count:5000&${fields}`)).change ?? [];
    const pendingVersions = new Set(pending.map((c) => c.version));
    return { pending, published: all.filter((c) => !pendingVersions.has(c.version)) };
}

/** The config's last finished build: its number and when it finished. */
async function lastBuild(configId) {
    const { build } = await teamcity(`/builds?locator=buildType:(id:${configId}),state:finished,count:1&fields=build(number,status,finishDate)`);
    return build?.[0] ?? null;
}

const cardFields = "idReadable,summary,resolved,customFields(name,value(name,fullName))";

/** Flattens a YouTrack card into the fields the report uses. */
function card(issue) {
    const field = (name) => {
        const value = issue.customFields.find((f) => f.name === name)?.value;
        return value?.fullName ?? value?.name ?? null;
    };
    return {
        id: issue.idReadable,
        summary: issue.summary,
        state: field("State"),
        resolved: issue.resolved != null,
        assignee: field("Assignee"),
        board: field("Kanban Board"),
    };
}

/** Looks up cards by id, returning a map from id to card. An id YouTrack doesn't know is left out. */
async function cardsById(ids) {
    const result = new Map();
    for (let i = 0; i < ids.length; i += 50) {
        const query = encodeURIComponent(`issue id: ${ids.slice(i, i + 50).join(", ")}`);
        for (const issue of await youtrack(`/issues?fields=${cardFields}&query=${query}&$top=100`)) result.set(issue.idReadable, card(issue));
    }
    return result;
}

/** The unresolved BL cards whose summary starts with this version's prefix, on any board except
 * Issues We'll Live With, whose cards are parked rather than pending. */
async function versionCards(version) {
    const query = encodeURIComponent(`project: BL #Unresolved summary: "${version}" Kanban Board: -{${PARKED_BOARD}}`);
    const prefix = new RegExp(`^\\s*\\[[^\\]]*\\b${version.replace(".", "\\.")}\\b[^\\]]*\\]`);
    return (await youtrack(`/issues?fields=${cardFields}&query=${query}&$top=500`)).filter((i) => prefix.test(i.summary)).map(card);
}

/** A card's latest comments, oldest first, cut short. */
async function latestComments(id) {
    const comments = await youtrack(`/issues/${id}/comments?fields=created,author(login),text&$top=500`);
    return comments.slice(-COMMENTS_PER_CARD).map((c) => ({
        date: new Date(c.created).toISOString().slice(0, 10),
        author: c.author.login,
        text: (c.text ?? "").replace(/\s+/g, " ").slice(0, 600),
    }));
}

/** GETs a GitHub REST path through `gh` and returns its JSON, throwing on any failure. */
function github(p) {
    return JSON.parse(execFileSync("gh", ["api", p], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] }));
}

/** A GitHub commit in the shape TeamCity gives a change. */
const asChange = (c) => ({ version: c.sha, username: c.author?.login ?? c.commit.author.name, date: c.commit.committer.date.replace(/[-:]/g, ""), comment: c.commit.message });

/**
 * A branch-merge release (an entry of REPOS): the commits on `from` that `to` lacks, apart from
 * copies of ones `to` already has (cherry-picked either way: one of `to`'s last 250 commits has
 * the same first line), and the head of `to`, as when it last published.
 */
function branchRelease({ repo, from, to }) {
    const ahead = github(`repos/${repo}/compare/${to}...${from}?per_page=250`);
    if (ahead.total_commits > ahead.commits.length) throw new Error(`${repo}: ${ahead.total_commits} commits wait on ${from}, more than the ${ahead.commits.length} GitHub lists at once`);
    const picked = new Set(github(`repos/${repo}/commits?sha=${to}&per_page=250`).map((c) => firstLine(c.commit.message)));
    const head = github(`repos/${repo}/commits/${to}`);
    return {
        pending: ahead.commits.map(asChange).filter((c) => !picked.has(firstLine(c.comment))),
        lastBuild: { number: head.sha.slice(0, 10), status: `head of ${to}`, finishDate: head.commit.committer.date },
    };
}

/** The bloom-player version a lockfile's text resolves (pnpm's "bloom-player@2.20.2:", or yarn's
 * "bloom-player@^2.20.1:" followed by `version "2.20.2"`), throwing when it has none. */
function lockedPlayerVersion(text) {
    const yarn = /^"?bloom-player@[^\n]*:\s*\n\s+version "([^"]+)"/m.exec(text);
    const pnpm = /^\s*['"]?bloom-player@(\d[\w.+-]*)['"]?:/m.exec(text);
    const version = yarn?.[1] ?? pnpm?.[1];
    if (!version) throw new Error("the lockfile names no bloom-player version");
    return version;
}

/** Each PLAYER_CONSUMERS entry with the bloom-player version it ships and the bloom-player commits on
 * master that version lacks. `betaVersion` is the live Bloom Desktop beta's version ("6.5"). */
function playerConsumers(betaVersion) {
    return PLAYER_CONSUMERS.map((c) => {
        let ref = c.ref;
        if (ref === "beta") ref = `Version${betaVersion}`;
        else if (ref === "latest release") ref = github(`repos/${c.repo}/releases/latest`).tag_name;
        const lock = execFileSync("gh", ["api", `repos/${c.repo}/contents/${c.lock}?ref=${ref}`, "-H", "Accept: application/vnd.github.raw"], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
        const version = lockedPlayerVersion(lock);
        const behind = github(`repos/BloomBooks/bloom-player/compare/v${version}...release?per_page=250`);
        if (behind.total_commits > behind.commits.length) throw new Error(`${c.name}: ${behind.total_commits} bloom-player commits are past v${version}, more than GitHub lists at once`);
        return { name: c.name, repo: c.repo, ref, playerVersion: version, pending: behind.commits.map(asChange) };
    });
}

const ids = (text) => [...new Set(text.match(CARD_ID) ?? [])];
const firstLine = (comment) => comment.split("\n")[0];

configure();
const which = process.argv[2]?.toLowerCase();
const target = which ? REPOS[ALIASES[which] ?? which] : null;
if (which && !target) throw new Error(`unknown target "${process.argv[2]}": give blorg, b-p, or nothing for Bloom Desktop`);
const report = [];
if (target) {
    const { pending, lastBuild } = branchRelease(target);
    report.push({ config: target.name, repo: target.repo, merge: `${target.from} into ${target.to}`, channel: "release", lastBuild, ...(await waiting(pending)), versionCardsNotWaiting: null });
    // bloom-player reaches users only through the products that ship it, each at a version of its own.
    if (target.repo === "BloomBooks/bloom-player") {
        const beta = (await publishConfigs()).find((c) => c.channel === "beta");
        if (!beta) throw new Error("TeamCity has no live Beta Publish config, so the Bloom Desktop beta branch is unknown");
        for (const c of playerConsumers(beta.version)) {
            report.push({ config: `bloom-player release not yet in ${c.name}`, repo: c.repo, shippedFrom: c.ref, playerVersion: c.playerVersion, channel: "consumer", ...(await waiting(c.pending)), versionCardsNotWaiting: null });
        }
    }
}
for (const config of target ? [] : await publishConfigs()) {
    const { pending, published } = await changes(config.id);
    const { holdingUp, resolvedAndWaiting, changesWithoutCard, pendingChangeCount, pendingIds } = await waiting(pending);
    const publishedIds = new Set(ids(published.map((c) => c.comment).join("\n")));
    const notWaiting = (await versionCards(config.version)).filter((c) => !pendingIds.includes(c.id));
    for (const c of notWaiting) {
        c.alreadyPublished = publishedIds.has(c.id);
        c.latestComments = await latestComments(c.id);
    }
    report.push({
        config: config.name,
        configId: config.id,
        channel: config.channel,
        version: config.version,
        lastBuild: await lastBuild(config.id),
        pendingChangeCount,
        holdingUp,
        resolvedAndWaiting,
        changesWithoutCard,
        versionCardsNotWaiting: notWaiting,
    });
}
console.log(JSON.stringify(report, (k, v) => (k === "pendingIds" ? undefined : v), 1));

/** The cards that waiting changes name, split into unresolved and resolved, and the changes that name none. */
async function waiting(pending) {
    const pendingIds = ids(pending.map((c) => c.comment).join("\n"));
    const known = await cardsById(pendingIds);
    const waitingCards = pendingIds.map((id) => ({
        ...(known.get(id) ?? { id, summary: null, state: "not found in YouTrack", resolved: false }),
        commits: pending.filter((c) => c.comment.includes(id)).map((c) => `${c.version.slice(0, 10)} ${firstLine(c.comment)}`),
    }));
    return {
        pendingIds,
        pendingChangeCount: pending.length,
        holdingUp: waitingCards.filter((c) => !c.resolved),
        resolvedAndWaiting: waitingCards.filter((c) => c.resolved).map((c) => ({ id: c.id, state: c.state, summary: c.summary })),
        changesWithoutCard: pending
            .filter((c) => ids(c.comment).length === 0)
            .map((c) => ({ commit: c.version.slice(0, 10), date: c.date.slice(0, 8), author: c.username, title: firstLine(c.comment) })),
    };
}
