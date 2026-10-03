import { describe, expect, test } from "bun:test";
import { expandArtistDiscography, expandDownloadAlbum, expandGraphAlbum, expandGraphDiscography, parseDownloadComposer, parseDownloadInput, parseDownloadTrack, spotifyPaginationPath } from "../src/lib/download-catalog";
const artistId="0123456789012345678901";
const album1="0123456789012345678902";
const album2="0123456789012345678903";
const track1="0123456789012345678904";
const track2="0123456789012345678905";
const track=(id:string,n:number)=>({id,name:`Track ${n}`,artists:[{name:"Artist"}],track_number:n,disc_number:1,duration_ms:200000,external_ids:{isrc:`ISRC${n}`}});
const album=(id:string,items:unknown[])=>({id,name:`Album ${id}`,artists:[{name:"Album artist"}],total_tracks:items.length,release_date:"2025-05-01",label:"Label",external_ids:{upc:"12345"},copyrights:[{text:"Copyright"}],images:[{url:"https://i.scdn.co/image/cover"}],tracks:{items}});

describe("download catalog",()=>{
  test("accepts Spotify canonical/locale links and URIs while rejecting impostor links",()=>{
    expect(parseDownloadInput(`https://open.spotify.com/intl-en/album/${album1}?si=abc`)).toEqual({kind:"album",id:album1});
    expect(parseDownloadInput(`spotify:artist:${artistId}`)).toEqual({kind:"artist",id:artistId});
    expect(parseDownloadInput("Artist song")).toBeNull();
    expect(()=>parseDownloadInput(`https://open.spotify.com.attacker.invalid/track/${track1}`)).toThrow();
    expect(()=>parseDownloadInput(`https://attacker@open.spotify.com/track/${track1}`)).toThrow();
  });
  test("preserves portable metadata and does not fabricate absent composer",()=>{
    const result=parseDownloadTrack(track(track1,2),album(album1,[track(track1,2)]));
    expect(result).toMatchObject({id:track1,albumArtist:"Album artist",trackNumber:2,trackTotal:1,discTotal:1,isrc:"ISRC2",upc:"12345",label:"Label",composer:"",durationMs:200000});
  });
  test("pagination rejects credentials and non-Spotify hosts",()=>{
    expect(spotifyPaginationPath(`https://api.spotify.com/v1/albums/${album1}/tracks?offset=50`,`/v1/albums/${album1}/tracks`)).toContain("offset=50");
    expect(()=>spotifyPaginationPath("https://other.example/v1/albums/a/tracks","/v1/albums/a/tracks")).toThrow();
    expect(()=>spotifyPaginationPath("https://user@api.spotify.com/v1/albums/a/tracks","/v1/albums/a/tracks")).toThrow();
  });
  test("fully expands album pages and retains disc total",async()=>{
    const paths:string[]=[];
    const result=await expandDownloadAlbum(album1,async(path)=>{
      paths.push(path);
      if(path===`/v1/albums/${album1}`) return {...album(album1,[track(track1,1)]),total_tracks:2,tracks:{items:[track(track1,1)],next:`https://api.spotify.com/v1/albums/${album1}/tracks?offset=1`}};
      return {items:[{...track(track2,2),disc_number:2}],next:null};
    });
    expect(paths).toHaveLength(2);
    expect(result.tracks).toHaveLength(2);
    expect(result.tracks[0].discTotal).toBe(2);
  });
  test("artist discography expands every release page and deduplicates recordings",async()=>{
    const paths:string[]=[];
    const result=await expandArtistDiscography(artistId,async(path)=>{
      paths.push(path);
      if(path===`/v1/artists/${artistId}`) return {name:"Artist"};
      if(path.includes("include_groups")) return {items:[{id:album1}],next:`https://api.spotify.com/v1/artists/${artistId}/albums?offset=50`};
      if(path.includes("offset=50")) return {items:[{id:album2}],next:null};
      if(path===`/v1/albums/${album1}`) return album(album1,[track(track1,1)]);
      return album(album2,[track(track1,1),track(track2,2)]);
    });
    expect(paths).toHaveLength(5);
    expect(result.kind).toBe("artist");
    expect(result.tracks.map((t)=>t.id)).toEqual([track1,track2]);
  });
  test("rejects a repeated provider page rather than returning a partial album",async()=>{
    await expect(expandDownloadAlbum(album1,async()=>({...album(album1,[]),items:[track(track1,1)],next:`https://api.spotify.com/v1/albums/${album1}/tracks?offset=1`,tracks:{items:[track(track1,1)],next:`https://api.spotify.com/v1/albums/${album1}/tracks?offset=1`}}))).rejects.toThrow("pagination");
  });

});


