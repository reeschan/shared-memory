# shared-memory

[日本語](README.md) | **English**

A local RAG that gives several AI agents (Claude Code / Codex / Kimi) and you a shared knowledge base, running entirely on your own PC. Markdown files are the single source of truth; OpenSearch is a derived index that can be rebuilt at any time.

<a href="docs/architecture/architecture-light.svg"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture/architecture-dark.svg">
  <img src="docs/architecture/architecture-light.svg" width="100%" alt="Architecture of shared-memory. From the top: Claude Code, Codex and Kimi Code send search / get / write to the MCP server on 127.0.0.1. The MCP server and the CLI share packages/core, and scheduled jobs (Task Scheduler / launchd / systemd) start the CLI's decay daily and gc weekly. On Windows, the weekly SharedMemory-Eval task runs sm eval (evaluation including the rescore guard) and sm feedback, and a toast tells the user the guard result and the URL of the feedback screen. The user opens the MCP server's /feedback screen in a browser and submits the weekly judgments. The apps read and write the data (Markdown as the single source of truth, OpenSearch + Sudachi as the derived index holding the embedding fingerprint in _meta, SQLite for access statistics and search logs, and the evaluation directory eval.dir for the evaluation set, history, sessions and reports) and call local models (Ollama for embeddings by default, an optional TEI reranker). Text is sent to an external OpenAI-compatible embedding or rerank API only when the configuration says so explicitly. The developer reviews the Markdown diff, commits it and pushes it to GitHub. When the server runs on a single PC, publish-code.mjs on a client PC sends changed code over SSH to a drop folder, and the SharedMemory-Deploy task (deploy-code.ps1) on the server PC applies it and restarts the MCP server.">
</picture></a>

Click the diagram to open it at full size. SVG: [light](docs/architecture/architecture-light.svg) / [dark](docs/architecture/architecture-dark.svg)

For the design details, see:

- [Design document](docs/design/design.md) (Japanese)
- [Implementation contracts (interfaces between modules)](docs/design/interfaces.md) (Japanese)

## Layout

- The knowledge itself (Markdown) is the source of truth. It does not live in this repository but under the folder that `memories_dir` in `config.local.yaml` points to (a synced folder or a private repository), as `<scope>/<id>.md`
- `state/stats.sqlite` holds access statistics (access count, last access date, tier). It is local to each PC and not tracked by Git
- `config.local.yaml` holds per-PC settings (not tracked by Git). See `config.local.example.yaml` for an example
- `opensearch/` contains the Dockerfile for OpenSearch + Sudachi, the index template and the Search Pipeline
- `packages/core` holds shared logic: front matter validation, chunking, embedding and rerank clients, search, and so on
- `packages/indexer` is the CLI (`pnpm sm <command>`)
- `packages/mcp-server` is the MCP server (search / get / write)
- `skills/` contains Skills for agents (`knowledge-import`, `mcp-setup`). Outside Windows, set `SHARED_MEMORY_ROOT` to the absolute path of the repository before using either
- `scripts/` contains scripts that start the MCP server, register tasks and deploy code (`publish-code.mjs` / `deploy-code.ps1`)
- `config.yaml` holds settings for embeddings, reranking, weights, half-life and so on
- `.cache/` is the embedding cache (not tracked by Git)

Data flow: agent → MCP server → Markdown / SQLite / OpenSearch. By default, embeddings come from a local Ollama (Qwen3-Embedding-0.6B, 1024 dimensions). Both the embedding model and the reranker can be swapped through configuration (see "Switching the embedding model" and "Reranking").

### How indexing and search work

How embeddings, OpenSearch and reranking fit together. Green lines are indexing, orange lines are search, and dashed lines are taken only when reranking is enabled.

- Indexing:
  1. Compare the embedding fingerprint in the index `_meta` with the fingerprint of the current configuration. If they differ, stop and suggest `pnpm sm reindex`.
  2. Split the Markdown into chunks by heading and keep only the chunks whose `content_hash` changed.
  3. Embed only the chunks missing from the embedding cache (`.cache/embeddings/<fingerprint>/`), with `document.prefix` prepended.
  4. Put the text into the BM25 field and the vector into the `knn_vector` field of the same document.
- Search:
  1. Embed the query with `query.prefix` prepended, and send kNN and BM25 (Sudachi) as a single hybrid query.
  2. The Search Pipeline min_max-normalizes both scores and combines them as BM25 0.4 : kNN 0.6 (the primary score).
  3. The MCP server groups the top 50 chunks by `memory_id`. The representative is the chunk with the highest primary score.
  4. If reranking is enabled, the top 20 by primary score are reordered by the reranker and that order is used as is. If it is disabled or fails, the rescore order is used (time decay with a floor of 0.7, an access count weight of 0.2 and a provenance factor).
  5. Return the id, title and excerpt of the top 8 (`limit`).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture/data-flow-dark.svg">
  <img src="docs/architecture/data-flow-light.svg" alt="Indexing and search flow (top to bottom). Indexing compares the embedding fingerprint in the index _meta with the configuration, chunks the Markdown, embeds only the chunks whose content_hash changed and that are missing from the per-fingerprint cache, with document.prefix (embedding.provider: Ollama by default, or an OpenAI-compatible API), and puts the document vectors into OpenSearch's knn_vector field and the text into the BM25 field analyzed by Sudachi. Search embeds the query with query.prefix, runs kNN with the query vector and BM25 with the query terms; the Search Pipeline min_max-normalizes and combines them as BM25 0.4 and kNN 0.6 into the primary score, which the MCP server groups by memory_id. If reranking is enabled, the top 20 by primary score are reordered; otherwise, or on failure, they are ordered by rescore, and the top 8 are returned." width="560">
