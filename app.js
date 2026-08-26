(function () {
  "use strict";

  var state = {
    sources: [],
    items: [],
    sourceFilter: "all",
    query: "",
    sort: "title",
    shown: 0,
    filtered: [],
  };
  var PAGE_SIZE = 60;

  var grid = document.getElementById("grid");
  var emptyState = document.getElementById("emptyState");
  var resultCount = document.getElementById("resultCount");
  var searchInput = document.getElementById("searchInput");
  var sortSelect = document.getElementById("sortSelect");
  var sentinel = document.getElementById("sentinel");
  var sourceTabs = document.getElementById("sourceTabs");
  var sourceBreakdown = document.getElementById("sourceBreakdown");

  function normalize(text) {
    return (text || "").toString().toLowerCase();
  }

  function escapeHtml(s) {
    return (s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function parseJsonl(text) {
    var rows = [];
    var lines = text.split("\n");
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

  // Extensible: every "active" source just needs an entry in sources.json
  // with a flat JSONL index and a field-name mapping into this common shape.
  // No per-source code changes needed to add a new one.
  function loadSource(source) {
    if (source.status !== "active" || !source.index_path) {
      return Promise.resolve([]);
    }
    return fetch(source.base_url + "/" + source.index_path)
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (text) {
        var rows = parseJsonl(text);
        return rows.map(function (row) {
          var f = source.fields || {};
          return {
            _source: source.id,
            _sourceName: source.name,
            _key: source.id + ":" + get(row, f.id),
            title_ko: get(row, f.title_ko) || "",
            title_hanja: get(row, f.title_hanja) || "",
            subtitle: get(row, f.subtitle) || "",
            date: get(row, f.date) || "",
            count: f.count ? (get(row, f.count) || 0) : 1,
            href: source.base_url + "/" + get(row, f.path),
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
    if (!pending.length) return;
    Promise.all(
      pending.map(function (s) {
        if (seen[s.base_url + s.stats_path]) return null;
        seen[s.base_url + s.stats_path] = true;
        return fetch(s.base_url + "/" + s.stats_path)
          .then(function (r) { return r.json(); })
          .catch(function () { return null; });
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
    a.href = item.href;
    a.target = "_blank";
    a.rel = "noopener";
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

  fetch("sources.json")
    .then(function (r) { return r.json(); })
    .then(function (sources) {
      state.sources = sources;
      renderSourceTabs();
      return Promise.all(sources.map(loadSource));
    })
    .then(function (results) {
      state.items = [].concat.apply([], results);
      renderGrid(true);
      loadStatsBadges();
    });
})();
