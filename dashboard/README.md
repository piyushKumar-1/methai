# methai dashboard

Edit, publish and serve assistant configs (`MethaiConfig`). Apps load theirs at start-up with
`methai.init(url)`, keep the last good copy, and reuse it when the server answers 304.

```sh
node dashboard/server.mjs          # http://localhost:8790 (Node 22.18+)
METHAI_DASHBOARD_TOKEN=… node dashboard/server.mjs   # writes need "Authorization: Bearer …"
```

- **UI** (`/`): one page per app — voice (phone + chat model, Deepgram, ElevenLabs, OpenAI
  Realtime), behaviour (greetings by language, interruptions, timings, prompt), safety (controls that
  need a yes, with a label tester), app context (screens, flows), raw JSON, and history with
  rollback. Publishing validates with the library's own validator.
- **The file apps fetch:** `GET /apps/<app>/methai.json`, with a content-based `ETag` and
  `Last-Modified`; `If-None-Match` with the current ETag gets `304 Not Modified`.
- **API:** `GET/POST /api/apps`, `GET/PUT /api/apps/<app>`, `GET /api/apps/<app>/revisions[/<n>]`,
  `POST /api/apps/<app>/rollback {revision}`, `POST /api/validate {config}`.
- **Data:** `METHAI_DATA_DIR` or `dashboard/data/` — a folder per app, a JSON file per revision.
