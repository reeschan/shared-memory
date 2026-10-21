# 埋め込みプロバイダーとリランカーの切り替え、Mac/Linux の手順、出典の記録

状態: 合意済み (2026-10-21)。用語は [GLOSSARY.md](../../GLOSSARY.md)、関連する決定は [ADR 0001](../adr/0001-embedding-fingerprint-excludes-url.md) と [ADR 0002](../adr/0002-rerank-before-rescore.md)。

## Problem Statement

shared-memory の埋め込みは Ollama の `/api/embed` に固定されている。ほかのモデルやサーバー (LM Studio、vLLM、TEI、OpenAI、Sarashina など) を試すにはコードを変えるしかない。また、モデルを替えても派生インデックスとキャッシュがそれを見分けないため、次元が同じなら新旧のベクトルが黙って混ざる。

検索にはリランクが無い。lab では Sarashina3 rerank が nDCG@10 を +0.03〜0.05 上げたが、本番では使えず、モデルを選ぶこともできない。一方で、本番の rescore だけで nDCG@10 が 0.884 から 0.694 に下がっていることも分かっている。

セットアップの手順は Windows 前提で、Mac や Linux の PC では何をすればよいか分からない。

メモリは正本として保全されているが、メモリを切り出した出典 (取り込み元の資料) は本文末尾の「出典: パス」という慣習でしか追えない。元ファイルが動いたり書き換わったりしても気づけない。

## Solution

- 埋め込みプロバイダーを、設定の `provider` (`ollama` / `openai`)・`url`・`model` などで選べるようにする。API キーは環境変数の名前だけを設定に書く。
- 派生インデックスに埋め込みの指紋を記録し、設定と違えば `index` を止めて `reindex` を促す。
- 検索に、任意で有効にできるリランクを入れる。リランカーは `flavor`・`url`・`model` で選ぶ。既定は無効で、失敗したらリランクなしの順位を返す。
- rescore を弱める (soft)。
- README を、Windows / Mac / Linux の単体構成と、Mac / Linux からのクライアント構成で読めるように整える。
- メモリの front matter に、任意の `source_path` と `source_sha256` を足す。

## User Stories

