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

  function yearOf(v) {
    var m = String(v || "").match(/(1[0-9]{3}|20[0-9]{2})/);
    return m ? parseInt(m[1], 10) : null;
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
      haystack: normalize([titleKo, titleHanja, subtitle, date, id, reign ? reign.ad : ""].join(" ")),
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
    add("all", "전체", state.ready ? fmt(state.items.length) : "");
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
    year.monthList.forEach(function (m) {
      var btn = el("button", "monthBtn");
      btn.type = "button";
      btn.setAttribute("aria-pressed", String(m === month));
      var top = el("span", "monthTop");
      top.appendChild(el("span", "monthName", monthLabel(m.month, m.leap)));
      top.appendChild(el("span", "monthCount", "기사 " + m.entries));
      btn.appendChild(top);
      var pills = el("span", "monthDays");
      m.items.forEach(function (it) {
        pills.appendChild(el("span", "dayPill", (it.reign.day ? it.reign.day + "일" : "미상") + " " + it.count + "건"));
      });
      btn.appendChild(pills);
      btn.addEventListener("click", function () {
        browseSelect({ month: m.key });
        var target = $("bDayH");
        if (target && window.matchMedia("(max-width: 900px)").matches) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      mgrid.appendChild(btn);
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
      var first = main[0];
      if (!first) headEl.textContent = routine[0] || "기사 제목 없음";
      else headEl.textContent = isUntitled(first) ? "제목 없는 기사" + (main.length > 1 ? " 외 " + (main.length - 1) + "건" : "") : first + (main.length > 1 ? " 외 " + (main.length - 1) + "건" : "");
      routineEl.textContent = routine.length && first ? "반복 기록: " + routine[0] : "";
    }, function () {
      headEl.textContent = "제목을 불러오지 못했습니다";
    });
  }

  function renderGrid(reset) {
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
    if (reset) {
      state.filtered = filteredSorted();
      state.shown = 0;
      grid.innerHTML = "";
    }
    var items = state.filtered;
    var next = items.slice(state.shown, state.shown + PAGE_SIZE);
    var frag = document.createDocumentFragment();
    next.forEach(function (item) { frag.appendChild(cardFor(item)); });
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

  function resetReaderExtras() {
    readerToc.hidden = true;
    readerToc.innerHTML = "";
    readerTools.hidden = true;
    readerBody.classList.remove("hasToc");
    readerView.classList.remove("wide");
    readerContent.classList.remove("structured");
  }

  function showContent(url, text, source, item, mdOpts) {
    resetReaderExtras();
    readerContent.innerHTML = renderMarkdown(text, mdOpts);
    rewriteContentLinks(readerContent, source, item);
    var toc = structureEntries(readerContent, source);
    if (toc) {
      readerTools.hidden = false;
      applyView();
      renderToc(toc, source);
    }
    readerSource.innerHTML = '원본 파일: <a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(url) + "</a>";
  }

  // Regroup the generated markdown (## 기사 → ### 한글 번역/독음/의미/원문 …)
  // into one card per article with 원문 and 번역 side by side. Returns the
  // table of contents, or null when the page has no such articles.
  var KNOWN_SECTIONS = { "한글 번역": 1, "독음": 1, "의미": 1, "원문": 1 };

  function structureEntries(container, source) {
    var nodes = Array.prototype.slice.call(container.children);
    var intro = [];
    var groups = [];
    var cur = null;
    nodes.forEach(function (n) {
      if (n.tagName === "H2") { cur = { h: n, parts: [] }; groups.push(cur); }
      else if (n.tagName === "HR") { /* dividers are drawn by the cards */ }
      else if (cur) cur.parts.push(n);
      else intro.push(n);
    });
    var hasArticles = groups.some(function (g) {
      return g.parts.some(function (p) { return p.tagName === "H3" && /^(원문|한글 번역)$/.test(p.textContent.trim()); });
    });
    if (!hasArticles) return null;

    var re = routineRe(source);
    container.innerHTML = "";
    container.classList.add("structured");
    if (intro.length && !source.reign) {
      var info = el("details", "entryIntro");
      info.appendChild(el("summary", null, "자료 정보"));
      intro.forEach(function (n) { info.appendChild(n); });
      container.appendChild(info);
    }

    var toc = [];
    var no = 0;
    groups.forEach(function (g, gi) {
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
      var rawTitle = g.h.textContent.trim();
      var untitled = isUntitled(rawTitle);
      var title = untitled ? "제목 없는 기사" : rawTitle;
      var routine = !!(re && re.test(rawTitle));
      var id = "entry-" + (gi + 1);
      var entry;

      function block(cls, label, list, lang) {
        var d = el("div", cls);
        if (lang) d.lang = lang;
        var l = el("span", "entryLabel", label);
        l.lang = "ko";
        d.appendChild(l);
        (list || []).forEach(function (n) { d.appendChild(n); });
        return d;
      }

      if (routine) {
        entry = el("details", "entry routine");
        var sum = el("summary");
        sum.appendChild(el("span", "routineTag", "반복 기록"));
        sum.appendChild(el("span", "entryTitleInline", title));
        entry.appendChild(sum);
        (sec["한글 번역"] || []).forEach(function (n) { entry.appendChild(n); });
        if (sec["원문"]) entry.appendChild(block("han", "원문", sec["원문"], "lzh"));
      } else {
        no++;
        entry = el("section", "entry");
        var head = el("header", "entryHead");
        head.appendChild(el("span", "entryNo", "기사 " + no));
        var h = el("h2", "entryTitle" + (untitled ? " untitled" : ""), title);
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
        tail.forEach(function (n) { entry.appendChild(n); });
        if (meta) entry.appendChild(meta);
      }
      entry.id = id;
      container.appendChild(entry);
      toc.push({ id: id, title: title, routine: routine, no: routine ? null : no });
    });
    return toc;
  }

  function renderToc(toc, source) {
    if (toc.length < 2) return;
    var articles = toc.filter(function (t) { return !t.routine; }).length;
    var sum = el("summary", null, (source.reign ? "이 날의 기사 " : "이 묶음의 기사 ") + articles + "건");
    readerToc.appendChild(sum);
    var list = el("ol", "tocList");
    toc.forEach(function (t) {
      var li = el("li", t.routine ? "tocRoutine" : null);
      var b = el("button", null);
      b.type = "button";
      b.appendChild(el("span", "tocNo", t.routine ? "반복 기록" : "기사 " + t.no));
      b.appendChild(el("span", "tocTitle", t.title));
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
    if (window.matchMedia("(min-width: 1000px)").matches) readerView.classList.add("wide");
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

  // reader:"book" -- README / 해제 / 묶음 N
  function renderBookItem(source, item, kind, partNo, token) {
    var parts = state.partsByBook[source.id + ":" + item._id] || [];
    var hajeUrl = source.base_url + "/" + bookDir(item.path) + "/haje.md";
    if (kind === "part" && !parts.some(function (p) { return p.part === partNo; })) kind = "readme";

    renderReaderHeader(item, kind === "part" ? "묶음 " + partNo : kind === "haje" ? "해제" : "");
    readerContent.innerHTML = '<p class="loading">불러오는 중…</p>';
    readerSource.innerHTML = "";
    readerPager.hidden = true;
    partTabs.innerHTML = "";

    fetchTextCached(hajeUrl)
      .then(function () { return true; }, function () { return false; })
      .then(function (hasHaje) {
        if (token !== state.renderToken) return;
        if (kind === "haje" && !hasHaje) kind = "readme";

        partTabs.innerHTML = "";
        partTabs.appendChild(tabLink("책 소개", readerHash(item), kind === "readme"));
        if (hasHaje) partTabs.appendChild(tabLink("해제", readerHash(item, { view: "haje" }), kind === "haje"));
        if (parts.length && parts.length <= PART_TABS_MAX) {
          parts.forEach(function (p) {
            partTabs.appendChild(tabLink("묶음 " + p.part, readerHash(item, { part: p.part }), kind === "part" && partNo === p.part));
          });
        } else if (parts.length) {
          var sel = document.createElement("select");
          sel.className = "partSelect" + (kind === "part" ? " active" : "");
          sel.setAttribute("aria-label", "본문 번역 묶음 선택 (전체 " + parts.length + "개)");
          var ph = document.createElement("option");
          ph.value = "";
          ph.textContent = "본문 묶음 선택 (" + parts.length + "개)";
          sel.appendChild(ph);
          parts.forEach(function (p) {
            var o = document.createElement("option");
            o.value = p.part;
            o.textContent = "묶음 " + p.part + (p.article_count ? " · 기사 " + p.article_count + "건" : "");
            if (kind === "part" && p.part === partNo) o.selected = true;
            sel.appendChild(o);
          });
          sel.addEventListener("change", function () {
            if (sel.value) location.hash = readerHash(item, { part: sel.value });
          });
          partTabs.appendChild(sel);
        }

        // prev/next through 책 소개 → 해제 → 묶음 1..N
        var seq = [{ label: "책 소개", href: readerHash(item) }];
        if (hasHaje) seq.push({ label: "해제", href: readerHash(item, { view: "haje" }) });
        parts.forEach(function (p) { seq.push({ label: "묶음 " + p.part, href: readerHash(item, { part: p.part }) }); });
        var cur = kind === "readme" ? 0 : kind === "haje" ? 1 : seq.length - parts.length + parts.map(function (p) { return p.part; }).indexOf(partNo);
        setPager(seq[cur - 1], seq[cur + 1]);

        var url;
        if (kind === "haje") url = hajeUrl;
        else if (kind === "part") url = source.base_url + "/" + parts.filter(function (p) { return p.part === partNo; })[0].path;
        else url = source.base_url + "/" + item.path;

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
      });
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
