const state = {
  query: "",
  platform: "",
  section: "all",
  records: [],
  hits: [],
  selected: null,
  detail: null,
  platforms: [],
  activeTab: "overview",
  searchRequestId: 0,
  detailRequestId: 0,
  searchController: null,
  detailController: null,
};

const sectionLabels = {
  overview: "Overview",
  documents: "Documents",
  vendors: "Vendors",
  parts_list_bom: "Parts List / BOM",
  where_used: "Where Used",
  changes_ecos: "Changes / ECOs",
  raw: "Raw JSON",
};

const sectionCountFields = {
  documents: "document_count",
  vendors: "vendor_count",
  parts_list_bom: "bom_count",
  where_used: "where_used_count",
  changes_ecos: "eco_count",
};

const tabHelp = {
  overview: "Core item information.",
  documents: "Files and document metadata attached to this item.",
  vendors: "Approved manufacturers, distributors, and vendor part numbers.",
  parts_list_bom: "Direct child parts used by this item. Click part numbers to open them.",
  where_used: "Parent assemblies or products that use this item. Click BOM part numbers to open them.",
  changes_ecos: "Change history, ECOs, ECNs, deviations, and revision notes.",
  raw: "Original scraped JSON for troubleshooting or audit work.",
};

const fieldPriority = {
  documents: ["File", "Title", "Type", "Vault", "Version", "Notes", "Actions"],
  vendors: ["Vendor", "Part Number", "Description", "Status", "Type", "Notes"],
  parts_list_bom: ["Item", "Part Number", "Description", "Qty", "Refdes", "Rev", "Alternate", "Notes", "Special"],
  where_used: ["BOM Part Number", "Description", "BOM Rev", "Item", "Qty", "Refdes", "Item Rev"],
  changes_ecos: ["Number", "Description", "Reason", "Type", "Status", "Raised On", "Released", "Old Rev", "New Rev", "Notes"],
};