1. 利用者として、`config.local.yaml` で埋め込みの `url` と `model` を書き換えるだけで別のモデルを使いたい。コードを触らずに試せるようにするため。
2. 利用者として、LM Studio・vLLM・llama.cpp・TEI・Infinity などの OpenAI 互換サーバーを `provider: openai` で使いたい。手元の環境に合うサーバーを選べるようにするため。
3. 利用者として、Sarashina・OpenAI・Voyage・Jina の埋め込み API を、追加パラメーター (`task_type` など) 付きで使いたい。API ごとの癖に合わせられるようにするため。
4. 利用者として、クエリと文書で別々の前置き文と追加パラメーターを設定したい。Qwen3 の Instruction や Sarashina の `task_type` を正しく渡せるようにするため。
5. 利用者として、API キーを設定ファイルに書かずに、`.env` か環境変数で渡したい。キーを Git や同期フォルダに載せないため。
6. 利用者として、何も設定しなければ今までどおりローカルの Ollama と Qwen3 で動いてほしい。既存の環境を壊さないため。
7. 利用者として、今の `config.local.yaml` (`query_instruction` を使っているもの) を直さずに動き続けてほしい。移行の手間を省くため。
8. 運用者として、埋め込みの設定を変えたあとに `index` を流したら、新旧のベクトルを混ぜる前に止まってほしい。検索の質が黙って壊れるのを防ぐため。
9. 運用者として、止まったときに `pnpm sm reindex` を流せばよいと分かるメッセージがほしい。次の一手に迷わないため。
10. 運用者として、SSH トンネル経由と直接接続で URL が違っても、同じモデルなら同じものとして扱ってほしい。サーバー集約構成で誤って止まらないため。
11. 運用者として、同じ名前で中身が違うモデルに替えたときは、`revision` を上げれば別物として扱ってほしい。名前だけでは区別できない場合に備えるため。
12. 運用者として、今の Qwen3 の埋め込みキャッシュを新しいキャッシュの形に引き継ぎたい。全件の再埋め込みを避けるため。
13. 運用者として、外部 API で全件を作り直すとき、RPM の上限内で送られ、429 や 5xx では待って再試行してほしい。途中で落ちないようにするため。
14. 運用者として、サーバーが返したベクトルの次元が設定と違えばすぐにエラーにしてほしい。誤った設定に早く気づくため。
15. 運用者として、正規化されていないベクトルを返すモデル (Sarashina など) でも、cosine で正しく検索できてほしい。モデルの違いを意識しないで済むため。
16. 利用者として、`config.local.yaml` で `rerank.enabled: true` にするだけでリランクを有効にしたい。検索の質を上げるため。
17. 利用者として、Sarashina・Cohere・Jina・Voyage・TEI・Infinity・vLLM・llama.cpp のリランカーを `flavor` で選びたい。手に入るリランカーを使えるようにするため。
18. 利用者として、ローカルのリランカー (TEI で動かす bge-reranker-v2-m3 や ruri-v3-reranker) を docker-compose で起動したい。本文を外に出さずにリランクするため。
19. 利用者として、リランカーが落ちていたり遅かったりしても、検索はリランクなしで返ってきてほしい。リランカーの不調で検索が止まらないようにするため。
20. 利用者として、リランクが失敗したことをログで知りたい。黙って質が落ちたままにしないため。
21. 利用者として、検索結果の `score` の意味は今までどおりで、リランクの点数は `rerank_score` で見たい。既存の利用者の解釈を変えないため。
22. 利用者として、リランクの候補数・本文の長さ・タイムアウトを設定で変えたい。遅延と質の釣り合いを調整するため。
23. 利用者として、リランクを無効にしているときも、rescore で正解が大きく沈まないようにしてほしい。リランク無しでも検索の質を保つため。
24. 利用者として、外部 API に本文を送る設定は自分で明示したときだけ有効になってほしい。知らないうちに本文が外に出ないようにするため。
25. 利用者として、Sarashina の無償ベータでは送った内容が改善に使われうることを README で知りたい。送るかどうかを判断するため。
26. Mac の利用者として、README の手順どおりに Docker・Ollama・Node 26・pnpm を入れて、単体構成を立ち上げたい。Windows 以外でも使えるようにするため。
27. Linux の利用者として、同じく単体構成を立ち上げ、必要なら `vm.max_map_count` を設定したい。OpenSearch を安定して動かすため。
28. Mac / Linux の利用者として、Windows のサーバー PC へ SSH トンネルを張るクライアント構成で使いたい。サーバー PC に集約した知識を使うため。
29. Mac / Linux の利用者として、MCP サーバーの常駐と `decay` / `gc` の定期実行を、launchd / systemd の雛形を見て設定したい。Windows のタスクスケジューラの代わりにするため。
30. Mac / Linux の利用者として、mcp-setup の Skill が `register.ps1` を使わずに手順で登録してくれてほしい。pwsh を入れずに済ませるため。
31. Mac / Linux の利用者として、`SHARED_MEMORY_ROOT` でリポジトリの場所を指定すれば Skill が動いてほしい。Windows の固定パスに縛られないため。
32. 利用者として、サーバー集約構成と自動配布が Windows のサーバー PC 限定だと README で分かるようにしたい。Mac / Linux で試して詰まらないようにするため。
33. 取り込みを行うエージェントとして、ファイルから取り込んだメモリに `source_path` と `source_sha256` を付けたい。出典をたどれるようにするため。
34. 運用者として、出典のハッシュを見て、元ファイルが書き換わったか分かるようにしたい。メモリが古くなっていないか判断するため。
35. エージェントとして、MCP の `write` と CLI の `import` でも `source_path` / `source_sha256` を任意で渡したい。どの経路でも出典を残せるようにするため。
36. 利用者として、出典の項目を付けないメモリも今までどおり有効であってほしい。既存のメモリを書き換えずに済ませるため。

## Implementation Decisions

### 埋め込みプロバイダー

