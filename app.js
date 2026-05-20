const STORAGE_KEY = "medicineRecordAppData";
const ENCRYPTION_VERSION = 1;
const ENCRYPTION_ITERATIONS = 250000;
const ENCRYPTION_SALT_BYTES = 16;
const ENCRYPTION_IV_BYTES = 12;

const today = getTodayString();
let editingRecordId = null;
let appData = createEmptyData();
let currentUser = null;
let csrfToken = "";
let idCheckTimer = null;
let encryptionState = createEncryptionState();

const elements = {
  authView: document.querySelector("#authView"),
  appMain: document.querySelector("#appMain"),
  securityView: document.querySelector("#securityView"),
  loginForm: document.querySelector("#loginForm"),
  loginId: document.querySelector("#loginId"),
  loginPassword: document.querySelector("#loginPassword"),
  loginRemember: document.querySelector("#loginRemember"),
  registerForm: document.querySelector("#registerForm"),
  registerId: document.querySelector("#registerId"),
  registerPassword: document.querySelector("#registerPassword"),
  registerRemember: document.querySelector("#registerRemember"),
  registerIdStatus: document.querySelector("#registerIdStatus"),
  registerSubmitButton: document.querySelector("#registerSubmitButton"),
  authMessage: document.querySelector("#authMessage"),
  openSecurityButton: document.querySelector("#openSecurityButton"),
  logoutButton: document.querySelector("#logoutButton"),
  securityLogoutButton: document.querySelector("#securityLogoutButton"),
  backToAppButton: document.querySelector("#backToAppButton"),
  securityStatusText: document.querySelector("#securityStatusText"),
  encryptedLockedPanel: document.querySelector("#encryptedLockedPanel"),
  encryptionOffPanel: document.querySelector("#encryptionOffPanel"),
  encryptionOnPanel: document.querySelector("#encryptionOnPanel"),
  unlockEncryptionForm: document.querySelector("#unlockEncryptionForm"),
  unlockPassphrase: document.querySelector("#unlockPassphrase"),
  enableEncryptionForm: document.querySelector("#enableEncryptionForm"),
  enablePassphrase: document.querySelector("#enablePassphrase"),
  encryptionWarningConfirm: document.querySelector("#encryptionWarningConfirm"),
  disableEncryptionForm: document.querySelector("#disableEncryptionForm"),
  disablePassphrase: document.querySelector("#disablePassphrase"),
  securityMessage: document.querySelector("#securityMessage"),
  currentUserText: document.querySelector("#currentUserText"),
  todayText: document.querySelector("#todayText"),
  medicineForm: document.querySelector("#medicineForm"),
  medicineName: document.querySelector("#medicineName"),
  timeSlot: document.querySelector("#timeSlot"),
  customSlotWrap: document.querySelector("#customSlotWrap"),
  customSlot: document.querySelector("#customSlot"),
  takenTime: document.querySelector("#takenTime"),
  isTaken: document.querySelector("#isTaken"),
  medicineMemo: document.querySelector("#medicineMemo"),
  medicineSubmitButton: document.querySelector("#medicineSubmitButton"),
  cancelEditButton: document.querySelector("#cancelEditButton"),
  conditionForm: document.querySelector("#conditionForm"),
  sleepiness: document.querySelector("#sleepiness"),
  focus: document.querySelector("#focus"),
  overallCondition: document.querySelector("#overallCondition"),
  sleepinessValue: document.querySelector("#sleepinessValue"),
  focusValue: document.querySelector("#focusValue"),
  overallConditionValue: document.querySelector("#overallConditionValue"),
  sleepHours: document.querySelector("#sleepHours"),
  hadCaffeine: document.querySelector("#hadCaffeine"),
  conditionMemo: document.querySelector("#conditionMemo"),
  todayMedicineList: document.querySelector("#todayMedicineList"),
  historyDate: document.querySelector("#historyDate"),
  historyMedicineList: document.querySelector("#historyMedicineList"),
  historyConditionView: document.querySelector("#historyConditionView")
};

