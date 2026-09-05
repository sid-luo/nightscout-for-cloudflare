import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstream = path.join(root, "vendor", "nightscout", "translations");
const deployed = path.join(root, "public", "translations");

async function jsonFiles(directory, relative = "") {
  const files = [];
  for (const entry of await readdir(path.join(directory, relative))) {
    const candidate = path.join(relative, entry);
    if ((await stat(path.join(directory, candidate))).isDirectory()) {
      files.push(...await jsonFiles(directory, candidate));
    } else if (entry.endsWith(".json")) {
      files.push(candidate);
    }
  }
  return files.sort();
}

test("all locked Nightscout translations are valid and deployed byte-for-byte", async () => {
  const files = await jsonFiles(upstream);
  assert.equal(files.length, 33);
  const deployedFiles = await jsonFiles(deployed);
  assert.deepEqual(deployedFiles, [...files, "sl_SL.json"].sort());
  for (const file of files) {
    const source = await readFile(path.join(upstream, file));
    const asset = await readFile(path.join(deployed, file));
    assert.doesNotThrow(() => JSON.parse(source.toString("utf8")), file);
    assert.deepEqual(asset, source, file);
  }
  assert.deepEqual(
    await readFile(path.join(deployed, "sl_SL.json")),
    await readFile(path.join(upstream, "sl_SI.json")),
    "Slovenian compatibility alias must stay byte-identical to sl_SI.json",
  );
});
