import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

async function collectTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTests(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(fullPath);
  }
  return files;
}

const tests = (await collectTests(path.resolve("tests"))).sort();
if (!tests.length) {
  console.error("No test files found under tests/");
  process.exit(1);
}

const child = spawn(process.execPath, ["--import", "tsx", "--test", ...tests], {
  stdio: "inherit",
  shell: false
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Test process terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
