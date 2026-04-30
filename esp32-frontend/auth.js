"use strict";
// ─── auth.js — included on every protected page ───────────────────────────────
// Provides: getToken, setToken, clearToken, authFetch, requireAuth

const TOKEN_KEY = "hm_token";

// ── Token storage ─────────────────────────────────────────────────────────────
function getToken()          { return localStorage.getItem(TOKEN_KEY); }
function setToken(token)     { localStorage.setItem(TOKEN_KEY, token); }
function clearToken()        { localStorage.removeItem(TOKEN_KEY); }

// ── Auth guard — call at top of every protected page ──────────────────────────
// Redirects to /login if no valid token is stored.
function requireAuth() {
  if (!getToken()) {
    window.location.replace("/login");
    return false;
  }
  return true;
}

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

// ── Logout ────────────────────────────────────────────────────────────────────
function logout() {
  clearToken();
  window.location.replace("/login");
}
