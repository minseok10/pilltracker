const SESSION_DAYS = 30;
const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_MAX_AGE * 1000;
const BROWSER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX = 10;
const ID_CHECK_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const ID_CHECK_RATE_LIMIT_MAX = 60;

export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);

  try {
    if (!context.env.DB) {
      return sendJson(500, { error: "D1 데이터베이스가 연결되지 않았습니다." });
    }

    if (!isAllowedOrigin(context.request)) {
      return sendJson(403, { error: "허용되지 않은 출처의 요청입니다." });
    }

    return await handleApi(context.request, context.env.DB, requestUrl);
  } catch (error) {
    console.error(error);
    return sendJson(500, { error: "서버 오류가 발생했습니다." });
  }
}

async function handleApi(request, db, requestUrl) {
  const pathname = requestUrl.pathname;

  if (request.method === "GET" && pathname === "/api/auth/check-id") {
    if (!await consumeRateLimit(db, `id-check:${getClientIp(request)}`, ID_CHECK_RATE_LIMIT_MAX, ID_CHECK_RATE_LIMIT_WINDOW_MS)) {
      return sendJson(429, { error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." });
    }

    const username = requestUrl.searchParams.get("username") || "";
    const result = validateUsername(username);
    const normalized = normalizeUsername(username);
    const user = result.ok ? await getUser(db, normalized) : null;

    return sendJson(result.ok ? 200 : 400, {
      available: result.ok && !user,
      message: result.ok
        ? user ? "이미 사용 중인 ID입니다." : "사용 가능한 ID입니다."
        : result.message
    });
  }

  if (request.method === "POST" && pathname === "/api/auth/register") {
    if (!await consumeRateLimit(db, `auth:${getClientIp(request)}`, AUTH_RATE_LIMIT_MAX, AUTH_RATE_LIMIT_WINDOW_MS)) {
      return sendJson(429, { error: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요." });
    }

    const body = await readJsonBody(request);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const passwordConfirm = String(body.passwordConfirm || "");
    const remember = body.remember !== false;
    const usernameResult = validateUsername(username);
    const passwordResult = validatePassword(password);
    const normalized = normalizeUsername(username);

    if (!usernameResult.ok) {
      return sendJson(400, { error: usernameResult.message });
    }

    if (!passwordResult.ok) {
      return sendJson(400, { error: passwordResult.message });
    }

    if (password !== passwordConfirm) {
      return sendJson(400, { error: "비밀번호 확인이 일치하지 않습니다." });
    }

    if (await getUser(db, normalized)) {
      return sendJson(409, { error: "이미 사용 중인 ID입니다." });
    }

    const salt = createToken(16);
    const user = {
      username,
      usernameKey: normalized,
      passwordSalt: salt,
      passwordHash: await hashPassword(password, salt),
      data: createEmptyUserData(),
      createdAt: new Date().toISOString()
    };

    await db.prepare(
      "INSERT INTO users (username_key, username, password_salt, password_hash, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(
      user.usernameKey,
      user.username,
      user.passwordSalt,
      user.passwordHash,
      JSON.stringify(user.data),
      user.createdAt
    ).run();

    const token = await createSession(db, normalized, remember);
    const session = await getSession(db, token);
    return sendJson(201, authResponse(user, session), {
      cookies: [createSessionCookie(request, token, remember)]
    });
  }

  if (request.method === "POST" && pathname === "/api/auth/login") {
    if (!await consumeRateLimit(db, `auth:${getClientIp(request)}`, AUTH_RATE_LIMIT_MAX, AUTH_RATE_LIMIT_WINDOW_MS)) {
      return sendJson(429, { error: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요." });
    }

    const body = await readJsonBody(request);
    const normalized = normalizeUsername(String(body.username || ""));
    const password = String(body.password || "");
    const remember = body.remember !== false;
    const user = await getUser(db, normalized);

    if (!user || await hashPassword(password, user.passwordSalt) !== user.passwordHash) {
      return sendJson(401, { error: "ID 또는 비밀번호가 올바르지 않습니다." });
    }

    const token = await createSession(db, normalized, remember);
    const session = await getSession(db, token);
    return sendJson(200, authResponse(user, session), {
      cookies: [createSessionCookie(request, token, remember)]
    });
  }

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    const token = getSessionToken(request);
    const session = token ? await getSession(db, token) : null;

    if (session && !isValidCsrf(request, session)) {
      return sendJson(403, { error: "보안 토큰이 올바르지 않습니다. 새로고침 후 다시 시도해주세요." });
    }

    if (token) {
      await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    }

    return sendJson(200, { ok: true }, {
      cookies: [clearSessionCookie(request)]
    });
  }

  if (request.method === "POST" && pathname === "/api/auth/verify-password") {
    if (!await consumeRateLimit(db, `auth:${getClientIp(request)}`, AUTH_RATE_LIMIT_MAX, AUTH_RATE_LIMIT_WINDOW_MS)) {
      return sendJson(429, { error: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요." });
    }

    const session = await getAuthenticatedSession(db, request);
    if (!session) {
      return sendJson(401, { error: "로그인이 필요합니다." });
    }

    if (!isValidCsrf(request, session)) {
      return sendJson(403, { error: "보안 토큰이 올바르지 않습니다. 새로고침 후 다시 시도해주세요." });
    }

    const body = await readJsonBody(request);
    const user = await getUser(db, session.username);
    const password = String(body.password || "");

    if (!user || await hashPassword(password, user.passwordSalt) !== user.passwordHash) {
      return sendJson(401, { error: "비밀번호가 올바르지 않습니다." });
    }

    return sendJson(200, { ok: true });
  }

  if (request.method === "GET" && pathname === "/api/auth/me") {
    const session = await getAuthenticatedSession(db, request);
    if (!session) {
      return sendJson(401, { error: "로그인이 필요합니다." });
    }

    const user = await getUser(db, session.username);
    return sendJson(200, authResponse(user, session));
  }

  if (request.method === "GET" && pathname === "/api/data") {
    const session = await getAuthenticatedSession(db, request);
    if (!session) {
      return sendJson(401, { error: "로그인이 필요합니다." });
    }

    const user = await getUser(db, session.username);
    return sendJson(200, sanitizeUserData(user.data));
  }

  if (request.method === "PUT" && pathname === "/api/data") {
    const session = await getAuthenticatedSession(db, request);
    if (!session) {
      return sendJson(401, { error: "로그인이 필요합니다." });
    }

    if (!isValidCsrf(request, session)) {
      return sendJson(403, { error: "보안 토큰이 올바르지 않습니다. 새로고침 후 다시 시도해주세요." });
    }

    const body = await readJsonBody(request);
    const data = sanitizeUserData(body);
    await db.prepare("UPDATE users SET data_json = ? WHERE username_key = ?")
      .bind(JSON.stringify(data), session.username)
      .run();

    return sendJson(200, data);
  }

  return sendJson(404, { error: "요청한 API를 찾을 수 없습니다." });
}

async function readJsonBody(request) {
  if (!request.body) {
    return {};
  }

  return request.json();
}

async function getUser(db, usernameKey) {
  const row = await db.prepare(
    "SELECT username_key, username, password_salt, password_hash, data_json, created_at FROM users WHERE username_key = ?"
  ).bind(usernameKey).first();

  if (!row) {
    return null;
  }

  return {
    usernameKey: row.username_key,
    username: row.username,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    data: safeJsonParse(row.data_json, createEmptyUserData()),
    createdAt: row.created_at
  };
}

async function getSession(db, token) {
  const row = await db.prepare(
    "SELECT token, username_key, csrf_token, expires_at FROM sessions WHERE token = ?"
  ).bind(token).first();

  if (!row) {
    return null;
  }

  return {
    token: row.token,
    username: row.username_key,
    csrfToken: row.csrf_token,
    expiresAt: Number(row.expires_at)
  };
}

async function getAuthenticatedSession(db, request) {
  const token = getSessionToken(request);
  if (!token) {
    return null;
  }

  const session = await getSession(db, token);
  const user = session ? await getUser(db, session.username) : null;
  if (!session || session.expiresAt <= Date.now() || !user) {
    await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    return null;
  }

  return session;
}

async function createSession(db, username, remember) {
  const token = createToken(32);
  await cleanupExpiredSessions(db);
  await db.prepare(
    "INSERT INTO sessions (token, username_key, csrf_token, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(
    token,
    username,
    createToken(32),
    Date.now() + (remember ? SESSION_TTL_MS : BROWSER_SESSION_TTL_MS)
  ).run();
  return token;
}

async function cleanupExpiredSessions(db) {
  await db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(Date.now()).run();
}

function getSessionToken(request) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  return cookies.sid || "";
}

function parseCookies(cookieHeader) {
  return cookieHeader.split(";").reduce(function (cookies, item) {
    const index = item.indexOf("=");
    if (index === -1) {
      return cookies;
    }

    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function createSessionCookie(request, token, remember) {
  const cookieParts = [
    `sid=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax"
  ];

  if (isSecureRequest(request)) {
    cookieParts.push("Secure");
  }

  if (remember) {
    cookieParts.push(`Max-Age=${SESSION_MAX_AGE}`);
  }

  return cookieParts.join("; ");
}

function clearSessionCookie(request) {
  const cookieParts = [
    "sid=",
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0"
  ];

  if (isSecureRequest(request)) {
    cookieParts.push("Secure");
  }

  return cookieParts.join("; ");
}

async function hashPassword(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: hexToBytes(salt),
      iterations: 100000,
      hash: "SHA-512"
    },
    keyMaterial,
    512
  );

  return bytesToHex(new Uint8Array(bits));
}

function normalizeUsername(username) {
  return String(username).trim().toLowerCase();
}

function validateUsername(username) {
  const trimmed = String(username || "").trim();

  if (!/^[A-Za-z0-9_]{3,20}$/.test(trimmed)) {
    return { ok: false, message: "ID는 영문, 숫자, 밑줄로 3~20자만 사용할 수 있습니다." };
  }

  return { ok: true };
}

function validatePassword(password) {
  if (String(password || "").length < 4) {
    return { ok: false, message: "비밀번호는 4자 이상이어야 합니다." };
  }

  return { ok: true };
}

function createEmptyUserData() {
  return {
    medicines: {},
    conditions: {}
  };
}

function sanitizeUserData(data) {
  const source = data && typeof data === "object" ? data : {};

  if (source.encrypted === true && source.encryption && typeof source.encryption === "object") {
    return {
      encrypted: true,
      encryption: source.encryption
    };
  }

  return {
    medicines: source.medicines && typeof source.medicines === "object" ? source.medicines : {},
    conditions: source.conditions && typeof source.conditions === "object" ? source.conditions : {}
  };
}

function publicUser(user) {
  return {
    username: user.username
  };
}

function authResponse(user, session) {
  return {
    user: publicUser(user),
    csrfToken: session.csrfToken
  };
}

function createToken(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function isValidCsrf(request, session) {
  const token = request.headers.get("x-csrf-token") || "";
  if (typeof session.csrfToken !== "string" || token.length !== session.csrfToken.length) {
    return false;
  }

  return constantTimeEqual(token, session.csrfToken);
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return result === 0;
}

function isAllowedOrigin(request) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    return true;
  }

  const expectedOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin) {
    return origin === expectedOrigin;
  }

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === expectedOrigin;
    } catch (error) {
      return false;
    }
  }

  return true;
}

function isSecureRequest(request) {
  return new URL(request.url).protocol === "https:";
}

// Rate limits are stored in D1 rather than an in-memory Map: Pages Functions run
// across many short-lived, non-shared isolates, so an in-process Map never
// accumulates enough hits to trip a limit. D1 gives every isolate a shared,
// durable counter.
//
// The increment and the limit decision happen in a single atomic statement: a
// separate SELECT-then-UPDATE would let a concurrent burst on the same key all
// read the same pre-increment count and slip through. The upsert either inserts
// a fresh counter (count=1), resets it if the fixed window has elapsed, or
// increments it, and RETURNs the resulting count for the check. SQLite serializes
// writes, so each concurrent request gets its own distinct post-increment value.
async function consumeRateLimit(db, key, maxRequests, windowMs) {
  const now = Date.now();
  const resetAt = now + windowMs;

  const row = await db.prepare(
    "INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?) " +
    "ON CONFLICT(key) DO UPDATE SET " +
    "count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END, " +
    "reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END " +
    "RETURNING count"
  ).bind(key, resetAt, now, now, resetAt).first();

  // Opportunistically purge expired rows so the table doesn't grow unbounded
  // from one-off keys. Sampled rather than run every request to avoid a second
  // round-trip on the hot path; it never affects the decision above.
  if (Math.random() < 0.02) {
    await db.prepare("DELETE FROM rate_limits WHERE reset_at <= ?").bind(now).run();
  }

  return Number(row.count) <= maxRequests;
}

function getClientIp(request) {
  const forwardedFor = String(request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return request.headers.get("cf-connecting-ip") || forwardedFor || "unknown";
}

function applySecurityHeaders(headers) {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'"
  ].join("; "));
}

function sendJson(statusCode, payload, options = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  applySecurityHeaders(headers);

  (options.cookies || []).forEach(function (cookie) {
    headers.append("Set-Cookie", cookie);
  });

  return new Response(JSON.stringify(payload), {
    status: statusCode,
    headers
  });
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return fallback;
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(function (byte) {
    return byte.toString(16).padStart(2, "0");
  }).join("");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}
