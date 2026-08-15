# DSH Trace Viewer

Browser viewer for DeepSeek Harness `session.jsonl` traces. Drop a file or choose one locally; nothing is uploaded.

Live demo: https://dsh-trace.lizhixin.top/

## Development

```bash
npm install
npm run dev
```

Build and preview the static site:

```bash
npm run build
npm run preview
```

## Cloudflare Pages

- Build command: `npm run build`
- Output directory: `dist`

The viewer uses `@deepseek-ai/dsh-session` and follows DSH Web's Chat and Trajectory renderer structure. It is a static client-only app with no backend or bindings.
