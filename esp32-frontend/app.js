// ─── Config ───────────────────────────────────────────────────────────────────
// URL: /patient?id=P101  (patient_id) or /patient?id=ESP32_01 (legacy deviceId)
const urlParams      = new URLSearchParams(window.location.search);
const PAGE_PATIENT_ID = urlParams.get("id") || null;

// Detect whether the id looks like a patient_id (P###) or a deviceId
const isPatientId = PAGE_PATIENT_ID && /^P\d+$/.test(PAGE_PATIENT_ID);

const API = PAGE_PATIENT_ID
  ? isPatientId
    ? `/api/dashboard?patientId=${encodeURIComponent(PAGE_PATIENT_ID)}`
    : `/api/dashboard?deviceId=${encodeURIComponent(PAGE_PATIENT_ID)}`
  : "/api/dashboard";

let hrChart, spo2Chart, tempChart;
let currentFilter = "live";
let currentDeviceId = null;

// ─── Reference maps ───────────────────────────────────────────────────────────
const deviceNameMap = {
  ESP32_01: "Patient 1",
  ESP32_02: "Patient 2",
};

const explanations = {
  "Stress detected": "Elevated heart rate with normal oxygen suggests stress.",
  "Fever risk": "High temperature with increased heart rate suggests fever.",
  "Respiratory concern": "Low oxygen saturation may indicate breathing issues.",
  Normal: "All vitals are within healthy ranges.",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function healthLabel(score) {
  if (score <= 1) return "Normal";
  if (score <= 3) return "Mild Risk";
  if (score <= 6) return "Moderate Risk";
  return "High Risk";
}

function getVitalStatus(type, value) {
  if (type === "hr") {
    if (value < 60)   return { level: "critical", text: "Critical", icon: "fa-triangle-exclamation" };
    if (value <= 100) return { level: "normal",   text: "Normal",   icon: "fa-circle-check"        };
    if (value <= 120) return { level: "warning",  text: "Warning",  icon: "fa-circle-exclamation"  };
    return               { level: "critical", text: "Critical", icon: "fa-triangle-exclamation" };
  }
  if (type === "spo2") {
    if (value > 95)  return { level: "normal",   text: "Normal",   icon: "fa-circle-check"        };
    if (value >= 92) return { level: "warning",  text: "Warning",  icon: "fa-circle-exclamation"  };
    return              { level: "critical", text: "Critical", icon: "fa-triangle-exclamation" };
  }
  if (type === "temp") {
    if (value < 37.5) return { level: "normal",   text: "Normal",   icon: "fa-circle-check"        };
    if (value <= 38)  return { level: "warning",  text: "Warning",  icon: "fa-circle-exclamation"  };
    return               { level: "critical", text: "Critical", icon: "fa-triangle-exclamation" };
  }
}

function applyStatusToCard(id, statusObj) {
  const statusEl = document.getElementById(`status-${id}`);
  const cardEl   = document.getElementById(`card-${id}`);
  statusEl.innerHTML = `<i class="fa-solid ${statusObj.icon}"></i> ${statusObj.text}`;
  statusEl.className = `vital-status status-${statusObj.level}-bg`;
  cardEl.classList.remove("card-normal", "card-warning", "card-critical");
  cardEl.classList.add(`card-${statusObj.level}`);
}

// ─── WebSocket indicator ──────────────────────────────────────────────────────
function setWsStatus(state) {
  const dot       = document.getElementById("wsDot");
  const text      = document.getElementById("wsText");
  const indicator = document.getElementById("wsIndicator");
  const styles = {
    connected:    { color: "#10b981", label: "Live",          border: "rgba(16,185,129,0.2)",  bg: "rgba(16,185,129,0.1)"  },
    disconnected: { color: "#ef4444", label: "Reconnecting…", border: "rgba(239,68,68,0.2)",   bg: "rgba(239,68,68,0.1)"   },
    connecting:   { color: "#eab308", label: "Connecting…",   border: "rgba(234,179,8,0.2)",   bg: "rgba(234,179,8,0.1)"   },
  };
  const s = styles[state] || styles.connecting;
  dot.style.background          = s.color;
  text.innerText                = s.label;
  indicator.style.borderColor   = s.border;
  indicator.style.background    = s.bg;
}

// ─── Render vitals (shared by WS push + polling) ─────────────────────────────
function renderVitals(vitals, time) {
  const hrStatus   = getVitalStatus("hr",   vitals.heartRate);
  const spo2Status = getVitalStatus("spo2", vitals.spo2);
  const tempStatus = getVitalStatus("temp", vitals.temperature);

  document.getElementById("hr").innerText   = vitals.heartRate;
  document.getElementById("spo2").innerText = vitals.spo2;
  document.getElementById("temp").innerText = vitals.temperature;

  applyStatusToCard("hr",   hrStatus);
  applyStatusToCard("spo2", spo2Status);
  applyStatusToCard("temp", tempStatus);

  // Patient banner
  const banner     = document.getElementById("patientBanner");
  const bannerIcon = document.getElementById("bannerIcon");
  const bannerText = document.getElementById("bannerText");
  const isCritical = [hrStatus, spo2Status, tempStatus].some(s => s.level === "critical");
  if (isCritical) {
    banner.className    = "patient-banner critical";
    bannerIcon.innerText = "🔴";
    bannerText.innerText = "Critical Condition";
  } else {
    banner.className    = "patient-banner stable";
    bannerIcon.innerText = "🟢";
    bannerText.innerText = "Patient Stable";
  }

  // Timestamp
  document.getElementById("updated").innerText =
    `Last updated: ${new Date(time).toLocaleTimeString()}`;

  // Live chart
  const chartLabel = new Date(time).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  updateLiveCharts(chartLabel, vitals.heartRate, vitals.spo2, vitals.temperature);

  // Smart alerts
  generateAlerts(vitals);
}

// ─── Alert Engine ─────────────────────────────────────────────────────────────
const activeAlerts = new Map(); // key → { severity, title, detail, time }

const ALERT_RULES = [
  // Heart rate
  {
    key: "hr_low",
    check: (v) => v.heartRate < 60,
    severity: "critical",
    icon: "fa-heart-crack",
    title: "Low Heart Rate detected",
    detail: (v) => `Heart rate is ${v.heartRate} bpm — below safe threshold (60 bpm)`,
  },
  {
    key: "hr_high_critical",
    check: (v) => v.heartRate > 120,
    severity: "critical",
    icon: "fa-heart-crack",
    title: "Critically High Heart Rate",
    detail: (v) => `Heart rate is ${v.heartRate} bpm — critically elevated (>120 bpm)`,
  },
  {
    key: "hr_high_warning",
    check: (v) => v.heartRate > 100 && v.heartRate <= 120,
    severity: "warning",
    icon: "fa-heart-pulse",
    title: "Elevated Heart Rate",
    detail: (v) => `Heart rate is ${v.heartRate} bpm — above normal range (100–120 bpm)`,
  },
  // SpO₂
  {
    key: "spo2_critical",
    check: (v) => v.spo2 < 92,
    severity: "critical",
    icon: "fa-lungs",
    title: "Low SpO\u2082 detected",
    detail: (v) => `Oxygen saturation is ${v.spo2}% — critically low (<92%)`,
  },
  {
    key: "spo2_warning",
    check: (v) => v.spo2 >= 92 && v.spo2 <= 95,
    severity: "warning",
    icon: "fa-lungs",
    title: "SpO\u2082 slightly low",
    detail: (v) => `Oxygen saturation is ${v.spo2}% — borderline low (92–95%)`,
  },
  // Temperature
  {
    key: "temp_critical",
    check: (v) => v.temperature > 38,
    severity: "critical",
    icon: "fa-temperature-full",
    title: "High Temperature detected",
    detail: (v) => `Temperature is ${v.temperature}\u00b0C — fever threshold exceeded (>38\u00b0C)`,
  },
  {
    key: "temp_warning",
    check: (v) => v.temperature >= 37.5 && v.temperature <= 38,
    severity: "warning",
    icon: "fa-temperature-half",
    title: "Elevated Temperature",
    detail: (v) => `Temperature is ${v.temperature}\u00b0C — slight fever (37.5–38\u00b0C)`,
  },
];

function generateAlerts(vitals) {
  const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  // Add / refresh triggered rules
  ALERT_RULES.forEach((rule) => {
    if (rule.check(vitals)) {
      if (!activeAlerts.has(rule.key)) {
        activeAlerts.set(rule.key, {
          severity: rule.severity,
          icon: rule.icon,
          title: rule.title,
          detail: rule.detail(vitals),
          time: now,
        });
      }
    } else {
      // auto-clear when condition resolves
      activeAlerts.delete(rule.key);
    }
  });

  renderAlertPanel();
}

function renderAlertPanel() {
  const list  = document.getElementById("alertsList");
  const badge = document.getElementById("alertBadge");
  const count = activeAlerts.size;

  // Badge
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = "inline-flex";
  } else {
    badge.style.display = "none";
  }

  // List
  list.innerHTML = "";

  if (count === 0) {
    list.innerHTML = `
      <div class="alert-empty" id="alertEmpty">
        <i class="fa-solid fa-circle-check"></i>
        All vitals are within normal range
      </div>`;
    return;
  }

  let delay = 0;
  activeAlerts.forEach((alert, key) => {
    const div = document.createElement("div");
    div.className = `alert-item alert-${alert.severity}`;
    div.style.animationDelay = `${delay}ms`;
    div.dataset.alertKey = key;
    div.innerHTML = `
      <i class="fa-solid ${alert.icon} alert-icon"></i>
      <div class="alert-body">
        <div class="alert-title">${alert.title}</div>
        <div class="alert-detail">${alert.detail}</div>
      </div>
      <span class="alert-time">${alert.time}</span>
      <button class="alert-dismiss" title="Dismiss" onclick="dismissAlert('${key}')">
        <i class="fa-solid fa-xmark"></i>
      </button>`;
    list.appendChild(div);
    delay += 60;
  });
}

