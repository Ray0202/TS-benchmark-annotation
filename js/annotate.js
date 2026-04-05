const configText = sessionStorage.getItem("annotationConfig");
const headerEl = document.getElementById("annotate-header");
const progressEl = document.getElementById("progress");
const contextEl = document.getElementById("context-panel");
const answerEl = document.getElementById("answer-panel");

if (!configText) {
  window.location.href = "index.html";
}

const config = JSON.parse(configText || "{}");

const state = {
  records: [],
  selectedItems: [],
  index: 0,
  answers: [],
  questionStartedAt: null,
};

function toFinite(v) {
  return Number.isFinite(v) ? v : null;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function extractEventInfo(item) {
  if (String(item.tier || "") === "T3") {
    return { lines: [], timestampText: null, dayRange: null };
  }
  const text = String(item.prompt || "");
  const lines = text.split("\n").map((x) => x.trim()).filter(Boolean);
  const eventLines = [];
  let inFutureEventBlock = false;
  let beforeFieldMeanings = true;
  for (const ln of lines) {
    const low = ln.toLowerCase();
    if (low.startsWith("field meanings")) {
      beforeFieldMeanings = false;
    }
    if (
      low.includes("upcoming event") ||
      low.includes("event context") ||
      low.includes("will occur soon") ||
      low.includes("future event")
    ) {
      inFutureEventBlock = true;
      eventLines.push(ln);
      continue;
    }
    if (inFutureEventBlock) {
      if (low.startsWith("field meaning") || low.startsWith("task:") || low.startsWith("questions:")) {
        inFutureEventBlock = false;
        continue;
      }
      if (ln.startsWith("-") || /^\d+\)/.test(ln) || low.includes("summary") || low.includes("medication")) {
        eventLines.push(ln);
      }
    }
    if (!inFutureEventBlock && beforeFieldMeanings && ln.startsWith("-")) {
      if (
        /(frontal|rainfall|holiday|event window|rebound|irradiance|wind|pressure gradient|hazy|suppressed|upcoming)/i.test(
          low
        )
      ) {
        eventLines.push(ln);
      }
    }
  }

  const eventText = eventLines.join(" ");
  const tsMatch = eventText.match(/\d{4}-\d{2}-\d{2}[T ][0-9:\-+Z]+/);
  const dayRangeMatch = eventText.match(/day[s]?\s*(\d+)\s*(?:[\-–—]|to)\s*(\d+)/i);
  const singleDayMatch = !dayRangeMatch ? eventText.match(/day\s*(\d+)/i) : null;
  const dayRange = dayRangeMatch
    ? { start: Number(dayRangeMatch[1]), end: Number(dayRangeMatch[2]) }
    : singleDayMatch
    ? { start: Number(singleDayMatch[1]), end: Number(singleDayMatch[1]) }
    : null;
  return {
    lines: Array.from(new Set(eventLines)),
    timestampText: tsMatch ? tsMatch[0] : null,
    dayRange,
  };
}

function renderPromptWithHighlights(item, eventInfo) {
  const lines = String(item.prompt || "").split("\n");
  const out = lines.map((ln) => {
    const escaped = escapeHtml(ln);
    if (eventInfo.lines.includes(ln.trim())) {
      return `<strong>${escaped}</strong>`;
    }
    return escaped;
  });
  return out.join("\n");
}

