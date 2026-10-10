---
id: 01M4JKT7J092VQJ4EE8Q4FVG7P
title: 採用しない構成は EC2 公開・Postgres・スナップショット・ボリューム同期
scope: global
kind: semantic
provenance: agent_verified
source_agent: claude
created_at: 2026-10-10T00:00:00.000Z
tags:
  - decision
---

EC2 での MCP サーバー公開 (認証・TLS の管理が必要)、Postgres (台帳は front matter と Git 履歴で代替)、OpenSearch のスナップショット運用 (再インデックスで足りる)、Docker ボリュームの直接同期 (壊れやすい) は採用しない。
出典: docs/design/design.md 1章