function dismissAlert(key) {
  activeAlerts.delete(key);
  renderAlertPanel();
}

// ─── Chart.js setup ───────────────────────────────────────────────────────────

function makeChartOptions({ yLabel, yMin, yMax, color, tickSuffix }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#ffffff",
        titleColor: "#0f172a",
        bodyColor: "#475569",
        borderColor: "#e2e8f0",
        borderWidth: 1,
        padding: 10,
        callbacks: {
          label: ctx => ` ${ctx.parsed.y}${tickSuffix}`
        }
      }
    },
    scales: {
      x: {
        ticks: { color: "#94a3b8", maxTicksLimit: 8, font: { size: 11 } },
        grid:  { color: "rgba(0,0,0,0.05)" },
        title: { display: true, text: "Time", color: "#94a3b8", font: { size: 11, weight: "500" } }
      },
      y: {
        min: yMin,
        max: yMax,
        ticks: {
          color: "#94a3b8",
          font: { size: 11 },
          callback: val => val + tickSuffix
        },
        grid:  { color: "rgba(0,0,0,0.05)" },
        title: { display: true, text: yLabel, color: "#94a3b8", font: { size: 11, weight: "500" } }
      }
    },
    elements: {
      line:  { tension: 0.4, borderWidth: 2.5 },
      point: { radius: 0, hitRadius: 12, hoverRadius: 5, hoverBackgroundColor: color }
    }
  };
}

