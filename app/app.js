// "Who Would Answer Here?" — app logic
// Data rows use these keys:
// year, college, transfer, first_gen, texas, here_count, belonging, lonely,
// met_friend, almost_left, hardest, kept_me, location, timestamp

let DATA = [];
let YOU = null;
let wallFilter = "all";
let refreshTimer = null;
const charts = {};

// ---------- column matching (Google Form titles -> keys) ----------
// Order matters: "kept you here" must match "kept" before "here".
const KEYWORDS = [
  ["kept", "kept_me"], ["leav", "almost_left"], ["hardest", "hardest"],
  ["belong", "belonging"], ["lonely", "lonely"], ["meet", "met_friend"], ["met_friend", "met_friend"],
  ["transfer", "transfer"], ["first", "first_gen"], ["texas", "texas"],
  ["college", "college"], ["year", "year"], ["location", "location"],
  ["timestamp", "timestamp"], ["here", "here_count"],
];

function normalizeRow(raw) {
  const row = {};
  for (const [header, value] of Object.entries(raw)) {
    const h = header.toLowerCase();
    const hit = KEYWORDS.find(([kw]) => h.includes(kw));
    if (hit && !(hit[1] in row)) row[hit[1]] = String(value ?? "").trim();
  }
  row.here_count = parseInt(row.here_count, 10);       // "5+" -> 5
  row.belonging = parseInt(row.belonging, 10);
  row.lonely = parseInt(row.lonely, 10);
  return row;
}

const valid = (r) => Number.isFinite(r.here_count);

// ---------- SAMPLE data (fake, for building before real data exists) ----------
function makeSample(n = 64) {
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const years = ["Freshman", "Sophomore", "Junior", "Senior", "Grad"];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const year = pick(years);
    const transfer = rand() < 0.2 ? "Yes" : "No";
    const first_gen = rand() < 0.25 ? "Yes" : "No";
    const texas = rand() < 0.75 ? "Yes" : "No";
    let base = 1 + years.indexOf(year) * 0.6 + rand() * 2.5;
    if (transfer === "Yes") base -= 1.3;
    if (first_gen === "Yes") base -= 0.6;
    if (texas === "No") base -= 0.5;
    const here = Math.max(0, Math.min(5, Math.round(base)));
    const belonging = Math.max(1, Math.min(5, Math.round(1.5 + here * 0.6 + (rand() - 0.5) * 1.5)));
    const hardest = pick(["Loneliness", "Grades", "Grades", "Money", "Family", "Health", "Homesickness", "None"]);
    rows.push({
      year, transfer, first_gen, texas, here_count: here, belonging,
      lonely: 6 - belonging,
      college: pick(["Engineering", "Mays Business", "Arts & Sciences", "AgriLife", "Education", "Health"]),
      met_friend: here === 0 ? "Haven't yet" : pick(["Fish Camp", "Class", "Dorm", "Student org", "Student org", "Faith group", "Roommate"]),
      almost_left: rand() < 0.35 ? "Yes" : "No",
      hardest,
      kept_me: hardest === "None" ? "N/A" : pick(["Friends", "Friends", "Family", "Faith", "A professor", "Traditions", "Myself", "No choice"]),
      location: pick(["MSC", "Evans Library", "Zach", "Rec Center", "Commons", "Mays", "Bus Stop"]),
    });
  }
  return rows;
}

// ---------- helpers ----------
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
function countBy(rows, key, skip = []) {
  const m = {};
  rows.forEach((r) => { const v = r[key]; if (v && !skip.includes(v)) m[v] = (m[v] || 0) + 1; });
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}
function renderBars(el, entries, total) {
  el.innerHTML = entries.slice(0, 4).map(([k, v]) => `
    <li><div class="row"><span>${k}</span><span>${pct(v, total)}%</span></div>
    <div class="track"><div class="fill" style="width:${pct(v, total)}%"></div></div></li>`).join("")
    || "<li class='muted'>Not enough data yet.</li>";
}

// ---------- RECOMMENDATION ENGINE ----------
// Find the respondents most similar to you, then learn from the ones who are doing well.
function similarity(a, b) {
  let s = 0;
  if (a.transfer === b.transfer) s += 2;
  if (a.first_gen === b.first_gen) s += 2;
  if (a.texas === b.texas) s += 1;
  if (a.year === b.year) s += 1;
  if (a.hardest === b.hardest) s += 2;
  return s;
}

