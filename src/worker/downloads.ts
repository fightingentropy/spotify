import { fetchPublicHttpUrl } from "@/lib/safe-fetch";
import { downloadPreferences, type DownloadPreferences } from "./download-preferences";
import type { Hono } from "hono";
import { parseDownloadInput, resolveDownloadCatalog, type DownloadTrack } from "@/lib/download-catalog";
import { artistDownloadImages, collectionDownloadImages, downloadImageUrl, expandSpotifyDownloadLink, searchDownloadCatalog, type DownloadSearchKind } from "@/lib/download-browse";
import { checkDownloadAvailability } from "./download-availability";
import { SpotifyPathfinderError } from "@/lib/spotify-pathfinder";
import type { AppEnv } from "./env";
import { jsonError, requireUser } from "./http";
import { readJson } from "./request";
import { envString, toStringValue } from "./values";

export async function checkDownloadSources(preferences: DownloadPreferences | undefined): Promise<Array<{source:"tidal"|"qobuz";ok:boolean;message:string}>> {
  return Promise.all((["tidal","qobuz"] as const).map(async(source)=>{
    const base = source === "tidal" ? preferences?.customTidalUrl : preferences?.customQobuzUrl;
    if (!base) return {source,ok:false,message:"No custom instance configured. Server providers are checked when downloading a track."};
    try {
      const response = await fetchPublicHttpUrl(new URL(base),{method:"GET",headers:{accept:"application/json,text/plain,*/*"}},6_000);
      await response.body?.cancel().catch(()=>undefined);
      return response.ok
        ? {source,ok:true,message:"Instance is reachable. Track availability and quality are checked during download."}
        : {source,ok:false,message:`Instance replied with HTTP ${response.status}. Track downloads have not been verified.`};
    } catch { return {source,ok:false,message:"Could not reach this public instance. Check the URL and network."}; }
  }));
}

export function registerDownloadRoutes(app: Hono<AppEnv>): void {
  app.post("/api/downloads/search",async(c)=>{
    requireUser(c.get("user"));
    const body=await readJson<{query?:unknown;type?:unknown;offset?:unknown;limit?:unknown}>(c.req.raw);
    try {
      return c.json(await searchDownloadCatalog(toStringValue(body?.query),toStringValue(body?.type) as DownloadSearchKind,
        body?.offset===undefined ? 0 : Number(body.offset),body?.limit===undefined ? 25 : Number(body.limit),envString(c.env,"SPOTIFY_SP_DC") || undefined));
    } catch(error) {
      if(error instanceof SpotifyPathfinderError) return jsonError(error.message,error.status);
      return jsonError("Catalog search is temporarily unavailable",502);
    }
  });
  app.post("/api/downloads/availability",async(c)=>{
    requireUser(c.get("user"));
    const body=await readJson<{track?:Partial<DownloadTrack>;source?:unknown;qualityProfile?:unknown;downloadPreferences?:unknown}>(c.req.raw);
    const raw=body?.track;
    const track={id:toStringValue(raw?.id),title:toStringValue(raw?.title),artists:Array.isArray(raw?.artists) ? raw.artists.filter((v):v is string=>typeof v==="string").slice(0,30) : [],album:toStringValue(raw?.album),isrc:toStringValue(raw?.isrc)};
    return c.json(await checkDownloadAvailability(c.env,track,toStringValue(body?.source),toStringValue(body?.qualityProfile)||"max",downloadPreferences(body ?? {})));
  });
  app.post("/api/downloads/images",async(c)=>{
    requireUser(c.get("user"));
    const body=await readJson<{input?:unknown;maxQualityArtwork?:unknown}>(c.req.raw);
    const input=toStringValue(body?.input).trim();
    if(input.length<2 || input.length>2048) return jsonError("Enter a Spotify artist, album, playlist or track link",400);
    try {
      const link=await expandSpotifyDownloadLink(input);
      const parsed=parseDownloadInput(link);
      const cookie=envString(c.env,"SPOTIFY_SP_DC") || undefined;
      if(parsed?.kind==="artist") return c.json({images:await artistDownloadImages(parsed.id,cookie,body?.maxQualityArtwork===true)});
      return c.json({images:collectionDownloadImages(await resolveDownloadCatalog(link,cookie),body?.maxQualityArtwork===true)});
    } catch(error) {
      if(error instanceof SpotifyPathfinderError) return jsonError(error.message,error.status);
      return jsonError("Could not load music artwork",502);
    }
  });
  app.post("/api/downloads/check-sources",async(c)=>{
    requireUser(c.get("user"));
    const body=await readJson<{downloadPreferences?:unknown}>(c.req.raw);
    if (!body) return jsonError("Invalid download preferences",400);
    return c.json({sources:await checkDownloadSources(downloadPreferences(body))});
  });
  app.post("/api/downloads/resolve",async(c)=>{
    requireUser(c.get("user"));
    const body=await readJson<{input?:unknown;maxQualityArtwork?:unknown}>(c.req.raw);
    const input=toStringValue(body?.input).trim();
    if (input.length<2 || input.length>2048) return jsonError("Enter a music search or Spotify link",400);
    try {
      const link=await expandSpotifyDownloadLink(input);
      const cookie=envString(c.env,"SPOTIFY_SP_DC") || undefined;
      const collection=await resolveDownloadCatalog(link,cookie);
      const maximum=body?.maxQualityArtwork===true;
      const parsed=parseDownloadInput(link);
      const images=parsed?.kind==="artist"
        ? await artistDownloadImages(parsed.id,cookie,maximum).catch(()=>collectionDownloadImages(collection,maximum))
        : collectionDownloadImages(collection,maximum);
      return c.json({...collection,images,coverUrl:downloadImageUrl(collection.coverUrl,maximum),
        tracks:maximum ? collection.tracks.map(track=>({...track,coverUrl:downloadImageUrl(track.coverUrl,true)})) : collection.tracks});
    } catch(error) {
      if (error instanceof SpotifyPathfinderError) return jsonError(error.message,error.status);
      return jsonError("Could not resolve this music. Please try again.",502);
    }
  });
}
