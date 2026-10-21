// 検索フィードバックの画面の動き。ビルドの手順は無く、このファイルをそのまま配る。
// CSP は script-src 'self' / style-src 'self' なので、インラインの script・on* 属性・style 属性を使わない
// (要素の大きさは CSSOM の el.style で変える。これは CSP に止められない)。
// 文字列は textContent で入れ、innerHTML は使わない (記憶のタイトルと抜粋はデータとして扱う)。
"use strict";

(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const SAVE_DELAY_MS = 500;
  const GRADE_CHOICES = [
    { value: 2, label: "答えている" },
    { value: 1, label: "一部" },
    { value: 0, label: "関係ない" },
  ];
  const CREATED_WEEKS_MAX = 8;

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

  /** 0.874 → ".874"、-0.012 → "−.012" (グラフの目盛り用) */
  function short(v, digits) {
    const t = Math.abs(v).toFixed(digits).replace(/^0(?=\.)/, "");
    return (v < 0 ? "−" : v > 0 ? "+" : "") + t;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  /** ISO 週 (月曜始まり)。core の isoWeek と同じく UTC で数える */
  function isoWeek(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dow = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - dow);
    const year = t.getUTCFullYear();
    const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
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

  function svgRoot(label) {
    return s("svg", { viewBox: "0 0 340 170", role: "img", "aria-label": label, focusable: "false" });
  }

  function label(x, y, text, anchor, cls) {
    return s("text", { x: x, y: y, class: cls || "c-label", "text-anchor": anchor || null }, text);
  }

  function emptyChart(host) {
    clear(host);
    host.appendChild(h("p", { class: "chart-empty" }, "まだ評価がありません"));
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
  function showNotice(text) {
    $("app").hidden = true;
    $("done").hidden = true;
    const n = $("notice");
    n.textContent = text;
    n.hidden = false;
    setConfirmEnabled(false);
    setSaveState("idle");
  }

  function setConfirmEnabled(on) {
    $("bar-confirm").disabled = !on;
    $("confirm-btn").disabled = !on;
  }

  function setSaveState(state) {
    const el = $("save-state");
    el.dataset.state = state;
    el.textContent =
      state === "saving" ? "保存中…" : state === "saved" ? "保存済み" : state === "error" ? "保存に失敗しました" : state === "closed" ? "確定済み" : "下書きを自動で保存";
  }

  /** 完了の画面。written が null なら「確定済み」(すでに確定されていた) の画面 */
  function showDone(written, outcomes) {
    closed = true;
    clearTimeout(saveTimer);
    $("app").hidden = true;
    $("notice").hidden = true;
    const done = $("done");
    done.hidden = false;
    setConfirmEnabled(false);
    setSaveState("closed");
    if (written === null) {
      $("done-eyebrow").textContent = "確定済み";
      $("done-title").textContent = "このセッションは確定済みです。";
      $("done-text").textContent = "判定はすでに送られています。確定したあとは直せません。";
    } else {
      $("done-eyebrow").textContent = "確定しました";
      $("done-title").textContent = "判定を送りました。";
      $("done-text").textContent =
        written + " 問の判定を評価セットに「人の判定」として書き込みました。インターリービングの出どころの集計は次のとおりです。";
    }
    const tally = { a: 0, b: 0, tie: 0 };
    for (const o of Object.values(outcomes || {})) if (o in tally) tally[o]++;
    const has = outcomes && Object.keys(outcomes).length > 0;
    $("done-summary").hidden = !has;
    $("done-wins").textContent = String(tally.a);
    $("done-losses").textContent = String(tally.b);
    $("done-ties").textContent = String(tally.tie);
    done.focus();
  }

  // ---- 上の帯・見出し・要約 ----
  function renderHeader(data) {
    const s0 = data.session;
    const n = s0.items.length;
    $("bar-meta").textContent = isoWeek(s0.created_at) + " · セッション " + s0.id;
    $("hero-eyebrow").textContent = "週 1 回 · " + n + " 問 · 約 " + Math.max(1, Math.round(n / 2)) + " 分";
    $("confirm-meta").textContent = "送り先 " + location.host + " · セッション " + s0.id;

    const hist = data.dashboard.history || [];
    const latest = hist.length > 0 ? hist[hist.length - 1] : null;

    const guard = $("sum-guard");
    clear(guard);
    if (latest === null) {
      append(guard, [h("span", { class: "dot", "data-level": "none", "aria-hidden": "true" }), "評価なし"]);
    } else {
      const level = latest.guard.alert ? "alert" : latest.guard.worse ? "worse" : "ok";
      const text = level === "alert" ? "警告" : level === "worse" ? "悪化の兆し" : "問題なし";
      append(guard, [h("span", { class: "dot", "data-level": level, "aria-hidden": "true" }), text]);
      if (latest.guard.reason) guard.title = latest.guard.reason;
    }

    $("sum-ndcg").textContent = latest === null ? "—" : num(latest.production.ndcg10, 3);

    const il = data.dashboard.interleave;
    const sumIl = $("sum-interleave");
    clear(sumIl);
    append(sumIl, [il.wins + " – " + il.losses, h("span", { class: "sub" }, "分 " + il.ties)]);

    const es = data.dashboard.eval_set;
    const sumEs = $("sum-evalset");
    clear(sumEs);
    append(sumEs, [es.questions + " 問", h("span", { class: "sub" }, "人 " + es.human)]);

    $("overview-meta").textContent = latest === null ? "評価の履歴なし" : "最終評価 " + localTime(latest.at) + " · sm eval";
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
    const svg = svgRoot(
      "週ごとの nDCG@10。本番は " + num(first.production.ndcg10, 3) + " から " + num(last.production.ndcg10, 3) +
        "、一次スコアだけは " + num(first.primary.ndcg10, 3) + " から " + num(last.primary.ndcg10, 3),
    );
    const mid = (lo + hi) / 2;
    const grid = s("g", { class: "c-grid" });
    const ticks = s("g");
    for (const v of [hi, mid, lo]) {
      grid.appendChild(s("line", { x1: left, y1: y(v).toFixed(1), x2: right, y2: y(v).toFixed(1) }));
      ticks.appendChild(label(0, (y(v) + 3).toFixed(1), short(v, 3).replace("+", "")));
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
      "週ごとの差 (本番 − 一次スコアだけ) と 95% 区間。最新の週は " + num(last.diff.mean, 3) + "、区間 " + num(last.diff.lo, 3) + " から " + num(last.diff.hi, 3) +
        (last.guard.worse ? "。区間の右端が 0 より左で、悪化している" : "。有意な悪化はない"),
    );
    svg.appendChild(s("rect", { x: left, y: top, width: (x(0) - left).toFixed(1), height: bottom - top, class: "c-worse" }));
    svg.appendChild(s("line", { x1: x(0).toFixed(1), y1: top, x2: x(0).toFixed(1), y2: bottom, class: "c-zero" }));
    svg.appendChild(label(left + 4, top + 12, "悪化"));
    svg.appendChild(label(left, 160, short(-m, 2)));
    svg.appendChild(label(x(0).toFixed(1), 160, "0", "middle"));
    svg.appendChild(label(right, 160, short(m, 2), "end"));
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
    $("chart-interleave-p").textContent = "符号検定 p = " + num(totals.p, 2);
    if (hist.length === 0) return emptyChart(host);
    /** @type {{week: string, w: number, l: number, t: number}[]} */
    let bars = [];
    if (hist.length === 1) {
      const r = hist[0];
      bars.push({ week: weekLabel(isoWeek(r.at)) + " まで", w: r.interleave.wins, l: r.interleave.losses, t: r.interleave.ties });
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
    const svg = svgRoot(
      "週ごとの勝ち負け。累計は本番 " + totals.wins + " 勝、一次スコアだけ " + totals.losses + " 勝、引き分け " + totals.ties,
    );
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
    const svg = svgRoot(
      "作成週ごとの割合。検索対象は " + cols.map((c) => pct(c.c)).join("、") + "。正解は " + cols.map((c) => pct(c.g)).join("、"),
    );
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
      warn.textContent = last.week + " の記憶が正解にほぼ無い";
      warn.hidden = false;
    }
    clear(host);
    host.appendChild(svg);
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
    $("progress-count").textContent = done + " / " + items.length + " 問";
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
      b.setAttribute("aria-label", "問 " + (i + 1) + (st === "done" ? " (判定済み)" : st === "partial" ? " (途中)" : " (未判定)"));
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
    const parts = ["問 " + (current + 1), it.kind === "real" ? "実クエリ" : "評価セット", "問われた時点 " + localTime(it.asked_at)];
    parts.forEach((p, i) => {
      if (i > 0) meta.appendChild(h("span", { "aria-hidden": "true" }, "·"));
      meta.appendChild(h("span", null, p));
    });
    if (it.filters && it.filters.scope) {
      meta.appendChild(h("span", { "aria-hidden": "true" }, "·"));
      meta.appendChild(h("span", null, "scope " + it.filters.scope));
    }
    if (it.differs) meta.appendChild(h("span", { class: "tag tag-accent" }, "上位が違う"));
    $("card-query").textContent = it.query;

    const ul = $("results");
    clear(ul);
    const e = draft[it.qid];
    if (it.cards.length === 0) {
      ul.appendChild(h("li", null, h("p", { class: "muted" }, "この問いには結果がありませんでした。")));
    }
    it.cards.forEach((c, j) => {
      const no = pad2(j + 1);
      const name = "g-" + current + "-" + j;
      const legendId = name + "-legend";
      const titleId = name + "-title";
      const grade = e ? e.grades[c.id] : undefined;
      const stale = e ? e.stale_ids.indexOf(c.id) >= 0 : false;

      const fieldset = h("fieldset", { class: "grade", "aria-describedby": titleId }, [h("legend", { id: legendId }, "結果 " + no + " の判定")]);
      for (const g of GRADE_CHOICES) {
        const input = h("input", { type: "radio", name: name, value: g.value, checked: grade === g.value });
        input.addEventListener("change", () => {
          if (closed) return;
          entryOf(it.qid).grades[c.id] = g.value;
          changed();
        });
        fieldset.appendChild(h("label", null, [input, g.label]));
      }

      const metaRow = h("p", { class: "result-meta" }, [
        h("span", null, "作成 " + localDay(c.created_at)),
        h("span", null, c.provenance),
        h("span", null, c.scope),
        c.stale ? h("span", { class: "tag tag-warning" }, "古い記憶 · " + c.age_days + " 日") : null,
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
      const body = h("div", null, [
        h("p", { class: "result-title", id: titleId }, c.title),
        h("p", { class: "result-excerpt" }, c.excerpt),
        metaRow,
        h("label", { class: "stale-check" }, [check, "新しい版があり、これは古い"]),
      ]);
      ul.appendChild(h("li", { "data-stale": c.stale ? "true" : "false" }, [h("span", { class: "result-no", "aria-hidden": "true" }, no), body, fieldset]));
    });

    const prev = $("prev-q");
    const next = $("next-q");
    prev.disabled = current === 0;
    prev.textContent = current === 0 ? "← 前の問い" : "← 問 " + current;
    if (current === session.items.length - 1) {
      next.textContent = "確定の欄へ →";
    } else {
      next.textContent = "問 " + (current + 2) + " へ →";
    }
  }

  function unjudgedCount() {
    return session.items.filter((it) => stateOf(it) !== "done").length;
  }

  function renderConfirmText() {
    const un = unjudgedCount();
    const base0 = "判定は評価セットに「人の判定」として書き込まれ、インターリービングの勝ち負けが集計に加わります。確定したあとは直せません。";
    $("confirm-text").textContent = base0 + (un > 0 ? "未判定の " + un + " 問は、付けた分だけを書き込みます (何も付けていない問いは判定なしとして扱います)。" : "");
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
    $("dialog-text").textContent =
      un === 0
        ? "全 " + session.items.length + " 問の判定を送ります。"
        : "未判定の問いが " + un + " 問あります (全 " + session.items.length + " 問)。付けた分だけを送り、何も付けていない問いは判定なしとして扱います。";
    const dlg = /** @type {HTMLDialogElement} */ ($("confirm-dialog"));
    if (typeof dlg.showModal === "function") dlg.showModal();
    else if (window.confirm($("dialog-text").textContent + " 確定しますか。")) submit();
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
        window.alert("確定に失敗しました (" + r.status + (r.body && r.body.error ? ": " + r.body.error : "") + ")。もう一度お試しください。");
      }
    } catch {
      setSaveState("error");
      setConfirmEnabled(true);
      window.alert("MCP サーバーに届きませんでした。サーバーが動いているか確かめて、もう一度お試しください。");
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
    setSaveState("idle");
    if (sessionId === "" || token === "") {
      showNotice("URL にセッションの id か合言葉がありません。トーストか sm feedback が開いた URL をそのまま使ってください。");
      return;
    }
    let r;
    try {
      r = await getJson(base + "/data" + q);
    } catch {
      showNotice("MCP サーバーに届きませんでした。サーバーが動いているか確かめて、ページを読み込み直してください。");
      return;
    }
    if (r.status === 403) return showNotice("合言葉が合いません。トーストか sm feedback が開いた URL をそのまま使ってください。");
    if (r.status === 404) return showNotice("このセッションは見つかりません。sm feedback で新しいセッションを作ってください。");
    if (r.status !== 200 || !r.body || !r.body.session) return showNotice("データを読めませんでした (" + r.status + ")。");

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
    $("app").hidden = false;
    renderHeader(data);
    const hist = data.dashboard.history || [];
    renderNdcg(hist);
    renderGuard(hist);
    renderInterleave(hist, data.dashboard.interleave);
    renderCreated(data.dashboard.created_dist);

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
