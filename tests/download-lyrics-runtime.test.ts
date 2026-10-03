import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

test("lyrics requests work in workerd and refuse redirects", async () => {
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fixtures/download-lyrics-worker.ts")],
    target: "browser",
  });
  expect(built.success).toBe(true);
  const bundle = await built.outputs[0].text();
  const directory = mkdtempSync(join(tmpdir(), "lyrics-workerd-"));
  try {
    writeFileSync(join(directory, "worker.js"), bundle);
    const result = spawnSync("node", ["--input-type=module", "-e", `
    import {readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {Miniflare} from 'miniflare';
    const directory=process.argv[1];
    const contents=readFileSync(join(directory,'worker.js'),'utf8');
    const runtime=new Miniflare({workers:[{config:{
      name:'download-lyrics-test',compatibilityDate:'2026-07-09',
      manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents}}}
    }}]});
    try {
      const response=await runtime.dispatchFetch('http://localhost/');
      writeFileSync(join(directory,'result.json'),await response.text());
    } finally {await runtime.dispose();}
    `, directory], { cwd: resolve(import.meta.dir, ".."), stdio: "inherit", timeout: 10_000 });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(directory, "result.json"), "utf8"))).toEqual({ miniFound: true, directFound: true, miniRequests: 1, lrclibRequests: 1 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 20_000);