</picture>

The diagram sources are `docs/architecture/architecture.d2` (overview) and `docs/architecture/data-flow.d2` (flow). When the layout changes, edit them and regenerate `<name>-light.svg` / `<name>-dark.svg` with `python ~/.claude/skills/arch-diagram/versions/v1.1/scripts/render.py docs/architecture/<name>.d2`.

## Prerequisites

Install the following for your OS.

| Item | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Docker | Docker Desktop (WSL2 backend) | Docker Desktop / OrbStack / colima | Docker Engine |
| Ollama | Install directly with the installer | Install the app | Follow the official instructions |
| Node 26 | fnm or mise | fnm or mise | fnm or mise |
| pnpm | `npm i -g pnpm@12` | `npm i -g pnpm@12` | `npm i -g pnpm@12` |

- Node 26 is needed to run TypeScript directly through type stripping, without a build step.
- Ollama and Docker are needed on the PC that runs the MCP server. A client PC in the setup described below does not need them.
- `vm.max_map_count` is optional; set it only if OpenSearch fails to start or warns about it. On Linux, run `sudo sysctl -w vm.max_map_count=262144` and persist it under `/etc/sysctl.d/`. With Docker Desktop, colima or OrbStack, set the same value inside their VM (for example `wsl -d docker-desktop sysctl -w vm.max_map_count=262144` or `colima ssh -- sudo sysctl -w vm.max_map_count=262144`). As long as you run a single node, the pre-start check does not stop on it.

## Setup

Use PowerShell on Windows and bash on macOS / Linux. `__ROOT__` is the absolute path of the repository.

```powershell
git clone <URL of this repository> shared-memory
cd shared-memory
pnpm install
Copy-Item config.local.example.yaml config.local.yaml   # point memories_dir at where your knowledge lives
ollama pull qwen3-embedding:0.6b
docker compose up -d --build
pnpm sm reindex
scripts/start-mcp.ps1
skills/mcp-setup/register.ps1
```

```bash
git clone <URL of this repository> shared-memory
cd shared-memory
pnpm install
cp config.local.example.yaml config.local.yaml   # point memories_dir at where your knowledge lives
ollama pull qwen3-embedding:0.6b
docker compose up -d --build
pnpm sm reindex
pnpm mcp        # to keep it running, start it from launchd / systemd as described below
```

1. Clone the repository.
2. Install dependencies with `pnpm install`, create `config.local.yaml`, and set `memories_dir` to where your knowledge lives (the last folder name is `memories`). See `config.local.example.yaml` for Mac / Linux path examples.
3. Pull the default embedding model from `config.yaml` with `ollama pull qwen3-embedding:0.6b`.
4. Start OpenSearch (with Sudachi) with `docker compose up -d --build`.
5. Index everything from the Markdown with `pnpm sm reindex`.
6. Start the MCP server: `scripts/start-mcp.ps1` on Windows, `pnpm mcp` or the services below on macOS / Linux.
7. Register the endpoint with your agents: `skills/mcp-setup/register.ps1` on Windows, and on macOS / Linux follow the non-Windows steps in `skills/mcp-setup/SKILL.md` (`SHARED_MEMORY_ROOT` is required).

The MCP endpoint is `http://127.0.0.1:7820/mcp`.

### Running as a service and scheduled jobs

On Windows, register the jobs in Task Scheduler with `scripts/register-tasks.ps1` (`-WhatIf` to preview, `-Unregister` to remove). It registers four tasks: starting the MCP server, `decay` (daily at 09:00), `gc` (Sundays at 09:30), and evaluation and feedback (`eval --notify` then `feedback --notify`, Sundays at 10:00).

On macOS use launchd, and on Linux use systemd user units. For `__NODE__`, write the real path printed by `realpath "$(command -v node)"`. With fnm, `which node` points to a temporary directory (`fnm_multishells/...`) that disappears on reboot, so do not use it. Shims from fnm or mise do not work from launchd / systemd either. Create the log folder first (`mkdir -p __ROOT__/.cache/logs`).

#### macOS (launchd)

`~/Library/LaunchAgents/com.shared-memory.mcp.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.shared-memory.mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>__NODE__</string>
    <string>__ROOT__/packages/mcp-server/src/server.ts</string>
  </array>
  <key>WorkingDirectory</key><string>__ROOT__</string>
  <key>EnvironmentVariables</key>
  <dict><key>SHARED_MEMORY_ROOT</key><string>__ROOT__</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>__ROOT__/.cache/logs/mcp.log</string>
  <key>StandardErrorPath</key><string>__ROOT__/.cache/logs/mcp.log</string>
</dict>
</plist>
```

