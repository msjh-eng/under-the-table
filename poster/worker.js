// post.gumreport.com: a password-protected, phone-friendly page for posting gum reports.
// It saves each report (and its photos) into the GitHub repository in one commit,
// which triggers the normal "Publish site" workflow.
//
// Settings (Cloudflare Worker secrets / vars):
//   POST_PASSWORD   the password used to sign in
//   GITHUB_TOKEN    fine-grained GitHub token with Contents: read & write on the repo
//   GITHUB_REPO     e.g. "msjh-eng/under-the-table" (set in wrangler.toml)
//   GITHUB_BRANCH   e.g. "main" (set in wrangler.toml)
//   SITE_URL        e.g. "https://gumreport.com" (set in wrangler.toml)

const COLORS = ["green", "pink", "white", "blue", "purple", "red", "yellow", "gray", "brown"];
const BACK = ["definitely", "maybe", "nope"];
const SESSION_DAYS = 60;
const MAX_PHOTOS = 8;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      console.error(err && err.stack || err);
      return json({ error: "Something went wrong on the server. Try again in a minute." }, 500);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (!env.POST_PASSWORD || !env.GITHUB_TOKEN) {
    return html(page("Not set up yet", `<p class="note">This posting page is missing its password or GitHub token. Add them in the repository's settings and run the deploy again.</p>`), 503);
  }

  if (path === "/login" && method === "POST") return login(request, env);
  if (path === "/logout" && method === "POST") return logout();

  const signedIn = await hasSession(request, env);

  if (path === "/" && method === "GET") {
    return html(signedIn ? formPage(env) : loginPage());
  }
  if (path === "/api/report" && method === "POST") {
    if (!signedIn) return json({ error: "You've been signed out. Reload the page and sign in again." }, 401);
    return createReport(request, env);
  }
  if (path === "/favicon.svg") {
    return new Response(FAVICON, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
  }
  return new Response("Not found", { status: 404 });
}

/* ---------------- sessions ---------------- */

async function sessionKey(env) {
  const material = new TextEncoder().encode(`${env.SESSION_SECRET || ""}|${env.POST_PASSWORD}|${env.GITHUB_TOKEN}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

async function makeSession(env) {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  const sig = await crypto.subtle.sign("HMAC", await sessionKey(env), new TextEncoder().encode(exp));
  return `${exp}.${b64url(sig)}`;
}
async function hasSession(request, env) {
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)gr=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  try {
    return await crypto.subtle.verify("HMAC", await sessionKey(env), fromB64url(sig), new TextEncoder().encode(exp));
  } catch {
    return false;
  }
}
async function sameText(a, b) {
  // compare via hashes so the time taken doesn't reveal the password
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const ax = new Uint8Array(x), ay = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < ax.length; i++) diff |= ax[i] ^ ay[i];
  return diff === 0;
}

async function login(request, env) {
  const form = await request.formData();
  const password = String(form.get("password") || "");
  if (!(await sameText(password, env.POST_PASSWORD))) {
    await new Promise(r => setTimeout(r, 1200)); // slow down guessing
    return html(loginPage("That password isn't right. Try again."), 401);
  }
  const token = await makeSession(env);
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "set-cookie": `gr=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`,
    },
  });
}
function logout() {
  return new Response(null, { status: 303, headers: { location: "/", "set-cookie": "gr=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" } });
}

/* ---------------- saving a report ---------------- */

const slugify = s => String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/['’]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "report";
const yamlStr = s => `'${String(s).replace(/'/g, "''")}'`;
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max);

