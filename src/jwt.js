// The claims of a JWT, or null when it is not one.
function jwtClaims(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

// Expiry of a JWT access token in ms, or null when it is not a JWT.
function jwtExpMs(token) {
  const claims = jwtClaims(token);
  return claims && claims.exp ? claims.exp * 1000 : null;
}

module.exports = { jwtExpMs, jwtClaims };
