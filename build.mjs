// Builds the Under the Table website into _site/.
// No outside packages needed: run with `node build.mjs`.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(ROOT, "_site");
const REPORTS_DIR = path.join(ROOT, "content", "reports");

/* ---------- tiny YAML reader (covers what Pages CMS writes) ---------- */
function parseScalar(raw) {
  let s = raw.trim();
  if (s === "" || s === "~" || s === "null") return "";
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlow(inner).map(parseScalar);
  }
  s = s.replace(/\s+#.*$/, "");
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
function splitFlow(str) {
  const out = []; let cur = "", q = null;
  for (const ch of str) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ",") { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
export function parseYaml(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const obj = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line) || /^\s/.test(line)) { i++; continue; }
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const rest = m[2].trim();
    i++;
    if (/^[|>][+-]?\d*$/.test(rest)) {
      const folded = rest[0] === ">";
      const keep = rest.includes("+"), strip = rest.includes("-");
      const block = [];
      while (i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i]))) { block.push(lines[i]); i++; }
      const indent = Math.min(...block.filter(l => l.trim()).map(l => l.match(/^\s*/)[0].length).concat([Infinity]));
      let body = block.map(l => l.slice(Number.isFinite(indent) ? indent : 0));
      if (!keep) while (body.length && !body[body.length - 1].trim()) body.pop();
      let val;
      if (folded) {
        val = ""; let prevBlank = true;
        for (const l of body) {
          if (!l.trim()) { val += "\n"; prevBlank = true; }
          else { val += (prevBlank ? "" : " ") + l; prevBlank = false; }
        }
      } else val = body.join("\n");
      obj[key] = strip ? val : val + "\n";
      if (strip) obj[key] = val;
      continue;
    }
    if (rest === "") {
      const items = [];
      while (i < lines.length && (/^\s*-\s/.test(lines[i]) || /^\s*-$/.test(lines[i]) || !lines[i].trim())) {
        const lm = lines[i].match(/^\s*-\s?(.*)$/);
        if (lm) items.push(parseScalar(lm[1]));
        i++;
      }
      obj[key] = items.length ? items : "";
      continue;
    }
    // plain multi-line continuation (indented lines after a plain scalar)
    let val = rest;
    while (i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*-\s/.test(lines[i])) { val += " " + lines[i].trim(); i++; }
    obj[key] = parseScalar(val);
  }
  return obj;
}
function readFrontmatter(text) {
  const t = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const m = t.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: t };
  return { data: parseYaml(m[1]), body: m[2] };
}

/* ---------- helpers ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slugify = s => String(s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/['\u2019]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report";
const COLORS = { green: "#2FB67C", pink: "#EF6FA0", white: "#F5F5F0", blue: "#4A90E2", purple: "#9B6BD3", red: "#E0453A", yellow: "#F2C94C", gray: "#9AA0A6", grey: "#9AA0A6", brown: "#8B5A3C" };
const BACK = { definitely: "Would go back", yes: "Would go back", maybe: "Maybe go back", nope: "Would not go back", no: "Would not go back" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function normDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const m = String(v || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}
function fmtDate(iso, long) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return "";
  return `${(long ? MONTHS_LONG : MONTHS)[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}
function stickyLabel(n) {
  if (!n) return "Spotless";
  if (n === 1) return "One sticky spot";
  if (n <= 3) return "A few sticky spots";
  if (n <= 6) return "Lots of sticky spots";
  return "Gum city";
}
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="nofollow noopener">$1</a>');
}
function paragraphs(body) {
  return String(body || "").replace(/\r\n?/g, "\n").split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
}
function plain(s) { return String(s).replace(/\*\*|\*/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); }
function place(r) { return [r.city, r.state].filter(Boolean).join(", "); }

/* ---------- load content ---------- */
const site = Object.assign({
  url: "https://example.com", author: "The Gum Inspector",
  intro: "Every time I eat out, I check under the table for gum. Here is what I find, restaurant by restaurant.",
  restaurants_message: "", everyone_message: ""
}, parseYaml(fs.readFileSync(path.join(ROOT, "content", "site.yml"), "utf8")));
for (const k of Object.keys(site)) if (typeof site[k] === "string") site[k] = site[k].trim();
site.url = String(site.url || "https://example.com").replace(/\/+$/, "");
const SITE_NAME = "Under the Table";