function initCharts() {
  const makeChart = (id, label, color, opts) =>
    new Chart(document.getElementById(id).getContext("2d"), {
      type: "line",
      data: { labels: [], datasets: [{ label, data: [], borderColor: color, backgroundColor: color + "18", fill: true }] },
      options: makeChartOptions({ color, ...opts })
    });

  hrChart   = makeChart("hrChart",   "Heart Rate",  "#ef4444", { yLabel: "bpm",  yMin: 30,  yMax: 180, tickSuffix: " bpm" });
  spo2Chart = makeChart("spo2Chart", "SpO₂",        "#0891b2", { yLabel: "%",    yMin: 80,  yMax: 100, tickSuffix: "%" });
  tempChart = makeChart("tempChart", "Temperature", "#d97706", { yLabel: "°C",   yMin: 34,  yMax: 42,  tickSuffix: "°C" });
}

function updateLiveCharts(timeLabel, hr, spo2, temp) {
  if (currentFilter !== "live") return;
  [
    { chart: hrChart,   value: hr   },
    { chart: spo2Chart, value: spo2 },
    { chart: tempChart, value: temp },
  ].forEach(({ chart, value }) => {
    chart.data.labels.push(timeLabel);
    chart.data.datasets[0].data.push(value);
    if (chart.data.labels.length > 20) {
      chart.data.labels.shift();
      chart.data.datasets[0].data.shift();
    }
    chart.update();
  });
}