function recommend(you) {
  const rows = DATA.filter(valid);
  const ranked = rows.map((r) => ({ r, s: similarity(you, r) })).sort((a, b) => b.s - a.s);
  const k = Math.min(rows.length, Math.max(10, Math.round(rows.length * 0.35)));
  const similar = ranked.slice(0, k).map((x) => x.r);

  // Among similar Aggies who are connected (3+ would answer Here), how did they meet their people?
  let connected = similar.filter((r) => r.here_count >= 3);
  let metNote = `From ${connected.length} Aggies like you who have 3+ people who'd answer "Here".`;
  if (connected.length < 3) {
    connected = rows.filter((r) => r.here_count >= 3);
    metNote = `From all ${connected.length} connected Aggies (not enough similar ones yet).`;
  }
  const met = countBy(connected, "met_friend", ["Haven't yet", ""]);

  // Among Aggies with the same hardest struggle, what kept them here?
  let struggled = rows.filter((r) => r.hardest === you.hardest && r.kept_me && r.kept_me !== "N/A");
  let keptNote = `From ${struggled.length} Aggies whose hardest part was ${you.hardest.toLowerCase()}.`;
  if (you.hardest === "None" || struggled.length < 3) {
    struggled = rows.filter((r) => r.kept_me && r.kept_me !== "N/A");
    keptNote = `From all ${struggled.length} Aggies who went through something hard.`;
  }
  const kept = countBy(struggled, "kept_me");

  const fewer = rows.filter((r) => r.here_count < you.here_count).length;
  const same = rows.filter((r) => r.here_count === you.here_count).length;
  return { met, metTotal: connected.length, metNote, kept, keptTotal: struggled.length, keptNote, fewer, same, total: rows.length };
}

function showResult() {
  if (!YOU) return;
  const rec = recommend(YOU);
  document.getElementById("result").hidden = false;
  const n = YOU.here_count;
  const people = n === 5 ? "5+ people" : `${n} ${n === 1 ? "person" : "people"}`;
  document.getElementById("percentile").innerHTML =
    `<b>${people}</b> would answer "Here" for you. ` +
    `<b>${pct(rec.same, rec.total)}%</b> of Aggies we surveyed said the same, and <b>${pct(rec.fewer, rec.total)}%</b> said fewer.`;
  document.getElementById("met-note").textContent = rec.metNote;
  document.getElementById("kept-note").textContent = rec.keptNote;
  renderBars(document.getElementById("met-list"), rec.met, rec.metTotal);
  renderBars(document.getElementById("kept-list"), rec.kept, rec.keptTotal);

  const topMet = rec.met[0]?.[0];
  const topKept = rec.kept[0]?.[0];
  let msg;
  if (n <= 1) msg = `You're not alone. ${pct(rows01(), DATA.filter(valid).length)}% of Aggies we met said 0 or 1 too. ` +
    (topMet ? `Aggies like you most often found their people through <b>${topMet}</b>. ` : "") + "Start there this week.";
  else if (n <= 3) msg = (topMet ? `Aggies like you who feel connected found their people through <b>${topMet}</b>. ` : "") +
    `Be the "Here" for someone who doesn't have one yet.`;
  else msg = `You have people. Somewhere on campus, someone answered 0. Say Howdy, and be their "Here."`;
  if (topKept && YOU.hardest !== "None") msg += ` When it got hard, <b>${topKept.toLowerCase()}</b> kept the most Aggies here.`;
  document.getElementById("message").innerHTML = msg;
}
const rows01 = () => DATA.filter((r) => valid(r) && r.here_count <= 1).length;

// ---------- CANDLE WALL ----------
function wallMatch(r) {
  if (wallFilter === "all") return true;
  if (wallFilter === "transfer") return r.transfer === "Yes";
  if (wallFilter === "first_gen") return r.first_gen === "Yes";
  if (wallFilter === "out") return r.texas === "No";
  return r.year === wallFilter;
}
function renderWall() {
  const rows = DATA.filter(valid);
  const all = YOU ? [...rows, { ...YOU, _you: true }] : rows;
  const wall = document.getElementById("wall");
  wall.innerHTML = all.map((r) => {
    const cls = ["candle", r._you ? "you" : "", r.here_count === 0 ? "out" : "", wallMatch(r) || r._you ? "" : "dim"].join(" ");
    const glow = 0.35 + r.here_count * 0.13;
    return `<div class="${cls}" title="${r._you ? "You" : r.year}: ${r.here_count} would answer Here">
      <div class="flame" style="opacity:${r.here_count === 0 ? 1 : glow}"></div><div class="wax"></div></div>`;
  }).join("");
  const group = rows.filter(wallMatch);
  const low = group.filter((r) => r.here_count <= 1).length;
  const avg = group.length ? (group.reduce((s, r) => s + r.here_count, 0) / group.length).toFixed(1) : "–";
  document.getElementById("wall-stat").innerHTML =
    `<b>${group.length}</b> Aggies · average <b>${avg}</b> people would answer "Here" · <b>${pct(low, group.length)}%</b> said 0 or 1`;
}