`~/Library/LaunchAgents/com.shared-memory.decay.plist` (daily at 09:00):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.shared-memory.decay</string>
  <key>ProgramArguments</key>
  <array>
    <string>__NODE__</string>
    <string>__ROOT__/packages/indexer/src/cli.ts</string>
    <string>decay</string>
  </array>
  <key>WorkingDirectory</key><string>__ROOT__</string>
  <key>EnvironmentVariables</key>
  <dict><key>SHARED_MEMORY_ROOT</key><string>__ROOT__</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>__ROOT__/.cache/logs/decay.log</string>
  <key>StandardErrorPath</key><string>__ROOT__/.cache/logs/decay.log</string>
</dict>
</plist>
```

For `gc`, use the same plist (`com.shared-memory.gc.plist`) with `Label` set to `com.shared-memory.gc`, the last `ProgramArguments` entry set to `gc`, `StartCalendarInterval` set to `<dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>`, and the log set to `.cache/logs/gc.log`.

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.shared-memory.mcp.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.shared-memory.decay.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.shared-memory.gc.plist
launchctl bootout gui/$(id -u)/com.shared-memory.mcp   # to stop it
```

#### Linux (systemd --user)

`~/.config/systemd/user/shared-memory-mcp.service`:

```ini
[Unit]
Description=shared-memory MCP server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=__ROOT__
Environment=SHARED_MEMORY_ROOT=__ROOT__
ExecStart=__NODE__ __ROOT__/packages/mcp-server/src/server.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/shared-memory-decay.service` and `shared-memory-decay.timer` (daily at 09:00):

```ini
[Unit]
Description=shared-memory decay

[Service]
Type=oneshot
WorkingDirectory=__ROOT__
Environment=SHARED_MEMORY_ROOT=__ROOT__
ExecStart=__NODE__ __ROOT__/packages/indexer/src/cli.ts decay
```

```ini
[Unit]
Description=shared-memory decay (daily)

[Timer]
OnCalendar=*-*-* 09:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

For `gc`, use the same units with the last word of `ExecStart` in `shared-memory-gc.service` set to `gc` and `OnCalendar` in `shared-memory-gc.timer` set to `Sun *-*-* 09:30:00`.

```bash
systemctl --user daemon-reload
systemctl --user enable --now shared-memory-mcp.service
systemctl --user enable --now shared-memory-decay.timer shared-memory-gc.timer
loginctl enable-linger "$USER"   # keep running while you are logged out
```

Without `loginctl enable-linger`, the units stop when you log out. Follow the logs with `journalctl --user -u shared-memory-mcp -f`.

## Switching the embedding model

With no configuration, the default in `config.yaml` calls Ollama's Qwen3-Embedding-0.6B (1024 dimensions) locally. To use a different model or server, put overrides under `embedding` in `config.local.yaml`. No code changes are needed.

| Key | Meaning |
| --- | --- |
| `provider` | `ollama` (default) or `openai`. `ollama` calls `<url>/api/embed`; `openai` calls the OpenAI-compatible `<url>/embeddings` |
| `url` | Server URL, without `/api/embed` or `/embeddings` |
| `model` | Model name |
| `dimension` | Vector dimension. An error is raised if the server returns a different dimension |
| `batch_size` | Number of texts per request. Set it to `1` for APIs such as Sarashina that accept only one at a time |
| `normalize` | Whether to L2-normalize (default `true`). The client normalizes even for models that do not |
| `revision` | Bump this when you switch to a different model under the same name (default `0`) |
| `rpm` | Maximum requests per minute. When omitted, requests are not spaced out |
| `api_key_env` | Name of the environment variable holding the API key. Never write the value itself |
| `extra_body` | Extra fields added to each request |
| `query` | `prefix` (query prefix) and `params` (fields added only for queries) |
| `document` | `prefix` (document prefix) and `params` (fields added only for documents) |

- Use `provider: openai` for OpenAI-compatible servers (LM Studio, vLLM, llama.cpp, TEI and so on) and for OpenAI's embedding API.
- Do not put API keys in configuration files. Write only the variable name in `api_key_env` and provide the value through `.env` at the repository root or an environment variable. `.env` does not override variables that are already set. If the name is set but the value is missing, startup fails.
- Changing the settings changes the embedding fingerprint (an identifier built from `provider`, `model`, `dimension`, `normalize`, `revision`, `query`, `document` and `extra_body`). If it differs from the index `_meta`, `index` stops and suggests `pnpm sm reindex`. Search and MCP startup only warn and continue.
- When you switch to a different model under the same name, bump `revision`. Even with the same dimension, the fingerprint changes and the model is treated as a different one.
- `url` is not part of the fingerprint. If the URL changes because you go through an SSH tunnel, the same model needs no rebuild.
- The old key `embedding.query_instruction` is read as `query.prefix` when the same file has no `embedding.query.prefix`. This translation happens per file before the files are merged, so an old key in `config.local.yaml` takes precedence over `query.prefix` in `config.yaml`. Use `embedding.query.prefix` for new settings.
- For both embeddings and reranking, text is sent to an external API only when you explicitly configure that provider and URL. The default Ollama is local and sends nothing out.

The current Ollama default (same as writing nothing):

```yaml
embedding:
  provider: ollama
  url: http://127.0.0.1:11434
  model: qwen3-embedding:0.6b
  dimension: 1024
  batch_size: 16
  normalize: true
  query:
    prefix: "Instruct: Given a question or keywords, retrieve memory notes that answer or relate to it\nQuery: "
