const { test, expect } = require("@playwright/test");

function uniqueId(prefix) {
  const timePart = Date.now().toString(36).slice(-5);
  const randomPart = Math.floor(Math.random() * 1296).toString(36).padStart(2, "0");
  return `${prefix.slice(0, 6)}_${timePart}${randomPart}`;
}

async function apiRequest(request, path, options = {}) {
  const method = options.method || "GET";
  const headers = {
    ...(options.headers || {})
  };

  if (method !== "GET") {
    headers.Origin = "http://localhost:3100";
  }

  return request.fetch(path, {
    method,
    headers,
    data: options.data
  });
}

async function register(request, username, password = "pass1234", remember = true) {
  const response = await apiRequest(request, "/api/auth/register", {
    method: "POST",
    data: {
      username,
      password,
      passwordConfirm: password,
      remember
    }
  });

  expect(response.status()).toBe(201);
  return response.json();
}

test("ID 중복은 대소문자를 구분하지 않고 막는다", async ({ request }) => {
  const username = `Case${Date.now().toString(36).slice(-5)}`;
  await register(request, username);

  const check = await apiRequest(request, `/api/auth/check-id?username=${username.toLowerCase()}`);
  expect(check.status()).toBe(200);
  expect(await check.json()).toEqual(expect.objectContaining({
    available: false
  }));
});

test("신뢰하지 않는 프록시 환경에서는 위조된 X-Forwarded-Proto 를 무시한다", async ({ request }) => {
  // TRUST_PROXY 가 꺼진 기본 환경(테스트 서버)에서는 클라이언트가 보낸
  // X-Forwarded-Proto 를 신뢰하면 안 된다. 신뢰할 경우 기대 origin 이 https 로
  // 바뀌어 정상 http 요청이 403 으로 거부된다. 무시하면 200 이어야 한다.
  const username = uniqueId("proxy");
  const auth = await register(request, username);

  const response = await request.fetch("/api/data", {
    method: "PUT",
    headers: {
      Origin: "http://localhost:3100",
      "X-Forwarded-Proto": "https",
      "X-CSRF-Token": auth.csrfToken
    },
    data: { medicines: {}, conditions: {} }
  });

  expect(response.status()).toBe(200);
});

test("거부된 데이터 저장 요청은 기존 기록을 변경하지 않는다", async ({ request }) => {
  const username = uniqueId("guard");
  const auth = await register(request, username);
  const csrfToken = auth.csrfToken;
  const baseline = {
    medicines: {
      "2026-05-20": [
        {
          id: "base",
          date: "2026-05-20",
          name: "보존약",
          timeSlot: "아침",
          isTaken: true,
          takenTime: "08:00",
          memo: "보존 메모"
        }
      ]
    },
    conditions: {
      "2026-05-20": {
        sleepiness: "2",
        focus: "4",
        overallCondition: "3",
        sleepHours: "7",
        hadCaffeine: false,
        memo: "보존 컨디션"
      }
    }
  };
  const malicious = {
    medicines: {},
    conditions: {}
  };

  const save = await apiRequest(request, "/api/data", {
    method: "PUT",
    headers: { "X-CSRF-Token": csrfToken },
    data: baseline
  });
  expect(save.status()).toBe(200);

  const noCsrf = await apiRequest(request, "/api/data", {
    method: "PUT",
    data: malicious
  });
  expect(noCsrf.status()).toBe(403);

  const evilOrigin = await request.fetch("/api/data", {
    method: "PUT",
    headers: {
      Origin: "http://evil.example",
      "X-CSRF-Token": csrfToken
    },
    data: malicious
  });
  expect(evilOrigin.status()).toBe(403);

  const after = await apiRequest(request, "/api/data");
  expect(after.status()).toBe(200);
  expect(await after.json()).toEqual(baseline);
});