async function fetchHistoricalData(seconds) {
  if (!currentDeviceId) return;
  try {
    const res    = await fetch(`/data/recent?deviceId=${currentDeviceId}&seconds=${seconds}`);
    const result = await res.json();
    if (!result.data) return;

    const labels = [], hrData = [], spo2Data = [], tempData = [];
    result.data.forEach(d => {
      labels.push(new Date(d.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      hrData.push(d.heartRate);
      spo2Data.push(d.spo2);
      tempData.push(d.temperature);
    });

    [
      { chart: hrChart,   data: hrData   },
      { chart: spo2Chart, data: spo2Data },
      { chart: tempChart, data: tempData },
    ].forEach(({ chart, data }) => {
      chart.data.labels = labels;
      chart.data.datasets[0].data = data;
      chart.update();
    });
  } catch (err) {
    console.error("Historical data fetch failed:", err);
  }
}

// ─── Polling fallback — also fetches fusion/AI insights ─────────────────────
async function loadDashboard() {
  try {
    const res  = await fetch(API);
    const data = await res.json();

    if (data.message === "No data yet") {
      document.getElementById("patientName").innerText = `Health Monitor — ${PAGE_PATIENT_ID || "Waiting for data..."}`;
      document.getElementById("status-label").innerText = "Loading...";
      return;
    }

    currentDeviceId = data.deviceId;
    // Prefer the logical patient name, fallback to deviceId
    const patientName = data.name || data.patient_id || data.deviceId;
    document.getElementById("patientName").innerText = `Health Monitor — ${patientName}`;

    // Overall status card
    const label       = healthLabel(data.fusion.riskScore);
    const statusLabel = document.getElementById("status-label");
    statusLabel.innerText   = label;
    statusLabel.style.color =
      label === "Normal"        ? "#10b981" :
      label === "Mild Risk"     ? "#eab308" :
      label === "Moderate Risk" ? "#f97316" : "#ef4444";

    // Vitals + banner + chart
    renderVitals(data.vitals, data.time);

    // Fusion / AI insights
    const fusionEl = document.getElementById("fusion");
    fusionEl.innerHTML = "";
    data.fusion.indicators.forEach(i => {
      const div = document.createElement("div");
      div.className = "card fusion-item";
      div.innerHTML = `<div class="fusion-item-content"><h4>${i}</h4><p>${explanations[i] || ""}</p></div>`;
      fusionEl.appendChild(div);
    });
  } catch (err) {
    console.warn("Poll fetch failed:", err.message);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initCharts();
  setWsStatus("connecting");

  // ── WebSocket (primary real-time channel) ──────────────────────────────────
  const socket = io();

  socket.on("connect", () => {
    setWsStatus("connected");
    console.log("[WS] Connected:", socket.id);
    // Join this patient's room so we only receive their events
    if (PAGE_PATIENT_ID) socket.emit("join-patient", PAGE_PATIENT_ID);
  });

  socket.on("disconnect", () => {
    setWsStatus("disconnected");
    console.warn("[WS] Disconnected — polling fallback active");
  });

  // Instant push: server emits this the moment ESP32 POSTs /data
  socket.on("vitals-update", (doc) => {
    currentDeviceId = doc.deviceId;
    renderVitals(
      { heartRate: doc.heartRate, spo2: doc.spo2, temperature: doc.temperature },
      doc.timestamp || new Date()
    );
  });


  // ── Polling fallback (5 s) — also pulls fusion/AI data ────────────────────
  setInterval(loadDashboard, 5000);
  loadDashboard();

  // ── Clear All alerts button ───────────────────────────────────────────────
  document.getElementById("clearAlertsBtn").addEventListener("click", () => {
    activeAlerts.clear();
    renderAlertPanel();
  });

  // ── Time-filter buttons ────────────────────────────────────────────────────
  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
      e.target.classList.add("active");
      currentFilter = e.target.dataset.filter;

      if (currentFilter === "live") {
        [hrChart, spo2Chart, tempChart].forEach(c => {
          c.data.labels = [];
          c.data.datasets[0].data = [];
          c.update();
        });
        loadDashboard();
      } else {
        fetchHistoricalData(currentFilter);
      }
    });
  });
});
