import {afterEach,describe,expect,test} from "bun:test";
import {downloadPreferences,instanceUrl,resolverOrder} from "../src/worker/download-preferences";
import {checkDownloadSources} from "../src/worker/downloads";
import {qualityLists,tidalSpotbyeQualities,resolveProviderDownload,fetchResolvedAudioDownload,validateMinimumQualityResponse} from "../src/worker/provider-download";
import {licensedAudioOutput,stagedAudioMatchesQuality} from "../src/server/licensed-audio-output";
import {downloadStagingId} from "../src/worker/discover-stage";
import type {LicensedSourceStream} from "../src/lib/licensed-source-download";
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
const trackId="0123456789012345678901";
function boxed(type:string,payload:Uint8Array):Uint8Array {const b=new Uint8Array(payload.length+8);new DataView(b.buffer).setUint32(0,b.length);b.set(new TextEncoder().encode(type),4);b.set(payload,8);return b;}
function mp4(codec:string,joc=codec==="ec-3"):Uint8Array {const descriptor=boxed("dec3",new Uint8Array([0,0,0,0,0,1,16]));const audio=new Uint8Array(28+(joc?descriptor.length:0));if(joc) audio.set(descriptor,28);const entry=boxed(codec,audio);const header=new Uint8Array(entry.length+8);new DataView(header.buffer).setUint32(4,1);header.set(entry,8);let result=boxed("stsd",header);for(const tag of ["stbl","minf","mdia","trak","moov"]) result=boxed(tag,result);return result;}
describe("download source preferences",()=>{
  test("validates public instances and strict fallback/resolver settings",()=>{
    expect(instanceUrl("https://provider.example.test/base/" )).toBe("https://provider.example.test/base");
    for(const url of ["https://localhost","http://provider.example.test","https://user:password@provider.example.test","https://provider.example.test?key=secret","https://127.0.0.1","https://[::1]","https://10.0.0.1","https://host.local"]) expect(()=>instanceUrl(url)).toThrow();
    const options=downloadPreferences({downloadPreferences:{resolver:"songstats",resolverFallback:false,providerOrder:["qobuz","tidal"]}})!;
    expect(resolverOrder(options)).toEqual(["songstats"]);
    expect(options.providerOrder).toEqual(["qobuz","tidal"]);
    expect(()=>downloadPreferences({downloadPreferences:{providerOrder:["tidal","tidal"]}})).toThrow();
    expect(()=>downloadPreferences({downloadPreferences:{providerFallback:"false"}})).toThrow();
  });
  test("checks custom instance reachability without claiming track availability",async()=>{
    let calls=0;
    globalThis.fetch=(async(_url,init)=>{calls++;expect(new Headers(init?.headers).has("authorization")).toBe(false);return new Response("ok");}) as typeof fetch;
    const checked=await checkDownloadSources(downloadPreferences({downloadPreferences:{customTidalUrl:"https://8.8.8.8"}}));
    expect(calls).toBe(1);expect(checked[0].ok).toBe(true);expect(checked[0].message).toContain("Track availability");expect(checked[1].ok).toBe(false);
  });
  test("custom Qobuz requests its documented format code without built-in credentials",async()=>{
    const seen:string[]=[];
    globalThis.fetch=(async(url,init)=>{seen.push(String(url));expect(new Headers(init?.headers).get("authorization")).toBeNull();return Response.json({success:true,data:{url:"https://media.example.test/audio.flac"}});}) as typeof fetch;
    const payload={spotifyUrl:`https://open.spotify.com/track/${trackId}`,qualityProfile:"hires48",downloadPreferences:{customQobuzUrl:"https://8.8.8.8/base",providerFallback:false}};
    const result=await resolveProviderDownload({} as CloudflareEnv,"qobuz",trackId,{linksByPlatform:{qobuz:{url:"https://open.qobuz.com/track/123",entityUniqueId:"QOBUZ_SONG::123"}}},payload,qualityLists(payload));
    expect(seen).toEqual(["https://8.8.8.8/base/api/download-music?track_id=123&quality=7"]);
    expect(result.minimumQuality).toBe("lossless");
  });
  test("continues in candidate order when the first provider media request fails",async()=>{
    const calls:string[]=[];
    globalThis.fetch=(async(url)=>{calls.push(String(url));return String(url).includes("first") ? new Response("unavailable",{status:503}) : new Response("fLaC",{headers:{"content-type":"audio/flac"}});}) as typeof fetch;
    const response=await fetchResolvedAudioDownload({service:"tidal",streamUrl:"https://media.example.test/first",minimumQuality:"lossless",fallbacks:[{service:"qobuz",streamUrl:"https://media.example.test/second",minimumQuality:"lossless"}]});
    expect(await response.text()).toBe("fLaC");
    expect(calls).toEqual(["https://media.example.test/first","https://media.example.test/second"]);
  });
  test("strict custom Tidal Atmos uses trackManifests and preserves M4A",async()=>{
    globalThis.fetch=(async(url)=>{const endpoint=new URL(String(url));expect(endpoint.pathname).toBe("/trackManifests/");expect(endpoint.searchParams.get("formats")).toBe("EAC3_JOC");return Response.json({data:{data:{attributes:{formats:["EAC3_JOC"],uri:`data:application/dash+xml;base64,${Buffer.from('<MPD><Representation codecs="ec-3"/></MPD>').toString("base64")}`}}}});}) as typeof fetch;
    const payload={spotifyUrl:`https://open.spotify.com/track/${trackId}`,qualityProfile:"atmos",downloadPreferences:{customTidalUrl:"https://8.8.8.8",providerFallback:false,atmosFallback:false}};
    const result=await resolveProviderDownload({} as CloudflareEnv,"tidal",trackId,{linksByPlatform:{tidal:{url:"https://listen.tidal.com/track/123",entityUniqueId:"TIDAL_SONG::123"}}},payload,qualityLists(payload));
    expect(result.minimumQuality).toBe("atmos");expect(result.licensedStream?.outputFormat).toBe("m4a");expect(result.fallbacks).toEqual([]);
  });
});
describe("Atmos quality truth",()=>{
  test("strict Atmos never queues a stereo quality or reuses stereo staging",()=>{
    const strict={qualityProfile:"atmos",downloadPreferences:{atmosFallback:false}};
    expect(qualityLists(strict).tidal).toEqual(["ATMOS"]);expect(tidalSpotbyeQualities(strict)).toEqual(["atmos"]);
    expect(tidalSpotbyeQualities({qualityProfile:"atmos",downloadPreferences:{atmosFallbackQuality:"cd"}})).toEqual(["atmos","16"]);
    expect(downloadStagingId(trackId,"tidal","atmos")).not.toBe(downloadStagingId(trackId,"tidal","max"));
  });
  test("Mini remuxes E-AC-3 without a decoder or FLAC conversion",()=>{
    const output=licensedAudioOutput({codec:"ec-3"} as LicensedSourceStream);
    expect(output).toEqual({extension:"m4a",contentType:"audio/mp4",copyArgs:["-c:a","copy","-f","mp4","-movflags","+faststart"]});
    expect(stagedAudioMatchesQuality(mp4("ec-3"),"atmos")).toBe(true);
    expect(stagedAudioMatchesQuality(mp4("mp4a"),"atmos")).toBe(false);
    expect(stagedAudioMatchesQuality(mp4("ec-3",false),"atmos")).toBe(false);
    expect(stagedAudioMatchesQuality(mp4("ec-3"),"lossless")).toBe(false);
  });
  test("Worker refuses ordinary E-AC-3 without JOC metadata",async()=>{
    const result=await validateMinimumQualityResponse(new Response(new Uint8Array(mp4("ec-3",false))),{service:"tidal",streamUrl:"",minimumQuality:"atmos"});
    expect(typeof result).toBe("string");
  });
  test("Worker checks audio bytes rather than a provider's Atmos label",async()=>{
    for(const [codec,accepted] of [["ec-3",true],["mp4a",false],["fLaC",false]] as const) {
      const result=await validateMinimumQualityResponse(new Response(new Uint8Array(mp4(codec)),{headers:{"content-type":"audio/mp4"}}),{service:"tidal",streamUrl:"",minimumQuality:"atmos"});
      expect(result instanceof Response).toBe(accepted);
      if(result instanceof Response) await result.body?.cancel();
    }
  });
});