const files = fs.existsSync(REPORTS_DIR) ? fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith(".md")).sort() : [];
let reports = files.map(f => {
  const { data, body } = readFrontmatter(fs.readFileSync(path.join(REPORTS_DIR, f), "utf8"));
  const gum = Math.max(0, parseInt(data.gum, 10) || 0);
  let colors = Array.isArray(data.colors) ? data.colors : (data.colors ? String(data.colors).split(",") : []);
  colors = colors.map(c => String(c).trim().toLowerCase()).filter(c => COLORS[c]);
  if (!gum) colors = [];
  return {
    file: f,
    restaurant: String(data.restaurant || "").trim() || f.replace(/\.md$/, ""),
    city: String(data.city || "").trim(),
    state: String(data.state || "").trim(),
    date: normDate(data.date) || f.slice(0, 10),
    gum, colors,
    tables: Math.max(1, parseInt(data.tables, 10) || 1),
    back: BACK[String(data.back === true ? "yes" : data.back === false ? "no" : data.back || "").toLowerCase()] || "",
    photo: String(data.photo || "").trim(),
    draft: data.draft === true,
    paras: paragraphs(body),
  };
}).filter(r => !r.draft);

// stable, readable addresses: /reports/dok-mali-thai-portland-me/
reports.sort((a, b) => a.date.localeCompare(b.date) || a.file.localeCompare(b.file));
const used = new Set();
for (const r of reports) {
  let s = slugify([r.restaurant, r.city, r.state].filter(Boolean).join(" "));
  if (used.has(s)) s = `${s}-${r.date}`;
  let n = 2; const base = s;
  while (used.has(s)) s = `${base}-${n++}`;
  used.add(s); r.slug = s;
}
reports.sort((a, b) => b.date.localeCompare(a.date) || a.restaurant.localeCompare(b.restaurant));

const totalGum = reports.reduce((t, r) => t + r.gum, 0);
const spotless = reports.filter(r => !r.gum).length;

/* ---------- pieces ---------- */
function tableSvg(list, label) {
  const pieces = [];
  list.forEach(r => {
    const cols = r.colors.length ? r.colors : ["gray"];
    for (let i = 0; i < r.gum; i++) pieces.push({ c: COLORS[cols[i % cols.length]], k: `${r.slug}:${i}` });
  });
  const left = 100, right = 900;
  let planks = "";
  for (let x = 42; x < 980; x += 40) planks += `<line class="t-plank" x1="${x}" y1="4" x2="${x}" y2="34"/>`;
  const n = pieces.length;
  const gums = pieces.map((g, i) => {
    const h = hash(g.k);
    const slot = left + 30 + (right - left - 60) * ((i + 0.5) / Math.max(n, 1));
    const jitter = ((h % 1000) / 1000 - 0.5) * Math.min(60, (right - left) / Math.max(n, 1));
    const cx = Math.max(left + 20, Math.min(right - 20, n === 1 ? left + 250 + (h % 200) : slot + jitter));
    const cy = 78 + ((h >> 10) % 10), rx = 15 + ((h >> 4) % 6), ry = 10 + ((h >> 7) % 4);
    return `<ellipse class="gumblob" cx="${cx.toFixed(1)}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${g.c}"/>`;
  }).join("");
  return `<svg viewBox="0 0 1000 230" role="img" aria-label="${esc(label || `A table with ${n} piece${n === 1 ? "" : "s"} of gum stuck underneath`)}"><rect class="t-top" x="0" y="0" width="1000" height="40" rx="10"/>${planks}<rect class="t-apron" x="50" y="36" width="900" height="30" rx="4"/><rect class="t-leg" x="70" y="60" width="26" height="170" rx="4"/><rect class="t-leg" x="904" y="60" width="26" height="170" rx="4"/>${gums}</svg>`;
}
const dots = r => r.colors.map(c => `<span class="dot" style="background:${COLORS[c]}" title="${esc(c)}"></span>`).join("");
const tagsHtml = r => `<span class="tag ${r.gum ? "sticky" : "clean"}">${r.gum ? "" : "✓ "}${stickyLabel(r.gum)}</span>${dots(r)}${r.tables > 1 ? `<span class="tag plain">${r.tables} tables checked</span>` : ""}${r.back ? `<span class="tag plain">${esc(r.back)}</span>` : ""}`;
const photoSrc = (r, prefix) => r.photo ? prefix + r.photo.replace(/^\/+/, "") : "";
const describe = r => {
  const where = place(r) ? ` in ${place(r)}` : "";
  const found = r.gum ? `${r.gum} piece${r.gum === 1 ? "" : "s"} of${r.colors.length ? " " + r.colors.join(" and ") : ""} gum stuck under the table` : "no gum under the table";
  return `Gum report for ${r.restaurant}${where}: The Gum Inspector found ${found} on ${fmtDate(r.date, true)}.${r.gum ? "" : " Spotless!"}`;
};

