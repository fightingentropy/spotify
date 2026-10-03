import { fetchSpotifyDownloadGraph, fetchSpotifyDownloadMetadata, SpotifyPathfinderError } from "./spotify-pathfinder";
import { parseDownloadInput, type DownloadCollection } from "./download-catalog";

export type DownloadSearchKind = "track" | "album" | "artist" | "playlist";
export type DownloadSearchItem = { id:string;kind:DownloadSearchKind;title:string;subtitle:string;coverUrl:string;sourceUrl:string;trackCount?:number };
export type DownloadSearchPage = { items:DownloadSearchItem[];offset:number;limit:number;total:number;totalExact:boolean;hasMore:boolean };
export type DownloadImage = { kind:"cover"|"avatar"|"header"|"gallery";url:string;label:string };
const object=(value:unknown):Record<string,unknown>=>value && typeof value==="object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
const array=(value:unknown):unknown[]=>Array.isArray(value) ? value : [];
const text=(value:unknown):string=>typeof value==="string" ? value : "";
const idValid=(value:string)=>/^[A-Za-z0-9]{22}$/.test(value);
const imageHosts=["scdn.co","spotifycdn.com","dzcdn.net","ytimg.com","mzstatic.com","qobuz.com","tidal.com"];

export function downloadImageUrl(input:string,maxQuality=false):string {
  try {
    const url=new URL(input);
    if(url.protocol!=="https:" || url.username || url.password || url.port ||
       !imageHosts.some(host=>url.hostname===host || url.hostname.endsWith(`.${host}`))) return "";
    if(maxQuality && url.hostname==="i.scdn.co") {
      url.pathname=url.pathname.replace(/ab67616d(?:00001e02|0000b273)/,"ab67616d000082c1");
    }
    return url.toString();
  } catch { return ""; }
}
function largest(value:unknown):string {
  const sources=Array.isArray(value) ? value : array(object(value).sources);
  return sources.map(object).sort((a,b)=>Number(b.width ?? 0)-Number(a.width ?? 0))
    .map(source=>downloadImageUrl(text(source.url))).find(Boolean) ?? "";
}
function image(value:unknown):string {
  const data=object(value);
  return largest(data.sources) || largest(data.images) || largest(data.coverArt) || largest(object(data.visuals).avatarImage) ||
    array(object(data.images).items).map(entry=>largest(object(entry).sources)).find(Boolean) || "";
}
function artistNames(value:unknown):string {
  return (Array.isArray(value) ? value : array(object(value).items)).map(entry=>{
    const artist=object(entry); return text(object(artist.profile).name) || text(artist.name);
  }).filter(Boolean).join(", ");
}
function unwrap(value:unknown):Record<string,unknown> {
  let data=object(value);
  for(let level=0;level<4;level++) {
    const next=data.itemV2 ?? data.item ?? data.data;
    if(!next || typeof next!=="object") break;
    data=object(next);
  }
  return data;
}
export function parseDownloadSearchPage(payload:unknown,kind:DownloadSearchKind,offset:number,limit:number):DownloadSearchPage {
  const root=object(payload);
  const graph=object(root.data).searchV2 ?? root.searchV2;
  const search=object(graph ?? root);
  const plural=`${kind}s`;
  const section=object(search[`${plural}V2`] ?? search[plural]);
  const total=Number(section.totalCount ?? section.total);
  if(!Number.isFinite(total) || total<0 || !Array.isArray(section.items)) throw new SpotifyPathfinderError("Spotify returned an incomplete search page",502);
  const seen=new Set<string>();
  const items:DownloadSearchItem[]=[];
  for(const row of section.items) {
    const data=unwrap(row);
    const uri=text(data.uri);
    if(uri && !uri.startsWith(`spotify:${kind}:`)) continue;
    const id=text(data.id) || uri.replace(`spotify:${kind}:`,"");
    const title=text(data.name) || text(object(data.profile).name);
    if(!idValid(id) || !title || seen.has(id)) continue;
    seen.add(id);
    const album=object(data.albumOfTrack ?? data.album);
    const owner=object(object(data.ownerV2).data ?? data.owner);
    const subtitle=kind==="artist" ? "Artist" : kind==="playlist" ? text(owner.display_name) || text(owner.name) || text(object(owner.profile).name) : artistNames(data.artists);
    const count=Number(data.total_tracks ?? object(data.tracks).total ?? object(data.tracks).totalCount ?? object(data.content).totalCount);
    items.push({id,kind,title,subtitle,coverUrl:image(kind==="track" ? album : data),sourceUrl:`https://open.spotify.com/${kind}/${id}`,
      ...(Number.isFinite(count) && count>=0 ? {trackCount:count} : {})});
  }
  const consumed=section.items.length;
  // searchDesktop totalCount is a changing window estimate, not the global
  // result count (live page2 can report total8 while returning rows6–10).
  // Its full pages are the only reliable continuation signal; Web API totals
  // are authoritative. One final empty page is preferable to dropping results.
  const hasMore=offset+limit<1000 && (graph ? consumed>=limit : consumed>0 && offset+consumed<total);
  return {items:items.slice(0,limit),offset,limit,total:graph ? Math.max(total,offset+consumed+(hasMore ? 1 : 0)) : total,totalExact:!graph,hasMore};
}
export async function searchDownloadCatalog(query:string,kind:DownloadSearchKind,offset=0,limit=25,cookie?:string):Promise<DownloadSearchPage> {
  query=query.trim();
  if(query.length<2 || query.length>100 || !["track","album","artist","playlist"].includes(kind) ||
     !Number.isInteger(offset) || offset<0 || offset>=1000 || !Number.isInteger(limit) || limit<1 || limit>50) {
    throw new SpotifyPathfinderError("Enter a search and choose a valid page (up to 1,000 results)",400);
  }
  try {
    const payload=await fetchSpotifyDownloadGraph("search",{searchTerm:query,offset,limit,numberOfTopResults:5,includeAudiobooks:false},cookie);
    return parseDownloadSearchPage(payload,kind,offset,limit);
  } catch { /* Web API fallback uses the same exact page and result type. */ }
  const params=new URLSearchParams({q:query,type:kind,offset:String(offset),limit:String(limit)});
  return parseDownloadSearchPage(await fetchSpotifyDownloadMetadata(`/v1/search?${params}`,cookie),kind,offset,limit);
}

