import fs from "node:fs";
import path from "node:path";

const dist = path.resolve("dist");
const core = path.join(dist, "server.js");
const entry = path.join(dist, "server-entry.js");
const coreTarget = path.join(dist, "server-core.js");

if (!fs.existsSync(core)) throw new Error("dist/server.js was not produced by TypeScript");
if (!fs.existsSync(entry)) throw new Error("dist/server-entry.js was not produced by TypeScript");

fs.rmSync(coreTarget, { force: true });
fs.renameSync(core, coreTarget);
fs.renameSync(entry, core);
