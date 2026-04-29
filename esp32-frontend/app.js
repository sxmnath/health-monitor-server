"use strict";
// ─── Config ───────────────────────────────────────────────────────────────────
const urlParams       = new URLSearchParams(window.location.search);
const PAGE_PATIENT_ID = urlParams.get("id") || null;
const isPatientId     = PAGE_PATIENT_ID && /^P\d+$/.test(PAGE_PATIENT_ID);

const API = PAGE_PATIENT_ID
  ? isPatientId
    ? `/api/dashboard?patientId=${encodeURIComponent(PAGE_PATIENT_ID)}`
    : `/api/dashboard?deviceId=${encodeURIComponent(PAGE_PATIENT_ID)}`
  : "/api/dashboard";

let hrChart, spo2Chart, tempChart;
let currentFilter    = "1h";
let currentPatientId = PAGE_PATIENT_ID;
let currentDeviceId  = null;

// ─── Client-side Signal Processing ───────────────────────────────────────────
// Note: server already applies moving average + noise rejection before storing.
// Here we apply a LIGHTER smoothing only for the live stream display so the
// UI doesn't jump on individual WebSocket frames before they hit the DB.
const MA_WIN = 3;
const hrBuf = [], spo2Buf = [], tempBuf = [];
let peakHr = null, minSpo2 = null, peakTempF = null;

