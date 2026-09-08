(function () {
  "use strict";

  var state = {
    sources: [],
    sourcesById: {},
    items: [],
    itemsByKey: {},
    partsByBook: {}, // "sourceId:book_id" -> [{part, path, ...}]
    sourceFilter: "all",
    query: "",
    sort: "title",
    shown: 0,
    filtered: [],
    partCache: {},
  };
  var PAGE_SIZE = 60;

  var gridView = document.getElementById("gridView");
  var grid = document.getElementById("grid");
  var emptyState = document.getElementById("emptyState");
  var resultCount = document.getElementById("resultCount");
  var searchInput = document.getElementById("searchInput");
  var sortSelect = document.getElementById("sortSelect");
  var sentinel = document.getElementById("sentinel");
  var sourceTabs = document.getElementById("sourceTabs");
  var sourceBreakdown = document.getElementById("sourceBreakdown");
  var controls = document.getElementById("controls");

  var readerView = document.getElementById("readerView");
  var readerHeader = document.getElementById("readerHeader");
  var partTabs = document.getElementById("partTabs");
  var readerContent = document.getElementById("readerContent");
  var readerSource = document.getElementById("readerSource");
  var backLink = document.getElementById("backLink");

  function normalize(text) {
    return (text || "").toString().toLowerCase();
  }

  function escapeHtml(s) {
    return (s || "")
      .toString()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function parseJsonl(text) {
    var rows = [];
    var lines = (text || "").split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch (err) {
        /* skip malformed line */
      }
    }
    return rows;
  }

  function get(row, key) {
    if (!key) return undefined;
    return row[key];
  }

  // ---- Minimal Markdown renderer, scoped to what the aks_yoksa/sjw_ilgi
  // snapshot generators actually emit: headings, "- " bullet lists, "|"
  // tables, ``` code fences, "---" rules, **bold**, `code`, [text](href),
  // and plain paragraphs. ----
  function inlineMd(s) {
    s = escapeHtml(s);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\[([^\]]*)\]\(([^)]+)\)/g, function (m, text, href) {
      return '<a href="' + href + '">' + text + "</a>";
    });
    return s;
  }

  function renderTable(tableLines) {
    var rows = tableLines.map(function (l) {
      return l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) {
        return c.trim();
      });
    });
    var header = rows[0];
    var body = rows.slice(2);
    var out = '<div class="tableWrap"><table><thead><tr>';
    header.forEach(function (h) { out += "<th>" + inlineMd(h) + "</th>"; });
    out += "</tr></thead><tbody>";
    body.forEach(function (r) {
      out += "<tr>" + r.map(function (c) { return "<td>" + inlineMd(c) + "</td>"; }).join("") + "</tr>";
    });
    out += "</tbody></table></div>";
    return out;
  }

  function renderMarkdown(text) {
    var lines = text.replace(/\r\n/g, "\n").split("\n");
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^```/.test(line)) {
        var buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++;
        out.push('<pre class="codeBlock"><code>' + escapeHtml(buf.join("\n")) + "</code></pre>");
        continue;
      }
      if (/^\s*$/.test(line)) {
        i++;
        continue;
      }
      if (/^-{3,}\s*$/.test(line)) {
        out.push("<hr />");
        i++;
        continue;
      }
      var heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        var level = heading[1].length;
        out.push("<h" + level + ">" + inlineMd(heading[2]) + "</h" + level + ">");
        i++;
        continue;
      }
      if (/^\|/.test(line)) {
        var tableLines = [];
        while (i < lines.length && /^\|/.test(lines[i])) {
          tableLines.push(lines[i]);
          i++;
        }
        out.push(renderTable(tableLines));
        continue;
      }
      if (/^-\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^-\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^-\s+/, ""));
          i++;
        }
        out.push("<ul>" + items.map(function (it) { return "<li>" + inlineMd(it) + "</li>"; }).join("") + "</ul>");
        continue;
      }
      var para = [line];
      i++;
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^#{1,6}\s/.test(lines[i]) &&
        !/^-\s+/.test(lines[i]) &&
        !/^```/.test(lines[i]) &&
        !/^\|/.test(lines[i]) &&
        !/^-{3,}\s*$/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      out.push("<p>" + inlineMd(para.join(" ")) + "</p>");
    }
    return out.join("\n");
  }

  // ---- Loading sources ----
  // Extensible: every "active" source just needs an entry in sources.json
  // with a flat JSONL index and a field-name mapping into this common shape.
  // A source with reader:"book" additionally supports a multi-part in-app
  // reader (parts_index_path); reader:"article" is a single-page reader.
  function loadSource(source) {
    if (source.status !== "active" || !source.index_path) {
      return Promise.resolve([]);
    }
    var jobs = [fetch(source.base_url + "/" + source.index_path).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    })];
    if (source.parts_index_path) {
      jobs.push(
        fetch(source.base_url + "/" + source.parts_index_path)
          .then(function (r) { return (r.ok ? r.text() : ""); })
          .catch(function () { return ""; })
      );
    }
    return Promise.all(jobs)
      .then(function (results) {
        if (results[1]) {
          var parts = parseJsonl(results[1]);
          parts.forEach(function (p) {
            var key = source.id + ":" + p.book_id;
            if (!state.partsByBook[key]) state.partsByBook[key] = [];
            state.partsByBook[key].push(p);
          });
        }
        var rows = parseJsonl(results[0]);
        return rows.map(function (row) {
          var f = source.fields || {};
          var id = get(row, f.id);
          return {
            _source: source.id,
            _sourceName: source.name,
            _key: source.id + ":" + id,
            _id: id,
            _row: row,
            title_ko: get(row, f.title_ko) || "",
            title_hanja: get(row, f.title_hanja) || "",
            subtitle: get(row, f.subtitle) || "",
            date: get(row, f.date) || "",
            count: f.count ? (get(row, f.count) || 0) : 1,
            path: get(row, f.path),
          };
        });
      })
      .catch(function () {
        return [];
      });
  }

  function loadStatsBadges() {
    var seen = {};
    var pending = state.sources.filter(function (s) { return s.stats_path; });
    Promise.all(
      pending.map(function (s) {
        var url = s.base_url + "/" + s.stats_path;
        if (seen[url]) return seen[url];
        var p = fetch(url).then(function (r) { return r.json(); }).catch(function () { return null; });
        seen[url] = p;
        return p;
      })
    ).then(function (results) {
      var chips = [];
      state.sources.forEach(function (s) {
        if (s.status === "active") {
          var count = state.items.filter(function (i) { return i._source === s.id; }).length;
          chips.push(s.name + " " + count + "건");
        } else if (s.stats_path) {
          var stats = results.find(function (r) { return r; });
          var val = stats && s.stats_key ? stats[s.stats_key] : null;
          var text = val ? (val.ok || 0) + "/" + (val.total_articles || 0) + "건 (준비 중)" : "준비 중";
          chips.push(s.name + " " + text);
        }
      });
      sourceBreakdown.innerHTML = chips.map(function (t) { return '<span class="chip">' + escapeHtml(t) + "</span>"; }).join("");
    });
  }

  function renderSourceTabs() {
    sourceTabs.innerHTML = "";
    var allBtn = document.createElement("button");
    allBtn.className = "sourceTab active";
    allBtn.setAttribute("data-source", "all");
    allBtn.setAttribute("role", "tab");
    allBtn.setAttribute("aria-selected", "true");
    allBtn.textContent = "전체";
    sourceTabs.appendChild(allBtn);
    state.sources.forEach(function (s) {
      var btn = document.createElement("button");
      btn.className = "sourceTab" + (s.status !== "active" ? " inProgress" : "");
      btn.setAttribute("data-source", s.id);
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", "false");
      btn.textContent = s.name + (s.status !== "active" ? " (준비 중)" : "");
      if (s.status === "active") sourceTabs.appendChild(btn);
    });
    sourceTabs.addEventListener("click", function (evt) {
      var btn = evt.target.closest(".sourceTab");
      if (!btn) return;
      state.sourceFilter = btn.getAttribute("data-source");
      Array.prototype.forEach.call(sourceTabs.querySelectorAll(".sourceTab"), function (b) {
        var active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", active ? "true" : "false");
      });
      location.hash = "";
      renderGrid(true);
    });
  }

  function matches(item, query) {
    if (!query) return true;
    var haystack = normalize(item.title_ko) + " " + normalize(item.title_hanja) + " " + normalize(item.subtitle);
    return haystack.indexOf(query) !== -1;
  }

  function compare(a, b) {
    switch (state.sort) {
      case "author":
        return normalize(a.subtitle).localeCompare(normalize(b.subtitle), "ko");
      case "date":
        return normalize(a.date).localeCompare(normalize(b.date), "ko");
      case "count-desc":
        return (b.count || 0) - (a.count || 0);
      default:
        return normalize(a.title_ko || a.title_hanja).localeCompare(normalize(b.title_ko || b.title_hanja), "ko");
    }
  }

  function filteredSorted() {
    var query = normalize(state.query);
    return state.items
      .filter(function (item) { return state.sourceFilter === "all" || item._source === state.sourceFilter; })
      .filter(function (item) { return matches(item, query); })
      .sort(compare);
  }

  function cardFor(item) {
    var a = document.createElement("a");
    a.className = "card";
    var src = state.sourcesById[item._source];
    if (src && src.reader) {
      a.href = "#src=" + encodeURIComponent(item._source) + "&id=" + encodeURIComponent(item._id);
    } else {
      a.href = item.path ? src.base_url + "/" + item.path : "#";
      a.target = "_blank";
      a.rel = "noopener";
    }
    a.setAttribute("role", "listitem");

    var badge = document.createElement("div");
    badge.className = "sourceBadge";
    badge.textContent = item._sourceName;
    a.appendChild(badge);

    var title = document.createElement("div");
    title.className = "cardTitle";
    title.textContent = item.title_ko || item.title_hanja || item._key;
    a.appendChild(title);

    if (item.title_hanja && item.title_hanja !== item.title_ko) {
      var hanja = document.createElement("div");
      hanja.className = "cardHanja";
      hanja.textContent = item.title_hanja;
      a.appendChild(hanja);
    }

    var meta = document.createElement("div");
    meta.className = "cardMeta";
    [item.subtitle || "미상", item.date || "", item.count > 1 ? item.count + "건" : ""]
      .filter(function (t) { return t; })
      .forEach(function (label) {
        var chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = label;
        meta.appendChild(chip);
      });
    a.appendChild(meta);
    return a;
  }

  function renderGrid(reset) {
    var items = filteredSorted();
    if (reset) {
      grid.innerHTML = "";
      state.shown = 0;
      state.filtered = items;
    }
    resultCount.textContent = items.length + "개 중 " + Math.min(state.shown + PAGE_SIZE, items.length) + "개 표시";
    emptyState.hidden = items.length !== 0;
    var next = items.slice(state.shown, state.shown + PAGE_SIZE);
    var frag = document.createDocumentFragment();
    next.forEach(function (item) { frag.appendChild(cardFor(item)); });
    grid.appendChild(frag);
    state.shown += next.length;
  }

  function loadMoreIfNeeded() {
    if (!state.filtered.length) return;
    if (state.shown >= state.filtered.length) return;
    var rect = sentinel.getBoundingClientRect();
    if (rect.top < window.innerHeight * 1.5) {
      renderGrid(false);
    }
  }

  // ---- Reader view: fetch a book/article's markdown from its own source
  // repo (cross-origin) and render inline, instead of just linking out. ----
  function bookDir(path) {
    return path.replace(/\/README\.md$/, "");
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

  // Links inside fetched .md content (e.g. "[해제 보기](haje.md)",
  // "[part-001.md](part-001.md)") are written relative to the item's own
  // directory in its source repo. Route the ones we recognize (haje.md,
  // part-NNN.md) to the in-app reader tabs, and resolve anything else
  // against the source repo's base_url instead of this page's URL.
  function rewriteContentLinks(container, source, item) {
    var anchors = container.querySelectorAll("a[href]");
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var href = a.getAttribute("href");
      if (!href || /^([a-z]+:)?\/\//i.test(href) || href.charAt(0) === "#") continue;
      if (/^haje\.md$/.test(href)) {
        a.href = "#src=" + encodeURIComponent(item._source) + "&id=" + encodeURIComponent(item._id) + "&view=haje";
        continue;
      }
      var partMatch = href.match(/^part-0*(\d+)\.md$/);
      if (partMatch) {
        a.href = "#src=" + encodeURIComponent(item._source) + "&id=" + encodeURIComponent(item._id) + "&part=" + parseInt(partMatch[1], 10);
        continue;
      }
      a.href = source.base_url + "/" + bookDir(item.path) + "/" + href;
    }
  }

  function tabButton(label, active, onClick) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab" + (active ? " active" : "");
    btn.textContent = label;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", active ? "true" : "false");
    btn.addEventListener("click", onClick);
    return btn;
  }

  function renderReaderHeader(item) {
    var chips = [item.subtitle || "미상", item.date || "미상"];
    if (item.count > 1) chips.push(item.count + "건 기사");
    readerHeader.innerHTML =
      '<h2 class="readerTitle">' + escapeHtml(item.title_ko || item.title_hanja || item._id) + "</h2>" +
      (item.title_hanja && item.title_hanja !== item.title_ko
        ? '<p class="readerHanja">' + escapeHtml(item.title_hanja) + "</p>"
        : "") +
      '<div class="cardMeta">' +
      chips.map(function (t) { return '<span class="chip">' + escapeHtml(t) + "</span>"; }).join("") +
      "</div>";
  }

  function openHash(params) {
    var hash = Object.keys(params)
      .map(function (k) { return k + "=" + encodeURIComponent(params[k]); })
      .join("&");
    var newHash = "#" + hash;
    if (location.hash !== newHash) {
      location.hash = newHash;
      return true; // hashchange will re-enter via route()
    }
    return false;
  }

  // reader:"book" -- multi-part reader (README / haje / part-NNN), mirrors
  // the aks_yoksa app's book browsing.
  function renderBookItem(source, item, kind, partNo) {
    showReader();
    renderReaderHeader(item);
    readerContent.innerHTML = '<p class="loading">불러오는 중…</p>';
    readerSource.innerHTML = "";

    var partsKey = source.id + ":" + item._id;
    var parts = (state.partsByBook[partsKey] || []).slice().sort(function (a, b) { return a.part - b.part; });
    var hajeUrl = source.base_url + "/" + bookDir(item.path) + "/haje.md";

    fetchTextCached(hajeUrl)
      .then(function () { return true; })
      .catch(function () { return false; })
      .then(function (hasHaje) {
        var effectiveKind = kind;
        var effectivePart = partNo;
        if (effectiveKind === "part" && !parts.some(function (p) { return p.part === effectivePart; })) {
          effectiveKind = "readme";
          effectivePart = null;
        }
        if (effectiveKind === "haje" && !hasHaje) {
          effectiveKind = "readme";
        }

        partTabs.innerHTML = "";
        partTabs.appendChild(tabButton("책 소개", effectiveKind === "readme", function () {
          openHash({ src: source.id, id: item._id });
        }));
        if (hasHaje) {
          partTabs.appendChild(tabButton("해제", effectiveKind === "haje", function () {
            openHash({ src: source.id, id: item._id, view: "haje" });
          }));
        }
        parts.forEach(function (part) {
          partTabs.appendChild(tabButton("묶음 " + part.part, effectiveKind === "part" && effectivePart === part.part, function () {
            openHash({ src: source.id, id: item._id, part: part.part });
          }));
        });

        var url;
        if (effectiveKind === "haje") {
          url = hajeUrl;
        } else if (effectiveKind === "part") {
          var match = parts.filter(function (p) { return p.part === effectivePart; })[0];
          url = match ? source.base_url + "/" + match.path : null;
        } else {
          url = source.base_url + "/" + item.path;
        }
        if (!url) {
          readerContent.innerHTML = '<p class="loading">표시할 내용이 없습니다.</p>';
          return;
        }
        fetchTextCached(url)
          .then(function (text) {
            readerContent.innerHTML = renderMarkdown(text);
            rewriteContentLinks(readerContent, source, item);
            readerSource.innerHTML = '원문 Markdown: <a href="' + url + '" target="_blank" rel="noopener">' + url + "</a>";
          })
          .catch(function () {
            readerContent.innerHTML = '<p class="loading">내용을 불러오지 못했습니다.</p>';
          });
      });
  }

  // reader:"article" -- single-page reader (e.g. sjw_ilgi articles).
  function renderArticleItem(source, item) {
    showReader();
    renderReaderHeader(item);
    partTabs.innerHTML = "";
    readerContent.innerHTML = '<p class="loading">불러오는 중…</p>';
    readerSource.innerHTML = "";
    var url = source.base_url + "/" + item.path;
    fetchTextCached(url)
      .then(function (text) {
        readerContent.innerHTML = renderMarkdown(text);
        readerSource.innerHTML = '원문 Markdown: <a href="' + url + '" target="_blank" rel="noopener">' + url + "</a>";
      })
      .catch(function () {
        readerContent.innerHTML = '<p class="loading">내용을 불러오지 못했습니다.</p>';
      });
  }

  function showReader() {
    gridView.hidden = true;
    controls.hidden = true;
    readerView.hidden = false;
    window.scrollTo(0, 0);
  }

  function showGrid() {
    readerView.hidden = true;
    controls.hidden = false;
    gridView.hidden = false;
  }

  function route() {
    var hash = location.hash.replace(/^#/, "");
    if (!hash) {
      showGrid();
      return;
    }
    var params = {};
    hash.split("&").forEach(function (pair) {
      var idx = pair.indexOf("=");
      if (idx === -1) return;
      params[pair.slice(0, idx)] = decodeURIComponent(pair.slice(idx + 1));
    });
    if (!params.src || !params.id) {
      showGrid();
      return;
    }
    var source = state.sourcesById[params.src];
    var item = state.itemsByKey[params.src + ":" + params.id];
    if (!source || !item) {
      showGrid();
      return;
    }
    if (source.reader === "article") {
      renderArticleItem(source, item);
      return;
    }
    var kind = params.view === "haje" ? "haje" : params.part ? "part" : "readme";
    renderBookItem(source, item, kind, params.part ? parseInt(params.part, 10) : null);
  }

  backLink.addEventListener("click", function () {
    location.hash = "";
  });

  var searchTimer = null;
  searchInput.addEventListener("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.query = searchInput.value;
      renderGrid(true);
    }, 120);
  });

  sortSelect.addEventListener("change", function () {
    state.sort = sortSelect.value;
    renderGrid(true);
  });

  window.addEventListener("scroll", loadMoreIfNeeded, { passive: true });
  window.addEventListener("resize", loadMoreIfNeeded);
  window.addEventListener("hashchange", route);

  fetch("sources.json")
    .then(function (r) { return r.json(); })
    .then(function (sources) {
      state.sources = sources;
      sources.forEach(function (s) { state.sourcesById[s.id] = s; });
      renderSourceTabs();
      return Promise.all(sources.map(loadSource));
    })
    .then(function (results) {
      state.items = [].concat.apply([], results);
      state.items.forEach(function (item) { state.itemsByKey[item._key] = item; });
      renderGrid(true);
      loadStatsBadges();
      route();
    });
})();