const summaryFields = {
  documents: ["File", "Title", "Type", "Vault"],
  vendors: ["Vendor", "Part Number", "Status", "Type"],
  parts_list_bom: ["Part Number", "Refdes", "Qty", "Description"],
  where_used: ["BOM Part Number", "Refdes", "Qty", "Description"],
  changes_ecos: ["Number", "Status", "Released", "Description"],
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function searchTerms() {
  return (state.query.toLowerCase().match(/[a-z0-9]+/g) || []).filter(Boolean);
}

function highlight(value) {
  let html = escapeHtml(value);
  for (const term of searchTerms()) {
    if (!term) continue;
    const pattern = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
    html = html.replace(pattern, "<mark>$1</mark>");
  }
  return html;
}

function compactText(value, max = 280) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function isAbortError(err) {
  return err && (err.name === "AbortError" || String(err.message || "").includes("aborted"));
}

async function refreshStatus() {
  try {
    const status = await api("/api/status");
    const label = status.state === "indexing"
      ? `Indexing ${formatNumber(status.processed)} / ${formatNumber(status.total)}`
      : "Database ready";
    $("indexStatus").textContent = label;
    if (status.state === "indexing") {
      $("resultCount").textContent = status.message || label;
    }
  } catch {
    $("indexStatus").textContent = "Index unavailable";
  }
}

async function loadPlatforms() {
  try {
    const payload = await api("/api/platforms");
    state.platforms = payload.platforms || [];
    const select = $("platformFilter");
    select.innerHTML = '<option value="">All platforms</option>';
    for (const platform of state.platforms) {
      const option = document.createElement("option");
      option.value = platform.platform;
      option.textContent = `${platform.platform} (${formatNumber(platform.item_count)})`;
      select.appendChild(option);
    }
    renderMetrics();
  } catch {
    renderMetrics();
  }
}

function renderMetrics() {
  $("platformMetrics").innerHTML = "";
}

function hitsForRecord(recordId) {
  return state.hits.filter((hit) => hit.record_id === recordId).slice(0, 3);
}

function renderResults() {
  const results = $("results");
  if (!state.records.length) {
    results.innerHTML = `<div class="empty-state compact"><h2>No results</h2><p>Try a part number, reference designator, file name, vendor, or ECO.</p></div>`;
    return;
  }
  results.innerHTML = state.records.map((record) => {
    const counts = [
      ["Docs", record.document_count],
      ["Vendors", record.vendor_count],
      ["BOM", record.bom_count],
      ["Used", record.where_used_count],
      ["ECOs", record.eco_count],
    ];
    const hitHtml = hitsForRecord(record.record_id).map((hit) => {
      const trail = (hit.trail || [state.query, record.platform, sectionLabels[hit.section] || hit.section]).filter(Boolean);
      return `
        <div class="trail">${trail.map(escapeHtml).join(" / ")}</div>
        <div class="snippet">${highlight(compactText(`${hit.title || ""} ${hit.body || ""}`))}</div>
      `;
    }).join("");
    const relatedHtml = renderRelatedInline(record.related_items || [], record.record_id);
    return `
      <article class="result-card ${state.selected === record.record_id ? "active" : ""}" data-id="${record.record_id}">
        <div class="result-meta">
          <span class="chip strong">${escapeHtml(record.platform)}</span>
          <span class="chip">${escapeHtml(record.status || "No status")}</span>
          <span class="chip">Rev ${escapeHtml(record.revision || "-")}</span>
        </div>
        <h2>${highlight(record.part_number || "No part number")}</h2>
        <p class="snippet">${highlight(record.description || record.type || "")}</p>
        <div class="chips">${counts.map(([label, value]) => `<span class="chip">${label}: ${formatNumber(value)}</span>`).join("")}</div>
        ${relatedHtml}
        ${hitHtml}
      </article>
    `;
  }).join("");
  results.querySelectorAll(".result-card").forEach((card) => {
    card.addEventListener("click", () => {
      selectRecord(Number(card.dataset.id)).catch((err) => {
        if (!isAbortError(err)) console.error(err);
      });
    });
  });
  attachRelatedLinks(results);
}

async function doSearch() {
  const requestId = ++state.searchRequestId;
  if (state.searchController) state.searchController.abort();
  state.searchController = new AbortController();
  const query = $("searchBox").value.trim();
  const platform = $("platformFilter").value;
  const section = $("sectionFilter").value;
  state.query = query;
  state.platform = platform;
  state.section = section;
  renderMetrics();
  const params = new URLSearchParams({
    q: query,
    platform,
    section,
    limit: "90",
  });
  $("resultCount").textContent = "Searching...";
  const payload = await api(`/api/search?${params}`, { signal: state.searchController.signal });
  if (requestId !== state.searchRequestId) return;
  state.records = payload.records || [];
  state.hits = payload.hits || [];
  $("resultCount").textContent = `${formatNumber(payload.total || state.records.length)} matching items`;
  $("activeTrail").textContent = [query || "Browse", platform || "All platforms", sectionLabels[section] || "All topics"].join(" / ");
  renderResults();
}

async function selectRecord(recordId) {
  const requestId = ++state.detailRequestId;
  if (state.detailController) state.detailController.abort();
  state.detailController = new AbortController();
  state.selected = recordId;
  state.activeTab = "overview";
  renderResults();
  const detail = $("detail");
  detail.innerHTML = `<div class="empty-state"><h2>Loading</h2><p>Pulling the full breakdown.</p></div>`;
  detail.scrollTop = 0;
  const payload = await api(`/api/item?id=${encodeURIComponent(recordId)}`, { signal: state.detailController.signal });
  if (requestId !== state.detailRequestId || state.selected !== recordId) return;
  state.detail = payload;
  renderDetail();
  detail.scrollTop = 0;
  if (window.matchMedia("(max-width: 1180px)").matches) {
    detail.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderDetail() {
  const detail = $("detail");
  if (!state.detail) {
    detail.innerHTML = `<div class="empty-state"><h2>Select a result</h2><p>Search across parts, schematics, BOM rows, vendors, Where Used, and ECO history.</p></div>`;
    return;
  }
  const { record } = state.detail;
  const tabs = ["overview", "documents", "vendors", "parts_list_bom", "where_used", "changes_ecos", "raw"];
  detail.innerHTML = `
    <div class="detail-header">
      <div class="chips">
        <span class="chip strong">${escapeHtml(record.platform)}</span>
        <span class="chip">${escapeHtml(record.type || "Type unavailable")}</span>
        <span class="chip">${escapeHtml(record.category || "Category unavailable")}</span>
      </div>
      <h2>${highlight(record.part_number || "No part number")}</h2>
      <p class="snippet">${highlight(record.description || "")}</p>
      <div class="chips">
        <span class="chip">Status: ${escapeHtml(record.status || "-")}</span>
        <span class="chip">Revision: ${escapeHtml(record.revision || "-")}</span>
        <span class="chip">Item ID: ${escapeHtml(record.item_id || "-")}</span>
      </div>
      ${renderRelatedPanel(state.detail.related || [], record.record_id)}
    </div>
    <div class="tabs">
      ${tabs.map((tab) => `
        <button class="tab ${state.activeTab === tab ? "active" : ""}" data-tab="${tab}" type="button">
          <span>${sectionLabels[tab]}</span>
          <strong>${formatNumber(tabCount(tab))}</strong>
        </button>
      `).join("")}
    </div>
    <div id="tabBody"></div>
  `;
  detail.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.activeTab = tab.dataset.tab;
      renderDetail();
    });
  });
  renderTabBody();
  attachRelatedLinks(detail);
}