function validate(input) {
  const errors = [];
  const r = {
    restaurant: clean(input.restaurant, 80).replace(/\n/g, " "),
    city: clean(input.city, 60).replace(/\n/g, " "),
    state: clean(input.state, 20).replace(/\n/g, " "),
    date: clean(input.date, 10),
    gum: Number.parseInt(input.gum, 10),
    tables: Number.parseInt(input.tables, 10),
    colors: Array.isArray(input.colors) ? [...new Set(input.colors.map(String))].filter(c => COLORS.includes(c)) : [],
    back: BACK.includes(input.back) ? input.back : "",
    body: clean(input.body, 5000).replace(/\r\n?/g, "\n").replace(/^---\s*$/gm, "- - -"),
    photos: Array.isArray(input.photos) ? input.photos : [],
  };
  if (!r.restaurant) errors.push("Add the restaurant's name.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) errors.push("Pick the day you went.");
  if (!Number.isFinite(r.gum) || r.gum < 0 || r.gum > 99) errors.push("Gum count should be between 0 and 99.");
  if (!Number.isFinite(r.tables) || r.tables < 1 || r.tables > 50) r.tables = 1;
  if (r.gum === 0) r.colors = [];
  if (r.photos.length > MAX_PHOTOS) errors.push(`Up to ${MAX_PHOTOS} photos per report.`);
  r.photos = r.photos.slice(0, MAX_PHOTOS).map((p, i) => {
    const data = String(p && p.data || "");
    let bytes;
    try { bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0)); } catch { bytes = new Uint8Array(); }
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) errors.push(`Photo ${i + 1} couldn't be read. Try choosing it again.`);
    else if (bytes.length > MAX_PHOTO_BYTES) errors.push(`Photo ${i + 1} is too big.`);
    return data;
  });
  return { r, errors };
}

function reportFile(r, photoPaths) {
  const lines = ["---", `restaurant: ${yamlStr(r.restaurant)}`];
  if (r.city) lines.push(`city: ${yamlStr(r.city)}`);
  if (r.state) lines.push(`state: ${yamlStr(r.state)}`);
  lines.push(`date: ${r.date}`, `gum: ${r.gum}`);
  if (r.colors.length) lines.push("colors:", ...r.colors.map(c => `  - ${c}`));
  lines.push(`tables: ${r.tables}`);
  if (r.back) lines.push(`back: ${r.back}`);
  if (photoPaths.length) lines.push("photo:", ...photoPaths.map(p => `  - ${p}`));
  lines.push("---", r.body, "");
  return lines.join("\n");
}

async function createReport(request, env) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > 40 * 1024 * 1024) return json({ error: "That's too much to send at once. Try fewer photos." }, 413);
  let input;
  try { input = await request.json(); } catch { return json({ error: "The form didn't send properly. Try again." }, 400); }
  const { r, errors } = validate(input);
  if (errors.length) return json({ error: errors.join(" ") }, 400);

  try {
    return await saveToGitHub(r, env);
  } catch (err) {
    console.error(err && err.stack || err);
    if (err && [401, 403, 404].includes(err.status)) {
      return json({ error: "The site's GitHub key isn't working (it may have expired). Ask a grown-up to make a new one." }, 502);
    }
    return json({ error: "Couldn't save to the site just now. Try again in a minute." }, 502);
  }
}