function layout({ prefix, title, description, canonical, body, ogImage, jsonld, ogType = "website" }) {
  const og = ogImage || `${site.url}/og.png`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(og)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${prefix}favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="${SITE_NAME}" href="${site.url}/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bagel+Fat+One&family=Figtree:wght@400;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="${prefix}styles.css">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>` : ""}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<main class="wrap" id="main">
${body}
</main>
</body>
</html>
`;
}
const panels = () => `<section class="two" aria-label="What you can do">
<div class="panel mint"><h2>Restaurants</h2><p>${esc(site.restaurants_message)}</p></div>
<div class="panel rose"><h2>Everyone else</h2><p>${esc(site.everyone_message)}</p></div>
</section>`;
const footer = prefix => `<footer class="foot"><span>${SITE_NAME} · reports from ${esc(site.author)}</span><span><a href="${prefix}feed.xml">RSS feed</a></span></footer>`;

/* ---------- pages ---------- */
function homePage() {
  const prefix = "";
  const cards = reports.map(r => `<article class="report">
<div class="rhead"><h3><a href="reports/${r.slug}/">${esc(r.restaurant)}</a></h3><div class="meta">${esc([place(r), fmtDate(r.date)].filter(Boolean).join(" · "))}</div></div>
<div class="count${r.gum ? "" : " zero"}"><b>${r.gum}</b><span>gum</span></div>
<div class="tags">${tagsHtml(r)}</div>
${r.paras[0] ? `<p class="excerpt">${inline(r.paras[0])}</p>` : ""}
<span class="readmore" aria-hidden="true">Read the report →</span>
</article>`).join("\n");
  const body = `<header class="hero">
<span class="eyebrow">Restaurant reports by ${esc(site.author)}</span>
<h1>Under the <span class="accent">Table</span></h1>
<p class="lede">${esc(site.intro)}</p>
</header>
<figure class="scene">${tableSvg(reports)}<figcaption>${totalGum ? "Every piece of gum found so far, stuck under one table." : "No gum found yet. Nice and clean."}</figcaption></figure>
<section class="stats" aria-label="Totals">
<div class="stat"><b>${reports.length}</b><span>Restaurants checked</span></div>
<div class="stat"><b>${totalGum}</b><span>Pieces of gum found</span></div>
<div class="stat"><b>${spotless}</b><span>Spotless tables</span></div>
</section>
<section class="reports" aria-labelledby="reports-h">
<div class="sec-head"><h2 id="reports-h">Reports</h2></div>
${cards || '<div class="empty">No reports yet.</div>'}
</section>
${panels()}
${footer(prefix)}`;
  const description = `${SITE_NAME}: a kid checks under restaurant tables for stuck gum and reports what he finds. ${reports.length} restaurant${reports.length === 1 ? "" : "s"} checked, ${totalGum} piece${totalGum === 1 ? "" : "s"} of gum found so far.`;
  return layout({
    prefix, title: `${SITE_NAME}: Gum reports from restaurant tables`, description, canonical: `${site.url}/`, body,
    jsonld: { "@context": "https://schema.org", "@type": "Blog", name: SITE_NAME, url: `${site.url}/`, description, author: { "@type": "Person", name: site.author },
      blogPost: reports.slice(0, 20).map(r => ({ "@type": "BlogPosting", headline: `${r.restaurant} gum report`, url: `${site.url}/reports/${r.slug}/`, datePublished: r.date })) }
  });
}

function reportPage(r) {
  const prefix = "../../";
  const canonical = `${site.url}/reports/${r.slug}/`;
  const others = reports.filter(o => o !== r).slice(0, 5);
  const img = photoSrc(r, prefix);
  const body = `<nav class="topbar" aria-label="Site"><a class="brand" href="${prefix}">Under the <span>Table</span></a><a class="navlink" href="${prefix}#reports-h">← All reports</a></nav>
<article class="article">
<div class="article-head">
<div class="rhead"><span class="eyebrow">Gum report</span><h1>${esc(r.restaurant)}</h1><div class="meta">${esc([place(r), fmtDate(r.date)].filter(Boolean).join(" · "))}</div></div>
<div class="count${r.gum ? "" : " zero"}"><b>${r.gum}</b><span>gum</span></div>
<div class="tags">${tagsHtml(r)}</div>
</div>
<figure class="scene">${tableSvg([r], `The table at ${r.restaurant} with ${r.gum} piece${r.gum === 1 ? "" : "s"} of gum underneath`)}</figure>
<div class="story">${r.paras.map(p => `<p>${inline(p).replace(/\n/g, "<br>")}</p>`).join("\n") || "<p>No write-up for this visit.</p>"}</div>
${img ? `<figure class="photo"><img src="${esc(img)}" alt="Under the table at ${esc(r.restaurant)}" loading="lazy"><figcaption>Photo from under the table.</figcaption></figure>` : ""}
<dl class="facts">
<div><dt>Restaurant</dt><dd>${esc(r.restaurant)}</dd></div>
${place(r) ? `<div><dt>Where</dt><dd>${esc(place(r))}</dd></div>` : ""}
<div><dt>Visited</dt><dd><time datetime="${r.date}">${fmtDate(r.date, true)}</time></dd></div>
<div><dt>Gum found</dt><dd>${r.gum}</dd></div>
<div><dt>Tables checked</dt><dd>${r.tables}</dd></div>
</dl>
</article>
${others.length ? `<section class="more"><h2>More reports</h2><ul>${others.map(o => `<li><a href="${prefix}reports/${o.slug}/">${esc(o.restaurant)}<span>${o.gum} gum</span></a></li>`).join("")}</ul></section>` : ""}
${panels()}
${footer(prefix)}`;
  const title = `${r.restaurant}${r.city ? ` (${place(r)})` : ""} gum report: ${r.gum ? `${r.gum} piece${r.gum === 1 ? "" : "s"} under the table` : "spotless table"} | ${SITE_NAME}`;
  const description = describe(r) + (r.paras[0] ? " " + plain(r.paras[0]).slice(0, 120) : "");
  return layout({
    prefix, title, description: description.slice(0, 300), canonical, body, ogType: "article",
    ogImage: r.photo ? `${site.url}/${r.photo.replace(/^\/+/, "")}` : null,
    jsonld: { "@context": "https://schema.org", "@type": "BlogPosting", headline: `${r.restaurant} gum report`, description: describe(r), datePublished: r.date, url: canonical, mainEntityOfPage: canonical,
      author: { "@type": "Person", name: site.author }, publisher: { "@type": "Organization", name: SITE_NAME },
      ...(r.photo ? { image: `${site.url}/${r.photo.replace(/^\/+/, "")}` } : {}),
      about: { "@type": "Restaurant", name: r.restaurant, ...(place(r) ? { address: { "@type": "PostalAddress", addressLocality: r.city || undefined, addressRegion: r.state || undefined } } : {}) } }
  });
}

function notFound() {
  // absolute paths so it works at any depth
  return layout({ prefix: "/", title: `Page not found | ${SITE_NAME}`, description: "That page isn't here.", canonical: `${site.url}/404.html`,
    body: `<nav class="topbar"><a class="brand" href="/">Under the <span>Table</span></a></nav><section class="hero"><h1>No gum here</h1><p class="lede">That page doesn't exist. <a href="/">Go to all the reports.</a></p></section>` })
    .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="robots" content="noindex">');
}

