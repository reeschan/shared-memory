---
id: 01M4JKT7HZK3NBKCAJR9A7Q6ZH
title: MCP サーバーは 1 プロセスだけ起動し、ツールは search / get / write の 3 つ
scope: global
kind: semantic
provenance: agent_verified
source_agent: claude
created_at: 2026-10-10T00:00:00.000Z
tags:
  - mcp
---

Streamable HTTP の MCP サーバーを 1 プロセスだけ起動し、3 つのエージェントが同じエンドポイントを使う。
SQLite とファイルへの書き込みを 1 プロセスに集約し、同時書き込みの衝突を避ける。ツールは検索 (要約のみ)、本文取得、書き込みの 3 つに絞る。
出典: docs/design/design.md 5.1章, 5.3章