- `Embedder` を具象クラスから interface に変える。中身は `embedDocuments`・`embedQuery` と、指紋・次元を返す読み取り専用の項目。`createEmbedder(config)` の factory が `provider` に応じて実装を返す。今 Embedder を作っている 3 か所 (CLI・MCP サーバー・結合テストの準備) は factory を使う。
- 実装は `ollama` (今の `/api/embed`) と `openai` (`<url>/embeddings` に `{model, input[], ...params}` を送り、`data[].embedding` を受け取る) の 2 つ。Cohere と Gemini は今回入れない。
- 設定 `embedding` の項目:
  - `provider`: 省略時は `ollama`
  - `url`
  - `model`
  - `dimension`
  - `batch_size`
  - `rpm`: 任意
  - `api_key_env`: 任意
  - `normalize`: 既定 true
  - `revision`: 任意。既定 0
  - `query`: `{prefix, params}`
  - `document`: `{prefix, params}`
  - `extra_body`: 任意
- 旧キー `embedding.query_instruction` は `query.prefix` として読む。両方あれば新しいキーを優先する。
- `batch_size: 1` で 1 リクエスト 1 テキストになる。Sarashina の埋め込みはこの設定で使う。
- 正規化は、クライアント側の L2 正規化で常に行う (`normalize: true`)。インデックスの `space_type` は cosine のまま固定する。
- 応答の件数や次元が合わなければ例外にする。今の挙動を引き継ぐ。
- 索引作りでの呼び出しは、`rpm` があればその回数以内に間隔を空けて送る。429 と 5xx では間隔を延ばしながら最大 3 回再試行する。検索のクエリの埋め込みは再試行しない。

### API キーと設定の検証

- 設定に書くのは環境変数の名前 (`api_key_env`) だけ。値は環境変数から読む。設定ローダーが、リポジトリルート (`SHARED_MEMORY_ROOT` か探索したルート) の `.env` を読み込む。すでにある環境変数は上書きしない。`.env` は cwd ではなくルート基準で探す。
- `api_key_env` に名前があるのに値が無ければ、起動時にエラーにする。
- `embedding` と `rerank` の列挙値・型・必須項目を、設定の読み込み時に検証する。今は必須キーの有無しか見ていないので、この 2 つのセクションに限って足す。

### 埋め込みの指紋とインデックス

- 指紋 = 次の正規化済み JSON のハッシュ: `provider`・`model`・`dimension`・`normalize`・`revision`・`query` と `document` の `prefix` / `params`・`extra_body`。`url` と `api_key_env` は含めない (ADR 0001)。
- インデックスを作るとき (`setup` / `reindex`) に、テンプレートの次元を設定から差し込む。あわせて、指紋とその内訳をインデックスの `_meta` に書く。
- `index`・`import`・MCP の `write` は、エイリアスの先のインデックスの `_meta` を設定と照合する。指紋が違えば、`pnpm sm reindex` を促すメッセージで止める。自動で再インデックスはしない。
- `_meta` に指紋が無い既存のインデックスは、旧来の既定の指紋とみなす。旧来の既定とは、今の Qwen3・1024 次元・Ollama・document の前置き無しの組み合わせ。今の本番は、そのまま動く。
- 検索と MCP の起動では、指紋の不一致は警告にとどめて続ける。クエリのベクトルの次元がインデックスと違う場合だけエラーにする。
- `index_base` は手書きのまま残し、目印として使う。
- 埋め込みキャッシュのキーは `<cache_dir>/<指紋>/<hash先頭2>/<hash>.json` にする。指紋が旧来の既定と同じときだけ、旧キャッシュ (`<cache_dir>/<モデル名を置換したもの>/…`) も読む。

### リランク

- `Reranker` interface: `rerank(query, documents[]) → {index, score}[]`。`createReranker(config)` の factory は、無効なら何も返さない。`searchMemories` の依存に、任意の項目として足す。これで CLI と MCP の両方に入る。
- `flavor` は 4 つ。書き方の違いは flavor ごとの実装が受け持つ。
  - `cohere`: Cohere・Jina・Infinity・vLLM・llama.cpp
  - `voyage`
  - `tei`
  - `sarashina`
