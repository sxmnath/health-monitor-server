"use strict";
const jwt  = require("jsonwebtoken");
const User = require("../models/User");

// ─── Token helper ─────────────────────────────────────────────────────────────
/**
 * Signs a JWT containing the user's id and role.
 * Expiry is controlled by JWT_EXPIRES_IN env var (default: "7d").
 */
function signToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

// ─── Protect middleware ───────────────────────────────────────────────────────
/**
 * Requires a valid Bearer JWT in the Authorization header.
 * Attaches the full user document (without password) to req.user.
 *
 * Usage:  router.get("/protected", protect, handler)
 */
async function protect(req, res, next) {
  try {
    // 1. Extract token from "Authorization: Bearer <token>"
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided. Please log in." });
    }
    const token = header.slice(7).trim();

    // 2. Verify signature and expiry
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        return res.status(401).json({ error: "Session expired. Please log in again." });
      }
      return res.status(401).json({ error: "Invalid token. Please log in." });
    }

    // 3. Confirm user still exists and is active
    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      return res.status(401).json({ error: "User no longer exists." });
    }
    if (!user.isActive) {
      return res.status(403).json({ error: "Account is disabled. Contact an administrator." });
    }

    // 4. Attach user + token payload to request
    req.user      = user;
    req.tokenData = decoded;   // { id, role, iat, exp }
    next();

  } catch (err) {
    console.error("[auth.protect]", err);
    res.status(500).json({ error: "Authentication error." });
  }
}

// ─── Role guard middleware factory ────────────────────────────────────────────
/**
 * Must be used AFTER protect().
 * Restricts access to users whose role is in the allowed list.
 *
 * Usage:  router.delete("/...", protect, requireRole("admin"), handler)
 *
 * @param  {...string} roles  One or more allowed roles
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated." });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. Required role: ${roles.join(" or ")}.`,
      });
    }
    next();
  };
}

// ─── Optional auth ────────────────────────────────────────────────────────────
/**
 * Like protect() but does NOT reject unauthenticated requests.
 * If a valid token is present req.user is set; otherwise req.user is null.
 * Useful for routes that behave differently for logged-in vs. anonymous users.
 */
async function optionalAuth(req, _res, next) {
  try {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return next();

    const token   = header.slice(7).trim();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user    = await User.findById(decoded.id).select("-password");
    if (user && user.isActive) req.user = user;
  } catch (_) {
    // Token invalid or expired — continue as unauthenticated
  }
  next();
}

module.exports = { signToken, protect, requireRole, optionalAuth };
