const { test, expect } = require("@playwright/test");

function uniqueId(prefix) {
  const timePart = Date.now().toString(36).slice(-5);
  const randomPart = Math.floor(Math.random() * 1296).toString(36).padStart(2, "0");
  return `${prefix.slice(0, 6)}_${timePart}${randomPart}`;
}

async function signUp(page, username, password, remember = true) {
  await page.goto("/");
  await page.fill("#registerId", username);
  await page.fill("#registerPassword", password);
  await page.fill("#registerPasswordConfirm", password);

  if (remember) {
    await page.check("#registerRemember");
  } else {
    await page.uncheck("#registerRemember");
  }

  await page.click("#registerSubmitButton");
  await expect(page.locator("#appMain")).toBeVisible();
  await expect(page.locator("#currentUserText")).toContainText(username);
}

async function addMedicine(page, name) {
  await page.fill("#medicineName", name);
  await page.check("#isTaken");
  await page.fill("#medicineMemo", "UI 테스트 메모");
  await page.click("#medicineSubmitButton");
  await expect(page.locator("#todayMedicineList")).toContainText(name);
}

test("가입 화면에서 비밀번호 확인이 일치해야 한다", async ({ page }) => {
  await page.goto("/");
  const username = uniqueId("mismatch");

  await page.fill("#registerId", username);
  await page.fill("#registerPassword", "pass1234");
  await page.fill("#registerPasswordConfirm", "pass9999");
  await page.click("#registerSubmitButton");

  await expect(page.locator("#authMessage")).toContainText("비밀번호 확인이 일치하지 않습니다.");
  await expect(page.locator("#authView")).toBeVisible();
});

test("가입 후 복용 기록과 컨디션 기록을 저장하고 조회한다", async ({ page }) => {
  const username = uniqueId("record");
  await signUp(page, username, "pass1234");

  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });

  await addMedicine(page, "테스트약");
  await page.fill("#sleepHours", "7.5");
  await page.fill("#conditionMemo", "컨디션 UI 테스트");
  await page.click("#conditionForm button[type='submit']");

  await expect(page.locator("#historyMedicineList")).toContainText("테스트약");
  await expect(page.locator("#historyConditionView")).toContainText("7.5시간");
});

test("월 단위로 이전 복용 기록을 모아 볼 수 있다", async ({ page }) => {
  const username = uniqueId("month");
  await signUp(page, username, "pass1234");

  const auth = await page.evaluate(async () => {
    const response = await fetch("/api/auth/me");
    return response.json();
  });

  await page.evaluate(async ({ csrfToken }) => {
    const response = await fetch("/api/data", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        medicines: {
          "2026-05-05": [
            {
              id: "may-early",
              date: "2026-05-05",
              name: "오월초약",
              timeSlot: "아침",
              isTaken: true,
              takenTime: "08:00",
              memo: ""
            }
          ],
          "2026-05-20": [
            {
              id: "may-late",
              date: "2026-05-20",
              name: "오월말약",
              timeSlot: "저녁",
              isTaken: false,
              takenTime: "20:00",
              memo: "월 보기 메모"
            }
          ],
          "2026-06-01": [
            {
              id: "june",
              date: "2026-06-01",
              name: "유월약",
              timeSlot: "점심",
              isTaken: true,
              takenTime: "12:00",
              memo: ""
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
            memo: "오월 컨디션"
          }
        }
      })
    });

    if (!response.ok) {
      throw new Error("테스트 데이터를 저장하지 못했습니다.");
    }
  }, { csrfToken: auth.csrfToken });

  await page.reload();
  await expect(page.locator("#appMain")).toBeVisible();

  await page.check('input[name="historyMode"][value="month"]');
  await page.fill("#historyMonth", "2026-05");

  await expect(page.locator("#historyMedicineList")).toContainText("오월초약");
  await expect(page.locator("#historyMedicineList")).toContainText("오월말약");
  await expect(page.locator("#historyMedicineList")).toContainText("월 보기 메모");
  await expect(page.locator("#historyMedicineList")).not.toContainText("유월약");
  await expect(page.locator("#historyConditionView")).toContainText("오월 컨디션");
});