```

An OpenAI-compatible server such as LM Studio:

```yaml
embedding:
  provider: openai
  url: http://127.0.0.1:1234/v1
  model: text-embedding-nomic-embed-text-v1.5
  dimension: 768
```

Sarashina (one text per request, task type passed via `params`):

```yaml
embedding:
  provider: openai
  url: https://api.sarashina.ai/v1
  model: sarashina3-embedding
  dimension: 1536
  batch_size: 1
  rpm: 60
  api_key_env: SARASHINA_API_KEY
  query:
    params:
      task_type: RETRIEVAL_QUERY
  document:
    params:
      task_type: RETRIEVAL_DOCUMENT
```

## Reranking

Disabled by default (`rerank.enabled: false`). When enabled, the top `candidates` memories by primary score are passed to the reranker and reordered. `score` stays the post-rescore score as before, and the reranker's score goes into `rerank_score`.

| `flavor` | Supported servers | Default path |
| --- | --- | --- |
| `cohere` | Cohere, Jina, Infinity, vLLM, llama.cpp (cohere style) | `/v1/rerank` |
| `voyage` | Voyage | `/v1/rerank` |
| `tei` | Hugging Face TEI | `/rerank` |
| `sarashina` | Sarashina | `/rerank` |

| Key | Meaning |
| --- | --- |
| `enabled` | Whether to rerank (default `false`) |
| `flavor` | One of the four above (default `cohere`) |
| `url` | Server URL |
| `model` | Model name (required when `enabled: true`) |
| `path` | Path override (defaults to the flavor's path) |
| `api_key_env` | Name of the environment variable for the API key. Put the value in `.env` or the environment |
| `candidates` | Number of candidates to rerank (default 20), taken from the top by primary score |
| `max_docs_per_request` | Documents per request (`0` means the flavor's default: 32 for TEI, 20 for Sarashina) |
| `doc_max_chars` | Length at which each document is truncated (default 2000) |
| `timeout_ms` | Timeout (default 3000) |
| `extra_body` | Extra fields added to each request |

- Candidates are chosen by the primary score before rescore. Reranked candidates are sorted by their score in descending order, the remaining memories follow in descending primary score, and the list is cut at `limit`.
- Scores have different ranges across APIs, so only the order is used. The meaning of `score` does not change.
- Expect about 1 second of latency with an external API (20 candidates). A local TEI is often faster, but on CPU the time grows with the number of candidates and the length of the text.
- On timeout, 429, 5xx or a malformed response, the order without reranking (rescore order) is returned and `rerank failed: ...` is logged. A misbehaving reranker never stops search.
- Text is sent to an external API only when you explicitly set `enabled: true` and `url`. In Sarashina's free beta, what you send may be used to improve their models and services. Think about whether candidate text may leave your PC before enabling it.

Example with a local TEI:

```yaml
rerank:
  enabled: true
  flavor: tei
  url: http://127.0.0.1:8081
  model: BAAI/bge-reranker-v2-m3
```

Start TEI with `docker compose --profile rerank up -d` (this starts `opensearch` and `reranker`). The first start takes a while to pull the image and the model. The model is cached in `./.cache/tei`.

Example with Sarashina:

```yaml
rerank:
  enabled: true
  flavor: sarashina
  url: https://api.sarashina.ai/v1
  model: sarashina3-rerank
  api_key_env: SARASHINA_API_KEY
  extra_body:
    task_type: GENERAL_RETRIEVAL
```

## Running the server on a single PC

You can run OpenSearch, Ollama and the MCP server on one machine (the server PC) and let agents on other PCs (client PCs) use it through SSH port forwarding. The MCP server binds only to loopback via `mcp.host` and also checks the `Host` header, so do not expose it on the LAN. Instead, forward `127.0.0.1:7820` on the client PC to `127.0.0.1:7820` on the server PC, keeping the same port number. Agents on the client PC can keep `http://127.0.0.1:7820/mcp` as their endpoint.

