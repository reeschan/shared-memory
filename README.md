# shared-memory

**日本語** | [English](README.en.md)

複数の AI エージェント (Claude Code / Codex / Kimi) と自分自身が共通で参照する知識ベースを、ローカル PC 内で完結する RAG として動かすリポジトリ。Markdown ファイルを唯一の正とし、OpenSearch はいつでも再構築できる派生インデックスとして扱う。

<a href="docs/architecture/architecture-light.svg"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture/architecture-dark.svg">
  <img src="docs/architecture/architecture-light.svg" width="100%" alt="shared-memory のアーキテクチャ図。上から順に、Claude Code・Codex・Kimi Code が 127.0.0.1 の MCP サーバーに search / get / write を送る。MCP サーバーと CLI は packages/core を共有し、定期実行 (タスクスケジューラ / launchd / systemd) が CLI の decay を毎日、gc を毎週起動する。Windows では週 1 回の SharedMemory-Eval が sm eval (rescore のガードを含む評価) と sm feedback を走らせ、トーストがガードの判定とフィードバックの画面の URL を利用者に知らせる。利用者はブラウザーで MCP サーバーの /feedback の画面を開き、週 1 回の判定を送る。アプリはデータ (Markdown が唯一の正、OpenSearch + Sudachi が派生インデックスで _meta に埋め込みの指紋を持つ、SQLite がアクセス統計と検索ログ、eval.dir の評価のディレクトリが評価セット・履歴・セッション・レポート) を読み書きし、ローカルのモデル (埋め込みの既定の Ollama、任意の TEI リランカー) を呼ぶ。設定で明示したときだけ、外部の OpenAI 互換の埋め込み API やリランク API に本文を送る。Markdown は開発者が差分を見てコミットし、GitHub に push する。">
</picture></a>

図をクリックすると原寸で開く。SVG: [ライト](docs/architecture/architecture-light.svg) / [ダーク](docs/architecture/architecture-dark.svg)

設計の詳細は次を参照。

- [設計書](docs/design/design.md)
- [実装の契約 (モジュール間インターフェース)](docs/design/interfaces.md)

## 構成

- 知識の本体 (Markdown) … 正。このリポジトリには置かず、`config.local.yaml` の `memories_dir` が指す場所 (同期フォルダや private リポジトリ) に `<scope>/<id>.md` で置く
- `state/stats.sqlite` … アクセス統計 (アクセス回数、最終アクセス日、tier)。PC ごとにローカルに置き、Git 管理しない
- `config.local.yaml` … PC ごとの設定 (Git 管理外)。例は `config.local.example.yaml`
- `opensearch/` … OpenSearch + Sudachi の Dockerfile、インデックステンプレート、Search Pipeline
- `packages/core` … front matter 検証、チャンク分割、埋め込みとリランクのクライアント、検索などの共通処理
- `packages/indexer` … CLI (`pnpm sm <command>`)
- `packages/mcp-server` … MCP サーバー (search / get / write)
- `skills/` … エージェント向け Skill (`knowledge-import`、`mcp-setup`)。Windows 以外では、どちらも使う前に `SHARED_MEMORY_ROOT` にリポジトリの絶対パスを設定する
- `scripts/` … MCP サーバーの起動スクリプトなど
- `config.yaml` … 埋め込み・リランク・重み・半減期などの設定
- `.cache/` … 埋め込みキャッシュ (Git 管理しない)

データの流れ: エージェント → MCP サーバー → Markdown / SQLite / OpenSearch。埋め込みは既定では Ollama (Qwen3-Embedding-0.6B、1024 次元) をローカルで呼ぶ。埋め込みのモデルとリランクは設定で差し替えられる (「埋め込みモデルの切り替え」「リランク」を参照)。

### インデックス作成と検索の流れ

埋め込み・OpenSearch・リランクのつながり。緑の線がインデックス作成、オレンジの線が検索、破線はリランクを有効にしたときだけ通る。

- インデックス作成:
  1. インデックスの `_meta` にある埋め込みの指紋と、今の設定の指紋を照合する。違えば止めて `pnpm sm reindex` を促す。
  2. Markdown を見出し単位のチャンクに分け、`content_hash` が変わったチャンクだけを残す。
  3. 埋め込みキャッシュ (`.cache/embeddings/<指紋>/`) に無いチャンクだけを、`document.prefix` を付けて埋め込む。
  4. 本文は BM25 用のフィールドへ、ベクトルは `knn_vector` フィールドへ、同じドキュメントとして投入する。
