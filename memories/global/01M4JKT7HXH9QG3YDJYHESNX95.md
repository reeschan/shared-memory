---
id: 01M4JKT7HXH9QG3YDJYHESNX95
title: ハイブリッド検索の重みは BM25 0.4 / kNN 0.6
scope: global
kind: semantic
provenance: agent_verified
source_agent: claude
created_at: 2026-10-10T00:00:00.000Z
tags:
  - search
  - config
---

OpenSearch のハイブリッドクエリ (BM25 と kNN) を Search Pipeline の正規化プロセッサで合成する。
初期の重みは BM25 0.4、kNN 0.6。値は config.yaml で調整する。
出典: docs/design/design.md 5.2章
