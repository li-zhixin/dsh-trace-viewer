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

The viewer reads released DSH session formats through v3. It understands embedded assistant streams, system-prompt and request-header updates, correlated retries and commands, compaction, structured context, turn usage/timing, and PTC sub-calls.

It reuses `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-llm`, the published UI primitives and the UI Conversation prompt contracts. Timeline virtualization uses `@tanstack/react-virtual`, and prompt diffs use `diff`. Chat and Trajectory projections stay local so the app remains a static client-only viewer with no Cordis runtime or backend bindings.