function toMillis(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

function formatTimestampLabel(v, withDate = false) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v >= 0 && v <= 23 && Number.isInteger(v)) {
      return `${String(v).padStart(2, "0")}:00`;
    }
    if (v >= 0 && v < 1440) {
      const total = Math.round(v);
      const hh = Math.floor(total / 60) % 24;
      const mm = total % 60;
      return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    }
    return String(Number(v.toFixed(2)));
  }
  const ms = toMillis(v);
  if (ms !== null) {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    if (!withDate) return `${hh}:${mm}`;
    const mon = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${mon}-${day} ${hh}:${mm}`;
  }
  return String(v).slice(0, 12);
}

function drawSeries(canvas, values, timestamps, eventInfo, color = "#0f6cbd") {
  const parentWidth = canvas.parentElement ? canvas.parentElement.clientWidth : 0;
  const width = Math.max(canvas.clientWidth, parentWidth - 8, 480);
  const height = Math.max(canvas.clientHeight, 170);
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  const clean = values
    .map((v, i) => ({ x: i, y: typeof v === "number" ? v : NaN }))
    .filter((p) => Number.isFinite(p.y));

  if (clean.length < 2) {
    ctx.fillStyle = "#8da2b5";
    ctx.font = "14px sans-serif";
    ctx.fillText("Insufficient data to draw", 12, 24);
    return;
  }

  const minY = Math.min(...clean.map((p) => p.y));
  const maxY = Math.max(...clean.map((p) => p.y));
  const yPad = Math.max((maxY - minY) * 0.08, 1e-6);
  const low = minY - yPad;
  const high = maxY + yPad;

  const left = 44;
  const right = width - 12;
  const top = 10;
  const bottom = height - 34;

  ctx.strokeStyle = "#64748b";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, bottom);
  ctx.lineTo(right, bottom);
  ctx.stroke();

  ctx.fillStyle = "#334155";
  ctx.font = "11px sans-serif";
  const yMinTxt = Number.isFinite(minY) ? String(Number(minY.toFixed(3))) : "";
  const yMaxTxt = Number.isFinite(maxY) ? String(Number(maxY.toFixed(3))) : "";
  if (yMaxTxt) ctx.fillText(yMaxTxt, 2, top + 10);
  if (yMinTxt) ctx.fillText(yMinTxt, 2, bottom + 2);

  const xScale = (x) => left + ((right - left) * x) / Math.max(values.length - 1, 1);
  const yScale = (y) => bottom - ((bottom - top) * (y - low)) / (high - low);

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  clean.forEach((point, idx) => {
    const px = xScale(point.x);
    const py = yScale(point.y);
    if (idx === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  });
  ctx.stroke();

  const tickCount = 5;
  const useDate = Array.isArray(timestamps) && timestamps.some((t) => toMillis(t) !== null);
  for (let i = 0; i < tickCount; i += 1) {
    const idx = Math.round((i * (values.length - 1)) / Math.max(tickCount - 1, 1));
    const x = xScale(idx);
    const raw = Array.isArray(timestamps) && timestamps.length > idx ? timestamps[idx] : idx;
    const label = formatTimestampLabel(raw, useDate && (i === 0 || i === tickCount - 1));
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, bottom);
    ctx.lineTo(x, bottom + 4);
    ctx.stroke();
    ctx.fillStyle = "#334155";
    ctx.font = "10px sans-serif";
    const w = ctx.measureText(label).width;
    ctx.fillText(label, Math.max(left, Math.min(right - w, x - w / 2)), bottom + 15);
  }

  const eventTs = eventInfo.timestampText ? toMillis(eventInfo.timestampText) : null;
  let markerX = null;
  let isFuture = false;
  let label = null;

  if (eventTs && Array.isArray(timestamps) && timestamps.length > 0) {
    const tsMillis = timestamps.map((t) => toMillis(t));
    const validTs = tsMillis.filter((x) => x !== null);
    if (validTs.length >= 2) {
      const minT = Math.min(...validTs);
      const maxT = Math.max(...validTs);
      if (eventTs > maxT) {
        markerX = right;
        isFuture = true;
      } else if (eventTs >= minT) {
        const ratio = (eventTs - minT) / Math.max(maxT - minT, 1);
        markerX = left + (right - left) * ratio;
      }
    }
  }

  if (markerX === null && eventInfo.dayRange) {
    markerX = right;
    isFuture = true;
    const d = eventInfo.dayRange;
    label = d.start === d.end ? `Event in future (Day ${d.start})` : `Event in future (Day ${d.start}-${d.end})`;
  }

  if (markerX === null && eventInfo.lines && eventInfo.lines.length > 0) {
    markerX = right;
    isFuture = true;
    label = "Event in future";
  }
  if (markerX === null) return;

  ctx.strokeStyle = "#cc2f2f";
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(markerX, top);
  ctx.lineTo(markerX, bottom);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#cc2f2f";
  ctx.beginPath();
  ctx.arc(markerX, top + 8, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = "12px sans-serif";
  if (isFuture) {
    const text = label || "Event in future";
    const textWidth = ctx.measureText(text).width;
    ctx.fillText(text, right - textWidth - 2, top + 16);
  } else {
    ctx.fillText("Event time", Math.max(left + 2, markerX - 26), top + 16);
  }
}

function mountSeriesCanvas(container, values, timestamps, eventInfo, color = "#0f6cbd") {
  const canvas = document.createElement("canvas");
  canvas.className = "ts-chart";
  container.append(canvas);
  requestAnimationFrame(() => drawSeries(canvas, values || [], timestamps || [], eventInfo, color));
}

function shuffle(array) {
  const out = [...array];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function getItemAnswer(itemId) {
  return state.answers.find((a) => a.itemId === itemId) || null;
}

function upsertAnswer(itemId, payload) {
  const idx = state.answers.findIndex((a) => a.itemId === itemId);
  if (idx >= 0) {
    state.answers[idx] = payload;
  } else {
    state.answers.push(payload);
  }
}

function buildSummary(answers) {
  const byQuestion = {};
  for (const rec of answers) {
    for (const [k, v] of Object.entries(rec.responses || {})) {
      if (!byQuestion[k]) {
        byQuestion[k] = {};
      }
      byQuestion[k][v] = (byQuestion[k][v] || 0) + 1;
    }
  }
  return byQuestion;
}

function triggerDownload(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildCsv(payload) {
  const rows = [
    ["annotator", "dataset", "item_id", "tier", "question_key", "answer", "time_spent_sec", "submitted_at"],
  ];

  for (const ans of payload.answers) {
    const base = [
      payload.annotatorName,
      payload.dataset,
      ans.itemId,
      ans.tier || "",
      "",
      "",
      String(toFinite(ans.timeSpentSec) ?? ""),
      ans.submittedAt || "",
    ];

    for (const [qKey, qVal] of Object.entries(ans.responses || {})) {
      const row = [...base];
      row[4] = qKey;
      row[5] = qVal;
      rows.push(row);
    }
  }

  return rows
    .map((r) =>
      r
        .map((cell) => {
          const s = String(cell ?? "").replace(/"/g, '""');
          return `"${s}"`;
        })
        .join(",")
    )
    .join("\n");
}

function renderFinish() {
  const summary = buildSummary(state.answers);

  contextEl.innerHTML = "";
  progressEl.textContent = `Completed ${state.answers.length} / ${state.selectedItems.length}`;

  const done = document.createElement("div");
  done.className = "summary";
  done.innerHTML = `<h3>Annotation Complete</h3><p>Download results, then return to the home page.</p>`;

  const stat = document.createElement("pre");
  stat.textContent = JSON.stringify(summary, null, 2);
  done.appendChild(stat);
  contextEl.appendChild(done);

  const payload = {
    annotatorName: config.annotatorName,
    dataset: config.dataset,
    requestedCount: config.requestedCount,
    actualCount: state.selectedItems.length,
    startedAt: config.startedAt,
    finishedAt: new Date().toISOString(),
    answers: state.answers,
    stats: summary,
  };

  answerEl.innerHTML = "";

  const downloadJsonBtn = document.createElement("button");
  downloadJsonBtn.className = "btn btn-primary";
  downloadJsonBtn.textContent = "Download JSON";
  downloadJsonBtn.onclick = () => {
    const filename = `${config.annotatorName}_${config.dataset}_annotations.json`;
    triggerDownload(filename, JSON.stringify(payload, null, 2), "application/json");
  };

  const downloadCsvBtn = document.createElement("button");
  downloadCsvBtn.className = "btn";
  downloadCsvBtn.textContent = "Download CSV";
  downloadCsvBtn.onclick = () => {
    const filename = `${config.annotatorName}_${config.dataset}_annotations.csv`;
    triggerDownload(filename, buildCsv(payload), "text/csv");
  };

  const backBtn = document.createElement("button");
  backBtn.className = "btn";
  backBtn.textContent = "Back to Home";
  backBtn.onclick = () => {
    sessionStorage.removeItem("annotationConfig");
    window.location.href = "index.html";
  };

  answerEl.append(downloadJsonBtn, downloadCsvBtn, backBtn);
}

function renderCurrent() {
  const item = state.selectedItems[state.index];
  if (!item) {
    renderFinish();
    return;
  }

  const existing = getItemAnswer(item.id);
  const existingResponses = (existing && existing.responses) || {};

  progressEl.textContent = `Progress ${state.index + 1} / ${state.selectedItems.length}`;
  contextEl.innerHTML = "";
  answerEl.innerHTML = "";

  const meta = document.createElement("div");
  meta.className = "muted";
  meta.textContent = `Sample ID: ${item.id} | Tier: ${item.tier || "N/A"} | Dataset: ${item.source_dataset}`;
  contextEl.append(meta);

  const eventInfo = extractEventInfo(item);
  const historicalEvents = Array.isArray(item.historical_events) ? item.historical_events : [];

  if (historicalEvents.length > 0) {
    const histBox = document.createElement("section");
    histBox.className = "prompt-box";
    histBox.innerHTML = `<h3>Historical Events</h3><pre>${escapeHtml(historicalEvents.join("\n"))}</pre>`;
    contextEl.append(histBox);
  }

  if (eventInfo.lines.length > 0) {
    const eventBox = document.createElement("section");
    eventBox.className = "prompt-box";
    eventBox.innerHTML = `<h3>Detected Future Event</h3><pre>${escapeHtml(eventInfo.lines.join("\n"))}</pre>`;
    contextEl.append(eventBox);
  }

  const promptBox = document.createElement("section");
  promptBox.className = "prompt-box";
  promptBox.innerHTML = `<h3>Task Description</h3><pre>${renderPromptWithHighlights(item, eventInfo) || "N/A"}</pre>`;
  contextEl.append(promptBox);

  const chartGrid = document.createElement("section");
  chartGrid.className = "chart-grid";

  const histBlock = document.createElement("div");
  histBlock.className = "chart-block";
  histBlock.innerHTML = `<h4>Historical Series (${(item.history || {}).key || "target"})</h4>`;
  const histValues = ((item.history || {}).values) || [];
  const histTimestamps = ((item.history || {}).timestamps) || [];
  mountSeriesCanvas(histBlock, histValues, histTimestamps, eventInfo);
  chartGrid.append(histBlock);

  const covariates = (((item.history_covariates || {}).covariates) || {});
  const covNames = Object.keys(covariates);
  if (covNames.length > 0) {
    const covDetails = document.createElement("details");
    covDetails.className = "chart-block";
    const summary = document.createElement("summary");
    summary.textContent = `Show Covariates (${covNames.length})`;
    covDetails.append(summary);
    for (const covName of covNames) {
      const covBlock = document.createElement("div");
      covBlock.className = "chart-block";
      covBlock.innerHTML = `<h4>Covariate: ${covName}</h4>`;

      mountSeriesCanvas(
        covBlock,
        covariates[covName] || [],
        ((item.history_covariates || {}).timestamps) || [],
        eventInfo,
        "#b55300"
      );
      covDetails.append(covBlock);
    }
    chartGrid.append(covDetails);
  }
  contextEl.append(chartGrid);

  const form = document.createElement("form");
  form.id = "question-form";
  form.className = "question-panel";

  const mcqList = Array.isArray(item.mcq) ? item.mcq : [];
  for (const [qIndex, q] of mcqList.entries()) {
    const block = document.createElement("fieldset");
    block.className = "mcq-block";

    const qKey = q.key || `q${qIndex + 1}`;
    const legend = document.createElement("legend");
    legend.textContent = `${qIndex + 1}. ${q.question}`;
    block.append(legend);

    const hasOptions = Array.isArray(q.options) && q.options.length > 1;
    if (hasOptions) {
      const optionsWrap = document.createElement("div");
      optionsWrap.className = "option-list";
      for (const optionText of q.options || []) {
        const optionId = `${item.id}_${qKey}_${optionText}`.replace(/[^a-zA-Z0-9_\-]/g, "_");
        const label = document.createElement("label");
        label.className = "option";

        const input = document.createElement("input");
        input.type = "radio";
        input.name = qKey;
        input.value = optionText;
        input.id = optionId;
        input.required = true;
        if (existingResponses[qKey] === optionText) {
          input.checked = true;
        }

        const text = document.createElement("span");
        text.textContent = optionText;

        label.append(input, text);
        optionsWrap.append(label);
      }
      block.append(optionsWrap);
    } else {
      const txt = document.createElement("textarea");
      txt.name = qKey;
      txt.rows = 3;
      txt.required = true;
      txt.placeholder = "Enter your selected answer";
      txt.value = existingResponses[qKey] || "";
      block.append(txt);
    }
    form.append(block);
  }

  const answerTitle = document.createElement("h3");
  answerTitle.textContent = "Questions";
  answerEl.append(answerTitle, form);

  const saveAndNextBtn = document.createElement("button");
  saveAndNextBtn.type = "button";
  saveAndNextBtn.className = "btn btn-primary";
  saveAndNextBtn.textContent = state.index === state.selectedItems.length - 1 ? "Submit & Finish" : "Save & Next";

  saveAndNextBtn.onclick = () => {
    const formData = new FormData(form);
    const responses = {};
    const missing = [];

    for (const q of mcqList) {
      const qKey = q.key;
      const answer = String(formData.get(qKey) || "").trim();
      if (!answer) {
        missing.push(qKey);
      } else {
        responses[qKey] = answer;
      }
    }

    if (missing.length > 0) {
      alert("Please answer all questions before continuing.");
      return;
    }

    const submittedAt = new Date().toISOString();
    const started = existing?.startedAt || state.questionStartedAt || submittedAt;
    const timeSpentSec = Math.max(0, (Date.parse(submittedAt) - Date.parse(started)) / 1000);

    upsertAnswer(item.id, {
      itemId: item.id,
      tier: item.tier,
      sourceDataset: item.source_dataset,
      responses,
      startedAt: started,
      submittedAt,
      timeSpentSec,
    });

    state.index += 1;
    state.questionStartedAt = new Date().toISOString();
    renderCurrent();
  };

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "btn";
  prevBtn.textContent = "Previous";
  prevBtn.disabled = state.index === 0;
  prevBtn.onclick = () => {
    if (state.index > 0) {
      state.index -= 1;
      state.questionStartedAt = new Date().toISOString();
      renderCurrent();
    }
  };

  const actionRow = document.createElement("div");
  actionRow.className = "row actions";
  actionRow.append(prevBtn, saveAndNextBtn);
  answerEl.append(actionRow);
}

async function init() {
  if (!config.annotatorName || !config.datasetFile || !config.dataset) {
    window.location.href = "index.html";
    return;
  }

  headerEl.innerHTML = `
    <strong>Annotator: ${config.annotatorName}</strong>
    <span class="muted">Dataset: ${config.dataset} | Tier: ${(config.selectedTiers || []).join(", ")}</span>
  `;

  try {
    const res = await fetch(config.datasetFile, { cache: "no-store" });
    if (!res.ok) {
      contextEl.innerHTML = `<p>Failed to load dataset: ${res.status}</p>`;
      return;
    }

    const records = await res.json();
    const allRecords = Array.isArray(records) ? records : [];
    const selectedTiers = (Array.isArray(config.selectedTiers) ? config.selectedTiers : ["T3", "T4"]).filter(
      (x) => x === "T3" || x === "T4"
    );
    state.records = allRecords.filter(
      (r) => Array.isArray(r.mcq) && r.mcq.length > 0 && selectedTiers.includes(String(r.tier || ""))
    );

    if (state.records.length === 0) {
      const availableTiers = Array.from(new Set(allRecords.map((r) => String(r.tier || "")).filter(Boolean))).join(", ");
      contextEl.innerHTML = `<p>No items under selected tier(s). Selected: ${selectedTiers.join(
        ", "
      )}. Available tiers in this dataset: ${availableTiers || "None"}.</p>`;
      return;
    }

    const count = Math.min(config.annotationCount || 1, state.records.length);
    state.selectedItems = shuffle(state.records).slice(0, count);
    state.questionStartedAt = new Date().toISOString();
    renderCurrent();
  } catch (err) {
    contextEl.innerHTML = `<p>Load error: ${escapeHtml(err?.message || String(err))}</p>`;
  }
}

init();