async function saveToGitHub(r, env) {
  const gh = github(env);
  const base = `${r.date}-${slugify(r.restaurant)}`;
  const rand = () => Math.random().toString(16).slice(2, 6);
  const photoSlug = slugify([r.restaurant, r.city].filter(Boolean).join(" ")).slice(0, 40);
  const photoFiles = r.photos.map((data, i) => ({ path: `media/photos/${photoSlug}-${r.date}-${i + 1}-${rand()}.jpg`, data }));
  const photoPaths = photoFiles.map(p => "/" + p.path);
  const markdown = reportFile(r, photoPaths);

  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await gh(`/git/ref/heads/${env.GITHUB_BRANCH}`);
    const headSha = ref.object.sha;
    const head = await gh(`/git/commits/${headSha}`);

    // pick a file name that isn't taken yet
    let name = `${base}.md`;
    for (let n = 2; await gh.exists(`content/reports/${name}`, headSha); n++) name = `${base}-${n}.md`;

    const tree = [];
    for (const p of photoFiles) {
      const blob = await gh(`/git/blobs`, { method: "POST", body: { content: p.data, encoding: "base64" } });
      tree.push({ path: p.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    tree.push({ path: `content/reports/${name}`, mode: "100644", type: "blob", content: markdown });

    const newTree = await gh(`/git/trees`, { method: "POST", body: { base_tree: head.tree.sha, tree } });
    const commit = await gh(`/git/commits`, {
      method: "POST",
      body: { message: `Add gum report: ${r.restaurant} (via post.gumreport.com)`, tree: newTree.sha, parents: [headSha] },
    });
    const moved = await gh(`/git/refs/heads/${env.GITHUB_BRANCH}`, { method: "PATCH", body: { sha: commit.sha, force: false }, allow: [422] });
    if (moved && moved.object) {
      return json({ ok: true, file: `content/reports/${name}`, site: env.SITE_URL });
    }
    // someone else saved at the same moment; try again on top of their change
  }
  return json({ error: "The site was busy saving something else. Press Publish again." }, 409);
}

function github(env) {
  const api = `https://api.github.com/repos/${env.GITHUB_REPO}`;
  const headers = {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "gumreport-poster",
  };
  const call = async (path, { method = "GET", body, allow = [] } = {}) => {
    const res = await fetch(api + path, { method, headers: body ? { ...headers, "content-type": "application/json" } : headers, body: body ? JSON.stringify(body) : undefined });
    if (allow.includes(res.status)) return null;
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };
  call.exists = async (filePath, ref) => {
    const res = await fetch(`${api}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`, { headers });
    if (res.status === 404) return false;
    if (!res.ok) { const err = new Error(`GitHub check ${filePath} -> ${res.status}`); err.status = res.status; throw err; }
    return true;
  };
  return call;
}

/* ---------------- pages ---------------- */

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const html = (body, status = 200) => new Response(body, {
  status,
  headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "same-origin",
    "x-robots-tag": "noindex",
  },
});
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="4" y="12" width="56" height="10" rx="3" fill="#7A4E2D"/><rect x="8" y="20" width="48" height="6" rx="2" fill="#5C3A22"/><rect x="10" y="24" width="6" height="30" rx="2" fill="#5C3A22"/><rect x="48" y="24" width="6" height="30" rx="2" fill="#5C3A22"/><ellipse cx="30" cy="31" rx="8" ry="5.5" fill="#2FB67C"/></svg>`;

function page(title, body, script = "") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#F3F4EF">
<title>${esc(title)} · Under the Table</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/favicon.svg">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bagel+Fat+One&family=Figtree:wght@400;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>${CSS}</style>
</head>
<body>
<main class="wrap">
<header class="top"><a class="brand" href="${"https://gumreport.com"}">Under the <span>Table</span></a></header>
${body}
</main>
${script ? `<script>${script}</script>` : ""}
</body>
</html>`;
}

function loginPage(error = "") {
  return page("Sign in", `<form class="card" method="post" action="/login">
<h1>Post a gum report</h1>
<p class="note">Sign in to add a new report to gumreport.com.</p>
<label class="lbl" for="password">Password</label>
<input class="input" id="password" name="password" type="password" autocomplete="current-password" required autofocus>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<button class="btn primary" type="submit">Sign in</button>
</form>`);
}

