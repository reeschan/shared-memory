---
id: 01M4JKT7J0RK9SSN8ZE555DTFF
title: gc は置き換え済みを archive に送り、ファイルの削除は人が行う
scope: global
kind: semantic
provenance: agent_verified
source_agent: claude
created_at: 2026-10-10T00:00:00.000Z
tags:
  - gc
  - tier
---

`gc` は is_superseded のメモリを archive に送り、symbol_ref の参照先が存在しないメモリは一覧に出して人が判断する。
ファイルの物理削除は自動では行わない。削除したい場合は人が消してコミットする。
出典: docs/design/design.md 6.3章
