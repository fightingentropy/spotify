import {
  fetchSpotifyAlbumCatalog, fetchSpotifyDownloadMetadata, fetchSpotifyDownloadGraph, fetchSpotifyLikedTracks,
  fetchSpotifyPlaylistCatalogPage, fetchSpotifyTrackMetadata, searchSpotifyCatalog,
  SpotifyPathfinderError, type SpotifyBatchTrack,
} from "./spotify-pathfinder";

export type DownloadTrack = {
  id: string; title: string; artists: string[]; album: string; albumArtist: string;
  trackNumber: number; trackTotal: number; discNumber: number; discTotal: number;
  releaseDate: string; isrc: string; upc: string; coverUrl: string; genre: string;
  composer: string; copyright: string; label: string; sourceUrl: string; durationMs: number;
  releaseType?: string;
};
export type DownloadCollection = { title: string; kind: string; tracks: DownloadTrack[]; coverUrl: string; owner?: string };
const MAX_TRACKS = 10_000;
const MAX_RELEASES = 250;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const text = (v: unknown): string => typeof v === "string" ? v : "";
const number = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
const names = (v: unknown): string[] => array(v).map((a) => text(object(a).name)).filter(Boolean);
const cover = (v: unknown): string => text(object(array(v)[0]).url);
const idValid = (id: string): boolean => /^[A-Za-z0-9]{22}$/.test(id);

