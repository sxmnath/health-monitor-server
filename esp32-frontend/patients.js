const PATIENTS_API = "/api/patients";

// ─── WS indicator ─────────────────────────────────────────────────────────────
function setWardWsStatus(state) {
  const dot  = document.getElementById("wardWsDot");
  const text = document.getElementById("wardWsText");
  const pill = document.getElementById("wardWsIndicator");
  const map  = {
    connected:    { color: "#10b981", label: "Live",         border: "rgba(16,185,129,0.25)", bg: "rgba(16,185,129,0.08)" },
    disconnected: { color: "#ef4444", label: "Reconnecting…", border: "rgba(239,68,68,0.25)",  bg: "rgba(239,68,68,0.08)"  },
    connecting:   { color: "#eab308", label: "Connecting…",   border: "rgba(234,179,8,0.25)",  bg: "rgba(234,179,8,0.08)"  },
  };
  const s = map[state] || map.connecting;
  dot.style.background  = s.color;
  text.textContent      = s.label;
  pill.style.borderColor = s.border;
  pill.style.background  = s.bg;
  pill.style.color       = s.color;
}

// ─── Time-ago helper ──────────────────────────────────────────────────────────
function timeAgo(dateStr) {
  const secs = Math.floor((Date.now() - new Date(dateStr)) / 1000);
  if (secs < 10)  return "just now";
  if (secs < 60)  return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

// ─── Card builder ─────────────────────────────────────────────────────────────
function buildCard(patient, index) {
  const { patient_id, deviceId, name, vitals, fusion, status, lastSeen } = patient;

  const badgeClass = `badge-${status}`;
  const badgeLabel = status.charAt(0).toUpperCase() + status.slice(1);
  const insight    = fusion.indicators[0] || "Normal";

  const card = document.createElement("a");
  card.className = `patient-card status-${status}`;
  card.href      = `/patient?id=${encodeURIComponent(patient_id)}`;
  card.style.animationDelay = `${index * 80}ms`;

  card.innerHTML = `
    <div class="card-top">
      <span class="patient-name">
        <i class="fa-solid fa-user-injured" style="font-size:1rem;margin-right:8px;opacity:0.7"></i>
        ${name}
      </span>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="pid-badge">${patient_id}</span>
        <span class="status-badge ${badgeClass}">${badgeLabel}</span>
      </div>
    </div>

    <div class="vitals-row">
      <div class="vital-chip">
        <i class="fa-solid fa-heart-pulse chip-icon chip-icon-hr"></i>
        <span class="chip-val">${vitals.heartRate}</span>
        <span class="chip-unit">bpm</span>
      </div>
      <div class="vital-chip">
        <i class="fa-solid fa-lungs chip-icon chip-icon-spo2"></i>
        <span class="chip-val">${vitals.spo2}</span>
        <span class="chip-unit">SpO₂ %</span>
      </div>
      <div class="vital-chip">
        <i class="fa-solid fa-temperature-half chip-icon chip-icon-temp"></i>
        <span class="chip-val">${vitals.temperature}</span>
        <span class="chip-unit">°C</span>
      </div>
    </div>

    <div class="insight-row">
      <i class="fa-solid fa-brain"></i>
      <span>${insight}</span>
    </div>

    <div class="card-footer">
      <span class="last-seen"><i class="fa-regular fa-clock"></i> ${timeAgo(lastSeen)}</span>
      <span class="view-btn">View Dashboard <i class="fa-solid fa-arrow-right"></i></span>
    </div>`;

  return card;
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderPatients(patients) {
  const grid = document.getElementById("patientGrid");
  grid.innerHTML = "";

  if (!patients.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-plug-circle-xmark"></i>
        <p>No patients found. Waiting for ESP32 devices to send data…</p>
      </div>`;
    return;
  }

  patients.forEach((p, i) => grid.appendChild(buildCard(p, i)));

  // Update summary strip
  document.getElementById("patientCount").textContent = patients.length;
  document.getElementById("countCritical").textContent = patients.filter(p => p.status === "critical").length;
  document.getElementById("countWarning").textContent  = patients.filter(p => p.status === "warning").length;
  document.getElementById("countStable").textContent   = patients.filter(p => p.status === "stable").length;

  document.getElementById("wardUpdated").textContent =
    `Last updated: ${new Date().toLocaleTimeString()}`;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────
async function fetchPatients() {
  try {
    const res  = await fetch(PATIENTS_API);
    const data = await res.json();
    renderPatients(Array.isArray(data) ? data : []);
  } catch (err) {
    console.warn("Failed to fetch patients:", err.message);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  setWardWsStatus("connecting");
  fetchPatients();

  // WebSocket
  const socket = io();
  socket.on("connect",    () => setWardWsStatus("connected"));
  socket.on("disconnect", () => setWardWsStatus("disconnected"));

  // Re-fetch list whenever any patient sends new data
  socket.on("patient-list-update", () => fetchPatients());

  // Polling fallback — also refreshes time-ago labels
  setInterval(fetchPatients, 5000);
});
