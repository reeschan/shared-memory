# 知識と橋渡しを分ける

## Problem Statement

shared-memory には 2 種類のメモリが混ざっている。1 つは、作業が終わっても別の作業で真のまま使える**知識**。もう 1 つは、1 つの作業の中で AI どうしが受け渡す**橋渡し** (進み具合・引き継ぎ・PBI 間の ref・状態のスナップショット) である。

- scope を付けない search で、作業空間 (`project:work.*`) のメモリが上位に混ざる。2026-10-24 に「作業空間 引き継ぎ」で検索すると、上位 15 件のうち 11 件が作業空間だった。ほかの作業の引き継ぎや ref は、今の問いへの答えにならない。
- 決まりが無いので、橋渡しが global や repo に書かれている。例えば「devloop: M1 の実装が完了 (2026-10-12、未コミット)」(01M4NVR3YJF0CBP5D3CVP6C0Y8) が global にある。2026-10-24 時点で、global・repo などの 396 件のうち、純粋な橋渡しが 24 件、橋渡しとノウハウが混ざったものが 36 件あった。
- kind は「古くなるか」の軸なので、この区別に使えない。episodic にも本物のノウハウがあり、semantic にも作業の ref がある。
- GraphRAG の実験 (docs/specs/graphrag-lab.md、feat/graphrag-lab) では、作業空間 48 件と、global・repo のスナップショット約 15 件が、関係の辺とコミュニティの要約を汚していた。
- atelier の `appendix/memory.md` には「作業空間は 30 日アクセスが無いと search から外れる」とある。しかし 6777053 から `searchable_tiers` は全 tier なので、この前提は成り立っていない。終わった作業の橋渡しは、いつまでも既定の検索に出る。

## Solution

- 橋渡しかどうかは scope で表す。`project:work.` で始まる scope が作業空間で、橋渡しは作業空間にだけ書く。kind・タグ・freshness は変えない (docs/adr/0003-relay-axis-is-workspace-scope.md)。
- scope を付けない search は、作業空間を常に除く。作業空間を引くには、scope にその作業空間を明示するか、`include_workspaces` を付ける。
- 作業が終わったら、最新の引き継ぎを「完了」のメモリで置き換える。これで、終わった作業の引き継ぎが resume の検索に出なくなる。作業空間は消さず、閉じた印も作らない。
- 書くときの決まりを、エージェントが必ず読む 3 か所に書く。MCP の `write` のツール説明、`~/.claude/CLAUDE.md` の shared-memory の節、atelier の `appendix/memory.md` である。
- global・repo に入った既存の橋渡しは、持ち主の承認を得てから、作業空間 (legacy) に移すか、ノウハウだけを抜き出して置き換える。削除はしない。

## User Stories

1. エージェントとして、scope を付けずに search したとき、ほかの作業の引き継ぎや ref が混ざらない結果を受け取りたい。今の問いに答える知識が上位に来るようにするため。
2. エージェントとして、scope に作業空間を明示して search したとき、今までどおりその作業空間のメモリを受け取りたい。作業を再開したときに ref を引けるようにするため。
3. atelier のオーケストレーターとして、`include_workspaces` を付けて tags `handoff` で search したい。フォルダの無いセッションからの resume で、作業中の引き継ぎを見つけるため。
4. atelier のオーケストレーターとして、終わった作業の引き継ぎが resume の検索に出ないようにしたい。再開する作業を取り違えないため。
5. atelier のオーケストレーターとして、finish で最新の引き継ぎを「完了」のメモリで置き換えたい。それだけで作業を閉じられ、閉じる仕組みを別に持たずに済むため。
6. エージェントとして、id を知っていれば、終わった作業空間のメモリも get で読みたい。昇格したメモリの出所を辿るため。
7. エージェントとして、`write` のツール説明だけを読んでも、進み具合や引き継ぎの書き先が作業空間だと分かりたい。Claude Code 以外 (Codex・Kimi など) も同じ決まりで書けるようにするため。
8. atelier を使わないセッション (design-flow、side session、単発の作業) のエージェントとして、atelier と同じ作業キーの決め方で作業空間を作りたい。決まりを 1 本にするため。
9. エージェントとして、global・repo に書いてよいかを「作業が終わっても、別の作業で真のまま使えるか」で判断したい。タイトルに日付付きの状態 (完了・未コミット・波 N・PR を出した) が入るなら、それは橋渡しだと分かるようにするため。
10. エージェントとして、スキルの版を切り替えた記録はメモリに書かず、スキルの CHANGELOG に書きたい。中身が二重にならないようにするため。
11. エージェントとして、版をまたいでも使える落とし穴は、知識として global に書きたい。版の記録をやめても、落とし穴は失われないようにするため。
12. エージェントとして、「設計が合意済み」を書くときは、決定と仕様の場所 (ブランチをまたいでも辿れる形) だけを repo に書きたい。ワークツリーのパスや未コミットの状態は、作業空間の引き継ぎに書く。
13. 持ち主として、global・repo にある橋渡しの一覧を scope ごとにまとめて見て、一括で承認したい。60 件を 1 件ずつ答えずに済むようにするため。
14. 持ち主として、ノウハウが混ざったメモリについて、抜き出すノウハウの案を 1 行ずつ見てから承認したい。知識を失わずに片付けるため。
15. 持ち主として、片付けでメモリが削除されないようにしたい。間違えても supersedes の連鎖から元の内容に戻れるようにするため。
16. 持ち主として、移したメモリに元の scope と元の id が書いてあってほしい。どこから来たかを後で確かめるため。
17. GraphRAG の実験の担当として、グラフの入力を作るときに、検索と同じ「作業空間を除く」の既定を使いたい。除外の条件を実験側で二重に持たないため。
18. 評価の担当として、評価とフィードバックの画面の検索に、本番と同じ既定 (作業空間を除く) が効いてほしい。本番とずれた条件で測らないため。
19. CLI の利用者として、`search` に、MCP と同じ意味の「作業空間を含める」の指定を使いたい。
20. atelier の利用者として、`appendix/memory.md` の作業空間の説明が今の検索の動きと合っていてほしい。「30 日で search から外れる」という誤った前提で設計しないため。

