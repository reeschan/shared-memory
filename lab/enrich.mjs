// doc2query: Sarashina のチャット系モデルで想定質問・キーワード・要約を作る (設計資料 5.2 のプロンプト)
// 使い方: node lab/enrich.mjs sarashina3-nano 60
import { readJsonl, sarashina, cacheGet, cacheSet, cacheFlush, sha } from "./lib.mjs";
const [model = "sarashina3-nano", rpm = "60"] = process.argv.slice(2);
const PROMPT_VERSION = "d2q-v1";
const NS = `enrich-${model}-${PROMPT_VERSION}`;
const schema = { type: "object", additionalProperties: false, required: ["questions", "keywords", "summary"], properties: {
  questions: { type: "array", items: { type: "string" } },
  keywords: { type: "array", items: { type: "string" } },
  summary: { type: "string" } } };
const prompt = c => `以下はAIエージェント用の共有メモリの一部です。
次のJSONを出力してください。
- questions: この文書だけで答えられる質問を5個。エージェントや人が実際に検索しそうな自然な日本語にする
- keywords: 固有名詞・ツール名・設定名・識別子を最大10個。文書の表記のまま
- summary: 100字程度の要約
文書にないことは書かない。

# パス
${c.scope}/${c.memory_id}
# 見出し
${c.title}
# 本文
${c.content}`;
function parse(text) {
  const t = text.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "");
  try { return JSON.parse(t); } catch { return null; }
}
const chunks = readJsonl("lab/data/chunks.jsonl")
  .filter(c => !process.env.LIVE_ONLY || (!c.is_superseded && ["hot", "warm"].includes(c.tier)));
let n = 0, fail = 0;
const t0 = Date.now();
for (const c of chunks) {
  const key = sha(c.title + "\n" + c.content);
  if (cacheGet(NS, key)) continue;
  let out = null;
  for (let i = 0; i < 2 && !out; i++) {
    const r = await sarashina("/chat/completions", { model, temperature: 0, max_completion_tokens: 800,
      messages: [{ role: "user", content: prompt(c) }],
      response_format: { type: "json_schema", json_schema: { name: "enrichment", strict: true, schema } } }, Number(rpm));
    out = parse(r.choices[0].message.content ?? "");
    if (out) out.usage = r.usage;
  }
  if (!out) { fail++; out = { questions: [], keywords: [], summary: "", failed: true }; }
  out.model = model; out.promptVersion = PROMPT_VERSION;
  cacheSet(NS, key, out);
  if (++n % 10 === 0) { cacheFlush(NS); console.log(new Date().toISOString(), n, "fail", fail, "avg s/chunk", ((Date.now() - t0) / n / 1000).toFixed(1)); }
}
cacheFlush(NS); console.log("done", n, "fail", fail);
