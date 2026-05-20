const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = 30;
const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_MAX_AGE * 1000;
const BROWSER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/style.css", "style.css"],
  ["/app.js", "app.js"]
]);

let db = loadDb();

const server = http.createServer(async function (req, res) {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApi(req, res, requestUrl);
      return;
    }

    serveStatic(res, requestUrl.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "서버 오류가 발생했습니다." });
  }
});

server.listen(PORT, function () {
  console.log(`Medicine record app is running at http://localhost:${PORT}`);
});

async function handleApi(req, res, requestUrl) {
  const pathname = requestUrl.pathname;

  if (req.method === "GET" && pathname === "/api/auth/check-id") {
    const username = requestUrl.searchParams.get("username") || "";
    const result = validateUsername(username);
    const normalized = normalizeUsername(username);
    sendJson(res, result.ok ? 200 : 400, {
      available: result.ok && !db.users[normalized],
      message: result.ok
        ? db.users[normalized] ? "이미 사용 중인 ID입니다." : "사용 가능한 ID입니다."
        : result.message
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/register") {
    const body = await readJsonBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const remember = body.remember !== false;
    const usernameResult = validateUsername(username);
    const passwordResult = validatePassword(password);
    const normalized = normalizeUsername(username);

    if (!usernameResult.ok) {
      sendJson(res, 400, { error: usernameResult.message });
      return;
    }

    if (!passwordResult.ok) {
      sendJson(res, 400, { error: passwordResult.message });
      return;
    }

    if (db.users[normalized]) {
      sendJson(res, 409, { error: "이미 사용 중인 ID입니다." });
      return;
    }

    const salt = crypto.randomBytes(16).toString("hex");
    db.users[normalized] = {
      username,
      usernameKey: normalized,
      passwordSalt: salt,
      passwordHash: hashPassword(password, salt),
      data: createEmptyUserData(),
      createdAt: new Date().toISOString()
    };

    const token = createSession(normalized, remember);
    saveDb();
    setSessionCookie(res, token, remember);
    sendJson(res, 201, { user: publicUser(db.users[normalized]) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/login") {
    const body = await readJsonBody(req);
    const normalized = normalizeUsername(String(body.username || ""));
    const password = String(body.password || "");
    const remember = body.remember !== false;
    const user = db.users[normalized];

    if (!user || hashPassword(password, user.passwordSalt) !== user.passwordHash) {
      sendJson(res, 401, { error: "ID 또는 비밀번호가 올바르지 않습니다." });
      return;
    }

    const token = createSession(normalized, remember);
    saveDb();
    setSessionCookie(res, token, remember);
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/logout") {
    const token = getSessionToken(req);
    if (token) {
      delete db.sessions[token];
      saveDb();
    }

    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/auth/me") {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "로그인이 필요합니다." });
      return;
    }

    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === "GET" && pathname === "/api/data") {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "로그인이 필요합니다." });
      return;
    }

    sendJson(res, 200, sanitizeUserData(user.data));
    return;
  }

  if (req.method === "PUT" && pathname === "/api/data") {
    const session = getAuthenticatedSession(req);
    if (!session) {
      sendJson(res, 401, { error: "로그인이 필요합니다." });
      return;
    }

    const body = await readJsonBody(req);
    db.users[session.username].data = sanitizeUserData(body);
    saveDb();
    sendJson(res, 200, db.users[session.username].data);
    return;
  }

  sendJson(res, 404, { error: "요청한 API를 찾을 수 없습니다." });
}

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(DB_FILE)) {
    return { users: {}, sessions: {} };
  }

  const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  return {
    users: parsed.users || {},
    sessions: parsed.sessions || {}
  };
}

function saveDb() {
  cleanupExpiredSessions();
  const tmpFile = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(db, null, 2));
  fs.renameSync(tmpFile, DB_FILE);
}

function serveStatic(res, pathname) {
  const fileName = STATIC_FILES.get(pathname);

  if (!fileName) {
    sendText(res, 404, "Not found");
    return;
  }

  const filePath = path.join(__dirname, fileName);
  const ext = path.extname(fileName);
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8"
  };

  res.writeHead(200, { "Content-Type": contentTypes[ext] || "text/plain; charset=utf-8" });
  fs.createReadStream(filePath).pipe(res);
}

function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    let body = "";

    req.on("data", function (chunk) {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("요청 본문이 너무 큽니다."));
        req.destroy();
      }
    });

    req.on("end", function () {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function getAuthenticatedUser(req) {
  const session = getAuthenticatedSession(req);
  return session ? db.users[session.username] : null;
}

function getAuthenticatedSession(req) {
  const token = getSessionToken(req);
  if (!token) {
    return null;
  }

  const session = db.sessions[token];
  if (!session || session.expiresAt <= Date.now() || !db.users[session.username]) {
    delete db.sessions[token];
    saveDb();
    return null;
  }

  return session;
}

function createSession(username, remember) {
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions[token] = {
    username,
    expiresAt: Date.now() + (remember ? SESSION_TTL_MS : BROWSER_SESSION_TTL_MS)
  };
  return token;
}

function cleanupExpiredSessions() {
  const now = Date.now();
  Object.keys(db.sessions).forEach(function (token) {
    if (db.sessions[token].expiresAt <= now) {
      delete db.sessions[token];
    }
  });
}

function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie || "");
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

function setSessionCookie(res, token, remember) {
  const cookieParts = [
    `sid=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax"
  ];

  if (remember) {
    cookieParts.push(`Max-Age=${SESSION_MAX_AGE}`);
  }

  res.setHeader("Set-Cookie", [cookieParts.join("; ")]);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", ["sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"]);
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}
