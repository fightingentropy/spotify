import { resolveQobuzAvailability } from "@/lib/qobuz-download";
import type { DownloadTrack } from "@/lib/download-catalog";
import { getPlatformLink, resolveTrackPayload, qobuzCredentialsFromEnv } from "./provider-download";
import type { DownloadPreferences } from "./download-preferences";
import { ApiError } from "./http";
import { envString } from "./values";

export type DownloadAvailability = {source:string;status:"available"|"unavailable"|"unknown";message:string};
type Lookup = (id:string,region:string,cookie:string,preferences?:DownloadPreferences)=>Promise<Record<string,unknown>>;
type QobuzLookup = typeof resolveQobuzAvailability;
export async function checkDownloadAvailability(
  env:CloudflareEnv,track:Pick<DownloadTrack,"id"|"title"|"artists"|"album"|"isrc">,
  source:string,quality:string,preferences?:DownloadPreferences,
  lookup:Lookup=resolveTrackPayload,qobuzLookup:QobuzLookup=resolveQobuzAvailability,
):Promise<{sources:DownloadAvailability[];checkedAt:string}> {
  if(!/^[A-Za-z0-9]{22}$/.test(track.id) || !["","auto","tidal","qobuz","amazon","deezer","apple","youtube"].includes(source) ||
     !["cd","hires48","max","atmos"].includes(quality)) throw new ApiError("Invalid track availability request",400);
  const order=preferences?.providerOrder ?? ["tidal","qobuz","amazon"];
  let sources=source && source!=="auto" ? [source,...(preferences?.providerFallback===false || source==="youtube" ? [] : order.filter(value=>value!==source))] : [...order];
  if(preferences?.providerFallback===false) sources=sources.slice(0,1);
  let links:Record<string,unknown>={};
  let resolved=true;
  try { if(source!=="youtube") links=await lookup(track.id,"US",envString(env,"SPOTIFY_SP_DC"),preferences); }
  catch {resolved=false;}
  let qobuzUrl=getPlatformLink(links,"qobuz")?.url ?? "";
  if(sources.includes("qobuz") && !qobuzUrl && preferences?.resolverFallback!==false && (track.isrc || (track.title && track.artists.length))) {
    try {
      const found=await qobuzLookup({isrc:track.isrc,title:track.title,artist:track.artists.join(", "),album:track.album,credentials:qobuzCredentialsFromEnv(env)});
      qobuzUrl=found.available ? found.qobuzUrl : "";
    } catch { /* No catalog match must never be presented as a tested audio failure. */ }
  }
  const platform:Record<string,string>={tidal:"tidal",amazon:"amazonMusic",deezer:"deezer",apple:"appleMusic",qobuz:"qobuz"};
  return {checkedAt:new Date().toISOString(),sources:sources.map((source):DownloadAvailability=>{
    if(source==="youtube") return {source,status:"unknown",message:"YouTube is matched when downloading. Audio availability and quality have not been tested."};
    if(quality==="atmos" && !["tidal","amazon"].includes(source)) return {source,status:"unavailable",message:preferences?.atmosFallback!==false ? "This provider is eligible only for the permitted stereo fallback." : "This provider does not offer Atmos downloads."};
    const matched=source==="qobuz" ? !!qobuzUrl : !!getPlatformLink(links,platform[source])?.url;
    if(!matched) return {source,status:"unknown",message:resolved ? "The selected catalog resolver found no matching provider entry. A download may still find an alternate match." : "The catalog resolver is unavailable. This is not a download availability result."};
    const custom=source==="tidal" ? preferences?.customTidalUrl : source==="qobuz" ? preferences?.customQobuzUrl : "";
    if(custom || quality==="atmos") return {source,status:"unknown",message:`Catalog match found. ${custom ? "The custom instance" : "Dolby Atmos"} must be verified during download; no audio was fetched.`};
    return {source,status:"available",message:"A matching catalog entry was found. Download access and requested quality are verified when downloading; no audio was fetched."};
  })};
}