test("주 단위는 고른 날짜가 속한 월~일만 모아 보여준다", async ({ page }) => {
  const username = uniqueId("week");
  await signUp(page, username, "pass1234");

  const auth = await page.evaluate(async () => {
    const response = await fetch("/api/auth/me");
    return response.json();
  });

  // 2026-05-20은 수요일 → 그 주는 월(2026-05-18)~일(2026-05-24).
  // 경계 밖 05-17(전 일요일)·05-25(다음 월요일)은 제외되어야 한다.
  await page.evaluate(async ({ csrfToken }) => {
    const medicine = (id, name, date) => ({
      id,
      date,
      name,
      timeSlot: "아침",
      isTaken: true,
      takenTime: "08:00",
      memo: ""
    });

    const response = await fetch("/api/data", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        medicines: {
          "2026-05-17": [medicine("prev", "지난주일요약", "2026-05-17")],
          "2026-05-18": [medicine("mon", "이번주월요약", "2026-05-18")],
          "2026-05-24": [medicine("sun", "이번주일요약", "2026-05-24")],
          "2026-05-25": [medicine("next", "다음주월요약", "2026-05-25")]
        },
        conditions: {
          "2026-05-20": {
            sleepiness: "2",
            focus: "4",
            overallCondition: "3",
            sleepHours: "7",
            hadCaffeine: false,
            memo: "수요일 컨디션"
          }
        }
      })
    });

    if (!response.ok) {
      throw new Error("테스트 데이터를 저장하지 못했습니다.");
    }
  }, { csrfToken: auth.csrfToken });

  await page.reload();
  await expect(page.locator("#appMain")).toBeVisible();

  await page.check('input[name="historyMode"][value="week"]');
  await page.fill("#historyWeekDate", "2026-05-20");

  await expect(page.locator("#historyWeekRange")).toContainText("5월 18일");
  await expect(page.locator("#historyWeekRange")).toContainText("5월 24일");
  await expect(page.locator("#historyMedicineList")).toContainText("이번주월요약");
  await expect(page.locator("#historyMedicineList")).toContainText("이번주일요약");
  await expect(page.locator("#historyMedicineList")).not.toContainText("지난주일요약");
  await expect(page.locator("#historyMedicineList")).not.toContainText("다음주월요약");
  await expect(page.locator("#historyConditionView")).toContainText("수요일 컨디션");
});

test("로그아웃 후 같은 계정으로 다시 로그인할 수 있다", async ({ page }) => {
  const username = uniqueId("login");
  await signUp(page, username, "pass1234");
  await addMedicine(page, "재로그인약");

  await page.click("#logoutButton");
  await expect(page.locator("#authView")).toBeVisible();

  await page.fill("#loginId", username);
  await page.fill("#loginPassword", "pass1234");
  await page.click("#loginForm button[type='submit']");

  await expect(page.locator("#appMain")).toBeVisible();
  await expect(page.locator("#todayMedicineList")).toContainText("재로그인약");
});

test("복용 기록 수정과 삭제가 다른 기록을 유실하지 않는다", async ({ page }) => {
  const username = uniqueId("edit");
  await signUp(page, username, "pass1234");
  await addMedicine(page, "첫번째약");
  await addMedicine(page, "두번째약");

  const firstRecord = page.locator(".record-item").filter({ hasText: "첫번째약" });
  await firstRecord.getByRole("button", { name: "수정" }).click();
  await page.fill("#medicineName", "수정된약");
  await page.click("#medicineSubmitButton");

  await expect(page.locator("#todayMedicineList")).toContainText("수정된약");
  await expect(page.locator("#todayMedicineList")).toContainText("두번째약");
  await expect(page.locator("#todayMedicineList")).not.toContainText("첫번째약");

  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  const editedRecord = page.locator(".record-item").filter({ hasText: "수정된약" });
  await editedRecord.getByRole("button", { name: "삭제" }).click();

  await expect(page.locator("#todayMedicineList")).not.toContainText("수정된약");
  await expect(page.locator("#todayMedicineList")).toContainText("두번째약");
});

