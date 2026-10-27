(function () {
  "use strict";

  var PAGE_SIZE = 60;
  var PART_TABS_MAX = 10; // above this, parts use a dropdown instead of one tab each
  var SITE_TITLE = document.title;

  var state = {
    ready: false,
    sources: [],
    sourcesById: {},
    sourceIndex: {},
    items: [],
    itemsByKey: {},
    orderBySource: {}, // sourceId -> items in date order (for prev/next in the reader)
    partsByBook: {}, // "sourceId:book_id" -> [{part, path, ...}]
    stats: {}, // stats_path -> parsed JSON
    loadErrors: [],
    sourceFilter: "all",
    query: "",
    tokens: [],
    sort: "title",
    shown: 0,
    filtered: [],
    partCache: {},
    reading: false,
    listScroll: 0,
    renderToken: 0,
    reignIndex: {}, // sourceId -> eras (왕 → 해 → 달 → 날)
    browse: { king: null, year: null, month: null, daySort: "date" },
    view: "both", // reader: both | ko | han
  };
  try { state.view = localStorage.getItem("kch.view") || "both"; } catch (e) { /* storage blocked */ }

  var collator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });

  function $(id) { return document.getElementById(id); }
  var gridView = $("gridView");
  var grid = $("grid");
  var browser = $("browser");
  var homeEl = $("home");
  var heroLead = $("heroLead");
  var sortLabel = $("sortLabel");
  var readerTools = $("readerTools");
  var readerToc = $("readerToc");
  var readerBody = $("readerBody");
  var readerCrumbs = $("readerCrumbs");
  var notice = $("notice");
  var emptyState = $("emptyState");
  var resultCount = $("resultCount");
  var searchInput = $("searchInput");
  var sortSelect = $("sortSelect");
  var sentinel = $("sentinel");
  var sourceTabs = $("sourceTabs");
  var statsLine = $("stats");
  var controls = $("controls");
  var readerView = $("readerView");
  var readerHeader = $("readerHeader");
  var partTabs = $("partTabs");
  var readerContent = $("readerContent");
  var readerPager = $("readerPager");
  var readerSource = $("readerSource");
  var backLink = $("backLink");

  // ---------------------------------------------------------------- helpers

  function normalize(text) {
    return (text == null ? "" : String(text)).toLowerCase();
  }

  function escapeHtml(s) {
    return (s == null ? "" : String(s))
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString("ko-KR");
  }

  // Values like "*" or "" mean "unknown" in the source data.
  function clean(v) {
    if (v == null) return "";
    v = String(v).trim();
    return v === "*" ? "" : v;
  }

  function parseJsonl(text) {
    var rows = [];
    var lines = (text || "").split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      try { rows.push(JSON.parse(line)); } catch (err) { /* skip malformed line */ }
    }
    return rows;
  }

  function get(row, key) {
    return key ? row[key] : undefined;
  }

  function fetchText(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    });
  }

  function fetchTextCached(url) {
    if (state.partCache[url]) return state.partCache[url];
    var p = fetchText(url);
    state.partCache[url] = p;
    p.catch(function () { delete state.partCache[url]; });
    return p;
  }

  // Only allow http(s), in-page and plain relative links out of fetched content.
  function safeHref(href) {
    href = (href || "").trim();
    if (/^https?:\/\//i.test(href) || href.charAt(0) === "#") return href;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || /^\/\//.test(href)) return null;
    return href;
  }

  // ------------------------------------------------- minimal Markdown renderer
  // Scoped to what the aks_yoksa / sjw_ilgi snapshot generators emit:
  // headings, "- " lists, "|" tables, ``` fences, "---" rules, **bold**,
  // `code`, [text](href), bare URLs and plain paragraphs.

  var INLINE_RE = /`([^`]+)`|\[([^\]]*)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()"]*[^\s<>()".,;:!?'])/g;

  function plainInline(s) {
    return escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }

  function linkHtml(href, text) {
    var safe = safeHref(href);
    if (safe == null) return text;
    var ext = /^https?:/i.test(safe) ? ' target="_blank" rel="noopener"' : "";
    return '<a href="' + escapeHtml(safe) + '"' + ext + ">" + text + "</a>";
  }

  function inlineMd(s) {
    var out = "";
    var last = 0;
    var m;
    INLINE_RE.lastIndex = 0;
    while ((m = INLINE_RE.exec(s))) {
      out += plainInline(s.slice(last, m.index));
      if (m[1] != null) out += "<code>" + escapeHtml(m[1]) + "</code>";
      else if (m[3] != null) out += linkHtml(m[3], plainInline(m[2]));
      else out += linkHtml(m[4], escapeHtml(m[4]));
      last = INLINE_RE.lastIndex;
    }
    return out + plainInline(s.slice(last));
  }

  function renderTable(tableLines) {
    var rows = tableLines.map(function (l) {
      return l.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map(function (c) { return c.trim(); });
    });
    var header = rows[0];
    var body = rows.slice(1).filter(function (r) { return !r.every(function (c) { return /^:?-{2,}:?$/.test(c); }); });
    var out = '<div class="tableWrap"><table><thead><tr>';
    header.forEach(function (h) { out += "<th>" + inlineMd(h) + "</th>"; });
    out += "</tr></thead><tbody>";
    body.forEach(function (r) {
      out += "<tr>" + r.map(function (c) { return "<td>" + inlineMd(c) + "</td>"; }).join("") + "</tr>";
    });
    return out + "</tbody></table></div>";
  }

  var META_ITEM_RE = /^([^:[\]`]{1,15}):\s+(.+)$/;

  function renderList(items, afterH2) {
    var isMeta = items.every(function (it) { return META_ITEM_RE.test(it); });
    if (!isMeta) {
      return "<ul>" + items.map(function (it) { return "<li>" + inlineMd(it) + "</li>"; }).join("") + "</ul>";
    }
    var html = '<ul class="metaList">' + items.map(function (it) {
      var m = it.match(META_ITEM_RE);
      return '<li><span class="metaKey">' + escapeHtml(m[1]) + '</span><span class="metaVal">' + inlineMd(m[2]) + "</span></li>";
    }).join("") + "</ul>";
    // Per-article bookkeeping (IDs, model, timestamps) is tucked away so the
    // translation itself comes first.
    if (afterH2) html = '<details class="articleMeta"><summary>기사 정보</summary>' + html + "</details>";
    return html;
  }

  function isBlockStart(line) {
    return /^\s*$/.test(line) || /^#{1,6}\s/.test(line) || /^-\s+/.test(line) ||
      /^```/.test(line) || /^\|/.test(line) || /^-{3,}\s*$/.test(line);
  }

  function renderMarkdown(text, opts) {
    opts = opts || {};
    var lines = text.replace(/\r\n/g, "\n").split("\n");
    var out = [];
    var i = 0;
    var lastBlock = "";
    if (opts.dropTitle) {
      while (i < lines.length && /^\s*$/.test(lines[i])) i++;
      if (i < lines.length && /^#\s+/.test(lines[i])) i++;
    }
    while (i < lines.length) {
      var line = lines[i];
      var fence = line.match(/^```\s*(\S*)/);
      if (fence) {
        var buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        if (fence[1] === "text" || fence[1] === "") {
          out.push('<div class="wonmun" lang="lzh">' + escapeHtml(buf.join("\n").replace(/^\n+|\n+$/g, "")) + "</div>");
        } else {
          out.push('<pre class="codeBlock"><code>' + escapeHtml(buf.join("\n")) + "</code></pre>");
        }
        lastBlock = "code";
        continue;
      }
      if (/^\s*$/.test(line)) { i++; continue; }
      if (/^-{3,}\s*$/.test(line)) { out.push("<hr />"); i++; lastBlock = "hr"; continue; }
      var heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        var level = heading[1].length;
        out.push("<h" + level + ">" + inlineMd(heading[2]) + "</h" + level + ">");
        i++;
        lastBlock = "h" + level;
        continue;
      }
      if (/^\|/.test(line)) {
        var tableLines = [];
        while (i < lines.length && /^\|/.test(lines[i])) { tableLines.push(lines[i]); i++; }
        out.push(renderTable(tableLines));
        lastBlock = "table";
        continue;
      }
      if (/^-\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^-\s+/.test(lines[i])) { items.push(lines[i].replace(/^-\s+/, "")); i++; }
        var listHtml = renderList(items, lastBlock === "h2");
        // Machine-extracted entity candidates (with confidence scores) are
        // reviewer data, not reading material: fold heading + list together.
        if (lastBlock === "h3" && /^<h3>엔티티 후보<\/h3>$/.test(out[out.length - 1])) {
          out.pop();
          listHtml = '<details class="articleMeta"><summary>엔티티 후보 ' + items.length + "개</summary>" + listHtml + "</details>";
        }
        out.push(listHtml);
        lastBlock = "list";
        continue;
      }
      var para = [line];
      i++;
      while (i < lines.length && !isBlockStart(lines[i])) { para.push(lines[i]); i++; }
      out.push("<p>" + inlineMd(para.join(" ")) + "</p>");
      lastBlock = "p";
    }
    return out.join("\n");
  }

  // ------------------------------------------------------------ loading data
  // Every "active" source needs an entry in sources.json with a flat JSONL
  // index and a field mapping into the common item shape below.
  //   reader:"book"    multi-part reader (README / haje / part-NNN)
  //   reader:"article" single-page reader with prev/next by date
  //   fields.title_sort / fields.date_sort  optional sort keys
  //   date_sort_mode   "year" (pull a 4-digit year out) or "text" (as-is)

  // 왕대·연호 → 서기: base = 원년의 전해, so 서기 = base + n. Used when a date
  // has only a reign year ("고종40년", "肅宗22", "光武元年").
  var ERA_BASES = [
    ["태조", "太祖", 1391], ["정종", "定宗", 1398], ["태종", "太宗", 1400], ["세종", "世宗", 1418],
    ["문종", "文宗", 1450], ["단종", "端宗", 1452], ["세조", "世祖", 1455], ["예종", "睿宗", 1468],
    ["성종", "成宗", 1469], ["연산군", "燕山君", 1494], ["중종", "中宗", 1505], ["인종", "仁宗", 1544],
    ["명종", "明宗", 1545], ["선조", "宣祖", 1567], ["광해군", "光海君", 1608], ["광해", "光海", 1608],
    ["인조", "仁祖", 1622], ["효종", "孝宗", 1649], ["현종", "顯宗", 1659], ["숙종", "肅宗", 1674],
    ["경종", "景宗", 1720], ["영조", "英祖", 1724], ["정조", "正祖", 1776], ["순조", "純祖", 1800],
    ["헌종", "憲宗", 1834], ["철종", "哲宗", 1849], ["고종", "高宗", 1863], ["순종", "純宗", 1906],
    ["광무", "光武", 1896], ["융희", "隆熙", 1906], ["메이지", "明治", 1867], ["다이쇼", "大正", 1911],
    ["쇼와", "昭和", 1925],
  ];
  var ERA_RE = new RegExp("(" + ERA_BASES.map(function (e) { return e[0] + "|" + e[1]; }).join("|") + ")\\s*(\\d{1,2}|元)");
  var ERA_LOOKUP = {};
  ERA_BASES.forEach(function (e) { ERA_LOOKUP[e[0]] = e[2]; ERA_LOOKUP[e[1]] = e[2]; });

  function yearOf(v) {
    var s = String(v || "");
    var m = s.match(/(1[0-9]{3}|20[0-9]{2})/);
    if (m) return parseInt(m[1], 10);
    var e = s.match(ERA_RE);
    if (e) return ERA_LOOKUP[e[1]] + (e[2] === "元" ? 1 : parseInt(e[2], 10));
    return null;
  }

  // Display clean-up for book titles/authors/dates (the raw values stay in
  // the search text).
  var UNKNOWN_DATE_RE = /^\[?(寫年|刊年|年紀)?未詳\]?$|^미상$/;

  function cleanBookTitle(s) {
    s = String(s || "").replace(/\s*n\d+-\d+책\s*$/, "");
    var m = s.match(/^(.*\S)\s+\[(.+)\]$/);
    if (m && /[一-鿿]/.test(m[2])) s = m[1];
    return s.replace(/\s*n\d+-\d+책\s*$/, "").trim();
  }

  // reign sources (승정원일기): the key encodes 왕대·재위년·월·윤달·일, e.g.
  // SJW-G21030020 = 정조 21년 3월 2일. sources.json maps each prefix to a
  // king and the year before 원년, so 서기 = base + 재위년 (0 = 즉위년).
  function reignEras(source) {
    if (!source._eras) {
      source._eras = {};
      (source.reign.eras || []).forEach(function (e, i) { e.order = i; source._eras[e.prefix] = e; });
    }
    return source._eras;
  }

  function parseReign(source, key) {
    var m = String(key).match(new RegExp(source.reign.key_pattern));
    if (!m) return null;
    var era = reignEras(source)[m[1]];
    if (!era) return null;
    var year = parseInt(m[2], 10);
    return {
      prefix: m[1], king: era.king, era: era, year: year,
      month: parseInt(m[3], 10), leap: m[4] === "1", day: parseInt(m[5], 10),
      ad: era.base + year,
    };
  }

  function reignYearLabel(year) { return year === 0 ? "즉위년" : year + "년"; }
  function monthLabel(month, leap) { return (leap ? "윤" : "") + month + "월"; }
  function monthKey(month, leap) { return (leap ? "윤" : "") + month; }
  function fixAccession(s) { return String(s || "").replace(/(\S) 0년/g, "$1 즉위년"); }

  function toItem(source, row) {
    var f = source.fields || {};
    var id = get(row, f.id);
    var reign = source.reign ? parseReign(source, id) : null;
    var titleKo = clean(get(row, f.title_ko));
    var titleHanja = clean(get(row, f.title_hanja));
    var subtitle = clean(get(row, f.subtitle));
    var date = clean(get(row, f.date));
    if (reign) {
      // The index sometimes tags a king's last day with his successor; the key is right.
      subtitle = reign.king;
      titleKo = fixAccession(titleKo);
      date = fixAccession(date);
    }
    var rawTitles = titleKo + " " + titleHanja;
    if (source.reader === "book") {
      titleKo = cleanBookTitle(titleKo);
      titleHanja = cleanBookTitle(titleHanja);
      if (/미상/.test(subtitle) && subtitle.length <= 8) subtitle = "미상";
      if (UNKNOWN_DATE_RE.test(date)) date = "";
    }
    var dateRaw = clean(get(row, f.date_sort || f.date));
    var dateKey = source.date_sort_mode === "year" ? yearOf(dateRaw) : (dateRaw || null);
    var displayTitle = titleKo || titleHanja || String(id);
    return {
      _source: source.id,
      _sourceName: source.name,
      _key: source.id + ":" + id,
      _id: id,
      title_ko: titleKo,
      title_hanja: titleHanja,
      subtitle: subtitle,
      date: date,
      count: f.count ? Number(get(row, f.count)) || 0 : 1,
      path: get(row, f.path),
      displayTitle: displayTitle,
      // "(신편) 척독대방", "[국조보감]감인청의궤" sort under 척, 감 -- not under the bracket.
      titleKey: f.title_sort
        ? String(get(row, f.title_sort) || "")
        : displayTitle.replace(/^(\s*[[(（【][^\])）】]*[\])）】]\s*)+/, "") || displayTitle,
      dateKey: dateKey,
      reign: reign,
      row: row,
      haystack: normalize([titleKo, titleHanja, rawTitles, subtitle, date, id, reign ? reign.ad : "", typeof dateKey === "number" ? dateKey : ""].join(" ")),
    };
  }

  // 왕 → 해 → 달 → 날 tree for the reign browser.
  function buildReignIndex(source) {
    var eras = [];
    var byPrefix = {};
    state.items.forEach(function (it) {
      if (it._source !== source.id || !it.reign) return;
      var r = it.reign;
      var e = byPrefix[r.prefix];
      if (!e) {
        e = byPrefix[r.prefix] = { prefix: r.prefix, king: r.king, order: r.era.order, base: r.era.base, years: {}, days: 0, entries: 0 };
        eras.push(e);
      }
      var y = e.years[r.year] = e.years[r.year] || { year: r.year, months: {}, days: 0, entries: 0 };
      var mk = monthKey(r.month, r.leap);
      var m = y.months[mk] = y.months[mk] || { key: mk, month: r.month, leap: r.leap, items: [], entries: 0 };
      m.items.push(it);
      m.entries += it.count;
      y.days++; y.entries += it.count;
      e.days++; e.entries += it.count;
    });
    eras.sort(function (a, b) { return a.order - b.order; });
    eras.forEach(function (e) {
      e.yearList = Object.keys(e.years).map(Number).sort(function (a, b) { return a - b; }).map(function (k) {
        var y = e.years[k];
        y.monthList = Object.keys(y.months).map(function (mk) { return y.months[mk]; })
          .sort(function (a, b) { return a.month - b.month || a.leap - b.leap; });
        y.monthList.forEach(function (m) {
          m.items.sort(function (a, b) { return collator.compare(a._id, b._id); });
        });
        return y;
      });
      e.firstYear = e.yearList[0].year;
      e.lastYear = e.yearList[e.yearList.length - 1].year;
    });
    return eras;
  }

  function loadSource(source) {
    if (source.status !== "active" || !source.index_path) return Promise.resolve([]);
    var jobs = [fetchText(source.base_url + "/" + source.index_path)];
    if (source.parts_index_path) {
      jobs.push(fetchText(source.base_url + "/" + source.parts_index_path).catch(function () { return ""; }));
    }
    return Promise.all(jobs)
      .then(function (results) {
        if (results[1]) {
          parseJsonl(results[1]).forEach(function (p) {
            var key = source.id + ":" + p.book_id;
            (state.partsByBook[key] = state.partsByBook[key] || []).push(p);
          });
          Object.keys(state.partsByBook).forEach(function (k) {
            state.partsByBook[k].sort(function (a, b) { return a.part - b.part; });
          });
        }
        return parseJsonl(results[0]).map(function (row) { return toItem(source, row); });
      })
      .catch(function () {
        state.loadErrors.push(source.name);
        return [];
      });
  }

  function loadStats() {
    var urls = {};
    state.sources.forEach(function (s) {
      if (s.stats_path) urls[s.stats_path] = s.base_url + "/" + s.stats_path;
    });
    return Promise.all(Object.keys(urls).map(function (path) {
      return fetch(urls[path])
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (json) { state.stats[path] = json; });
    }));
  }

  function statsFor(source) {
    var json = source.stats_path && state.stats[source.stats_path];
    return json && source.stats_key ? json[source.stats_key] : null;
  }

  function itemCount(sourceId) {
    var n = 0;
    for (var i = 0; i < state.items.length; i++) if (state.items[i]._source === sourceId) n++;
    return n;
  }

  // ------------------------------------------------------- list: tabs & stats

  function renderSourceTabs() {
    sourceTabs.innerHTML = "";
    function add(id, label, count, disabled) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sourceTab";
      btn.setAttribute("data-source", id);
      btn.setAttribute("aria-pressed", String(state.sourceFilter === id));
      btn.disabled = !!disabled;
      btn.appendChild(document.createTextNode(label));
      if (count) {
        var c = document.createElement("span");
        c.className = "tabCount";
        c.textContent = count;
        btn.appendChild(c);
      }
      sourceTabs.appendChild(btn);
    }
    add("all", "처음", "");
    state.sources.forEach(function (s) {
      if (s.status === "active") {
        add(s.id, s.name, state.ready ? fmt(itemCount(s.id)) + (s.item_unit || "") : "");
      } else {
        add(s.id, s.name, "준비 중", true);
      }
    });
  }

  function renderStats() {
    var parts = [];
    state.sources.forEach(function (s) {
      var st = statsFor(s);
      if (s.status === "active") {
        var text = s.name + " " + fmt(itemCount(s.id)) + (s.item_unit || "건");
        if (st && st.articles) text += "·기사 " + fmt(st.articles) + "건";
        parts.push(text);
      } else if (st && st.total_articles) {
        parts.push(s.name + " 번역 준비 중(" + fmt(st.ok) + "/" + fmt(st.total_articles) + "건)");
      }
    });
    statsLine.textContent = parts.join("  ·  ");

    var lead = [];
    var articles = 0;
    state.sources.forEach(function (s) {
      if (s.status !== "active") return;
      lead.push(((s.home && s.home.short) || s.name) + " " + fmt(itemCount(s.id)) + (s.item_unit || "건"));
      var st = statsFor(s);
      if (st && st.articles) articles += st.articles;
    });
    heroLead.textContent = lead.join(", ") + (articles ? " — 기사 " + fmt(articles) + "건" : "") +
      "의 원문과 AI 번역을 한곳에서 찾고 바로 읽을 수 있습니다.";
  }

  sourceTabs.addEventListener("click", function (evt) {
    var btn = evt.target.closest(".sourceTab");
    if (!btn || btn.disabled) return;
    setFilter(btn.getAttribute("data-source"));
  });

  function setFilter(id) {
    state.sourceFilter = id;
    Array.prototype.forEach.call(sourceTabs.querySelectorAll(".sourceTab"), function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-source") === id));
    });
    syncListUrl();
    renderGrid(true);
  }

  // --------------------------------------------------- list: filter, sort, grid

  function setQuery(q) {
    state.query = q;
    state.tokens = normalize(q).split(/\s+/).filter(Boolean);
  }

  function matches(item, tokens) {
    for (var i = 0; i < tokens.length; i++) {
      if (item.haystack.indexOf(tokens[i]) === -1) return false;
    }
    return true;
  }

  function cmpKey(a, b, ka, kb) {
    var na = ka == null || ka === "", nb = kb == null || kb === "";
    if (na || nb) return na === nb ? 0 : na ? 1 : -1; // unknowns last
    if (typeof ka === "number" && typeof kb === "number") return ka - kb;
    if (typeof ka !== typeof kb) return state.sourceIndex[a._source] - state.sourceIndex[b._source];
    return collator.compare(ka, kb);
  }

  function byTitle(a, b) {
    if (a._source !== b._source) {
      var ta = a.titleKey === a.displayTitle, tb = b.titleKey === b.displayTitle;
      if (ta !== tb) return state.sourceIndex[a._source] - state.sourceIndex[b._source];
    }
    return collator.compare(a.titleKey, b.titleKey);
  }

  function byDate(a, b) {
    return cmpKey(a, b, a.dateKey, b.dateKey) || byTitle(a, b);
  }

  function compare(a, b) {
    switch (state.sort) {
      case "author": return cmpKey(a, b, a.subtitle, b.subtitle) || byDate(a, b);
      case "date": return byDate(a, b);
      case "count-desc": return (b.count || 0) - (a.count || 0) || byTitle(a, b);
      default: return byTitle(a, b) || byDate(a, b);
    }
  }

  function filteredSorted() {
    var tokens = state.tokens;
    return state.items
      .filter(function (item) {
        return (state.sourceFilter === "all" || item._source === state.sourceFilter) && matches(item, tokens);
      })
      .sort(compare);
  }

  function appendHighlighted(el, text) {
    var tokens = state.tokens;
    if (!tokens.length) { el.textContent = text; return; }
    var re = new RegExp("(" + tokens.map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|") + ")", "gi");
    String(text).split(re).forEach(function (piece, idx) {
      if (!piece) return;
      if (idx % 2 === 1) {
        var m = document.createElement("mark");
        m.textContent = piece;
        el.appendChild(m);
      } else {
        el.appendChild(document.createTextNode(piece));
      }
    });
  }

  function readerHash(item, extra) {
    var h = "#src=" + encodeURIComponent(item._source) + "&id=" + encodeURIComponent(item._id);
    Object.keys(extra || {}).forEach(function (k) { h += "&" + k + "=" + encodeURIComponent(extra[k]); });
    return h;
  }

  function metaChips(item, forReader) {
    var src = state.sourcesById[item._source] || {};
    var chips = [];
    function add(t) {
      if (t && t !== item.displayTitle && chips.indexOf(t) === -1) chips.push(t);
    }
    if (item.reign) {
      add(item.reign.king);
      add("서기 " + item.reign.ad + (forReader ? "년 · 음력" : ""));
    } else {
      add(item.subtitle || (forReader ? "저자 미상" : ""));
      add(item.date || (forReader ? "연대 미상" : ""));
    }
    if (item.count > 0 && src.fields && src.fields.count) add("기사 " + fmt(item.count) + "건");
    return chips;
  }

  function cardFor(item) {
    var src = state.sourcesById[item._source];
    var a = document.createElement("a");
    a.className = "card";
    if (src && src.reader) {
      a.href = readerHash(item);
    } else {
      a.href = item.path ? src.base_url + "/" + item.path : "#";
      a.target = "_blank";
      a.rel = "noopener";
    }

    if (state.sourceFilter === "all") {
      var badge = document.createElement("span");
      badge.className = "sourceBadge";
      badge.textContent = item._sourceName;
      a.appendChild(badge);
    }

    var title = document.createElement("span");
    title.className = "cardTitle";
    appendHighlighted(title, item.displayTitle);
    a.appendChild(title);

    if (item.title_hanja && item.title_hanja !== item.displayTitle) {
      var hanja = document.createElement("span");
      hanja.className = "cardHanja";
      hanja.lang = "lzh";
      appendHighlighted(hanja, item.title_hanja);
      a.appendChild(hanja);
    }

    var chips = metaChips(item, false);
    if (chips.length) {
      var meta = document.createElement("span");
      meta.className = "cardMeta";
      chips.forEach(function (label) {
        var chip = document.createElement("span");
        chip.className = "chip";
        chip.title = label;
        appendHighlighted(chip, label);
        meta.appendChild(chip);
      });
      a.appendChild(meta);
    }
    return a;
  }

  function renderEmpty() {
    emptyState.innerHTML = "";
    var p = document.createElement("p");
    p.textContent = state.query ? "‘" + state.query + "’에 맞는 항목이 없습니다." : "표시할 항목이 없습니다.";
    emptyState.appendChild(p);
    if (state.query && state.sourceFilter !== "all") {
      var elsewhere = state.items.filter(function (it) { return matches(it, state.tokens); }).length;
      if (elsewhere) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = "전체 출처에서 " + fmt(elsewhere) + "건 보기";
        b.addEventListener("click", function () { setFilter("all"); });
        emptyState.appendChild(b);
        return;
      }
    }
    if (state.query) {
      var clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "검색어 지우기";
      clear.addEventListener("click", function () {
        searchInput.value = "";
        setQuery("");
        syncListUrl();
        renderGrid(true);
        searchInput.focus();
      });
      emptyState.appendChild(clear);
    }
  }

  // ------------------------------------------------ reign browser (승정원일기)
  // With a reign source selected and no search text, the list becomes
  // 왕 → 재위년 → 달 → 날 instead of thousands of flat date cards.

  function browseSource() {
    var s = state.sourcesById[state.sourceFilter];
    return s && s.reign && !state.query && state.reignIndex[s.id] ? s : null;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function browseSelect(patch) {
    Object.keys(patch).forEach(function (k) { state.browse[k] = patch[k]; });
    syncListUrl();
    renderBrowser();
  }

  function eraSpanText(e) {
    return (e.base + e.firstYear) + "–" + (e.base + e.lastYear) + " · " +
      reignYearLabel(e.firstYear) + "~" + reignYearLabel(e.lastYear);
  }

  function renderBrowser() {
    var source = browseSource();
    var eras = state.reignIndex[source.id];
    var b = state.browse;
    var era = eras.filter(function (e) { return e.king === b.king; })[0] || eras[0];
    var year = era.years[b.year] || era.yearList[0];
    var month = year.months[b.month] || year.monthList[0];
    b.king = era.king; b.year = year.year; b.month = month.key;

    browser.innerHTML = "";

    // 왕대
    var kingSec = el("section", "bSection");
    kingSec.setAttribute("aria-labelledby", "bKingH");
    var kh = el("h2", "bHeading", "왕대"); kh.id = "bKingH";
    kingSec.appendChild(kh);
    var kingRow = el("div", "kingRow");
    eras.forEach(function (e, i) {
      var prev = eras[i - 1];
      if (prev && e.base + e.firstYear - (prev.base + prev.lastYear) > 5) {
        var gap = el("div", "kingGap");
        gap.appendChild(el("strong", null, (prev.base + prev.lastYear + 1) + "–" + (e.base + e.firstYear - 1)));
        gap.appendChild(el("span", null, "이 시기는 아직 자료가 없습니다"));
        kingRow.appendChild(gap);
      }
      var btn = el("button", "kingBtn");
      btn.type = "button";
      btn.setAttribute("aria-pressed", String(e === era));
      btn.appendChild(el("span", "kingName", e.king));
      btn.appendChild(el("span", "kingSub", eraSpanText(e)));
      btn.appendChild(el("span", "kingSub", fmt(e.days) + "일 · 기사 " + fmt(e.entries) + "건"));
      btn.addEventListener("click", function () { browseSelect({ king: e.king, year: null, month: null }); });
      kingRow.appendChild(btn);
    });
    kingSec.appendChild(kingRow);
    browser.appendChild(kingSec);

    // 재위 연도
    var yearSec = el("section", "bSection");
    yearSec.setAttribute("aria-labelledby", "bYearH");
    var yhRow = el("div", "bHeadRow");
    var yh = el("h2", "bHeading", era.king + " 재위 연도"); yh.id = "bYearH";
    yhRow.appendChild(yh);
    yhRow.appendChild(el("span", "bNote", "막대 높이 = 번역된 날짜 수"));
    yearSec.appendChild(yhRow);
    var chartWrap = el("div", "yearChartWrap");
    var chart = el("div", "yearChart");
    var maxDays = Math.max.apply(null, era.yearList.map(function (y) { return y.days; }));
    era.yearList.forEach(function (y) {
      var btn = el("button", "yearBtn");
      btn.type = "button";
      var on = y === year;
      btn.setAttribute("aria-pressed", String(on));
      btn.setAttribute("aria-label", era.king + " " + reignYearLabel(y.year) + ", 서기 " + (era.base + y.year) + "년, " + y.days + "일");
      btn.appendChild(el("span", "yearDays", y.days + "일"));
      var bar = el("span", "yearBar");
      bar.style.height = Math.max(4, Math.round(y.days / maxDays * 96)) + "px";
      btn.appendChild(bar);
      btn.appendChild(el("span", "yearLabel", reignYearLabel(y.year)));
      btn.appendChild(el("span", "yearAd", String(era.base + y.year)));
      btn.addEventListener("click", function () { browseSelect({ year: y.year, month: null }); });
      chart.appendChild(btn);
    });
    chartWrap.appendChild(chart);
    yearSec.appendChild(chartWrap);
    browser.appendChild(yearSec);
    requestAnimationFrame(function () {
      var sel = chart.querySelector('[aria-pressed="true"]');
      if (sel && chartWrap.scrollWidth > chartWrap.clientWidth) {
        chartWrap.scrollLeft = sel.offsetLeft - chartWrap.clientWidth / 2 + sel.offsetWidth / 2;
      }
    });

    // 달 + 날
    var cols = el("div", "bCols");
    var monthSec = el("section", "bSection bMonths");
    monthSec.setAttribute("aria-labelledby", "bMonthH");
    var mhRow = el("div", "bHeadRow");
    var mh = el("h2", "bHeading", era.king + " " + reignYearLabel(year.year) + " (" + (era.base + year.year) + ") · 달별");
    mh.id = "bMonthH";
    mhRow.appendChild(mh);
    mhRow.appendChild(el("span", "bNote", year.monthList.length + "개월 · " + fmt(year.days) + "일 · 기사 " + fmt(year.entries) + "건"));
    monthSec.appendChild(mhRow);
    if (year.days / year.monthList.length < 8) {
      monthSec.appendChild(el("p", "bHint", "이 자료는 달마다 1일·2일·그믐 같은 일부 날짜만 번역되어 있습니다. 목록에 없는 날은 자료가 없는 날입니다. 날짜는 음력입니다."));
    }
    var mgrid = el("div", "monthGrid");
    // Each month: its name previews the month's headlines on the right; each
    // date opens the reader directly (one click instead of two).
    year.monthList.forEach(function (m) {
      var tile = el("div", "monthTile" + (m === month ? " selected" : ""));
      var btn = el("button", "monthTop");
      btn.type = "button";
      btn.setAttribute("aria-pressed", String(m === month));
      btn.setAttribute("aria-label", monthLabel(m.month, m.leap) + " 기사 제목 미리보기, 기사 " + m.entries + "건");
      btn.appendChild(el("span", "monthName", monthLabel(m.month, m.leap)));
      btn.appendChild(el("span", "monthCount", "기사 " + m.entries));
      btn.addEventListener("click", function () {
        browseSelect({ month: m.key });
        var target = $("bDayH");
        if (target && window.matchMedia("(max-width: 900px)").matches) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      tile.appendChild(btn);
      var pills = el("span", "monthDays");
      m.items.forEach(function (it) {
        var a = el("a", "dayPill", (it.reign.day ? it.reign.day + "일" : "미상") + " " + it.count + "건");
        a.href = readerHash(it);
        a.setAttribute("aria-label", it.displayTitle + " 읽기, 기사 " + it.count + "건");
        pills.appendChild(a);
      });
      tile.appendChild(pills);
      mgrid.appendChild(tile);
    });
    monthSec.appendChild(mgrid);
    cols.appendChild(monthSec);

    var daySec = el("section", "bSection bDays");
    daySec.setAttribute("aria-labelledby", "bDayH");
    var dhRow = el("div", "bHeadRow");
    var dh = el("h2", "bHeading", monthLabel(month.month, month.leap) + "의 날짜");
    dh.id = "bDayH";
    dhRow.appendChild(dh);
    var sortGroup = el("div", "segmented");
    sortGroup.setAttribute("role", "group");
    sortGroup.setAttribute("aria-label", "날짜 정렬");
    [["date", "날짜순"], ["count", "기사 많은 순"]].forEach(function (opt) {
      var sb = el("button", null, opt[1]);
      sb.type = "button";
      sb.setAttribute("aria-pressed", String(b.daySort === opt[0]));
      sb.addEventListener("click", function () { browseSelect({ daySort: opt[0] }); });
      sortGroup.appendChild(sb);
    });
    dhRow.appendChild(sortGroup);
    daySec.appendChild(dhRow);

    var days = month.items.slice();
    if (b.daySort === "count") days.sort(function (x, y) { return y.count - x.count || collator.compare(x._id, y._id); });
    var lastDay = Math.max.apply(null, month.items.map(function (it) { return it.reign.day; }));
    days.forEach(function (it) {
      var card = el("a", "dayCard");
      card.href = readerHash(it);
      var top = el("span", "dayTop");
      top.appendChild(el("span", "dayDate", monthLabel(month.month, month.leap) + " " + (it.reign.day ? it.reign.day + "일" : "날짜 미상")));
      top.appendChild(el("span", "dayMeta", (it.reign.day >= 29 && it.reign.day === lastDay ? "그믐 · " : "") + "기사 " + it.count + "건"));
      top.appendChild(el("span", "dayGo", "읽기 →"));
      card.appendChild(top);
      var head = el("span", "dayHeadline", "…");
      head.lang = "ko";
      card.appendChild(head);
      var routine = el("span", "dayRoutine");
      card.appendChild(routine);
      daySec.appendChild(card);
      loadDayHeadline(source, it, head, routine);
    });
    cols.appendChild(daySec);
    browser.appendChild(cols);
  }

  function routineRe(source) {
    var p = source.reign && source.reign.routine_pattern;
    return p ? new RegExp(p) : null;
  }

  function isUntitled(heading) {
    return /^[A-Z]+-[A-Z0-9^_-]{8,}$/.test(heading.trim());
  }

  // The index has no article titles, so read the day file (cached) and show
  // its first non-routine heading.
  function loadDayHeadline(source, item, headEl, routineEl) {
    var re = routineRe(source);
    fetchTextCached(source.base_url + "/" + item.path).then(function (text) {
      var heads = (text.match(/^## .+$/gm) || []).map(function (h) { return h.slice(3).trim(); });
      var routine = re ? heads.filter(function (h) { return re.test(h); }) : [];
      var main = heads.filter(function (h) { return !(re && re.test(h)); });
      var first = main[0] && main[0].replace(/^\(제목 없음\)\s*/, "");
      if (!first) headEl.textContent = routine[0] || "기사 제목 없음";
      else headEl.textContent = isUntitled(first) ? "제목 없는 기사" + (main.length > 1 ? " 외 " + (main.length - 1) + "건" : "") : first + (main.length > 1 ? " 외 " + (main.length - 1) + "건" : "");
      routineEl.textContent = routine.length && first ? "반복 기록: " + routine[0] : "";
    }, function () {
      headEl.textContent = "제목을 불러오지 못했습니다";
    });
  }

  // ------------------------------------------------------------- home page
  // "처음" (no source, no search): hero search, one card per source and a
  // short list of the books with the most articles.

  function isHome() {
    return state.sourceFilter === "all" && !state.query;
  }

  function renderHome() {
    homeEl.innerHTML = "";

    var srcSec = el("section", "homeSection");
    srcSec.setAttribute("aria-labelledby", "homeSrcH");
    var sh = el("h2", "homeHeading", "출처별로 둘러보기");
    sh.id = "homeSrcH";
    srcSec.appendChild(sh);
    var cards = el("div", "srcCards");
    state.sources.forEach(function (s) {
      var home = s.home || {};
      var st = statsFor(s);
      if (s.status !== "active") {
        var pending = el("div", "srcCard pending");
        pending.appendChild(el("span", "srcEyebrow", s.description || s.name));
        pending.appendChild(el("span", "srcTitle", s.name + " · 번역 준비 중"));
        if (st && st.total_articles) {
          pending.appendChild(el("span", "srcBlurb", fmt(st.ok) + " / " + fmt(st.total_articles) + "건 번역됨"));
          var track = el("span", "progress");
          track.setAttribute("role", "img");
          var pct = Math.round((st.ok || 0) / st.total_articles * 100);
          track.setAttribute("aria-label", "진행률 " + pct + "퍼센트");
          var fill = el("span", "progressFill");
          fill.style.width = pct + "%";
          track.appendChild(fill);
          pending.appendChild(track);
        }
        pending.appendChild(el("span", "srcBlurb", "번역이 끝나는 대로 이곳에서 찾아 읽을 수 있습니다."));
        cards.appendChild(pending);
        return;
      }
      // The whole card is clickable through the title link (stretched with
      // ::after); 왕대 links sit above it so they can go one level deeper.
      var a = el("div", "srcCard linked");
      a.appendChild(el("span", "srcEyebrow", s.name));
      var titleLink = el("a", "srcTitle srcLink", home.title || s.name);
      titleLink.href = "?src=" + encodeURIComponent(s.id);
      titleLink.setAttribute("data-nav", "list");
      a.appendChild(titleLink);
      var nums = el("span", "srcNums");
      function num(v, label) {
        var n = el("span", "srcNum");
        n.appendChild(el("span", "srcNumV", v));
        n.appendChild(el("span", "srcNumL", label));
        nums.appendChild(n);
      }
      num(fmt(itemCount(s.id)), s.item_unit || "건");
      if (st && st.articles) num(fmt(st.articles), "기사");
      a.appendChild(nums);
      var eras = state.reignIndex[s.id];
      if (eras) {
        var bar = el("span", "eraBar");
        bar.setAttribute("aria-hidden", "true");
        eras.forEach(function (e) {
          var seg = el("span", "eraSeg");
          seg.style.flexGrow = e.days;
          seg.title = e.king;
          bar.appendChild(seg);
        });
        a.appendChild(bar);
        var kings = el("span", "srcKings");
        eras.forEach(function (e) {
          var k = el("a", "srcKing", e.king);
          k.href = "?src=" + encodeURIComponent(s.id) + "&king=" + encodeURIComponent(e.king);
          k.setAttribute("data-nav", "list");
          kings.appendChild(k);
        });
        a.appendChild(kings);
      }
      if (home.blurb) a.appendChild(el("span", "srcBlurb", home.blurb));
      a.appendChild(el("span", "srcCta", (home.cta || "둘러보기") + " →"));
      cards.appendChild(a);
    });
    srcSec.appendChild(cards);
    homeEl.appendChild(srcSec);

    // Featured list for each table-layout source
    state.sources.forEach(function (s) {
      if (s.status !== "active" || s.list_layout !== "table") return;
      var items = state.items.filter(function (it) { return it._source === s.id; })
        .sort(function (x, y) { return y.count - x.count || byTitle(x, y); })
        .slice(0, 8);
      if (!items.length) return;
      var sec = el("section", "homeSection");
      sec.setAttribute("aria-labelledby", "homeTop-" + s.id);
      var row = el("div", "bHeadRow");
      var h = el("h2", "homeHeading", ((s.home && s.home.short) || s.name) + " · 기사가 많은 책");
      h.id = "homeTop-" + s.id;
      row.appendChild(h);
      row.appendChild(el("span", "bNote", fmt(itemCount(s.id)) + (s.item_unit || "건") + " 중 " + items.length + (s.item_unit || "건")));
      sec.appendChild(row);
      var table = el("div", "grid asTable");
      table.appendChild(tableHead());
      items.forEach(function (it) { table.appendChild(rowFor(it)); });
      sec.appendChild(table);
      var more = el("a", "moreLink", ((s.home && s.home.short) || s.name) + " " + fmt(itemCount(s.id)) + (s.item_unit || "건") + " 모두 보기 →");
      more.href = "?src=" + encodeURIComponent(s.id);
      more.setAttribute("data-nav", "list");
      sec.appendChild(more);
      homeEl.appendChild(sec);
    });
  }

  function tableHead() {
    var h = el("div", "bookHead");
    h.setAttribute("aria-hidden", "true");
    ["제목", "저자·편자", "연도", "기사"].forEach(function (t) { h.appendChild(el("span", null, t)); });
    return h;
  }

  function rowFor(item) {
    var a = el("a", "bookRow");
    a.href = readerHash(item);
    var t = el("span", "rTitle");
    var ko = el("span", "rKo");
    appendHighlighted(ko, item.displayTitle);
    t.appendChild(ko);
    if (item.title_hanja && item.title_hanja !== item.displayTitle) {
      var hj = el("span", "rHanja");
      hj.lang = "lzh";
      appendHighlighted(hj, item.title_hanja);
      t.appendChild(hj);
    }
    a.appendChild(t);
    var au = el("span", "rAuthor");
    appendHighlighted(au, item.subtitle || "미상");
    a.appendChild(au);
    var yr = el("span", "rYear");
    if (typeof item.dateKey === "number") {
      yr.appendChild(el("strong", null, String(item.dateKey)));
      var raw = item.date !== String(item.dateKey) ? item.date : "";
      if (raw) {
        var rs = el("span", "rEra");
        rs.lang = "lzh";
        appendHighlighted(rs, raw);
        yr.appendChild(rs);
      }
    } else {
      yr.appendChild(el("span", "rEra", item.date && !/미상|未詳/.test(item.date) ? item.date : "연대 미상"));
    }
    a.appendChild(yr);
    a.appendChild(el("span", "rCount", item.count ? "기사 " + fmt(item.count) : ""));
    return a;
  }

  function renderGrid(reset) {
    var home = isHome();
    document.body.classList.toggle("home", home);
    homeEl.hidden = !home;
    if (home) {
      browser.hidden = true;
      grid.hidden = true;
      emptyState.hidden = true;
      grid.removeAttribute("aria-busy");
      state.filtered = [];
      resultCount.textContent = "";
      renderHome();
      return;
    }
    var bsrc = browseSource();
    browser.hidden = !bsrc;
    grid.hidden = !!bsrc;
    sortLabel.hidden = !!bsrc;
    if (bsrc) {
      grid.removeAttribute("aria-busy");
      emptyState.hidden = true;
      state.filtered = [];
      resultCount.textContent = fmt(itemCount(bsrc.id)) + (bsrc.item_unit || "건");
      renderBrowser();
      return;
    }
    var curSrc = state.sourcesById[state.sourceFilter];
    var asTable = !!(curSrc && curSrc.list_layout === "table");
    grid.classList.toggle("asTable", asTable);
    if (reset) {
      state.filtered = filteredSorted();
      state.shown = 0;
      grid.innerHTML = "";
      if (asTable && state.filtered.length) grid.appendChild(tableHead());
    }
    var items = state.filtered;
    var next = items.slice(state.shown, state.shown + PAGE_SIZE);
    var frag = document.createDocumentFragment();
    next.forEach(function (item) { frag.appendChild(asTable ? rowFor(item) : cardFor(item)); });
    grid.appendChild(frag);
    state.shown += next.length;
    grid.removeAttribute("aria-busy");

    resultCount.textContent = state.query || state.sourceFilter !== "all"
      ? fmt(items.length) + "건 찾음"
      : fmt(items.length) + "건";
    emptyState.hidden = items.length !== 0;
    if (!items.length) renderEmpty();
    if (reset) requestAnimationFrame(loadMoreIfNeeded);
  }

  function loadMoreIfNeeded() {
    if (state.reading || state.shown >= state.filtered.length) return;
    if (sentinel.getBoundingClientRect().top < window.innerHeight + 1200) {
      renderGrid(false);
      requestAnimationFrame(loadMoreIfNeeded);
    }
  }

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) loadMoreIfNeeded();
    }, { rootMargin: "0px 0px 1200px 0px" }).observe(sentinel);
  }
  window.addEventListener("scroll", function () {
    loadMoreIfNeeded();
    controls.classList.toggle("stuck", controls.getBoundingClientRect().top <= 0 && window.scrollY > 0);
  }, { passive: true });
  window.addEventListener("resize", loadMoreIfNeeded);

  // List state lives in the query string (?q=&src=&sort=) so searches can be
  // shared and survive reloads; the reader uses the hash.
  function readListUrl() {
    var p = new URLSearchParams(location.search);
    setQuery(p.get("q") || "");
    searchInput.value = state.query;
    var src = p.get("src");
    state.sourceFilter = src && state.sourcesById[src] && state.sourcesById[src].status === "active" ? src : "all";
    var sort = p.get("sort");
    state.sort = sort && sortSelect.querySelector('option[value="' + sort + '"]') ? sort : "title";
    sortSelect.value = state.sort;
    var y = p.get("y");
    state.browse = {
      king: p.get("king"),
      year: y === null || y === "" ? null : (y === "즉위년" ? 0 : parseInt(y, 10)),
      month: p.get("m"),
      daySort: p.get("dsort") === "count" ? "count" : "date",
    };
  }

  function syncListUrl() {
    var p = new URLSearchParams();
    if (state.query) p.set("q", state.query);
    if (state.sourceFilter !== "all") p.set("src", state.sourceFilter);
    if (state.sort !== "title") p.set("sort", state.sort);
    if (browseSource() && state.browse.king) {
      p.set("king", state.browse.king);
      if (state.browse.year != null) p.set("y", state.browse.year);
      if (state.browse.month) p.set("m", state.browse.month);
      if (state.browse.daySort === "count") p.set("dsort", "count");
    }
    var qs = p.toString();
    history.replaceState(history.state, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    lastListSearch = location.search;
  }

  var searchTimer = null;
  searchInput.addEventListener("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      setQuery(searchInput.value.trim());
      syncListUrl();
      renderGrid(true);
    }, 150);
  });

  sortSelect.addEventListener("change", function () {
    state.sort = sortSelect.value;
    syncListUrl();
    renderGrid(true);
  });

  // ------------------------------------------------------------------ reader
  // Fetches the item's markdown from its own source repo (cross-origin) and
  // renders it here instead of linking out.

  function bookDir(path) {
    return path.replace(/\/README\.md$/, "");
  }

  // Links inside fetched .md content are relative to the item's directory in
  // the source repo. haje.md / part-NNN.md go to the in-app reader; anything
  // else resolves against the source repo.
  function rewriteContentLinks(container, source, item) {
    var anchors = container.querySelectorAll("a[href]");
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var href = a.getAttribute("href");
      if (!href || /^([a-z]+:)?\/\//i.test(href) || href.charAt(0) === "#") continue;
      if (/^haje\.md$/.test(href)) { a.href = readerHash(item, { view: "haje" }); continue; }
      var partMatch = href.match(/^part-0*(\d+)\.md$/);
      if (partMatch) { a.href = readerHash(item, { part: parseInt(partMatch[1], 10) }); continue; }
      a.href = source.base_url + "/" + bookDir(item.path) + "/" + href;
      a.target = "_blank";
      a.rel = "noopener";
    }
  }

  function listHref(params) {
    var p = new URLSearchParams();
    Object.keys(params).forEach(function (k) { if (params[k] != null) p.set(k, params[k]); });
    return location.pathname + "?" + p.toString();
  }

  function reignListParams(item, depth) {
    var r = item.reign;
    var p = { src: item._source };
    if (depth >= 1) p.king = r.king;
    if (depth >= 2) p.y = r.year;
    if (depth >= 3) p.m = monthKey(r.month, r.leap);
    return p;
  }

  function renderCrumbs(item) {
    readerCrumbs.innerHTML = "";
    if (!item.reign) { readerCrumbs.hidden = true; return; }
    var r = item.reign;
    var parts = [
      [item._sourceName, 0],
      [r.king, 1],
      [reignYearLabel(r.year) + " (" + r.ad + ")", 2],
      [monthLabel(r.month, r.leap), 3],
    ];
    parts.forEach(function (pt) {
      var a = el("a", null, pt[0]);
      a.href = listHref(reignListParams(item, pt[1]));
      a.setAttribute("data-nav", "list");
      readerCrumbs.appendChild(a);
      readerCrumbs.appendChild(el("span", "crumbSep", "›")).setAttribute("aria-hidden", "true");
    });
    var cur = el("span", null, r.day ? r.day + "일" : "날짜 미상");
    cur.setAttribute("aria-current", "page");
    readerCrumbs.appendChild(cur);
    readerCrumbs.hidden = false;
  }

  function renderReaderHeader(item, subtitle) {
    renderCrumbs(item);
    var chips = metaChips(item, true);
    readerHeader.innerHTML =
      '<span class="sourceBadge">' + escapeHtml(item._sourceName) + "</span>" +
      '<h2 class="readerTitle" id="readerTitle" tabindex="-1">' + escapeHtml(item.displayTitle) + "</h2>" +
      (item.title_hanja && item.title_hanja !== item.displayTitle
        ? '<p class="readerHanja" lang="lzh">' + escapeHtml(item.title_hanja) + "</p>"
        : "") +
      '<div class="cardMeta">' +
      chips.map(function (t) { return '<span class="chip">' + escapeHtml(t) + "</span>"; }).join("") +
      "</div>" +
      '<p class="aiNote">한글 번역·독음·풀이는 AI가 만든 기계 번역입니다. 인용할 때는 원문과 원 출처를 확인하세요.</p>';
    document.title = item.displayTitle + (subtitle ? " · " + subtitle : "") + " — " + SITE_TITLE;
  }

  function tabLink(label, href, active) {
    var a = document.createElement("a");
    a.className = "tab";
    a.href = href;
    a.textContent = label;
    if (active) a.setAttribute("aria-current", "page");
    return a;
  }

  function pagerLink(label, href, rel) {
    var a = document.createElement("a");
    a.className = "pagerBtn";
    a.textContent = label;
    if (href) {
      a.href = href;
      a.rel = rel;
    } else {
      a.setAttribute("aria-disabled", "true");
    }
    return a;
  }

  function setPager(prev, next) {
    readerPager.innerHTML = "";
    if (!prev && !next) { readerPager.hidden = true; return; }
    readerPager.appendChild(pagerLink(prev ? "← " + prev.label : "", prev && prev.href, "prev"));
    readerPager.appendChild(pagerLink(next ? next.label + " →" : "", next && next.href, "next"));
    readerPager.hidden = false;
  }

  // ---- Entry structuring ---------------------------------------------------
  // Regroup the generated markdown (## 기사 → ### 한글 번역/독음/의미/원문 …)
  // into one block per article with 원문 and 번역 side by side. Works on a
  // freshly rendered container and can be called again for later 묶음, so a
  // book reads as one continuous page. `ctx` carries numbering across calls.
  var KNOWN_SECTIONS = { "한글 번역": 1, "독음": 1, "의미": 1, "원문": 1 };

  function newEntryCtx(source, item) {
    var vols = item && item.row && Number(item.row.volume_count) > 1;
    return { source: source, seq: 0, no: 0, lastVol: null, multiVol: !!vols, toc: [] };
  }

  function volLabel(v) {
    var m = String(v).match(/v(\d+)\]?\s*$/);
    return m ? "제" + parseInt(m[1], 10) + "책" : String(v);
  }

  function metaMap(details) {
    var map = {};
    if (!details) return map;
    Array.prototype.forEach.call(details.querySelectorAll(".metaList li"), function (li) {
      var k = li.querySelector(".metaKey"), v = li.querySelector(".metaVal");
      if (k && v) map[k.textContent.trim()] = v;
    });
    return map;
  }

  function snippetOf(nodes) {
    var t = (nodes || []).map(function (n) { return n.textContent; }).join(" ").replace(/\s+/g, " ").trim();
    return t.length > 46 ? t.slice(0, 46) + "…" : t;
  }

  // Returns { intro: [nodes before the first article], entries: [nodes], toc: [...] }
  // or null when the page has no articles.
  function structureEntries(container, ctx) {
    var source = ctx.source;
    var nodes = Array.prototype.slice.call(container.children);
    var intro = [];
    var groups = [];
    var cur = null;
    nodes.forEach(function (n) {
      if (n.tagName === "H2") { cur = { h: n, parts: [] }; groups.push(cur); }
      else if (n.tagName === "HR") { /* entries draw their own dividers */ }
      else if (cur) cur.parts.push(n);
      else intro.push(n);
    });
    var hasArticles = groups.some(function (g) {
      return g.parts.some(function (p) { return p.tagName === "H3" && /^(원문|한글 번역)$/.test(p.textContent.trim()); });
    });
    if (!hasArticles) return null;

    var re = routineRe(source);
    var out = [];
    var toc = [];

    function block(cls, label, list, lang) {
      var d = el("div", cls);
      if (lang) d.lang = lang;
      var l = el("span", "entryLabel", label);
      l.lang = "ko";
      d.appendChild(l);
      (list || []).forEach(function (n) { d.appendChild(n); });
      return d;
    }

    groups.forEach(function (g) {
      var sec = {};
      var order = [];
      var tail = [];
      var meta = null;
      var name = null;
      g.parts.forEach(function (p) {
        if (p.tagName === "H3") { name = p.textContent.trim(); sec[name] = []; order.push(name); return; }
        if (p.tagName === "DETAILS" && !name && !meta) { meta = p; return; }
        if (p.tagName === "DETAILS") { tail.push(p); name = null; return; }
        if (name) sec[name].push(p); else tail.push(p);
      });
      var info = metaMap(meta);
      var rawTitle = g.h.textContent.trim();
      var untitled = isUntitled(rawTitle);
      var title = untitled ? "제목 없는 기사" : rawTitle;
      var routine = !!(re && re.test(rawTitle));
      var id = "entry-" + (++ctx.seq);

      if (ctx.multiVol && info["권책"]) {
        var vol = info["권책"].textContent.trim();
        if (vol !== ctx.lastVol) {
          ctx.lastVol = vol;
          var vh = el("h2", "volHead", volLabel(vol));
          vh.id = "vol-" + ctx.seq;
          out.push(vh);
          toc.push({ vol: true, id: vh.id, title: volLabel(vol) });
        }
      }

      var entry;
      if (routine) {
        entry = el("details", "entry routine");
        var sum = el("summary");
        sum.appendChild(el("span", "routineTag", "반복 기록"));
        sum.appendChild(el("span", "entryTitleInline", title));
        entry.appendChild(sum);
        (sec["한글 번역"] || []).forEach(function (n) { entry.appendChild(n); });
        if (sec["원문"]) entry.appendChild(block("han", "원문", sec["원문"], "lzh"));
      } else {
        ctx.no++;
        entry = el("section", "entry");
        var head = el("header", "entryHead");
        var no = el("span", "entryNo", "기사 " + ctx.no);
        if (info["면/쪽"]) no.appendChild(el("span", "entryPage", " · " + info["면/쪽"].textContent.trim() + "면"));
        head.appendChild(no);
        var h = el("h2", "entryTitle" + (untitled ? " untitled" : ""));
        var derived = title.match(/^\(제목 없음\)\s*(.*)$/);
        if (derived) {
          // The data marks titles made from the translation's first line.
          h.appendChild(el("span", "noTitle", "제목 없음"));
          h.appendChild(document.createTextNode(" " + derived[1]));
        } else {
          h.textContent = title;
        }
        h.tabIndex = -1;
        head.appendChild(h);
        entry.appendChild(head);
        var pair = el("div", "pair");
        if (sec["원문"]) pair.appendChild(block("han", "원문", sec["원문"], "lzh"));
        if (sec["한글 번역"]) pair.appendChild(block("ko", "한글 번역", sec["한글 번역"]));
        entry.appendChild(pair);
        if (sec["독음"]) entry.appendChild(block("reading", "독음", sec["독음"]));
        if (sec["의미"]) {
          var gloss = el("details", "gloss");
          gloss.appendChild(el("summary", null, "풀이 보기"));
          sec["의미"].forEach(function (n) { gloss.appendChild(n); });
          entry.appendChild(gloss);
        }
        order.forEach(function (nm) {
          if (KNOWN_SECTIONS[nm]) return;
          entry.appendChild(block("extra", nm, sec[nm]));
        });
        var foot = el("div", "entryFoot");
        var srcA = info["출처"] && info["출처"].querySelector("a");
        if (srcA) {
          var link = el("a", "entrySrc", "원 출처에서 보기 ↗");
          link.href = srcA.href;
          link.target = "_blank";
          link.rel = "noopener";
          foot.appendChild(link);
        }
        tail.forEach(function (n) { foot.appendChild(n); });
        if (meta) foot.appendChild(meta);
        entry.appendChild(foot);
      }
      entry.id = id;
      out.push(entry);
      toc.push({ id: id, title: title, routine: routine, no: routine ? null : ctx.no, snippet: routine ? "" : snippetOf(sec["한글 번역"]) });
    });
    ctx.toc = ctx.toc.concat(toc);
    return { intro: intro, entries: out, toc: toc };
  }

  function resetReaderExtras() {
    readerToc.hidden = true;
    readerToc.innerHTML = "";
    readerTools.hidden = true;
    readerBody.classList.remove("hasToc");
    readerView.classList.remove("wide");
    readerContent.classList.remove("structured");
  }

  function setSourceLine(links) {
    readerSource.innerHTML = "";
    if (!links.length) return;
    readerSource.appendChild(document.createTextNode("원본 파일: "));
    links.forEach(function (l, i) {
      if (i) readerSource.appendChild(document.createTextNode(" · "));
      var a = el("a", null, l[0]);
      a.href = l[1];
      a.target = "_blank";
      a.rel = "noopener";
      readerSource.appendChild(a);
    });
  }

  function renderMdInto(text, source, item) {
    var tmp = document.createElement("div");
    tmp.innerHTML = renderMarkdown(text, { dropTitle: true });
    rewriteContentLinks(tmp, source, item);
    return tmp;
  }

  // Single-page sources (승정원일기 days).
  function showContent(url, text, source, item) {
    resetReaderExtras();
    var tmp = renderMdInto(text, source, item);
    var ctx = newEntryCtx(source, item);
    var res = structureEntries(tmp, ctx);
    readerContent.innerHTML = "";
    if (res) {
      readerContent.classList.add("structured");
      res.entries.forEach(function (n) { readerContent.appendChild(n); });
      readerTools.hidden = false;
      applyView();
      renderToc(ctx, source);
    } else {
      while (tmp.firstChild) readerContent.appendChild(tmp.firstChild);
    }
    setSourceLine([["이 날짜 파일", url]]);
  }

  function renderToc(ctx, source) {
    readerToc.innerHTML = "";
    var toc = ctx.toc;
    var articles = toc.filter(function (t) { return !t.routine && !t.vol; }).length;
    if (articles + toc.filter(function (t) { return t.routine; }).length < 2) {
      readerToc.hidden = true;
      readerBody.classList.remove("hasToc");
      return;
    }
    var label = source.reign ? "이 날의 기사 " + articles + "건" : "기사 목록 " + articles + "건" + (ctx.more ? " (읽은 곳까지)" : "");
    readerToc.appendChild(el("summary", null, label));
    var list = el("ol", "tocList");
    toc.forEach(function (t) {
      var li = el("li", t.vol ? "tocVol" : t.routine ? "tocRoutine" : null);
      var b = el("button", null);
      b.type = "button";
      if (t.vol) {
        b.appendChild(el("span", "tocTitle", t.title));
      } else {
        b.appendChild(el("span", "tocNo", t.routine ? "반복 기록" : "기사 " + t.no));
        b.appendChild(el("span", "tocTitle", t.title));
        if (t.snippet) b.appendChild(el("span", "tocSnippet", t.snippet));
      }
      b.addEventListener("click", function () {
        var target = $(t.id);
        if (!target) return;
        if (target.tagName === "DETAILS") target.open = true;
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        var h = target.querySelector(".entryTitle");
        if (h) h.focus({ preventScroll: true });
        if (!window.matchMedia("(min-width: 1000px)").matches) readerToc.open = false;
      });
      li.appendChild(b);
      list.appendChild(li);
    });
    readerToc.appendChild(list);
    readerToc.open = window.matchMedia("(min-width: 1000px)").matches;
    readerToc.hidden = false;
    readerBody.classList.add("hasToc");
    readerView.classList.add("wide");
  }

  function applyView() {
    readerContent.classList.remove("view-both", "view-ko", "view-han");
    readerContent.classList.add("view-" + state.view);
    Array.prototype.forEach.call(readerTools.querySelectorAll("[data-view]"), function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-view") === state.view));
    });
  }

  readerTools.addEventListener("click", function (e) {
    var b = e.target.closest("[data-view]");
    if (!b) return;
    state.view = b.getAttribute("data-view");
    try { localStorage.setItem("kch.view", state.view); } catch (err) { /* ignore */ }
    applyView();
  });

  function showLoadError(retry) {
    readerContent.innerHTML = '<p class="loading">내용을 불러오지 못했습니다. <button type="button" class="pagerBtn">다시 시도</button></p>';
    readerContent.querySelector("button").addEventListener("click", retry);
  }

  // ---- Books: one page --------------------------------------------------------
  // Opening a book shows its body right away: 자료 정보 and 해제 sit folded on
  // top, the chosen 묶음 (default 1) follows, and "다음 묶음 이어 읽기"
  // appends the next one in place. #…&part=N starts at N; &view=haje opens
  // the 해제.

  // README "- 키: 값" lines before the first "##" -> 자료 정보
  function bookInfoNode(readmeText, source, item) {
    if (!readmeText) return null;
    var head = readmeText.split(/\n## /)[0];
    var lines = head.split("\n").filter(function (l) { return /^- /.test(l) && !/^- (순번|한자 제목):/.test(l); });
    if (!lines.length) return null;
    var d = el("details", "bookInfo");
    d.appendChild(el("summary", null, "자료 정보"));
    var tmp = renderMdInto(lines.join("\n"), source, item);
    while (tmp.firstChild) d.appendChild(tmp.firstChild);
    return d;
  }

  // 해제 is the archive's own (non-AI) commentary, split by 【정의】【서지사항】….
  function hajeNode(text) {
    if (!text) return null;
    var body = text.replace(/\r\n/g, "\n")
      .replace(/^# .*\n/, "")
      .replace(/^- [^\n]*\n/gm, "")
      .replace(/^G\d+\+[A-Z0-9_^-]+\s*$/gm, "")
      .trim();
    if (!body || /요약 해설만 작성/.test(body) && body.length < 80) return null;
    var sections = [];
    var curSec = { name: "", lines: [] };
    body.split("\n").forEach(function (line) {
      var parts = line.split(/(【[^】]+】)/);
      parts.forEach(function (p) {
        var m = p.match(/^【([^】]+)】$/);
        if (m) { if (curSec.name || curSec.lines.length) sections.push(curSec); curSec = { name: m[1].trim(), lines: [] }; }
        else if (p.trim()) curSec.lines.push(p.trim());
      });
    });
    if (curSec.name || curSec.lines.length) sections.push(curSec);
    if (!sections.length) return null;

    var wrap = el("section", "haje");
    wrap.id = "haje";
    wrap.setAttribute("aria-labelledby", "hajeH");
    var hh = el("h2", "hajeHead", "해제");
    hh.id = "hajeH";
    hh.tabIndex = -1;
    wrap.appendChild(hh);
    var lead = sections.filter(function (s) { return s.name === "정의"; })[0] || sections[0];
    var leadP = el("p", "hajeLead", lead.lines.join(" "));
    wrap.appendChild(leadP);
    var rest = sections.filter(function (s) { return s !== lead; });
    if (rest.length) {
      var det = el("details", "hajeMore");
      det.appendChild(el("summary", null, "해제 전체 보기 · " + rest.map(function (s) { return s.name || "본문"; }).join(" · ")));
      rest.forEach(function (s) {
        if (s.name) det.appendChild(el("h3", null, s.name));
        s.lines.forEach(function (l) { det.appendChild(el("p", null, l)); });
      });
      wrap.appendChild(det);
    }
    wrap.appendChild(el("p", "hajeNote", "해제는 한국학중앙연구원이 작성한 원문 그대로입니다(AI 번역 아님)."));
    return wrap;
  }

  function renderBookItem(source, item, kind, partNo, token) {
    var parts = state.partsByBook[source.id + ":" + item._id] || [];
    var dir = source.base_url + "/" + bookDir(item.path);
    var startIdx = 0;
    if (kind === "part") {
      var found = parts.map(function (p) { return p.part; }).indexOf(partNo);
      if (found >= 0) startIdx = found;
    }

    renderReaderHeader(item, startIdx > 0 ? "묶음 " + parts[startIdx].part : "");
    readerContent.innerHTML = '<p class="loading">불러오는 중…</p>';
    readerSource.innerHTML = "";
    setPager(null, null);
    partTabs.innerHTML = "";

    // 묶음 navigation only when there is more than one
    if (parts.length > 1 && parts.length <= PART_TABS_MAX) {
      parts.forEach(function (p, i) {
        partTabs.appendChild(tabLink("묶음 " + p.part, readerHash(item, i ? { part: p.part } : {}), i === startIdx));
      });
    } else if (parts.length > PART_TABS_MAX) {
      var sel = document.createElement("select");
      sel.className = "partSelect active";
      sel.setAttribute("aria-label", "본문 묶음으로 바로 가기 (전체 " + parts.length + "개)");
      parts.forEach(function (p, i) {
        var o = document.createElement("option");
        o.value = p.part;
        o.textContent = "묶음 " + p.part + " / " + parts.length + (p.article_count ? " · 기사 " + p.article_count + "건" : "");
        if (i === startIdx) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function () {
        location.hash = readerHash(item, sel.selectedIndex ? { part: sel.value } : {});
      });
      partTabs.appendChild(sel);
    }

    var readmeUrl = source.base_url + "/" + item.path;
    var hajeUrl = dir + "/haje.md";
    function opt(p) { return p.then(function (t) { return t; }, function () { return ""; }); }

    var load = function () {
      readerContent.innerHTML = '<p class="loading">불러오는 중…</p>';
      var partUrl = parts.length ? source.base_url + "/" + parts[startIdx].path : null;
      Promise.all([
        opt(fetchTextCached(readmeUrl)),
        opt(fetchTextCached(hajeUrl)),
        partUrl ? fetchTextCached(partUrl) : Promise.resolve(""),
      ]).then(function (res) {
        if (token !== state.renderToken) return;
        resetReaderExtras();
        readerContent.innerHTML = "";
        var top = el("div", "bookTop");
        var info = bookInfoNode(res[0], source, item);
        if (info) top.appendChild(info);
        var haje = hajeNode(res[1]);
        if (haje) top.appendChild(haje);
        if (top.childNodes.length) readerContent.appendChild(top);

        var ctx = newEntryCtx(source, item);
        // Number articles by their place in the whole book, even when starting at a later 묶음.
        for (var pi = 0; pi < startIdx; pi++) ctx.no += Number(parts[pi].article_count) || 0;
        var bodyWrap = el("div", "bookBody");
        readerContent.appendChild(bodyWrap);
        var links = [["책 소개", readmeUrl]];
        if (haje) links.push(["해제", hajeUrl]);

        function appendPart(idx, text) {
          var r = structureEntries(renderMdInto(text, source, item), ctx);
          if (r) r.entries.forEach(function (n) { bodyWrap.appendChild(n); });
          links.push(["묶음 " + parts[idx].part, source.base_url + "/" + parts[idx].path]);
          setSourceLine(links);
        }

        if (partUrl) {
          appendPart(startIdx, res[2]);
          readerContent.classList.add("structured");
          readerTools.hidden = false;
          applyView();
        } else {
          // No 묶음 index: fall back to the README itself.
          var tmp = renderMdInto(res[0] || "", source, item);
          while (tmp.firstChild) readerContent.appendChild(tmp.firstChild);
          setSourceLine(links);
        }

        var moreBox = el("div", "moreBox");
        readerContent.appendChild(moreBox);
        var nextIdx = startIdx + 1;
        function renderMore() {
          moreBox.innerHTML = "";
          if (!parts.length) return;
          if (nextIdx >= parts.length) {
            moreBox.appendChild(el("p", "moreEnd", parts.length > 1 ? "이 책의 마지막 묶음입니다." : "이 책의 공개 번역은 여기까지입니다."));
            return;
          }
          var p = parts[nextIdx];
          var btn = el("button", "moreBtn");
          btn.type = "button";
          btn.appendChild(el("span", null, "다음 묶음 이어 읽기"));
          btn.appendChild(el("span", "moreSub", "묶음 " + p.part + " / " + parts.length + (p.article_count ? " · 기사 " + p.article_count + "건" : "")));
          btn.addEventListener("click", function () {
            btn.disabled = true;
            btn.firstChild.textContent = "불러오는 중…";
            fetchTextCached(source.base_url + "/" + p.path).then(function (text) {
              if (token !== state.renderToken) return;
              var firstNew = ctx.seq + 1;
              appendPart(nextIdx, text);
              nextIdx++;
              ctx.more = true;
              renderToc(ctx, source);
              renderMore();
              var target = $("entry-" + firstNew);
              var h = target && target.querySelector(".entryTitle");
              if (h) h.focus({ preventScroll: true });
            }, function () {
              btn.disabled = false;
              btn.firstChild.textContent = "다시 시도";
            });
          });
          moreBox.appendChild(btn);
        }
        renderMore();
        renderToc(ctx, source);

        if (kind === "haje" && haje) {
          requestAnimationFrame(function () {
            haje.scrollIntoView({ block: "start" });
            var more = haje.querySelector("details");
            if (more) more.open = true;
            $("hajeH").focus({ preventScroll: true });
          });
        }
      }, function () {
        if (token === state.renderToken) showLoadError(load);
      });
    };
    load();
  }

  // reader:"article" -- one page per item, prev/next in date order
  function renderArticleItem(source, item, token) {
    renderReaderHeader(item, "");
    partTabs.innerHTML = "";
    readerSource.innerHTML = "";
    var order = state.orderBySource[source.id] || [];
    var idx = order.indexOf(item);
    function nav(it) { return it ? { label: it.displayTitle, href: readerHash(it) } : null; }
    setPager(nav(order[idx - 1]), nav(order[idx + 1]));

    var url = source.base_url + "/" + item.path;
    var load = function () {
      readerContent.innerHTML = '<p class="loading">불러오는 중…</p>';
      fetchTextCached(url).then(function (text) {
        if (token !== state.renderToken) return;
        showContent(url, text, source, item, { dropTitle: true });
      }, function () {
        if (token === state.renderToken) showLoadError(load);
      });
    };
    load();
  }

  function showReader() {
    if (!state.reading) state.listScroll = window.scrollY;
    state.reading = true;
    document.body.classList.add("reading");
    gridView.hidden = true;
    readerView.hidden = false;
    window.scrollTo(0, 0);
  }

  function showGrid() {
    var wasReading = state.reading;
    state.reading = false;
    document.body.classList.remove("reading");
    readerView.hidden = true;
    gridView.hidden = false;
    document.title = SITE_TITLE;
    if (wasReading) {
      var y = state.listScroll;
      requestAnimationFrame(function () { window.scrollTo(0, y); });
    }
  }

  function parseHash() {
    var params = {};
    location.hash.replace(/^#/, "").split("&").forEach(function (pair) {
      var idx = pair.indexOf("=");
      if (idx === -1) return;
      try { params[pair.slice(0, idx)] = decodeURIComponent(pair.slice(idx + 1)); } catch (e) { /* ignore */ }
    });
    return params;
  }

  function showNotice(html) {
    notice.innerHTML = html;
    notice.hidden = !html;
  }

  var lastRoutedHref = null;
  var lastListSearch = null;

  function route() {
    if (!state.ready) return;
    // hashchange and popstate both fire for one navigation; handle it once.
    if (location.href === lastRoutedHref) return;
    lastRoutedHref = location.href;
    // Back/forward or a breadcrumb changed the list state (?src=&king=…).
    if (location.search !== lastListSearch) {
      lastListSearch = location.search;
      readListUrl();
      renderSourceTabs();
      renderGrid(true);
      state.listScroll = 0;
    }
    var params = parseHash();
    if (!params.src || !params.id) {
      if (!state.loadErrors.length) showNotice("");
      showGrid();
      return;
    }
    var source = state.sourcesById[params.src];
    var item = state.itemsByKey[params.src + ":" + params.id];
    if (!source || !item) {
      showGrid();
      showNotice("요청한 항목을 찾을 수 없습니다. 주소가 바뀌었거나 아직 공개되지 않은 항목일 수 있습니다.");
      return;
    }
    var entering = !state.reading;
    if (!state.loadErrors.length) showNotice("");
    showReader();
    resetReaderExtras();
    state.currentItem = item;
    var token = ++state.renderToken;
    if (source.reader === "article") {
      renderArticleItem(source, item, token);
    } else {
      var kind = params.view === "haje" ? "haje" : params.part ? "part" : "readme";
      renderBookItem(source, item, kind, params.part ? parseInt(params.part, 10) : null, token);
    }
    if (entering) {
      var h = $("readerTitle");
      if (h) h.focus({ preventScroll: true });
    }
  }

  function goToList() {
    var item = state.currentItem;
    var target = location.pathname + location.search;
    // Opened from a shared link with no list state: land on that day's month.
    if (item && item.reign && !new URLSearchParams(location.search).get("src")) {
      target = listHref(reignListParams(item, 3));
    }
    history.pushState(null, "", target);
    route();
  }

  backLink.addEventListener("click", goToList);

  // Breadcrumb links change the list state in place instead of reloading.
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[data-nav="list"]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    history.pushState(null, "", a.getAttribute("href"));
    route();
    window.scrollTo(0, 0);
  });

  document.addEventListener("keydown", function (e) {
    var t = e.target;
    var typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    if (e.key === "/" && !typing && !state.reading && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (e.key === "Escape" && state.reading && !typing) {
      goToList();
    }
  });

  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  window.addEventListener("hashchange", route);
  window.addEventListener("popstate", route);

  // -------------------------------------------------------------------- boot

  fetch("sources.json")
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (sources) {
      state.sources = sources;
      sources.forEach(function (s, i) {
        state.sourcesById[s.id] = s;
        state.sourceIndex[s.id] = i;
      });
      readListUrl();
      renderSourceTabs();
      return Promise.all([Promise.all(sources.map(loadSource)), loadStats()]);
    })
    .then(function (results) {
      state.items = [].concat.apply([], results[0]);
      state.items.forEach(function (item) { state.itemsByKey[item._key] = item; });
      state.sources.forEach(function (s) {
        state.orderBySource[s.id] = state.items
          .filter(function (it) { return it._source === s.id; })
          .sort(byDate);
        if (s.reign && s.status === "active") {
          var idx = buildReignIndex(s);
          if (idx.length) state.reignIndex[s.id] = idx;
        }
      });
      state.ready = true;
      renderSourceTabs();
      renderStats();
      if (state.loadErrors.length) {
        showNotice(escapeHtml(state.loadErrors.join(", ")) + " 목록을 불러오지 못했습니다." +
          '<button type="button" onclick="location.reload()">다시 시도</button>');
      }
      renderGrid(true);
      lastListSearch = location.search;
      route();
    })
    .catch(function () {
      grid.removeAttribute("aria-busy");
      grid.innerHTML = '<p class="loading">출처 목록을 불러오지 못했습니다. 잠시 뒤 <a href="">새로고침</a>해 주세요.</p>';
    });
})();