## Implementation Decisions

- **分類の軸**: 作業空間は「scope が `project:work.` で始まる」で決まる。この判定は core に 1 か所だけ置き、検索の既定・GraphRAG の入力・今後の利用者が同じ判定を使う。`KINDS`、freshness の計算、tier、タグの語彙は変えない。
- **検索の既定**: core の検索の絞り込み (`buildFilter`) を次のように変える。
  - 検索の入力に、省略できる `include_workspaces` (真偽値、既定は偽) を足す。
  - `scope` が無く、`include_workspaces` が偽のとき、scope が `project:work.` で始まるものを除く (scope は keyword なので前方一致の除外で書ける)。
  - `scope` があるときは今までどおり完全一致だけで絞り、`include_workspaces` は見ない。作業空間を明示すれば、その作業空間が引ける。
  - 問われた時点を再現する検索 (`asOf`) にも、同じ除外を掛ける。
- **MCP の search**: 入力に `include_workspaces` を足す。説明は「scope を付けない検索は作業空間 (`project:work.*`) を除く。引き継ぎの resume のときだけ true にする」の趣旨にする。
- **MCP の write**: ツール説明に 1 文足す。「進み具合・引き継ぎ・ref は作業空間 `project:work.<repo>.<branch>.W-<n>` に書き、global・repo には別の作業でも真のまま使える知識だけを書く」の趣旨。サーバー側で title や本文を見て弾く・警告する検査は入れない (誤検知が多いため)。
- **CLI の search**: MCP と同じ意味のオプションを足す。
- **作業キー**: atelier の決め方 (`<repo>:<branch>:W-<n>`、作業空間は `project:work.<repo>.<branch>.W-<n>`、ブランチの `/` などは `-`) を、atelier を使わない作業にも使う。
- **作業の完了**: finish で、最新の引き継ぎ (tags `handoff`) を supersedes する「完了」のメモリを作業空間に書く。kind は `episodic`、tags は `handoff` と `work:<branch>/<作業の番号>`、本文には完了日と昇格したメモリの id の一覧を書く。置き換えられたメモリは検索から外れるので、resume の検索に終わった作業は出ない。作業空間は get と、scope を明示した search で辿れる。
- **書くときの決まりの文面** (実装で次の 3 か所に入れる):
  - `~/.claude/CLAUDE.md` の shared-memory の節に、次の 2 行を足す。
    - 進み具合・引き継ぎ・PBI 間の ref・状態のスナップショットは作業空間 `project:work.<repo>.<branch>.W-<n>` にだけ書く。global・repo には、作業が終わっても別の作業で真のまま使える知識だけを書く。
    - スキルの版の経緯はスキルの CHANGELOG に書き、メモリに書かない。「設計が合意済み」は、決定と仕様の場所だけを repo に書く。
  - atelier の `appendix/memory.md`:
    - Finish の「drops out of search after 30 days」を、「scope を付けない検索には出ない」に直す。
    - Finish に「完了」メモリの手順を足す。
    - Hand off の resume の検索に `include_workspaces` を足す (`appendix/handoff.md` の検索も同じ)。
    - atelier の本文の変更は skill-versioning の手順で行う。
  - MCP の `write` のツール説明 (上記)。