- 検索:
  1. クエリに `query.prefix` を付けて埋め込み、kNN と BM25 (Sudachi) を 1 回のハイブリッドクエリで投げる。
  2. Search Pipeline が両方のスコアを min_max 正規化し、BM25 0.4 : kNN 0.6 で合成する (一次スコア)。
  3. MCP サーバーが上位 50 チャンクを `memory_id` でまとめる。代表は一次スコアが最大のチャンク。
  4. リランクが有効なら、一次スコアの上位 20 件をリランカーで並べ替え、その順位をそのまま使う。無効か失敗のときは、rescore (時間減衰に下限 0.7・アクセス回数の係数 0.2・出所の係数) の順位を使う。
  5. 上位 8 件 (`limit`) の id・title・抜粋を返す。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture/data-flow-dark.svg">
  <img src="docs/architecture/data-flow-light.svg" alt="インデックス作成と検索の流れの図 (上から下へ)。インデックス作成では、インデックスの _meta と設定の埋め込みの指紋を照合し、Markdown をチャンク分割し、content_hash が変わったチャンクのうち指紋ごとのキャッシュに無いものだけを document.prefix を付けて埋め込み (embedding.provider: 既定は Ollama、または OpenAI 互換 API)、文書ベクトルを OpenSearch の knn_vector フィールドへ、本文を Sudachi で解析する BM25 用フィールドへ投入する。検索では、クエリに query.prefix を付けて埋め込み、クエリベクトルで kNN、クエリの語で BM25 を検索し、Search Pipeline が min_max 正規化して BM25 0.4 と kNN 0.6 で合成した一次スコアを、MCP サーバーが memory_id でまとめる。リランクが有効なら一次スコアの上位 20 件を並べ替え、無効か失敗なら rescore で並べ、上位 8 件を返す。" width="560">
</picture>

図のソースは `docs/architecture/architecture.d2` (全体) と `docs/architecture/data-flow.d2` (流れ)。構成を変えたら直して、`python ~/.claude/skills/arch-diagram/versions/v1.1/scripts/render.py docs/architecture/<名前>.d2` で `<名前>-light.svg` / `<名前>-dark.svg` を描き直す。

## 前提

OS ごとに、次のものを入れる。

| 項目 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Docker | Docker Desktop (WSL2 バックエンド) | Docker Desktop / OrbStack / colima | Docker Engine |
| Ollama | インストーラーで直接インストール | アプリをインストール | 公式の手順でインストール |
| Node 26 | fnm か mise | fnm か mise | fnm か mise |
| pnpm | `npm i -g pnpm@12` | `npm i -g pnpm@12` | `npm i -g pnpm@12` |

- Node 26 は、TypeScript をビルドせずに型ストリップで直接実行するために要る。
- Ollama と Docker は、MCP サーバーを動かす PC に入れる。下記のクライアント構成では要らない。
- `vm.max_map_count` は、OpenSearch が起動しないときや警告が出たときだけ設定する任意の手順。Linux は `sudo sysctl -w vm.max_map_count=262144` で設定し、`/etc/sysctl.d/` に書いて永続化する。Docker Desktop・colima・OrbStack は、それぞれの VM の中で同じ値を設定する (例: `wsl -d docker-desktop sysctl -w vm.max_map_count=262144`、`colima ssh -- sudo sysctl -w vm.max_map_count=262144`)。single-node で動かす限り、未設定でも起動前のチェックでは止まらない。

## セットアップ

Windows は PowerShell、macOS / Linux は bash で行う。`__ROOT__` はリポジトリの絶対パス。

```powershell
git clone <このリポジトリの URL> shared-memory
cd shared-memory
pnpm install
Copy-Item config.local.example.yaml config.local.yaml   # memories_dir を知識の保存先に書き換える
ollama pull qwen3-embedding:0.6b
docker compose up -d --build
pnpm sm reindex
scripts/start-mcp.ps1
skills/mcp-setup/register.ps1
```

```bash
git clone <このリポジトリの URL> shared-memory
cd shared-memory
pnpm install
cp config.local.example.yaml config.local.yaml   # memories_dir を知識の保存先に書き換える
ollama pull qwen3-embedding:0.6b
docker compose up -d --build
pnpm sm reindex
pnpm mcp        # 常駐させるなら、この後の launchd / systemd の設定で起動する
```

1. リポジトリを clone する。
2. `pnpm install` で依存を入れ、`config.local.yaml` を作って `memories_dir` に知識の保存先 (末尾のフォルダ名は `memories`) を書く。Mac / Linux のパスの例は `config.local.example.yaml` にある。
3. `ollama pull qwen3-embedding:0.6b` で、`config.yaml` の既定の埋め込みモデルを取得する。
4. `docker compose up -d --build` で OpenSearch (Sudachi 入り) を起動する。
5. `pnpm sm reindex` で Markdown から全件をインデックスする。
6. MCP サーバーを起動する。Windows は `scripts/start-mcp.ps1`、macOS / Linux は `pnpm mcp` か下記の常駐を使う。
7. エージェントにエンドポイントを登録する。Windows は `skills/mcp-setup/register.ps1`、macOS / Linux は `skills/mcp-setup/SKILL.md` の Windows 以外の手順で行う (`SHARED_MEMORY_ROOT` が必須)。

MCP のエンドポイントは `http://127.0.0.1:7820/mcp`。

### 常駐と定期実行