function tabCount(tab) {
  if (!state.detail) return 0;
  if (tab === "overview") return 1;
  if (tab === "documents") return Math.max(state.detail.files?.length || 0, state.detail.sections?.documents?.length || 0);
  if (tab === "raw") return state.detail.raw && Object.keys(state.detail.raw).length ? 1 : 0;
  return state.detail.sections?.[tab]?.length || 0;
}

function sectionIntro(tab, count) {
  return `
    <div class="section-intro">
      <div>
        <h3>${escapeHtml(sectionLabels[tab])}</h3>
        <p>${escapeHtml(tabHelp[tab] || "")}</p>
      </div>
      <span>${formatNumber(count)} ${count === 1 ? "row" : "rows"}</span>
    </div>
  `;
}

function renderRelatedInline(items, currentId) {
  const siblings = items.filter((item) => item.record_id !== currentId);
  if (!siblings.length) return "";
  return `
    <div class="related-strip" aria-label="Related items">
      <span>Related</span>
      ${siblings.slice(0, 4).map((item) => `
        <button class="related-link" type="button" data-record-id="${item.record_id}">
          ${escapeHtml(item.relationship || item.type || "Related")}: ${escapeHtml(item.part_number)}
        </button>
      `).join("")}
    </div>
  `;
}

function renderRelatedPanel(items, currentId) {
  if (!items || items.length <= 1) return "";
  return `
    <section class="related-panel">
      <div class="related-panel-title">
        <h3>Related Items</h3>
        <span>${formatNumber(items.length)} linked records</span>
      </div>
      <div class="related-grid">
        ${items.map((item) => `
          <button class="related-card ${item.record_id === currentId ? "current" : ""}" type="button" data-record-id="${item.record_id}" ${item.record_id === currentId ? "disabled" : ""}>
            <span>${escapeHtml(item.relationship || item.type || "Related")}</span>
            <strong>${escapeHtml(item.part_number)}</strong>
            <small>${escapeHtml(item.description || item.platform || "")}</small>
          </button>
        `).join("")}
      </div>
    </section>
  `;
}

function attachRelatedLinks(root) {
  root.querySelectorAll(".related-link, .related-card").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const recordId = Number(button.dataset.recordId || 0);
      if (recordId) {
        selectRecord(recordId).catch((err) => {
          if (!isAbortError(err)) console.error(err);
        });
      }
    });
  });
}

function renderTabBody() {
  const body = $("tabBody");
  const detail = state.detail;
  const tab = state.activeTab;
  if (tab === "overview") {
    const record = detail.record;
    body.innerHTML = `
      ${sectionIntro("overview", 1)}
      <div class="field-grid">
        ${field("Platform", record.platform)}
        ${field("Part Number", record.part_number)}
        ${field("Description", record.description)}
        ${field("Type", record.type)}
        ${field("Category", record.category)}
        ${field("Status", record.status)}
        ${field("Revision", record.revision)}
      </div>
    `;
    attachItemLinks(body);
    return;
  }
  if (tab === "documents") {
    body.innerHTML = `${sectionIntro("documents", tabCount("documents"))}${renderDocumentRows()}`;
    attachItemLinks(body);
    attachDocumentDownloads(body);
    return;
  }
  if (tab === "raw") {
    body.innerHTML = `${sectionIntro("raw", tabCount("raw"))}<pre>${escapeHtml(JSON.stringify(detail.raw || {}, null, 2))}</pre>`;
    return;
  }
  body.innerHTML = `${sectionIntro(tab, tabCount(tab))}${renderSectionRows(tab)}`;
  attachItemLinks(body);
}

function normalizeFileName(value) {
  return String(value || "").trim().toLowerCase();
}

function documentRowForFile(doc, rows) {
  const name = normalizeFileName(doc.name);
  return rows.find((item) => {
    const row = item.row || {};
    return normalizeFileName(row.File) === name || normalizeFileName(row.Title) === name;
  });
}

