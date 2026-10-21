// 本番テンプレートを元に、アナライザーや BM25 パラメーターだけを変えた検証用インデックスを作り、memory_lab_base から複製する
import { readFileSync } from "node:fs";
import { os } from "./lib.mjs";
const base = () => JSON.parse(readFileSync("opensearch/index-template.json", "utf8"));
// 未知語 (英字の識別子など) は sudachi.json で 補助記号,一般 になるので、補助記号は句読点と括弧だけを落とす
const STOP_POS = ["助詞", "助動詞", "補助記号,句点", "補助記号,読点", "補助記号,括弧開", "補助記号,括弧閉", "空白"];
export const SYNONYMS = [
  "埋め込み, エンベディング, embedding, ベクトル化",
  "削除, 消去, 消す",
  "設定, コンフィグ, config",
  "検索, サーチ, search",
  "リポジトリ, repo, repository",
  "テスト, test",
  "エラー, error",
  "インデックス, index",
  "要約, サマリー, summary",
  "再起動, restart",
];
const variants = {
  // BM25 の文書長補正をなくす
  memory_lab_b0: t => { t.settings.index.similarity = { bm: { type: "BM25", k1: 1.2, b: 0 } }; setSim(t); },
  memory_lab_b05: t => { t.settings.index.similarity = { bm: { type: "BM25", k1: 1.2, b: 0.5 } }; setSim(t); },
  memory_lab_k1_2: t => { t.settings.index.similarity = { bm: { type: "BM25", k1: 2.0, b: 0.75 } }; setSim(t); },
  // Sudachi の分割単位
  memory_lab_split_a: t => { t.settings.analysis.tokenizer.sudachi_c.split_mode = "A"; },
  memory_lab_split_b: t => { t.settings.analysis.tokenizer.sudachi_c.split_mode = "B"; },
  // 助詞・助動詞・記号を落とす (現行は stoptags 未指定で何も落ちていない)
  memory_lab_pos: t => { t.settings.analysis.filter = { pos: { type: "sudachi_part_of_speech", stoptags: STOP_POS } };
    t.settings.analysis.analyzer.ja.filter = ["pos", "sudachi_normalizedform", "lowercase"]; },
  // 検索時だけ同義語を展開する (search_analyzer)
  memory_lab_syn: t => { t.settings.analysis.filter = { syn: { type: "synonym_graph", synonyms: SYNONYMS } };
    t.settings.analysis.analyzer.ja_search = { type: "custom", tokenizer: "sudachi_c", filter: ["sudachi_part_of_speech", "sudachi_normalizedform", "lowercase", "syn"] };
    for (const f of ["title", "content"]) t.mappings.properties[f].search_analyzer = "ja_search"; },
  // 識別子を壊さないよう、英数字をそのまま持つサブフィールドを足す (standard アナライザー)
  memory_lab_raw: t => { for (const f of ["title", "content"]) t.mappings.properties[f].fields = { std: { type: "text", analyzer: "standard" } }; },
};
function setSim(t) { for (const f of ["title", "content"]) t.mappings.properties[f].similarity = "bm"; }

for (const [name, mod] of Object.entries(variants)) {
  if (process.env.ONLY && process.env.ONLY !== name) continue;
  const t = base(); mod(t);
  try { await os("DELETE", `/${name}`); } catch {}
  await os("PUT", `/${name}`, t);
  const r = await os("POST", "/_reindex", { source: { index: "memory_lab_base" }, dest: { index: name } }, "?refresh=true");
  console.log(name, r.created, r.failures.length);
}