The server-PC setup, its automatic code deployment (`publish-code.mjs` and `deploy-code.ps1`) and task registration on the server PC (`register-tasks.ps1`) are Windows-only. macOS / Linux are supported only as clients.

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -L 127.0.0.1:7820:127.0.0.1:7820 <user>@<server PC>
```

Keep the tunnel running with launchd / systemd on the client PC. launchd / systemd cannot prompt for a password, so set up key-based login to the server PC.

On macOS, `~/Library/LaunchAgents/com.shared-memory.tunnel.plist` (replace `__USER__@__SERVER__` with your user name and the server PC's name):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.shared-memory.tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/ssh</string>
    <string>-N</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-o</string><string>ServerAliveInterval=15</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-L</string><string>127.0.0.1:7820:127.0.0.1:7820</string>
    <string>__USER__@__SERVER__</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>__ROOT__/.cache/logs/tunnel.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.shared-memory.tunnel.plist
```

On Linux, `~/.config/systemd/user/shared-memory-tunnel.service`:

```ini
[Unit]
Description=shared-memory SSH tunnel
After=network-online.target

[Service]
ExecStart=/usr/bin/ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L 127.0.0.1:7820:127.0.0.1:7820 __USER__@__SERVER__
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now shared-memory-tunnel.service
```

- Server PC: do steps 1 to 6 of "Setup" above and run `scripts/register-tasks.ps1`. All tasks run under an interactive logon, so log on after a reboot. Turn off sleep as well.
- Client PC: stop your own MCP server and tasks (`SharedMemory-MCP`, `SharedMemory-Decay`, `SharedMemory-GC`, `SharedMemory-Eval`), start the ssh command above at logon, and make it reconnect when it drops. OpenSearch and Ollama are not needed either.
- Memory Markdown is written only to the server PC's `memories_dir`. Only the server PC's SQLite statistics are used.

Notes for configuring the server PC over SSH:

- Processes started from an SSH session end when you disconnect. Start Docker Desktop, Ollama and the like from tasks that run under an interactive logon.
- An SSH session cannot use the Windows credential store, so `docker compose build` may fail to pull base images. Build directly on the server PC, or `docker save` the image on another PC and `docker load` it.
- If `memories_dir` is in a synced folder (Proton Drive and so on) with online-only files, they cannot be opened from an SSH session. Mark that folder as "Always keep on this device".

### Code deployment

Deploy shared-memory code edited on a client PC to the server PC and apply it there. The steps in this section are used only on a Windows server PC.

1. On the client PC, run `node scripts/publish-code.mjs --ssh <user>@<server PC> --remote-dir <destination on the server PC>`. Of the files tracked by Git and the untracked files that are not ignored, the ones that differ from the server PC's `<destination>/manifest.json` are packed into a tar, copied with scp, and extracted into `<destination>/files/` on the other side. At the end it replaces `manifest.json`, which lists the hashes of all files, and starts the `SharedMemory-Deploy` task. `node_modules`, `state`, `.cache`, `.env` and `config.local.yaml` are not deployed. `--force` resends all files.
2. On the server PC, `scripts/deploy-code.ps1 -SourceDir <destination>` checks that the hashes in `manifest.json` match the contents, then applies them to the working folder. If dependencies (`package.json`, `pnpm-lock.yaml` and so on) changed, it runs `pnpm install --frozen-lockfile`; if files involved in execution (`packages/`, `config.yaml` and so on) changed, it restarts the MCP server. If the server does not respond after the restart, it reverts and does not retry that version. Changes to `opensearch/` and `docker-compose.yml` are only applied, so rebuild the image and recreate the index by hand.

```powershell
# Server PC: register the SharedMemory-Deploy task that checks for changes at logon and every 5 minutes
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-code.ps1 -SourceDir <destination> -Register
```

On the client PC, calling the same command from Claude Code hooks (`PostToolUse` `Write|Edit|MultiEdit|NotebookEdit` and `SessionEnd`) deploys the code every time you edit this repository (calls from hooks detach the deployment and return immediately). Edits by other agents or by hand are picked up by a task that runs the same command every 10 minutes. Logs go to `.cache/logs/publish-code.log` and `.cache/logs/deploy-code.log` respectively, and the files before applying are kept in `.cache/deploy/backup/` on the server PC for the last 5 deployments.

Instead of SSH, you can also send to a folder you can write to directly from this PC, such as a shared folder (`--dest <destination> [--trigger-ssh <user>@<server PC>]`).

## CLI commands

Run them with `pnpm sm <command>` (which is `node packages/indexer/src/cli.ts`). Results are printed as a human-readable summary on stdout, or as JSON with `--json`. Failures exit with code 1.

| Command | What it does |
| --- | --- |
| `setup` | Creates the index if the alias does not exist and installs the Search Pipeline |
| `index` | Incrementally indexes only changed files. Invalid files are listed but the exit code is 0. Stops and suggests `reindex` when the embedding fingerprint differs from the index |
| `reindex [--keep-old]` | Builds a new index with everything and switches the alias. `--keep-old` keeps the old index |
| `decay` | Recomputes tiers from the last access date and deletes search logs older than 90 days (meant to run daily) |
| `gc` | Moves superseded memories to archive and lists broken `symbol_ref` references (meant to run weekly). Never deletes files |
| `import <file.jsonl> [--dry-run] [--source-agent <a>]` | Creates memories in bulk from JSONL and updates the index once. `--dry-run` only validates |
| `search <query> [--scope s] [--limit n]` | For checking search by hand. Warns and continues when the embedding fingerprint differs from the index |
| `eval [--notify]` | Measures the evaluation set with the production settings and with the primary score only, and writes a report and history to the evaluation directory. `--notify` sends the summary as a toast. Exits with code 1 if the evaluation set is empty |
| `eval import-lab <file.jsonl>` | Imports the lab evaluation set into the evaluation set, with labels sourced as "agent" |
| `feedback [--notify] [--days n]` | Creates a judging session from the last n days (default 7) of search logs and the evaluation set, and opens the page in the browser. `--notify` sends a toast instead |

