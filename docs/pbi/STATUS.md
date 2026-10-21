# PBI 状態

作業キー: shared-memory:feat/pluggable-embedding-rerank:W-001 / 作業空間: project:work.shared-memory.feat-pluggable-embedding-rerank.W-001
外した実行先: なし
仕様: docs/specs/pluggable-embedding-and-rerank.md (PBI-018 以降)

| PBI | モデル | 状態 | 差し戻し | 昇格 | 続行指示 | メモ |
|---|---|---|---|---|---|---|
| PBI-001 | opus | 完了 | 0/2 | 0/1 | 0/2 | 一発合格。pnpm が minimumReleaseAgeExclude を自動追記 |
| PBI-002 | opus | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 (検証コマンド4はオーケストレーターの誤りで修正) |
| PBI-003 | sonnet | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 |
| PBI-004 | sonnet | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 |
| PBI-005 | sonnet | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 |
| PBI-006 | sonnet | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 |
| PBI-007 | sonnet | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 |
| PBI-008 | opus | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 (テスト用インデックス名に -idx。PBI の名前衝突の誤りへの対処) |
| PBI-009 | opus | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 |
| PBI-010 | opus | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 |
| PBI-011 | haiku | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 |
| PBI-012 | opus | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 ([::1] も Host 許可・JSON 応答) |
| PBI-013 | opus | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 |
| PBI-014 | opus | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 |
| PBI-015 | opus | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 (本実行は未実施) |
| PBI-016 | sonnet | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 |
| PBI-017 | sonnet | 完了 | 0/2 | 0/1 | 0/2 | 一発合格。本番でタスク再登録・スモークテスト 3 エージェント成功 |
| PBI-018 | agent sonnet high（sonnet / deep） | 完了 | 0/2 | 0/1 | 0/2 | 一発合格。検証は Node 26 で (既定の node は 22)。軽微: local の旧キーは新キーに負ける |
| PBI-019 | dsh deepseek-flash high（sonnet / normal） | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 |
| PBI-027 | dsh deepseek-flash high（sonnet / normal） | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 (検証1・2は設計者の誤りで修正) |
| PBI-021 | dsh deepseek-flash high（haiku / normal） | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 |
| PBI-022 | agent sonnet high（sonnet / deep） | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 (検証5は設計者の誤り: 結合テストが 11434 固定。docs/pbi/tools/embed-int-check.test.ts に直した)。今の設定の指紋 = LEGACY |
| PBI-023 | agent sonnet high（sonnet / deep） | 完了 | 0/2 | 0/1 | 0/2 | 一発合格。sarashina の点数なしは「長さ-位置」、返らない文書は最下位で補う |
| PBI-020 | dsh deepseek-flash high（sonnet / normal） | 完了 | 0/2 | 0/1 | 0/2 | 一発合格 |
| PBI-024 | dsh deepseek-flash high（sonnet / deep） | 完了 | 0/2 | 0/1 | 0/2 | 一発合格。検証4の14件 fail は既存の結合テスト (embed.int・opensearch.int・cli.int) が 9200/11434 固定のため。PBI 外 (後続候補) |
| PBI-025 | dsh deepseek-flash high（sonnet / normal） | 完了 | 0/2 | 0/1 | 0/2 | 一発合格。検証6の14件 fail は既知 (PBI-024 と同じ) |
| PBI-026 | dsh deepseek-flash high（sonnet / normal） | 完了 | 0/2 | 0/1 | 0/2 | 一発合格。既存の「コードの配布」節は保持 |
| PBI-028 | dsh deepseek-flash high（sonnet / normal） | 完了 | 0/2 | 0/1 | 0/2 | 一発合格。test:int 52/52 |
