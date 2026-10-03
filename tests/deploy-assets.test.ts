import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const deployScript = readFileSync(new URL("../scripts/deploy-mini.sh", import.meta.url), "utf8");
// Run the actual remote manifest/pruning program against isolated build files.
const remoteProgram = deployScript.split("<<'REMOTE_ASSETS'\n")[1]?.split("\nREMOTE_ASSETS")[0];
if (!remoteProgram) throw new Error("Deployment asset manifest program was not found");
const temporaryDirectories: string[] = [];

function deployment() {
  const root = mkdtempSync(join(tmpdir(), "spotify-assets-test-"));
  temporaryDirectories.push(root);
  const assets = join(root, "dist/client/assets");
  mkdirSync(assets, { recursive: true });
  mkdirSync(join(root, ".deploy"));
  const addAssets = (files: string[]) => {
    for (const file of files) {
      mkdirSync(join(assets, file, ".."), { recursive: true });
      writeFileSync(join(assets, file), file);
    }
  };
  const run = (mode: string) => Bun.spawnSync(["python3", "-c", remoteProgram, mode], {
    env: { ...process.env, REMOTE_APP: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const publish = (files: string[]) => {
    addAssets(files);
    writeFileSync(join(root, ".deploy/client-assets.next.json"), JSON.stringify(files));
    const result = run("publish");
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  };
  const manifest = () => JSON.parse(readFileSync(join(root, ".deploy/client-assets.json"), "utf8"));
  return { root, assets, addAssets, run, publish, manifest };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("frontend deployment asset retention", () => {
  test("keeps current and previous chunks, preserves them on retries, and prunes only older build assets", () => {
    const release = deployment();
    release.addAssets(["AlbumPage-old.js", "shared.js"]);
    writeFileSync(join(release.root, "music.flac"), "untouched app data");
    expect(release.run("prepare").exitCode).toBe(0);
    release.publish(["AlbumPage-new.js", "shared.js"]);
    expect(readdirSync(release.assets).sort()).toEqual(["AlbumPage-new.js", "AlbumPage-old.js", "shared.js"]);
    release.publish(["AlbumPage-new.js", "shared.js"]);
    expect(release.manifest().previous).toEqual(["AlbumPage-old.js", "shared.js"]);
    release.publish(["AlbumPage-newest.js", "shared.js"]);
    expect(readdirSync(release.assets).sort()).toEqual(["AlbumPage-new.js", "AlbumPage-newest.js", "shared.js"]);
    expect(release.manifest()).toEqual({ current: ["AlbumPage-newest.js", "shared.js"], previous: ["AlbumPage-new.js", "shared.js"] });
    expect(readFileSync(join(release.root, "music.flac"), "utf8")).toBe("untouched app data");
  });

  test("an incomplete upload or unsafe manifest cannot prune the current assets", () => {
    const release = deployment();
    release.addAssets(["current.js"]);
    expect(release.run("prepare").exitCode).toBe(0);
    for (const files of [["missing.js"], ["../../private-data"]]) {
      writeFileSync(join(release.root, ".deploy/client-assets.next.json"), JSON.stringify(files));
      expect(release.run("publish").exitCode).not.toBe(0);
      expect(readdirSync(release.assets)).toEqual(["current.js"]);
      expect(release.manifest().current).toEqual(["current.js"]);
    }
  });

  test("the static-file rsync updates HTML without deleting retained route chunks", () => {
    const release = deployment();
    const build = join(release.root, "build");
    mkdirSync(join(build, "client/assets"), { recursive: true });
    writeFileSync(join(build, "client/index.html"), "new index");
    release.addAssets(["previous.js", "current.js"]);
    writeFileSync(join(release.root, "dist/client/index.html"), "old index");
    const result = Bun.spawnSync(["rsync", "-a", "--checksum", "--delete", "--exclude=/client/assets/", `${build}/`, `${release.root}/dist/`]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(release.root, "dist/client/index.html"), "utf8")).toBe("new index");
    expect(readdirSync(release.assets).sort()).toEqual(["current.js", "previous.js"]);
  });
});
