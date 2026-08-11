import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "src-tauri", "resources", "runtime");

fs.mkdirSync(runtime, { recursive: true });
for (const directory of ["dist", "public"]) {
  const target = path.join(runtime, directory);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(root, directory), target, { recursive: true });
}
fs.copyFileSync(process.execPath, path.join(runtime, "node.exe"));
console.log(`Desktop runtime prepared with ${process.version}`);
