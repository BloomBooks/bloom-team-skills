// Prints each new line of ~/.claude/bloom-dashboard/events.log as it is written, for the
// session's Monitor. It saves how far it has read in events.offset, so a Monitor that is started
// again after its timeout prints the lines written while none was running, instead of losing them.
// The first run, with no events.offset, starts at the end of the log.
//
// Usage: node watch-events.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = path.join(os.homedir(), ".claude", "bloom-dashboard");
const log = path.join(dataDir, "events.log");
const offsetFile = path.join(dataDir, "events.offset");

const size = () => { try { return fs.statSync(log).size; } catch { return 0; } };
let offset = Number.parseInt(fs.existsSync(offsetFile) ? fs.readFileSync(offsetFile, "utf8") : "", 10);
if (!Number.isFinite(offset)) offset = size();

function readNew() {
  const end = size();
  if (end < offset) offset = 0; // the log was replaced
  if (end === offset) return;
  const fd = fs.openSync(log, "r");
  const buf = Buffer.alloc(end - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  // Only whole lines; a line still being written waits for the next read.
  const text = buf.toString("utf8");
  const last = text.lastIndexOf("\n");
  if (last < 0) return;
  for (const line of text.slice(0, last).split("\n")) if (line.trim()) console.log(line);
  offset += Buffer.byteLength(text.slice(0, last + 1));
  fs.writeFileSync(offsetFile, String(offset));
}

fs.writeFileSync(offsetFile, String(offset));
readNew();
setInterval(readNew, 1000);
