#!/usr/bin/env node
// Tells the developer's dashboard that a card or a PR has just changed, so that it reads again
// now: node tell-dashboard.mjs card-changed | pr-changed. With no dashboard running it does
// nothing and exits 0. The script itself belongs to the dashboard.
import { main } from "../orca-bloom-dashboard-plugin/report/tell.mjs";
await main(process.argv.slice(2));
