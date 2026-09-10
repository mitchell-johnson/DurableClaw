import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, lstat, readFile, unlink, rm } from "node:fs/promises";
import { ensurePrivateDirectory, privateRead, privateWrite } from "./store.mjs";

const exec = promisify(execFile);
export const LABEL = "com.durableclaw.device";
export const defaultDirectory = (home = homedir()) =>
  join(home, "Library", "Application Support", "DurableClaw");
const runtimeFiles = [
  "cli.mjs",
  "protocol.mjs",
  "executor.mjs",
  "store.mjs",
  "daemon.mjs",
  "pair.mjs",
  "installer.mjs",
];
const xml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char],
  );

export function installationPlan({
  home = homedir(),
  nodePath = process.execPath,
  uid = process.getuid?.(),
} = {}) {
  if (
    !isAbsolute(nodePath) ||
    !isAbsolute(home) ||
    !Number.isSafeInteger(uid) ||
    uid < 1
  )
    throw new Error("Installation requires absolute paths and a regular user");
  const directory = defaultDirectory(home);
  const plistPath = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const args = [
    nodePath,
    join(directory, "runtime", "cli.mjs"),
    "run",
    "--state",
    directory,
  ];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map((value) => `<string>${xml(value)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>10</integer>
<key>ProcessType</key><string>Background</string>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(directory, "daemon.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(directory, "daemon.log"))}</string>
</dict></plist>
`;
  return {
    directory,
    plistPath,
    plist,
    target: `gui/${uid}/${LABEL}`,
    domain: `gui/${uid}`,
  };
}

function requireMac(platform) {
  if (platform !== "darwin")
    throw new Error("launchd installation is available only on macOS");
}

async function bootout(plan, run) {
  try {
    await run("/bin/launchctl", ["bootout", plan.target]);
  } catch (error) {
    if (
      !/could not find service|no such process|service not found/i.test(
        `${error.stderr ?? ""} ${error.message ?? ""}`,
      )
    )
      throw error;
  }
}

export async function install({
  home = homedir(),
  nodePath = process.execPath,
  uid = process.getuid?.(),
  platform = process.platform,
  dryRun = false,
  run = exec,
} = {}) {
  requireMac(platform);
  const plan = installationPlan({ home, nodePath, uid });
  if (dryRun) return plan;
  await ensurePrivateDirectory(plan.directory);
  const runtime = join(plan.directory, "runtime");
  await ensurePrivateDirectory(runtime);
  const launchAgents = dirname(plan.plistPath);
  await mkdir(launchAgents, { recursive: true, mode: 0o700 });
  const info = await lstat(launchAgents);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid()) ||
    info.mode & 0o022
  )
    throw new Error(
      "LaunchAgents must be a user-owned directory without group/world write permission",
    );
  // Stop the existing service before replacing the modules it imports.
  await bootout(plan, run);
  const source = dirname(fileURLToPath(import.meta.url));
  for (const file of runtimeFiles)
    await privateWrite(join(runtime, file), await readFile(join(source, file)));
  const logPath = join(plan.directory, "daemon.log");
  try {
    await privateRead(logPath, 16 * 1024 * 1024);
  } catch (error) {
    if (error.code === "ENOENT") await privateWrite(logPath, "");
    else throw error;
  }
  await privateWrite(plan.plistPath, plan.plist);
  await run("/bin/launchctl", ["bootstrap", plan.domain, plan.plistPath]);
  return plan;
}

export async function uninstall({
  home = homedir(),
  uid = process.getuid?.(),
  platform = process.platform,
  dryRun = false,
  purge = false,
  run = exec,
} = {}) {
  requireMac(platform);
  const plan = installationPlan({ home, uid });
  if (dryRun) return { ...plan, purge };
  await bootout(plan, run);
  await unlink(plan.plistPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (purge) {
    await ensurePrivateDirectory(plan.directory);
    await rm(plan.directory, { recursive: true });
  }
  return { ...plan, purge };
}

export async function status({
  home = homedir(),
  uid = process.getuid?.(),
  platform = process.platform,
  run = exec,
} = {}) {
  requireMac(platform);
  const plan = installationPlan({ home, uid });
  let config = null;
  try {
    config = JSON.parse(await privateRead(join(plan.directory, "config.json")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let loaded = false;
  try {
    await run("/bin/launchctl", ["print", plan.target]);
    loaded = true;
  } catch (error) {
    if (
      !/could not find service|no such process|service not found/i.test(
        `${error.stderr ?? ""} ${error.message ?? ""}`,
      )
    )
      throw error;
  }
  return {
    loaded,
    paired: Boolean(config),
    device_id: config?.deviceId,
    server: config?.origin,
    directory: plan.directory,
  };
}
