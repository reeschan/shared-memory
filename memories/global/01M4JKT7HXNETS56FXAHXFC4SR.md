---
id: 01M4JKT7HXNETS56FXAHXFC4SR
title: 再スコアは時間減衰・アクセス回数・出所の係数を掛ける
scope: global
kind: semantic
provenance: agent_verified
source_agent: claude
created_at: 2026-10-10T00:00:00.000Z
tags:
  - search
  - ranking
---

上位 50 チャンクを MCP サーバー側で再スコアする。
最終スコア = ハイブリッドスコア × 時間減衰 × (1 + log(1 + access_count)) × 出所の係数。
出所の係数は human_confirmed 1.0 / agent_verified 0.85 / agent_inferred 0.7。時間減衰は function_score ではなくサーバー側で行う。
出典: docs/design/design.md 5.2章