function renderDocumentRows() {
  const docs = state.detail.files || [];
  const rows = state.detail.sections?.documents || [];
  const usedRows = new Set();
  const cards = docs.map((doc) => {
    const item = documentRowForFile(doc, rows);
    if (item) usedRows.add(item.section_row_id);
    return renderDocumentCard(doc, item?.row || {});
  });
  for (const item of rows) {
    if (usedRows.has(item.section_row_id)) continue;
    cards.push(renderDocumentCard(null, item.row || {}, item.title));
  }
  if (!cards.length) {
    return `<div class="empty-state compact"><h2>No Documents</h2><p>This item has no files or document metadata.</p></div>`;
  }
  return `<div class="section-list">${cards.join("")}</div>`;
}

function renderDocumentCard(doc, row, fallbackTitle = "") {
  const name = doc?.name || row.File || fallbackTitle || row.Title || "Document";
  const url = doc?.file_path ? `/api/file?path=${encodeURIComponent(doc.file_path)}` : "";
  const size = doc?.bytes ? `${formatNumber(doc.bytes)} bytes` : "";
  const type = row.Type || doc?.extension || "";
  const vault = row.Vault || "";
  const title = row.Title || "";
  const fields = orderedEntries("documents", row)
    .map(([key, value]) => linkedField("documents", row, key, value))
    .join("");
  return `
    <details class="row-card document-card">
      <summary class="row-card-title document-summary">
        <div class="summary-grid document-summary-grid">
          <span class="summary-main">
            <b>File</b>
            ${url
              ? `<a class="doc-download" href="${url}" target="_blank" rel="noreferrer">${highlight(name)}</a>`
              : highlight(name)}
          </span>
          ${title ? `<span><b>Title</b>${highlight(title)}</span>` : ""}
          ${type ? `<span><b>Type</b>${highlight(type)}</span>` : ""}
          ${vault ? `<span><b>Vault</b>${highlight(vault)}</span>` : ""}
          ${size ? `<span><b>Size</b>${escapeHtml(size)}</span>` : ""}
        </div>
        <span class="dropdown-cue">${formatNumber(orderedEntries("documents", row).length)} fields</span>
      </summary>
      <div class="field-grid">
        ${fields || field("File", name, "important")}
        ${size ? field("Size", size) : ""}
      </div>
    </details>
  `;
}

function attachDocumentDownloads(root) {
  root.querySelectorAll(".doc-download").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  });
}

function field(label, value, importance = "") {
  return `<div class="field ${importance}"><span>${escapeHtml(label)}</span><strong>${highlight(value || "-")}</strong></div>`;
}

function fieldImportance(section, label) {
  const important = {
    documents: ["File", "Title", "Type"],
    vendors: ["Vendor", "Part Number", "Status"],
    parts_list_bom: ["Part Number", "Description", "Qty", "Refdes"],
    where_used: ["BOM Part Number", "Description", "Refdes"],
    changes_ecos: ["Number", "Description", "Reason", "Status"],
  }[section] || [];
  return important.includes(label) ? "important" : "";
}

function orderedEntries(section, row) {
  const entries = Object.entries(row).filter(([key, value]) => {
    if (key.toLowerCase().endsWith("links")) return false;
    const text = typeof value === "object" ? flattenValue(value) : String(value ?? "");
    return text.trim() !== "";
  });
  const priority = fieldPriority[section] || [];
  return entries.sort(([left], [right]) => {
    const leftIndex = priority.indexOf(left);
    const rightIndex = priority.indexOf(right);
    const a = leftIndex === -1 ? 999 : leftIndex;
    const b = rightIndex === -1 ? 999 : rightIndex;
    if (a !== b) return a - b;
    return left.localeCompare(right);
  });
}

function linkedField(section, row, label, value) {
  const text = typeof value === "object" ? flattenValue(value) : String(value ?? "");
  const link = resolveLinkForField(section, row, label, text);
  if (!link) return field(label, text, fieldImportance(section, label));
  const attrs = [
    link.itemId ? `data-item-id="${escapeHtml(link.itemId)}"` : "",
    link.partNumber ? `data-part-number="${escapeHtml(link.partNumber)}"` : "",
  ].filter(Boolean).join(" ");
  return `
    <div class="field important">
      <span>${escapeHtml(label)}</span>
      <button class="item-link" type="button" ${attrs}>${highlight(text || "-")}</button>
    </div>
  `;
}

function resolveLinkForField(section, row, label, text) {
  const normalized = label.toLowerCase();
  const linkable = section === "parts_list_bom"
    ? normalized === "part number"
    : section === "where_used" && normalized === "bom part number";
  if (!linkable || !text.trim()) return null;
  const links = row[`${label} Links`] || row[`${label} links`] || [];
  const firstLink = Array.isArray(links) ? links[0] : null;
  const href = firstLink?.href || "";
  const idMatch = href.match(/[?&]id=(\d+)/i);
  return {
    itemId: idMatch ? idMatch[1] : "",
    partNumber: text.trim(),
  };
}

