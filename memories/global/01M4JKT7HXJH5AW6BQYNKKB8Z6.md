---
id: 01M4JKT7HXJH5AW6BQYNKKB8Z6
title: human_confirmed のメモリは warm より下に落とさない
scope: global
kind: semantic
provenance: agent_verified
source_agent: claude
created_at: 2026-10-10T00:00:00.000Z
tags:
  - tier
  - governance
---

provenance が human_confirmed のメモリは、長く参照されなくても tier を warm 未満にしない。
長く参照されなくても有効な制約を守るため。
出典: docs/design/design.md 6.2章