startApp();

async function startApp() {
  elements.todayText.textContent = formatDateForView(today);
  elements.historyDate.value = today;
  setDefaultTakenTime();
  updateRangeNumbers();
  bindEvents();
  await restoreSession();
}

function bindEvents() {
  elements.loginForm.addEventListener("submit", login);
  elements.registerForm.addEventListener("submit", register);
  elements.registerId.addEventListener("input", scheduleIdCheck);
  elements.openSecurityButton.addEventListener("click", openSecuritySettings);
  elements.logoutButton.addEventListener("click", logout);
  elements.securityLogoutButton.addEventListener("click", logout);
  elements.backToAppButton.addEventListener("click", backToApp);
  elements.unlockEncryptionForm.addEventListener("submit", unlockEncryption);
  elements.enableEncryptionForm.addEventListener("submit", enableEncryption);
  elements.disableEncryptionForm.addEventListener("submit", disableEncryption);
  elements.medicineForm.addEventListener("submit", saveMedicineRecord);
  elements.conditionForm.addEventListener("submit", saveConditionRecord);
  elements.timeSlot.addEventListener("change", toggleCustomSlot);
  elements.cancelEditButton.addEventListener("click", resetMedicineForm);
  elements.historyDate.addEventListener("change", renderHistory);
  elements.todayMedicineList.addEventListener("click", handleMedicineListClick);

  [elements.sleepiness, elements.focus, elements.overallCondition].forEach(function (range) {
    range.addEventListener("input", updateRangeNumbers);
  });
}

async function restoreSession() {
  try {
    const result = await apiRequest("/api/auth/me");
    currentUser = result.user;
    csrfToken = result.csrfToken;
    await enterApp();
  } catch (error) {
    showAuth();
  }
}

async function login(event) {
  event.preventDefault();
  setAuthMessage("");
  const loginPassword = elements.loginPassword.value;

  try {
    const result = await apiRequest("/api/auth/login", {
      method: "POST",
      body: {
        username: elements.loginId.value.trim(),
        password: loginPassword,
        remember: elements.loginRemember.checked
      }
    });

    currentUser = result.user;
    csrfToken = result.csrfToken;
    await enterApp(loginPassword);
  } catch (error) {
    setAuthMessage(error.message, true);
  } finally {
    elements.loginPassword.value = "";
  }
}

async function register(event) {
  event.preventDefault();
  setAuthMessage("");

  try {
    const result = await apiRequest("/api/auth/register", {
      method: "POST",
      body: {
        username: elements.registerId.value.trim(),
        password: elements.registerPassword.value,
        remember: elements.registerRemember.checked
      }
    });

    currentUser = result.user;
    csrfToken = result.csrfToken;
    elements.registerPassword.value = "";
    await enterApp();
  } catch (error) {
    setAuthMessage(error.message, true);
    await checkRegisterId();
  }
}

async function logout() {
  await apiRequest("/api/auth/logout", { method: "POST" });
  currentUser = null;
  csrfToken = "";
  appData = createEmptyData();
  encryptionState = createEncryptionState();
  resetMedicineForm();
  showAuth();
}

function scheduleIdCheck() {
  clearTimeout(idCheckTimer);
  elements.registerSubmitButton.disabled = true;
  setIdStatus("확인 중...", "muted");
  idCheckTimer = setTimeout(checkRegisterId, 300);
}

async function checkRegisterId() {
  const username = elements.registerId.value.trim();

  if (!username) {
    setIdStatus("영문, 숫자, 밑줄로 3~20자", "muted");
    elements.registerSubmitButton.disabled = false;
    return;
  }

  try {
    const result = await apiRequest(`/api/auth/check-id?username=${encodeURIComponent(username)}`);
    setIdStatus(result.message, result.available ? "success" : "error");
    elements.registerSubmitButton.disabled = !result.available;
  } catch (error) {
    setIdStatus(error.message, "error");
    elements.registerSubmitButton.disabled = true;
  }
}