export function parseDownloadInput(input: string): {kind: string; id: string} | null {
  const uri = input.match(/^spotify:(track|album|playlist|artist):([A-Za-z0-9]{22})$/);
  if (uri) return {kind: uri[1], id: uri[2]};
  if (input === "spotify:collection:tracks") return {kind:"collection",id:"tracks"};
  if (input.startsWith("spotify:")) throw new SpotifyPathfinderError("Invalid Spotify link",400);
  if (!/^https?:\/\//i.test(input)) return null;
  let url: URL;
  try { url = new URL(input); } catch { throw new SpotifyPathfinderError("Invalid music link", 400); }
  if (url.protocol !== "https:" || !["open.spotify.com","play.spotify.com"].includes(url.hostname) || url.username || url.password) {
    throw new SpotifyPathfinderError("Paste a Spotify track, album, playlist, or artist link",400);
  }
  const path = url.pathname.replace(/^\/intl-[a-z-]+\//i,"/");
  if (path === "/collection/tracks") return {kind:"collection",id:"tracks"};
  const match = path.match(/^\/(track|album|playlist|artist)\/([A-Za-z0-9]{22})\/?$/);
  if (!match) throw new SpotifyPathfinderError("Paste a Spotify track, album, playlist, or artist link",400);
  return {kind:match[1],id:match[2]};
}

export function parseDownloadTrack(value: unknown, albumValue?: unknown): DownloadTrack | null {
  const track = object(value);
  const id = text(track.id);
  const title = text(track.name);
  if (!idValid(id) || !title || track.is_local === true) return null;
  const album = object(albumValue ?? track.album);
  const external = object(track.external_ids);
  const albumExternal = object(album.external_ids);
  return {
    id,title,artists:names(track.artists), album:text(album.name),albumArtist:names(album.artists).join(", "),releaseType:text(album.album_type).toLowerCase(),
    trackNumber:number(track.track_number),trackTotal:number(album.total_tracks),discNumber:number(track.disc_number),
    discTotal: Math.max(0,...array(object(album.tracks).items).map((item)=>number(object(item).disc_number))),
    releaseDate:text(album.release_date),isrc:text(external.isrc),upc:text(albumExternal.upc),coverUrl:cover(album.images),
    genre:array(album.genres).map(text).filter(Boolean).join("; "),composer:"",
    copyright:array(album.copyrights).map((item)=>text(object(item).text)).filter(Boolean).join("; "),
    label:text(album.label),sourceUrl:`https://open.spotify.com/track/${id}`,durationMs:number(track.duration_ms),
  };
}
function batchTrack(track: SpotifyBatchTrack): DownloadTrack {
  return {id:track.id,title:track.name,artists:track.artists,album:track.album ?? "",albumArtist:track.artists.join(", "),
    trackNumber:0,trackTotal:0,discNumber:0,discTotal:0,releaseDate:track.releaseDate ?? "",isrc:"",upc:"",
    coverUrl:track.imageUrl ?? "",genre:"",composer:"",copyright:"",label:"",sourceUrl:`https://open.spotify.com/track/${track.id}`,durationMs:track.durationMs ?? 0};
}
function collection(title: string, kind: string, tracks: DownloadTrack[], coverUrl=""): DownloadCollection {
  const seen = new Set<string>();
  const unique = tracks.filter((track) => !seen.has(track.id) && !!seen.add(track.id));
  if (!unique.length) throw new SpotifyPathfinderError("No downloadable tracks found",404);
  if (unique.length > MAX_TRACKS) throw new SpotifyPathfinderError("This collection exceeds the 10,000-track limit. Select individual albums instead.",400);
  return {title,kind,tracks:unique,coverUrl:coverUrl || unique[0]?.coverUrl || ""};
}
export function spotifyPaginationPath(next: string, expectedPath: string): string {
  const url = new URL(next,"https://api.spotify.com");
  if (url.origin !== "https://api.spotify.com" || url.pathname !== expectedPath || url.username || url.password) {
    throw new SpotifyPathfinderError("Invalid Spotify pagination",502);
  }
  return url.pathname + url.search;
}

type CatalogGet = (path: string) => Promise<unknown>;
export async function expandDownloadAlbum(id: string, get: CatalogGet): Promise<DownloadCollection> {
  const album = object(await get(`/v1/albums/${id}`));
  const initial = object(album.tracks);
  const items = [...array(initial.items)];
  let next = text(initial.next);
  const pages = new Set<string>();
  while (next) {
    const path = spotifyPaginationPath(next,`/v1/albums/${id}/tracks`);
    if (pages.has(path) || items.length >= MAX_TRACKS) throw new SpotifyPathfinderError("Album pagination exceeds the supported limit",502);
    pages.add(path);
    const page = object(await get(path));
    items.push(...array(page.items)); next = text(page.next);
  }
  if (number(album.total_tracks)>items.length) throw new SpotifyPathfinderError("Could not load all album tracks",502);
  const completeAlbum = {...album,tracks:{items}};
  return collection(text(album.name),"album",items.map((item)=>parseDownloadTrack(item,completeAlbum)).filter((t):t is DownloadTrack=>!!t),cover(album.images));
}
export async function expandArtistDiscography(id: string, get: CatalogGet): Promise<DownloadCollection> {
  const artist = object(await get(`/v1/artists/${id}`));
  if (!text(artist.name)) throw new SpotifyPathfinderError("Could not load Spotify artist metadata",502);
  let received=0;
  let total=0;
  let path = `/v1/artists/${id}/albums?include_groups=album,single,compilation&limit=50`;
  const releases = new Set<string>();
  const pages = new Set<string>();
  while (path) {
    if (pages.has(path)) throw new SpotifyPathfinderError("Repeated Spotify release page",502);
    pages.add(path);
    const page = object(await get(path));
    received+=array(page.items).length;
    total=Math.max(total,number(page.total));
    if (total>MAX_RELEASES) throw new SpotifyPathfinderError("This artist has more than 250 releases. Select albums individually.",400);
    for (const item of array(page.items)) { const albumId=text(object(item).id); if (idValid(albumId)) releases.add(albumId); }
    if (releases.size > MAX_RELEASES) throw new SpotifyPathfinderError("This artist has more than 250 releases. Select albums individually.",400);
    const next = text(page.next);
    path = next ? spotifyPaginationPath(next,`/v1/artists/${id}/albums`) : "";
  }
  if (received<total) throw new SpotifyPathfinderError("Could not load the full discography",502);
  const tracks: DownloadTrack[] = [];
  const ids = [...releases];
  for (let offset=0;offset<ids.length;offset+=4) {
    const albums = await Promise.all(ids.slice(offset,offset+4).map((albumId)=>expandDownloadAlbum(albumId,get)));
    tracks.push(...albums.flatMap((album)=>album.tracks));
    if (tracks.length > MAX_TRACKS) throw new SpotifyPathfinderError("This discography exceeds 10,000 tracks. Select albums individually.",400);
  }
  return collection(text(artist.name),"artist",tracks,cover(artist.images));
}

export async function resolveDownloadCatalog(input: string, cookie?: string): Promise<DownloadCollection> {
  const parsed = parseDownloadInput(input.trim());
  const get: CatalogGet = (path)=>fetchSpotifyDownloadMetadata(path,cookie);
  const graph: GraphGet = (operation,variables)=>fetchSpotifyDownloadGraph(operation,variables,cookie);
  if (!parsed) {
    const found = await searchSpotifyCatalog(input.slice(0,100),cookie,{tracks:24,playlists:0,artists:0});
    return collection(`Results for “${input.slice(0,100)}”`,"search",found.tracks.map(batchTrack));
  }
  const {kind,id} = parsed;
  if (kind === "artist") {
    try { return await expandGraphDiscography(id,graph); }
    catch (error) {
      if (error instanceof SpotifyPathfinderError && error.status===400) throw error;
      return expandArtistDiscography(id,get);
    }
  }
  if (kind === "album") {
    try { return await expandGraphAlbum(id,graph); }
    catch (error) { if (error instanceof SpotifyPathfinderError && error.status===400) throw error; }
    try { return await expandDownloadAlbum(id,get); }
    catch {
      const album = await fetchSpotifyAlbumCatalog(id,cookie);
      if ((album.album.trackCount ?? 0) > album.tracks.length) throw new SpotifyPathfinderError("Could not load all album tracks. Please try again.",502);
      const tracks = album.tracks.map((t)=>({...batchTrack(t),trackTotal:album.tracks.length}));
      return collection(album.album.name,kind,tracks,album.album.imageUrl ?? "");
    }
  }
  if (kind === "track") {
    try {
      const raw=object(object(object(await graph("track",{uri:`spotify:track:${id}`})).data).trackUnion);
      const album=object(raw.albumOfTrack);
      const albumId=text(album.uri).replace(/^spotify:album:/,"");
      const detail=idValid(albumId) ? await expandGraphAlbum(albumId,graph) : null;
      const selected=detail?.tracks.find((track)=>track.id===id) ?? parseGraphDownloadTrack(raw,album,0,0);
      if(selected) {
        const [metadata,credits]=await Promise.all([
          fetchSpotifyTrackMetadata(id,cookie).catch(()=>null),
          graph("credits",{trackUri:`spotify:track:${id}`}).catch(()=>null),
        ]);
        if(metadata?.isrc) selected.isrc=metadata.isrc;
        selected.composer=parseDownloadComposer(credits);
        return collection(selected.title,kind,[selected]);
      }
    } catch { /* Retain Web API/spclient fallback during query changes. */ }
    try {
      const raw = object(await get(`/v1/tracks/${id}`));
      const albumId = text(object(raw.album).id);
      const album = idValid(albumId) ? await get(`/v1/albums/${albumId}`).catch(()=>raw.album) : raw.album;
      const track = parseDownloadTrack(raw,album);
      if (track) return collection(track.title,kind,[track]);
    } catch { /* Pathfinder supports public links when Web API is unavailable. */ }
    const track = await fetchSpotifyTrackMetadata(id,cookie);
    if (!track) throw new SpotifyPathfinderError("Could not load this Spotify track",502);
    const fallback = batchTrack({id,name:track.title,artists:[track.artist],album:track.album,imageUrl:track.imageUrl});
    fallback.isrc=track.isrc;
    return collection(fallback.title,kind,[fallback]);
  }
  if (kind === "collection") {
    if (!cookie) throw new SpotifyPathfinderError("Spotify account connection is required for Liked Songs",400);
    const liked=await fetchSpotifyLikedTracks(cookie,MAX_TRACKS+1);
    return collection(liked.title,"playlist",liked.tracks.map(batchTrack));
  }
  let offset=0;
  let title: string;
  let image: string;
  let owner: string;
  const tracks: DownloadTrack[]=[];
  const seenOffsets=new Set<number>();
  for (;;) {
    if (seenOffsets.has(offset)) throw new SpotifyPathfinderError("Repeated Spotify playlist page",502);
    seenOffsets.add(offset);
    const page=await fetchSpotifyPlaylistCatalogPage(id,cookie,offset,100);
    if (page.totalCount>MAX_TRACKS) throw new SpotifyPathfinderError("This playlist exceeds 10,000 tracks",400);
    title=page.playlist.name; image=page.playlist.imageUrl ?? ""; owner=page.playlist.ownerName ?? "";
    tracks.push(...page.tracks.map(batchTrack));
    if (page.nextOffset == null) break;
    offset=page.nextOffset;
  }
  return {...collection(title,kind,tracks,image), owner};
}

type GraphGet = (operation: "artist" | "discography" | "album" | "track" | "credits", variables: Record<string, unknown>) => Promise<unknown>;
const graphNames = (value: unknown): string[] => array(object(value).items).map((item)=>text(object(object(item).profile).name) || text(object(item).name)).filter(Boolean);
function graphCover(value: unknown): string {
  const sources=array(object(value).sources).map(object).sort((a,b)=>number(b.width)-number(a.width));
  return text(sources[0]?.url);
}
export function parseGraphDownloadTrack(value: unknown, album: Record<string,unknown>, total: number, discTotal: number): DownloadTrack | null {
  const track=object(value);
  const id=text(track.uri).replace(/^spotify:track:/,"");
  const artistNames=graphNames(track.artists);
  const albumArtists=graphNames(album.artists);
  const data={id,name:track.name,artists:artistNames.map((name)=>({name})),track_number:track.trackNumber,
    disc_number:track.discNumber,duration_ms:object(track.duration).totalMilliseconds,
    external_ids:{isrc:text(object(track.externalIds).isrc)}};
  const result=parseDownloadTrack(data,{name:album.name,album_type:album.type,artists:albumArtists.map((name)=>({name})),total_tracks:total,
    images:[{url:graphCover(album.coverArt)}],release_date:text(object(album.date).isoString).slice(0,10),
    label:album.label,copyrights:array(object(album.copyright).items),external_ids:{upc:object(album.externalIds).upc}});
  if(result) result.discTotal=discTotal;
  return result;
}

export function parseDownloadComposer(payload: unknown): string {
  const track=object(object(object(payload).data).trackUnion);
  const credits=array(object(object(track.creditsTrait).contributors).items).map(object);
  const composers=credits.filter((credit)=>text(credit.role)==="Composer");
  const writers=composers.length ? composers : credits.filter((credit)=>text(credit.role)==="Writer");
  return [...new Set(writers.map((credit)=>text(credit.name)).filter(Boolean))].join("; ");
}

export async function expandGraphAlbum(id: string, query: GraphGet): Promise<DownloadCollection> {
  let first: Record<string,unknown> | undefined;
  const items: unknown[]=[];
  const pages=new Set<string>();
  let offset=0;
  let total: number;
  do {
    const response=object(await query("album",{uri:`spotify:album:${id}`,locale:"",offset,limit:100}));
    const album=object(object(response.data).albumUnion);
    const group=object(album.tracksV2 ?? album.tracks);
    const page=array(group.items);
    if (!text(album.name) || !Number.isFinite(group.totalCount)) throw new SpotifyPathfinderError("Spotify returned incomplete album metadata",502);
    first ??=album;
    total=number(group.totalCount);
    if(total>MAX_TRACKS) throw new SpotifyPathfinderError("This album exceeds 10,000 tracks",400);
    if(!page.length && offset<total) throw new SpotifyPathfinderError("Could not load all album tracks",502);
    const fingerprint=JSON.stringify(page);
    if(pages.has(fingerprint)) throw new SpotifyPathfinderError("Repeated Spotify album page",502);
    pages.add(fingerprint);
    items.push(...page); offset+=page.length;
    if(items.length>MAX_TRACKS) throw new SpotifyPathfinderError("This album exceeds 10,000 tracks",400);
  } while(offset<total);
  const rows=items.map((item)=>object(object(item).track ?? item));
  const discs=Math.max(0,...rows.map((row)=>number(row.discNumber)));
  const tracks=rows.map((row)=>parseGraphDownloadTrack(row,first ?? {},total,discs)).filter((track):track is DownloadTrack=>!!track);
  if(tracks.length!==rows.length) throw new SpotifyPathfinderError("Some album tracks have incomplete metadata. Please try again.",502);
  return collection(text(first?.name),"album",tracks,graphCover(first?.coverArt));
}

export async function expandGraphDiscography(id: string, query: GraphGet): Promise<DownloadCollection> {
  const overview=object(object(object(await query("artist",{uri:`spotify:artist:${id}`,locale:""})).data).artistUnion);
  const title=text(object(overview.profile).name);
  if(!title) throw new SpotifyPathfinderError("Could not load Spotify artist metadata",502);
  const releases=new Set<string>();
  const pages=new Set<string>();
  let offset=0;
  let total: number;
  do {
    const response=object(await query("discography",{uri:`spotify:artist:${id}`,offset,limit:50,order:"DATE_DESC"}));
    const root=object(object(object(object(response.data).artistUnion).discography).all);
    if(!Number.isFinite(root.totalCount)) throw new SpotifyPathfinderError("Spotify returned incomplete discography metadata",502);
    total=number(root.totalCount);
    if(total>MAX_RELEASES) throw new SpotifyPathfinderError("This artist has more than 250 releases. Select albums individually.",400);
    const groups=array(root.items);
    const fingerprint=JSON.stringify(groups);
    if(pages.has(fingerprint)) throw new SpotifyPathfinderError("Repeated Spotify discography page",502);
    pages.add(fingerprint);
    if(!groups.length && offset<total) throw new SpotifyPathfinderError("Could not load the full discography",502);
    for(const group of groups) {
      // Each group can contain equivalent territorial editions. Spotify's first
      // release is the preferred edition, matching the desktop SpotiFLAC list.
      const release=object(array(object(object(group).releases).items)[0]);
      const albumId=text(release.id) || text(release.uri).replace(/^spotify:album:/,"");
      if(!idValid(albumId)) throw new SpotifyPathfinderError("Could not read a release in this discography",502);
      releases.add(albumId);
    }
    offset+=groups.length;
    if(offset>MAX_RELEASES) throw new SpotifyPathfinderError("This artist has more than 250 releases. Select albums individually.",400);
  } while(offset<total);
  const tracks: DownloadTrack[]=[];
  const ids=[...releases];
  for(let offset=0;offset<ids.length;offset+=4) {
    const albums=await Promise.all(ids.slice(offset,offset+4).map((album)=>expandGraphAlbum(album,query)));
    tracks.push(...albums.flatMap((album)=>album.tracks));
    if(tracks.length>MAX_TRACKS) throw new SpotifyPathfinderError("This discography exceeds 10,000 tracks. Select albums individually.",400);
  }
  return collection(title,"artist",tracks,graphCover(object(overview.visuals).avatarImage));
}
