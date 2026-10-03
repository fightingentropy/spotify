import {afterEach,describe,expect,test} from "bun:test";
import {mkdtemp,writeFile,readFile,stat,rm,symlink,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {desktopSpotiflacSessionPath,migrateProviderSession,readDesktopSpotiflacSession} from "../src/server/spotiflac-session-refresh";
const roots:string[]=[];
async function fixture(){const root=await mkdtemp(join(tmpdir(),"provider-session-test-"));roots.push(root);return {root,legacy:join(root,"legacy.json"),target:join(root,"private","provider-session.json")};}
afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true});});
const record={install_id:"fixture-install",session_id:"fixture-id",session_secret:"fixture-secret",expires_at:"2099-01-01T00:00:00Z"};
describe("independent provider session migration",()=>{
  test("migrates privately while preserving the original record",async()=>{
    const f=await fixture();await writeFile(f.legacy,JSON.stringify(record));
    expect(await migrateProviderSession(f.target,f.legacy)).toEqual(record);
    expect(JSON.parse(await readFile(f.legacy,"utf8"))).toEqual(record);
    expect((await stat(f.target)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.root,"private"))).mode & 0o777).toBe(0o700);
    expect(await readDesktopSpotiflacSession(f.target)).toEqual(record);
  });
  test("never overwrites an existing or concurrently created new session",async()=>{
    const f=await fixture();await writeFile(f.legacy,JSON.stringify(record));
    await Promise.all([migrateProviderSession(f.target,f.legacy),migrateProviderSession(f.target,f.legacy)]);
    const newer={...record,session_id:"newer"};await writeFile(f.target,JSON.stringify(newer));
    expect(await migrateProviderSession(f.target,f.legacy)).toEqual(newer);
  });
  test("rejects malformed and oversized legacy records without leaking contents",async()=>{
    for(const raw of ['{"session_secret":"secret fixture",bad}',JSON.stringify({session_id:55}),"x".repeat(33000)]) {
      const f=await fixture();await writeFile(f.legacy,raw);
      await expect(migrateProviderSession(f.target,f.legacy)).rejects.toThrow("Could not migrate");
      expect(await stat(f.target).catch(()=>null)).toBeNull();
    }
  });
  test("refuses symlinked source or destination instead of reading arbitrary files",async()=>{
    const f=await fixture();const real=join(f.root,"real.json");await writeFile(real,JSON.stringify(record));await symlink(real,f.legacy);
    await expect(migrateProviderSession(f.target,f.legacy)).rejects.toThrow();
    await mkdir(join(f.root,"private"));await symlink(real,f.target);
    await expect(migrateProviderSession(f.target,real)).rejects.toThrow();
  });
  test("has no dependency on an installed SpotiFLAC bundle",async()=>{
    const source=await readFile(new URL("../src/server/spotiflac-session-refresh.ts",import.meta.url),"utf8");
    expect(source).not.toContain("Info.plist");expect(source).not.toContain("Bun.spawnSync");
    if(!process.env.SPOTIFLAC_SESSION_FILE) expect(desktopSpotiflacSessionPath()).toEndWith(".streamarena-music/provider-session.json");
  });
});
