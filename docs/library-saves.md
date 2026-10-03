# Discovery playback, downloads, and likes

Discovery playback and permanent library saves use separate paths. A playable
preview does not by itself mean a file is saved in the library.

## Preparing a permanent file

`POST /api/discover/stage` accepts a catalog track and its metadata. A playback
request with `preview: true` uses YouTube directly. A library request first
tries the configured SpotiFLAC providers. If resolution or downloading fails,
the Worker asks the private media server to download YouTube audio with yt-dlp
and marks the staged file as `libraryFallback`.

The media server searches by title, artist, and duration when only a Spotify
track ID is available. An exact YouTube track uses its video ID. Ordinary preview
files are refreshed for fallback saves so the current Premium session and
format selection can improve their quality.

`POST /api/discover/promote` moves the staged audio and artwork from `.discover`
into the library and rescans it. An ordinary preview returns
`409 preview_not_lossless` so clients prepare a permanent copy first; an expired
or missing preview returns 404. The web and native keep helpers handle both
responses by staging once and retrying promotion. Approved YouTube fallbacks
and direct YouTube tracks can be promoted in their original format.

Playlist entries must reference a promoted library file. The playlist API
rejects `.discover` URLs because that cache is temporary and can be pruned.

## YouTube quality and credentials

The server's selector is `774/141/bestaudio`: prefer Premium Opus, then Premium
AAC, then the best available audio. The authenticated request uses the YouTube
Music client; the ordinary web client can omit audio-only formats even with a
valid Premium session. Audio is extracted without a lossy re-encode and keeps
its original extension. Converting it to FLAC would not recover lost detail.

YouTube Music lists its High setting as 256 kbps AAC or Opus; a variable-rate
file's measured average can differ. See the
[official audio-quality guide](https://support.google.com/youtubemusic/answer/9076559).

Configure `YOUTUBE_COOKIES_FILE`, or use the server account's default
`~/.config/spotify/youtube-cookies.txt`. Keep that file private and outside Git.
The server also needs yt-dlp, ffmpeg, and a supported JavaScript runtime such as
Deno on its subprocess PATH. If authenticated extraction fails, the downloader
retries anonymously. A Premium subscription alone does not guarantee every
extraction yields a Premium format; inspect the saved file when verifying quality.

## Durable likes

The web heart stays pending while the permanent copy is prepared and its like
is saved. Optimistic state follows the replacement song ID. A failed save rolls
back and shows a visible error.

If both audio sources are unavailable, the web client saves catalog metadata
through `/api/likes`. The private server stores it in `catalog-likes.json` beside
the library cache, separately from physical-file likes. These entries survive
rescans and restarts and recreate a preview when played. A later successful
file like replaces the matching metadata entry.

Relevant code is in `src/worker/discover-stage.ts`, `src/server/local-discover.ts`,
`src/server/youtube-preview.ts`, `src/server/catalog-likes.ts`, and the web/native
`discover-keep.ts` helpers. Regression coverage includes provider failures,
promotion, metadata persistence, server restart, and heart-state transitions.
