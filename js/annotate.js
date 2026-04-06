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
  cheatMode: false,
};
const MAX_PLOT_POINTS = 180;
const CHEAT_PASSWORD = "0302";

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
  if (typeof ts !== "string") return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

function parseEventTimestampFromPrompt(promptText) {
  const m = String(promptText || "").match(/\d{4}-\d{2}-\d{2}[T ][0-9:\-+Z]+/);
  if (!m) return null;
  const s = m[0].replace(" ", "T");
  return toMillis(s);
}

function parsePsmlStartMs(sampleId) {
  const raw = String(sampleId || "");
  const m = raw.match(/:(\d{10})->(\d{10})$/);
  if (!m) return null;
  const start = m[1];
  const y = Number(start.slice(0, 4));
  const mo = Number(start.slice(4, 6));
  const d = Number(start.slice(6, 8));
  const h = Number(start.slice(8, 10));
  if (![y, mo, d, h].every((x) => Number.isFinite(x))) return null;
  return Date.UTC(y, mo - 1, d, h, 0, 0);
}

function getBaseDateFromItem(item) {
  const raw = String((item && (item.sample_id || item.id)) || "");
  const m = raw.match(/(\d{4})-(\d{2})-(\d{2})T/);
  if (!m) return null;
  const y = Number(m[1]);
  const mon = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mon) || !Number.isFinite(d)) return null;
  return { y, mon, d };
}

function isMinuteOfDaySeries(ts) {
  if (!Array.isArray(ts) || ts.length < 2) return false;
  return ts.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1439);
}

function unwrapMinuteOfDay(ts) {
  const out = [];
  let dayOffset = 0;
  let prev = null;
  for (const v of ts) {
    const minute = Number(v);
    if (prev !== null && minute < prev - 720) dayOffset += 1;
    out.push(minute + dayOffset * 1440);
    prev = minute;
  }
  return out;
}

function inferMinuteStep(ts) {
  const deltas = [];
  for (let i = 1; i < ts.length; i += 1) {
    const prev = Number(ts[i - 1]);
    const curr = Number(ts[i]);
    if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue;
    let d = curr - prev;
    if (d <= 0) d += 1440;
    if (d > 0 && d <= 720) deltas.push(d);
  }
  if (deltas.length === 0) return 60;
  const sorted = [...deltas].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 60;
}

function buildDisplayTimestamps(item, timestamps) {
  const ts = Array.isArray(timestamps) ? timestamps : [];
  if (ts.length === 0) return ts;

  if (ts.some((v) => typeof v === "string" && toMillis(v) !== null)) {
    return ts;
  }

  const ds = String((item && item.source_dataset) || "");
  if (ds === "freshretailnet" && ts.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)) {
    const out = [];
    let day = 0;
    let prev = null;
    let prevOut = null;
    const dayStartMinute = 6 * 60;
    const dayEndMinute = 22 * 60;
    const activeSpanMinute = dayEndMinute - dayStartMinute;
    for (const v of ts) {
      const curr = Number(v);
      if (prev !== null && curr < prev - 0.5) day += 1;
      // Freshretailnet slots represent the active retail window (06:00-22:00).
      let minuteInDay = Math.round(dayStartMinute + curr * activeSpanMinute);
      if (minuteInDay > dayEndMinute) minuteInDay = dayEndMinute;
      let absMinute = day * 1440 + minuteInDay;
      if (prevOut !== null && absMinute <= prevOut) absMinute = prevOut + 1;
      out.push(absMinute);
      prev = curr;
      prevOut = absMinute;
    }
    return out;
  }

  if (ds === "PSML" && ts.every((v) => typeof v === "number" && Number.isFinite(v))) {
    const startMs = parsePsmlStartMs(item && (item.sample_id || item.id));
    if (Number.isFinite(startMs)) {
      const out = [];
      let dayOffsetHours = 0;
      let prevHour = null;
      for (let i = 0; i < ts.length; i += 1) {
        const idx = Number(ts[i]);
        const currHour = Number.isFinite(idx) ? idx : i;
        if (prevHour !== null && currHour < prevHour - 12) {
          dayOffsetHours += 24;
        }
        const hourOffset = currHour + dayOffsetHours;
        out.push(new Date(startMs + hourOffset * 3600 * 1000).toISOString());
        prevHour = currHour;
      }
      return out;
    }
  }

  if (ds === "MIMIC" && isMinuteOfDaySeries(ts)) {
    const stepMin = inferMinuteStep(ts);
    const base = getBaseDateFromItem(item);
    let endMs = base ? Date.UTC(base.y, base.mon - 1, base.d, 0, 0, 0) : Date.now();
    const eventMs = parseEventTimestampFromPrompt(item && item.prompt);
    if (String(item && item.tier) === "T4" && Number.isFinite(eventMs)) {
      endMs = eventMs - stepMin * 60 * 1000;
    }
    const n = ts.length;
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const t = endMs - (n - 1 - i) * stepMin * 60 * 1000;
      out.push(new Date(t).toISOString());
    }
    return out;
  }

  if (isMinuteOfDaySeries(ts)) {
    return unwrapMinuteOfDay(ts);
  }
  return ts;
}