// Shared links never receive the music session or Spotify credentials. Every
// redirect is checked before fetching, so a provider cannot redirect to an
// arbitrary third-party or local service.
export async function expandSpotifyDownloadLink(input:string,request:(input:string,init?:RequestInit)=>Promise<Response>=fetch):Promise<string> {
  input=input.trim();
  if(input.startsWith("www.")) input=`https://${input}`;
  if(!/^https?:\/\//i.test(input)) return input;
  let url:URL;
  try { url=new URL(input); } catch { throw new SpotifyPathfinderError("Invalid Spotify link",400); }
  const hosts=["spotify.link","spotify.app.link","open.spotify.com","play.spotify.com"];
  for(let hop=0;hop<5;hop++) {
    if(url.protocol!=="https:" || url.username || url.password || url.port || !hosts.includes(url.hostname)) throw new SpotifyPathfinderError("Unsupported Spotify share link",400);
    if(["open.spotify.com","play.spotify.com"].includes(url.hostname)) {
      parseDownloadInput(url.toString());
      return url.toString();
    }
    const response=await request(url.toString(),{redirect:"manual",headers:{accept:"text/html"},signal:AbortSignal.timeout(8_000)});
    await response.body?.cancel().catch(()=>undefined);
    if(response.status<300 || response.status>=400 || !response.headers.get("location")) throw new SpotifyPathfinderError("This Spotify share link did not resolve. Paste its full Spotify URL.",502);
    url=new URL(response.headers.get("location")!,url);
  }
  throw new SpotifyPathfinderError("Spotify share link redirected too many times",502);
}

export function parseArtistDownloadImages(payload:unknown,maxQuality=false):DownloadImage[] {
  const artist=object(object(object(payload).data).artistUnion ?? payload);
  const visuals=object(artist.visuals);
  const images:DownloadImage[]=[];
  const seen=new Set<string>();
  const add=(kind:DownloadImage["kind"],url:string,label:string)=>{
    url=downloadImageUrl(url,maxQuality);
    if(url && !seen.has(url)) {seen.add(url);images.push({kind,url,label});}
  };
  add("avatar",largest(visuals.avatarImage) || largest(artist.images),"Artist portrait");
  add("header",largest(visuals.headerImage) || largest(object(object(artist.headerImage).data).sources),"Artist header");
  for(const [index,value] of array(object(visuals.gallery).items ?? visuals.gallery).slice(0,50).entries()) {
    add("gallery",largest(value) || image(value),`Gallery ${index+1}`);
  }
  return images;
}
export async function artistDownloadImages(id:string,cookie?:string,maxQuality=false):Promise<DownloadImage[]> {
  if(!idValid(id)) throw new SpotifyPathfinderError("Invalid artist ID",400);
  try { return parseArtistDownloadImages(await fetchSpotifyDownloadGraph("artist",{uri:`spotify:artist:${id}`,locale:""},cookie),maxQuality); }
  catch { return parseArtistDownloadImages(await fetchSpotifyDownloadMetadata(`/v1/artists/${id}`,cookie),maxQuality); }
}
export function collectionDownloadImages(collection:DownloadCollection,maxQuality=false):DownloadImage[] {
  const seen=new Set<string>();
  const images:DownloadImage[]=[];
  for(const [label,url] of [[collection.title,collection.coverUrl],...collection.tracks.map(track=>[track.album || track.title,track.coverUrl])]) {
    const allowed=downloadImageUrl(url,maxQuality);
    if(allowed && !seen.has(allowed)) {seen.add(allowed);images.push({kind:"cover",url:allowed,label});}
  }
  return images;
}