/* ---------- write ---------- */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const write = (rel, s) => { const p = path.join(OUT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const copyDir = (from, to) => { if (!fs.existsSync(from)) return; fs.cpSync(from, path.join(OUT, to), { recursive: true }); };

copyDir(path.join(ROOT, "static"), ".");
copyDir(path.join(ROOT, "media"), "media");
write("index.html", homePage());
for (const r of reports) write(`reports/${r.slug}/index.html`, reportPage(r));
write("404.html", notFound());
write("robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${site.url}/sitemap.xml\n`);
const lastmod = reports[0]?.date || new Date().toISOString().slice(0, 10);
write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${site.url}/</loc><lastmod>${lastmod}</lastmod></url>
${reports.map(r => `<url><loc>${site.url}/reports/${r.slug}/</loc><lastmod>${r.date}</lastmod></url>`).join("\n")}
</urlset>
`);
const rfc822 = iso => new Date(iso + "T12:00:00Z").toUTCString();
write("feed.xml", `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${SITE_NAME}</title><link>${site.url}/</link><description>${esc(site.intro)}</description>
${reports.slice(0, 30).map(r => `<item><title>${esc(r.restaurant)}: ${r.gum} gum</title><link>${site.url}/reports/${r.slug}/</link><guid>${site.url}/reports/${r.slug}/</guid><pubDate>${rfc822(r.date)}</pubDate><description>${esc(describe(r))}</description></item>`).join("\n")}
</channel></rss>
`);
try {
  const host = new URL(site.url).hostname;
  if (host && !/github\.io$|^example\.com$/.test(host)) write("CNAME", host + "\n");
} catch {}
write(".nojekyll", "");
console.log(`Built ${reports.length} report page(s) into _site/ for ${site.url}`);