// ---------- CHARTS ----------
Chart.defaults.color = "#bfa9a0";
Chart.defaults.borderColor = "#3d2323";
function upsertChart(id, config) {
  if (charts[id]) { charts[id].data = config.data; charts[id].update(); return; }
  charts[id] = new Chart(document.getElementById(id), config);
}
function renderCharts() {
  const rows = DATA.filter(valid);
  const labels = ["0", "1", "2", "3", "4", "5+"];
  const dist = labels.map((_, i) => rows.filter((r) => r.here_count === i).length);
  upsertChart("c-here", {
    type: "bar",
    data: { labels, datasets: [{ label: "Aggies", data: dist, backgroundColor: "#ffcf6b" }] },
    options: { plugins: { legend: { display: false } }, scales: { x: { title: { display: true, text: 'People who would answer "Here"' } } } },
  });

  const avgBelong = labels.map((_, i) => {
    const g = rows.filter((r) => r.here_count === i && Number.isFinite(r.belonging));
    return g.length ? +(g.reduce((s, r) => s + r.belonging, 0) / g.length).toFixed(2) : null;
  });
  upsertChart("c-belong", {
    type: "line",
    data: { labels, datasets: [{ label: "Avg belonging (1–5)", data: avgBelong, borderColor: "#ffcf6b", backgroundColor: "#ffcf6b", spanGaps: true, tension: 0.3 }] },
    options: { scales: { y: { min: 1, max: 5 }, x: { title: { display: true, text: 'People who would answer "Here"' } } } },
  });

  const groups = [
    ["Everyone", () => true], ["Transfers", (r) => r.transfer === "Yes"], ["Non-transfers", (r) => r.transfer === "No"],
    ["First-gen", (r) => r.first_gen === "Yes"], ["Not from TX", (r) => r.texas === "No"],
    ["Freshmen", (r) => r.year === "Freshman"], ["Seniors", (r) => r.year === "Senior"],
  ];
  upsertChart("c-groups", {
    type: "bar",
    data: {
      labels: groups.map((g) => g[0]),
      datasets: [{ label: '% answering 0 or 1', backgroundColor: "#732f2f", data: groups.map(([, f]) => {
        const g = rows.filter(f); return pct(g.filter((r) => r.here_count <= 1).length, g.length);
      }) }],
    },
    options: { indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { max: 100, ticks: { callback: (v) => v + "%" } } } },
  });

  const kept = countBy(rows, "kept_me", ["N/A"]);
  upsertChart("c-kept", {
    type: "doughnut",
    data: { labels: kept.map((k) => k[0]), datasets: [{ data: kept.map((k) => k[1]),
      backgroundColor: ["#ffcf6b", "#e09f3e", "#b5651d", "#732f2f", "#9e2a2b", "#540b0e", "#d9c5b2", "#7a6c5d"], borderColor: "#261414" }] },
    options: { plugins: { legend: { position: "right" } } },
  });
}

// ---------- render everything ----------
function renderAll() {
  document.getElementById("n-count").textContent = DATA.filter(valid).length;
  renderWall();
  renderCharts();
  showResult();
}

// ---------- data loading ----------
function setData(rows, source, isSample = false) {
  DATA = rows.map((r) => (isSample ? r : normalizeRow(r))).filter(valid);
  document.getElementById("sample-banner").hidden = !isSample;
  document.getElementById("load-status").textContent =
    `${DATA.length} responses loaded from ${source} at ${new Date().toLocaleTimeString()}.`;
  renderAll();
}

function loadUrl(url) {
  Papa.parse(url, {
    download: true, header: true, skipEmptyLines: true,
    complete: (res) => setData(res.data, "Google Sheet"),
    error: () => { document.getElementById("load-status").textContent = "Couldn't load that link. Is it published as CSV?"; },
  });
}

document.getElementById("load-url").addEventListener("click", () => {
  const url = document.getElementById("sheet-url").value.trim();
  if (!url) return;
  try { localStorage.setItem("sheetUrl", url); } catch {}
  loadUrl(url);
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => loadUrl(url), 30000);   // live refresh during demo
});

document.getElementById("file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  Papa.parse(f, { header: true, skipEmptyLines: true, complete: (res) => setData(res.data, f.name) });
});

// ---------- form ----------
const form = document.getElementById("you");
form.here_count.addEventListener("input", (e) => {
  document.getElementById("here-val").textContent = e.target.value === "5" ? "5+" : e.target.value;
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(form));
  YOU = { ...fd, here_count: +fd.here_count, belonging: +fd.belonging };
  renderAll();
  document.getElementById("result").scrollIntoView({ behavior: "smooth" });
});

document.getElementById("filters").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  wallFilter = b.dataset.f;
  document.querySelectorAll("#filters button").forEach((x) => x.classList.toggle("on", x === b));
  renderWall();
});

// ---------- start ----------
let saved = null;
try { saved = localStorage.getItem("sheetUrl"); } catch {}
if (saved) {
  document.getElementById("sheet-url").value = saved;
  document.getElementById("load-url").click();
} else {
  setData(makeSample(), "SAMPLE generator", true);
}
