# A personal shot archive

The dial-in website keeps its beginner shot history for the current session.
It is not a multi-user shot archive. For longer-term graph storage,
[Visualizer](https://github.com/miharekar/visualizer) is the closest existing
match to Decaid's uploader.

## What the local study proved

On 2026-10-11, Visualizer commit
`648237eba00ed7058b7569a6ca4fb2ac8078ce59` built and ran in disposable local
containers. A synthetic shot generated with Decaid's actual converter uploaded
through its multipart API. Database readback preserved five samples, pressure,
flow, temperatures, dose/yield and stage boundaries; server-side chart data and
two background jobs also worked. The study containers and synthetic volumes
were removed afterwards. No personal shots or hosted accounts were used.

This validates ingestion and graph preparation, not browser rendering, photos,
production security, backup recovery or physical device uploads.

## What a real instance needs

- Ruby 4.0.7, Rails 8.1.4 and PostgreSQL 18, matching the pinned dependencies.
  The app has a Dockerfile and Kamal deployment; a personal instance needs its
  own configuration. [Deployment source](https://github.com/miharekar/visualizer/blob/648237eba00ed7058b7569a6ca4fb2ac8078ce59/config/deploy.yml)
- Web and background-job processes, fresh secrets, your own origin/TLS settings,
  and backups for the database and attachments. The current development and
  production configurations select R2 storage; a one-node instance must
  explicitly switch attachments to local disk or use its own object store.
  [Storage configuration](https://github.com/miharekar/visualizer/blob/648237eba00ed7058b7569a6ca4fb2ac8078ce59/config/storage.yml)
- An access gate such as a private LAN/VPN. The local study confirmed that an
  unauthenticated request could read the graph and notes of a synthetic shot
  with `public: false` when its UUID was known. Treat this flag as unlisted,
  rather than per-shot access control.
  [Shot API](https://github.com/miharekar/visualizer/blob/648237eba00ed7058b7569a6ca4fb2ac8078ce59/app/controllers/api/shots_controller.rb)
- Separate consideration of Highcharts' licence. The app is MIT licensed;
  that licence does not grant rights to all dependencies.
  [App licence](https://github.com/miharekar/visualizer/blob/648237eba00ed7058b7569a6ca4fb2ac8078ce59/LICENSE),
  [Highcharts terms](https://shop.highcharts.com/license-eula).

## The Decaid integration gap

The inspected bundled Visualizer plugin hardcodes the hosted API, share and
profile URLs. A future host/plugin change should expose one normalized server
base URL and derive those URLs from it. Credentials and remote-shot mapping
must be isolated by server; changing a server must not silently forward the
old server's credentials. Streamline delegates uploads to this plugin, so
changing only a skin link is insufficient.

Use Decaid's existing converter: raw Decaid shot JSON is not the supported
Decent JSON upload format.
[Visualizer parser](https://github.com/miharekar/visualizer/blob/648237eba00ed7058b7569a6ca4fb2ac8078ce59/app/models/parsers/decent_json.rb)

Beanconqueror is a local mobile journal and supports custom Visualizer URLs.
Gaggiuino Local Profiler has standalone hosting but targets Gaggiuino/GaggiMate;
its export support does not establish a Decaid import path.
[Beanconqueror](https://github.com/graphefruit/Beanconqueror),
[Local Profiler](https://github.com/mxkissnr/gaggiuino-local-profiler).
