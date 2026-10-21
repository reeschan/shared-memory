// memory_lab_base から全チャンクを lab/data/chunks.jsonl に書き出す (embedding 含む)
import { writeFileSync } from "node:fs";
const OS = "http://127.0.0.1:9200";
const res = await fetch(`${OS}/memory_lab_base/_search`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ size: 2000, query: { match_all: {} } }) });
const hits = (await res.json()).hits.hits;
writeFileSync("lab/data/chunks.jsonl", hits.map(h => JSON.stringify({ _id: h._id, ...h._source })).join("\n") + "\n");
console.log(hits.length);
