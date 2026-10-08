// Expiry of a JWT access token in ms, or null when it is not a JWT.
function jwtExpMs(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

module.exports = { jwtExpMs };