Windows は `scripts/register-tasks.ps1` でタスクスケジューラに登録する (`-WhatIf` で内容確認、`-Unregister` で削除)。MCP サーバーの起動、`decay` (毎日 09:00)、`gc` (毎週日曜 09:30)、評価とフィードバック (`eval --notify` と `feedback --notify`、毎週日曜 10:00) の 4 つが入る。

macOS は launchd、Linux は systemd のユーザー unit で常駐させる。`__NODE__` には `realpath "$(command -v node)"` で出る実体のパスを書く。fnm の `which node` は再起動で消える一時ディレクトリ (`fnm_multishells/...`) を指すので、そのまま書かない。fnm や mise の shim も launchd / systemd からは使えない。ログのフォルダは先に作る (`mkdir -p __ROOT__/.cache/logs`)。

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

`~/Library/LaunchAgents/com.shared-memory.decay.plist` (毎日 09:00):

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

`gc` は、`Label` を `com.shared-memory.gc`、`ProgramArguments` の最後を `gc`、`StartCalendarInterval` を `<dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>`、ログを `.cache/logs/gc.log` にした同じ plist (`com.shared-memory.gc.plist`) にする。

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.shared-memory.mcp.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.shared-memory.decay.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.shared-memory.gc.plist
launchctl bootout gui/$(id -u)/com.shared-memory.mcp   # 止めるとき
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

`~/.config/systemd/user/shared-memory-decay.service` と `shared-memory-decay.timer` (毎日 09:00):

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

`gc` は、`shared-memory-gc.service` の `ExecStart` の最後を `gc` に、`shared-memory-gc.timer` の `OnCalendar` を `Sun *-*-* 09:30:00` にした同じ unit にする。

```bash
systemctl --user daemon-reload
systemctl --user enable --now shared-memory-mcp.service
systemctl --user enable --now shared-memory-decay.timer shared-memory-gc.timer
loginctl enable-linger "$USER"   # ログオンしていないときも動かす
```

`loginctl enable-linger` をしないと、ログアウトしたときに unit が止まる。ログは `journalctl --user -u shared-memory-mcp -f` で見る。

## 埋め込みモデルの切り替え

何も設定しなければ、`config.yaml` の既定どおり Ollama の Qwen3-Embedding-0.6B (1024 次元) をローカルで呼ぶ。別のモデルやサーバーを使うときは、`config.local.yaml` の `embedding` に上書きを書く。コードは変えない。

| キー | 内容 |
| --- | --- |
| `provider` | `ollama` (既定) か `openai`。`ollama` は `<url>/api/embed`、`openai` は OpenAI 互換の `<url>/embeddings` を呼ぶ |
| `url` | サーバーの URL。`/api/embed` や `/embeddings` は付けない |
| `model` | モデル名 |
| `dimension` | ベクトルの次元。サーバーが返した次元と違えばエラーになる |
| `batch_size` | 1 回に送るテキスト数。Sarashina のように 1 件ずつしか受け付けない API は `1` にする |
| `normalize` | L2 正規化するか (既定 `true`)。正規化しないモデルもクライアント側で揃える |
| `revision` | 同じ名前で中身の違うモデルに替えたときに上げる番号 (既定 `0`) |
| `rpm` | 1 分あたりのリクエスト数の上限。省略すると間隔を空けない |
| `api_key_env` | API キーの値を入れた環境変数の名前。値そのものは書かない |
| `extra_body` | リクエストに足す項目 |
| `query` | `prefix` (クエリの前置き) と `params` (クエリだけに足す項目) |
| `document` | `prefix` (文書の前置き) と `params` (文書だけに足す項目) |

- `provider: openai` は OpenAI 互換のサーバー (LM Studio・vLLM・llama.cpp・TEI など) と、OpenAI の埋め込み API に使う。
- API キーは設定ファイルに書かず、`api_key_env` に名前だけを書いて、値はリポジトリルートの `.env` か環境変数で渡す。`.env` は既にある環境変数を上書きしない。名前だけ書いて値が無いまま起動するとエラーになる。
- 設定を変えると埋め込みの指紋 (`provider`・`model`・`dimension`・`normalize`・`revision`・`query`・`document`・`extra_body` から作る識別子) が変わる。指紋がインデックスの `_meta` と違うと `index` は止まり、`pnpm sm reindex` を促す。search と MCP の起動は警告だけで続く。
- 同じ名前で中身の違うモデルに替えたときは `revision` を上げる。次元が同じでも、指紋が変わって別物として扱われる。
- `url` は指紋に含まれない。SSH トンネル経由で URL が変わっても、同じモデルなら作り直さなくてよい。
- 旧キー `embedding.query_instruction` は、同じファイルに `embedding.query.prefix` が無ければ `query.prefix` として読む。読み替えはファイルごとに重ねる前に行うので、`config.local.yaml` の旧キーは `config.yaml` の `query.prefix` より優先される。新しく書くときは `embedding.query.prefix` を使う。
- 埋め込みもリランクも、外部 API に本文を送るのは、設定でそのプロバイダーと URL を明示したときだけ。既定の Ollama はローカルで、外に送らない。

今の Ollama の既定 (何も書かないときと同じ):

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

LM Studio などの OpenAI 互換サーバー:

