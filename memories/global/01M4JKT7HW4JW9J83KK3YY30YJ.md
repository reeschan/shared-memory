---
id: 01M4JKT7HW4JW9J83KK3YY30YJ
title: 埋め込みモデルは Qwen3-Embedding-0.6B (1024 次元) を使う
scope: global
kind: semantic
provenance: agent_verified
source_agent: claude
created_at: 2026-10-10T00:00:00.000Z
tags:
  - embedding
---

ベクトル化にはローカルで動かす Qwen3-Embedding-0.6B (1024 次元) を使う。日本語・英語・コードが混ざる内容を 1 モデルで扱え、本文を外部に送らずに済む。
モデルを変えるときはインデックス名を変えて全件を再埋め込みし、異なるモデルのベクトルを同じインデックスに混ぜない。
出典: docs/design/design.md 4章
