const formEl = document.getElementById("examples-form");
const datasetEl = document.getElementById("examples-dataset");
const tierEl = document.getElementById("examples-tier");
const countEl = document.getElementById("examples-count");
const msgEl = document.getElementById("examples-message");
const progressEl = document.getElementById("examples-progress");
const contextEl = document.getElementById("examples-context");
const answerEl = document.getElementById("examples-answer");

const state = {
  catalog: [],
  items: [],
  index: 0,
};

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function toMillis(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

function formatTimestampLabel(v, withDate = false) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v >= 0 && v <= 23 && Number.isInteger(v)) return `${String(v).padStart(2, "0")}:00`;
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

function extractEventInfo(item) {
  if (String(item.tier || "") === "T3") return { lines: [], timestampText: null, dayRange: null };

  const lines = String(item.prompt || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const eventLines = [];
  let inFutureEventBlock = false;
  let beforeFieldMeanings = true;

  for (const ln of lines) {
    const low = ln.toLowerCase();
    if (low.startsWith("field meanings")) beforeFieldMeanings = false;

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
      if (/(frontal|rainfall|holiday|event window|rebound|irradiance|wind|pressure gradient|hazy|suppressed|upcoming)/i.test(low)) {
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
    if (eventInfo.lines.includes(ln.trim())) return `<strong>${escaped}</strong>`;
    return escaped;
  });
  return out.join("\n");
}

function drawSeries(canvas, values, timestamps, eventInfo, color = "#0f6cbd") {
  const parentWidth = canvas.parentElement ? canvas.parentElement.clientWidth : 0;
  const width = Math.max(canvas.clientWidth, parentWidth - 8, 480);
  const height = Math.max(canvas.clientHeight, 170);
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  const clean = (values || [])
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
  ctx.fillText(String(Number(minY.toFixed(3))), 2, bottom + 2);
  ctx.fillText(String(Number(maxY.toFixed(3))), 2, top + 10);

  const xScale = (x) => left + ((right - left) * x) / Math.max((values || []).length - 1, 1);
  const yScale = (y) => bottom - ((bottom - top) * (y - low)) / (high - low);

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  clean.forEach((point, idx) => {
    const px = xScale(point.x);
    const py = yScale(point.y);
    if (idx === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  const tickCount = 5;
  const useDate = Array.isArray(timestamps) && timestamps.some((t) => toMillis(t) !== null);
  for (let i = 0; i < tickCount; i += 1) {
    const idx = Math.round((i * ((values || []).length - 1)) / Math.max(tickCount - 1, 1));
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

function renderCurrent() {
  const item = state.items[state.index];
  if (!item) {
    contextEl.innerHTML = "";
    answerEl.innerHTML = "";
    progressEl.textContent = "";
    return;
  }

  progressEl.textContent = `Example ${state.index + 1} / ${state.items.length}`;
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
  mountSeriesCanvas(histBlock, (item.history || {}).values || [], (item.history || {}).timestamps || [], eventInfo);
  chartGrid.append(histBlock);

  const covariates = ((item.history_covariates || {}).covariates) || {};
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
        (item.history_covariates || {}).timestamps || [],
        eventInfo,
        "#b55300"
      );
      covDetails.append(covBlock);
    }
    chartGrid.append(covDetails);
  }

  contextEl.append(chartGrid);

  const title = document.createElement("h3");
  title.textContent = "Questions and Reference Answers";
  answerEl.append(title);

  const mcqList = Array.isArray(item.mcq) ? item.mcq : [];
  const refs = item.reference_answers || {};

  mcqList.forEach((q, idx) => {
    const qKey = q.key || `q${idx + 1}`;
    const correct = refs[qKey] || "";

    const block = document.createElement("fieldset");
    block.className = "mcq-block";

    const legend = document.createElement("legend");
    legend.textContent = `${idx + 1}. ${q.question || qKey}`;
    block.append(legend);

    const opts = Array.isArray(q.options) ? q.options : [];
    if (opts.length > 0) {
      const optionsWrap = document.createElement("div");
      optionsWrap.className = "option-list";

      opts.forEach((optionText) => {
        const option = document.createElement("div");
        option.className = "option";
        const isCorrect = String(optionText).trim() === String(correct).trim();
        if (isCorrect) option.classList.add("correct");

        option.innerHTML = `<span>${escapeHtml(optionText)}</span>`;
        optionsWrap.append(option);
      });

      block.append(optionsWrap);
    }

    const answerKey = document.createElement("div");
    answerKey.className = "answer-key";
    answerKey.textContent = `Correct answer: ${correct || "N/A"}`;
    block.append(answerKey);

    answerEl.append(block);
  });

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "btn";
  prevBtn.textContent = "Previous";
  prevBtn.disabled = state.index === 0;
  prevBtn.onclick = () => {
    if (state.index > 0) {
      state.index -= 1;
      renderCurrent();
    }
  };

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "btn btn-primary";
  nextBtn.textContent = state.index === state.items.length - 1 ? "Restart" : "Next";
  nextBtn.onclick = () => {
    if (state.index < state.items.length - 1) {
      state.index += 1;
    } else {
      state.index = 0;
    }
    renderCurrent();
  };

  const actionRow = document.createElement("div");
  actionRow.className = "row actions";
  actionRow.append(prevBtn, nextBtn);
  answerEl.append(actionRow);
}

async function loadCatalog() {
  try {
    const res = await fetch("data/examples/catalog.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load examples catalog: ${res.status}`);

    const catalog = await res.json();
    state.catalog = Array.isArray(catalog) ? catalog : [];
    datasetEl.innerHTML = "";

    if (state.catalog.length === 0) {
      datasetEl.innerHTML = '<option value="">No example dataset available</option>';
      return;
    }

    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "Select a dataset";
    datasetEl.append(defaultOption);

    state.catalog.forEach((ds) => {
      const option = document.createElement("option");
      option.value = ds.dataset;
      option.textContent = `${ds.dataset} (${ds.count})`;
      option.dataset.file = ds.file;
      option.dataset.count = String(ds.count || 0);
      datasetEl.append(option);
    });
  } catch (err) {
    datasetEl.innerHTML = '<option value="">Load failed</option>';
    msgEl.textContent = err.message;
  }
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  msgEl.textContent = "";

  const datasetName = String(datasetEl.value || "").trim();
  const tier = String(tierEl.value || "T3").trim();
  const count = Math.max(1, Math.floor(Number(countEl.value || 1)));
  const option = datasetEl.options[datasetEl.selectedIndex];

  if (!datasetName || !option || !option.dataset.file) {
    msgEl.textContent = "Please select a valid dataset.";
    return;
  }

  try {
    const res = await fetch(option.dataset.file, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load examples dataset: ${res.status}`);

    const rows = await res.json();
    const allRows = Array.isArray(rows) ? rows : [];
    const filtered = allRows.filter((r) => {
      const mcq = Array.isArray(r.mcq) ? r.mcq : [];
      const refs = r.reference_answers || {};
      return String(r.tier || "") === tier && mcq.length > 0 && Object.keys(refs).length > 0;
    });

    if (filtered.length === 0) {
      progressEl.textContent = "";
      contextEl.innerHTML = `<p>No examples in tier ${tier} for selected dataset.</p>`;
      answerEl.innerHTML = "";
      return;
    }

    state.items = shuffle(filtered).slice(0, Math.min(count, filtered.length));
    state.index = 0;
    renderCurrent();
  } catch (err) {
    progressEl.textContent = "";
    contextEl.innerHTML = `<p>Load error: ${escapeHtml(err?.message || String(err))}</p>`;
    answerEl.innerHTML = "";
  }
});

loadCatalog();