```yaml
embedding:
  provider: openai
  url: http://127.0.0.1:1234/v1
  model: text-embedding-nomic-embed-text-v1.5
  dimension: 768
```

Sarashina (1 件ずつ送り、タスク種別を `params` で渡す):

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

## リランク

既定は無効 (`rerank.enabled: false`)。有効にすると、一次スコアの上位 `candidates` 件のメモリをリランカーに渡して順位を付け直す。`score` は今までどおり rescore 後のスコアで、リランクの点数は `rerank_score` に入る。

| `flavor` | 対応するサーバー | 既定のパス |
| --- | --- | --- |
| `cohere` | Cohere・Jina・Infinity・vLLM・llama.cpp (cohere 形) | `/v1/rerank` |
| `voyage` | Voyage | `/v1/rerank` |
| `tei` | Hugging Face TEI | `/rerank` |
| `sarashina` | Sarashina | `/rerank` |

| キー | 内容 |
| --- | --- |
| `enabled` | リランクを使うか (既定 `false`) |
| `flavor` | 上の 4 種類 (既定 `cohere`) |
| `url` | サーバーの URL |
| `model` | モデル名 (`enabled: true` のとき必須) |
| `path` | パスの上書き (省略時は flavor の既定) |
| `api_key_env` | API キーの環境変数名。値は `.env` か環境変数に書く |
| `candidates` | リランクにかける候補数 (既定 20)。一次スコアの上位から選ぶ |
| `max_docs_per_request` | 1 回に送る文書数 (`0` なら flavor の既定。TEI は 32、Sarashina は 20) |
| `doc_max_chars` | 1 文書の本文を切る長さ (既定 2000) |
| `timeout_ms` | タイムアウト (既定 3000) |
| `extra_body` | リクエストに足す項目 |

- 候補は rescore の前の一次スコアで選ぶ。リランクした候補を点数の降順に並べ、候補外のメモリは一次スコアの降順で後ろにつなぎ、最後に `limit` で切る。
- 点数は API ごとに範囲が違うので、使うのは順位だけにする。`score` の意味は変えない。
- 遅延の目安は、外部 API で約 1 秒 (候補 20 件)。ローカルの TEI はこれより短いことが多いが、CPU では候補数と本文の長さに比例して遅くなる。
- タイムアウト・429・5xx・応答の形が不正のときは、リランクなしの順位 (rescore 順) を返し、`rerank failed: ...` をログに出す。リランカーの不調で検索は止まらない。
- 外部 API に本文を送るのは、`enabled: true` と `url` を設定で明示したときだけ。Sarashina の無償ベータでは、送った内容がモデルやサービスの改善に使われることがある。候補の本文を外に出してよいか考えてから有効にする。

ローカルの TEI を使う例:

```yaml
rerank:
  enabled: true
  flavor: tei
  url: http://127.0.0.1:8081
  model: BAAI/bge-reranker-v2-m3
```

TEI は `docker compose --profile rerank up -d` で起動する (`opensearch` と `reranker` が起動する)。初回はイメージとモデルの取得に時間がかかる。モデルは `./.cache/tei` にキャッシュされる。

Sarashina を使う例:

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

## サーバーを 1 台の PC に集約する

OpenSearch・Ollama・MCP サーバーを 1 台 (以下サーバー PC) だけで動かし、ほかの PC (以下クライアント PC) のエージェントからは SSH のポート転送で使うこともできる。MCP サーバーは `mcp.host` がループバック限定で `Host` ヘッダーも検査するので、LAN に直接公開せず、クライアント PC の `127.0.0.1:7820` をサーバー PC の `127.0.0.1:7820` へ同じポート番号で転送する。クライアント PC のエージェントの登録は `http://127.0.0.1:7820/mcp` のまま変えなくてよい。

