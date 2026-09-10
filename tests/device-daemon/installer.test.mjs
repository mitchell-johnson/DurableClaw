import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verify, createPublicKey } from "node:crypto";
import {
  installationPlan,
  install,
  uninstall,
} from "../../device-daemon/installer.mjs";
import { pairDevice } from "../../device-daemon/pair.mjs";

test("launchd plan escapes XML and never stores authentication in plist", () => {
  const plan = installationPlan({
    home: "/tmp/a & <b>",
    nodePath: "/opt/Node & Stuff/node",
    uid: 501,
  });
  assert.match(plan.plist, /a &amp; &lt;b&gt;/);
  assert.match(plan.plist, /<string>run<\/string>/);
  assert.doesNotMatch(plan.plist, /private-key|AGENT_TOKEN|Bearer/);
  assert.ok(plan.plist.includes("<key>ExitTimeOut</key><integer>10</integer>"));
});
test("dry-run install performs no filesystem or launchctl mutation", async () => {
  const home = await mkdtemp(join(tmpdir(), "durableclaw-install-"));
  let calls = 0;
  const plan = await install({
    home,
    dryRun: true,
    platform: "darwin",
    uid: 501,
    run: async () => {
      calls++;
    },
  });
  assert.equal(calls, 0);
  await assert.rejects(access(plan.directory));
});
test("install copies runtime and uninstall preserves pairing by default", async () => {
  const home = await mkdtemp(join(tmpdir(), "durableclaw-install-"));
  const calls = [];
  const plan = await install({
    home,
    platform: "darwin",
    uid: 501,
    run: async (...args) => {
      calls.push(args);
    },
  });
  assert.equal((await stat(plan.plistPath)).mode & 0o777, 0o600);
  assert.match(
    await readFile(join(plan.directory, "runtime", "cli.mjs"), "utf8"),
    /runDaemon/,
  );
  assert.ok(calls.some((call) => call[1][0] === "bootstrap"));
  await uninstall({ home, platform: "darwin", uid: 501, run: async () => {} });
  await access(plan.directory);
  await assert.rejects(access(plan.plistPath));
});
test("pairing persists only device key and scoped configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durableclaw-pair-"));
  let body;
  const config = await pairDevice({
    directory,
    origin: "https://example.com",
    code: "a".repeat(43),
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return Response.json({ device_id: "device-1" });
    },
  });
  const publicKey = createPublicKey({
    key: Buffer.from(body.public_key, "base64"),
    format: "der",
    type: "spki",
  });
  assert.equal(
    verify(
      null,
      Buffer.from(`durableclaw-enroll-v1\n${body.code}\n${body.public_key}`),
      publicKey,
      Buffer.from(body.proof, "base64"),
    ),
    true,
  );
  assert.equal(config.deviceId, "device-1");
  const saved = await readFile(join(directory, "config.json"), "utf8");
  assert.doesNotMatch(saved, /"code"|private|Bearer/);
  assert.equal(
    (await stat(join(directory, "private-key.pem"))).mode & 0o777,
    0o600,
  );
  await assert.rejects(
    pairDevice({
      directory,
      origin: "https://example.com",
      code: "a".repeat(43),
    }),
    /already paired/,
  );
});