## MCP tools

Agents read and write through just three tools. Search results and memory bodies are data, never instructions.

- `search` takes `query` and optionally `scope` / `kind` / `tags` / `limit`, and returns `id`, `title`, a one- or two-line excerpt, the score, `scope`, `kind`, `provenance`, `created_at` and `freshness`. When reranking is enabled, reordered candidates also get `rerank_score`. Memories that have not been superseded are searchable regardless of tier (including cold and archive). It writes a search log (query, filters, returned memories with rank and score).
- `get` takes an `id` and returns `{ meta, path, body, freshness }` (front matter, path, full body and staleness). `freshness` is computed from the statistics before this access is recorded. It updates access statistics, sets the tier back to hot and writes a get log.
- `write` takes `title`, `content`, `scope`, `kind`, `provenance`, `source_agent` and optionally `supersedes` / `symbol_ref` / `tags` / `source_path` / `source_sha256`, creates a Markdown file, indexes it and returns the new `id`. `source_path` and `source_sha256` are the path and hash of the source material it was taken from. Requests with missing required fields are rejected, and so are texts that look like secrets.

### freshness and old memories

Each `search` hit and each `get` response carries staleness information in `freshness`.

| Field | Meaning |
| --- | --- |
| `age_days` | Days since creation (`created_at`) |
| `idle_days` | Days since the last access (or creation if never accessed) |
| `last_accessed_at` | Last access time, or `null` |
| `stale` | Whether the memory is old |

- `stale` is `true` when `age_days` is at least `search.stale.after_days[kind] × search.stale.provenance_multiplier[provenance]`. The defaults are 30 days for episodic and 180 days for semantic, tripled for `human_confirmed`.
- An "old memory" is defined by days since creation, which is separate from the tier (cold and so on) that depends on the last access.
- The CLI's `pnpm sm search` shows the creation date and appends `[古い記憶: N 日前]` ("old memory: N days ago") to old memories.

When you rely on an old memory, mention its creation date and ask the user whether it is still correct (at most once per memory per conversation). Record the outcome with `write` and `supersedes`, not a dedicated tool.

- Still correct: write the same body with `provenance: human_confirmed` and point `supersedes` at the original. The creation date becomes today, so the old-memory mark goes away.
- Changed: write the new content with `supersedes`.
- No longer needed: write a short memory saying "X was retired (reason)" with `supersedes`.

The block that `mcp-setup` writes into each agent's instruction file (`<!-- shared-memory:begin -->` to `<!-- shared-memory:end -->`) contains a one-line rule for this. On Windows, `register.ps1` rewrites the block, so running it again is enough. On Mac / Linux, already-registered environments are not updated automatically, so add the following line by hand inside the block of each agent's instruction file (the ones you registered: `~/.claude/CLAUDE.md` for Claude Code, `~/.codex/AGENTS.md` for Codex, `~/.kimi-code/AGENTS.md` for Kimi Code CLI), right before `<!-- shared-memory:end -->`. The line is in Japanese, as written by `register.ps1`.

```markdown
- 古い記憶 (search や get の結果で freshness.stale が true) を根拠に使うときは、作成日を添えてユーザーに今も正しいかを確かめる。確かめたら human_confirmed と supersedes で書き直し、変わっていたら supersedes で置き換える。
```

### Search logs

MCP `search` and `get`, and the CLI's `search`, are logged to `search_log` and `get_log` in the same SQLite file as the statistics (`state/stats.sqlite`). Search keeps working even if logging fails. Logs stay on each PC, are never sent anywhere, and rows older than 90 days are deleted by the daily `decay`.

## Evaluation and feedback

Once a week, search quality is measured and checked for whether rescore is making the primary-score ranking worse. In the same weekly round, you judge the queries that were actually used that week in the browser, which grows the evaluation set. Neither of these changes your settings automatically. For the background and reasoning, see the [specification](docs/specs/rescore-guard-and-temporal-eval.md) (Japanese).

### Evaluation set and evaluation directory

The evaluation set, reports, run history and feedback sessions all live in the evaluation directory. Choose it with `eval.dir` in `config.local.yaml`. When it is empty (the default), it is `eval/` next to `memories_dir`. Like the memories themselves, it is not kept in this repository.

