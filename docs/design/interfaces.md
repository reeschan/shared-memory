# 実装の契約 (モジュール間インターフェース)

`docs/design/design.md`(設計書) を実装するときの、パッケージ間の取り決め。各 PBI はここに書かれた名前・型・挙動に従う。ここに無いものを他モジュールから呼ばない。

> 実装の前に書いた契約。コードはおおむねこのとおりだが、実装時に足したものがある。食い違ったらコードが正。
> - 型の追加: `TierDeps` (`{ os, stats }`)、`ImportPlan` / `ImportLineError`
> - `Embedder` は interface で、`createEmbedder(cfg, cacheDir, opts?)` が返す。`Reranker` は `createReranker(cfg)` が返し、無効なら `undefined`。`SearchResult.rerank_score` はリランクした候補にだけ付く
> - MCP の `get` の返り値は `{ meta, path, body }` (front matter は `meta`)。Host ヘッダーは `[::1]:<port>` も許可する。応答は SSE ではなく JSON
> - CLI の `import` は、エラーがあると書き込まずに終了コード 1。`--json` のときはエラーも `{"error": ...}` の JSON で出す
> - 結合テストのインデックス名は `test-<name>-<乱数>-idx` (エイリアスと同じ名前にはできないため)
> - `pnpm test` は `*.int.test.ts` を除く単体テストだけを流す
> - 設計からの変更と具体値は design.md の12章にまとめた

## 0. 共通の前提

- Node 26 の型ストリップで TypeScript を**ビルドせずに**実行する。`node packages/indexer/src/cli.ts` のように直接動かす。
  - `tsconfig.base.json` は `erasableSyntaxOnly: true`, `allowImportingTsExtensions: true`, `noEmit: true`, `module/moduleResolution: nodenext`, `strict: true`, `verbatimModuleSyntax: true`。
  - 相対 import は拡張子 `.ts` まで書く (`import { x } from "./config.ts"`)。型だけの import は `import type`。
  - `enum`・`namespace`・パラメータプロパティ (`constructor(private x)`) は使わない (型ストリップできない)。
- パッケージ: `@shared-memory/core` (packages/core)、`@shared-memory/indexer` (packages/indexer)、`@shared-memory/mcp-server` (packages/mcp-server)。すべて `"type": "module"`。core は `"exports": {".": "./src/index.ts"}` で、`src/index.ts` が下記モジュールを再エクスポートする。
- 依存: core = `yaml`, `ulid`。mcp-server = `@modelcontextprotocol/sdk`, `zod`。OpenSearch と Ollama は `fetch` で直接呼ぶ (クライアントライブラリは使わない)。SQLite は組み込みの `node:sqlite` (`DatabaseSync`)。
- テスト: `node --test --test-reporter=tap <files>`。テストファイルは各パッケージの `test/*.test.ts`。外部サービス (OpenSearch/Ollama) を使うテストは `test/*.int.test.ts` とし、単体テストと分ける。
- 型チェック: ルートで `pnpm typecheck` (= `tsc -p tsconfig.json`)。
- パス表記: Memory の `path` はリポジトリルートからの相対・区切りは `/` (例 `memories/global/01J....md`)。

## 1. config.yaml と `config.ts`

```yaml
memories_dir: memories
state_db: state/stats.sqlite
cache_dir: .cache/embeddings
opensearch:
  url: http://127.0.0.1:9200
  alias: memories
  index_base: memories-qwen3-0.6b-v1
  template_file: opensearch/index-template.json
  pipeline_name: memories-hybrid
  pipeline_file: opensearch/search-pipeline.json
embedding:
  provider: ollama          # ollama / openai
  url: http://127.0.0.1:11434
  model: qwen3-embedding:0.6b
  dimension: 1024
  batch_size: 16
  normalize: true
  revision: 0
  # rpm: 60
  # api_key_env: EMBEDDING_API_KEY
  query:
    prefix: "Instruct: Given a question or keywords, retrieve memory notes that answer or relate to it\nQuery: "
    params: {}
  document: { prefix: "", params: {} }
rerank:
  enabled: false
  flavor: cohere            # cohere / voyage / tei / sarashina
  url: ""
  model: ""
  # path: /custom/rerank
  # api_key_env: RERANK_API_KEY
  candidates: 20
  max_docs_per_request: 0   # 0 なら flavor の既定 (tei 32 / sarashina 20)
  doc_max_chars: 2000
  timeout_ms: 3000
chunk:
  min_chars: 400
  max_chars: 800
search:
  candidates: 50
  default_limit: 8
  weights: { bm25: 0.4, knn: 0.6 }
  searchable_tiers: [hot, warm]
  half_life_days: { hot: 30, warm: 60, cold: 120, archive: 365 }
  provenance_factor: { human_confirmed: 1.0, agent_verified: 0.85, agent_inferred: 0.7 }
  rescore: { decay_floor: 0.7, access_weight: 0.2 }
tiers:
  warm_after_days: 7
  cold_after_days: 30
  archive_after_days: 180
mcp:
  host: 127.0.0.1
  port: 7820
  path: /mcp
repos: {}   # gc の symbol_ref 確認用。リポジトリ名 -> ローカルの絶対パス
```

