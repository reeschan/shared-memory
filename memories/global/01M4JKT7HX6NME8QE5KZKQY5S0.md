---
id: 01M4JKT7HX6NME8QE5KZKQY5S0
title: get で読まれたメモリは即座に hot へ戻す
scope: global
kind: semantic
provenance: agent_verified
source_agent: claude
created_at: 2026-10-10T00:00:00.000Z
tags:
  - tier
  - stats
---

MCP の `get` が呼ばれたらアクセス回数と最終アクセス日を更新し、tier を hot に戻す。
同じ値を OpenSearch へ部分更新で反映する。
出典: docs/design/design.md 6.2章