| File | Contents |
| --- | --- |
| `eval-set.jsonl` | The evaluation set. One question per line, with the query, the time it was asked, its kind (synthetic / real query), the relevant memories (memory `id` with grade 2 / 1), a freshness-sensitive flag, and the label records (source "agent" or "human", time of labeling, and the session ID for human labels) |
| `history.jsonl` | History of `sm eval` runs (one line per run). Feeds the charts on the feedback page |
| `reports/<YYYY-MM-DD>.md` | A report per run |
| `sessions/<id>.json` | Feedback sessions (chosen questions, interleaved lists, drafts, confirmed judgments and wins/losses) |

- When a question has both human and agent labels, the human label is used.
- Import the lab evaluation set (JSONL of `{qid, set, query, relevant}`) with `pnpm sm eval import-lab <file.jsonl>`. Labels are sourced as "agent" and the asked-at time is 2026-10-17. Questions that already exist (compared after trimming and collapsing whitespace and lowercasing) are skipped.

### sm eval and the guard

`pnpm sm eval` measures the evaluation set with two configurations: the production settings (with the rescore from `config.yaml`, plus reranking if it is enabled) and the primary score only (no rescore; reranking follows production). Both go through the production search (`searchMemories`).

- Each question is measured as of the time it was asked. Memories created after that time are excluded from the candidates, and both the supersede state and the "now" used for time decay are set to that time. Access counts use the values at evaluation time (the report notes that the access term contains leakage).
- What it reports: nDCG@10, Recall@5 and MRR@10 for each configuration; the per-question nDCG@10 difference (production − primary score only) with a bootstrap (5,000 resamples) 95% interval; nDCG@10 on freshness-sensitive questions alone and the rate at which the newer version ranks above the older one; the creation-date distribution of relevant memories and of the corpus (by week); and whether the conditions for revisiting the parameters are met.
- It writes a report under `reports/`, appends a line to the history, and prints a summary and the report location. With `--json`, it prints the run result as JSON.
- The "まとめ" (summary) at the top of the report avoids jargon: search quality is shown as a score out of 100, production is called "the current settings", the primary score only is "content similarity only", and the 95% interval is "the margin of error". The detailed metrics above follow it for experts. Reports and toast notifications are written in Japanese only.

The guard watches whether rescore makes the ranking significantly worse than the primary score alone.

- If the upper bound of the 95% interval of the difference is below 0, that run counts as "worse". Two worse runs in a row raise an alert. A single one does not.
- An alert is also raised when, over the accumulated interleaving results from feedback, the primary score alone significantly beats production (sign test, p < 0.05).
- Alerts are only reported through a toast (`--notify`) and the report; settings are never changed. You decide whether to act and edit `config.yaml` yourself.

The "revisit conditions" in the report read "yes" only when all three hold: (a) the creation dates of the corpus span at least twice the half-life, (b) at least 150 questions have human judgments, of which at least 30 are freshness-sensitive, and (c) the guard has alerted, or the rate of newer versions ranking above older ones is below 0.6. Until then, the rescore parameters are left alone.

### The weekly round

1. On Windows, `SharedMemory-Eval`, registered by `scripts/register-tasks.ps1`, runs `eval --notify` and then `feedback --notify` every Sunday at 10:00 (30 minutes after gc).
2. `eval --notify` runs the evaluation and shows a toast, in plain words, with the guard result, the search quality (production nDCG@10 as a score out of 100) and whether it is time to revisit the settings.
3. `feedback --notify` picks questions to judge from the last 7 days of MCP search logs and the evaluation set, creates a session and shows a toast. Clicking the toast opens the page in your browser.
4. Judge the results on the page and press the confirm button.

- To start by hand, run `pnpm sm feedback` (`--days <n>` changes how far back it looks). It creates a session, opens the page in your default browser and exits without waiting for the result. If there is nothing to judge, no session is created.
- Outside Windows, no toast is shown; the report location and the page URL are printed to stdout instead. To schedule it on macOS / Linux, create one plist / unit for `eval --notify` and one for `feedback --notify`, shaped like the `gc` ones above, and run them weekly at a time after gc.
- When the server runs on a single PC, evaluation and notifications happen on the server PC. From a client PC, open the same URL (`http://127.0.0.1:7820/feedback/...`) through the SSH tunnel.

### The feedback page

![The feedback page in English, plain view. Plain / expert and Japanese / English switches at the top right. At the top, a summary (degradation watch, search quality score, number of questions where the current settings won, number of check questions) and four charts; below, the list of 10 questions to judge and the result cards for one question, each with "answers / partly / not related" buttons. The first card has its full text expanded](docs/assets/feedback-screen.en.png)

An example of the page (dummy data), in English and the plain view, with the first card's full text expanded. The dummy questions and memories are written in Japanese; they are shown as written. The MCP server process serves it at `/feedback/<session ID>?t=<token>` on the same port as `/mcp`. It loads nothing from outside and never sends memory text anywhere.

