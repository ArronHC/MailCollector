import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "src-tauri", "resources", "runtime");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

fs.mkdirSync(runtime, { recursive: true });
for (const directory of ["dist", "public"]) {
  const target = path.join(runtime, directory);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(root, directory), target, { recursive: true });
}

if (!fs.existsSync(path.join(runtime, "package.json")) || !fs.existsSync(path.join(runtime, "package-lock.json"))) {
  throw new Error("Desktop runtime package manifest is incomplete");
}

execFileSync(npmCommand, ["ci", "--omit=dev"], {
  cwd: runtime,
  stdio: "inherit",
  env: {
    ...process.env,
    npm_config_audit: "false",
    npm_config_fund: "false",
  },
});

const requiredRuntimePackages = [
  "better-sqlite3",
  "dotenv",
  "express",
  "imapflow",
  "mailparser",
  "nodemailer",
  "zod",
];
execFileSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `await Promise.all(${JSON.stringify(requiredRuntimePackages)}.map((name) => import(name)));`,
  ],
  { cwd: runtime, stdio: "inherit" },
);

fs.copyFileSync(process.execPath, path.join(runtime, "node.exe"));
console.log(`Desktop runtime prepared with ${process.version} and production dependencies`);
