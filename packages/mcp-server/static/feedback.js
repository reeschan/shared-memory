// 検索フィードバックの画面の動き。ビルドの手順は無く、このファイルをそのまま配る。
// CSP は script-src 'self' / style-src 'self' なので、インラインの script・on* 属性・style 属性を使わない
// (要素の大きさは CSSOM の el.style で変える。これは CSP に止められない)。
// 文字列は textContent で入れ、innerHTML は使わない (記憶のタイトルと抜粋はデータとして扱う)。
"use strict";

(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const SAVE_DELAY_MS = 500;
  const GRADE_VALUES = [2, 1, 0];
  const CREATED_WEEKS_MAX = 8;
  const MODE_KEY = "sm-feedback-mode";
  const LANG_KEY = "sm-feedback-lang";

  // ---- 文言の辞書 ----
  // キー → { ja, en }。値は文字列か、引数を受けて文字列を返す関数。一般向けと専門向けで違うものは
  // { g: 一般向け, x: 専門向け } にする。一般向けは専門用語を言い換える (本番 → いまの設定、
  // 一次スコアだけ → 内容の近さだけ、nDCG@10 → 検索の質 (100 点満点)、95% 区間 → ぶれ幅、など)。
  const STRINGS = {
    page_title: { ja: "検索フィードバック", en: "Search feedback" },
    skip: { ja: "判定へ移る", en: "Skip to judging" },
    brand_sub: { ja: "/ 検索フィードバック", en: "/ Search feedback" },
    nav_label: { ja: "ページ内", en: "On this page" },
    nav_overview: { ja: "結果の一覧", en: "Overview" },
    nav_judge: { ja: "判定", en: "Judge" },
    mode_label: { ja: "表示のモード", en: "Display mode" },
    mode_general: { ja: "一般", en: "Plain" },
    mode_expert: { ja: "専門", en: "Expert" },
    mode_suffix: { ja: "向け", en: "" },
    mode_general_title: { ja: "専門用語を使わずに表示する", en: "Show in plain words, without jargon" },
    mode_expert_title: {
      ja: "評価の指標名 (nDCG・インターリービング・95% 区間など) で表示する",
      en: "Show with evaluation terms (nDCG, interleaving, 95% intervals, and so on)",
    },
    lang_label: { ja: "言語", en: "Language" },
    confirm_button: { ja: "確定して送る", en: "Submit" },
    session: { ja: (id) => "セッション " + id, en: (id) => "session " + id },

    save_idle: { ja: "下書きを自動で保存", en: "Drafts save automatically" },
    save_saving: { ja: "保存中…", en: "Saving…" },
    save_saved: { ja: "保存済み", en: "Saved" },
    save_error: { ja: "保存に失敗しました", en: "Could not save" },
    save_closed: { ja: "確定済み", en: "Submitted" },

    hero_eyebrow: {
      ja: (a) => "週 1 回 · " + a.n + " 問 · 約 " + a.min + " 分",
      en: (a) => "Weekly · " + a.n + " questions · about " + a.min + " min",
    },
    hero_title_1: { ja: "今週の検索は、", en: "Were this week's searches" },
    hero_title_2: { ja: "役に立っていましたか。", en: "actually helpful?" },
    hero_lead: {
      ja: {
        g: "今週エージェントが実際に調べた問いと、確かめ用の問いを選びました。出てきた結果の 1 件ずつに「答えている・一部・関係ない」を付けてください。結果は 2 つの並べ方を混ぜたもので、どちらから出たかは伏せてあります。",
        x: "エージェントが今週実際に投げた問いと、評価セットの問いを選びました。結果の 1 件ずつに「答えている・一部関係する・関係ない」を付けてください。どの設定から出た結果かは伏せてあります。",
      },
      en: {
        g: "We picked questions your agents actually searched this week, plus some check questions. Mark each result as \"answers\", \"partly\" or \"not related\". The results mix two ways of ranking, and which one each came from is hidden.",
        x: "We picked queries the agents actually issued this week and questions from the evaluation set. Grade each result as \"answers\", \"partly relevant\" or \"not related\". Which configuration produced each result is hidden.",
      },
    },
    sum_guard: { ja: { g: "悪化の見張り", x: "ガード" }, en: { g: "Degradation watch", x: "Guard" } },
    sum_ndcg: { ja: { g: "検索の質", x: "nDCG@10 (本番)" }, en: { g: "Search quality", x: "nDCG@10 (production)" } },
    sum_interleave: { ja: { g: "いまの設定が上", x: "インターリービング" }, en: { g: "Current settings won", x: "Interleaving" } },
    sum_evalset: { ja: { g: "確かめ用の問い", x: "評価セット" }, en: { g: "Check questions", x: "Evaluation set" } },
    guard_none: { ja: { g: "まだ測っていない", x: "評価なし" }, en: { g: "Not measured yet", x: "No runs" } },
    guard_alert: { ja: { g: "悪くなっている", x: "警告" }, en: { g: "Getting worse", x: "Alert" } },
    guard_worse: { ja: "悪化の兆し", en: "Early warning" },
    guard_ok: { ja: "問題なし", en: "No problems" },
    il_sum_sub: {
      ja: { g: (a) => "逆 " + a.l + " · 差なし " + a.t, x: (a) => "分 " + a.t },
      en: { g: (a) => "vs " + a.l + " · even " + a.t, x: (a) => "ties " + a.t },
    },
    count_q: { ja: (n) => n + " 問", en: (n) => String(n) },
    evalset_sub: {
      ja: { g: (n) => "判定済み " + n, x: (n) => "人 " + n },
      en: { g: (n) => "judged " + n, x: (n) => "human " + n },
    },
    overview_title: { ja: "結果の一覧", en: "Overview" },
    overview_none: { ja: { g: "まだ測っていません", x: "評価の履歴なし" }, en: { g: "Not measured yet", x: "No evaluation history" } },
    overview_last: {
      ja: { g: (t) => "最後に測った日時 " + t, x: (t) => "最終評価 " + t + " · sm eval" },
      en: { g: (t) => "Last measured " + t, x: (t) => "Last run " + t + " · sm eval" },
    },
    chart_empty: { ja: "まだ評価がありません", en: "No evaluations yet" },

    prod: { ja: { g: "いまの設定", x: "本番" }, en: { g: "current settings", x: "production" } },
    prim: { ja: { g: "内容の近さだけ", x: "一次スコアだけ" }, en: { g: "similarity only", x: "primary score only" } },
    ndcg_title: { ja: { g: "検索の質の推移", x: "nDCG@10 の推移" }, en: { g: "Search quality over time", x: "nDCG@10 over time" } },
    ndcg_note: {
      ja: {
        g: "いまの設定 (新しさや使われ方も加味して並べ直す) と、内容の近さだけで並べた場合を、同じ問いで毎週測ったもの。100 点に近いほど、正解が上位に来ています。",
        x: "本番の設定 (rescore あり) と一次スコアだけを、同じ評価セットで毎週測ったもの。",
      },
      en: {
        g: "The current settings (which also re-rank by recency and use) and ranking by content similarity only, measured weekly on the same questions. The closer to 100, the higher the right answers appear.",
        x: "The production configuration (with rescore) and the primary score only, measured weekly on the same evaluation set.",
      },
    },
    ndcg_aria: {
      ja: {
        g: (a) => "週ごとの検索の質 (100 点満点)。いまの設定は " + a.p0 + " 点から " + a.p1 + " 点、内容の近さだけは " + a.q0 + " 点から " + a.q1 + " 点",
        x: (a) => "週ごとの nDCG@10。本番は " + a.p0 + " から " + a.p1 + "、一次スコアだけは " + a.q0 + " から " + a.q1,
      },
      en: {
        g: (a) => "Weekly search quality out of 100. Current settings went from " + a.p0 + " to " + a.p1 + "; similarity only from " + a.q0 + " to " + a.q1,
        x: (a) => "Weekly nDCG@10. Production went from " + a.p0 + " to " + a.p1 + "; primary score only from " + a.q0 + " to " + a.q1,
      },
    },
    guard_title: {
      ja: { g: "並べ直しで悪くなっていないか", x: "ガード — 差と 95% 区間" },
      en: { g: "Is re-ranking making things worse?", x: "Guard — difference and 95% interval" },
    },
    guard_sub: { ja: { g: "点の差とぶれ幅", x: "本番 − 一次スコアだけ" }, en: { g: "Score difference and margin", x: "production − primary only" } },
    guard_note: {
      ja: {
        g: "線 (ぶれ幅) がまるごと 0 より左、つまり並べ直すほうがはっきり悪い週が 2 週続いたら、通知で知らせます。設定は自動では変えません。",
        x: "区間の右端が 0 より左に 2 週続いたら、トーストで知らせます。設定は自動では変えません。",
      },
      en: {
        g: "If the whole line (the margin) sits left of 0, meaning re-ranking is clearly worse, for 2 weeks in a row, you get a notification. Settings are never changed automatically.",
        x: "If the upper end of the interval is below 0 for 2 weeks in a row, a toast alerts you. Settings are never changed automatically.",
      },
    },
    guard_worse_side: { ja: { g: "悪くなる側", x: "悪化" }, en: { g: "worse", x: "worse" } },
    guard_aria: {
      ja: {
        g: (a) => "週ごとの点の差 (いまの設定 − 内容の近さだけ) とぶれ幅。最新の週は " + a.m + "、ぶれ幅 " + a.lo + " から " + a.hi + (a.worse ? "。ぶれ幅ごと 0 より左で、悪くなっている" : "。はっきり悪くなってはいない"),
        x: (a) => "週ごとの差 (本番 − 一次スコアだけ) と 95% 区間。最新の週は " + a.m + "、区間 " + a.lo + " から " + a.hi + (a.worse ? "。区間の右端が 0 より左で、悪化している" : "。有意な悪化はない"),
      },
      en: {
        g: (a) => "Weekly score difference (current settings − similarity only) with its margin. Latest week " + a.m + ", margin " + a.lo + " to " + a.hi + (a.worse ? ". The whole margin is below 0: getting worse" : ". Not clearly worse"),
        x: (a) => "Weekly difference (production − primary only) with 95% interval. Latest week " + a.m + ", interval " + a.lo + " to " + a.hi + (a.worse ? ". Upper end below 0: significantly worse" : ". No significant degradation"),
      },
    },
    points_unit: { ja: " 点", en: " pts" },
    il_title: {
      ja: { g: "あなたの判定で、どちらが良かったか", x: "インターリービングの勝ち負け" },
      en: { g: "Which was better, by your judgments", x: "Interleaving wins and losses" },
    },
    il_p: { ja: (p) => "符号検定 p = " + p, en: (p) => "sign test p = " + p },
    il_win: { ja: { g: "いまの設定が良かった", x: "本番の勝ち" }, en: { g: "current settings better", x: "production wins" } },
    il_loss: { ja: { g: "内容の近さだけが良かった", x: "一次スコアだけの勝ち" }, en: { g: "similarity only better", x: "primary-only wins" } },
    il_tie: { ja: { g: "差なし", x: "引き分け (上位が同じ)" }, en: { g: "no difference", x: "ties (same top results)" } },
    il_win_short: { ja: { g: "いまの設定が良かった", x: "本番の勝ち" }, en: { g: "Current settings better", x: "Production wins" } },
    il_loss_short: { ja: { g: "内容の近さだけが良かった", x: "一次スコアだけの勝ち" }, en: { g: "Similarity only better", x: "Primary-only wins" } },
    il_tie_short: { ja: { g: "差なし", x: "引き分け" }, en: { g: "No difference", x: "Ties" } },
    il_until: { ja: (w) => w + " まで", en: (w) => "to " + w },
    il_aria: {
      ja: {
        g: (a) => "週ごとの判定の結果。累計は、いまの設定が良かった " + a.w + " 問、内容の近さだけが良かった " + a.l + " 問、差なし " + a.t + " 問",
        x: (a) => "週ごとの勝ち負け。累計は本番 " + a.w + " 勝、一次スコアだけ " + a.l + " 勝、引き分け " + a.t,
      },
      en: {
        g: (a) => "Weekly results of your judgments. In total: current settings better " + a.w + ", similarity only better " + a.l + ", no difference " + a.t,
        x: (a) => "Weekly wins and losses. In total: production " + a.w + ", primary only " + a.l + ", ties " + a.t,
      },
    },
    created_title: {
      ja: { g: "正解の記憶はいつ作られたか", x: "正解の作成日の分布" },
      en: { g: "When were the right answers written?", x: "Creation dates of relevant memories" },
    },
    created_sub: { ja: "週ごとの割合", en: "share per week" },
    created_corpus: { ja: { g: "すべての記憶", x: "検索対象" }, en: { g: "all memories", x: "corpus" } },
    created_gold: { ja: { g: "正解の記憶", x: "正解" }, en: { g: "right answers", x: "relevant" } },
    created_aria: {
      ja: {
        g: (a) => "作られた週ごとの割合。すべての記憶は " + a.c + "。正解の記憶は " + a.g,
        x: (a) => "作成週ごとの割合。検索対象は " + a.c + "。正解は " + a.g,
      },
      en: {
        g: (a) => "Share by week written. All memories: " + a.c + ". Right answers: " + a.g,
        x: (a) => "Share by creation week. Corpus: " + a.c + ". Relevant: " + a.g,
      },
    },
    created_warning: {
      ja: { g: (w) => w + " に作った記憶が、正解にほとんど入っていない", x: (w) => w + " の記憶が正解にほぼ無い" },
      en: { g: (w) => "Memories from " + w + " are almost never the right answer", x: (w) => w + " memories are nearly absent from the relevant set" },
    },

    judge_title: { ja: "判定", en: "Judge" },
    judge_hint: {
      ja: "1 件ずつ選ぶと、その場で下書きとして保存されます。タブを閉じても続きから再開できます。",
      en: "Each choice is saved as a draft right away. You can close the tab and pick up where you left off.",
    },
    progress_label: { ja: "判定の進み具合", en: "Judging progress" },
    progress_count: { ja: (a) => a.done + " / " + a.n + " 問", en: (a) => a.done + " / " + a.n + " questions" },
    qlist_label: { ja: "問いの一覧", en: "Questions" },
    q_label: {
      ja: (a) => "問 " + a.i + (a.st === "done" ? " (判定済み)" : a.st === "partial" ? " (途中)" : " (未判定)"),
      en: (a) => "Question " + a.i + (a.st === "done" ? " (judged)" : a.st === "partial" ? " (in progress)" : " (not judged)"),
    },
    q_no: { ja: (i) => "問 " + i, en: (i) => "Q" + i },
    kind_real: { ja: { g: "今週の問い", x: "実クエリ" }, en: { g: "this week's question", x: "real query" } },
    kind_synthetic: { ja: { g: "確かめ用の問い", x: "評価セット" }, en: { g: "check question", x: "evaluation set" } },
    asked_at: { ja: { g: (t) => "調べた日時 " + t, x: (t) => "問われた時点 " + t }, en: { g: (t) => "searched " + t, x: (t) => "asked at " + t } },
    scope: { ja: { g: (s) => "範囲 " + s, x: (s) => "scope " + s }, en: (s) => "scope " + s },
    differs: { ja: { g: "2 つの並べ方で上位が違う", x: "上位が違う" }, en: { g: "the two rankings differ", x: "top results differ" } },
    no_results: { ja: "この問いには結果がありませんでした。", en: "This question returned no results." },
    grade_legend: { ja: (no) => "結果 " + no + " の判定", en: (no) => "Judgment for result " + no },
    grade_2: { ja: "答えている", en: "Answers" },
    grade_1: { ja: "一部", en: "Partly" },
    grade_0: { ja: "関係ない", en: "Not related" },
    created_on: { ja: (d) => "作成 " + d, en: (d) => "written " + d },
    prov_human_confirmed: { ja: { g: "人が確認", x: "human_confirmed" }, en: { g: "confirmed by a person", x: "human_confirmed" } },
    prov_agent_verified: { ja: { g: "エージェントが確認", x: "agent_verified" }, en: { g: "verified by an agent", x: "agent_verified" } },
    prov_agent_inferred: { ja: { g: "エージェントの推測", x: "agent_inferred" }, en: { g: "inferred by an agent", x: "agent_inferred" } },
    stale_tag: { ja: (d) => "古い記憶 · " + d + " 日", en: (d) => "outdated · " + d + " days" },
    stale_check: { ja: "新しい版があり、これは古い", en: "A newer version exists; this one is outdated" },
    show_full: { ja: "全文を開く", en: "Show full text" },
    hide_full: { ja: "閉じる", en: "Hide" },
    prev_first: { ja: "← 前の問い", en: "← Previous" },
    prev_to: { ja: (i) => "← 問 " + i, en: (i) => "← Q" + i },
    next_to: { ja: (i) => "問 " + i + " へ →", en: (i) => "Q" + i + " →" },
    next_confirm: { ja: "確定の欄へ →", en: "To submit →" },
    card_note: {
      ja: {
        g: "結果は 2 つの並べ方から交互に取っています。どちらから出たかは、確定したあとにだけ分かります。",
        x: "結果の並びは 2 つの設定から交互に取ったもので、出どころは確定後のレポートにだけ出ます。",
      },
      en: {
        g: "Results alternate between two ways of ranking. Which one each came from is shown only after you submit.",
        x: "Results are interleaved from two configurations; their origin appears only in the report after submission.",
      },
    },

    confirm_title: { ja: { g: "判定を確定して送る", x: "確定して MCP サーバーに送る" }, en: { g: "Submit your judgments", x: "Submit to the MCP server" } },
    confirm_text: {
      ja: {
        g: "判定は「人の判定」として保存され、2 つの並べ方のどちらが良かったかの集計に加わります。確定したあとは直せません。",
        x: "判定は評価セットに「人の判定」として書き込まれ、インターリービングの勝ち負けが集計に加わります。確定したあとは直せません。",
      },
      en: {
        g: "Your judgments are saved as human judgments and added to the tally of which ranking was better. They cannot be changed after you submit.",
        x: "Judgments are written to the evaluation set as human labels, and the interleaving wins and losses are added to the totals. They cannot be changed after submission.",
      },
    },
    confirm_unjudged: {
      ja: (n) => "未判定の " + n + " 問は、付けた分だけを書き込みます (何も付けていない問いは判定なしとして扱います)。",
      en: (n) => " For the " + n + " unfinished questions, only the judgments you made are written (questions with none are treated as unjudged).",
    },
    confirm_meta: { ja: (a) => "送り先 " + a.host + " · セッション " + a.id, en: (a) => "to " + a.host + " · session " + a.id },
    dialog_title: { ja: "確定して送りますか", en: "Submit your judgments?" },
    dialog_final: { ja: "確定したあとは直せません。", en: "They cannot be changed afterwards." },
    dialog_cancel: { ja: "戻る", en: "Back" },
    dialog_ok: { ja: "確定する", en: "Submit" },
    dialog_all: { ja: (n) => "全 " + n + " 問の判定を送ります。", en: (n) => "Sending judgments for all " + n + " questions." },
    dialog_some: {
      ja: (a) => "未判定の問いが " + a.un + " 問あります (全 " + a.n + " 問)。付けた分だけを送り、何も付けていない問いは判定なしとして扱います。",
      en: (a) => a.un + " of " + a.n + " questions are not fully judged. Only the judgments you made are sent; questions with none are treated as unjudged.",
    },
    confirm_fallback: { ja: " 確定しますか。", en: " Submit?" },

    done_eyebrow_closed: { ja: "確定済み", en: "Already submitted" },
    done_title_closed: { ja: "このセッションは確定済みです。", en: "This session has already been submitted." },
    done_text_closed: { ja: "判定はすでに送られています。確定したあとは直せません。", en: "The judgments were already sent and cannot be changed." },
    done_eyebrow: { ja: "確定しました", en: "Submitted" },
    done_title: { ja: "判定を送りました。", en: "Your judgments were sent." },
    done_text: {
      ja: {
        g: (n) => n + " 問の判定を「人の判定」として保存しました。あなたの判定で、どちらの並べ方が良かったかは次のとおりです。",
        x: (n) => n + " 問の判定を評価セットに「人の判定」として書き込みました。インターリービングの出どころの集計は次のとおりです。",
      },
      en: {
        g: (n) => "Saved judgments for " + n + " questions as human judgments. Here is which ranking was better by your judgments.",
        x: (n) => "Wrote " + n + " questions to the evaluation set as human labels. Interleaving tally by origin:",
      },
    },
    done_foot: {
      ja: { g: "このタブは閉じてかまいません。次の週の測定に反映されます。", x: "このタブは閉じてかまいません。次の評価 (sm eval) のレポートに反映されます。" },
      en: { g: "You can close this tab. Your judgments count from next week's measurement.", x: "You can close this tab. The next evaluation (sm eval) report will include them." },
    },

    err_submit: {
      ja: (a) => "確定に失敗しました (" + a + ")。もう一度お試しください。",
      en: (a) => "Submitting failed (" + a + "). Please try again.",
    },
    err_unreachable_submit: {
      ja: "MCP サーバーに届きませんでした。サーバーが動いているか確かめて、もう一度お試しください。",
      en: "Could not reach the MCP server. Check that it is running and try again.",
    },
    err_no_token: {
      ja: "URL にセッションの id か合言葉がありません。トーストか sm feedback が開いた URL をそのまま使ってください。",
      en: "The URL is missing the session id or token. Use the URL opened by the toast or by sm feedback as is.",
    },
    err_unreachable: {
      ja: "MCP サーバーに届きませんでした。サーバーが動いているか確かめて、ページを読み込み直してください。",
      en: "Could not reach the MCP server. Check that it is running and reload the page.",
    },
    err_forbidden: {
      ja: "合言葉が合いません。トーストか sm feedback が開いた URL をそのまま使ってください。",
      en: "The token does not match. Use the URL opened by the toast or by sm feedback as is.",
    },
    err_not_found: {
      ja: "このセッションは見つかりません。sm feedback で新しいセッションを作ってください。",
      en: "This session was not found. Create a new one with sm feedback.",
    },
    err_data: { ja: (s) => "データを読めませんでした (" + s + ")。", en: (s) => "Could not read the data (" + s + ")." },
  };

  // ---- URL から id と合言葉 ----
  const pathParts = location.pathname.split("/").filter((s) => s !== "");
  const sessionId = pathParts[0] === "feedback" && pathParts.length >= 2 ? decodeURIComponent(pathParts[1]) : "";
  const token = new URLSearchParams(location.search).get("t") || "";
  const q = "?t=" + encodeURIComponent(token);
  const base = "/feedback/" + encodeURIComponent(sessionId);

  // ---- 状態 ----
  /** @type {any} */ let session = null;
  /** @type {Record<string, {grades: Record<string, number>, stale_ids: string[]}>} */ let draft = {};
  let current = 0;
  let saveTimer = 0;
  let saving = false;
  let dirty = false;
  let closed = false;
  let submitting = false;
  let saveState = "idle";
  /** 表示のモード。"general" = 一般向け (専門用語を言い換える) / "expert" = 専門向け (指標名のまま) */
  let mode = loadPref(MODE_KEY, ["general", "expert"], "general");
  /** 表示の言語。"ja" / "en"。保存が無ければブラウザーの言語から決める */
  let lang = loadPref(LANG_KEY, ["ja", "en"], defaultLang());
  /** 切り替えたときに描き直すための、最後に読んだデータ・完了の画面の中身・知らせ */
  /** @type {any} */ let lastData = null;
  /** @type {any} */ let lastDone = null;
  /** @type {{key: string, arg?: any} | null} */ let lastNotice = null;
  /** 全文を開いているカード (qid と memory_id の組)。問いを移っても、切り替えても保つ */
  const expanded = new Set();

  // ---- 小さな道具 ----
  function $(id) {
    const el = document.getElementById(id);
    if (el === null) throw new Error("要素がありません: " + id);
    return el;
  }

  /** 要素を作る。attrs の値が null / undefined / false なら付けない */
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    setAttrs(el, attrs);
    append(el, children);
    return el;
  }

  function s(tag, attrs, children) {
    const el = document.createElementNS(SVG_NS, tag);
    setAttrs(el, attrs);
    append(el, children);
    return el;
  }

  function setAttrs(el, attrs) {
    if (!attrs) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? "" : String(v));
    }
  }

  function append(el, children) {
    if (children === undefined || children === null) return;
    const list = Array.isArray(children) ? children : [children];
    for (const c of list) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function num(v, digits) {
    return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
  }

  // ---- 言語とモード ----
  function defaultLang() {
    const l = (navigator.language || "ja").toLowerCase();
    return l.startsWith("ja") ? "ja" : "en";
  }

  function loadPref(key, allowed, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v !== null && allowed.indexOf(v) >= 0 ? v : fallback;
    } catch {
      return fallback;
    }
  }

  function savePref(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // 保存できなくても、このタブの中では切り替わる
    }
  }

  /** 辞書から今の言語とモードの文言を引く。arg があれば関数に渡す */
  function t(key, arg) {
    const e = STRINGS[key];
    if (e === undefined) return key;
    let v = e[lang] !== undefined ? e[lang] : e.ja;
    if (v !== null && typeof v === "object") v = mode === "expert" ? v.x : v.g;
    return typeof v === "function" ? v(arg) : v;
  }

  /** nDCG などの 0〜1 の値。一般向けは 100 点満点の整数、専門向けは小数 3 桁 */
  function score(v) {
    if (typeof v !== "number" || !Number.isFinite(v)) return "—";
    return mode === "expert" ? v.toFixed(3) : String(Math.round(v * 100));
  }

  /** 差の値。一般向けは点 (小数 1 桁)、専門向けは小数 3 桁 */
  function scoreDiff(v) {
    if (typeof v !== "number" || !Number.isFinite(v)) return "—";
    return mode === "expert" ? v.toFixed(3) : (v * 100).toFixed(1) + t("points_unit");
  }

  /** 書き込みの出どころ。一般向けは言葉に直す */
  function provenanceLabel(p) {
    const key = "prov_" + p;
    return STRINGS[key] !== undefined ? t(key) : p;
  }

  /** 静的な文言 (data-t・data-t-title・data-t-aria) と切り替えボタンの状態を入れ直し、描き直す */
  function applyPrefs() {
    const root = document.documentElement;
    root.lang = lang;
    root.dataset.mode = mode;
    document.title = t("page_title");
    for (const b of document.querySelectorAll(".mode-btn")) {
      b.setAttribute("aria-pressed", b.getAttribute("data-mode") === mode ? "true" : "false");
    }
    for (const b of document.querySelectorAll(".lang-btn")) {
      b.setAttribute("aria-pressed", b.getAttribute("data-lang") === lang ? "true" : "false");
    }
    for (const el of document.querySelectorAll("[data-t]")) el.textContent = t(el.getAttribute("data-t"));
    for (const el of document.querySelectorAll("[data-t-title]")) el.setAttribute("title", t(el.getAttribute("data-t-title")));
    for (const el of document.querySelectorAll("[data-t-aria]")) el.setAttribute("aria-label", t(el.getAttribute("data-t-aria")));
    for (const el of document.querySelectorAll("[data-expert-only]")) {
      /** @type {HTMLElement} */ (el).hidden = mode !== "expert";
    }
    setSaveState(saveState);
    if (lastNotice !== null) $("notice").textContent = t(lastNotice.key, lastNotice.arg);
    if (lastData !== null && !closed) renderAll(lastData);
    if (lastDone !== null) renderDone(lastDone.written, lastDone.outcomes);
  }

  function setMode(next) {
    if (next !== "general" && next !== "expert") return;
    mode = next;
    savePref(MODE_KEY, mode);
    applyPrefs();
  }

  function setLang(next) {
    if (next !== "ja" && next !== "en") return;
    lang = next;
    savePref(LANG_KEY, lang);
    applyPrefs();
  }

  /** 0.874 → ".874"、-0.012 → "−.012" (グラフの目盛り用) */
  function short(v, digits) {
    const x = Math.abs(v).toFixed(digits).replace(/^0(?=\.)/, "");
    return (v < 0 ? "−" : v > 0 ? "+" : "") + x;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  /** ISO 週 (月曜始まり)。core の isoWeek と同じく UTC で数える */
  function isoWeek(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dow = u.getUTCDay() || 7;
    u.setUTCDate(u.getUTCDate() + 4 - dow);
    const year = u.getUTCFullYear();
    const week = Math.ceil(((u.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
    return year + "-W" + pad2(week);
  }

  function weekLabel(w) {
    const m = /W\d+$/.exec(w);
    return m ? m[0] : w;
  }

  /** ローカル時刻の "2026-10-20 14:32" */
  function localTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function localDay(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.getMonth() + 1 + "/" + pad2(d.getDate());
  }

  function svgRoot(text) {
    return s("svg", { viewBox: "0 0 340 170", role: "img", "aria-label": text, focusable: "false" });
  }

  function label(x, y, text, anchor, cls) {
    return s("text", { x: x, y: y, class: cls || "c-label", "text-anchor": anchor || null }, text);
  }

  function emptyChart(host) {
    clear(host);
    host.appendChild(h("p", { class: "chart-empty" }, t("chart_empty")));
  }

  // ---- 通信 ----
  async function getJson(path) {
    const res = await fetch(path, { headers: { Accept: "application/json" }, cache: "no-store", credentials: "same-origin" });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body: body };
  }

  async function postJson(path, value, keepalive) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(value),
      cache: "no-store",
      credentials: "same-origin",
      keepalive: !!keepalive,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body: body };
  }

  // ---- 画面の切り替え ----
  function showNotice(key, arg) {
    lastNotice = { key: key, arg: arg };
    $("app").hidden = true;
    $("done").hidden = true;
    const n = $("notice");
    n.textContent = t(key, arg);
    n.hidden = false;
    setConfirmEnabled(false);
    setSaveState("idle");
  }

  function setConfirmEnabled(on) {
    $("bar-confirm").disabled = !on;
    $("confirm-btn").disabled = !on;
  }

  function setSaveState(state) {
    saveState = state;
    const el = $("save-state");
    el.dataset.state = state;
    el.textContent = t("save_" + state);
  }

  /** 完了の画面。written が null なら「確定済み」(すでに確定されていた) の画面 */
  function showDone(written, outcomes) {
    lastDone = { written: written, outcomes: outcomes };
    closed = true;
    clearTimeout(saveTimer);
    $("app").hidden = true;
    $("notice").hidden = true;
    const done = $("done");
    done.hidden = false;
    setConfirmEnabled(false);
    setSaveState("closed");
    renderDone(written, outcomes);
    done.focus();
  }

  /** 完了の画面の文言と集計 (切り替えたときも呼ぶ) */
  function renderDone(written, outcomes) {
    if (written === null) {
      $("done-eyebrow").textContent = t("done_eyebrow_closed");
      $("done-title").textContent = t("done_title_closed");
      $("done-text").textContent = t("done_text_closed");
    } else {
      $("done-eyebrow").textContent = t("done_eyebrow");
      $("done-title").textContent = t("done_title");
      $("done-text").textContent = t("done_text", written);
    }
    const tally = { a: 0, b: 0, tie: 0 };
    for (const o of Object.values(outcomes || {})) if (o in tally) tally[o]++;
    const has = outcomes && Object.keys(outcomes).length > 0;
    $("done-summary").hidden = !has;
    $("done-wins").textContent = String(tally.a);
    $("done-losses").textContent = String(tally.b);
    $("done-ties").textContent = String(tally.tie);
  }

  // ---- 上の帯・見出し・要約 ----
  function renderHeader(data) {
    const s0 = data.session;
    const n = s0.items.length;
    $("bar-meta").textContent = isoWeek(s0.created_at) + " · " + t("session", s0.id);
    $("hero-eyebrow").textContent = t("hero_eyebrow", { n: n, min: Math.max(1, Math.round(n / 2)) });
    $("confirm-meta").textContent = t("confirm_meta", { host: location.host, id: s0.id });

    const hist = data.dashboard.history || [];
    const latest = hist.length > 0 ? hist[hist.length - 1] : null;

    const guard = $("sum-guard");
    clear(guard);
    guard.removeAttribute("title");
    if (latest === null) {
      append(guard, [h("span", { class: "dot", "data-level": "none", "aria-hidden": "true" }), t("guard_none")]);
    } else {
      const level = latest.guard.alert ? "alert" : latest.guard.worse ? "worse" : "ok";
      append(guard, [h("span", { class: "dot", "data-level": level, "aria-hidden": "true" }), t("guard_" + level)]);
      // 理由は指標の言葉 (日本語) で書かれているので、専門向けだけに出す
      if (latest.guard.reason && mode === "expert") guard.title = latest.guard.reason;
    }

    const sumNdcg = $("sum-ndcg");
    clear(sumNdcg);
    append(sumNdcg, latest === null ? "—" : [score(latest.production.ndcg10), mode === "expert" ? null : h("span", { class: "sub" }, "/ 100")]);

    const il = data.dashboard.interleave;
    const sumIl = $("sum-interleave");
    clear(sumIl);
    // 一般向けは「いまの設定が良かった問いの数」を主に、逆と差なしを添える
    append(sumIl, [
      mode === "expert" ? il.wins + " – " + il.losses : t("count_q", il.wins),
      h("span", { class: "sub" }, t("il_sum_sub", { l: il.losses, t: il.ties })),
    ]);

    const es = data.dashboard.eval_set;
    const sumEs = $("sum-evalset");
    clear(sumEs);
    append(sumEs, [t("count_q", es.questions), h("span", { class: "sub" }, t("evalset_sub", es.human))]);

    $("overview-meta").textContent = latest === null ? t("overview_none") : t("overview_last", localTime(latest.at));
  }

  // ---- グラフ 1: nDCG@10 の推移 ----
  function renderNdcg(hist) {
    const host = $("chart-ndcg");
    if (hist.length === 0) return emptyChart(host);
    const prod = hist.map((r) => r.production.ndcg10);
    const prim = hist.map((r) => r.primary.ndcg10);
    const all = prod.concat(prim).filter((v) => Number.isFinite(v));
    let lo = Math.min.apply(null, all);
    let hi = Math.max.apply(null, all);
    const padY = Math.max((hi - lo) * 0.15, 0.01);
    lo = Math.max(0, lo - padY);
    hi = Math.min(1, hi + padY);
    if (hi - lo < 0.02) hi = lo + 0.02;
    const top = 20, bottom = 140, left = 34, right = 330;
    const y = (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
    const xs = hist.map((_, i) => (hist.length === 1 ? (left + right) / 2 : left + 8 + (i * (right - left - 16)) / (hist.length - 1)));
    const pts = (vals) => vals.map((v, i) => xs[i].toFixed(1) + "," + y(v).toFixed(1)).join(" ");

    const first = hist[0], last = hist[hist.length - 1];
    const fmt = (v) => (mode === "expert" ? num(v, 3) : score(v));
    const svg = svgRoot(
      t("ndcg_aria", {
        p0: fmt(first.production.ndcg10),
        p1: fmt(last.production.ndcg10),
        q0: fmt(first.primary.ndcg10),
        q1: fmt(last.primary.ndcg10),
      }),
    );
    const mid = (lo + hi) / 2;
    const grid = s("g", { class: "c-grid" });
    const ticks = s("g");
    for (const v of [hi, mid, lo]) {
      grid.appendChild(s("line", { x1: left, y1: y(v).toFixed(1), x2: right, y2: y(v).toFixed(1) }));
      ticks.appendChild(label(0, (y(v) + 3).toFixed(1), mode === "expert" ? short(v, 3).replace("+", "") : String(Math.round(v * 100))));
    }
    svg.appendChild(grid);
    svg.appendChild(ticks);
    if (hist.length > 1) {
      svg.appendChild(s("polyline", { points: pts(prim), class: "c-line-prim" }));
      svg.appendChild(s("polyline", { points: pts(prod), class: "c-line-prod" }));
    }
    const dots = s("g", { class: "c-dot" });
    prim.forEach((v, i) => {
      if (hist.length === 1) dots.appendChild(s("rect", { x: xs[i] - 2, y: y(v) - 2, width: 4, height: 4, class: "c-mean" }));
    });
    prod.forEach((v, i) => dots.appendChild(s("circle", { cx: xs[i].toFixed(1), cy: y(v).toFixed(1), r: i === prod.length - 1 ? 3.5 : 2.5 })));
    svg.appendChild(dots);
    const weeks = s("g");
    const step = Math.ceil(hist.length / 6);
    hist.forEach((r, i) => {
      if ((hist.length - 1 - i) % step === 0) weeks.appendChild(label(xs[i].toFixed(1), 160, weekLabel(isoWeek(r.at)), "middle"));
    });
    svg.appendChild(weeks);
    clear(host);
    host.appendChild(svg);
  }

  // ---- グラフ 2: ガードの差と 95% 区間 ----
  function renderGuard(hist) {
    const host = $("chart-guard");
    if (hist.length === 0) return emptyChart(host);
    const rows = hist.slice(-6);
    let m = 0.01;
    for (const r of rows) m = Math.max(m, Math.abs(r.diff.lo), Math.abs(r.diff.hi), Math.abs(r.diff.mean));
    m *= 1.15;
    const left = 20, right = 290, top = 8, bottom = 146;
    const x = (v) => left + ((v + m) / (2 * m)) * (right - left);
    const rowH = (bottom - top) / rows.length;
    const last = rows[rows.length - 1];
    const svg = svgRoot(
      t("guard_aria", { m: scoreDiff(last.diff.mean), lo: scoreDiff(last.diff.lo), hi: scoreDiff(last.diff.hi), worse: last.guard.worse }),
    );
    svg.appendChild(s("rect", { x: left, y: top, width: (x(0) - left).toFixed(1), height: bottom - top, class: "c-worse" }));
    svg.appendChild(s("line", { x1: x(0).toFixed(1), y1: top, x2: x(0).toFixed(1), y2: bottom, class: "c-zero" }));
    svg.appendChild(label(left + 4, top + 12, t("guard_worse_side")));
    const axis = (v) => (mode === "expert" ? short(v, 2) : short(v * 100, 1));
    svg.appendChild(label(left, 160, axis(-m)));
    svg.appendChild(label(x(0).toFixed(1), 160, "0", "middle"));
    svg.appendChild(label(right, 160, axis(m), "end"));
    rows.forEach((r, i) => {
      const cy = top + rowH * (i + 0.5);
      const isLast = i === rows.length - 1;
      const cls = (isLast ? "c-ci-latest" : "c-ci") + (r.diff.hi < 0 ? " c-ci-bad" : "");
      svg.appendChild(s("line", { x1: x(r.diff.lo).toFixed(1), y1: cy.toFixed(1), x2: x(r.diff.hi).toFixed(1), y2: cy.toFixed(1), class: cls }));
      const size = isLast ? 8 : 6;
      svg.appendChild(s("rect", { x: (x(r.diff.mean) - size / 2).toFixed(1), y: (cy - size / 2).toFixed(1), width: size, height: size, class: isLast ? "c-mean-latest" : "c-mean" }));
      svg.appendChild(label(right + 10, (cy + 3).toFixed(1), weekLabel(isoWeek(r.at)), null, isLast ? "c-label-strong" : "c-label"));
    });
    clear(host);
    host.appendChild(svg);
  }

  // ---- グラフ 3: インターリービングの週ごとの積み上げ ----
  // 履歴の interleave は実行の時点の累計なので、隣どうしの差をその週の分とする。
  function renderInterleave(hist, totals) {
    const host = $("chart-interleave");
    $("chart-interleave-p").textContent = t("il_p", num(totals.p, 2));
    if (hist.length === 0) return emptyChart(host);
    /** @type {{week: string, w: number, l: number, t: number}[]} */
    let bars = [];
    if (hist.length === 1) {
      const r = hist[0];
      bars.push({ week: t("il_until", weekLabel(isoWeek(r.at))), w: r.interleave.wins, l: r.interleave.losses, t: r.interleave.ties });
    } else {
      for (let i = 1; i < hist.length; i++) {
        const a = hist[i - 1].interleave, b = hist[i].interleave;
        bars.push({
          week: weekLabel(isoWeek(hist[i].at)),
          w: Math.max(0, b.wins - a.wins),
          l: Math.max(0, b.losses - a.losses),
          t: Math.max(0, b.ties - a.ties),
        });
      }
    }
    bars = bars.slice(-6);
    let max = 1;
    for (const b of bars) max = Math.max(max, b.w + b.l + b.t);
    const left = 20, right = 330, top = 16, bottom = 140;
    const slot = (right - left) / bars.length;
    const bw = Math.min(36, slot * 0.6);
    const unit = (bottom - top) / max;
    const svg = svgRoot(t("il_aria", { w: totals.wins, l: totals.losses, t: totals.ties }));
    svg.appendChild(s("line", { x1: left, y1: bottom, x2: right, y2: bottom, class: "c-grid" }));
    bars.forEach((b, i) => {
      const bx = left + slot * i + (slot - bw) / 2;
      let yTop = bottom;
      for (const [v, cls] of [[b.w, "c-win"], [b.l, "c-loss"], [b.t, "c-tie"]]) {
        if (v <= 0) continue;
        const hgt = v * unit;
        yTop -= hgt;
        svg.appendChild(s("rect", { x: bx.toFixed(1), y: yTop.toFixed(1), width: bw.toFixed(1), height: hgt.toFixed(1), class: cls }));
      }
      const total = b.w + b.l + b.t;
      svg.appendChild(label((bx + bw / 2).toFixed(1), (yTop - 4).toFixed(1), total === 0 ? "0" : b.w + "–" + b.l, "middle"));
      svg.appendChild(label((bx + bw / 2).toFixed(1), 156, b.week, "middle"));
    });
    clear(host);
    host.appendChild(svg);
  }

  // ---- グラフ 4: 正解の作成日の分布 ----
  function renderCreated(dist) {
    const host = $("chart-created");
    const warn = $("created-warning");
    warn.hidden = true;
    if (!dist || !Array.isArray(dist.weeks) || dist.weeks.length === 0) return emptyChart(host);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const cTotal = sum(dist.corpus) || 1;
    const gTotal = sum(dist.gold) || 1;
    /** @type {{week: string, c: number, g: number}[]} */
    let cols = dist.weeks.map((w, i) => ({ week: weekLabel(w), c: (dist.corpus[i] || 0) / cTotal, g: (dist.gold[i] || 0) / gTotal }));
    if (cols.length > CREATED_WEEKS_MAX) {
      const head = cols.slice(0, cols.length - CREATED_WEEKS_MAX + 1);
      const rest = cols.slice(cols.length - CREATED_WEEKS_MAX + 1);
      cols = [{ week: "〜" + head[head.length - 1].week, c: sum(head.map((x) => x.c)), g: sum(head.map((x) => x.g)) }].concat(rest);
    }
    let max = 0.05;
    for (const c of cols) max = Math.max(max, c.c, c.g);
    const left = 20, right = 330, top = 26, bottom = 140;
    const slot = (right - left) / cols.length;
    const bw = Math.min(32, slot * 0.38);
    const yv = (v) => bottom - (v / max) * (bottom - top);
    const pct = (v) => Math.round(v * 100) + "%";
    const sep = lang === "ja" ? "、" : ", ";
    const svg = svgRoot(t("created_aria", { c: cols.map((c) => pct(c.c)).join(sep), g: cols.map((c) => pct(c.g)).join(sep) }));
    svg.appendChild(s("line", { x1: left, y1: bottom, x2: right, y2: bottom, class: "c-grid" }));
    const fs = cols.length > 6 ? 7 : 9;
    cols.forEach((c, i) => {
      const cx = left + slot * i + slot / 2;
      const x1 = cx - bw - 2, x2 = cx + 2;
      const hc = Math.max(c.c > 0 ? 1 : 0, bottom - yv(c.c));
      const hg = Math.max(c.g > 0 ? 1 : 0, bottom - yv(c.g));
      svg.appendChild(s("rect", { x: x1.toFixed(1), y: (bottom - hc).toFixed(1), width: bw.toFixed(1), height: hc.toFixed(1), class: "c-corpus" }));
      svg.appendChild(s("rect", { x: x2.toFixed(1), y: (bottom - hg).toFixed(1), width: bw.toFixed(1), height: hg.toFixed(1), class: "c-gold" }));
      const t1 = label((x1 + bw / 2).toFixed(1), (bottom - hc - 4).toFixed(1), pct(c.c), "middle");
      const t2 = label((x2 + bw / 2).toFixed(1), (bottom - hg - 4).toFixed(1), pct(c.g), "middle", "c-label-strong");
      t1.setAttribute("font-size", String(fs));
      t2.setAttribute("font-size", String(fs));
      svg.appendChild(t1);
      svg.appendChild(t2);
      svg.appendChild(label(cx.toFixed(1), 156, c.week, "middle"));
    });
    const last = cols[cols.length - 1];
    if (last.c > 0.05 && last.g < last.c / 4) {
      warn.textContent = t("created_warning", last.week);
      warn.hidden = false;
    }
    clear(host);
    host.appendChild(svg);
  }

  /** 上の帯・要約・グラフ 4 つと、表示中の問いを描く (切り替えたときも呼ぶ) */
  function renderAll(data) {
    renderHeader(data);
    const hist = data.dashboard.history || [];
    renderNdcg(hist);
    renderGuard(hist);
    renderInterleave(hist, data.dashboard.interleave);
    renderCreated(data.dashboard.created_dist);
    if (session !== null && session.items.length > 0 && $("qlist").childNodes.length > 0) {
      renderCard();
      renderProgress();
    }
  }

  // ---- 判定 ----
  function entryOf(qid) {
    if (!draft[qid]) draft[qid] = { grades: {}, stale_ids: [] };
    return draft[qid];
  }

  /** "done" = 全部の結果に判定 / "partial" = 一部 / "none" = 何も無い */
  function stateOf(item) {
    const e = draft[item.qid];
    if (!e) return "none";
    const graded = item.cards.filter((c) => e.grades[c.id] === 0 || e.grades[c.id] === 1 || e.grades[c.id] === 2).length;
    if (item.cards.length > 0 && graded === item.cards.length) return "done";
    if (graded > 0 || e.stale_ids.length > 0) return "partial";
    return "none";
  }

  function renderProgress() {
    const items = session.items;
    const done = items.filter((it) => stateOf(it) === "done").length;
    const pct = items.length === 0 ? 0 : Math.round((done / items.length) * 100);
    $("progress-count").textContent = t("progress_count", { done: done, n: items.length });
    $("progress-pct").textContent = pct + "%";
    const track = $("progress-track");
    track.setAttribute("aria-valuemax", String(items.length));
    track.setAttribute("aria-valuenow", String(done));
    $("progress-fill").style.width = pct + "%";

    const list = $("qlist");
    const buttons = list.querySelectorAll("button");
    items.forEach((it, i) => {
      const b = buttons[i];
      if (!b) return;
      const st = stateOf(it);
      b.dataset.state = st;
      b.textContent = i + 1 + (st === "done" ? " ✓" : "");
      b.setAttribute("aria-label", t("q_label", { i: i + 1, st: st }));
      if (i === current) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    });
    renderConfirmText();
  }

  function renderQList() {
    const list = $("qlist");
    clear(list);
    session.items.forEach((_, i) => {
      const b = h("button", { type: "button" }, String(i + 1));
      b.addEventListener("click", () => {
        goTo(i, false);
      });
      list.appendChild(h("li", null, b));
    });
    // 10 問より少ないときは列の数を合わせる (CSSOM なので CSP に止められない)
    list.style.gridTemplateColumns = "repeat(" + Math.max(1, session.items.length) + ", minmax(0, 1fr))";
  }

  function goTo(i, focusCard) {
    current = Math.max(0, Math.min(session.items.length - 1, i));
    renderCard();
    renderProgress();
    if (focusCard) {
      $("card-query").scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }

  function renderCard() {
    const it = session.items[current];
    const meta = $("card-meta");
    clear(meta);
    const parts = [t("q_no", current + 1), t(it.kind === "real" ? "kind_real" : "kind_synthetic"), t("asked_at", localTime(it.asked_at))];
    parts.forEach((p, i) => {
      if (i > 0) meta.appendChild(h("span", { "aria-hidden": "true" }, "·"));
      meta.appendChild(h("span", null, p));
    });
    if (it.filters && it.filters.scope) {
      meta.appendChild(h("span", { "aria-hidden": "true" }, "·"));
      meta.appendChild(h("span", null, t("scope", it.filters.scope)));
    }
    if (it.differs) meta.appendChild(h("span", { class: "tag tag-accent" }, t("differs")));
    $("card-query").textContent = it.query;

    const ul = $("results");
    clear(ul);
    const e = draft[it.qid];
    if (it.cards.length === 0) {
      ul.appendChild(h("li", null, h("p", { class: "muted" }, t("no_results"))));
    }
    it.cards.forEach((c, j) => {
      const no = pad2(j + 1);
      const name = "g-" + current + "-" + j;
      const legendId = name + "-legend";
      const titleId = name + "-title";
      const grade = e ? e.grades[c.id] : undefined;
      const stale = e ? e.stale_ids.indexOf(c.id) >= 0 : false;

      const fieldset = h("fieldset", { class: "grade", "aria-describedby": titleId }, [h("legend", { id: legendId }, t("grade_legend", no))]);
      for (const value of GRADE_VALUES) {
        const input = h("input", { type: "radio", name: name, value: value, checked: grade === value });
        input.addEventListener("change", () => {
          if (closed) return;
          entryOf(it.qid).grades[c.id] = value;
          changed();
        });
        fieldset.appendChild(h("label", null, [input, t("grade_" + value)]));
      }

      const metaRow = h("p", { class: "result-meta" }, [
        h("span", null, t("created_on", localDay(c.created_at))),
        h("span", null, provenanceLabel(c.provenance)),
        h("span", null, c.scope),
        c.stale ? h("span", { class: "tag tag-warning" }, t("stale_tag", c.age_days)) : null,
      ]);
      const check = h("input", { type: "checkbox", checked: stale });
      check.addEventListener("change", () => {
        if (closed) return;
        const en = entryOf(it.qid);
        const k = en.stale_ids.indexOf(c.id);
        if (check.checked && k < 0) en.stale_ids.push(c.id);
        if (!check.checked && k >= 0) en.stale_ids.splice(k, 1);
        changed();
      });
      // 抜粋は検索側で切られている。サーバーが全文 (body) を添えたときだけ、開閉できるようにする
      const full = typeof c.body === "string" ? c.body : "";
      const hasMore = full !== "" && Array.from(full.replace(/\s+/g, " ").trim()).length > Array.from(c.excerpt.trim()).length;
      const openKey = it.qid + "\u0000" + c.id;
      const isOpen = hasMore && expanded.has(openKey);
      const bodyId = name + "-body";
      const excerptEl = h("p", { class: "result-excerpt", hidden: isOpen }, c.excerpt + (hasMore && !c.excerpt.endsWith("…") ? "…" : ""));
      const fullEl = hasMore ? h("div", { class: "result-body", id: bodyId, hidden: !isOpen }, full) : null;
      let toggle = null;
      if (hasMore) {
        const btn = h("button", { type: "button", class: "result-toggle", "aria-expanded": isOpen ? "true" : "false", "aria-controls": bodyId }, t(isOpen ? "hide_full" : "show_full"));
        btn.addEventListener("click", () => {
          const open = !expanded.has(openKey);
          if (open) expanded.add(openKey);
          else expanded.delete(openKey);
          excerptEl.hidden = open;
          /** @type {HTMLElement} */ (fullEl).hidden = !open;
          btn.setAttribute("aria-expanded", open ? "true" : "false");
          btn.textContent = t(open ? "hide_full" : "show_full");
        });
        toggle = btn;
      }
      const body = h("div", null, [
        h("p", { class: "result-title", id: titleId }, c.title),
        excerptEl,
        fullEl,
        toggle,
        metaRow,
        h("label", { class: "stale-check" }, [check, t("stale_check")]),
      ]);
      ul.appendChild(h("li", { "data-stale": c.stale ? "true" : "false" }, [h("span", { class: "result-no", "aria-hidden": "true" }, no), body, fieldset]));
    });

    const prev = $("prev-q");
    const next = $("next-q");
    prev.disabled = current === 0;
    prev.textContent = current === 0 ? t("prev_first") : t("prev_to", current);
    next.textContent = current === session.items.length - 1 ? t("next_confirm") : t("next_to", current + 2);
  }

  function unjudgedCount() {
    return session.items.filter((it) => stateOf(it) !== "done").length;
  }

  function renderConfirmText() {
    const un = unjudgedCount();
    $("confirm-text").textContent = t("confirm_text") + (un > 0 ? t("confirm_unjudged", un) : "");
  }

  // ---- 下書きの保存 (連続した操作は 500ms まとめる) ----
  function changed() {
    dirty = true;
    renderProgress();
    setSaveState("saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DELAY_MS);
  }

  async function flush() {
    if (closed || !dirty) return;
    if (saving) {
      // 送っている最中の変更は、終わってからもう一度送る
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, SAVE_DELAY_MS);
      return;
    }
    saving = true;
    dirty = false;
    setSaveState("saving");
    try {
      const r = await postJson(base + "/draft" + q, { draft: draft });
      if (r.status === 200) {
        if (!dirty) setSaveState("saved");
      } else if (r.status === 409) {
        showDone(null, null);
      } else {
        dirty = true;
        setSaveState("error");
      }
    } catch {
      dirty = true;
      setSaveState("error");
    } finally {
      saving = false;
    }
  }

  // タブを閉じる前に、まだ送っていない下書きを送る
  window.addEventListener("pagehide", () => {
    if (closed || !dirty || session === null) return;
    clearTimeout(saveTimer);
    postJson(base + "/draft" + q, { draft: draft }, true).catch(() => {});
  });

  // ---- 確定 ----
  function openConfirm() {
    if (closed || session === null) return;
    const un = unjudgedCount();
    const n = session.items.length;
    $("dialog-text").textContent = un === 0 ? t("dialog_all", n) : t("dialog_some", { un: un, n: n });
    const dlg = /** @type {HTMLDialogElement} */ ($("confirm-dialog"));
    if (typeof dlg.showModal === "function") dlg.showModal();
    else if (window.confirm($("dialog-text").textContent + t("confirm_fallback"))) submit();
  }

  async function submit() {
    if (submitting || closed) return;
    submitting = true;
    clearTimeout(saveTimer);
    setConfirmEnabled(false);
    setSaveState("saving");
    try {
      const r = await postJson(base + "/submit" + q, { draft: draft });
      if (r.status === 200) {
        dirty = false;
        const written = r.body && typeof r.body.written === "number" ? r.body.written : 0;
        let outcomes = null;
        try {
          const d = await getJson(base + "/data" + q);
          if (d.status === 200 && d.body && d.body.session) outcomes = d.body.session.outcomes || null;
        } catch {
          outcomes = null;
        }
        showDone(written, outcomes);
      } else if (r.status === 409) {
        showDone(null, null);
      } else {
        setSaveState("error");
        setConfirmEnabled(true);
        window.alert(t("err_submit", r.status + (r.body && r.body.error ? ": " + r.body.error : "")));
      }
    } catch {
      setSaveState("error");
      setConfirmEnabled(true);
      window.alert(t("err_unreachable_submit"));
    } finally {
      submitting = false;
    }
  }

  function wire() {
    $("bar-confirm").addEventListener("click", openConfirm);
    $("confirm-btn").addEventListener("click", openConfirm);
    const dlg = /** @type {HTMLDialogElement} */ ($("confirm-dialog"));
    $("dialog-cancel").addEventListener("click", () => dlg.close());
    $("dialog-ok").addEventListener("click", () => {
      dlg.close();
      submit();
    });
    for (const b of document.querySelectorAll(".mode-btn")) {
      b.addEventListener("click", () => setMode(b.getAttribute("data-mode")));
    }
    for (const b of document.querySelectorAll(".lang-btn")) {
      b.addEventListener("click", () => setLang(b.getAttribute("data-lang")));
    }
    $("prev-q").addEventListener("click", () => goTo(current - 1, true));
    $("next-q").addEventListener("click", () => {
      if (current === session.items.length - 1) {
        $("confirm").scrollIntoView({ block: "start", behavior: "smooth" });
        $("confirm-btn").focus({ preventScroll: true });
      } else {
        goTo(current + 1, true);
      }
    });
  }

  // ---- 起動 ----
  async function start() {
    wire();
    applyPrefs();
    setSaveState("idle");
    if (sessionId === "" || token === "") {
      showNotice("err_no_token");
      return;
    }
    let r;
    try {
      r = await getJson(base + "/data" + q);
    } catch {
      showNotice("err_unreachable");
      return;
    }
    if (r.status === 403) return showNotice("err_forbidden");
    if (r.status === 404) return showNotice("err_not_found");
    if (r.status !== 200 || !r.body || !r.body.session) return showNotice("err_data", r.status);

    const data = r.body;
    session = data.session;
    draft = {};
    for (const [qid, e] of Object.entries(session.draft || {})) {
      draft[qid] = { grades: Object.assign({}, e.grades || {}), stale_ids: Array.isArray(e.stale_ids) ? e.stale_ids.slice() : [] };
    }

    if (session.status === "confirmed") {
      showDone(null, session.outcomes || null);
      return;
    }

    $("notice").hidden = true;
    lastNotice = null;
    $("app").hidden = false;
    lastData = data;
    renderAll(data);

    if (session.items.length === 0) {
      $("card").hidden = true;
      $("qlist").hidden = true;
    } else {
      renderQList();
      // 最初の未完了の問いから始める
      const firstOpen = session.items.findIndex((it) => stateOf(it) !== "done");
      current = firstOpen >= 0 ? firstOpen : 0;
      renderCard();
      renderProgress();
    }
    setConfirmEnabled(true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