const graphTrack=(id:string,n:number,disc=1)=>({uri:`spotify:track:${id}`,name:`Track ${n}`,artists:{items:[{profile:{name:"Artist"}}]},trackNumber:n,discNumber:disc,duration:{totalMilliseconds:200000}});
const graphAlbum=(items:unknown[],total=items.length)=>({data:{albumUnion:{name:"Release",artists:{items:[{profile:{name:"Album artist"}}]},date:{isoString:"2025-05-01T00:00:00Z"},label:"Label",copyright:{items:[{text:"Copyright"}]},coverArt:{sources:[{url:"small",width:64},{url:"large",width:640}]},tracksV2:{items:items.map((track)=>({track})),totalCount:total}}}});
const graphReleases=(ids:string[],total=ids.length)=>({data:{artistUnion:{discography:{all:{totalCount:total,items:ids.map((id)=>({releases:{items:[{id}]}}))}}}}});

describe("current Spotify download metadata",()=>{
  test("expands tracksV2 pages and preserves real multi-disc track numbers",async()=>{
    const offsets:unknown[]=[];
    const result=await expandGraphAlbum(album1,async(_operation,variables)=>{
      offsets.push(variables.offset);
      return variables.offset===0 ? graphAlbum([graphTrack(track1,8)],2) : graphAlbum([graphTrack(track2,1,2)],2);
    });
    expect(offsets).toEqual([0,1]);
    expect(result.tracks.map((t)=>[t.trackNumber,t.discNumber,t.discTotal])).toEqual([[8,1,2],[1,2,2]]);
    expect(result.tracks[0]).toMatchObject({albumArtist:"Album artist",coverUrl:"large",releaseDate:"2025-05-01",label:"Label",copyright:"Copyright"});
  });
  test("expands every artist release page and fails if any album is unavailable",async()=>{
    const offsets:unknown[]=[];
    const get=async(operation:string,variables:Record<string,unknown>)=>{
      if(operation==="artist") return {data:{artistUnion:{profile:{name:"Artist"}}}};
      if(operation==="discography") {
        offsets.push(variables.offset);
        return graphReleases([variables.offset===0 ? album1 : album2],2);
      }
      return graphAlbum([graphTrack(variables.uri===`spotify:album:${album1}` ? track1 : track2,1)]);
    };
    const result=await expandGraphDiscography(artistId,get);
    expect(offsets).toEqual([0,1]);
    expect(result.tracks.map((t)=>t.id)).toEqual([track1,track2]);
    await expect(expandGraphDiscography(artistId,async(operation,variables)=>{
      if(variables.uri===`spotify:album:${album2}`) throw new Error("album unavailable");
      return get(operation,variables);
    })).rejects.toThrow("album unavailable");
  });
  test("rejects repeated provider album pages instead of silently returning a partial collection",async()=>{
    await expect(expandGraphAlbum(album1,async()=>graphAlbum([graphTrack(track1,1)],3))).rejects.toThrow("Repeated");
  });
  test("rejects missing metadata and incomplete provider pages",async()=>{
    await expect(expandGraphAlbum(album1,async(_operation,variables)=>variables.offset===0 ? graphAlbum([graphTrack(track1,1)],2) : graphAlbum([],2))).rejects.toThrow("all album tracks");
    await expect(expandGraphAlbum(album1,async()=>graphAlbum([{name:"Track without ID"}]))).rejects.toThrow("incomplete metadata");
  });
  test("rejects repeated artist pages and explicit release limits",async()=>{
    const get=async(operation:string,total:number)=>operation==="artist" ? {data:{artistUnion:{profile:{name:"Artist"}}}} : graphReleases([album1],total);
    await expect(expandGraphDiscography(artistId,async(operation)=>get(operation,3))).rejects.toThrow("Repeated");
    await expect(expandGraphDiscography(artistId,async(operation)=>get(operation,251))).rejects.toThrow("250 releases");
  });
  test("uses composer credits without mislabelling performers or inventing names",()=>{
    const credits=(items:unknown[])=>({data:{trackUnion:{creditsTrait:{contributors:{items}}}}});
    expect(parseDownloadComposer(credits([{name:"Performer",role:"Main Artist"},{name:"Composer",role:"Composer"},{name:"Composer",role:"Composer"},{name:"Writer",role:"Writer"}]))).toBe("Composer");
    expect(parseDownloadComposer(credits([{name:"Writer",role:"Writer"}]))).toBe("Writer");
    expect(parseDownloadComposer(null)).toBe("");
  });
});
