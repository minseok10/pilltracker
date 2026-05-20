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
