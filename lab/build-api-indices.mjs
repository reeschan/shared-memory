// Sarashina の結果を使う検証用インデックスを作る
//   node lab/build-api-indices.mjs sara        → memory_lab_sara (Sarashina3 embedding を sara_vec に追加)
//   node lab/build-api-indices.mjs d2q nano    → memory_lab_d2q_nano (想定質問・キーワード・要約 + 想定質問ベクトル)
import { readFileSync } from "node:fs";
import { os, readJsonl, qwenEmbed, cacheGet, cacheSet, cacheFlush, sha } from "./lib.mjs";

const [what, model = "nano"] = process.argv.slice(2);
const t = JSON.parse(readFileSync("opensearch/index-template.json", "utf8"));
const chunks = readJsonl("lab/data/chunks.jsonl");
const vecField = dim => ({ type: "knn_vector", dimension: dim, method: { name: "hnsw", engine: "faiss", space_type: "cosinesimil" } });
let name;
const docs = [];

if (what === "sara") {
  name = "memory_lab_sara";
  t.mappings.properties.sara_vec = vecField(1536);
  for (const c of chunks) {
    const v = cacheGet("sarashina-emb-doc", sha(c.content));
    if (!v) throw new Error(`Sarashina 埋め込みが無いチャンクがある: ${c._id}`);
    docs.push({ ...c, sara_vec: v });
  }
} else if (what === "d2q") {
  const nq = Number(process.env.NQ ?? 5); // 想定質問の件数 (3 件と 5 件の比較用)
  name = `memory_lab_d2q_${model}${nq === 5 ? "" : `_q${nq}`}`;
  const ns = `enrich-sarashina3-${model}-d2q-v1`;
  Object.assign(t.mappings.properties, {
    questions: { type: "text", analyzer: "ja" },
    keywords: { type: "text", analyzer: "ja", fields: { raw: { type: "keyword" } } },
    summary: { type: "text", analyzer: "ja" },
    question_vecs: { type: "nested", properties: { text: { type: "text", analyzer: "ja" }, vec: vecField(1024) } },
    enrich: { properties: { model: { type: "keyword" }, prompt_version: { type: "keyword" } } },
  });
  let missing = 0;
  for (const c of chunks) {
    const e = cacheGet(ns, sha(c.title + "\n" + c.content));
    if (!e) { missing++; docs.push(c); continue; } // 未生成 (例: mini は検索対象チャンクだけ生成) は本文のみ
    const qs = e.questions.slice(0, nq).filter(q => typeof q === "string" && q.trim());
    const vecs = [];
    for (const q of qs) {
      const key = sha(q);
      let v = cacheGet("qwen-doc", key);
      if (!v) { [v] = await qwenEmbed([q]); cacheSet("qwen-doc", key, v); }
      vecs.push(v);
    }
    docs.push({ ...c, questions: qs, keywords: e.keywords.slice(0, 10), summary: e.summary,
      question_vecs: qs.map((q, i) => ({ text: q, vec: vecs[i] })), enrich: { model: e.model, prompt_version: e.promptVersion } });
  }
  cacheFlush("qwen-doc");
  console.log("missing enrichment", missing);
} else throw new Error("usage: sara | d2q <nano|mini>");

try { await os("DELETE", `/${name}`); } catch {}
await os("PUT", `/${name}`, t);
for (let i = 0; i < docs.length; i += 100) {
  const body = docs.slice(i, i + 100).flatMap(({ _id, ...d }) => [JSON.stringify({ index: { _index: name, _id } }), JSON.stringify(d)]).join("\n") + "\n";
  const r = await os("POST", "/_bulk", body);
  if (r.errors) throw new Error(JSON.stringify(r.items.find(x => x.index.error)).slice(0, 500));
}
await os("POST", `/${name}/_refresh`);
const stats = await os("GET", `/${name}/_stats/store,docs`);
console.log(name, (await os("GET", `/${name}/_count`)).count, "store bytes", stats._all.primaries.store.size_in_bytes, "docs(incl nested)", stats._all.primaries.docs.count);
