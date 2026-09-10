import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const directory = fileURLToPath(new URL("./vendor/gogcli/", import.meta.url));
const manifest = JSON.parse(
  await readFile(new URL("./vendor/manifest.json", import.meta.url), "utf8"),
);
if (
  manifest.schema_version !== 1 ||
  !/^[a-f0-9]{40}$/.test(manifest.fork_revision) ||
  manifest.fork !== "https://github.com/mitchell-johnson/gogcli" ||
  !/^[a-f0-9]{40}$/.test(manifest.upstream_revision)
)
  throw new Error("Invalid native-port provenance");
const files = (await readdir(directory, { recursive: true })).sort();
const actual = [];
for (const name of files) {
  if (
    !name.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
  )
    throw new Error("Invalid vendor path");
  const path = join(directory, name);
  const stat = await lstat(path);
  if (stat.isDirectory()) continue;
  if (!stat.isFile()) throw new Error("Vendor symlinks are not supported");
  actual.push(name);
  const hash = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (manifest.files[name] !== hash)
    throw new Error(`Native port differs from pinned source: ${name}`);
}
if (
  JSON.stringify(actual) !== JSON.stringify(Object.keys(manifest.files).sort())
)
  throw new Error("Native port file set differs from pinned source");
const project = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);
for (const [name, version] of Object.entries(manifest.dependencies))
  if (project.dependencies[name] !== version)
    throw new Error(`Native dependency version differs: ${name}`);
process.stdout.write(
  `Verified ${actual.length} native gogcli files at ${manifest.fork_revision}\n`,
);