function formPage(env) {
  const colorChips = COLORS.map(c => `<button type="button" class="chip" data-color="${c}" aria-pressed="false"><span class="dot" style="background:${HEX[c]}"></span>${c}</button>`).join("");
  return page("New report", `<form class="card" id="f" novalidate>
<div class="headrow"><h1>New report</h1><button class="link" type="button" id="logout">Sign out</button></div>

<div class="field"><label class="lbl" for="restaurant">Restaurant name</label>
<input class="input" id="restaurant" maxlength="80" autocomplete="off" autocapitalize="words" placeholder="e.g. Dok Mali Thai" required></div>

<div class="row2">
<div class="field"><label class="lbl" for="city">Town or city</label><input class="input" id="city" maxlength="60" autocapitalize="words"></div>
<div class="field"><label class="lbl" for="state">State</label><input class="input" id="state" maxlength="20" autocapitalize="characters"></div>
</div>

<div class="field"><label class="lbl" for="date">When did you go? <small>Older visits are fine.</small></label><input class="input" type="date" id="date" required></div>

<div class="field"><span class="lbl">How many pieces of gum?</span>
<div class="stepper"><button type="button" class="step" data-step="gum:-1" aria-label="One less piece">−</button><output id="gum">0</output><button type="button" class="step" data-step="gum:1" aria-label="One more piece">+</button><span id="gumtag" class="tag clean">✓ Spotless</span></div></div>

<div class="field" id="colorsField" hidden><span class="lbl">What colors? <small>Tap all you saw.</small></span><div class="chips">${colorChips}</div></div>

<div class="field"><span class="lbl">How many tables did you check?</span>
<div class="stepper"><button type="button" class="step" data-step="tables:-1" aria-label="One less table">−</button><output id="tables">1</output><button type="button" class="step" data-step="tables:1" aria-label="One more table">+</button></div></div>

<div class="field"><span class="lbl">Would you go back?</span>
<div class="chips" id="back"><button type="button" class="chip" data-back="definitely" aria-pressed="false">Yes</button><button type="button" class="chip" data-back="maybe" aria-pressed="false">Maybe</button><button type="button" class="chip" data-back="nope" aria-pressed="false">No</button></div></div>

<div class="field"><label class="lbl" for="body">Your report <small>What did you find? What should the restaurant do?</small></label>
<textarea class="input" id="body" maxlength="5000" rows="6"></textarea></div>

<div class="field"><span class="lbl">Photos <small>Up to ${MAX_PHOTOS}. Just the gum or the table, no people.</small></span>
<div class="thumbs" id="thumbs"></div>
<label class="btn ghost" for="photos">＋ Add photos</label>
<input id="photos" type="file" accept="image/*" multiple hidden></div>

<p class="err" id="err" role="alert" hidden></p>
<button class="btn primary big" type="submit" id="publish">Publish report</button>
<p class="note" id="status" aria-live="polite"></p>
</form>

<section class="card" id="done" hidden>
<h1>Published! 🎉</h1>
<p class="note">Your report will show up on gumreport.com in about a minute.</p>
<a class="btn primary" href="${esc(env.SITE_URL || "https://gumreport.com")}">See the site</a>
<button class="btn ghost" type="button" id="another">Post another report</button>
</section>`, CLIENT_JS.replace("__MAX__", String(MAX_PHOTOS)));
}

const HEX = { green: "#2FB67C", pink: "#EF6FA0", white: "#F5F5F0", blue: "#4A90E2", purple: "#9B6BD3", red: "#E0453A", yellow: "#F2C94C", gray: "#9AA0A6", brown: "#8B5A3C" };

const CSS = `
:root{color-scheme:light;--bg:#F3F4EF;--surface:#fff;--ink:#17251F;--muted:#56635D;--line:#DDE2DC;--green:#1E9E6A;--green-soft:#D8EFE5;--pink:#E0457F;--pink-soft:#FBDDE8;--pink-ink:#C2305F;
--display:"Bagel Fat One","Arial Rounded MT Bold","Arial Black",sans-serif;--body:"Figtree",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#121815;--surface:#1B2320;--ink:#EDF3EF;--muted:#9DABA4;--line:#2C3833;--green:#4FCB96;--green-soft:#173028;--pink:#FF6F9F;--pink-soft:#3A1D29;--pink-ink:#FF9CBD}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.5 var(--body);padding:env(safe-area-inset-top,0) 16px env(safe-area-inset-bottom,0)}
.wrap{max-width:560px;margin:0 auto;padding-block:16px 48px;display:grid;gap:16px}
.top{display:flex;justify-content:center}
.brand{font-family:var(--display);font-size:24px;text-decoration:none;color:var(--ink)}
.brand span{color:var(--green)}
h1{font-family:var(--display);font-weight:400;font-size:30px;line-height:1.1;margin:0}
.card{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:20px;display:grid;gap:18px}
.headrow{display:flex;justify-content:space-between;align-items:center;gap:12px}
.field{display:grid;gap:8px;min-width:0}
.lbl{font-weight:800}
.lbl small{font-weight:400;font-size:14px;color:var(--muted);margin-left:4px}
.note{margin:0;color:var(--muted)}
.input{width:100%;min-height:52px;border:1.5px solid var(--line);background:var(--bg);color:var(--ink);border-radius:12px;padding:12px 14px;font:inherit;font-size:17px}
textarea.input{min-height:140px;resize:vertical}
.input:focus{outline:3px solid var(--pink);outline-offset:1px}
.row2{display:grid;grid-template-columns:2fr 1fr;gap:12px}
.stepper{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.step{width:56px;height:56px;border-radius:50%;border:1.5px solid var(--line);background:var(--surface);color:var(--ink);font-size:28px;font-weight:700;line-height:1;touch-action:manipulation}
.stepper output{font-family:var(--display);font-size:44px;min-width:56px;text-align:center}
.tag{border-radius:999px;padding:4px 14px;font-weight:700;font-size:15px;white-space:nowrap}
.tag.clean{background:var(--green-soft);color:var(--green)} .tag.sticky{background:var(--pink-soft);color:var(--pink-ink)}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{display:inline-flex;align-items:center;gap:8px;min-height:44px;border:1.5px solid var(--line);background:var(--bg);color:var(--ink);border-radius:999px;padding:8px 16px;font:inherit;font-weight:700;touch-action:manipulation}
.chip[aria-pressed="true"]{background:var(--ink);color:var(--surface);border-color:var(--ink)}
.dot{width:16px;height:16px;border-radius:50%;border:1px solid rgba(0,0,0,.2)}
.btn{display:inline-flex;justify-content:center;align-items:center;gap:8px;min-height:50px;border-radius:999px;padding:12px 22px;font:inherit;font-weight:800;text-decoration:none;cursor:pointer;border:0}
.btn.primary{background:var(--pink);color:#fff}
.btn.primary:disabled{opacity:.6}
.btn.big{font-size:19px;min-height:58px}
.btn.ghost{background:var(--surface);color:var(--ink);border:1.5px solid var(--line)}
.link{background:none;border:0;color:var(--muted);font:inherit;text-decoration:underline;padding:8px}
.thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px}
.thumbs:empty{display:none}
.thumb{position:relative;aspect-ratio:1;border-radius:10px;overflow:hidden;border:1px solid var(--line)}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb button{position:absolute;top:4px;right:4px;width:30px;height:30px;border-radius:50%;border:0;background:rgba(0,0,0,.65);color:#fff;font-size:18px;line-height:1}
.err{margin:0;color:var(--pink-ink);font-weight:800}
[hidden]{display:none!important}
`;