async function enterApp(loginPassword) {
  elements.authView.classList.add("hidden");
  elements.currentUserText.textContent = `${currentUser.username} 님의 기록`;

  const savedData = await apiRequest("/api/data");
  if (isEncryptedData(savedData)) {
    encryptionState = {
      enabled: true,
      locked: true,
      key: null,
      envelope: savedData.encryption
    };
    appData = createEmptyData();

    if (loginPassword) {
      try {
        const result = await decryptEnvelope(encryptionState.envelope, loginPassword);
        encryptionState.key = result.key;
        encryptionState.locked = false;
        appData = sanitizeData(result.data);
        showApp();
        loadConditionForm(today);
        updateRangeNumbers();
        renderAll();
        return;
      } catch (error) {
        setSecurityMessage("로그인 비밀번호로 기록을 복호화하지 못했습니다. 비밀번호를 다시 입력해주세요.", true);
      }
    }

    showSecurity();
    if (!loginPassword) {
      setSecurityMessage("암호화된 기록을 보려면 로그인 비밀번호를 입력해주세요.", false);
    }
    return;
  }

  encryptionState = createEncryptionState();
  appData = sanitizeData(savedData);
  await migrateLocalStorageDataIfNeeded();
  showApp();
  loadConditionForm(today);
  updateRangeNumbers();
  renderAll();
}

function showAuth() {
  elements.appMain.classList.add("hidden");
  elements.securityView.classList.add("hidden");
  elements.authView.classList.remove("hidden");
}

function showApp() {
  elements.authView.classList.add("hidden");
  elements.securityView.classList.add("hidden");
  elements.appMain.classList.remove("hidden");
}

function showSecurity() {
  elements.authView.classList.add("hidden");
  elements.appMain.classList.add("hidden");
  elements.securityView.classList.remove("hidden");
  renderSecuritySettings();
}

function openSecuritySettings() {
  setSecurityMessage("", false);
  showSecurity();
}

function backToApp() {
  if (encryptionState.enabled && encryptionState.locked) {
    setSecurityMessage("기록을 보려면 먼저 로그인 비밀번호로 잠금 해제해주세요.", true);
    return;
  }

  showApp();
  loadConditionForm(today);
  updateRangeNumbers();
  renderAll();
}

function renderSecuritySettings() {
  elements.encryptedLockedPanel.classList.toggle("hidden", !(encryptionState.enabled && encryptionState.locked));
  elements.encryptionOffPanel.classList.toggle("hidden", encryptionState.enabled);
  elements.encryptionOnPanel.classList.toggle("hidden", !(encryptionState.enabled && !encryptionState.locked));

  if (encryptionState.enabled && encryptionState.locked) {
    elements.securityStatusText.textContent = "서버 저장 암호화가 켜져 있고 기록이 잠겨 있습니다.";
  } else if (encryptionState.enabled) {
    elements.securityStatusText.textContent = "서버 저장 암호화가 켜져 있습니다.";
  } else {
    elements.securityStatusText.textContent = "서버 저장 암호화가 꺼져 있습니다.";
  }
}

async function unlockEncryption(event) {
  event.preventDefault();
  setSecurityMessage("");

  try {
    await verifyLoginPassword(elements.unlockPassphrase.value);
    const result = await decryptEnvelope(encryptionState.envelope, elements.unlockPassphrase.value);
    encryptionState.key = result.key;
    encryptionState.locked = false;
    appData = sanitizeData(result.data);
    elements.unlockPassphrase.value = "";
    renderSecuritySettings();
    loadConditionForm(today);
    updateRangeNumbers();
    renderAll();
    setSecurityMessage("잠금이 해제되었습니다.", false);
  } catch (error) {
    setSecurityMessage("로그인 비밀번호가 올바르지 않거나 기록을 복호화할 수 없습니다.", true);
  }
}

