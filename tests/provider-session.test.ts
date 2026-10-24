import {afterEach,describe,expect,test} from "bun:test";
import {mkdtemp,writeFile,readFile,rm,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {desktopSpotiflacSessionPath,readDesktopSpotiflacSession} from "../src/server/spotiflac-session-refresh";
const roots:string[]=[];
async function fixture(){const root=await mkdtemp(join(tmpdir(),"provider-session-test-"));roots.push(root);return {root,target:join(root,"provider-session.json")};}
afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true});});
const record={install_id:"fixture-install",session_id:"fixture-id",session_secret:"fixture-secret",expires_at:"2099-01-01T00:00:00Z"};
describe("provider session file",()=>{
  test("reads a saved session and treats a missing file as no session",async()=>{
    const f=await fixture();
    expect(await readDesktopSpotiflacSession(f.target)).toEqual({});
    await writeFile(f.target,JSON.stringify(record));
    expect(await readDesktopSpotiflacSession(f.target)).toEqual(record);
  });
  test("rejects malformed and oversized records",async()=>{
    for(const raw of ['{"session_secret":"secret fixture",bad}',JSON.stringify({session_id:55}),"x".repeat(33000)]) {
      const f=await fixture();await writeFile(f.target,raw);
      await expect(readDesktopSpotiflacSession(f.target)).rejects.toThrow();
    }
  });
  test("refuses a symlinked session file instead of reading arbitrary files",async()=>{
    const f=await fixture();const real=join(f.root,"real.json");await writeFile(real,JSON.stringify(record));await symlink(real,f.target);
    await expect(readDesktopSpotiflacSession(f.target)).rejects.toThrow();
  });
  test("has no dependency on an installed SpotiFLAC bundle",async()=>{
    const source=await readFile(new URL("../src/server/spotiflac-session-refresh.ts",import.meta.url),"utf8");
    expect(source).not.toContain("Info.plist");expect(source).not.toContain("Bun.spawnSync");
    if(!process.env.SPOTIFLAC_SESSION_FILE) expect(desktopSpotiflacSessionPath()).toEndWith(".streamarena-music/provider-session.json");
  });
});
