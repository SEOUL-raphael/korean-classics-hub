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
  };

  var collator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });

  function $(id) { return document.getElementById(id); }
  var gridView = $("gridView");
  var grid = $("grid");
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

  function toItem(source, row) {
    var f = source.fields || {};
    var id = get(row, f.id);
    var titleKo = clean(get(row, f.title_ko));
    var titleHanja = clean(get(row, f.title_hanja));
    var subtitle = clean(get(row, f.subtitle));
    var date = clean(get(row, f.date));
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
      haystack: normalize([titleKo, titleHanja, subtitle, date, id].join(" ")),
    };
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
    add(item.subtitle || (forReader ? "저자 미상" : ""));
    add(item.date || (forReader ? "연대 미상" : ""));
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

  function renderGrid(reset) {
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
    if (sort && sortSelect.querySelector('option[value="' + sort + '"]')) state.sort = sort;
    sortSelect.value = state.sort;
  }

  function syncListUrl() {
    var p = new URLSearchParams();
    if (state.query) p.set("q", state.query);
    if (state.sourceFilter !== "all") p.set("src", state.sourceFilter);
    if (state.sort !== "title") p.set("sort", state.sort);
    var qs = p.toString();
    history.replaceState(history.state, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
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

  function renderReaderHeader(item, subtitle) {
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

  function showContent(url, text, source, item, mdOpts) {
    readerContent.innerHTML = renderMarkdown(text, mdOpts);
    rewriteContentLinks(readerContent, source, item);
    readerSource.innerHTML = '원본 파일: <a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(url) + "</a>";
  }

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

  function route() {
    if (!state.ready) return;
    // hashchange and popstate both fire for one navigation; handle it once.
    if (location.href === lastRoutedHref) return;
    lastRoutedHref = location.href;
    var params = parseHash();
    if (!params.src || !params.id) { showGrid(); return; }
    var source = state.sourcesById[params.src];
    var item = state.itemsByKey[params.src + ":" + params.id];
    if (!source || !item) {
      showGrid();
      showNotice("요청한 항목을 찾을 수 없습니다. 주소가 바뀌었거나 아직 공개되지 않은 항목일 수 있습니다.");
      return;
    }
    var entering = !state.reading;
    showReader();
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
    history.pushState(null, "", location.pathname + location.search);
    route();
  }

  backLink.addEventListener("click", goToList);

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
      });
      state.ready = true;
      renderSourceTabs();
      renderStats();
      if (state.loadErrors.length) {
        showNotice(escapeHtml(state.loadErrors.join(", ")) + " 목록을 불러오지 못했습니다." +
          '<button type="button" onclick="location.reload()">다시 시도</button>');
      }
      renderGrid(true);
      route();
    })
    .catch(function () {
      grid.removeAttribute("aria-busy");
      grid.innerHTML = '<p class="loading">출처 목록을 불러오지 못했습니다. 잠시 뒤 <a href="">새로고침</a>해 주세요.</p>';
    });
})();