async function enableEncryption(event) {
  event.preventDefault();
  setSecurityMessage("");

  const passphrase = elements.enablePassphrase.value;
  if (!passphrase) {
    setSecurityMessage("로그인 비밀번호를 입력해주세요.", true);
    return;
  }

  if (!elements.encryptionWarningConfirm.checked) {
    setSecurityMessage("복구 불가 안내를 확인해야 암호화를 켤 수 있습니다.", true);
    return;
  }

  try {
    await verifyLoginPassword(passphrase);
    const encrypted = await createEncryptedPayload(appData, passphrase);
    await saveRawData(encrypted.payload);
    encryptionState = {
      enabled: true,
      locked: false,
      key: encrypted.key,
      envelope: encrypted.payload.encryption
    };
    elements.enableEncryptionForm.reset();
    renderSecuritySettings();
    setSecurityMessage("모든 기록을 암호화했습니다.", false);
  } catch (error) {
    setSecurityMessage(error.message, true);
  }
}

async function disableEncryption(event) {
  event.preventDefault();
  setSecurityMessage("");

  try {
    await verifyLoginPassword(elements.disablePassphrase.value);
    const result = await decryptEnvelope(encryptionState.envelope, elements.disablePassphrase.value);
    const plainData = sanitizeData(result.data);
    await saveRawData(plainData);
    appData = plainData;
    encryptionState = createEncryptionState();
    elements.disableEncryptionForm.reset();
    renderSecuritySettings();
    loadConditionForm(today);
    updateRangeNumbers();
    renderAll();
    setSecurityMessage("모든 기록을 복호화하고 암호화를 껐습니다.", false);
  } catch (error) {
    setSecurityMessage("로그인 비밀번호가 올바르지 않거나 기록을 복호화할 수 없습니다.", true);
  }
}

function handleMedicineListClick(event) {
  const button = event.target.closest("button[data-action][data-record-id]");
  if (!button) {
    return;
  }

  const recordId = button.dataset.recordId;
  if (button.dataset.action === "edit") {
    editMedicineRecord(recordId);
  }

  if (button.dataset.action === "delete") {
    deleteMedicineRecord(recordId);
  }
}

async function saveMedicineRecord(event) {
  event.preventDefault();

  const data = loadData();
  const selectedSlot = elements.timeSlot.value;
  const customSlot = elements.customSlot.value.trim();
  const timeSlot = selectedSlot === "직접 입력" ? customSlot : selectedSlot;

  if (!timeSlot) {
    alert("직접 입력 시간대를 적어주세요.");
    return;
  }

  const record = {
    id: editingRecordId || String(Date.now()),
    date: today,
    name: elements.medicineName.value.trim(),
    timeSlot: timeSlot,
    isTaken: elements.isTaken.checked,
    takenTime: elements.takenTime.value,
    memo: elements.medicineMemo.value.trim()
  };

  if (!data.medicines[today]) {
    data.medicines[today] = [];
  }

  if (editingRecordId) {
    data.medicines[today] = data.medicines[today].map(function (item) {
      return item.id === editingRecordId ? record : item;
    });
  } else {
    data.medicines[today].push(record);
  }

  try {
    await saveData(data);
    resetMedicineForm();
    renderAll();
  } catch (error) {
    alert(error.message);
  }
}

async function saveConditionRecord(event) {
  event.preventDefault();

  const data = loadData();
  data.conditions[today] = {
    sleepiness: elements.sleepiness.value,
    focus: elements.focus.value,
    overallCondition: elements.overallCondition.value,
    sleepHours: elements.sleepHours.value,
    hadCaffeine: elements.hadCaffeine.checked,
    memo: elements.conditionMemo.value.trim()
  };

  try {
    await saveData(data);
    renderAll();
    alert("오늘의 컨디션을 저장했습니다.");
  } catch (error) {
    alert(error.message);
  }
}

