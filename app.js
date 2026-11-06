(() => {
  "use strict";

  const TOTAL = 10000;
  const STORAGE_KEY = "combination-tracker-v1";
  const HISTORY_LIMIT = 300;
  const ROW_H = 44; // must match .dial-num height in CSS
  const LABELS = ["1st", "2nd", "3rd", "4th"];

  // Most frequently chosen 4-digit codes in published analyses of leaked PIN datasets
  // (e.g. DataGenetics, 2012). Human-chosen lock codes follow similar habits, but this is a heuristic.
  const COMMON = [
    1234, 1111, 0, 1212, 7777, 1004, 2000, 4444, 2222, 6969, 9999, 3333, 5555, 6666,
    1122, 1313, 8888, 4321, 2001, 1010, 1342, 2580, 1230, 1990, 1986, 1984, 1987, 1985,
  ];

  const MODE_DESC = {
    smart: "Tries the likeliest codes first: your numbers, common codes, repeats and patterns, years (2030 → 1940), then dates (DDMM, MMDD), then everything else. This helps when a person chose the code.",
    sequential: "Goes 0000 → 9999 in order. Use this if the code was random or set at the factory, because no order beats it then.",
  };

  const defaultSettings = () => ({
    mode: "smart",
    dial: [Array(10).fill(0), Array(10).fill(0), Array(10).fill(0), Array(10).fill(0)], // 0 neutral, 1 known, 2 out
    contains: "",
    personal: "",
  });

  // ---------- State ----------
  let state = {
    tried: new Uint8Array(TOTAL),
    current: 0,
    history: [], // { c, t, a: "tried" | "untried" | "found" }
    found: null,
    settings: defaultSettings(),
  };
  let triedCount = 0;
  const undoStack = [];
  const session = { count: 0, start: null };
  let prevDigits = [0, 0, 0, 0];

  // derived
  let order = new Int16Array(TOTAL);     // attempt order
  let posInOrder = new Int16Array(TOTAL); // code -> index in order
  let category = new Array(TOTAL).fill("");
  let allowed = new Uint8Array(TOTAL).fill(1);
  let allowedCount = TOTAL;

  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(4, "0");
  const digitsOf = (n) => [Math.floor(n / 1000), Math.floor(n / 100) % 10, Math.floor(n / 10) % 10, n % 10];
  const fromDigits = (d) => d[0] * 1000 + d[1] * 100 + d[2] * 10 + d[3];
  const wrap = (n) => ((n % TOTAL) + TOTAL) % TOTAL;
  const fmt = (n) => n.toLocaleString("en-GB");

  function recount() {
    triedCount = 0;
    for (let i = 0; i < TOTAL; i++) triedCount += state.tried[i];
  }

  // ---------- Candidate ordering ----------
  function permutations4(code) {
    const s = pad(code).split("");
    const out = new Set();
    const rec = (arr, rest) => {
      if (!rest.length) { out.add(Number(arr.join(""))); return; }
      rest.forEach((c, i) => rec([...arr, c], rest.filter((_, j) => j !== i)));
    };
    rec([], s);
    return [...out];
  }

  function personalCodes(text) {
    const exact = [], perms = [];
    const tokens = (text.match(/\d+/g) || []);
    for (const t of tokens) {
      if (t.length <= 4) {
        exact.push(Number(t));                     // "42" -> 0042
        if (t.length < 4) exact.push(Number(t.padEnd(4, "0"))); // "42" -> 4200
      } else {
        for (let i = 0; i + 4 <= t.length; i++) exact.push(Number(t.slice(i, i + 4))); // every 4-digit window
        if (t.length === 8) exact.push(Number(t.slice(2, 4) + t.slice(0, 2)));       // DDMMYYYY -> MMDD
      }
    }
    for (const c of exact) perms.push(...permutations4(c));
    return { exact, perms };
  }

  function buildOrder() {
    const seen = new Uint8Array(TOTAL);
    const list = [];
    const cat = new Array(TOTAL).fill("");
    const add = (c, label) => {
      if (c < 0 || c >= TOTAL || seen[c]) return;
      seen[c] = 1; cat[c] = label; list.push(c);
    };

    const { exact, perms } = personalCodes(state.settings.personal);
    exact.forEach((c) => add(c, "Your number"));
    perms.forEach((c) => add(c, "Your digits"));
    COMMON.forEach((c) => add(c, "Common code"));

    for (let a = 0; a < 10; a++) add(a * 1111, "Repeated");
    for (let s = 0; s < 10; s++) {
      add(fromDigits([s, (s + 1) % 10, (s + 2) % 10, (s + 3) % 10]), "Sequence");
      add(fromDigits([s, (s + 9) % 10, (s + 8) % 10, (s + 7) % 10]), "Sequence");
    }
    for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) {
      if (a === b) continue;
      add(fromDigits([a, b, a, b]), "Pattern");
      add(fromDigits([a, a, b, b]), "Pattern");
      add(fromDigits([a, b, b, a]), "Pattern");
    }
    for (let y = 2030; y >= 1940; y--) add(y, "Year");

    const dim = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (let m = 1; m <= 12; m++) for (let d = 1; d <= dim[m - 1]; d++) add(d * 100 + m, "Date DDMM");
    for (let m = 1; m <= 12; m++) for (let d = 1; d <= dim[m - 1]; d++) add(m * 100 + d, "Date MMDD");

    if (state.settings.mode === "sequential") {
      for (let i = 0; i < TOTAL; i++) order[i] = i;
    } else {
      for (let i = 0; i < TOTAL; i++) add(i, "");
      list.forEach((c, i) => { order[i] = c; });
    }
    for (let i = 0; i < TOTAL; i++) posInOrder[order[i]] = i;
    category = cat;
  }

  function buildAllowed() {
    const { dial, contains } = state.settings;
    const need = Array(10).fill(0);
    for (const ch of contains.replace(/\D/g, "")) need[+ch]++;
    const known = dial.map((row) => row.indexOf(1));
    allowedCount = 0;
    for (let i = 0; i < TOTAL; i++) {
      const d = digitsOf(i);
      let ok = true;
      for (let p = 0; p < 4 && ok; p++) {
        if (known[p] >= 0 ? d[p] !== known[p] : dial[p][d[p]] === 2) ok = false;
      }
      if (ok) {
        const have = Array(10).fill(0);
        d.forEach((x) => have[x]++);
        for (let k = 0; k < 10; k++) if (have[k] < need[k]) { ok = false; break; }
      }
      allowed[i] = ok ? 1 : 0;
      allowedCount += allowed[i];
    }
  }

  function rebuild() {
    buildOrder();
    buildAllowed();
  }

  const isCandidate = (i) => allowed[i] && !state.tried[i];

  function nextCandidate(from) {
    const p = posInOrder[from];
    for (let k = 1; k <= TOTAL; k++) {
      const i = order[(p + k) % TOTAL];
      if (isCandidate(i)) return i;
    }
    return -1;
  }

  function firstCandidate() {
    for (let k = 0; k < TOTAL; k++) if (isCandidate(order[k])) return order[k];
    return -1;
  }

  function upcoming(n) {
    const out = [];
    let cur = state.current;
    for (let k = 0; k < n; k++) {
      const nx = nextCandidate(cur);
      if (nx === -1 || out.includes(nx) || nx === state.current) break;
      out.push(nx);
      cur = nx;
    }
    return out;
  }

  function candidatesLeft() {
    let n = 0;
    for (let i = 0; i < TOTAL; i++) n += isCandidate(i);
    return n;
  }

  // ---------- Persistence ----------
  function serialise() {
    return {
      version: 2,
      tried: Array.from(state.tried).join(""),
      current: state.current,
      history: state.history,
      found: state.found,
      settings: state.settings,
      savedAt: new Date().toISOString(),
    };
  }

  function deserialise(obj) {
    if (!obj || typeof obj.tried !== "string" || obj.tried.length !== TOTAL || /[^01]/.test(obj.tried)) {
      throw new Error("Invalid data file");
    }
    const tried = new Uint8Array(TOTAL);
    for (let i = 0; i < TOTAL; i++) tried[i] = obj.tried.charCodeAt(i) === 49 ? 1 : 0;
    const s = defaultSettings();
    const src = obj.settings || {};
    if (src.mode === "sequential" || src.mode === "smart") s.mode = src.mode;
    if (Array.isArray(src.dial) && src.dial.length === 4) {
      s.dial = src.dial.map((row) => Array.from({ length: 10 }, (_, k) => [0, 1, 2].includes(row?.[k]) ? row[k] : 0));
    }
    if (typeof src.contains === "string") s.contains = src.contains.replace(/\D/g, "").slice(0, 4);
    if (typeof src.personal === "string") s.personal = src.personal.slice(0, 200);
    return {
      tried,
      current: Number.isInteger(obj.current) ? wrap(obj.current) : 0,
      history: Array.isArray(obj.history) ? obj.history.slice(0, HISTORY_LIMIT) : [],
      found: Number.isInteger(obj.found) ? obj.found : null,
      settings: s,
    };
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(serialise())); }
    catch (e) { toast("⚠️ Could not save progress in this browser"); }
  }

  function load() {
    let fresh = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) { state = deserialise(JSON.parse(raw)); fresh = false; }
    } catch (e) { /* start fresh */ }
    recount();
    rebuild();
    if (fresh) { const f = firstCandidate(); if (f !== -1) state.current = f; }
  }

  // ---------- Actions ----------
  function setTried(idx, val, action) {
    const prev = state.tried[idx];
    if (prev !== val) {
      state.tried[idx] = val;
      triedCount += val ? 1 : -1;
    }
    state.history.unshift({ c: idx, t: Date.now(), a: action });
    if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
    return prev;
  }

  function pushUndo(entry) {
    undoStack.push(entry);
    if (undoStack.length > 200) undoStack.shift();
  }

  function markTriedAndNext() {
    const idx = state.current;
    const prev = setTried(idx, 1, "tried");
    pushUndo({ idx, prev, from: idx, prevFound: state.found });
    bumpSession(prev ? 0 : 1);
    const nxt = nextCandidate(idx);
    if (nxt === -1) toast("🎯 No candidates left within your clues");
    else state.current = nxt;
    commit(true);
  }

  function toggleTried() {
    const idx = state.current;
    const newVal = state.tried[idx] ? 0 : 1;
    const prev = setTried(idx, newVal, newVal ? "tried" : "untried");
    pushUndo({ idx, prev, from: idx, prevFound: state.found });
    if (newVal) bumpSession(1);
    commit(true);
  }

  function markFound() {
    const idx = state.current;
    const prev = setTried(idx, 1, "found");
    pushUndo({ idx, prev, from: idx, prevFound: state.found });
    if (!prev) bumpSession(1);
    state.found = idx;
    commit(true);
    celebrate();
    toast(`🎉 Combination ${pad(idx)} saved as the winner!`);
  }

  function undo() {
    const u = undoStack.pop();
    if (!u) { toast("Nothing to undo"); return; }
    if (state.tried[u.idx] !== u.prev) triedCount += u.prev ? 1 : -1;
    state.tried[u.idx] = u.prev;
    state.found = u.prevFound;
    const h = state.history.findIndex((e) => e.c === u.idx);
    if (h !== -1) state.history.splice(h, 1);
    if (!u.prev && session.count > 0) session.count--;
    state.current = u.from;
    commit(true);
    toast(`↶ Undid ${pad(u.idx)}`);
  }

  function goTo(n) {
    state.current = wrap(n);
    commit(false);
  }

  function goNextCandidate() {
    const n = nextCandidate(state.current);
    if (n === -1) toast("No candidates left within your clues");
    else goTo(n);
  }

  function setDigit(pos, delta) {
    const d = digitsOf(state.current);
    d[pos] = (d[pos] + delta + 10) % 10;
    goTo(fromDigits(d));
  }

  function bumpSession(n) {
    if (!n) return;
    if (!session.start) session.start = Date.now();
    session.count += n;
  }

  function settingsChanged() {
    rebuild();
    // if the current code no longer fits the clues, move to the best candidate
    if (!isCandidate(state.current)) {
      const f = firstCandidate();
      if (f !== -1) state.current = f;
    }
    renderClues();
    commit(true);
  }

  function resetAll() {
    if (!confirm("Reset ALL progress? This clears every tried combination, the history and your clues.")) return;
    state = { tried: new Uint8Array(TOTAL), current: 0, history: [], found: null, settings: defaultSettings() };
    triedCount = 0;
    undoStack.length = 0;
    session.count = 0;
    session.start = null;
    rebuild();
    state.current = firstCandidate();
    renderClues();
    commit(true);
    toast("Progress reset");
  }

  function commit(changed) {
    save();
    render(changed);
  }

  // ---------- Dials ----------
  const dialEls = [];

  function buildDials() {
    const wrapEl = $("dials");
    for (let pos = 0; pos < 4; pos++) {
      const dial = document.createElement("div");
      dial.className = "dial";

      const up = document.createElement("button");
      up.className = "dial-btn";
      up.textContent = "▲";
      up.title = "Increase digit";
      up.addEventListener("click", () => setDigit(pos, +1));

      const win = document.createElement("div");
      win.className = "dial-window";
      const focus = document.createElement("div");
      focus.className = "dial-focus";
      const strip = document.createElement("div");
      strip.className = "dial-strip";
      const seq = [9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0]; // neighbours wrap visually
      const nums = seq.map((v) => {
        const el = document.createElement("div");
        el.className = "dial-num";
        el.textContent = v;
        strip.appendChild(el);
        return el;
      });
      win.append(focus, strip);
      win.addEventListener("wheel", (e) => {
        e.preventDefault();
        setDigit(pos, e.deltaY > 0 ? +1 : -1);
      }, { passive: false });
      win.addEventListener("click", (e) => {
        const y = e.clientY - win.getBoundingClientRect().top;
        if (y < ROW_H) setDigit(pos, -1);
        else if (y > ROW_H * 2) setDigit(pos, +1);
      });
      // touch swipe
      let ty = null;
      win.addEventListener("touchstart", (e) => { ty = e.touches[0].clientY; }, { passive: true });
      win.addEventListener("touchmove", (e) => {
        if (ty === null) return;
        const dy = e.touches[0].clientY - ty;
        if (Math.abs(dy) > 24) { setDigit(pos, dy < 0 ? +1 : -1); ty = e.touches[0].clientY; }
        e.preventDefault();
      }, { passive: false });
      win.addEventListener("touchend", () => { ty = null; });

      const down = document.createElement("button");
      down.className = "dial-btn";
      down.textContent = "▼";
      down.title = "Decrease digit";
      down.addEventListener("click", () => setDigit(pos, -1));

      const label = document.createElement("span");
      label.className = "dial-label";
      label.textContent = LABELS[pos];

      dial.append(up, win, down, label);
      wrapEl.appendChild(dial);
      dialEls.push({ dial, strip, nums, label });
    }
  }

  function renderDials() {
    const d = digitsOf(state.current);
    d.forEach((v, pos) => {
      const { dial, strip, nums, label } = dialEls[pos];
      strip.style.transform = `translateY(${-v * ROW_H}px)`;
      nums.forEach((el, i) => el.classList.toggle("active", i === v + 1));
      const fixed = state.settings.dial[pos].includes(1);
      dial.classList.toggle("fixed", fixed);
      label.textContent = LABELS[pos] + (fixed ? " · known" : "");
      if (v !== prevDigits[pos]) {
        dial.classList.add("changed");
        clearTimeout(dial._t);
        dial._t = setTimeout(() => dial.classList.remove("changed"), 450);
      }
    });
    prevDigits = d;
  }

  // ---------- Clues panel ----------
  const chipEls = [];
  function buildClues() {
    const grid = $("digitGrid");
    for (let p = 0; p < 4; p++) {
      const lbl = document.createElement("span");
      lbl.className = "row-lbl";
      lbl.textContent = LABELS[p];
      grid.appendChild(lbl);
      chipEls[p] = [];
      for (let k = 0; k < 10; k++) {
        const b = document.createElement("button");
        b.className = "dchip";
        b.textContent = k;
        b.addEventListener("click", () => {
          const row = state.settings.dial[p];
          const next = (row[k] + 1) % 3;
          if (next === 1) row.forEach((v, j) => { if (v === 1) row[j] = 0; }); // only one known per dial
          row[k] = next;
          if (row.every((v) => v === 2)) { row[k] = 0; toast("Every digit on a dial can't be ruled out"); }
          settingsChanged();
        });
        grid.appendChild(b);
        chipEls[p].push(b);
      }
    }

    $("modeSeg").addEventListener("click", (e) => {
      const m = e.target.dataset.mode;
      if (!m || m === state.settings.mode) return;
      state.settings.mode = m;
      settingsChanged();
      toast(m === "smart" ? "Smart order on" : "Sequential order on");
    });

    let debounce;
    const onText = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        state.settings.contains = $("containsInput").value.replace(/\D/g, "").slice(0, 4);
        state.settings.personal = $("personalInput").value.slice(0, 200);
        settingsChanged();
      }, 350);
    };
    $("containsInput").addEventListener("input", onText);
    $("personalInput").addEventListener("input", onText);

    $("clearCluesBtn").addEventListener("click", () => {
      const mode = state.settings.mode;
      state.settings = defaultSettings();
      state.settings.mode = mode;
      settingsChanged();
      toast("Clues cleared");
    });
  }

  function renderClues() {
    const { dial, mode, contains, personal } = state.settings;
    for (let p = 0; p < 4; p++) {
      const hasKnown = dial[p].includes(1);
      chipEls[p].forEach((b, k) => {
        b.className = "dchip" + (dial[p][k] === 1 ? " known" : dial[p][k] === 2 ? " out" : hasKnown ? " dim" : "");
      });
    }
    document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    $("modeDesc").textContent = MODE_DESC[mode];
    $("modePill").textContent = mode === "smart" ? "Smart order" : "Sequential";
    if (document.activeElement !== $("containsInput")) $("containsInput").value = contains;
    if (document.activeElement !== $("personalInput")) $("personalInput").value = personal;

    $("spaceText").textContent = fmt(allowedCount);
    $("spaceFill").style.width = (allowedCount / TOTAL) * 100 + "%";
    const saved = 100 - (allowedCount / TOTAL) * 100;
    $("savingText").textContent = saved > 0 ? `(${saved.toFixed(saved < 1 ? 2 : 1)}% fewer)` : "";
  }

  // ---------- Map ----------
  const canvas = $("map");
  const ctx = canvas.getContext("2d");
  const CELL = 10;
  canvas.width = canvas.height = CELL * 100;

  function renderMap() {
    const css = getComputedStyle(document.documentElement);
    const cTried = css.getPropertyValue("--tried").trim();
    const cUntried = css.getPropertyValue("--untried").trim();
    const cOut = css.getPropertyValue("--out").trim();
    const cCur = css.getPropertyValue("--current").trim();

    ctx.fillStyle = "#0e1122";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < TOTAL; i++) {
      const row = Math.floor(i / 100), col = i % 100;
      ctx.fillStyle = state.tried[i] ? cTried : allowed[i] ? cUntried : cOut;
      ctx.fillRect(col * CELL + 1, row * CELL + 1, CELL - 2, CELL - 2);
    }
    if (state.found !== null) {
      const r = Math.floor(state.found / 100), c = state.found % 100;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(c * CELL + 1, r * CELL + 1, CELL - 2, CELL - 2);
    }
    const r = Math.floor(state.current / 100), c = state.current % 100;
    ctx.fillStyle = "rgba(245,158,11,0.10)";
    ctx.fillRect(0, r * CELL, canvas.width, CELL);
    ctx.fillRect(c * CELL, 0, CELL, canvas.height);
    ctx.fillStyle = cCur;
    ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
  }

  function cellFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const col = Math.floor(((e.clientX - rect.left) / rect.width) * 100);
    const row = Math.floor(((e.clientY - rect.top) / rect.height) * 100);
    if (col < 0 || col > 99 || row < 0 || row > 99) return null;
    return { idx: row * 100 + col, x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  canvas.addEventListener("click", (e) => { const c = cellFromEvent(e); if (c) goTo(c.idx); });
  canvas.addEventListener("mousemove", (e) => {
    const c = cellFromEvent(e);
    const tip = $("mapTip");
    if (!c) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.style.left = c.x + "px";
    tip.style.top = c.y + "px";
    const st = state.tried[c.idx] ? "tried" : allowed[c.idx] ? "to try" : "ruled out";
    tip.textContent = `${pad(c.idx)} · ${st}${category[c.idx] ? " · " + category[c.idx] : ""}`;
  });
  canvas.addEventListener("mouseleave", () => { $("mapTip").hidden = true; });

  // ---------- Blocks ----------
  const blockEls = [];
  function buildBlocks() {
    const el = $("blocks");
    for (let b = 0; b < 10; b++) {
      const div = document.createElement("div");
      div.className = "block";
      div.title = `${b}000 – ${b}999`;
      div.innerHTML = `<div class="block-fill"></div><div class="block-label"><b>${b}xxx</b><span>0%</span></div>`;
      div.addEventListener("click", () => {
        for (let i = b * 1000; i < b * 1000 + 1000; i++) if (isCandidate(i)) return goTo(i);
        goTo(b * 1000);
      });
      el.appendChild(div);
      blockEls.push(div);
    }
  }

  function renderBlocks() {
    const curBlock = Math.floor(state.current / 1000);
    for (let b = 0; b < 10; b++) {
      let tried = 0, pool = 0;
      for (let i = b * 1000; i < b * 1000 + 1000; i++) {
        if (allowed[i] || state.tried[i]) { pool++; tried += state.tried[i]; }
      }
      const pct = pool ? (tried / pool) * 100 : 100;
      const div = blockEls[b];
      div.querySelector(".block-fill").style.height = (pool ? pct : 0) + "%";
      div.querySelector(".block-label span").textContent = pool ? Math.round(pct) + "%" : "—";
      div.classList.toggle("current", b === curBlock);
      div.style.opacity = pool ? 1 : 0.35;
    }
  }

  // ---------- Stats, queue & history ----------
  const RING_LEN = 2 * Math.PI * 52;

  function fmtDuration(min) {
    if (!isFinite(min)) return "–";
    if (min < 1) return "< 1 min";
    if (min < 60) return `${Math.ceil(min)} min`;
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h} h ${m} min`;
  }

  function renderStats() {
    const left = candidatesLeft();
    let triedInPool = 0;
    for (let i = 0; i < TOTAL; i++) if (state.tried[i] && allowed[i]) triedInPool++;
    const pool = triedInPool + left;
    const frac = pool ? triedInPool / pool : 1;
    const pct = frac * 100;
    $("pctText").textContent = (pct === 0 || pct === 100 ? pct : pct.toFixed(pct < 10 ? 2 : 1)) + "%";
    $("ringSub").textContent = `of ${fmt(pool)} candidates`;
    $("ringFg").style.strokeDasharray = RING_LEN;
    $("ringFg").style.strokeDashoffset = RING_LEN * (1 - frac);
    $("candText").textContent = fmt(left);
    $("triedText").textContent = fmt(triedCount);
    $("sessionText").textContent = fmt(session.count);

    let rate = null;
    if (session.start && session.count > 1) {
      const mins = (Date.now() - session.start) / 60000;
      if (mins > 0.05) rate = session.count / mins;
    }
    $("rateText").textContent = rate ? rate.toFixed(1) : "–";
    $("etaText").textContent = rate ? fmtDuration(left / rate) : "–";

    $("foundBox").hidden = state.found === null;
    if (state.found !== null) $("foundText").textContent = pad(state.found);

    const badge = $("statusBadge");
    const isFound = state.found === state.current;
    const isTried = !!state.tried[state.current];
    const isOut = !allowed[state.current];
    badge.textContent = isFound ? "🎉 Winner" : isTried ? "✓ Tried" : isOut ? "Ruled out by clues" : "Not tried";
    badge.className = "badge" + (isFound ? " found" : isTried ? " tried" : isOut ? " out" : "");

    const cat = category[state.current];
    $("catTag").hidden = !cat;
    $("catTag").textContent = cat;
    $("undoBtn").disabled = undoStack.length === 0;
  }

  function renderQueue() {
    const q = upcoming(6);
    $("queue").innerHTML = q.length
      ? q.map((c, i) => `<button class="q${i === 0 ? " first" : ""}" data-c="${c}"><b>${pad(c)}</b><small>${category[c] || "—"}</small></button>`).join("")
      : `<span class="muted">Nothing left to try</span>`;
  }
  $("queue").addEventListener("click", (e) => {
    const b = e.target.closest("[data-c]");
    if (b) goTo(Number(b.dataset.c));
  });

  function timeAgo(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    const d = new Date(t);
    return d.toLocaleDateString("en-GB") + " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  function renderHistory() {
    const ol = $("history");
    const items = state.history.slice(0, 60);
    $("historyCount").textContent = state.history.length ? `${state.history.length} logged` : "";
    if (!items.length) {
      ol.innerHTML = `<li class="empty">No attempts yet – press Enter to log your first one</li>`;
      return;
    }
    ol.innerHTML = items.map((h) => {
      const tag = h.a === "found" ? `<span class="tag ok">worked</span>`
        : h.a === "untried" ? `<span class="tag un">unmarked</span>` : "";
      return `<li data-c="${h.c}"><span><span class="code">${pad(h.c)}</span>${tag}</span><span class="time">${timeAgo(h.t)}</span></li>`;
    }).join("");
  }
  $("history").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-c]");
    if (li) goTo(Number(li.dataset.c));
  });

  // ---------- Render ----------
  function render(changed) {
    renderDials();
    renderMap();
    renderStats();
    renderQueue();
    renderBlocks();
    if (changed) {
      renderHistory();
      const b = $("statusBadge");
      b.classList.remove("pulse"); void b.offsetWidth; b.classList.add("pulse");
    }
  }

  // ---------- UI bits ----------
  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  function celebrate() {
    const colours = ["#6c8cff", "#8b5cf6", "#22c55e", "#f59e0b", "#ef4444", "#ffffff"];
    for (let i = 0; i < 120; i++) {
      const c = document.createElement("div");
      c.className = "confetti";
      c.style.left = Math.random() * 100 + "vw";
      c.style.background = colours[i % colours.length];
      c.style.animationDuration = 1.8 + Math.random() * 1.8 + "s";
      c.style.animationDelay = Math.random() * 0.4 + "s";
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 4200);
    }
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(serialise(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    const d = new Date();
    const stamp = `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
    a.href = URL.createObjectURL(blob);
    a.download = `combination-progress-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Progress exported");
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        state = deserialise(JSON.parse(reader.result));
        recount();
        rebuild();
        undoStack.length = 0;
        renderClues();
        commit(true);
        toast(`Imported – ${fmt(triedCount)} tried`);
      } catch (e) {
        toast("⚠️ " + e.message);
      }
    };
    reader.readAsText(file);
  }

  // ---------- Wire up ----------
  $("tryBtn").addEventListener("click", markTriedAndNext);
  $("prevBtn").addEventListener("click", () => goTo(state.current - 1));
  $("nextBtn").addEventListener("click", () => goTo(state.current + 1));
  $("toggleBtn").addEventListener("click", toggleTried);
  $("undoBtn").addEventListener("click", undo);
  $("foundBtn").addEventListener("click", markFound);
  $("nextUntriedBtn").addEventListener("click", goNextCandidate);
  $("resetBtn").addEventListener("click", resetAll);
  $("exportBtn").addEventListener("click", exportData);
  $("importInput").addEventListener("change", (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = "";
  });
  $("jumpForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("jumpInput").value.trim();
    if (!/^\d{1,4}$/.test(v)) { toast("Enter 1–4 digits"); return; }
    goTo(Number(v));
    $("jumpInput").value = "";
    $("jumpInput").blur();
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault();
        if (document.activeElement && document.activeElement.tagName === "BUTTON") document.activeElement.blur();
        markTriedAndNext();
        break;
      case "ArrowLeft": e.preventDefault(); goTo(state.current - 1); break;
      case "ArrowRight": e.preventDefault(); goTo(state.current + 1); break;
      case "t": case "T": toggleTried(); break;
      case "n": case "N": goNextCandidate(); break;
    }
  });

  setInterval(() => { renderHistory(); renderStats(); }, 15000);

  // ---------- Init ----------
  load();
  prevDigits = digitsOf(state.current);
  buildDials();
  buildBlocks();
  buildClues();
  renderClues();
  render(true);
})();
