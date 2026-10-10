---
id: 01M4JKT7HXG9GWSA8DFPBP52G2
title: メモリの本文は書き換えず supersedes で新規作成する
scope: global
kind: semantic
provenance: agent_verified
source_agent: claude
created_at: 2026-10-10T00:00:00.000Z
tags:
  - governance
---

既存ファイルの本文は書き換えない。内容を更新するときは新しいファイルを作り、`supersedes` で元メモリの id を指す。
出所の連鎖は supersedes と Git 履歴で追える。上書き用の別ツールは作らない。
出典: docs/design/design.md 3.1章