function editMedicineRecord(recordId) {
  const data = loadData();
  const record = (data.medicines[today] || []).find(function (item) {
    return item.id === recordId;
  });

  if (!record) {
    return;
  }

  editingRecordId = record.id;
  elements.medicineName.value = record.name;
  elements.takenTime.value = record.takenTime;
  elements.isTaken.checked = record.isTaken;
  elements.medicineMemo.value = record.memo;

  const basicSlots = ["아침", "점심", "저녁", "자기 전"];
  if (basicSlots.includes(record.timeSlot)) {
    elements.timeSlot.value = record.timeSlot;
    elements.customSlot.value = "";
  } else {
    elements.timeSlot.value = "직접 입력";
    elements.customSlot.value = record.timeSlot;
  }

  toggleCustomSlot();
  elements.medicineSubmitButton.textContent = "수정 저장";
  elements.cancelEditButton.classList.remove("hidden");
  elements.medicineName.focus();
}

async function deleteMedicineRecord(recordId) {
  const shouldDelete = confirm("이 복용 기록을 삭제할까요?");
  if (!shouldDelete) {
    return;
  }

  const data = loadData();
  data.medicines[today] = (data.medicines[today] || []).filter(function (item) {
    return item.id !== recordId;
  });

  try {
    await saveData(data);
    resetMedicineForm();
    renderAll();
  } catch (error) {
    alert(error.message);
  }
}

function resetMedicineForm() {
  editingRecordId = null;
  elements.medicineForm.reset();
  elements.timeSlot.value = "아침";
  elements.isTaken.checked = false;
  setDefaultTakenTime();
  toggleCustomSlot();
  elements.medicineSubmitButton.textContent = "기록 추가";
  elements.cancelEditButton.classList.add("hidden");
}

function loadConditionForm(date) {
  const data = loadData();
  const condition = data.conditions[date];

  if (!condition) {
    elements.sleepiness.value = 3;
    elements.focus.value = 3;
    elements.overallCondition.value = 3;
    elements.sleepHours.value = "";
    elements.hadCaffeine.checked = false;
    elements.conditionMemo.value = "";
    return;
  }

  elements.sleepiness.value = condition.sleepiness;
  elements.focus.value = condition.focus;
  elements.overallCondition.value = condition.overallCondition || condition.mood || 3;
  elements.sleepHours.value = condition.sleepHours;
  elements.hadCaffeine.checked = condition.hadCaffeine;
  elements.conditionMemo.value = condition.memo;
}

function renderAll() {
  renderTodayMedicines();
  renderHistory();
}

function renderTodayMedicines() {
  const data = loadData();
  const records = data.medicines[today] || [];

  if (records.length === 0) {
    elements.todayMedicineList.innerHTML = '<p class="muted">아직 오늘 추가한 복용 기록이 없습니다.</p>';
    return;
  }

  elements.todayMedicineList.innerHTML = records.map(function (record) {
    return createMedicineRecordHtml(record, true);
  }).join("");
}

function renderHistory() {
  const data = loadData();
  const selectedDate = elements.historyDate.value || today;
  const records = data.medicines[selectedDate] || [];
  const condition = data.conditions[selectedDate];

  if (records.length === 0) {
    elements.historyMedicineList.innerHTML = '<p class="muted">선택한 날짜의 복용 기록이 없습니다.</p>';
  } else {
    elements.historyMedicineList.innerHTML = records.map(function (record) {
      return createMedicineRecordHtml(record, false);
    }).join("");
  }

  elements.historyConditionView.innerHTML = createConditionHtml(condition);
}

