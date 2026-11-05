// Runs one of the commands in sources.mjs and prints what it returns:
//
//   node tools.mjs <command> [arguments] [@<body file>]
//
// It signs in to the tool server with your GitHub login (`gh auth token`), so you need no token of
// your own for any of these services. SKILL.md beside this file says what each command reaches.

import { configure, sourceCommands, splitBody } from "./sources.mjs";

const [command, ...args] = process.argv.slice(2);
if (!Object.hasOwn(sourceCommands, command ?? "")) {
    console.error(`usage: node tools.mjs <command> ...; the commands are ${Object.keys(sourceCommands).join(", ")} (see sources.mjs)`);
    process.exit(1);
}
try {
    configure();
    const [commandArgs, body] = splitBody(command, args);
    console.log(await sourceCommands[command](commandArgs, body));
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
