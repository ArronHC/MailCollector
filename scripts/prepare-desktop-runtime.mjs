import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "src-tauri", "resources", "runtime");
const frpVersion = "0.70.1";

fs.mkdirSync(runtime, { recursive: true });
for (const directory of ["dist", "public"]) {
  const target = path.join(runtime, directory);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(root, directory), target, { recursive: true });
}

if (!fs.existsSync(path.join(runtime, "package.json")) || !fs.existsSync(path.join(runtime, "package-lock.json"))) {
  throw new Error("Desktop runtime package manifest is incomplete");
}

const npmExecPath = process.env.npm_execpath;
if (npmExecPath && fs.existsSync(npmExecPath)) {
  execFileSync(process.execPath, [npmExecPath, "ci", "--omit=dev"], {
    cwd: runtime,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });
} else {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npmCommand, ["ci", "--omit=dev"], {
    cwd: runtime,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });
}

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

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function ensureFrpc() {
  if (process.platform !== "win32") {
    console.log("Skipping Windows frpc bundle on non-Windows build host");
    return;
  }
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : "";
  if (!arch) throw new Error(`Unsupported Windows architecture for frpc: ${process.arch}`);

  const target = path.join(runtime, "frpc.exe");
  if (fs.existsSync(target)) {
    console.log(`Using existing frpc.exe for frp v${frpVersion}`);
    return;
  }

  const archiveName = `frp_${frpVersion}_windows_${arch}.zip`;
  const baseUrl = `https://github.com/fatedier/frp/releases/download/v${frpVersion}`;
  const [archive, checksums] = await Promise.all([
    download(`${baseUrl}/${archiveName}`),
    download(`${baseUrl}/frp_sha256_checksums.txt`)
  ]);
  const checksumLine = checksums.toString("utf8").split(/\r?\n/).find((line) => line.includes(archiveName));
  const expectedSha256 = checksumLine?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error(`Unable to find SHA-256 checksum for ${archiveName}`);
  }
  const actualSha256 = createHash("sha256").update(archive).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`frpc archive checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mailcollector-frp-"));
  const archivePath = path.join(tempRoot, archiveName);
  const extractDir = path.join(tempRoot, "extract");
  fs.writeFileSync(archivePath, archive);
  fs.mkdirSync(extractDir, { recursive: true });
  const psQuote = (value) => `'${value.replace(/'/g, "''")}'`;
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Expand-Archive -LiteralPath ${psQuote(archivePath)} -DestinationPath ${psQuote(extractDir)} -Force`
  ], { stdio: "inherit" });
  const source = path.join(extractDir, `frp_${frpVersion}_windows_${arch}`, "frpc.exe");
  if (!fs.existsSync(source)) throw new Error(`frpc.exe not found in ${archiveName}`);
  fs.copyFileSync(source, target);
  execFileSync(target, ["--version"], { stdio: "inherit", windowsHide: true });
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log(`Bundled frpc v${frpVersion} (${arch})`);
}

await ensureFrpc();
fs.copyFileSync(process.execPath, path.join(runtime, "node.exe"));
console.log(`Desktop runtime prepared with ${process.version} and production dependencies`);
