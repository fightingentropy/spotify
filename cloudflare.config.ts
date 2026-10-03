// D1 migrations live in db/d1-migrations; local state remains managed by Wrangler.
import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "spotify",
    compatibilityDate: "2026-07-09",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    entrypoint: "src/worker/index.ts",
    workersDev: true,
    observability: {
      enabled: true,
      logs: {
        enabled: true,
        headSamplingRate: 1,
      },
      traces: {
        enabled: true,
        headSamplingRate: 0.01,
      },
    },
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: true,
    },
    triggers: [
      triggers.fetch({
        pattern: "music.streamarena.xyz/api/playback-state*",
        zone: "streamarena.xyz",
      }),
      triggers.scheduled({
        schedule: "*/15 * * * *",
      }),
    ],
    env: {
      PLAYLISTS_EDITABLE: bindings.text("1"),
      AUTH_TRUST_HOST: bindings.text("true"),
      EMAIL_FROM: bindings.text("noreply@streamarena.xyz"),
      APP_ORIGIN: bindings.text("https://music.streamarena.xyz"),
      MAC_MINI_ORIGIN: bindings.text("https://music.streamarena.xyz"),
      SPOTIFLAC_PROVIDER_ORDER: bindings.text(
        "tidal-qobuz-amazon-deezer-apple",
      ),
      SPOTIFLAC_TIDAL_APIS: bindings.text("https://tdl-oss.spotbye.qzz.io"),
      SPOTIFLAC_ACTIVE_TIDAL_API: bindings.text(
        "https://tdl-oss.spotbye.qzz.io",
      ),
      DB: bindings.d1({
        name: "spotify-db",
        id: "88a7aea6-ab87-43e9-a728-bca750986ccc",
      }),
      MEDIA: bindings.r2({
        name: "spotify-media",
      }),
      EMAIL: bindings.sendEmail({}),
      IMAGES: bindings.images({}),
      ASSETS: bindings.assets(),
    },
  },
});
