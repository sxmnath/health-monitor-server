"use strict";
// ─── auth.js — included on every protected page ───────────────────────────────
// Provides: getToken, setToken, clearToken, authFetch, requireAuth

const TOKEN_KEY = "hm_token";

// ── Token storage ─────────────────────────────────────────────────────────────
function getToken()          { return localStorage.getItem(TOKEN_KEY); }
function setToken(token)     { localStorage.setItem(TOKEN_KEY, token); }
function clearToken()        { localStorage.removeItem(TOKEN_KEY); }

// ── Auth guards ───────────────────────────────────────────────────────────────
// protectPage(): call at top of protected pages — redirects to /login if no token
function protectPage() {
  if (!getToken()) {
    document.documentElement.style.visibility = "hidden";
    window.location.replace("/login");
    return false;
  }
  return true;
}

// publicOnlyPage(): call at top of login/signup — redirects to / if already logged in
function publicOnlyPage() {
  if (getToken()) {
    document.documentElement.style.visibility = "hidden";
    window.location.replace("/");
    return false;
  }
  return true;
}

// requireAuth(): alias kept for backwards compatibility
function requireAuth() { return protectPage(); }

// ── Authenticated fetch wrapper ───────────────────────────────────────────────
// Drop-in replacement for fetch() that:
//   • Injects Authorization: Bearer <token> automatically
//   • Redirects to /login on 401 (expired / invalid token)
async function authFetch(url, options = {}) {
  const token = getToken();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    window.location.replace("/login");
    // Return a never-resolving promise so callers don't continue executing
    return new Promise(() => {});
  }

  return res;
}

// ── fetchCurrentUser() ────────────────────────────────────────────────────────
// Fetches /api/auth/me and populates the topbar user identity elements.
// Call once after DOMContentLoaded on every protected page.
async function fetchCurrentUser() {
  try {
    const res  = await authFetch("/api/auth/me");
    const data = await res.json();
    const user = data.user;
    if (!user) return;

    // Greeting — first name only to keep it compact
    const nameEl = document.getElementById("topbarUserName");
    if (nameEl) {
      nameEl.textContent = user.name ? user.name.split(" ")[0] : user.email;
    }

    // Avatar — swap icon for <img> if a profileImage URL is set
    const avatarEl = document.getElementById("topbarAvatar");
    if (avatarEl && user.profileImage) {
      avatarEl.innerHTML = `<img src="${user.profileImage}" alt="${user.name}" />`;
    }
  } catch (e) {
    // Non-fatal — topbar just stays as "…"
    console.warn("[fetchCurrentUser]", e.message);
  }
}

// ── Logout ────────────────────────────────────────────────────────────────────
function logout() {
  clearToken();
  window.location.replace("/login");
}