function createMedicineRecordHtml(record, showActions) {
  const takenText = record.isTaken ? "복용함" : "미복용";
  const timeText = record.takenTime ? escapeHtml(record.takenTime) : "시간 없음";
  const memoHtml = record.memo ? `<p class="record-memo">${escapeHtml(record.memo)}</p>` : "";
  const actionsHtml = showActions ? `
    <div class="record-actions">
      <button class="small-button" type="button" data-action="edit" data-record-id="${escapeHtml(record.id)}">수정</button>
      <button class="danger-button" type="button" data-action="delete" data-record-id="${escapeHtml(record.id)}">삭제</button>
    </div>
  ` : "";

  return `
    <article class="record-item">
      <div class="record-top">
        <div>
          <div class="record-name">${escapeHtml(record.name)}</div>
          <p class="record-meta">${escapeHtml(record.timeSlot)} · ${timeText}</p>
        </div>
        <span class="badge">${takenText}</span>
      </div>
      ${memoHtml}
      ${actionsHtml}
    </article>
  `;
}

function createConditionHtml(condition) {
  if (!condition) {
    return '<p class="muted">선택한 날짜의 컨디션 기록이 없습니다.</p>';
  }

  const sleepHours = condition.sleepHours ? `${escapeHtml(condition.sleepHours)}시간` : "기록 없음";
  const caffeine = condition.hadCaffeine ? "섭취함" : "섭취 안 함";
  const memo = condition.memo ? escapeHtml(condition.memo) : "기록 없음";

  return `
    <div class="condition-grid">
      <div class="condition-pill">졸림 정도<strong>${condition.sleepiness}/5</strong></div>
      <div class="condition-pill">집중도<strong>${condition.focus}/5</strong></div>
      <div class="condition-pill">종합컨디션<strong>${condition.overallCondition || condition.mood || 3}/5</strong></div>
      <div class="condition-pill">수면 시간<strong>${sleepHours}</strong></div>
      <div class="condition-pill">카페인<strong>${caffeine}</strong></div>
    </div>
    <p class="record-memo">${memo}</p>
  `;
}

function toggleCustomSlot() {
  const isCustom = elements.timeSlot.value === "직접 입력";
  elements.customSlotWrap.classList.toggle("hidden", !isCustom);
}

function updateRangeNumbers() {
  elements.sleepinessValue.textContent = elements.sleepiness.value;
  elements.focusValue.textContent = elements.focus.value;
  elements.overallConditionValue.textContent = elements.overallCondition.value;
}

function setDefaultTakenTime() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  elements.takenTime.value = `${hours}:${minutes}`;
}

function loadData() {
  if (encryptionState.enabled && encryptionState.locked) {
    return createEmptyData();
  }

  return appData;
}

async function saveData(data) {
  if (encryptionState.enabled) {
    if (encryptionState.locked || !encryptionState.key) {
      throw new Error("로그인 비밀번호로 잠금 해제한 뒤 저장할 수 있습니다.");
    }

    const encryptedPayload = await encryptDataWithExistingKey(data, encryptionState.key, encryptionState.envelope);
    await saveRawData(encryptedPayload);
    encryptionState.envelope = encryptedPayload.encryption;
    appData = data;
    return;
  }

  appData = sanitizeData(await saveRawData(data));
}

async function saveRawData(data) {
  return apiRequest("/api/data", {
    method: "PUT",
    body: data
  });
}

async function migrateLocalStorageDataIfNeeded() {
  const savedText = localStorage.getItem(STORAGE_KEY);
  if (!savedText || hasAnyData(appData)) {
    return;
  }

  try {
    const legacyData = sanitizeData(JSON.parse(savedText));
    if (!hasAnyData(legacyData)) {
      return;
    }

    await saveData(legacyData);
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn("기존 브라우저 저장 데이터를 옮기지 못했습니다.", error);
  }
}

function hasAnyData(data) {
  return Object.keys(data.medicines || {}).length > 0 || Object.keys(data.conditions || {}).length > 0;
}