function clientSmooth(buf, val) {
  buf.push(val);
  if (buf.length > MA_WIN) buf.shift();
  return Math.round((buf.reduce((a, b) => a + b, 0) / buf.length) * 10) / 10;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const AI_NOTES = {
  "Stress detected":          "Elevated heart rate with normal oxygen suggests stress.",
  "Fever risk":               "High temperature with increased heart rate suggests fever.",
  "Respiratory concern":      "Low oxygen saturation may indicate breathing issues.",
  "SpO₂ sensor disconnected": "Blood oxygen sensor is not connected to the device.",
  "Normal":                   "All vitals are within healthy ranges.",
};

function getVitalStatus(type, value) {
  if (type === "hr") {
    if (value < 50)   return { level: "critical", text: "Bradycardia",  icon: "fa-triangle-exclamation" };
    if (value <= 100) return { level: "normal",   text: "Normal",       icon: "fa-circle-check"         };
    if (value <= 120) return { level: "warning",  text: "Tachycardia",  icon: "fa-circle-exclamation"   };
    return                   { level: "critical", text: "Critical HR",  icon: "fa-triangle-exclamation" };
  }
  if (type === "spo2") {
    if (value > 95)  return { level: "normal",   text: "Normal",   icon: "fa-circle-check"        };
    if (value >= 92) return { level: "warning",  text: "Low",      icon: "fa-circle-exclamation"  };
    return                  { level: "critical", text: "Critical", icon: "fa-triangle-exclamation" };
  }
  if (type === "temp") {   // °F
    if (value < 100.4) return { level: "normal",   text: "Normal",     icon: "fa-circle-check"        };
    if (value <= 102)  return { level: "warning",  text: "Mild Fever", icon: "fa-circle-exclamation"  };
    return                    { level: "critical", text: "High Fever", icon: "fa-triangle-exclamation" };
  }
}

// ─── WS indicator ─────────────────────────────────────────────────────────────
function setWsStatus(state) {
  const dot  = document.getElementById("wsDot");
  const text = document.getElementById("wsText");
  if (!dot || !text) return;
  const map = {
    connected:    { color: "#3dab6e", label: "Live"          },
    disconnected: { color: "#e05c5c", label: "Reconnecting…" },
    connecting:   { color: "#e09a3c", label: "Connecting…"   },
  };
  const s = map[state] || map.connecting;
  dot.style.background = s.color;
  text.innerText        = s.label;
}

// ─── Render vitals ─────────────────────────────────────────────────────────────
// `raw` now contains { heartRate, spo2, temperatureF } — already processed by server
function renderVitals(raw, time) {
  // Light client-side smoothing for live stream visual stability
  const hr    = raw.heartRate    != null ? clientSmooth(hrBuf,   raw.heartRate)    : null;
  const spo2  = raw.spo2;   // -1 = not connected — do NOT smooth sentinel
  const spo2v = spo2 === -1 ? -1 : (spo2 != null ? clientSmooth(spo2Buf, spo2) : null);
  const tempF = raw.temperatureF != null ? clientSmooth(tempBuf, raw.temperatureF) : null;

  // Peak tracking (session highs/lows)
  if (hr    != null && (peakHr    === null || hr    > peakHr))    peakHr    = hr;
  if (tempF != null && (peakTempF === null || tempF > peakTempF)) peakTempF = tempF;
  if (spo2v !== -1 && spo2v != null && (minSpo2 === null || spo2v < minSpo2)) minSpo2 = spo2v;

  // ── Heart Rate card ────────────────────────────────────────────────────────
  if (hr != null) {
    const st   = getVitalStatus("hr", hr);
    const card = document.getElementById("card-hr");
    const valEl  = document.getElementById("hr");
    const statEl = document.getElementById("status-hr");
    if (valEl)  valEl.innerText   = hr;
    if (statEl) { statEl.innerHTML = `<i class="fa-solid ${st.icon}"></i> ${st.text}`; statEl.className = `vc-status status-${st.level}`; }
    if (card)   card.className    = `vital-card card-${st.level}`;
    const bar = document.getElementById("bar-hr");
    if (bar) bar.style.width = `${Math.min(100, (hr / 200) * 100)}%`;
    const pk = document.getElementById("peak-hr");
    if (pk) pk.innerText = peakHr !== null ? `${peakHr} bpm` : "--";
  }

  // ── SpO2 card ──────────────────────────────────────────────────────────────
  const spo2Card  = document.getElementById("card-spo2");
  const spo2ValEl = document.getElementById("spo2");
  const spo2Stat  = document.getElementById("status-spo2");
  const spo2Bar   = document.getElementById("bar-spo2");
  const spo2Pk    = document.getElementById("peak-spo2");

  if (spo2v === -1) {
    if (spo2ValEl) spo2ValEl.innerText = "—";
    if (spo2Stat)  { spo2Stat.innerHTML = '<i class="fa-solid fa-plug-circle-xmark"></i> Not Connected'; spo2Stat.className = "vc-status status-disconnected"; }
    if (spo2Card)  spo2Card.className   = "vital-card card-disconnected";
    if (spo2Bar)   spo2Bar.style.width  = "0%";
    if (spo2Pk)    spo2Pk.innerText     = "—";
  } else if (spo2v != null) {
    const st = getVitalStatus("spo2", spo2v);
    if (spo2ValEl) spo2ValEl.innerText = spo2v;
    if (spo2Stat)  { spo2Stat.innerHTML = `<i class="fa-solid ${st.icon}"></i> ${st.text}`; spo2Stat.className = `vc-status status-${st.level}`; }
    if (spo2Card)  spo2Card.className   = `vital-card card-${st.level}`;
    if (spo2Bar)   spo2Bar.style.width  = `${Math.max(0, ((spo2v - 80) / 20) * 100)}%`;
    if (spo2Pk)    spo2Pk.innerText     = minSpo2 !== null ? `${minSpo2}%` : "--";
  }

  // ── Temperature card ───────────────────────────────────────────────────────
  if (tempF != null) {
    const st   = getVitalStatus("temp", tempF);
    const card = document.getElementById("card-temp");
    const valEl  = document.getElementById("temp");
    const statEl = document.getElementById("status-temp");
    if (valEl)  valEl.innerText   = tempF;
    if (statEl) { statEl.innerHTML = `<i class="fa-solid ${st.icon}"></i> ${st.text}`; statEl.className = `vc-status status-${st.level}`; }
    if (card)   card.className    = `vital-card card-${st.level}`;
    const bar = document.getElementById("bar-temp");
    if (bar) bar.style.width = `${Math.min(100, Math.max(0, ((tempF - 90) / 14) * 100))}%`;
    const pk = document.getElementById("peak-temp");
    if (pk) pk.innerText = peakTempF !== null ? `${peakTempF}°F` : "--";
  }

  // ── Status Banner ──────────────────────────────────────────────────────────
  const banner = document.getElementById("statusBanner");
  const label  = document.getElementById("statusLabel");
  if (banner && label) {
    const isCrit = [
      hr    != null && getVitalStatus("hr",   hr).level    === "critical",
      spo2v !== -1  && spo2v != null && getVitalStatus("spo2", spo2v).level === "critical",
      tempF != null && getVitalStatus("temp", tempF).level === "critical",
    ].some(Boolean);
    const isWarn = [
      hr    != null && getVitalStatus("hr",   hr).level    === "warning",
      spo2v !== -1  && spo2v != null && getVitalStatus("spo2", spo2v).level === "warning",
      tempF != null && getVitalStatus("temp", tempF).level === "warning",
    ].some(Boolean);
    if (isCrit)      { banner.className = "status-banner status-critical"; label.innerText = "⚠ Critical — Immediate Attention Required"; }
    else if (isWarn) { banner.className = "status-banner status-warning";  label.innerText = "◉ Warning — Monitor Closely";               }
    else             { banner.className = "status-banner status-normal";   label.innerText = "✓ All Vitals Stable";                       }
  }

  // Timestamps
  const t = new Date(time).toLocaleTimeString();
  ["updated", "footerUpdated"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerText = `Last updated: ${t}`;
  });

  // Live chart update
  const chartLabel = new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  updateLiveCharts(chartLabel, hr, spo2v === -1 ? null : spo2v, tempF, raw.isPeak);

  generateAlerts({ heartRate: hr, spo2: spo2v, temperatureF: tempF });
}