`packages/core/src/config.ts`:

- `export type Config` … 上の YAML と同じキー (snake_case のまま) に加え `root: string` (リポジトリルートの絶対パス)。`memories_dir` / `state_db` / `cache_dir` / `opensearch.template_file` / `opensearch.pipeline_file` は読み込み時に**絶対パスへ解決済み**の値を入れる。`search.rescore` の既定は `decay_floor: 0.7` / `access_weight: 0.2`。
- `export function findRoot(start?: string): string` … `start` (既定 `process.env.SHARED_MEMORY_ROOT ?? process.cwd()`) から親へたどり、`config.yaml` と `pnpm-workspace.yaml` が両方ある最初のディレクトリを返す。見つからなければ throw。
- `export function loadConfig(root?: string): Config` … `root` 省略時は `findRoot()`。必須キーが欠けていたら throw。
- `embedding` と `rerank` は読み込み時に正規化する。`embedding` の既定は `provider: ollama`・`normalize: true`・`revision: 0`・`extra_body: {}`、`query` / `document` は `{prefix: "", params: {}}`。旧キー `embedding.query_instruction` は、`embedding.query.prefix` が無いときだけ `query.prefix` として読む。`rerank` の既定は `enabled: false`・`flavor: cohere`・`url: ""`・`model: ""`・`candidates: 20`・`max_docs_per_request: 0`・`doc_max_chars: 2000`・`timeout_ms: 3000`。`rerank.enabled` のときは `url` と `model` が必須。列挙値・数値・型が不正なら日本語のエラーで throw する。
- `loadConfig` は最初に `<root>/.env` を読み、まだ設定されていない環境変数だけを `process.env` に入れる。`api_key_env` が書かれていて `resolveApiKey(name)` が undefined なら throw (値をエラーに出さない)。`rerank.api_key_env` は `rerank.enabled` のときだけ確かめる。API キーの値は `resolveApiKey(name?)` で取り出す。

## 2. front matter と `frontmatter.ts`

- 定数: `KINDS = ["episodic","semantic"]`, `PROVENANCES = ["human_confirmed","agent_verified","agent_inferred"]`, `SOURCE_AGENTS = ["human","claude","codex","kimi","grok"]`, `TIERS = ["hot","warm","cold","archive"]` (すべて `as const`)。対応する型 `Kind` `Provenance` `SourceAgent` `Tier`。
- `export type MemoryMeta = { id; title; scope; kind; provenance; source_agent; created_at; supersedes?; symbol_ref?; tags?: string[] }` (文字列型は上の型を使う)。
- `export type Memory = MemoryMeta & { body: string; path: string }`
- スコープ: `global` / `project:<name>` / `repo:<name>`、`<name>` は `/^[A-Za-z0-9._-]+$/`。
  - `export function scopeToDir(scope: string): string` … `global`→`global`, `project:foo`→`project/foo`, `repo:bar`→`repo/bar`。不正なら throw。
