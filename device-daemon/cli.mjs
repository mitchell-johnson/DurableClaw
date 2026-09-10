#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { runDaemon } from "./daemon.mjs";
import { pairDevice, readPairCode } from "./pair.mjs";
import { defaultDirectory, install, uninstall, status } from "./installer.mjs";

const help = `DurableClaw device daemon (Node.js 22.12+, macOS, regular user)

  node device-daemon/cli.mjs pair --server https://claw.example.com
  node device-daemon/cli.mjs install [--dry-run]
  node device-daemon/cli.mjs status
  node device-daemon/cli.mjs run [--state /absolute/state/path]
  node device-daemon/cli.mjs uninstall [--purge] [--dry-run]

Pairing reads a one-use code from hidden terminal input or stdin.
--allow-local-http permits loopback HTTP only, for local development.
Do not use sudo. Shell commands have this user's full privileges.
`;

export async function main(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      server: { type: "string" },
      state: { type: "string" },
      "dry-run": { type: "boolean" },
      "allow-local-http": { type: "boolean" },
      purge: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(help);
    return;
  }
  if (positionals.length !== 1) throw new Error("Expected one command");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12))
    throw new Error("Node.js 22.12 or newer is required");
  if (process.getuid?.() === 0)
    throw new Error("Do not use sudo; run as a regular user");
  const directory = values.state ? resolve(values.state) : defaultDirectory();
  if (command === "pair") {
    if (!values.server)
      throw new Error("pair requires --server https://your-server");
    const config = await pairDevice({
      directory,
      origin: values.server,
      code: await readPairCode(),
      allowLocalHttp: Boolean(values["allow-local-http"]),
    });
    console.log(
      `Paired device ${config.deviceId} with ${config.origin}. Run install to start its LaunchAgent.`,
    );
  } else if (command === "run") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    try {
      await runDaemon(directory, { signal: controller.signal });
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    }
  } else if (command === "install" || command === "uninstall") {
    if (values.state)
      throw new Error(
        "--state is supported only by pair and run; launchd uses the standard installation directory",
      );
    const plan = await (command === "install" ? install : uninstall)({
      dryRun: Boolean(values["dry-run"]),
      purge: Boolean(values.purge),
    });
    console.log(
      values["dry-run"]
        ? JSON.stringify(
            {
              directory: plan.directory,
              plistPath: plan.plistPath,
              plist: plan.plist,
              purge: plan.purge,
            },
            null,
            2,
          )
        : `${command === "install" ? "Installed" : "Uninstalled"} ${plan.plistPath}`,
    );
  } else if (command === "status")
    console.log(JSON.stringify(await status(), null, 2));
  else throw new Error(`Unknown command: ${command}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
