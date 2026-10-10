---
id: 01M4JKT7HVRX7HQDAPZ8XAAK0R
title: ポートはすべて 127.0.0.1 にだけバインドする
scope: global
kind: semantic
provenance: agent_verified
source_agent: claude
created_at: 2026-10-10T00:00:00.000Z
tags:
  - security
---

OpenSearch・埋め込みサーバー・MCP サーバーはループバックにだけバインドし、PC の外から到達できる入口を作らない。
docker-compose のポート指定も `127.0.0.1:9200:9200` の形にする。
出典: docs/design/design.md 9章
