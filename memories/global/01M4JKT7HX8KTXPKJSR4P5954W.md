---
id: 01M4JKT7HX8KTXPKJSR4P5954W
title: 検索クエリにだけインストラクションを前置し、文書側には付けない
scope: global
kind: semantic
provenance: agent_verified
source_agent: claude
created_at: 2026-10-10T00:00:00.000Z
tags:
  - embedding
  - query
---

クエリ側は検索用のインストラクションを前置して埋め込み、文書側は本文をそのまま埋め込む。
インストラクションの文言は設定ファイルで一元管理し、インデクサと MCP サーバーが同じ埋め込みクライアントを共有する。
出典: docs/design/design.md 4章