- **既存の橋渡しの片付け**:
  - 対象: 2026-10-24 の仕分けで A (純粋な橋渡し) 24 件、B (橋渡しとノウハウの混在) 36 件。一覧はこのリポジトリに入れず、セッションの共有メモ (`relay-candidates.md`) に置く。お客さまの名前を含むタイトルがあるため。実行の前に、置き換えられていないかを確かめ直す。
  - A: 作業空間 (legacy) に同じ本文で書き、元の id を supersedes する。
  - B: ノウハウだけを新しいメモリにして元の scope に書き、元の id を supersedes する。橋渡しの部分は legacy に書く (supersedes は付けない。元はノウハウの側が置き換える)。「設計が合意済み」型 (4 件) も、決定と仕様の場所だけを書き直す。
  - legacy の scope: `project:work.<repo>.legacy.W-000`。global のものは `project:work.global.legacy.W-000`、作業空間でない project (`project:pbi-orchestration-jev`・`project:harness2.verify.agg.smoke`) のものはそれぞれの名前の legacy。
  - legacy に移すメモリの形: 本文の先頭に「<元の scope> から移した (元 id)」を足し、残りは元のまま。kind と provenance は元のまま。tags は元のタグに `work:legacy` を足す。
  - 承認: A は scope ごとの一覧をまとめて、B は「残す」欄 (抜き出すノウハウ 1 行) をまとめて、持ち主が承認する。直したいものだけ個別に指摘してもらう。書く本文の案はファイルにして見せ、承認のあとで MCP の write で書く。
  - 実行は、この仕様の合意のあとの別のセッションで行う。

## Testing Decisions

- 良いテストは、外から見える振る舞い (どのメモリが検索結果に出るか) だけを確かめ、OpenSearch のクエリの形には立ち入らない。
- **合意済みの seam**:
  1. core の検索 (`searchMemories`) を、実際の OpenSearch に対して呼ぶ結合テスト。作業空間・global・repo・作業空間でない project のメモリを入れて、次を確かめる。
     - scope なしでは作業空間が出ない。
     - `include_workspaces` で出る。
     - 作業空間の scope の明示で、その作業空間だけが出る。
     - `asOf` 付きでも同じ。
     - 「完了」メモリで置き換えた引き継ぎが、`include_workspaces` でも出ない。
  2. 作業空間の判定 (純関数) の単体テスト。`project:work.x`・`project:workshop`・`project:work`・`repo:work.x` などの境界を確かめる。
- MCP の search と write の入出力は、core の上の薄い受け渡しなので、新しい seam は作らない。ツール説明の文面はレビューで見る。
- 先例: core の検索の結合テスト (scope ごとにメモリを入れて検索する形)、絞り込みの単体テスト。
- atelier と CLAUDE.md の文面はテストせず、レビューで見る。

## Out of Scope

- `lab/` と feat/graphrag-lab の作業 (実験側は独自にグラフの入力から作業空間を除いて進める。この仕様の実装後に、core の判定を使うかは実験側で決める)。
- kind の値の追加、タグ `relay` の導入、作業空間を閉じる印やフラグ。
- write でのサーバー側の検査 (title の形や書き先の警告)。
- 既存のメモリの削除。作業空間のメモリを tier や日数で消す・隠す仕組み。
- 知識どうしの重複 (例えば sekisuiheim の区画の設計の同じ内容 3 件) の整理。橋渡しではないので、別に扱う。
- 片付けの実行そのもの (別のセッション)。

## Further Notes

- 決定の経緯: 2026-10-24、design-flow でオーナーと合意した。軸の選択は docs/adr/0003-relay-axis-is-workspace-scope.md に記録した。
- リスク: 外部の利用者 (knowledge-digest、harness2 の shared-memory connector) が、scope なしの search で作業空間のメモリを拾っている場合、結果が変わる。実装の前に、これらの呼び出しが scope を付けているかを確かめる。
- 仕分けの境界: AI レーダーの日次まとめ、決定が中心の PBI 実装メモ、設計合意のメモは C (知識) にした。承認のときに、この境界も持ち主に見てもらう。
- 古い記憶の確認 (freshness) は知識のための仕組みで、作業空間には使わない。作業空間は既定の検索に出ないので、kind ごとのしきい値を変える必要はない。
