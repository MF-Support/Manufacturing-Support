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
  session: null,
};

const SUPABASE_URL = "https://vqnstcikpeyardzupyoo.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZxbnN0Y2lrcGV5YXJkenVweW9vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxMDM5NjYsImV4cCI6MjA5NDY3OTk2Nn0.OZexHd5bKNkiUctKQkuIo61IlyCqyskOIVs1KphgfHU";
const STORAGE_BUCKET = "manufacturing-documents";
const SESSION_KEY = "manufacturing_support_session";

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
const isLoginPage = Boolean($("loginScreen"));
const isAppPage = Boolean($("appShell"));

function appUrl() {
  return new URL("app.html", window.location.href).toString();
}

function loginUrl() {
  return new URL("index.html", window.location.href).toString();
}

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

function authToken() {
  return state.session?.access_token || SUPABASE_ANON_KEY;
}

async function supabaseFetch(path, options = {}) {
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${authToken()}`,
    ...(options.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...options, headers });
  if (!res.ok) throw new Error(await res.text());
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function signIn(email, password) {
  const payload = await supabaseFetch("/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  state.session = payload;
  localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  renderAuth();
  if (isLoginPage) {
    window.location.assign(appUrl());
    return;
  }
  if (isAppPage) {
    await loadPlatforms();
    await doSearch();
  }
}

function signOut() {
  state.session = null;
  localStorage.removeItem(SESSION_KEY);
  state.records = [];
  state.detail = null;
  state.selected = null;
  renderAuth();
  if (isAppPage) {
    window.location.assign(loginUrl());
  }
}

function loadSession() {
  try {
    state.session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    state.session = null;
  }
}

function renderAuth() {
  const authed = Boolean(state.session?.access_token);
  if (isLoginPage) {
    if (authed) {
      window.location.replace(appUrl());
      return;
    }
    $("loginMessage").textContent = "Use your approved Supabase account.";
    return;
  }
  if (isAppPage && !authed) {
    window.location.replace(loginUrl());
    return;
  }
  if (isAppPage) {
    $("appShell").hidden = false;
    $("indexStatus").textContent = "Connected to Supabase";
  }
}

function isAbortError(err) {
  return err && (err.name === "AbortError" || String(err.message || "").includes("aborted"));
}

async function refreshStatus() {
  renderAuth();
}

async function loadPlatforms() {
  if (!state.session?.access_token) return;
  try {
    const platforms = await supabaseFetch("/rest/v1/platforms?select=id,name&order=name.asc");
    state.platforms = platforms || [];
    const select = $("platformFilter");
    select.innerHTML = '<option value="">All platforms</option>';
    for (const platform of state.platforms) {
      const option = document.createElement("option");
      option.value = String(platform.id);
      option.textContent = platform.name;
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

function escapePostgrestText(value) {
  return String(value || "").replaceAll("*", " ").replaceAll(",", " ").trim();
}

function itemSelect() {
  return "id,platform_id,item_id,part_number,description,type,category,status,revision,related_family_key,raw,platforms(name)";
}

function mapItem(row) {
  return {
    record_id: row.id,
    id: row.id,
    platform_id: row.platform_id,
    platform: row.platforms?.name || "Unknown",
    item_id: row.item_id || "",
    part_number: row.part_number || "",
    description: row.description || "",
    type: row.type || "",
    category: row.category || "",
    status: row.status || "",
    revision: row.revision || "",
    related_family_key: row.related_family_key || "",
    raw: row.raw || {},
    document_count: 0,
    vendor_count: 0,
    bom_count: 0,
    where_used_count: 0,
    eco_count: 0,
  };
}

function countFieldForSection(section) {
  return sectionCountFields[section] || "";
}

async function fetchItemsByIds(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  const rows = await supabaseFetch(`/rest/v1/items?select=${itemSelect()}&id=in.(${unique.join(",")})`);
  return (rows || []).map(mapItem);
}

async function attachCounts(records) {
  const ids = records.map((record) => record.record_id);
  if (!ids.length) return records;
  const idList = ids.join(",");
  const sectionRows = await supabaseFetch(`/rest/v1/section_rows?select=item_id,section&item_id=in.(${idList})`);
  const docs = await supabaseFetch(`/rest/v1/documents?select=item_id&item_id=in.(${idList})`);
  const byId = Object.fromEntries(records.map((record) => [record.record_id, record]));
  for (const row of sectionRows || []) {
    const record = byId[row.item_id];
    const fieldName = countFieldForSection(row.section);
    if (record && fieldName) record[fieldName] = Number(record[fieldName] || 0) + 1;
  }
  for (const doc of docs || []) {
    const record = byId[doc.item_id];
    if (record) record.document_count = Number(record.document_count || 0) + 1;
  }
  return records;
}

function rankRecords(records, query) {
  const normalized = query.toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]+/g, "");
  return records.sort((left, right) => {
    const lp = String(left.part_number || "").toLowerCase();
    const rp = String(right.part_number || "").toLowerCase();
    const ld = String(left.description || "").toLowerCase();
    const rd = String(right.description || "").toLowerCase();
    const score = (record, part, desc) => {
      const partCompact = part.replace(/[^a-z0-9]+/g, "");
      if (part === normalized) return 0;
      if (partCompact === compact) return 1;
      if (desc === normalized) return 2;
      if (part.startsWith(normalized)) return 3;
      if (part.includes(normalized)) return 4;
      if (desc.includes(normalized)) return 5;
      return 9;
    };
    return score(left, lp, ld) - score(right, rp, rd) || lp.localeCompare(rp) || ld.localeCompare(rd);
  });
}

function makeHit(row, section) {
  return {
    record_id: row.item_id,
    section,
    title: row.title || "",
    body: row.body || "",
    trail: [state.query, sectionLabels[section] || section],
  };
}

async function signedStorageUrl(storagePath) {
  if (!storagePath) return "";
  const encodedPath = storagePath.split("/").map(encodeURIComponent).join("/");
  const payload = await supabaseFetch(`/storage/v1/object/sign/${encodeURIComponent(STORAGE_BUCKET)}/${encodedPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  const signed = payload?.signedURL || payload?.signedUrl || "";
  return signed ? `${SUPABASE_URL}${signed}` : "";
}

async function fetchDetail(recordId) {
  const rows = await supabaseFetch(`/rest/v1/items?select=${itemSelect()}&id=eq.${encodeURIComponent(recordId)}&limit=1`);
  if (!rows?.length) throw new Error("Item not found");
  const record = mapItem(rows[0]);
  const [sectionRows, documents, relatedRows] = await Promise.all([
    supabaseFetch(`/rest/v1/section_rows?select=id,section,title,body,row_data&item_id=eq.${encodeURIComponent(recordId)}&order=section.asc`),
    supabaseFetch(`/rest/v1/documents?select=id,file_name,title,document_type,vault,storage_path,metadata&item_id=eq.${encodeURIComponent(recordId)}&order=file_name.asc`),
    record.related_family_key
      ? supabaseFetch(`/rest/v1/items?select=${itemSelect()}&related_family_key=eq.${encodeURIComponent(record.related_family_key)}&limit=18`)
      : Promise.resolve([]),
  ]);
  const sections = { documents: [], vendors: [], parts_list_bom: [], where_used: [], changes_ecos: [] };
  for (const row of sectionRows || []) {
    if (!sections[row.section]) sections[row.section] = [];
    sections[row.section].push({
      section_row_id: row.id,
      title: row.title,
      body: row.body,
      row: row.row_data || {},
    });
  }
  const files = [];
  for (const doc of documents || []) {
    const metadata = doc.metadata || {};
    const name = doc.file_name || metadata.name || "Document";
    files.push({
      id: doc.id,
      name,
      title: doc.title || "",
      type: doc.document_type || "",
      vault: doc.vault || "",
      bytes: metadata.bytes || 0,
      extension: String(name).split(".").pop() || "",
      storage_path: doc.storage_path || "",
      file_path: doc.storage_path ? await signedStorageUrl(doc.storage_path) : "",
      upload_skipped_reason: metadata.upload_skipped_reason || "",
    });
  }
  const related = (relatedRows || []).map((row) => ({
    ...mapItem(row),
    relationship: row.id === recordId ? "Current item" : "Related",
  }));
  return { record, sections, files, related, raw: record.raw || {} };
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
  if (!state.session?.access_token) {
    $("resultCount").textContent = "Sign in to search";
    return;
  }
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
  $("resultCount").textContent = "Searching...";
  const safeQuery = escapePostgrestText(query);
  const platformClause = platform ? `&platform_id=eq.${encodeURIComponent(platform)}` : "";
  let records = [];
  let hits = [];
  if (!safeQuery) {
    records = (await supabaseFetch(`/rest/v1/items?select=${itemSelect()}${platformClause}&order=part_number.asc&limit=90`)).map(mapItem);
  } else {
    const like = `*${encodeURIComponent(safeQuery)}*`;
    const itemRows = await supabaseFetch(
      `/rest/v1/items?select=${itemSelect()}${platformClause}&or=(part_number.ilike.${like},description.ilike.${like},type.ilike.${like},category.ilike.${like})&limit=90`
    );
    const itemMap = new Map((itemRows || []).map((row) => [row.id, mapItem(row)]));
    const sectionFilter = section !== "all" && section !== "documents" ? `&section=eq.${encodeURIComponent(section)}` : "";
    if (section === "all" || section !== "documents") {
      const sectionRows = await supabaseFetch(
        `/rest/v1/section_rows?select=item_id,section,title,body${sectionFilter}&or=(title.ilike.${like},body.ilike.${like})&limit=240`
      );
      hits = (sectionRows || []).map((row) => makeHit(row, row.section));
      const found = await fetchItemsByIds(hits.map((hit) => hit.record_id).filter((id) => !itemMap.has(id)));
      for (const record of found) itemMap.set(record.record_id, record);
    }
    if (section === "all" || section === "documents") {
      const docs = await supabaseFetch(
        `/rest/v1/documents?select=item_id,file_name,title,document_type&or=(file_name.ilike.${like},title.ilike.${like},document_type.ilike.${like})&limit=180`
      );
      hits.push(...(docs || []).map((doc) => ({
        record_id: doc.item_id,
        section: "documents",
        title: doc.title || doc.file_name || "",
        body: [doc.file_name, doc.document_type].filter(Boolean).join(" "),
        trail: [state.query, "Documents"],
      })));
      const found = await fetchItemsByIds((docs || []).map((doc) => doc.item_id).filter((id) => !itemMap.has(id)));
      for (const record of found) itemMap.set(record.record_id, record);
    }
    records = rankRecords([...itemMap.values()], query).slice(0, 90);
  }
  if (requestId !== state.searchRequestId) return;
  state.records = await attachCounts(records);
  state.hits = hits;
  const platformLabel = state.platforms.find((item) => String(item.id) === platform)?.name || "All platforms";
  $("resultCount").textContent = `${formatNumber(state.records.length)} matching items`;
  $("activeTrail").textContent = [query || "Browse", platformLabel, sectionLabels[section] || "All topics"].join(" / ");
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
  const payload = await fetchDetail(recordId);
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
  const url = doc?.file_path || "";
  const size = doc?.bytes ? `${formatNumber(doc.bytes)} bytes` : "";
  const type = row.Type || doc?.type || doc?.extension || "";
  const vault = row.Vault || doc?.vault || "";
  const title = row.Title || doc?.title || "";
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
        ${doc?.upload_skipped_reason ? field("Upload status", doc.upload_skipped_reason) : ""}
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
        const payload = await resolveItem(params.get("item_id"), params.get("part_number"));
        if (payload?.record_id) {
          await selectRecord(Number(payload.record_id));
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

async function resolveItem(itemId, partNumber) {
  if (itemId) {
    const rows = await supabaseFetch(`/rest/v1/items?select=${itemSelect()}&item_id=eq.${encodeURIComponent(itemId)}&limit=1`);
    if (rows?.length) return mapItem(rows[0]);
  }
  if (partNumber) {
    const rows = await supabaseFetch(`/rest/v1/items?select=${itemSelect()}&part_number=ilike.${encodeURIComponent(partNumber)}&limit=1`);
    if (rows?.length) return mapItem(rows[0]);
  }
  return null;
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

loadSession();
refreshStatus();

if (isLoginPage) {
  $("authForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("loginMessage").textContent = "Signing in...";
    try {
      await signIn($("emailInput").value.trim(), $("passwordInput").value);
      $("passwordInput").value = "";
    } catch (err) {
      console.error(err);
      $("loginMessage").textContent = "Sign in failed. Check the email and password.";
    }
  });
}

if (isAppPage) {
  $("searchBtn").addEventListener("click", queueSearch);
  $("searchBox").addEventListener("input", queueSearch);
  $("platformFilter").addEventListener("change", queueSearch);
  $("sectionFilter").addEventListener("change", queueSearch);
  $("logoutBtn").addEventListener("click", signOut);
}

if (isAppPage && state.session?.access_token) {
  loadPlatforms().then(doSearch).catch((err) => {
    console.error(err);
    $("resultCount").textContent = "Supabase connection failed";
  });
} else if (isLoginPage) {
  $("loginMessage").textContent = "Use your approved Supabase account.";
}