// ─── Alert Engine ─────────────────────────────────────────────────────────────
const activeAlerts = new Map();
const ALERT_RULES = [
  { key: "hr_low",    check: v => v.heartRate != null && v.heartRate < 50,                                         severity: "critical", icon: "fa-heart-crack",       title: "Bradycardia Detected",      detail: v => `Heart rate ${v.heartRate} bpm (threshold: <50)` },
  { key: "hr_crit",   check: v => v.heartRate != null && v.heartRate > 120,                                        severity: "critical", icon: "fa-heart-crack",       title: "Critical Tachycardia",      detail: v => `Heart rate ${v.heartRate} bpm (threshold: >120)` },
  { key: "hr_warn",   check: v => v.heartRate != null && v.heartRate > 100 && v.heartRate <= 120,                  severity: "warning",  icon: "fa-heart-pulse",       title: "Elevated Heart Rate",       detail: v => `Heart rate ${v.heartRate} bpm (normal: 50–100)` },
  { key: "spo2_nc",   check: v => v.spo2 === -1,                                                                   severity: "warning",  icon: "fa-plug-circle-xmark", title: "SpO₂ Sensor Not Connected", detail: () => "Blood oxygen sensor is disconnected" },
  { key: "spo2_crit", check: v => v.spo2 !== -1 && v.spo2 != null && v.spo2 < 92,                                 severity: "critical", icon: "fa-lungs",             title: "Critical Low SpO₂",         detail: v => `SpO₂ ${v.spo2}% (critical: <92%)` },
  { key: "spo2_warn", check: v => v.spo2 !== -1 && v.spo2 != null && v.spo2 >= 92 && v.spo2 <= 95,               severity: "warning",  icon: "fa-lungs",             title: "SpO₂ Slightly Low",         detail: v => `SpO₂ ${v.spo2}% (borderline: 92–95%)` },
  { key: "temp_crit", check: v => v.temperatureF != null && v.temperatureF > 102,                                  severity: "critical", icon: "fa-temperature-full",  title: "High Fever",                detail: v => `Temp ${v.temperatureF}°F (critical: >102°F)` },
  { key: "temp_warn", check: v => v.temperatureF != null && v.temperatureF >= 100.4 && v.temperatureF <= 102,     severity: "warning",  icon: "fa-temperature-half",  title: "Mild Fever",                detail: v => `Temp ${v.temperatureF}°F (mild: 100.4–102°F)` },
];

function generateAlerts(vitals) {
  const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  ALERT_RULES.forEach(r => {
    if (r.check(vitals)) {
      if (!activeAlerts.has(r.key)) activeAlerts.set(r.key, { severity: r.severity, icon: r.icon, title: r.title, detail: r.detail(vitals), time: now });
    } else {
      activeAlerts.delete(r.key);
    }
  });
  renderAlertPanel();
}

