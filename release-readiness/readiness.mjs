// Gathers what an agent needs to say whether Bloom's next beta and release can be published, and
// prints it as JSON:
//
//   node readiness.mjs
//
// For every Beta Publish and Release Publish build configuration that is not paused in TeamCity's
// Bloom / Publish project, it reads the changes waiting for the next publish, looks up every
// YouTrack card those changes name, and lists the unresolved cards whose summary starts with that
// version's prefix ("[6.5]", "[6.5 Regression]") but whose code is not among the waiting changes.
// SKILL.md beside this file says how to turn the JSON into a report.
//
// TeamCity is read as a guest. YouTrack is read through the team's tool server (bloom-services),
// so no token is needed.
import { callService, configure } from "../bloom-services/sources.mjs";

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

const ids = (text) => [...new Set(text.match(CARD_ID) ?? [])];
const firstLine = (comment) => comment.split("\n")[0];

configure();
const configs = await publishConfigs();
const report = [];
for (const config of configs) {
    const { pending, published } = await changes(config.id);
    const pendingIds = ids(pending.map((c) => c.comment).join("\n"));
    const publishedIds = new Set(ids(published.map((c) => c.comment).join("\n")));
    const known = await cardsById(pendingIds);
    const waitingCards = pendingIds.map((id) => ({
        ...(known.get(id) ?? { id, summary: null, state: "not found in YouTrack", resolved: false }),
        commits: pending.filter((c) => c.comment.includes(id)).map((c) => `${c.version.slice(0, 10)} ${firstLine(c.comment)}`),
    }));
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
        pendingChangeCount: pending.length,
        holdingUp: waitingCards.filter((c) => !c.resolved),
        resolvedAndWaiting: waitingCards.filter((c) => c.resolved).map((c) => ({ id: c.id, state: c.state, summary: c.summary })),
        changesWithoutCard: pending
            .filter((c) => ids(c.comment).length === 0)
            .map((c) => ({ commit: c.version.slice(0, 10), date: c.date.slice(0, 8), author: c.username, title: firstLine(c.comment) })),
        versionCardsNotWaiting: notWaiting,
    });
}
console.log(JSON.stringify(report, null, 1));