- 設定 `rerank` の項目:
  - `enabled`: 既定 false
  - `flavor`
  - `url`
  - `path`: 任意。flavor ごとの既定を上書きする
  - `model`
  - `api_key_env`: 任意
  - `candidates`: 既定 20
  - `max_docs_per_request`: 0 なら flavor ごとの既定。sarashina は 20、tei は 32
  - `doc_max_chars`: 既定 2000
  - `timeout_ms`: 既定 3000
  - `extra_body`: 任意
- レスポンスの JSON パスで汎用的に指定する形は、今回入れない。
- 流れ:
  1. 一次スコアでメモリ単位に集約する。
  2. 一次スコアの上位 `candidates` 件を候補にする。
  3. 各候補の代表チャンクの本文を `doc_max_chars` で切り、リランクする。
  4. リランカーの点数の降順に並べる。21 位以降は一次スコアの順のまま後ろにつなぐ。
  5. `limit` で切る。
- 候補にリランクの順位をそのまま使い、rescore は掛け直さない (ADR 0002)。
- 上限を超える件数は分けて送る。返ってきた点数は API ごとに範囲が違うので、使うのは順位だけにする。
- タイムアウト・429・5xx・形の不正のときは、リランクしない順位 (一次スコアと rescore による今までの順位) を返し、警告ログを出す。検索の中では再試行しない。
- `SearchResult` に任意の `rerank_score` を足す。`score` の意味 (rescore 後のスコア) は変えない。
- ローカルのリランカーとして、docker-compose に TEI を任意のプロファイルで足す。モデルは bge-reranker-v2-m3 か ruri-v3-reranker-310m を想定する。TEI で動くかと遅延は、実装のときに実測して決める。TEI で動かなければ llama.cpp の手順に切り替える。

### rescore を弱める

- rescore を `(0.7 + 0.3 × 減衰) × (1 + 0.2 × ln(1 + アクセス回数)) × 出所の係数` に変える。lab の soft と同じ式で、nDCG@10 は 0.694 から 0.859 に上がる。下限 0.7 と係数 0.2 は設定 (`search.rescore`) に出す。

### 出典

- front matter に任意の `source_path` (文字列) と `source_sha256` (64 桁の 16 進) を足す。検証は形だけにする。
- MCP の `write`、CLI の `import` (JSONL の行)、knowledge-import の Skill がこの 2 つを受け付ける。
- knowledge-import は、ファイルから取り込むときに、この 2 つを必ず付ける。本文末尾の「出典: パス」も残す。
- 出典の中身は保存しない。

### Mac / Linux の手順

- 「前提」と「別 PC でのセットアップ」を、Windows (PowerShell) と Mac / Linux (bash) の 2 通りで書く。
  - Docker: Docker Desktop / OrbStack / colima / Docker Engine
  - Ollama
  - Node 26: fnm か mise
  - pnpm
- `config.local.example.yaml` に、Mac と Linux のパスの例を足す。
- `vm.max_map_count` は、起動しないときや警告が出たときに設定する任意の手順として書く。single-node では、未設定でも起動前のチェックで止まらない。
- クライアント構成: サーバー PC へトンネルを張る `ssh -L` の例と、それを常駐させる launchd / systemd の雛形を載せる。
- 単体構成の常駐: MCP サーバーの常駐と `decay` / `gc` の定期実行を、launchd の plist と systemd --user の unit / timer の雛形で示す。導入スクリプトは作らない。
- サーバー集約構成とコードの自動配布 (`publish-code.mjs` の受け取り側、`deploy-code.ps1`、`register-tasks.ps1`) は、Windows のサーバー PC 限定と明記する。
- mcp-setup の SKILL.md に、Windows 以外の手順を書く。中身は `claude mcp add` などのエージェント別の登録、`ln -s` での Skill の配置、指示ファイルへの追記。
- 各 Skill は、Windows 以外では `SHARED_MEMORY_ROOT` を必須とする。
- 外部 API に本文を送るのは、設定で明示したときだけと README に書く。Sarashina の無償ベータの扱い (送った内容が改善に使われうること) も書く。

## Testing Decisions