const CLIENT_JS = `
(function(){
  "use strict";
  var MAX = __MAX__, state = { gum: 0, tables: 1, colors: [], back: "", photos: [] };
  var $ = function(id){ return document.getElementById(id); };
  var DRAFT = "gumreport-draft";
  function today(){ var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
  $("date").value = today();
  $("date").max = today();

  // remember typed text if the page is closed by accident (photos aren't kept)
  try {
    var saved = JSON.parse(localStorage.getItem(DRAFT) || "null");
    if (saved) {
      ["restaurant","city","state","date","body"].forEach(function(k){ if (saved[k]) $(k).value = saved[k]; });
      state.gum = saved.gum || 0; state.tables = saved.tables || 1; state.colors = saved.colors || []; state.back = saved.back || "";
    } else {
      var last = JSON.parse(localStorage.getItem("gumreport-last") || "null");
      if (last) { $("city").value = last.city || ""; $("state").value = last.state || ""; }
    }
  } catch (e) {}
  function saveDraft(){
    try { localStorage.setItem(DRAFT, JSON.stringify({ restaurant: $("restaurant").value, city: $("city").value, state: $("state").value, date: $("date").value, body: $("body").value, gum: state.gum, tables: state.tables, colors: state.colors, back: state.back })); } catch (e) {}
  }
  document.addEventListener("input", saveDraft);

  function label(n){ return !n ? "✓ Spotless" : n === 1 ? "One sticky spot" : n <= 3 ? "A few sticky spots" : n <= 6 ? "Lots of sticky spots" : "Gum city"; }
  function draw(){
    $("gum").textContent = state.gum; $("tables").textContent = state.tables;
    var t = $("gumtag"); t.textContent = label(state.gum); t.className = "tag " + (state.gum ? "sticky" : "clean");
    $("colorsField").hidden = state.gum === 0;
    document.querySelectorAll("[data-color]").forEach(function(b){ b.setAttribute("aria-pressed", String(state.colors.indexOf(b.dataset.color) >= 0)); });
    document.querySelectorAll("[data-back]").forEach(function(b){ b.setAttribute("aria-pressed", String(state.back === b.dataset.back)); });
    var th = $("thumbs"); th.innerHTML = "";
    state.photos.forEach(function(p, i){
      var d = document.createElement("div"); d.className = "thumb";
      var img = document.createElement("img"); img.src = p.preview; img.alt = "Photo " + (i + 1);
      var x = document.createElement("button"); x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", "Remove photo " + (i + 1));
      x.onclick = function(){ URL.revokeObjectURL(p.preview); state.photos.splice(i, 1); draw(); };
      d.appendChild(img); d.appendChild(x); th.appendChild(d);
    });
    saveDraft();
  }
  document.querySelectorAll("[data-step]").forEach(function(b){
    b.onclick = function(){
      var parts = b.dataset.step.split(":"), k = parts[0], v = state[k] + Number(parts[1]);
      var min = k === "tables" ? 1 : 0, max = k === "tables" ? 50 : 99;
      state[k] = Math.max(min, Math.min(max, v)); draw();
    };
  });
  document.querySelectorAll("[data-color]").forEach(function(b){
    b.onclick = function(){ var c = b.dataset.color, i = state.colors.indexOf(c); if (i >= 0) state.colors.splice(i, 1); else state.colors.push(c); draw(); };
  });
  document.querySelectorAll("[data-back]").forEach(function(b){
    b.onclick = function(){ state.back = state.back === b.dataset.back ? "" : b.dataset.back; draw(); };
  });

  // shrink each photo on the phone: max 1600px, JPEG. Re-drawing also drops hidden data like GPS location.
  function shrink(file){
    return new Promise(function(resolve, reject){
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function(){
        var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, 1600 / Math.max(w, h));
        var c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function(blob){
          if (!blob) return reject(new Error("encode"));
          var r = new FileReader();
          r.onload = function(){ resolve({ data: String(r.result).split(",")[1], preview: URL.createObjectURL(blob) }); };
          r.onerror = reject; r.readAsDataURL(blob);
        }, "image/jpeg", 0.82);
      };
      img.onerror = function(){ URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }
  $("photos").onchange = async function(e){
    var files = Array.prototype.slice.call(e.target.files || []);
    e.target.value = "";
    showErr("");
    for (var i = 0; i < files.length; i++) {
      if (state.photos.length >= MAX) { showErr("Up to " + MAX + " photos per report."); break; }
      $("status").textContent = "Getting photo " + (i + 1) + " of " + files.length + " ready…";
      try { state.photos.push(await shrink(files[i])); draw(); }
      catch (err) { showErr("One photo couldn't be opened. Try a JPG, or take it with the phone's camera."); }
    }
    $("status").textContent = "";
  };

  function showErr(m){ var el = $("err"); el.textContent = m; el.hidden = !m; }

  $("f").onsubmit = async function(e){
    e.preventDefault();
    showErr("");
    var payload = {
      restaurant: $("restaurant").value.trim(), city: $("city").value.trim(), state: $("state").value.trim(),
      date: $("date").value, body: $("body").value.trim(), gum: state.gum, tables: state.tables,
      colors: state.colors, back: state.back, photos: state.photos.map(function(p){ return { data: p.data }; })
    };
    if (!payload.restaurant) { showErr("Add the restaurant's name."); $("restaurant").focus(); return; }
    if (!payload.date) { showErr("Pick the day you went."); $("date").focus(); return; }
    var btn = $("publish"); btn.disabled = true; btn.textContent = "Publishing…";
    $("status").textContent = state.photos.length ? "Uploading " + state.photos.length + " photo" + (state.photos.length === 1 ? "" : "s") + "…" : "";
    try {
      var res = await fetch("/api/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), credentials: "same-origin" });
      var out = await res.json().catch(function(){ return {}; });
      if (!res.ok) throw new Error(out.error || "Couldn't publish. Check your connection and try again.");
      try { localStorage.removeItem(DRAFT); localStorage.setItem("gumreport-last", JSON.stringify({ city: payload.city, state: payload.state })); } catch (e2) {}
      $("f").hidden = true; $("done").hidden = false; window.scrollTo(0, 0);
    } catch (err) {
      showErr(err.message || "Couldn't publish. Check your connection and try again.");
    } finally {
      btn.disabled = false; btn.textContent = "Publish report"; $("status").textContent = "";
    }
  };
  $("another").onclick = function(){ location.reload(); };
  $("logout").onclick = function(){
    var f = document.createElement("form"); f.method = "post"; f.action = "/logout"; document.body.appendChild(f); f.submit();
  };
  draw();
})();
`;