- `export function validateMeta(meta: unknown): string[]` … エラーメッセージの配列 (空なら妥当)。検査: 必須 7 項目の有無と型、列挙値、`id` が ULID (`/^[0-9A-HJKMNP-TV-Z]{26}$/`)、`created_at` が `Date.parse` 可能な ISO 8601、`tags` は文字列配列、`supersedes` は ULID、`title` は空でない 200 字以内。
- `export function parseMemoryFile(text: string, relPath: string): { ok: true; memory: Memory } | { ok: false; errors: string[] }` … `---` で囲まれた YAML front matter を `yaml` で読み、`validateMeta` に加えて「ファイル名 (拡張子除く) = id」「`relPath` が `memories/<scopeToDir(scope)>/<id>.md`」を検査する。本文は front matter 直後の空行を除いた残り (末尾の改行は trim)。YAML が日付を Date 型に変える場合に備え、`created_at` は ISO 文字列に正規化する。
- `export function serializeMemory(meta: MemoryMeta, body: string): string` … `---\n<YAML>---\n\n<body>\n`。キー順は id, title, scope, kind, provenance, source_agent, created_at, supersedes, symbol_ref, tags。undefined のキーは出さない。`parseMemoryFile(serializeMemory(m, b), path)` で元に戻ること。
- `export function memoryRelPath(meta: Pick<MemoryMeta,"id"|"scope">, memoriesDirName = "memories"): string` … `memories/<scopeToDir>/<id>.md`。

## 3. `secrets.ts`

- `export function findSecrets(text: string): string[]` … 当てはまったパターン名の配列 (重複なし)。最低限: AWS アクセスキー (`AKIA[0-9A-Z]{16}`)、GitHub トークン (`gh[pousr]_[A-Za-z0-9]{36,}`, `github_pat_`)、OpenAI/Anthropic 形式 (`sk-[A-Za-z0-9_-]{20,}`, `sk-ant-`)、Slack (`xox[baprs]-`)、秘密鍵ブロック (`-----BEGIN [A-Z ]*PRIVATE KEY-----`)、Google API キー (`AIza[0-9A-Za-z_-]{35}`)、`(api[_-]?key|secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9_\-/+]{16,}` (大文字小文字無視)。

## 4. `chunk.ts`

