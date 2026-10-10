---
id: 01M4JKT7HX54T2VNPTM8QMN5FQ
title: OpenSearch のセキュリティプラグインは無効で動かす
scope: global
kind: semantic
provenance: agent_verified
source_agent: claude
created_at: 2026-10-10T00:00:00.000Z
tags:
  - security
  - opensearch
---

認証なしで動かすのはポートをループバックに限定している前提による。
バインド先を変えるときは、必ずセキュリティプラグインを有効に戻す。
出典: docs/design/design.md 9章