サーバー集約構成と、サーバー PC のタスク登録 (`register-tasks.ps1`) は Windows のサーバー PC 限定。macOS / Linux はクライアント側だけで使う。

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -L 127.0.0.1:7820:127.0.0.1:7820 <user>@<サーバー PC>
```

トンネルは、クライアント PC の launchd / systemd で常駐させる。launchd / systemd はパスワードを聞けないので、サーバー PC へは鍵で入れるようにしておく。

macOS の `~/Library/LaunchAgents/com.shared-memory.tunnel.plist` (中の `__USER__@__SERVER__` は自分のユーザー名とサーバー PC の名前に置き換える):

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

Linux の `~/.config/systemd/user/shared-memory-tunnel.service`:

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

- サーバー PC: 上の「セットアップ」の 1〜6 と `scripts/register-tasks.ps1` を行う。どのタスクも対話ログオンで動くので、再起動したらログオンしておく。スリープも切っておく。
- クライアント PC: 自分の MCP サーバーとタスク (`SharedMemory-MCP`・`SharedMemory-Decay`・`SharedMemory-GC`・`SharedMemory-Eval`) は止め、上の ssh をログオン時に起動して、切れたらつなぎ直すようにしておく。OpenSearch と Ollama も要らない。
- メモリの Markdown はサーバー PC の `memories_dir` にだけ書かれる。統計の SQLite もサーバー PC のものだけを使う。

SSH 越しにサーバー PC を設定するときの注意:

- SSH セッションから起動したプロセスは切断時に終わる。Docker Desktop や Ollama などは、対話ログオンのタスクから起動する。
- SSH セッションからは Windows の資格情報ストアを使えないため、`docker compose build` がベースイメージを取得できないことがある。サーバー PC で直接ビルドするか、ほかの PC で `docker save` したイメージを `docker load` する。
- `memories_dir` が同期フォルダー (Proton Drive など) にあり、オンラインのみのファイルがあると、SSH セッションからは開けない。そのフォルダーを「常にこのデバイスに保持」にしておく。

## CLI コマンド

`pnpm sm <command>` で実行する (中身は `node packages/indexer/src/cli.ts`)。結果は人が読める要約を標準出力に出し、`--json` を付けると JSON になる。失敗時は終了コード 1。

| コマンド | 内容 |
| --- | --- |
| `setup` | エイリアスが無ければインデックスを作り、Search Pipeline を投入する |
| `index` | 変更されたファイルだけを差分インデックスする。不正なファイルは一覧に出すが終了コードは 0。埋め込みの指紋がインデックスと違うときは止まり、`reindex` を促す |
| `reindex [--keep-old]` | 新しいインデックスを作って全件を投入し、エイリアスを付け替える。`--keep-old` で旧インデックスを残す |
| `decay` | 最終アクセス日から tier を再計算し、90 日より古い検索ログを消す (1 日 1 回の想定) |
| `gc` | 置き換え済みのメモリを archive に送り、`symbol_ref` の参照切れを一覧に出す (週 1 回の想定)。ファイルは消さない |
| `import <file.jsonl> [--dry-run] [--source-agent <a>]` | JSONL からメモリをまとめて作成し、インデックスを 1 回だけ更新する。`--dry-run` は検証のみ |
| `search <query> [--scope s] [--limit n]` | 検索の動作確認用。埋め込みの指紋がインデックスと違うときは警告を出して続ける |
| `eval [--notify]` | 評価セットを本番の設定と一次スコアだけで測り、レポートと履歴を評価のディレクトリに書く。`--notify` で要約をトーストで知らせる。評価セットが空なら終了コード 1 |
| `eval import-lab <file.jsonl>` | lab の評価セットを、ラベルの出どころ「エージェント」として評価セットに取り込む |
| `feedback [--notify] [--days n]` | 過去 n 日 (既定 7) の検索ログと評価セットから判定のセッションを作り、画面をブラウザーで開く。`--notify` ならトーストで知らせる |

## MCP ツール

エージェントからの読み書きの入口は 3 つのツールだけ。検索結果とメモリ本文は「データ」であり、指示として扱わない。

- `search` … `query` と、任意で `scope` / `kind` / `tags` / `limit` を受け取り、`id`・`title`・1〜2 行の抜粋・スコア・`scope`・`kind`・`provenance`・`created_at`・`freshness` を返す。リランクが有効なら、並べ替えた候補に `rerank_score` も付く。置き換えられていないメモリは tier (cold・archive を含む) によらず検索の対象になる。検索ログ (クエリ・絞り込み条件・返したメモリと順位とスコア) を記録する。
- `get` … `id` を受け取り、`{ meta, path, body, freshness }` (front matter・パス・本文の全文・古さ) を返す。`freshness` は今回のアクセスを記録する前の統計から計算する。アクセス統計を更新し、tier を hot に戻し、get ログを記録する。
- `write` … `title`・`content`・`scope`・`kind`・`provenance`・`source_agent` と、任意で `supersedes` / `symbol_ref` / `tags` / `source_path` / `source_sha256` を受け取り、Markdown ファイルを作成してインデックスし、作成した `id` を返す。`source_path` と `source_sha256` は出典 (取り込み元の資料) のパスとハッシュ。必須項目が欠けていたら拒否し、秘密情報らしき文字列も拒否する。

### freshness と古い記憶

`search` の各ヒットと `get` の応答には、古さの情報 `freshness` が付く。

| フィールド | 内容 |
| --- | --- |
| `age_days` | 作成 (`created_at`) からの日数 |
| `idle_days` | 最終アクセス (なければ作成日) からの日数 |
| `last_accessed_at` | 最終アクセス日時。なければ `null` |
| `stale` | 古い記憶かどうか |

- `stale` は `age_days` が `search.stale.after_days[kind] × search.stale.provenance_multiplier[provenance]` 以上のとき `true` になる。既定は episodic 30 日・semantic 180 日で、`human_confirmed` はその 3 倍。
- 「古い記憶」は作成からの日数で決まり、最終アクセスで決まる tier (cold など) とは別物。
- CLI の `pnpm sm search` は作成日を表示し、古い記憶なら末尾に `[古い記憶: N 日前]` を付ける。

古い記憶を根拠に使うときは、作成日を添えてユーザーに今も正しいかを確かめる (同じ記憶について 1 つの会話で 1 回まで)。結果は専用のツールではなく `write` と `supersedes` で残す。

- 今も正しい: 同じ本文を `provenance: human_confirmed` で書き、元のメモリを `supersedes` で指す。作成日が今日になるので、古い記憶の印が消える。
- 内容が変わった: 新しい内容を `supersedes` で書く。
- もう要らない: 「〜は廃止した (理由)」という短いメモリを `supersedes` で書く。

`mcp-setup` が各エージェントの指示ファイルに書くブロック (`<!-- shared-memory:begin -->` 〜 `<!-- shared-memory:end -->`) には、この運用の 1 行が入っている。Windows の `register.ps1` はブロックを書き直すので、もう一度実行すれば届く。Mac / Linux で登録済みの環境には自動で届かないので、各エージェントの指示ファイル (登録したもの。Claude Code は `~/.claude/CLAUDE.md`、Codex は `~/.codex/AGENTS.md`、Kimi Code CLI は `~/.kimi-code/AGENTS.md`) のブロックの中、`<!-- shared-memory:end -->` の直前に、次の 1 行を手で足す。

```markdown
- 古い記憶 (search や get の結果で freshness.stale が true) を根拠に使うときは、作成日を添えてユーザーに今も正しいかを確かめる。確かめたら human_confirmed と supersedes で書き直し、変わっていたら supersedes で置き換える。
```

### 検索ログ

MCP の `search` と `get`、CLI の `search` は、統計と同じ SQLite (`state/stats.sqlite`) の `search_log` と `get_log` に記録する。記録に失敗しても検索は止まらない。ログは PC ごとで外には出さず、毎日の `decay` で 90 日より古い行を消す。

## 評価とフィードバック

検索の質を週 1 回測り、rescore が一次スコアの順位を悪くしていないかを見張る。あわせて、その週に実際に使われた問いを人がブラウザーで判定し、評価セットを育てる。どちらも設定は自動では変えない。検討の経緯と判断の根拠は [仕様](docs/specs/rescore-guard-and-temporal-eval.md) にある。

### 評価セットと評価のディレクトリ

評価セット・レポート・実行の履歴・フィードバックのセッションは、すべて評価のディレクトリに置く。場所は `config.local.yaml` の `eval.dir` で選ぶ。空 (既定) なら `memories_dir` の隣の `eval/`。正本と同じく、このリポジトリには置かない。

| ファイル | 内容 |
| --- | --- |
| `eval-set.jsonl` | 評価セット。1 行 1 問で、問い・問われた時点・種類 (合成 / 実クエリ)・正解 (メモリの `id` と等級 2 / 1)・鮮度が効く問いの印・ラベルの記録 (出どころ「エージェント」か「人」、付けた時刻、人ならセッション ID) を持つ |
| `history.jsonl` | `sm eval` の実行の履歴 (1 行 1 回)。画面のグラフの材料になる |
| `reports/<YYYY-MM-DD>.md` | 実行ごとのレポート |
| `sessions/<id>.json` | フィードバックのセッション (選んだ問い・混ぜたリスト・下書き・確定した判定と勝ち負け) |

- 同じ問いに人とエージェントのラベルがあれば、人のラベルを使う。
- lab の評価セット (`{qid, set, query, relevant}` の JSONL) は `pnpm sm eval import-lab <file.jsonl>` で取り込む。出どころは「エージェント」、問われた時点は 2026-10-17 になる。同じ問い (前後と連続の空白、大文字小文字を揃えて比べる) が既にあれば足さない。

### sm eval とガード

`pnpm sm eval` は、評価セットを 2 つの構成で測る。本番の設定 (`config.yaml` の rescore あり。リランクが有効ならそれも含む) と、一次スコアだけ (rescore なし。リランクの有無は本番に合わせる)。どちらも本番の検索 (`searchMemories`) を通す。

- 各問いは、問われた時点の状態で測る。その時点より後に作られた記憶は検索対象から外し、置き換えの状態と時間減衰の「今」もその時点に合わせる。アクセス回数は評価の時点の値を使う (レポートに「アクセスの項は漏れを含む」と書く)。
- 出すもの: 構成ごとの nDCG@10・Recall@5・MRR@10、問いごとの nDCG@10 の差 (本番 − 一次スコアだけ) とブートストラップ (5,000 回) の 95% 区間、鮮度が効く問いだけの nDCG@10 と「新しい版が古い版より上に来た割合」、正解と検索対象の作成日の分布 (週ごと)、パラメーターの調整を見直す条件の判定。
- レポートを `reports/` に書き、履歴に 1 行足し、要約とレポートの場所を標準出力に出す。`--json` なら実行の結果を JSON で出す。
- レポートの冒頭の「まとめ」は専門用語を使わずに書く (検索の質を 100 点満点の点数で、本番を「いまの設定」、一次スコアだけを「内容の近さだけ」、95% 区間を「ぶれ幅」と呼ぶ)。その下に、上の指標を専門向けの詳しい数値として載せる。

ガードは、rescore が一次スコアだけの順位より有意に悪くしていないかを見張る。

- 差の 95% 区間の上端が 0 未満なら、その回は「悪化」。悪化が 2 回続いたら警告する。1 回だけでは警告しない。
- フィードバックのインターリービングの累計で、一次スコアだけが本番に有意に勝っている (符号検定で p < 0.05) ときも警告する。
- 警告はトースト (`--notify`) とレポートで知らせるだけで、設定は変えない。直すかどうかは人が決めて `config.yaml` を変える。

レポートの「見直す条件」は、(a) 検索対象の作成日の幅が半減期の 2 倍以上、(b) 人が判定した問いが 150 問以上でそのうち鮮度が効く問いが 30 問以上、(c) ガードの警告か、新しい版が上に来た割合が 0.6 未満、の 3 つがすべてそろったときに「はい」になる。そろうまでは rescore のパラメーターを調整しない。

### 週 1 回の流れ

1. Windows では、`scripts/register-tasks.ps1` が登録する `SharedMemory-Eval` が、毎週日曜 10:00 (gc の 30 分後) に `eval --notify` と `feedback --notify` を続けて走らせる。
2. `eval --notify` が評価し、悪化の見張り (ガード) の判定・検索の質 (本番の nDCG@10 を 100 点満点で)・設定の見直しの要否を、専門用語を使わない言葉でトーストに出す。
3. `feedback --notify` が、過去 7 日の MCP の検索ログと評価セットから判定する問いを選んでセッションを作り、トーストで知らせる。トーストをクリックすると画面がブラウザーで開く。
4. 画面で判定し、「確定して送る」を押す。

- 手で始めるときは `pnpm sm feedback` (`--days <n>` で遡る日数を変える)。セッションを作って既定のブラウザーで画面を開き、結果を待たずに終わる。判定する問いが無ければセッションを作らない。
- Windows 以外ではトーストを出さず、レポートの場所と画面の URL を標準出力に出す。macOS / Linux で定期実行するときは、上の `gc` と同じ形の plist / unit を `eval --notify` 用と `feedback --notify` 用に 1 つずつ作り、gc より後の時刻に週 1 回走らせる。
- サーバー集約構成では、評価と通知はサーバー PC で行う。クライアント PC からは、SSH トンネルで転送した同じ URL (`http://127.0.0.1:7820/feedback/...`) を開く。