test("보안 설정에서 기록 암호화를 켜고 자동 로그인 상태에서 잠금 해제할 수 있다", async ({ page }) => {
  const username = uniqueId("secure");
  await signUp(page, username, "pass1234");
  await addMedicine(page, "암호화전약");

  await page.click("#openSecurityButton");
  await expect(page.locator("#securityView")).toBeVisible();

  await page.fill("#enablePassphrase", "wrongpass");
  await page.check("#encryptionWarningConfirm");
  await page.click("#enableEncryptionForm button[type='submit']");
  await expect(page.locator("#securityMessage")).toContainText("비밀번호가 올바르지 않습니다.");

  await page.fill("#enablePassphrase", "pass1234");
  await page.click("#enableEncryptionForm button[type='submit']");
  await expect(page.locator("#securityMessage")).toContainText("모든 기록을 암호화했습니다.");

  const encryptedPayloadText = await page.evaluate(async () => {
    const response = await fetch("/api/data");
    return JSON.stringify(await response.json());
  });
  expect(encryptedPayloadText).toContain('"encrypted":true');
  expect(encryptedPayloadText).not.toContain("암호화전약");

  await page.click("#backToAppButton");
  await expect(page.locator("#todayMedicineList")).toContainText("암호화전약");

  await page.reload();
  await expect(page.locator("#securityView")).toBeVisible();
  await expect(page.locator("#encryptedLockedPanel")).toBeVisible();

  await page.fill("#unlockPassphrase", "pass1234");
  await page.click("#unlockEncryptionForm button[type='submit']");
  await expect(page.locator("#securityMessage")).toContainText("잠금이 해제되었습니다.");

  await page.click("#backToAppButton");
  await expect(page.locator("#todayMedicineList")).toContainText("암호화전약");

  await addMedicine(page, "암호화후약");
  const encryptedAgainText = await page.evaluate(async () => {
    const response = await fetch("/api/data");
    return JSON.stringify(await response.json());
  });
  expect(encryptedAgainText).toContain('"encrypted":true');
  expect(encryptedAgainText).not.toContain("암호화전약");
  expect(encryptedAgainText).not.toContain("암호화후약");

  await page.reload();
  await page.fill("#unlockPassphrase", "wrongpass");
  await page.click("#unlockEncryptionForm button[type='submit']");
  await expect(page.locator("#securityMessage")).toContainText("로그인 비밀번호가 올바르지 않거나 기록을 복호화할 수 없습니다.");
  await expect(page.locator("#encryptedLockedPanel")).toBeVisible();

  await page.fill("#unlockPassphrase", "pass1234");
  await page.click("#unlockEncryptionForm button[type='submit']");
  await page.click("#backToAppButton");
  await expect(page.locator("#todayMedicineList")).toContainText("암호화전약");
  await expect(page.locator("#todayMedicineList")).toContainText("암호화후약");
});

test("암호화된 기록을 복호화해 암호화를 끌 수 있다", async ({ page }) => {
  const username = uniqueId("decrypt");
  await signUp(page, username, "pass1234");
  await addMedicine(page, "복호화약");

  await page.click("#openSecurityButton");
  await page.fill("#enablePassphrase", "pass1234");
  await page.check("#encryptionWarningConfirm");
  await page.click("#enableEncryptionForm button[type='submit']");
  await expect(page.locator("#securityMessage")).toContainText("모든 기록을 암호화했습니다.");

  await page.fill("#disablePassphrase", "wrongpass");
  await page.click("#disableEncryptionForm button[type='submit']");
  await expect(page.locator("#securityMessage")).toContainText("로그인 비밀번호가 올바르지 않거나 기록을 복호화할 수 없습니다.");

  const stillEncryptedText = await page.evaluate(async () => {
    const response = await fetch("/api/data");
    return JSON.stringify(await response.json());
  });
  expect(stillEncryptedText).toContain('"encrypted":true');
  expect(stillEncryptedText).not.toContain("복호화약");

  await page.fill("#disablePassphrase", "pass1234");
  await page.click("#disableEncryptionForm button[type='submit']");
  await expect(page.locator("#securityMessage")).toContainText("암호화를 껐습니다.");

  const plainPayloadText = await page.evaluate(async () => {
    const response = await fetch("/api/data");
    return JSON.stringify(await response.json());
  });
  expect(plainPayloadText).not.toContain('"encrypted":true');
  expect(plainPayloadText).toContain("복호화약");
});