function attachItemLinks(root) {
  root.querySelectorAll(".item-link").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      button.disabled = true;
      const label = button.textContent;
      button.textContent = "Opening...";
      try {
        const params = new URLSearchParams({
          item_id: button.dataset.itemId || "",
          part_number: button.dataset.partNumber || "",
        });
        const payload = await api(`/api/resolve?${params}`);
        if (payload.found && payload.record?.record_id) {
          await selectRecord(Number(payload.record.record_id));
        } else {
          button.textContent = "Not indexed";
          setTimeout(() => {
            button.textContent = label;
            button.disabled = false;
          }, 1400);
        }
      } catch (err) {
        if (isAbortError(err)) {
          button.textContent = label;
          button.disabled = false;
          return;
        }
        console.error(err);
        button.textContent = "Open failed";
        setTimeout(() => {
          button.textContent = label;
          button.disabled = false;
        }, 1400);
      }
    });
  });
}

function renderSectionRows(section) {
  const rows = state.detail.sections?.[section] || [];
  if (!rows.length) {
    return `<div class="empty-state compact"><h2>No ${escapeHtml(sectionLabels[section])}</h2><p>This item has no rows in this topic.</p></div>`;
  }
  return `
    <div class="section-list">
      ${rows.map((item) => {
        const row = item.row || {};
        const fields = orderedEntries(section, row)
          .map(([key, value]) => linkedField(section, row, key, value))
          .join("");
        const summary = renderRowSummary(section, row, item.title);
        return `
          <details class="row-card">
            <summary class="row-card-title">
              ${summary}
              <span class="dropdown-cue">${formatNumber(orderedEntries(section, row).length)} fields</span>
            </summary>
            <div class="field-grid">${fields}</div>
          </details>
        `;
      }).join("")}
    </div>
  `;
}

function renderRowSummary(section, row, fallbackTitle) {
  const fields = summaryFields[section] || [];
  const chips = fields
    .map((label) => {
      const value = row[label];
      const text = typeof value === "object" ? flattenValue(value) : String(value ?? "");
      if (!text.trim()) return "";
      if (section === "parts_list_bom" && label === "Part Number") {
        return `<span class="summary-main">${linkedSummaryValue(section, row, label, text)}</span>`;
      }
      if (section === "where_used" && label === "BOM Part Number") {
        return `<span class="summary-main">${linkedSummaryValue(section, row, label, text)}</span>`;
      }
      const importance = ["File", "Title", "Vendor", "Number", "Description"].includes(label) ? "summary-main" : "";
      return `<span class="${importance}"><b>${escapeHtml(label)}</b>${highlight(text)}</span>`;
    })
    .filter(Boolean);
  if (!chips.length) {
    chips.push(`<span class="summary-main">${highlight(fallbackTitle || sectionLabels[section] || "")}</span>`);
  }
  return `<div class="summary-grid">${chips.join("")}</div>`;
}

function linkedSummaryValue(section, row, label, text) {
  const link = resolveLinkForField(section, row, label, text);
  if (!link) return `<b>${escapeHtml(label)}</b>${highlight(text)}`;
  const attrs = [
    link.itemId ? `data-item-id="${escapeHtml(link.itemId)}"` : "",
    link.partNumber ? `data-part-number="${escapeHtml(link.partNumber)}"` : "",
  ].filter(Boolean).join(" ");
  return `<b>${escapeHtml(label)}</b><button class="item-link inline" type="button" ${attrs}>${highlight(text)}</button>`;
}

function flattenValue(value) {
  if (Array.isArray(value)) return value.map(flattenValue).join(" ");
  if (value && typeof value === "object") return Object.entries(value).map(([k, v]) => `${k}: ${flattenValue(v)}`).join(" ");
  return String(value ?? "");
}

let timer = null;
function queueSearch() {
  clearTimeout(timer);
  timer = setTimeout(() => doSearch().catch((err) => {
    if (isAbortError(err)) return;
    $("resultCount").textContent = "Search failed";
    console.error(err);
  }), 300);
}

$("searchBtn").addEventListener("click", queueSearch);
$("searchBox").addEventListener("input", queueSearch);
$("platformFilter").addEventListener("change", queueSearch);
$("sectionFilter").addEventListener("change", queueSearch);
$("reindexBtn").addEventListener("click", async () => {
  $("resultCount").textContent = "Queued index rebuild";
  await api("/api/reindex", { method: "POST" });
  refreshStatus();
});

refreshStatus();
loadPlatforms().then(doSearch);
setInterval(refreshStatus, 3000);