### フィードバックの画面

![フィードバックの画面 (日本語・一般向けの表示)。右上に一般向け・専門向けと、日本語・英語の切り替え。上に要約 (悪化の見張り・検索の質の点数・いまの設定が上だった問いの数・確かめ用の問いの数) とグラフ 4 つ、下に 10 問の判定の一覧と、1 問分の結果のカード (答えている / 一部 / 関係ない のボタン)。1 件目のカードは全文を開いている](docs/assets/feedback-screen.png)

画面の例 (ダミーのデータ、日本語・一般向けの表示で 1 件目の全文を開いたところ。英語の表示は [英語版の README](README.en.md#the-feedback-page) にある)。MCP サーバーのプロセスが、`/mcp` と同じポートの `/feedback/<セッション ID>?t=<合言葉>` で配る。外部の読み込みはせず、記憶の本文を外に出さない。

- 上の帯で、言語を日本語 (JA) と英語 (EN) から選べる。既定はブラウザーの言語 (日本語なら日本語、それ以外は英語)。画面の文言だけが切り替わり、問いや記憶のタイトル・本文は書かれた言語のまま出る。
- 上の帯で、表示を「一般向け」と「専門向け」から選べる (既定は一般向け)。言語とモードの選択はどちらもブラウザーが覚える。一般向けは専門用語を言い換え、専門向けは指標の名前のまま出す。

  | 専門向け | 一般向け |
  | --- | --- |
  | 本番 / 一次スコアだけ | いまの設定 / 内容の近さだけ |
  | nDCG@10 (0.864) | 検索の質 (86 / 100 点) |
  | ガード / 95% 区間 | 悪化の見張り / ぶれ幅 |
  | インターリービングの勝ち・負け・引き分け | いまの設定が良かった・内容の近さだけが良かった・差なし |
  | 評価セット / 実クエリ / 問われた時点 | 確かめ用の問い / 今週の問い / 調べた日時 |

  一般向けでは、符号検定の p 値とガードの理由を出さない。
- 上に、ガード・本番の nDCG@10・インターリービングの累計・評価セットの問い数の要約と、グラフ 4 つ (nDCG@10 の推移、ガードの差と 95% 区間、インターリービングの勝ち負け、正解の作成日の分布) が並ぶ。
- 判定は 1 回 10 問まで。その週にエージェントが実際に投げた問いのうち、2 つの構成で上位 10 件が違うものを優先し、足りなければ評価セットの人の判定が無い問いで埋める。
- 結果は、本番と一次スコアだけの順位を交互に混ぜた 10 件 (インターリービング) で、どちら由来かは伏せる。カードごとに「答えている / 一部 / 関係ない」を選び、必要なら「新しい版があり、これは古い」に印を付ける。
- カードの抜粋は検索の時点で 160 字に切られている。続きがあるカードには「全文を開く」が付き、開くと記憶の本文 (4,000 字まで) が出る。全文は、画面がデータを読むときに MCP サーバーが記憶のファイルから足す (セッションのファイルには入れない)。
- 1 件選ぶたびに下書きとして保存され、タブを閉じても続きから再開できる。
- 「確定して送る」で、判定が評価セットに出どころ「人」(セッション ID と時刻つき) として書かれ、インターリービングの勝ち負けがセッションに記録される。未判定の問いは判定なしとして扱う。確定したあとは直せない。
- URL の合言葉 (`t=`) が合わない要求は拒む。セッションを作る HTTP の道は無く、作れるのは CLI だけ。判定の書き込みは MCP のツールにもしていないので、エージェントが人の判定を名乗って書くことはできない。URL には合言葉が入るので、人に渡さない。

### アクセスに数えない

`sm eval` とフィードバックの画面は、core の検索と読み出しを直接呼ぶ。記憶を読んでも `access_count` と `last_accessed_at` は増えず、検索ログと get のログにも書かない。評価セットに入った記憶ほどアクセスの項で有利になる漏れを防ぎ、ログを「エージェントと人が実際に使った検索」だけに保つため。

## メモリファイルの書式

`memories/<scope>/<id>.md` に、YAML の front matter と本文を置く。ファイル名は `id` と一致させる。

| フィールド | 必須 | 内容 |
| --- | --- | --- |
| `id` | 必須 | ULID (26 文字)。ファイル名と一致させる |
| `title` | 必須 | 検索結果の 1 行表示に使う (200 字以内) |
| `scope` | 必須 | `global` / `project:<名前>` / `repo:<名前>` |
| `kind` | 必須 | `episodic` (出来事) / `semantic` (知識) |
| `provenance` | 必須 | `human_confirmed` / `agent_verified` / `agent_inferred` |
| `source_agent` | 必須 | `human` / `claude` / `codex` / `kimi` / `grok` |
| `created_at` | 必須 | 作成日 (ISO 8601) |
| `supersedes` | 任意 | 置き換える元メモリの `id` |
| `symbol_ref` | 任意 | Serena の `name_path` (コード関連のメモリのみ) |
| `tags` | 任意 | 任意の分類 (文字列の配列) |
| `source_path` | 任意 | 出典 (取り込み元の資料) のパス (1000 字以内) |
| `source_sha256` | 任意 | 出典の SHA-256 (64 桁の小文字 16 進) |

既存ファイルの本文は書き換えない。内容を更新するときは新しいファイルを作り、`supersedes` で元を指す。削除はファイル削除で行い、次の `index` で OpenSearch から消える。

## 保全の方針

| 対象 | 保全方法 | 失った場合 |
| --- | --- | --- |
| Markdown | 保存先に任せる (同期フォルダならクラウド側、private リポジトリなら push) | 復元できない。ここだけは必ず守る |
| 構築一式 (Dockerfile、マッピング、辞書、コード) | 同じリポジトリで Git 管理 | 同上 |
| SQLite の統計 | 保全しない (PC ごと) | 検索は動く。優先度の履歴が初期化される |
| OpenSearch のデータ | 保全しない | `pnpm sm reindex` で再生成 |
| 埋め込みキャッシュ | 保全しない | 再埋め込みの時間がかかるだけ |

## 運用ルール

- このリポジトリ (コード) は public。知識の本体は `memories_dir` の先に置き、ここにはコミットしない。
- 統計の SQLite は同期フォルダに置かない (同時に書くと壊れたり、競合ファイルができたりする)。
- 別の PC で書かれたメモリは同期で届くだけなので、`pnpm sm index` を流すとインデックスに入る。
- 秘密情報 (API キーなど) をメモリに書かない。埋め込みやリランクの API キーは、設定ファイルには環境変数の名前 (`api_key_env`) だけを書き、値はリポジトリルートの `.env` (Git 管理外) か環境変数に置く。
- ポートはすべて `127.0.0.1` 限定。バインド先を変えるなら、OpenSearch のセキュリティを有効に戻す (現在は認証なしで動かしている)。
- 埋め込みモデルやマッピングを変えるときは `pnpm sm reindex` で作り直す (新しいインデックスを作ってエイリアスを付け替える)。埋め込みの設定を変えたのに作り直していなければ、`index` が指紋の違いで止まって知らせる。

## テスト

```powershell
pnpm test        # 単体テスト (外部サービス不要)
pnpm test:int    # 結合テスト (OpenSearch と Ollama の起動が必要)
pnpm typecheck   # 型チェック
```

結合テストは `loadConfig()` の接続先 (`config.yaml` に `config.local.yaml` を重ねたもの) を使う。SSH トンネルなどで接続先を変えているときは、`config.local.yaml` の `opensearch.url` と `embedding.url` を合わせておく。テスト用のインデックスは `test-` で始まる名前で作り、終わったら消す。
