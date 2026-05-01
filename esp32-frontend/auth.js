"use strict";
// ─── auth.js — included on every page ─────────────────────────────────────────
// Provides: getToken, setToken, clearToken, authFetch, requireAuth,
//           protectPage, publicOnlyPage, logout

const TOKEN_KEY = "hm_token";

// ── Token storage ──────────────────────────────────────────────────────────────
function getToken()      { return localStorage.getItem(TOKEN_KEY); }
function setToken(token) { localStorage.setItem(TOKEN_KEY, token); }
function clearToken()    { localStorage.removeItem(TOKEN_KEY); }

// ── protectPage() ─────────────────────────────────────────────────────────────
// Call at the very top of any protected page's script block.
// If no token → freeze the page instantly and redirect to /login.
// Returns true when the user is authenticated (so callers can continue).
function protectPage() {
  if (!getToken()) {
    // Hide the page body so nothing flashes before the redirect fires
    document.documentElement.style.visibility = "hidden";
    window.location.replace("/login");
    return false;
  }
  return true;
}

// ── publicOnlyPage() ──────────────────────────────────────────────────────────
// Call at the very top of login/signup scripts.
// If a token already exists → redirect to / (no point showing login again).
function publicOnlyPage() {
  if (getToken()) {
    document.documentElement.style.visibility = "hidden";
    window.location.replace("/");
    return false;
  }
  return true;
}

// ── requireAuth() — kept for backwards compatibility ──────────────────────────
function requireAuth() { return protectPage(); }

// ── authFetch() ───────────────────────────────────────────────────────────────
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

// ── logout() ──────────────────────────────────────────────────────────────────
function logout() {
  clearToken();
  window.location.replace("/login");
}