function normalizeSeriesLength(values, timestamps, maxPoints = MAX_PLOT_POINTS) {
  const vals = Array.isArray(values) ? values : [];
  const ts = Array.isArray(timestamps) ? timestamps : [];
  const n = vals.length;
  if (n === 0) return { values: [], timestamps: [] };
  if (n <= maxPoints) return { values: vals, timestamps: ts };

  const outVals = [];
  const outTs = [];
  for (let i = 0; i < maxPoints; i += 1) {
    const idx = Math.floor((i * (n - 1)) / Math.max(maxPoints - 1, 1));
    outVals.push(vals[idx]);
    if (ts.length === n) outTs.push(ts[idx]);
  }

  if (ts.length === n) return { values: outVals, timestamps: outTs };
  if (ts.length > 0) {
    const outTs2 = [];
    for (let i = 0; i < maxPoints; i += 1) {
      const idx = Math.floor((i * (ts.length - 1)) / Math.max(maxPoints - 1, 1));
      outTs2.push(ts[idx]);
    }
    return { values: outVals, timestamps: outTs2 };
  }
  return { values: outVals, timestamps: [] };
}

function formatTimestampLabel(v, withDate = false) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" && Number.isFinite(v)) {
    if (withDate && v >= 0) {
      const total = Math.round(v);
      const day = Math.floor(total / 1440) + 1;
      const rem = ((total % 1440) + 1440) % 1440;
      const hh = Math.floor(rem / 60);
      const mm = rem % 60;
      return `Day ${day} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    }
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

function isStrictlyIncreasing(arr) {
  for (let i = 1; i < arr.length; i += 1) {
    if (!(arr[i] > arr[i - 1])) return false;
  }
  return arr.length >= 2;
}

function deriveAxisInfo(values, timestamps) {
  const vals = Array.isArray(values) ? values : [];
  const ts = Array.isArray(timestamps) ? timestamps : [];
  const dateTs = ts.map((t) => toMillis(t));
  const hasDateAxis = dateTs.filter((x) => x !== null).length >= 2;
  const hasNumericAxis = !hasDateAxis && ts.length >= 2 && ts.every((t) => typeof t === "number" && Number.isFinite(t));

  const validDateTs = dateTs.filter((x) => x !== null);
  const useDateAxis = hasDateAxis && isStrictlyIncreasing(validDateTs);
  const numericTs = hasNumericAxis ? ts.map((t) => Number(t)) : [];
  const useNumericAxis = hasNumericAxis && isStrictlyIncreasing(numericTs);

  const xRaw = vals.map((_, i) => {
    if (useDateAxis) return dateTs[i];
    if (useNumericAxis) return Number.isFinite(Number(ts[i])) ? Number(ts[i]) : NaN;
    return i;
  });

  const clean = vals
    .map((v, i) => ({ x: xRaw[i], y: typeof v === "number" ? v : NaN }))
    .filter((p) => Number.isFinite(p.y) && Number.isFinite(p.x));

  if (clean.length < 2) {
    return { useDateAxis, useNumericAxis, clean, minX: null, maxX: null };
  }

  return {
    useDateAxis,
    useNumericAxis,
    clean,
    minX: Math.min(...clean.map((p) => p.x)),
    maxX: Math.max(...clean.map((p) => p.x)),
  };
}

function drawSeries(canvas, values, timestamps, eventInfo, color = "#0f6cbd", opts = {}) {
  const parentWidth = canvas.parentElement ? canvas.parentElement.clientWidth : 0;
  const width = Math.max(canvas.clientWidth, parentWidth - 8, 480);
  const height = Math.max(canvas.clientHeight, 170);
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  const axis = deriveAxisInfo(values, timestamps);
  const useDateAxis = axis.useDateAxis;
  const useNumericAxis = axis.useNumericAxis;
  const clean = axis.clean.map((p, i) => ({ ...p, i }));

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

  const freshTickMode =
    useNumericAxis && Number.isFinite(opts && opts.dayStartMinute) && Number.isFinite(opts && opts.dayEndMinute);
  const psmlMidnightMode = useDateAxis && Boolean(opts && opts.psmlMidnightTicks);

  const left = freshTickMode ? 56 : 44;
  const right = width - 12;
  const top = 10;
  const bottom = height - (freshTickMode || psmlMidnightMode ? 64 : 34);

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
  if (yMinTxt) ctx.fillText(yMinTxt, 2, bottom - 4);

  const hasDomain =
    opts &&
    opts.xDomain &&
    Number.isFinite(opts.xDomain.min) &&
    Number.isFinite(opts.xDomain.max) &&
    opts.xDomain.max > opts.xDomain.min;
  const minX = hasDomain ? opts.xDomain.min : axis.minX;
  const maxX = hasDomain ? opts.xDomain.max : axis.maxX;
  const xScale = (x) => left + ((right - left) * (x - minX)) / Math.max(maxX - minX, 1e-9);
  const yScale = (y) => bottom - ((bottom - top) * (y - low)) / (high - low);

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  const breakOnReset = Boolean(opts.breakOnReset);
  const resetDrop = Number.isFinite(opts.resetDropThreshold) ? opts.resetDropThreshold : 360;
  clean.forEach((point, idx) => {
    const px = xScale(point.x);
    const py = yScale(point.y);
    if (idx === 0) {
      ctx.moveTo(px, py);
      return;
    }
    const prev = clean[idx - 1];
    const isReset = breakOnReset && Number.isFinite(prev.y) && Number.isFinite(point.y) && prev.y - point.y > resetDrop;
    if (isReset) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  });
  ctx.stroke();

  const tickSpecs = [];

  if (psmlMidnightMode) {
    const dayMs = 24 * 60 * 60 * 1000;
    const startDate = new Date(minX);
    startDate.setHours(0, 0, 0, 0);
    let t = startDate.getTime();
    if (t < minX) t += dayMs;
    for (; t <= maxX; t += dayMs) {
      tickSpecs.push({ t, label: "00:00", isPsmlMidnight: true, showLabel: true });
    }
  }

  if (freshTickMode) {
    const dayStartMinute = Number(opts.dayStartMinute);
    const dayEndMinute = Number(opts.dayEndMinute);
    const noonMinute = 12 * 60;
    const firstDay = Math.max(0, Math.floor((minX - dayStartMinute) / 1440));
    const lastDay = Math.max(firstDay, Math.ceil((maxX - dayStartMinute) / 1440));

    for (let d = firstDay; d <= lastDay; d += 1) {
      const base = d * 1440;
      const tStart = base + dayStartMinute;
      const tNoon = base + noonMinute;
      const tEnd = base + dayEndMinute;

      if (tStart >= minX && tStart <= maxX) tickSpecs.push({ t: tStart, label: "06:00", isFresh: true, showLabel: true });
      if (tNoon >= minX && tNoon <= maxX) tickSpecs.push({ t: tNoon, label: "", isFresh: true, showLabel: false });
      if (tEnd >= minX && tEnd <= maxX) tickSpecs.push({ t: tEnd, label: "22:00", isFresh: true, showLabel: true });
    }
  }

  if (tickSpecs.length === 0) {
    const tickCount = 5;
    for (let i = 0; i < tickCount; i += 1) {
      const t = minX + ((maxX - minX) * i) / Math.max(tickCount - 1, 1);
      let label = "";
      if (useDateAxis) {
        label = formatTimestampLabel(new Date(t).toISOString(), true);
      } else if (useNumericAxis) {
        label = formatTimestampLabel(t, true);
      } else {
        label = String(Math.round(t));
      }
      tickSpecs.push({ t, label, isFresh: false });
    }
  }

  for (const spec of tickSpecs) {
    const x = xScale(spec.t);
    const label = spec.label || "";
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, bottom);
    ctx.lineTo(x, bottom + (spec.isFresh || spec.isPsmlMidnight ? 5 : 4));
    ctx.stroke();

    ctx.fillStyle = "#334155";
    if (spec.isFresh) {
      if (spec.showLabel) {
        ctx.font = "7px sans-serif";
        ctx.save();
        ctx.translate(x, bottom + 30);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    } else if (spec.isPsmlMidnight) {
      if (spec.showLabel) {
        ctx.font = "7px sans-serif";
        ctx.save();
        ctx.translate(x, bottom + 30);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    } else {
      ctx.font = "10px sans-serif";
      const w = ctx.measureText(label).width;
      ctx.fillText(label, Math.max(left, Math.min(right - w, x - w / 2)), bottom + 15);
    }
  }

  const showEventMarker = opts.showEventMarker !== false;
  if (!showEventMarker) return;

  const eventTs = eventInfo.timestampText ? toMillis(eventInfo.timestampText) : null;
  let markerX = null;
  let isFuture = false;
  let label = null;

  if (eventTs && useDateAxis && Array.isArray(timestamps) && timestamps.length > 0) {
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

function mountSeriesCanvas(container, values, timestamps, eventInfo, color = "#0f6cbd", opts = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = "ts-chart";
  container.append(canvas);
  requestAnimationFrame(() => drawSeries(canvas, values || [], timestamps || [], eventInfo, color, opts));
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

function sanitizeFilenamePart(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "unknown";
  const cleaned = raw
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "unknown";
}

function buildDownloadFilename(stage, ext) {
  const annotator = sanitizeFilenamePart(config.annotatorName);
  const dataset = sanitizeFilenamePart(config.dataset);
  const tiers = Array.isArray(config.selectedTiers)
    ? config.selectedTiers.filter((t) => t === "T3" || t === "T4")
    : [];
  const tierPart = sanitizeFilenamePart(tiers.length > 0 ? tiers.join("-") : "NA");
  const startIndex = Math.max(1, Math.floor(Number(config.startIndex || 1)));
  const itemCount = Math.max(
    1,
    Math.floor(Number(state.selectedItems.length || config.annotationCount || config.requestedCount || 1))
  );
  const stagePart = sanitizeFilenamePart(stage || "annotations");
  return `${annotator}_${dataset}_${tierPart}_start${startIndex}_n${itemCount}_${stagePart}.${ext}`;
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

function getCurrentDraftResponse() {
  const item = state.selectedItems[state.index];
  if (!item) return null;
  const form = document.getElementById("question-form");
  if (!form) return null;

  const formData = new FormData(form);
  const mcqList = Array.isArray(item.mcq) ? item.mcq : [];
  const responses = {};

  for (const q of mcqList) {
    const qKey = q.key;
    const answer = String(formData.get(qKey) || "").trim();
    if (answer) responses[qKey] = answer;
  }
  if (Object.keys(responses).length === 0) return null;

  const existing = getItemAnswer(item.id);
  const submittedAt = new Date().toISOString();
  const started = existing?.startedAt || state.questionStartedAt || submittedAt;
  const timeSpentSec = Math.max(0, (Date.parse(submittedAt) - Date.parse(started)) / 1000);

  return {
    itemId: item.id,
    tier: item.tier,
    sourceDataset: item.source_dataset,
    responses,
    startedAt: started,
    submittedAt,
    timeSpentSec,
    draft: true,
  };
}

function buildPayload(includeCurrentDraft = false) {
  const merged = new Map();
  for (const ans of state.answers) {
    merged.set(ans.itemId, ans);
  }
  if (includeCurrentDraft) {
    const draft = getCurrentDraftResponse();
    if (draft) merged.set(draft.itemId, draft);
  }
  const answers = Array.from(merged.values());
  const summary = buildSummary(answers);
  return {
    annotatorName: config.annotatorName,
    dataset: config.dataset,
    requestedCount: config.requestedCount,
    actualCount: state.selectedItems.length,
    startedAt: config.startedAt,
    exportedAt: new Date().toISOString(),
    answers,
    stats: summary,
    isPartial: answers.length < state.selectedItems.length,
  };
}

function renderHeader() {
  headerEl.innerHTML = "";

  const left = document.createElement("div");
  left.innerHTML = `
    <strong>Annotator: ${config.annotatorName}</strong>
    <span class="muted">Dataset: ${config.dataset} | Tier: ${(config.selectedTiers || []).join(", ")} | Start: ${
      Math.max(1, Math.floor(Number(config.startIndex || 1)))
    } | Requested: ${Math.max(1, Math.floor(Number(config.annotationCount || 1)))} | Saved: ${state.answers.length}/${state.selectedItems.length || 0} | Cheat: ${
      state.cheatMode ? "ON" : "OFF"
    }</span>
  `;

  const right = document.createElement("div");
  right.className = "row";

  const downloadJsonBtn = document.createElement("button");
  downloadJsonBtn.type = "button";
  downloadJsonBtn.className = "btn";
  downloadJsonBtn.textContent = "Download Progress JSON";
  downloadJsonBtn.onclick = () => {
    const payload = buildPayload(true);
    const filename = buildDownloadFilename("progress", "json");
    triggerDownload(filename, JSON.stringify(payload, null, 2), "application/json");
  };

  const downloadCsvBtn = document.createElement("button");
  downloadCsvBtn.type = "button";
  downloadCsvBtn.className = "btn";
  downloadCsvBtn.textContent = "Download Progress CSV";
  downloadCsvBtn.onclick = () => {
    const payload = buildPayload(true);
    const filename = buildDownloadFilename("progress", "csv");
    triggerDownload(filename, buildCsv(payload), "text/csv");
  };

  const saveExitBtn = document.createElement("button");
  saveExitBtn.type = "button";
  saveExitBtn.className = "btn btn-primary";
  saveExitBtn.textContent = "Save & Exit";
  saveExitBtn.onclick = () => {
    const payload = buildPayload(true);
    const filename = buildDownloadFilename("progress", "json");
    triggerDownload(filename, JSON.stringify(payload, null, 2), "application/json");
    sessionStorage.removeItem("annotationConfig");
    window.location.href = "index.html";
  };

  const enterCheatBtn = document.createElement("button");
  enterCheatBtn.type = "button";
  enterCheatBtn.className = "btn";
  enterCheatBtn.textContent = "Enter Cheat Mode";
  enterCheatBtn.onclick = () => {
    const pwd = window.prompt("Enter cheat password:");
    if (pwd === null) return;
    if (String(pwd).trim() !== CHEAT_PASSWORD) {
      window.alert("Invalid password.");
      return;
    }
    state.cheatMode = true;
    renderHeader();
    if (state.selectedItems.length > 0 && state.index < state.selectedItems.length) {
      renderCurrent();
    }
  };

  const exitCheatBtn = document.createElement("button");
  exitCheatBtn.type = "button";
  exitCheatBtn.className = "btn";
  exitCheatBtn.textContent = "Exit Cheat Mode";
  exitCheatBtn.onclick = () => {
    state.cheatMode = false;
    renderHeader();
    if (state.selectedItems.length > 0 && state.index < state.selectedItems.length) {
      renderCurrent();
    }
  };

  right.append(downloadJsonBtn, downloadCsvBtn, enterCheatBtn, exitCheatBtn, saveExitBtn);
  headerEl.append(left, right);
}

function renderFinish() {
  const payload = buildPayload(true);
  const summary = payload.stats || {};

  contextEl.innerHTML = "";
  renderHeader();
  progressEl.textContent = `Completed ${state.answers.length} / ${state.selectedItems.length}`;

  const done = document.createElement("div");
  done.className = "summary";
  done.innerHTML = `<h3>Annotation Complete</h3><p>Download results, then return to the home page.</p>`;

  const stat = document.createElement("pre");
  stat.textContent = JSON.stringify(summary, null, 2);
  done.appendChild(stat);
  contextEl.appendChild(done);

  payload.finishedAt = new Date().toISOString();

  answerEl.innerHTML = "";

  const downloadJsonBtn = document.createElement("button");
  downloadJsonBtn.className = "btn btn-primary";
  downloadJsonBtn.textContent = "Download JSON";
  downloadJsonBtn.onclick = () => {
    const filename = buildDownloadFilename("annotations", "json");
    triggerDownload(filename, JSON.stringify(payload, null, 2), "application/json");
  };

  const downloadCsvBtn = document.createElement("button");
  downloadCsvBtn.className = "btn";
  downloadCsvBtn.textContent = "Download CSV";
  downloadCsvBtn.onclick = () => {
    const filename = buildDownloadFilename("annotations", "csv");
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

  renderHeader();
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
  const histTimestamps = buildDisplayTimestamps(item, ((item.history || {}).timestamps) || []);
  const histPrepared = normalizeSeriesLength(histValues, histTimestamps);
  const mainAxis = deriveAxisInfo(histPrepared.values, histPrepared.timestamps);
  const mainDomain =
    Number.isFinite(mainAxis.minX) && Number.isFinite(mainAxis.maxX) && mainAxis.maxX > mainAxis.minX
      ? { min: mainAxis.minX, max: mainAxis.maxX }
      : null;
  mountSeriesCanvas(histBlock, histPrepared.values, histPrepared.timestamps, eventInfo, "#0f6cbd", {
    xDomain: mainDomain,
    dayStartMinute: String(item.source_dataset || "") === "freshretailnet" ? 6 * 60 : undefined,
    dayEndMinute: String(item.source_dataset || "") === "freshretailnet" ? 22 * 60 : undefined,
    psmlMidnightTicks: String(item.source_dataset || "") === "PSML",
  });
  chartGrid.append(histBlock);

  const covTimestamps = buildDisplayTimestamps(item, ((item.history_covariates || {}).timestamps) || []);
  const covariates = (((item.history_covariates || {}).covariates) || {});
  const covNames = Object.keys(covariates).sort((a, b) => {
    const aTimePos = String(a).toLowerCase() === "time_position_in_day";
    const bTimePos = String(b).toLowerCase() === "time_position_in_day";
    if (aTimePos === bTimePos) return 0;
    return aTimePos ? 1 : -1;
  });
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
      const covPrepared = normalizeSeriesLength(covariates[covName] || [], covTimestamps);
      const covAxis = deriveAxisInfo(covPrepared.values, covPrepared.timestamps);
      if (covAxis.clean.length < 2) {
        const note = document.createElement("p");
        note.className = "muted";
        note.textContent = "Skipped: too few valid points for plotting.";
        covBlock.append(note);
        covDetails.append(covBlock);
        continue;
      }

      const isTimePos = String(covName).toLowerCase().includes("time_position_in_day");
      mountSeriesCanvas(covBlock, covPrepared.values, covPrepared.timestamps, eventInfo, "#b55300", {
        breakOnReset: isTimePos,
        resetDropThreshold: 300,
        showEventMarker: false,
        xDomain: mainDomain,
        dayStartMinute: String(item.source_dataset || "") === "freshretailnet" ? 6 * 60 : undefined,
    dayEndMinute: String(item.source_dataset || "") === "freshretailnet" ? 22 * 60 : undefined,
        psmlMidnightTicks: String(item.source_dataset || "") === "PSML",
      });
      covDetails.append(covBlock);
    }
    chartGrid.append(covDetails);
  }
  contextEl.append(chartGrid);

  const form = document.createElement("form");
  form.id = "question-form";
  form.className = "question-panel";

  const mcqList = Array.isArray(item.mcq) ? item.mcq : [];
  const referenceAnswers = item.reference_answers && typeof item.reference_answers === "object" ? item.reference_answers : {};
  for (const [qIndex, q] of mcqList.entries()) {
    const block = document.createElement("fieldset");
    block.className = "mcq-block";

    const qKey = q.key || `q${qIndex + 1}`;
    const legend = document.createElement("legend");
    legend.textContent = `${qIndex + 1}. ${q.question}`;
    block.append(legend);
    if (state.cheatMode) {
      const hint = document.createElement("div");
      hint.className = "muted";
      hint.textContent = `Answer: ${referenceAnswers[qKey] || "N/A"}`;
      block.append(hint);
    }

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

    const count = Math.max(1, Math.floor(Number(config.annotationCount || 1)));
    const startIndex0 = Math.max(0, Math.floor(Number(config.startIndex || 1)) - 1);
    state.selectedItems = state.records.slice(startIndex0, startIndex0 + count);
    if (state.selectedItems.length === 0) {
      contextEl.innerHTML = `<p>No items from start index ${startIndex0 + 1}. Available filtered items: ${state.records.length}.</p>`;
      return;
    }
    state.questionStartedAt = new Date().toISOString();
    renderHeader();
    renderCurrent();
  } catch (err) {
    contextEl.innerHTML = `<p>Load error: ${escapeHtml(err?.message || String(err))}</p>`;
  }
}

init();