function renderAlertPanel() {
  const list  = document.getElementById("alertsList");
  const badge = document.getElementById("alertBadge");
  if (!list) return;
  const count = activeAlerts.size;
  if (badge) { badge.textContent = count; badge.style.display = count > 0 ? "inline-flex" : "none"; }
  list.innerHTML = "";
  if (count === 0) {
    list.innerHTML = `<div class="alert-empty"><i class="fa-solid fa-circle-check"></i> All vitals normal</div>`;
    return;
  }
  let delay = 0;
  activeAlerts.forEach((a, key) => {
    const div = document.createElement("div");
    div.className = `alert-item alert-${a.severity}`;
    div.style.animationDelay = `${delay}ms`;
    div.innerHTML = `<i class="fa-solid ${a.icon} alert-icon"></i><div class="alert-body"><div class="alert-title">${a.title}</div><div class="alert-detail">${a.detail}</div></div><span class="alert-time">${a.time}</span><button class="alert-dismiss" onclick="dismissAlert('${key}')"><i class="fa-solid fa-xmark"></i></button>`;
    list.appendChild(div);
    delay += 60;
  });
}

function dismissAlert(key) { activeAlerts.delete(key); renderAlertPanel(); }

// ─── Charts ────────────────────────────────────────────────────────────────────
function makeChartOpts({ yLabel, yMin, yMax, color, tickSuffix }) {
  return {
    responsive: true, maintainAspectRatio: false,
    animation: { duration: 200 },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#fff", titleColor: "#1a1a2e", bodyColor: "#5a5570",
        borderColor: "#e8e2d8", borderWidth: 1, padding: 10,
        callbacks: { label: ctx => ` ${ctx.parsed.y}${tickSuffix}` },
      },
    },
    scales: {
      x: {
        ticks: { color: "#9b96a8", maxTicksLimit: 8, font: { size: 11 }, maxRotation: 0 },
        grid:  { color: "rgba(0,0,0,0.04)" },
        title: { display: true, text: "Time", color: "#9b96a8", font: { size: 11 } },
      },
      y: {
        min: yMin, max: yMax,
        ticks: { color: "#9b96a8", font: { size: 11 }, callback: v => v + tickSuffix },
        grid:  { color: "rgba(0,0,0,0.04)" },
        title: { display: true, text: yLabel, color: "#9b96a8", font: { size: 11 } },
      },
    },
    elements: {
      line:  { tension: 0.4, borderWidth: 2.5 },
      point: { radius: 0, hitRadius: 12, hoverRadius: 5, hoverBackgroundColor: color },
    },
  };
}

function initCharts() {
  const mk = (id, label, color, opts) =>
    new Chart(document.getElementById(id).getContext("2d"), {
      type: "line",
      data: { labels: [], datasets: [{ label, data: [], borderColor: color, backgroundColor: color + "18", fill: true, spanGaps: false }] },
      options: makeChartOpts({ color, ...opts }),
    });
  hrChart   = mk("hrChart",   "Heart Rate",  "#e05c6e", { yLabel: "bpm", yMin: 30,  yMax: 200, tickSuffix: " bpm" });
  spo2Chart = mk("spo2Chart", "SpO₂",        "#4ab3c8", { yLabel: "%",   yMin: 80,  yMax: 100, tickSuffix: "%"    });
  tempChart = mk("tempChart", "Temperature", "#e0963c", { yLabel: "°F",  yMin: 90,  yMax: 104, tickSuffix: "°F"   });
}

function updateLiveCharts() {
  // Live chart removed — only 1h and 24h historical views are shown.
}