- A language switch in the top bar chooses Japanese (JA) or English (EN). The default follows the browser language (Japanese if it is Japanese, otherwise English). Only the page text changes; questions and memory titles and text are shown in the language they were written in.
- A switch in the top bar chooses between a "plain" view (the default) that replaces jargon with plain words, and an "expert" view that keeps the metric names. The browser remembers both choices. For example, production / primary score only become "the current settings / content similarity only", nDCG@10 becomes "search quality" out of 100, the guard and its 95% interval become "degradation watch" and "margin of error", and interleaving wins / losses / ties become "current settings were better / content similarity was better / no difference". The plain view hides the sign-test p-value and the guard's reason.
- The top shows a summary of the guard, the production nDCG@10, the accumulated interleaving results and the number of questions in the evaluation set, plus four charts (nDCG@10 over time, the guard's difference with its 95% interval, interleaving wins and losses, and the creation-date distribution of relevant memories).
- Up to 10 questions per session. Queries that agents actually issued that week come first, preferring those where the top 10 differ between the two configurations; any remaining slots are filled with questions from the evaluation set that have no human judgment yet.
- The results are 10 items interleaved from the production ranking and the primary-score-only ranking, with their origin hidden. For each card, choose "answers / partly / not related", and if needed tick "a newer version exists; this one is outdated".
- Card excerpts are cut to 160 characters at search time. Cards with more text get a "show full text" link that expands the memory body (up to 4,000 characters). The MCP server adds the full text from the memory files when the page loads its data; it is not stored in the session file.
- Each choice is saved as a draft right away, so you can close the tab and pick up where you left off.
- Pressing the confirm button writes your judgments into the evaluation set with source "human" (with the session ID and time) and records the interleaving wins and losses in the session. Unjudged questions are treated as having no judgment. Once confirmed, judgments cannot be changed.
- Requests with a wrong token (`t=` in the URL) are rejected. There is no HTTP route that creates sessions; only the CLI can. Writing judgments is not exposed as an MCP tool either, so agents cannot pose as a human and write labels. The URL contains the token, so do not share it.

### Not counted as access

`sm eval` and the feedback page call the core search and read functions directly. Reading memories through them does not increase `access_count` or `last_accessed_at`, and nothing is written to the search or get logs. This prevents memories in the evaluation set from gaining an edge through the access term, and keeps the logs limited to searches that agents and people actually made.

## Memory file format

Each memory is `memories/<scope>/<id>.md` with YAML front matter and a body. The file name must match the `id`.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Required | ULID (26 characters). Must match the file name |
| `title` | Required | Shown as the one-line summary in search results (up to 200 characters) |
| `scope` | Required | `global` / `project:<name>` / `repo:<name>` |
| `kind` | Required | `episodic` (an event) / `semantic` (knowledge) |
| `provenance` | Required | `human_confirmed` / `agent_verified` / `agent_inferred` |
| `source_agent` | Required | `human` / `claude` / `codex` / `kimi` / `grok` / `harness2` |
| `created_at` | Required | Creation date (ISO 8601) |
| `supersedes` | Optional | `id` of the memory this one replaces |
| `symbol_ref` | Optional | Serena `name_path` (code-related memories only) |
| `tags` | Optional | Free-form classification (array of strings) |
| `source_path` | Optional | Path of the source material (up to 1000 characters) |
| `source_sha256` | Optional | SHA-256 of the source material (64 lowercase hex digits) |

Never rewrite the body of an existing file. To update content, create a new file and point `supersedes` at the original. To delete, remove the file; the next `index` removes it from OpenSearch.

## Preservation policy

| Target | How it is preserved | If it is lost |
| --- | --- | --- |
| Markdown | Up to where it is stored (the cloud side for a synced folder, a push for a private repository) | It cannot be restored. Protect this above all |
| Build assets (Dockerfile, mappings, dictionaries, code) | Tracked in Git in this repository | Same as above |
| SQLite statistics | Not preserved (per PC) | Search still works. Priority history is reset |
| OpenSearch data | Not preserved | Regenerate with `pnpm sm reindex` |
| Embedding cache | Not preserved | Re-embedding just takes time |

## Operating rules

- This repository (the code) is public. Keep the knowledge itself under `memories_dir` and never commit it here.
- Do not put the SQLite statistics in a synced folder (concurrent writes can corrupt it or create conflict files).
- Memories written on another PC only arrive through syncing; run `pnpm sm index` to add them to the index.
- Never write secrets (API keys and so on) into memories. For embedding and rerank API keys, write only the environment variable name (`api_key_env`) in configuration files and keep the value in `.env` at the repository root (not tracked by Git) or in the environment.
- All ports are bound to `127.0.0.1` only. If you change the bind address, re-enable OpenSearch security (it currently runs without authentication).
- When you change the embedding model or the mappings, rebuild with `pnpm sm reindex` (it creates a new index and switches the alias). If you changed the embedding settings but did not rebuild, `index` stops on the fingerprint mismatch and tells you.

## Tests

```powershell
pnpm test        # unit tests (no external services needed)
pnpm test:int    # integration tests (OpenSearch and Ollama must be running)
pnpm typecheck   # type check
```

Integration tests use the endpoints from `loadConfig()` (`config.local.yaml` layered over `config.yaml`). If you have changed endpoints, for example through an SSH tunnel, set `opensearch.url` and `embedding.url` in `config.local.yaml` accordingly. Test indices are created with names starting with `test-` and deleted afterwards.
