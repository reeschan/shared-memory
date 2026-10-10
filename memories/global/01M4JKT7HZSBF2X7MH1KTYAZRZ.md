---
id: 01M4JKT7HZSBF2X7MH1KTYAZRZ
title: 秘密情報はメモリに書かず、write で典型的なキーの形を拒否する
scope: global
kind: semantic
provenance: agent_verified
source_agent: claude
created_at: 2026-10-10T00:00:00.000Z
tags:
  - security
  - governance
---

API キーなどの秘密情報はメモリに書かない運用とする。
`write` と `import` は典型的なキーの形を検出したら拒否する。リポジトリのリモートはプライベートにする。
出典: docs/design/design.md 9章