// ─── Historical Data — THE FIX ────────────────────────────────────────────────
// Uses the new /api/patients/:id/history?range=1h|24h endpoint.
// The server stores temperatureF directly so no conversion needed here.
async function fetchHistoricalData(range) {
  const pid = currentPatientId;
  if (!pid) { console.warn("[history] No patient ID"); return; }

  showChartLoading(true);
  try {
    const res    = await fetch(`/api/patients/${encodeURIComponent(pid)}/history?range=${range}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();

    if (!result.data || result.data.length === 0) {
      showChartEmpty(range);
      return;
    }

    const labels = [], hrD = [], spo2D = [], tempD = [];
    result.data.forEach(d => {
      // For 1h: show HH:MM:SS; for 24h: show HH:MM
      const opts = range === "1h"
        ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
        : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
      labels.push(new Date(d.time).toLocaleString([], opts));
      hrD.push(d.heartRate ?? null);
      spo2D.push(d.spo2 === -1 ? null : (d.spo2 ?? null));
      tempD.push(d.temperatureF ?? null);
    });

    [
      { c: hrChart,   d: hrD   },
      { c: spo2Chart, d: spo2D },
      { c: tempChart, d: tempD },
    ].forEach(({ c, d }) => {
      if (!c) return;
      c.data.labels             = labels;
      c.data.datasets[0].data   = d;
      c.update();
    });
  } catch (e) {
    console.error("[fetchHistoricalData]", e);
    showChartEmpty(range);
  } finally {
    showChartLoading(false);
  }
}

function showChartLoading(on) {
  const el = document.getElementById("chartLoadingMsg");
  if (el) el.style.display = on ? "flex" : "none";
}

function showChartEmpty(range) {
  const label = range === "1h" ? "last 1 hour" : "last 24 hours";
  const el    = document.getElementById("chartEmptyMsg");
  if (el) { el.textContent = `No data for the ${label}. Data will appear here once the sensor sends readings.`; el.style.display = "block"; }
}

// ─── Patient Profile ───────────────────────────────────────────────────────────
let patientProfile = {};

function renderProfile(p) {
  patientProfile = p || {};
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val || "—"; };
  const name = p.name || p.patient_id || PAGE_PATIENT_ID || "Patient";
  set("patientName",   name);
  set("bcPatientName", name);
  document.title = `${name} — Health Monitor`;
  set("patientId",    p.patient_id || PAGE_PATIENT_ID);
  set("pf-room",      p.roomNo);
  set("pf-ward",      p.ward);
  set("pf-age",       p.age       ? `${p.age} yrs`  : null);
  set("pf-gender",    p.gender);
  set("pf-blood",     p.bloodType);
  set("pf-weight",    p.weight    ? `${p.weight} kg` : null);
  set("pf-height",    p.height    ? `${p.height} cm` : null);
  set("pf-physician", p.physician);
  set("pf-diagnosis", p.diagnosis);
  set("pf-phone",     p.phone);
  set("pf-notes",     p.notes);
}

async function loadPatientProfile() {
  if (!PAGE_PATIENT_ID || !isPatientId) return;
  try {
    const res = await fetch(`/api/patients/${encodeURIComponent(PAGE_PATIENT_ID)}`);
    if (!res.ok) return;
    const p = await res.json();
    renderProfile(p);
    currentDeviceId = p.deviceId;
  } catch (e) { console.warn("Profile load failed:", e); }
}

// ─── Edit Modal ────────────────────────────────────────────────────────────────
function openEditModal() {
  const p = patientProfile;
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ""; };
  setVal("f-name", p.name);       setVal("f-age", p.age);           setVal("f-gender", p.gender);
  setVal("f-bloodType", p.bloodType); setVal("f-weight", p.weight); setVal("f-height", p.height);
  setVal("f-roomNo", p.roomNo);   setVal("f-ward", p.ward);         setVal("f-physician", p.physician);
  setVal("f-diagnosis", p.diagnosis); setVal("f-phone", p.phone);   setVal("f-notes", p.notes);
  document.getElementById("editModal")?.classList.add("open");
}

function closeEditModal() {
  document.getElementById("editModal")?.classList.remove("open");
}

async function saveModal() {
  const g  = id => document.getElementById(id)?.value?.trim();
  const gn = id => { const v = document.getElementById(id)?.value; return v ? Number(v) : undefined; };
  const data = {
    name: g("f-name"), age: gn("f-age"), gender: g("f-gender"), bloodType: g("f-bloodType"),
    weight: gn("f-weight"), height: gn("f-height"), roomNo: g("f-roomNo"), ward: g("f-ward"),
    physician: g("f-physician"), diagnosis: g("f-diagnosis"), phone: g("f-phone"),
    notes: document.getElementById("f-notes")?.value?.trim(),
  };
  const btn = document.getElementById("modalSave");
  try {
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }
    const res = await fetch(`/api/patients/${encodeURIComponent(PAGE_PATIENT_ID)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error("Save failed");
    const updated = await res.json();
    renderProfile(updated);
    closeEditModal();
  } catch { alert("Failed to save. Please try again."); }
  finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-check"></i> Save Changes'; }
  }
}

// ─── Reset Patient Data ────────────────────────────────────────────────────────
async function resetPatientData() {
  const pid = currentPatientId || PAGE_PATIENT_ID;
  if (!pid) return;
  if (!confirm(`Reset ALL sensor data for ${patientProfile.name || pid}?\nThis cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/patients/${encodeURIComponent(pid)}/data`, { method: "DELETE" });
    const r   = await res.json();
    // Clear charts
    [hrChart, spo2Chart, tempChart].forEach(c => {
      if (!c) return;
      c.data.labels = []; c.data.datasets[0].data = []; c.update();
    });
    // Clear buffers
    hrBuf.length = 0; spo2Buf.length = 0; tempBuf.length = 0;
    peakHr = null; minSpo2 = null; peakTempF = null;
    activeAlerts.clear(); renderAlertPanel();
    alert(`Done — ${r.deleted || 0} records deleted.`);
  } catch { alert("Reset failed. Check server connection."); }
}

// ─── Dashboard poll (fallback when WebSocket misses a frame) ──────────────────
async function loadDashboard() {
  try {
    const res  = await fetch(API);
    const data = await res.json();
    if (data.message === "No data yet" || data.error) return;

    currentDeviceId  = data.deviceId;
    currentPatientId = data.patient_id || PAGE_PATIENT_ID;

    if (!patientProfile.name && data.name) {
      renderProfile({ ...data, patient_id: currentPatientId });
    }

    // AI Insights
    if (data.fusion?.indicators) {
      const fusionEl = document.getElementById("fusion");
      if (fusionEl) {
        fusionEl.innerHTML = "";
        data.fusion.indicators.forEach(i => {
          const d = document.createElement("div");
          d.className = "fusion-item";
          d.innerHTML = `<i class="fa-solid fa-brain"></i><div class="fusion-item-content"><h4>${i}</h4><p>${AI_NOTES[i] || ""}</p></div>`;
          fusionEl.appendChild(d);
        });
      }
    }

    // data.vitals now uses temperatureF from the new server
    renderVitals(data.vitals, data.time);
  } catch (e) { console.warn("[poll]", e.message); }
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initCharts();
  setWsStatus("connecting");
  loadPatientProfile();

  // WebSocket
  const socket = io();
  socket.on("connect", () => {
    setWsStatus("connected");
    if (PAGE_PATIENT_ID) socket.emit("join-patient", PAGE_PATIENT_ID);
  });
  socket.on("disconnect", () => setWsStatus("disconnected"));
  socket.on("vitals-update", doc => {
    currentDeviceId  = doc.deviceId;
    currentPatientId = doc.patient_id || PAGE_PATIENT_ID;
    // doc now has temperatureF directly from server
    renderVitals(
      { heartRate: doc.heartRate, spo2: doc.spo2, temperatureF: doc.temperatureF, isPeak: doc.isPeak },
      doc.time || new Date()
    );
    // AI insights
    if (doc.fusion?.indicators) {
      const fusionEl = document.getElementById("fusion");
      if (fusionEl) {
        fusionEl.innerHTML = "";
        doc.fusion.indicators.forEach(i => {
          const d = document.createElement("div");
          d.className = "fusion-item";
          d.innerHTML = `<i class="fa-solid fa-brain"></i><div class="fusion-item-content"><h4>${i}</h4><p>${AI_NOTES[i] || ""}</p></div>`;
          fusionEl.appendChild(d);
        });
      }
    }
  });

  // Poll fallback every 5s
  setInterval(loadDashboard, 5000);
  loadDashboard();

  // Alerts
  document.getElementById("clearAlertsBtn")?.addEventListener("click", () => {
    activeAlerts.clear(); renderAlertPanel();
  });

  // Time filter buttons (1h / 24h only)
  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
      e.currentTarget.classList.add("active");
      currentFilter = e.currentTarget.dataset.filter;
      const emptyEl = document.getElementById("chartEmptyMsg");
      if (emptyEl) emptyEl.style.display = "none";
      fetchHistoricalData(currentFilter);  // "1h" or "24h"
    });
  });

  // Auto-load 1h on page open
  fetchHistoricalData("1h");

  // Edit modal
  document.getElementById("editBtn")?.addEventListener("click", openEditModal);
  document.getElementById("modalClose")?.addEventListener("click", closeEditModal);
  document.getElementById("modalCancel")?.addEventListener("click", closeEditModal);
  document.getElementById("modalSave")?.addEventListener("click", saveModal);
  document.getElementById("editModal")?.addEventListener("click", e => {
    if (e.target === e.currentTarget) closeEditModal();
  });

  // Reset button
  document.getElementById("resetDataBtn")?.addEventListener("click", resetPatientData);
});