function sanitizeData(data) {
  const source = data && typeof data === "object" ? data : {};
  return {
    medicines: source.medicines && typeof source.medicines === "object" ? source.medicines : {},
    conditions: source.conditions && typeof source.conditions === "object" ? source.conditions : {}
  };
}

function createEmptyData() {
  return {
    medicines: {},
    conditions: {}
  };
}

function createEncryptionState() {
  return {
    enabled: false,
    locked: false,
    key: null,
    envelope: null
  };
}

function isEncryptedData(data) {
  return Boolean(data && data.encrypted === true && data.encryption);
}

async function createEncryptedPayload(data, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(ENCRYPTION_SALT_BYTES));
  const key = await deriveEncryptionKey(passphrase, salt, ENCRYPTION_ITERATIONS);
  const payload = await encryptDataWithExistingKey(data, key, {
    salt: bytesToBase64(salt),
    iterations: ENCRYPTION_ITERATIONS
  });

  return { key, payload };
}

async function encryptDataWithExistingKey(data, key, envelope) {
  const iv = crypto.getRandomValues(new Uint8Array(ENCRYPTION_IV_BYTES));
  const encoded = new TextEncoder().encode(JSON.stringify(sanitizeData(data)));
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    key,
    encoded
  );

  return {
    encrypted: true,
    encryption: {
      version: ENCRYPTION_VERSION,
      algorithm: "AES-GCM",
      kdf: "PBKDF2-SHA-256",
      iterations: envelope.iterations || ENCRYPTION_ITERATIONS,
      salt: envelope.salt,
      iv: bytesToBase64(iv),
      ciphertext: arrayBufferToBase64(encryptedBuffer)
    }
  };
}

async function decryptEnvelope(envelope, passphrase) {
  if (!envelope || envelope.version !== ENCRYPTION_VERSION) {
    throw new Error("지원하지 않는 암호화 데이터입니다.");
  }

  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToArrayBuffer(envelope.ciphertext);
  const key = await deriveEncryptionKey(passphrase, salt, envelope.iterations || ENCRYPTION_ITERATIONS);
  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv },
    key,
    ciphertext
  );
  const text = new TextDecoder().decode(decryptedBuffer);

  return {
    key,
    data: JSON.parse(text)
  };
}

async function deriveEncryptionKey(passphrase, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: iterations,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function bytesToBase64(bytes) {
  return arrayBufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary);
}

function base64ToBytes(base64) {
  return new Uint8Array(base64ToArrayBuffer(base64));
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

async function apiRequest(path, options) {
  const requestOptions = options || {};
  const method = requestOptions.method || "GET";
  const headers = {};

  if (requestOptions.body) {
    headers["Content-Type"] = "application/json";
  }

  if (csrfToken && method !== "GET") {
    headers["X-CSRF-Token"] = csrfToken;
  }

  const response = await fetch(path, {
    method: method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined
  });
  const result = await response.json().catch(function () {
    return {};
  });

  if (!response.ok) {
    throw new Error(result.error || result.message || "요청을 처리하지 못했습니다.");
  }

  return result;
}

async function verifyLoginPassword(password) {
  await apiRequest("/api/auth/verify-password", {
    method: "POST",
    body: { password: password }
  });
}

function setAuthMessage(message, isError) {
  elements.authMessage.textContent = message;
  elements.authMessage.classList.toggle("error", Boolean(isError));
}

function setSecurityMessage(message, isError) {
  elements.securityMessage.textContent = message;
  elements.securityMessage.classList.toggle("error", Boolean(isError));
}

function setIdStatus(message, type) {
  elements.registerIdStatus.textContent = message;
  elements.registerIdStatus.classList.toggle("success", type === "success");
  elements.registerIdStatus.classList.toggle("error", type === "error");
  elements.registerIdStatus.classList.toggle("muted", type === "muted");
}

function getTodayString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateForView(dateText) {
  const date = new Date(`${dateText}T00:00:00`);
  return date.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long"
  });
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