- よいテストとは、外から見える振る舞いだけを確かめるもの。たとえば、設定を与えたときに、どの HTTP リクエストが出て、どの順位とエラーが返るか。内部の関数の分け方には依存しない。
- 既存の流儀を引き継ぐ。
  - `node:test` と `assert/strict` を使う。
  - HTTP は `http.createServer` で 127.0.0.1:0 に偽のサーバーを立てて確かめる。今の embed の単体テストがこの形。
  - 結合テストは、実物の OpenSearch と Ollama で `*.int.test.ts` にする。
- 合意済みの seam:
  1. **埋め込みプロバイダー** (`createEmbedder(config)` が返す `Embedder`): 偽サーバーに対して、次の項目を確かめる。
     - `ollama` と `openai` のリクエストの形
     - 前置き文と追加パラメーター
     - 認証ヘッダー
     - バッチ分割
     - 正規化
     - 次元の不一致での例外
     - 429 からの再試行
     - キャッシュの読み書きと旧キャッシュの引き継ぎ
     - 指紋が URL に依存しないこと
  2. **リランカー** (`createReranker(config)` が返す `Reranker`): 偽サーバーに対して、次の項目を確かめる。
     - 4 つの flavor のリクエストとレスポンスの読み方
     - 上限での分割
     - タイムアウト
  3. **検索** (`searchMemories`): 偽の OpenSearch クライアント (決まった hits を返すもの)、偽の Embedder、偽の Reranker を渡して、次の項目を確かめる。
     - 候補の選び方
     - リランク後の順位
     - 21 位以降のつなぎ方
     - `rerank_score`
     - 失敗時のフォールバック
     - soft rescore の順位
  4. **指紋の照合** (`setup` / `reindex` / `index`): 結合テストで、次の項目を確かめる。
     - `_meta` の書き込み
     - 不一致で `index` が止まること
     - `_meta` が無い既存のインデックスを旧来の既定とみなすこと
- 設定の検証 (`loadConfig`): 既存の設定のテストに足す。旧キーの読み替え、列挙値の検証、`.env` の読み込みと上書きしないことを確かめる。
- 出典の項目: 既存の front matter のテストと import のテストに足す。
- 検索のテストは今、実リポジトリの `config.local.yaml` の影響を受ける。新しいテストは設定をテスト内で組み立て、PC ごとの設定に依存しないようにする。
- README の手順は自動テストしない。Mac / Linux の実機で確かめる場合は、手で確かめた結果を共有メモリに残す。

## Out of Scope

- Cohere と Gemini のネイティブな埋め込み API。
- レスポンスの JSON パスで汎用的に指定する、リランカーの設定。
- OpenSearch の検索パイプラインの中でリランクすること (ML Commons のコネクター)。API キーを OpenSearch に置くことになるため。
- doc2query などのメタデータ付与。lab で効果が誤差の範囲だったため。
- 埋め込みの指紋が変わったときに、自動で再インデックスすること。
- Mac / Linux 用の導入スクリプト、サーバー集約構成と自動配布の移植。
- 出典の中身 (取り込み元の資料の原文) を保存すること。
- メモリの Markdown の履歴を Git で残すこと。Proton Drive の版履歴を確かめてから、別の課題として扱う。
- macOS の `._*.md` を無視する件と、scope の大文字小文字の件。コードの修正なので、別の課題として扱う。

## Further Notes

- 根拠は、2026-10-17 の評価 (`docs/experiments/2026-10-17-search-variants.md`、共有メモリ 01M541J1NQ4MH902SGDSFHWS33)。
- サーバー集約構成の現状は、共有メモリ 01M56CHJGKNM6SYP34ZS2JCNAX。
- Ollama には 2026 年 10 月の時点でリランク API が無い。そのため、ローカルでリランクするには別のサーバー (TEI / llama.cpp など) が要る。
- soft rescore とリランクを併用したときの評価は、まだ測っていない。リランクを有効にしたあと、lab で `rerank:hyb-b0-zscore+rescore-soft` などを測り、ADR 0002 を見直す。
- 実装を終えたら、README のアーキテクチャ図 (データの流れ) にリランカーを描き足す。