- `export type Chunk = { chunk_no: number; text: string }`
- `export function chunkMemory(title: string, body: string, opts: { min_chars: number; max_chars: number }): Chunk[]`
  - 見出し行 (`^#{1,6}\s`) で節に分ける。コードフェンス (```) 内の `#` は見出しとみなさない。
  - `max_chars` を超える節は段落 (空行) 区切りで、`min_chars`〜`max_chars` を目安に詰めて分ける。1 段落が `max_chars` を超えるときは `max_chars` で機械的に切る。
  - `min_chars` 未満の短い節は次の節と結合してよい (最後の節は前と結合)。
  - 各チャンクの `text` は `"<title>\n\n<本文片>"`。本文が空なら title だけのチャンクを 1 つ返す。`chunk_no` は 0 始まりの連番。
- `export function sha256(s: string): string` … 16 進。
- `export function contentHash(chunkText: string, meta: MemoryMeta, path: string): string` … `sha256(chunkText + "\n" + JSON.stringify({title, scope, kind, provenance, source_agent, created_at, supersedes ?? null, symbol_ref ?? null, tags: [...(tags ?? [])].sort(), path}))`。メタデータが変わっても再投入されるようにするため。

## 5. `embed.ts` と `rerank.ts`

### `embed.ts`

- `export interface Embedder` … `readonly fingerprint: string` (埋め込みの指紋)・`readonly dimension: number`・`embedDocuments(items: { hash; text }[]): Promise<{ vectors; cached; embedded }>`・`embedQuery(query): Promise<number[]>`。
- `export function createEmbedder(cfg: Config["embedding"], cacheDir: string, opts?: { fetch?; sleep? }): Embedder` … `provider` に応じた実装を返す。`ollama` は `POST <url>/api/embed` に `{model, input: string[], ...extra_body, ...params}` を送り、`embeddings` を読む。`openai` は `POST <url>/embeddings` に同じ形で送り、`data[].embedding` を `index` の順に並べて読む。`api_key_env` があれば `Authorization: Bearer <値>` を付ける (値はログやエラーに出さない)。
- `embedDocuments` … キャッシュ `<cacheDir>/<指紋>/<hash の先頭2文字>/<hash>.json` (中身は数値配列の JSON) にあれば使い、無いものだけを `batch_size` ずつ送る。文書側は `document.prefix + text` と `document.params` を使う。`rpm` があれば前回の送信から `60000 / rpm` ms 空ける。429・5xx は待って最大 3 回再試行する。
- `embedQuery` … `query.prefix + query` と `query.params` で埋め込む。キャッシュせず、再試行もしない。
- 応答の件数が入力と違うとき、または次元が `cfg.dimension` と違うときは throw する。`normalize: true` (既定) なら L2 正規化してから返す。
- `export function embeddingFingerprint(cfg): string` … `sha256(安定 JSON(fingerprintParts(cfg)))` の先頭 16 桁。`export function fingerprintParts(cfg): Record<string, unknown>` … `provider`・`model`・`dimension`・`normalize`・`revision`・`query`・`document`・`extra_body`。`url`・`api_key_env`・`batch_size`・`rpm` は含めない (ADR 0001)。
- `export const LEGACY_EMBEDDING: Config["embedding"]` … 今の Qwen3 の既定。`_meta` に指紋が無い既存インデックスはこの指紋とみなし、指紋がこれと同じときだけ旧キャッシュ (`<cacheDir>/<モデル名の英数字以外を _ に置換>/…`) も読む。

### `rerank.ts`

- `export type RerankHit = { index: number; score: number }`
- `export interface Reranker` … `rerank(query: string, documents: string[]): Promise<RerankHit[]>`。score の降順で全文書分を返す。失敗時は throw し、フォールバックは呼び出し側 (`searchMemories`) が行う。
- `export function createReranker(cfg: Config["rerank"], opts?: { fetch? }): Reranker | undefined` … `enabled: false` なら `undefined`。
- flavor ごとの送り先と読み取り: `cohere` は `<url>/v1/rerank` に `{model, query, documents, top_n, ...extra_body}` を送り `results[].relevance_score` を読む。`voyage` は `<url>/v1/rerank` に `{model, query, documents, top_k, ...extra_body}` を送り `data[].relevance_score` を読む。`tei` は `<url>/rerank` に `{query, texts, ...extra_body}` を送り `[{index, score}]` を読む。`sarashina` は `<url>/rerank` に `{model, query, documents, ...extra_body}` を送り `data[0].result[]` の `document_id` と `relevance_score` (無ければ `score`) を読む。`path` でパスを上書きできる。
- 1 リクエストの上限は `max_docs_per_request` (0 なら flavor の既定: cohere / voyage 1000、tei 32、sarashina 20)。超える件数は分けて送り、返った index にオフセットを足して統合する。本文は `doc_max_chars` で切る。
- 1 リクエストは `timeout_ms` で打ち切る (`AbortSignal.timeout`)。HTTP エラー・タイムアウト・応答の形が不正は throw。返ってこなかった文書は最下位として全文書分を揃える。

## 6. `opensearch.ts`

- `export class OpenSearchClient` … `constructor(url: string)`。すべて `fetch`。非 2xx は `Error("OpenSearch <method> <path> <status>: <body>")` を throw (ただし下記で 404 を値として扱うものを除く)。
  - `request<T = any>(method: string, path: string, body?: unknown): Promise<T>` (body はオブジェクトなら JSON、文字列ならそのまま。bulk 用に `Content-Type: application/x-ndjson` を指定できる第 4 引数 `contentType?`)
  - `indexExists(name): Promise<boolean>` (HEAD, 404→false)
  - `createIndex(name, body: object): Promise<void>` / `deleteIndex(name): Promise<void>`
  - `getAliasTargets(alias): Promise<string[]>` (404→[])
  - `swapAlias(alias, newIndex, oldIndices: string[]): Promise<void>` (`POST /_aliases` で remove と add を 1 回で)
  - `bulk(lines: object[], refresh = false): Promise<{ errors: boolean; failed: { id: string; error: unknown }[] }>` (NDJSON にして末尾改行を付けて送る。空配列なら何もしない)
  - `search<T = any>(index, body, params?: Record<string,string>): Promise<{ hits: { _id: string; _score: number; _source: T }[] }>` (`hits.hits` を返す)
  - `scanAll<T = any>(index, query: object, sourceFields: string[]): Promise<{ _id: string; _source: T }[]>` (scroll API で全件。インデックスが無ければ [])
  - `updateByQuery(index, query: object, script: { source: string; params?: object }, refresh = true): Promise<number>` (更新件数)
  - `putSearchPipeline(name, body: object): Promise<void>`
  - `refresh(index): Promise<void>`

## 7. `stats.ts`

- `export type Stat = { memory_id: string; access_count: number; last_accessed_at: string | null; tier: Tier }`
- `export class StatsStore` … `constructor(dbPath: string)` (親ディレクトリが無ければ作る。`CREATE TABLE IF NOT EXISTS` で設計書 3.2 のテーブル)
  - `get(id): Stat | undefined` / `all(): Map<string, Stat>`
  - `recordAccess(id, nowIso: string): Stat` … 行が無ければ作る。count+1、last=now、tier='hot'
  - `setTiers(entries: { memory_id: string; tier: Tier }[]): void` … 1 トランザクションで upsert (count と last は保持)
  - `close(): void`

## 8. `indexing.ts` (インデクサ本体。CLI と MCP の write が共有)

- `export type Deps = { os: OpenSearchClient; embedder: Embedder; stats: StatsStore }`
- `export async function scanMemories(cfg): Promise<{ memories: Memory[]; invalid: { path: string; errors: string[] }[] }>` … `memories_dir` 配下の `**/*.md` を読み `parseMemoryFile`。
- `export function computeSuperseded(memories: Memory[]): Set<string>` … どれかの `supersedes` に指されている id の集合。
- `export async function ensureSetup(cfg, os): Promise<{ createdIndex?: string }>` … エイリアスが無ければ `index_base` を `template_file` の内容で作ってエイリアスを張る。毎回 `pipeline_file` を読み、`phase_results_processors[0]["normalization-processor"].combination.parameters.weights` を `[search.weights.bm25, search.weights.knn]` に差し替えて `putSearchPipeline`。
- ドキュメント: `_id` = `"<memory_id>:<chunk_no>"`。`_source` は設計書 3.3 のマッピングの全フィールド。`access_count` / `last_accessed_at` / `tier` は StatsStore から (行が無ければ 0 / null / "hot")。
- `export type IndexReport = { scanned: number; invalid: { path: string; errors: string[] }[]; embedded: number; cached: number; upserted: number; updated: number; deleted: number }`
- `export async function indexIncremental(cfg, deps, opts?: { only?: string[]; index?: string }): Promise<IndexReport>` … 設計書 6.1 の手順。
  1. 全件を `scanMemories` (is_superseded の算出に全件が要るため)。
  2. 既存ドキュメントを `scanAll` (`memory_id, content_hash, is_superseded, tier, access_count, last_accessed_at`)。
  3. 対象 (`only` があればそのパスのメモリだけ、無ければ全件) のチャンクを作り、`content_hash` が既存と違うか無いチャンクだけ埋め込んで `index` 操作。
  4. ハッシュが同じチャンクは、`is_superseded` / `tier` / `access_count` / `last_accessed_at` が現在値と違うときだけ `update` (部分更新)。`only` 指定時もこの部分更新は全件に対して行う (supersedes の連鎖を反映するため)。
  5. 対象メモリの既存ドキュメントのうち新しいチャンク集合に無いもの、および (`only` 無しのとき) ファイルが無くなったメモリのドキュメントを `delete`。
  6. bulk は最後に `refresh=true`。`index` 省略時はエイリアス名に書く。
- `export async function reindexAll(cfg, deps, opts?: { keepOld?: boolean }): Promise<IndexReport & { index: string }>` … 新インデックス名 = エイリアスが未作成なら `index_base`、あれば `<index_base>-r<YYYYMMDDHHmmss>`。テンプレートで作成→`indexIncremental(cfg, deps, { index: 新名 })`→`swapAlias`→`keepOld` でなければ旧インデックスを削除。パイプラインも `ensureSetup` と同じく投入する。

## 9. `search.ts`

- `export type SearchInput = { query: string; scope?: string; kind?: Kind; tags?: string[]; limit?: number }`
- `export type SearchResult = { id: string; title: string; excerpt: string; score: number; scope: string; kind: Kind; provenance: Provenance; created_at: string; rerank_score?: number }` … `score` は rescore 後のスコア (意味は今までと同じ)。`rerank_score` はリランクした候補にだけ付くリランカーの点数。
- `export function buildFilter(cfg, input): object[]` … `term is_superseded:false`、`terms tier: searchable_tiers`、指定時のみ `term scope` / `term kind` / `terms tags`。
- `export function buildHybridQuery(cfg, input, vector: number[]): object` … `size = search.candidates`、`_source.excludes = ["embedding"]`、`query.hybrid.queries = [ {bool: {must: {multi_match: {query, fields: ["title^2","content"]}}, filter}}, {knn: {embedding: {vector, k: candidates, filter: {bool: {filter}}}}} ]`。順序は BM25 → kNN (パイプラインの weights の順と対応)。
- `export function rescore(hybridScore: number, src: {last_accessed_at?: string|null; created_at: string; access_count?: number; tier?: Tier; provenance: Provenance}, cfg, now: Date): number` … `(decay_floor + (1 - decay_floor) × 減衰) × (1 + access_weight × ln(1 + アクセス回数)) × 出所の係数`。減衰 = `0.5 ** (経過日数 / half_life_days[tier])`、経過日数は `last_accessed_at ?? created_at` から (負なら 0)。`decay_floor` と `access_weight` は `search.rescore` (既定 0.7 / 0.2)。
- `export async function searchMemories(cfg, deps: { os; embedder: Embedder; reranker?: Reranker; log?: (msg: string) => void }, input, now = new Date()): Promise<SearchResult[]>` … クエリ埋め込み → `os.search(alias, buildHybridQuery(...), { search_pipeline: pipeline_name })` → 各ヒットを `rescore` → `memory_id` ごとに一次スコア最大のチャンクを代表にまとめる。
  - `reranker` が無ければ、rescore の降順で `limit ?? default_limit` 件を返す。
  - `reranker` があれば、候補は一次スコア上位 `rerank.candidates` 件。代表チャンクの本文を渡し、返った点数の降順に候補を並べる。点が返ってこなかった候補と候補外のメモリは一次スコアの降順で後ろにつなぎ、最後に `limit` で切る。リランクした候補には `rerank_score` を付け、`score` は rescore 後の値のまま (ADR 0002: リランクの順位に rescore は掛け直さない)。
  - リランクが throw したときは `log` に 1 回メッセージを渡し、リランクなしの rescore 順で返す。検索は止めない。
  - `excerpt` は代表チャンクの content から先頭の `"<title>\n\n"` を除き、改行を空白にした先頭 160 字。

## 10. `memory-store.ts`

- `export type WriteInput = { title; content; scope; kind; provenance; source_agent; supersedes?; symbol_ref?; tags? }`
- `export function findMemoryPath(cfg, id): string | undefined` … `memories_dir` 配下から `<id>.md` を探し、絶対パスを返す。
- `export async function readMemory(cfg, id): Promise<Memory | undefined>`
- `export function prepareMemory(input: WriteInput, opts: { now: Date; existingIds: Set<string> }): { ok: true; meta: MemoryMeta; body: string } | { ok: false; errors: string[] }` … ULID を採番 (`ulid` パッケージの `ulid()`)、`created_at = now.toISOString()`、`validateMeta`、`findSecrets(title + "\n" + content)` が空でなければエラー (「秘密情報らしき文字列: <名前>」)、`supersedes` が `existingIds` に無ければエラー、`content` が空ならエラー。
- `export async function writeMemory(cfg, deps, input, now = new Date()): Promise<{ id: string; path: string }>` … 既存 id 集合を `scanMemories` で作り `prepareMemory`、失敗なら `Error(errors.join("; "))`。ファイルを `memoryRelPath` に `serializeMemory` で書く (ディレクトリは作る。既存ファイルは上書きしない)。`indexIncremental(cfg, deps, { only: [path] })`。
- `export async function recordAccess(cfg, deps: { os; stats }, id, now = new Date()): Promise<Stat>` … `stats.recordAccess` の後、`updateByQuery(alias, {term: {memory_id: id}}, ...)` で `access_count` / `last_accessed_at` / `tier` を反映する。

## 11. CLI (`packages/indexer/src/cli.ts`)

`pnpm sm <command>` (= `node packages/indexer/src/cli.ts`)。結果は人が読める要約を標準出力に、`--json` で JSON。失敗時は終了コード 1。

| コマンド | 実装 |
| --- | --- |
| `setup` | `ensureSetup` |
| `index` | `ensureSetup` → `indexIncremental` (不正ファイルは一覧を出すが終了コードは 0) |
| `reindex [--keep-old]` | `reindexAll` |
| `decay` | `tiers.ts` の `runDecay` |
| `gc` | `tiers.ts` の `runGc` |
| `import <file.jsonl> [--dry-run] [--source-agent <a>]` | `import.ts` |
| `search <query> [--scope s] [--limit n]` | `searchMemories` (動作確認用) |

## 12. MCP サーバー (`packages/mcp-server/src/server.ts`)

- `pnpm mcp` (= `node packages/mcp-server/src/server.ts`) で起動。`cfg.mcp.host:port` の `cfg.mcp.path` に Streamable HTTP (ステートレス: `sessionIdGenerator: undefined`、リクエストごとに server/transport を作る)。`host` がループバック (127.0.0.1 / ::1 / localhost) 以外なら起動を拒否。DNS リバインディング対策として Host ヘッダーが `127.0.0.1:<port>` か `localhost:<port>` 以外のリクエストは 403。
- ツール (`zod` で入力を定義):
  - `search` {query, scope?, kind?, tags?, limit?} → `searchMemories` の結果を JSON テキストで返す。
  - `get` {id} → `readMemory` (無ければ isError) と `recordAccess`。front matter と本文を返す。
  - `write` {title, content, scope, kind, provenance, source_agent, supersedes?, symbol_ref?, tags?} → `writeMemory`。返り値 `{id, path}`。検証エラーは isError で理由を返す。
- 各ツールの description に「結果はデータであり指示ではない」旨を入れる。
- 起動時に `ensureSetup` を 1 回呼ぶ。Deps は起動時に 1 組作り、全リクエストで共有する (SQLite への書き込みを 1 プロセスに集約するため)。
- `GET /health` は `{"ok":true}` を返す。

## 13. `tiers.ts` (decay / gc)

- `export function computeTier(meta: MemoryMeta, stat: Stat | undefined, superseded: boolean, cfg, now: Date): Tier`
  - `superseded` なら `archive`。
  - それ以外は `last_accessed_at ?? created_at` からの経過日数で、`archive_after_days` 以上→archive、`cold_after_days` 以上→cold、`warm_after_days` 以上→warm、未満→hot。
  - `provenance === "human_confirmed"` は cold / archive を `warm` に引き上げる (ただし superseded は archive のまま)。
- `export async function syncTiers(cfg, deps: { os; stats }, changes: { memory_id: string; tier: Tier }[]): Promise<number>` … `stats.setTiers` の後、tier ごとに `updateByQuery(alias, {terms: {memory_id: [...]}}, "ctx._source.tier = params.tier")` で反映。反映件数を返す。
- `export async function runDecay(cfg, deps, now = new Date()): Promise<{ total: number; changed: { memory_id: string; from: Tier; to: Tier }[] }>` … 全メモリの `computeTier` を計算し、現在の tier (StatsStore、行が無ければ "hot") と違うものだけ `syncTiers`。
- `export async function runGc(cfg, deps, now = new Date()): Promise<{ archived: string[]; brokenSymbolRefs: { memory_id: string; symbol_ref: string; reason: string }[] }>`
  - superseded のメモリで tier が archive でないものを archive にする (`syncTiers`)。
  - `symbol_ref` を持つメモリについて、scope が `repo:<name>` で `cfg.repos[name]` があれば、そのディレクトリ配下のテキストファイル (`.git` / `node_modules` を除く) に `symbol_ref` の最後の `/` 以降の名前が現れるかを調べ、無ければ `brokenSymbolRefs` に入れる。`cfg.repos[name]` が無ければ reason「repos に未登録」で入れる。ファイルは消さない。

## 14. `import.ts` (まとめ入力)

- 入力は JSONL。1 行 = `WriteInput` (`provenance` 省略時は `agent_verified`、`source_agent` 省略時は CLI の `--source-agent`、それも無ければエラー)。
- `export function parseImportJsonl(text: string, defaults: { source_agent?: SourceAgent }): { inputs: { line: number; input: WriteInput }[]; errors: { line: number; errors: string[] }[] }` … JSON として読めない行、必須欠け。
- `export async function planImport(cfg, inputs, now = new Date()): Promise<{ ok: { line: number; meta: MemoryMeta; body: string }[]; errors: { line: number; errors: string[] }[] }>` … `scanMemories` の既存 id 集合で各行を `prepareMemory`。同じバッチ内で `title`+`content` が完全一致する重複行はエラーにする。
- `export async function commitImport(cfg, deps, plan): Promise<{ created: { id: string; path: string }[]; report: IndexReport }>` … 全ファイルを書いてから `indexIncremental(cfg, deps)` を**1 回だけ**呼ぶ。
- CLI の `import --dry-run` は planImport までを行い、新規 / 置き換え (supersedes あり) / エラーの件数と各行の title を表示する。エラーが 1 件でもあれば dry-run でなくても書き込まずに終了コード 1。
