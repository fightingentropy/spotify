import { describe, expect, test } from "bun:test";
import { collectionDownloadImages, downloadImageUrl, expandSpotifyDownloadLink, parseArtistDownloadImages, parseDownloadSearchPage } from "../src/lib/download-browse";
import { checkDownloadAvailability } from "../src/worker/download-availability";
import { downloadPreferences } from "../src/worker/download-preferences";
import type { DownloadCollection, DownloadTrack } from "../src/lib/download-catalog";
import { Hono } from "hono";
import { registerDownloadRoutes } from "../src/worker/downloads";
import type { AppEnv } from "../src/worker/env";
import { ApiError } from "../src/worker/http";

const id="0123456789012345678901";
const picture="https://i.scdn.co/image/ab67616d0000b273abcdef";
const preferences=downloadPreferences({downloadPreferences:{providerOrder:["tidal","qobuz","amazon"]}})!;
const track={id,title:"Track",artists:["Artist"],album:"Album",isrc:"GBABC2400001"};

test("all download catalog and asset endpoints require the music account before doing work",async()=>{
  const app=new Hono<AppEnv>();
  app.use("*",async(c,next)=>{c.set("user",null);await next();});
  app.onError(error=>Response.json({error:error.message},{status:error instanceof ApiError ? error.status : 500}));
  registerDownloadRoutes(app);
  for(const action of ["search","resolve","images","availability","check-sources"]) {
    const response=await app.request(`/api/downloads/${action}`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"},{} as CloudflareEnv);
    expect(response.status).toBe(401);
  }
});

describe("typed download search",()=>{
  test("preserves provider page totals and only parses the selected result section",()=>{
    const page=parseDownloadSearchPage({data:{searchV2:{albumsV2:{totalCount:82,items:[{data:{uri:`spotify:album:${id}`,name:"Album",artists:{items:[{profile:{name:"Artist"}}]},coverArt:{sources:[{url:picture,width:640}]}}}]},artists:{totalCount:1,items:[{data:{uri:`spotify:artist:${id}`,profile:{name:"Wrong category"}}}]}}}},"album",25,1);
    expect(page).toMatchObject({offset:25,limit:1,total:82,totalExact:false,hasMore:true});
    expect(page.items).toEqual([{id,kind:"album",title:"Album",subtitle:"Artist",coverUrl:picture,sourceUrl:`https://open.spotify.com/album/${id}`}]);
  });
  test("does not truncate pagination when Spotify returns a window estimate",()=>{
    const data={uri:`spotify:track:${id}`,name:"Track"};
    const page=parseDownloadSearchPage({data:{searchV2:{tracksV2:{totalCount:3,items:[{item:{data}}]}}}},"track",5,1);
    expect(page).toMatchObject({hasMore:true,total:7,totalExact:false});
    const final=parseDownloadSearchPage({tracks:{total:6,items:[{id,name:"Track"}]}},"track",5,1);
    expect(final).toMatchObject({hasMore:false,total:6,totalExact:true});
  });
  test("supports Web API and all four Pathfinder wrappers without harvesting credited artists",()=>{
    for(const kind of ["track","album","artist","playlist"] as const) {
      const data={id,uri:`spotify:${kind}:${id}`,name:"Result",profile:{name:"Result"},artists:[{name:"Artist"}],album:{images:[{url:picture}]},images:[{url:picture}]};
      expect(parseDownloadSearchPage({[`${kind}s`]:{total:1,items:[data]}},kind,0,25).items[0].kind).toBe(kind);
      expect(parseDownloadSearchPage({data:{searchV2:{[`${kind}sV2`]:{totalCount:1,items:[{item:{data}}]}}}},kind,0,25).hasMore).toBe(false);
    }
    expect(()=>parseDownloadSearchPage({data:{searchV2:{tracksV2:{items:[]}}}},"track",0,25)).toThrow("incomplete");
  });
});

describe("safe Spotify share URLs",()=>{
  test("follows only Spotify redirects and never includes credentials",async()=>{
    const urls:string[]=[];
    const result=await expandSpotifyDownloadLink("https://spotify.link/share",(async(input,init)=>{
      urls.push(String(input));
      expect(init?.redirect).toBe("manual");
      const headers=new Headers(init?.headers);
      expect(headers.has("cookie")).toBe(false);
      expect(headers.has("authorization")).toBe(false);
      return new Response(null,{status:302,headers:{location:`https://open.spotify.com/track/${id}?si=test`}});
    }));
    expect(result).toContain(`/track/${id}`);
    expect(urls).toEqual(["https://spotify.link/share"]);
  });
  test("refuses unsafe redirects before the second network request and bounds loops",async()=>{
    let count=0;
    await expect(expandSpotifyDownloadLink("https://spotify.link/share",(async()=>{
      count++; return new Response(null,{status:302,headers:{location:"http://127.0.0.1/private"}});
    }))).rejects.toThrow("Unsupported");
    expect(count).toBe(1);
    await expect(expandSpotifyDownloadLink("https://spotify.link/share",(async()=>new Response(null,{status:302,headers:{location:"/loop"}})))).rejects.toThrow("too many");
    await expect(expandSpotifyDownloadLink("https://user@spotify.link/share")).rejects.toThrow("Unsupported");
  });
});

describe("artwork-only metadata",()=>{
  test("returns avatar/header/gallery with public-CDN validation and resolution selection",()=>{
    const images=parseArtistDownloadImages({data:{artistUnion:{headerImage:{data:{sources:[{url:"https://image-cdn-ak.spotifycdn.com/header",width:2000}]}},visuals:{avatarImage:{sources:[{url:picture,width:640}]},gallery:{items:[{sources:[{url:"https://i.scdn.co/gallery/1",width:1000}]},{sources:[{url:"http://127.0.0.1/secret"}]}]}}}}},true);
    expect(images.map(image=>image.kind)).toEqual(["avatar","header","gallery"]);
    expect(images[0].url).toContain("ab67616d000082c1");
    expect(downloadImageUrl("https://user:secret@i.scdn.co/x")).toBe("");
    expect(downloadImageUrl("https://i.scdn.co.attacker.invalid/x")).toBe("");
  });
  test("deduplicates album art for batch assets without requiring audio",()=>{
    const collection={title:"Playlist",coverUrl:picture,tracks:[{album:"Album",coverUrl:picture},{album:"Other",coverUrl:"https://i.scdn.co/image/other"}]} as DownloadCollection;
    expect(collectionDownloadImages(collection)).toHaveLength(2);
  });
});

describe("provider catalog availability",()=>{
  const env={} as CloudflareEnv;
  const links={linksByPlatform:{tidal:{url:"https://tidal.com/browse/track/1"},amazonMusic:{url:"https://music.amazon.com/tracks/1"}}};
  test("honors resolver/provider selection without downloading media",async()=>{
    let calls=0;
    const prefs={...preferences,providerFallback:false,resolverFallback:false};
    const result=await checkDownloadAvailability(env,track,"tidal","max",prefs,async(_id,_region,_cookie,received)=>{
      calls++;expect(received).toEqual(prefs);return links;
    },async()=>{throw new Error("Qobuz must not run");});
    expect(calls).toBe(1);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({source:"tidal",status:"available"});
    expect(result.sources[0].message).toContain("no audio was fetched");
    expect(Date.parse(result.checkedAt)).toBeGreaterThan(0);
  });
  test("catalog matches never claim custom-instance or Atmos audio availability",async()=>{
    const result=await checkDownloadAvailability(env,track,"tidal","atmos",{...preferences,customTidalUrl:"https://custom.example"},async()=>links,async()=>({available:false,qobuzUrl:""}));
    expect(result.sources.find(source=>source.source==="tidal")?.status).toBe("unknown");
    expect(result.sources.find(source=>source.source==="amazon")?.status).toBe("unknown");
    expect(result.sources.find(source=>source.source==="qobuz")?.status).toBe("unavailable");
  });
  test("unavailable resolver returns uncertainty, not invented provider success",async()=>{
    const result=await checkDownloadAvailability(env,{...track,isrc:"",title:"",artists:[]},"","max",preferences,async()=>{throw new Error("offline");});
    expect(result.sources.every(source=>source.status==="unknown")).toBe(true);
    await expect(checkDownloadAvailability(env,{...track,id:"invalid"} as DownloadTrack,"tidal","max",preferences)).rejects.toThrow("Invalid");
  });
});
