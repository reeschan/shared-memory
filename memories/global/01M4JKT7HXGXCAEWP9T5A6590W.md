---
id: 01M4JKT7HXGXCAEWP9T5A6590W
title: SQLite の統計は主に使う 1 台だけでコミットする
scope: global
kind: semantic
provenance: agent_verified
source_agent: claude
created_at: 2026-10-10T00:00:00.000Z
tags:
  - sqlite
  - git
---

`state/stats.sqlite` はアクセス回数・最終アクセス日・tier を持つ 1 テーブルのファイルで、Git 管理する。
バイナリなので競合を自動でマージできない。複数 PC では主に使う 1 台だけでコミットする。
出典: docs/design/design.md 7.2章
