# lab: 検索設定の比較

検索の設定を 1 つずつ変えて、同じ評価セットで比べるためのスクリプト。結果は [docs/experiments/2026-10-17-search-variants.md](../docs/experiments/2026-10-17-search-variants.md)。

- 本番のエイリアス `memories`、その先のインデックス、Search Pipeline `memories-hybrid` には書き込まない。作るのは `memory_lab_*` と `lab-*` だけ。
- メモリの本文を含むもの (チャンク、評価セット、生成結果、キャッシュ、結果) は `lab/data/` に置く。Git の管理外。
- Sarashina API のキーは、リポジトリ直下の `.env` に `SARASHINA_API_KEY=...` で置く (Git の管理外)。

## 手順

```powershell
node lab/export.mjs                          # 本番を複製した memory_lab_base から lab/data/chunks.jsonl を作る (複製は README の下記)
node lab/build-text-indices.mjs              # BM25・Sudachi の変種インデックス (ONLY=<名前> で 1 つだけ)
node lab/pipelines.mjs                       # lab-* の Search Pipeline
node lab/sarashina-embed.mjs                 # Sarashina3 embedding (60 RPM、全件で約 11 分)
node lab/enrich.mjs sarashina3-nano 60       # doc2query (nano、約 12 分)
$env:LIVE_ONLY=1; node lab/enrich.mjs sarashina3-mini 6   # doc2query (mini、検索対象だけで約 90 分)
node lab/build-api-indices.mjs sara          # memory_lab_sara
node lab/build-api-indices.mjs d2q nano      # memory_lab_d2q_nano (NQ=3 で質問 3 件版)
node lab/eval.mjs                            # 全 variant を評価 (名前か "前方一致*" で絞れる)
node lab/compare.mjs base rerank:base        # 2 つの variant の nDCG@10 の差 (ブートストラップ)
node lab/hnsw-recall.mjs                     # HNSW と総当たりの一致率
node lab/srw.mjs                             # Search Relevance Workbench で BM25 系を評価
```

`memory_lab_base` は、本番のテンプレートで作ったインデックスに `_reindex` で本番から複製する。

```powershell
curl.exe -XPUT localhost:9200/memory_lab_base -H "content-type: application/json" --data-binary "@opensearch/index-template.json"
curl.exe -XPOST "localhost:9200/_reindex?refresh=true" -H "content-type: application/json" -d '{\"source\":{\"index\":\"memories\"},\"dest\":{\"index\":\"memory_lab_base\"}}'
```

評価セット `lab/data/eval.jsonl` は 1 行 1 問で `{"qid", "set": "synthetic"|"real", "query", "relevant": {"<memory_id>": 2|1}}`。作り方は結果の文書の「方法」を参照。`node lab/pool.mjs "<クエリ>"` で、正解付け用に BM25 と kNN の上位 10 メモリを出せる。

## 片付け

```powershell
curl.exe -XDELETE "localhost:9200/memory_lab_*"
curl.exe -XDELETE "localhost:9200/_search/pipeline/lab-*"
```

Search Relevance Workbench に登録したものは、`/_plugins/_search_relevance/{query_sets,search_configurations,judgments,experiments}/<id>` を DELETE する。
