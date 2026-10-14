import "./styles.css";
import { APP_VERSION, MODEL_OPTIONS, QUALITY_PRESETS } from "./config.js";
import { PaddleOcrEngine, formatRuntimeDetails } from "./ocr-engine.js";
import { prepareImage, readImageOrientationInfo, releasePreparedImage } from "./image-tools.js";
import {
  clearOcrInFlight,
  getCompatibilityReason,
  getRuntimePolicy,
  isCompatibilityMode,
  markOcrInFlight,
  recoverCompatibilityMode,
  setCompatibilityMode
} from "./runtime-policy.js";
import { renderComparison, renderFieldEditor, renderPreview } from "./render.js";
import { detectQrProfile } from "./qr-engine.js";
import { applyManualValue, autoSelectProfile, extractProfileFields, extractQrProfileFields, loadProfiles } from "./profile-engine.js";
import { compareExtractions } from "./comparison.js";
import { clearExportedRecords, clearPendingExport, loadPendingExport, loadRecords, markRecordsExported, savePendingExport, saveRecord } from "./storage.js";
import { exportRecords, manualCorrectionLabel } from "./excel-export.js";
import { formatMilliseconds, safeError, serializableResult } from "./utils.js";
import { applyStaticTranslations, getLanguage, setLanguage, t } from "./i18n.js";

const crashRecovery = recoverCompatibilityMode();
const engine = new PaddleOcrEngine();
let profiles = [];
let records = [];
let pendingExport = null;
let comparison = null;
let currentSaved = false;
let saveInProgress = false;
let reviewConfirmed = false;
let reviewConfirmedAt = "";
let guidedCapture = {
  active: false,
  complete: false,
  processing: false,
  success: false,
  successAutomatic: false,
  autoSavePending: false,
  step: "",
  productFile: null,
  vdaFile: null,
  productAnalysisPromise: null
};
const slots = { product: createSlot("product"), vda: createSlot("vda") };
const el = (id) => document.getElementById(id);

el("version").textContent = `v${APP_VERSION}`;
setupLanguage();
setupOptions();
setupSlot("product");
setupSlot("vda");
setupActions();
setupCompatibilityMode();
renderAll();
loadStoredRecords();
const profilesReady = loadProfiles().then((loaded) => {
  profiles = loaded;
  populateProfiles();
  return profiles;
});
Promise.all([profilesReady, initializeEngine()]).catch(() => {});

function setupLanguage() {
  const select = el("languageSelect");
  if (!select) return;
  select.value = getLanguage();
  applyStaticTranslations();
  updateGuideSummaryHint();
  el("usageGuide")?.addEventListener("toggle", updateGuideSummaryHint);
  select.addEventListener("change", () => {
    setLanguage(select.value);
    applyStaticTranslations();
    updateGuideSummaryHint();
    populateProfiles();
    renderAll();
    refreshEngineLanguage();
  });
}

function updateGuideSummaryHint() {
  const guide = el("usageGuide");
  const hint = guide?.querySelector(".guide-summary-hint");
  if (hint) hint.textContent = t(guide.open ? "guide.collapse" : "guide.expand");
}

function refreshEngineLanguage() {
  const badge = el("engineBadge");
  if (!badge) return;
  const className = badge.classList.contains("ok") ? "ok" : badge.classList.contains("bad") ? "bad" : "wait";
  setEngineStatus("", className);
}

function createSlot(key) {
  return {
    key,
    file: null,
    prepared: null,
    result: null,
    wallMs: null,
    error: "",
    state: "empty",
    profile: null,
    extraction: null,
    manual: false,
    selectedProfileId: ""
  };
}

function setupOptions() {
  for (const model of Object.values(MODEL_OPTIONS)) el("modelSelect").append(new Option(model.label, model.key));
  for (const preset of Object.values(QUALITY_PRESETS)) el("qualitySelect").append(new Option(preset.label, preset.key));
  el("modelSelect").value = "standard";
  el("qualitySelect").value = "balanced";
}

function setupSlot(key) {
  const galleryInput = el(`${key}Input`);
  const cameraInput = el(`${key}CameraInput`);

  // Galerie und native Kamera bleiben getrennt. Die Kamera darf unabhängig
  // von der aktuellen Gerätehaltung immer öffnen. Erst das tatsächlich
  // aufgenommene Bild wird anschließend auf Hoch-/Querformat geprüft.
  galleryInput.removeAttribute("capture");
  cameraInput?.setAttribute("capture", "environment");
  cameraInput?.addEventListener("click", () => {
    cameraInput.setAttribute("capture", "environment");
    // Derselbe Kameradateiname muss bei einer Wiederholungsaufnahme erneut ein
    // change-Ereignis auslösen können.
    cameraInput.value = "";
  });

  const handleGalleryFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await loadFile(key, file);
  };
  const handleCameraFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (guidedCapture.active && guidedCapture.step === key) {
      if (key === "product") {
        guidedCapture.productFile = file;
        guidedCapture.step = "vda";

        // Produktbild sofort im Hintergrund vorbereiten und analysieren. Der
        // Bediener muss darauf nicht warten und kann direkt das VDA-/TA-Label
        // fotografieren. Die zweite OCR wird später bewusst erst nach diesem
        // Promise gestartet, damit nicht zwei Predict-Aufrufe dieselbe Engine
        // gleichzeitig verwenden.
        guidedCapture.productAnalysisPromise = loadFile("product", file);
        renderGuidedCapture();

        // Native Kamera-Dialoge dürfen nach der Rückkehr nicht zuverlässig
        // programmgesteuert erneut geöffnet werden. Deshalb springt die App
        // direkt zur einzigen nächsten Aktion: VDA-/TA-Label fotografieren.
        requestAnimationFrame(() => {
          const action = el("guidedCaptureButton");
          action?.scrollIntoView({ behavior: "smooth", block: "center" });
          try { action?.focus({ preventScroll: true }); } catch { action?.focus(); }
        });
        return;
      }

      guidedCapture.vdaFile = file;
      guidedCapture.active = false;
      guidedCapture.complete = true;
      guidedCapture.processing = true;
      guidedCapture.autoSavePending = true;
      guidedCapture.step = "processing";
      renderGuidedCapture();
      renderAll();
      queueScrollTo(el("resultCard"));

      await processGuidedCapture();
      guidedCapture.processing = false;
      guidedCapture.step = "";

      const initialReleased = comparison?.status === "released"
        && Number(comparison?.manualInputRequiredFields?.length || 0) === 0
        && !slots.product.manual
        && !slots.vda.manual;

      if (initialReleased) {
        renderAll();
        await storeCurrent({ automatic: true });
      } else {
        guidedCapture.autoSavePending = false;
        renderGuidedCapture();
        renderAll();
        queueNextInteractionScroll();
      }
      return;
    }

    await loadFile(key, file);
    queueNextInteractionScroll();
  };
  galleryInput.addEventListener("change", handleGalleryFile);
  cameraInput?.addEventListener("change", handleCameraFile);
  el(`${key}Profile`).addEventListener("change", async () => selectProfile(key, el(`${key}Profile`).value));
}

function setupActions() {
  el("initializeButton").onclick = () => initializeEngine(true);
  el("saveButton").onclick = () => storeCurrent();
  el("reviewButton").onclick = confirmOperatorReview;
  el("newCsvButton").onclick = () => pendingExport ? confirmPendingExport() : shareProtocolExport("new");
  el("allCsvButton").onclick = () => pendingExport ? resendPendingExport() : shareProtocolExport("all");
  el("clearSentButton").onclick = clearSentProtocolRows;
  el("debugButton").onclick = exportDebug;
  el("guidedCaptureButton").onclick = handleGuidedCaptureButton;
}



function resetCurrentScanForGuidedCapture() {
  for (const key of ["product", "vda"]) {
    const slot = slots[key];
    releasePreparedImage(slot.prepared);
    Object.assign(slot, createSlot(key));
    const profileSelect = el(`${key}Profile`);
    if (profileSelect) profileSelect.value = "";
    const galleryInput = el(`${key}Input`);
    const cameraInput = el(`${key}CameraInput`);
    if (galleryInput) galleryInput.value = "";
    if (cameraInput) cameraInput.value = "";
  }
  comparison = null;
  currentSaved = false;
  resetOperatorReview();
}

function handleGuidedCaptureButton() {
  if (guidedCapture.processing || guidedCapture.complete) return;

  if (!guidedCapture.active) {
    resetCurrentScanForGuidedCapture();
    guidedCapture = {
      active: true,
      complete: false,
      processing: false,
      success: false,
      successAutomatic: false,
      autoSavePending: false,
      step: "product",
      productFile: null,
      vdaFile: null,
      productAnalysisPromise: null
    };
    renderGuidedCapture();
    renderAll();
  }

  if (["product", "vda"].includes(guidedCapture.step)) {
    openGuidedCamera(guidedCapture.step);
  }
}

function openGuidedCamera(key) {
  const input = el(`${key}CameraInput`);
  if (!input) return;
  input.value = "";
  input.setAttribute("capture", "environment");
  try { input.click(); } catch { /* Der sichtbare Fallback bleibt verfügbar. */ }
}

async function processGuidedCapture() {
  const productFile = guidedCapture.productFile;
  const vdaFile = guidedCapture.vdaFile;
  if (!productFile || !vdaFile) return;

  // Im geführten Ablauf läuft das Produktlabel bereits seit Rückkehr aus der
  // ersten Kamera. Nur wenn dieser Vorlauf aus irgendeinem Grund nicht
  // gestartet wurde, wird er hier nachgeholt. Danach folgt die VDA-/TA-OCR.
  const productAnalysis = guidedCapture.productAnalysisPromise
    || loadFile("product", productFile);
  guidedCapture.productAnalysisPromise = productAnalysis;
  await productAnalysis;
  await loadFile("vda", vdaFile);
}

function renderGuidedCapture() {
  const notice = el("guidedCaptureNotice");
  const step = el("guidedCaptureStep");
  const title = el("guidedCaptureTitle");
  const hint = el("guidedCaptureHint");
  const action = el("guidedCaptureButton");
  if (!notice || !step || !title || !hint || !action) return;

  action.disabled = guidedCapture.processing || guidedCapture.complete;
  notice.classList.toggle("success", Boolean(guidedCapture.success));
  const successIcon = el("guidedCaptureSuccessIcon");
  if (successIcon) successIcon.hidden = !guidedCapture.success;

  if (guidedCapture.processing) {
    notice.hidden = false;
    step.textContent = `✓ ${t("capture.step2").replace(/^✓\s*/, "")}`;
    title.textContent = t("capture.bothTaken");
    hint.textContent = t("capture.processingHint");
    action.textContent = t("capture.processing");
    return;
  }

  if (guidedCapture.active && guidedCapture.step === "product") {
    notice.hidden = false;
    step.textContent = t("capture.step1");
    title.textContent = t("capture.productTitle");
    hint.textContent = t("capture.nativeHint");
    action.textContent = t("capture.product");
    return;
  }

  if (guidedCapture.active && guidedCapture.step === "vda") {
    notice.hidden = false;
    step.textContent = t("capture.step2");
    title.textContent = t("capture.vdaTitle");
    hint.textContent = t("capture.vdaHint");
    action.textContent = t("capture.vda");
    return;
  }

  if (guidedCapture.complete) {
    notice.hidden = false;
    step.textContent = t("capture.stepDone");
    title.textContent = t("capture.doneTitle");
    hint.textContent = t("capture.doneHint");
    action.textContent = t("capture.complete");
    return;
  }

  if (guidedCapture.success) {
    notice.hidden = false;
    step.textContent = t("capture.savedStep");
    title.textContent = t(guidedCapture.successAutomatic ? "capture.savedTitleAuto" : "capture.savedTitle");
    hint.textContent = t(guidedCapture.successAutomatic ? "capture.savedHintAuto" : "capture.savedHint");
    action.disabled = false;
    action.textContent = t("capture.startNext");
    return;
  }

  notice.hidden = true;
  action.disabled = false;
  action.textContent = t("capture.start");
}

function updatePhotoActions() {
  for (const key of ["product", "vda"]) {
    const action = el(`${key}PhotoAction`);
    if (!action) continue;
    const enabled = guidedCapture.complete && !guidedCapture.processing;
    action.hidden = !enabled;
    action.removeAttribute("aria-disabled");
    if (enabled) action.textContent = t("capture.retake");
  }
}

function queueScrollTo(target, focus = false) {
  if (!target) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { target.scrollIntoView({ behavior: "smooth", block: "center" }); } catch { target.scrollIntoView(); }
    if (focus) {
      try { target.focus({ preventScroll: true }); } catch { try { target.focus(); } catch { /* optional */ } }
    }
  }));
}

function firstRequiredFieldInput() {
  return document.querySelector(
    "#productFields .field-card.manual-required input, #vdaFields .field-card.manual-required input"
  );
}

function queueNextInteractionScroll() {
  if (guidedCapture.processing) {
    queueScrollTo(el("resultCard"));
    return;
  }

  if (Number(comparison?.manualInputRequiredFields?.length || 0) > 0) {
    queueScrollTo(firstRequiredFieldInput(), true);
    return;
  }

  if (comparison?.status === "review" && !reviewConfirmed) {
    queueScrollTo(el("reviewButton"), true);
    return;
  }

  const visible = displayedComparison();
  if (visible?.status === "rejected" || visible?.status === "released") {
    queueScrollTo(el("saveButton"), true);
    return;
  }

  for (const key of ["product", "vda"]) {
    if (["orientation", "error"].includes(slots[key].state)) {
      queueScrollTo(el(`${key}PhotoAction`) || el(`${key}Status`));
      return;
    }
  }
}

function isPortraitPhoto(orientationInfo, prepared) {
  if (orientationInfo?.portrait === true) return true;
  return Number(prepared?.height || 0) > Number(prepared?.width || 0);
}

function setupCompatibilityMode() {
  const toggle = el("compatibilityToggle");
  if (!toggle) return;
  toggle.checked = isCompatibilityMode();
  toggle.addEventListener("change", async () => {
    const enabled = toggle.checked;
    clearOcrInFlight();
    setCompatibilityMode(enabled, "manual");
    await engine.dispose();
    setEngineStatus(enabled
      ? t("engine.compatOn")
      : t("engine.compatOff"), "wait");
    await initializeEngine(true);
    renderAll();
  });
}

function populateProfiles() {
  for (const key of ["product", "vda"]) {
    const select = el(`${key}Profile`);
    select.replaceChildren(new Option(getLanguage() === "de" ? "Automatisch" : getLanguage() === "fr" ? "Automatique" : "Automatic", ""));
    profiles.filter((profile) => profile.role === key).forEach((profile) => select.append(new Option(profile.name, profile.id)));
    select.value = slots[key].selectedProfileId || "";
  }
}

async function initializeEngine(force = false) {
  if (!force && engine.ready) return true;
  setEngineStatus(t("engine.preparingShort"), "wait");
  try {
    const info = await engine.initialize("standard", (message) => setEngineStatus(message, "wait"), force);
    setEngineStatus(t("engine.readyText"), "ok");
    const reason = getCompatibilityReason();
    el("engineDetails").textContent = [
      `Initialisierung ${formatMilliseconds(info.initMs)}`,
      formatRuntimeDetails(info.summary),
      isCompatibilityMode() && reason === "ocr-crash-recovery" ? "Stabiler Modus nach vorherigem Analysefehler automatisch aktiviert" : "",
      isCompatibilityMode() && reason === "mobile-default" ? "Mobilgerät · stabiler Modus standardmäßig aktiv" : ""
    ].filter(Boolean).join(" · ");
    return true;
  } catch (error) {
    setEngineStatus(t("engine.notReadyText", { error: safeError(error) }), "bad");
    return false;
  }
}

function currentPreset() {
  const policy = getRuntimePolicy();
  const requested = QUALITY_PRESETS[el("qualitySelect")?.value] || QUALITY_PRESETS.balanced;
  return {
    ...requested,
    maxImageSide: policy.scannerMaxImageSide
      ? Math.min(requested.maxImageSide, policy.scannerMaxImageSide)
      : requested.maxImageSide,
    textDetLimitSideLen: policy.scannerDetLimitSideLen
      ? Math.min(requested.textDetLimitSideLen, policy.scannerDetLimitSideLen)
      : requested.textDetLimitSideLen
  };
}

async function loadFile(key, file) {
  const slot = slots[key];
  releasePreparedImage(slot.prepared);

  // Jedes neue Foto beginnt ausdrücklich wieder im Automatikmodus. Das erkannte
  // Profil wird intern gespeichert, der Select bleibt aber auf "Automatisch".
  Object.assign(slot, {
    file,
    prepared: null,
    result: null,
    extraction: null,
    error: "",
    state: "preparing",
    manual: false,
    profile: null,
    selectedProfileId: ""
  });
  el(`${key}Profile`).value = "";
  comparison = null;
  currentSaved = false;
  resetOperatorReview();
  renderAll();

  try {
    const preset = currentPreset();
    const policy = getRuntimePolicy();
    const orientationInfo = await readImageOrientationInfo(file).catch(() => null);
    slot.prepared = await prepareImage(file, preset.maxImageSide, {
      resizeDuringDecode: policy.resizeDuringDecode
    });

    // Hochkant wird zweifach geprüft: anhand der EXIF-orientierten
    // Originalabmessungen UND anhand des tatsächlich decodierten Bildes.
    // Dadurch funktionieren auch Samsung-/iPhone-Fotos, deren JPEG-Rohdaten
    // quer gespeichert sind und erst über EXIF gedreht werden.
    if (isPortraitPhoto(orientationInfo, slot.prepared)) {
      slot.error = t("scan.orientationError");
      slot.state = "orientation";
      clearOcrInFlight();
      renderAll();
      return;
    }

    // QR-Profile werden vor PaddleOCR geprüft. Suchbereich und Parserregeln kommen
    // vollständig aus der Profilkonfiguration; kundenspezifischer Code ist nicht nötig.
    try { await profilesReady; } catch { /* OCR-Fallback bleibt möglich. */ }
    const qrStartedAt = performance.now();
    const qrMatch = detectQrProfile(slot.prepared.canvas, profiles, key);
    if (qrMatch) {
      slot.wallMs = performance.now() - qrStartedAt;
      slot.result = {
        items: [],
        image: { width: slot.prepared.width, height: slot.prepared.height },
        metrics: { qrMs: slot.wallMs },
        qr: { raw: qrMatch.raw, parser: qrMatch.parsed.parser }
      };
      slot.profile = qrMatch.profile;
      slot.extraction = extractQrProfileFields(qrMatch.profile, qrMatch);
      slot.state = "done";
      comparison = slots.product.extraction && slots.vda.extraction
        ? compareExtractions(slots.product.extraction, slots.vda.extraction)
        : null;
      clearOcrInFlight();
      renderAll();
      return;
    }

    markOcrInFlight("photo-prepared", {
      slot: key,
      backend: policy.backend,
      width: slot.prepared.width,
      height: slot.prepared.height,
      appVersion: APP_VERSION
    });
    slot.state = "ready";
    renderSlot(key);
    // Safari/iOS bekommt einen Paint-Zyklus, bevor der OCR-Worker startet.
    await nextPaint();
    await analyzeSlot(key);
  } catch (error) {
    clearOcrInFlight();
    slot.error = safeError(error);
    slot.state = "error";
    renderSlot(key);
  }
}

async function analyzeSlot(key) {
  const slot = slots[key];
  if (!slot.prepared) return;
  currentSaved = false;
  resetOperatorReview();

  // Auch bei "Erneut analysieren" bleibt der QR-Pfad erhalten. Bei manueller
  // Profilauswahl wird nur dieses QR-Profil geprüft; im Automatikmodus alle passenden QR-Profile.
  const selected = slot.selectedProfileId
    ? profiles.find((profile) => profile.id === slot.selectedProfileId) || null
    : null;
  const qrCandidates = selected?.source?.type === "qr"
    ? [selected]
    : slot.selectedProfileId ? [] : profiles;
  if (qrCandidates.length) {
    const qrStartedAt = performance.now();
    const qrMatch = detectQrProfile(slot.prepared.canvas, qrCandidates, key);
    if (qrMatch) {
      slot.wallMs = performance.now() - qrStartedAt;
      slot.profile = qrMatch.profile;
      slot.result = qrResult(slot, qrMatch);
      slot.extraction = extractQrProfileFields(qrMatch.profile, qrMatch);
      slot.state = "done";
      refreshComparison();
      clearOcrInFlight();
      renderAll();
      return;
    }
    if (selected?.source?.type === "qr") {
      slot.profile = selected;
      slot.extraction = warningExtraction(selected, t("scan.qrMissing"));
      slot.state = "done";
      refreshComparison();
      clearOcrInFlight();
      renderAll();
      return;
    }
  }

  if (!(await initializeEngine())) {
    clearOcrInFlight();
    return;
  }
  slot.state = "analyzing";
  renderSlot(key);
  await nextPaint();

  try {
    const preset = currentPreset();
    const policy = getRuntimePolicy();
    markOcrInFlight("predict", {
      slot: key,
      backend: policy.backend,
      width: slot.prepared.width,
      height: slot.prepared.height,
      appVersion: APP_VERSION
    });
    const out = await engine.predict(slot.prepared.canvas, {
      textDetLimitSideLen: preset.textDetLimitSideLen,
      textDetLimitType: "min",
      textDetMaxSideLimit: policy.textDetMaxSideLimit,
      textDetThresh: 0.25,
      textDetBoxThresh: preset.textDetBoxThresh,
      textDetUnclipRatio: 1.55,
      textRecScoreThresh: preset.textRecScoreThresh
    });
    slot.result = out.result;
    slot.wallMs = out.wallMs;
    slot.state = "done";
    setEngineStatus(t("engine.readyText"), "ok");
    const metrics = out.result?.metrics || {};
    el("engineDetails").textContent = [
      formatRuntimeDetails(engine.summary, out.runtime),
      Number.isFinite(metrics.detMs) ? `Detektion ${formatMilliseconds(metrics.detMs)}` : "",
      Number.isFinite(metrics.recMs) ? `Erkennung ${formatMilliseconds(metrics.recMs)}` : ""
    ].filter(Boolean).join(" · ");
    resolveProfile(key);
  } catch (error) {
    slot.error = safeError(error);
    slot.state = "error";
  } finally {
    clearOcrInFlight();
  }
  renderAll();
}

async function analyzeAll() {
  for (const key of ["product", "vda"]) if (slots[key].prepared) await analyzeSlot(key);
}

function resolveProfile(key) {
  const slot = slots[key];
  if (!slot.result) return;
  currentSaved = false;

  let profile = slot.selectedProfileId
    ? profiles.find((candidate) => candidate.id === slot.selectedProfileId) || null
    : null;

  if (!profile) {
    const match = autoSelectProfile(slot.result.items, profiles, key);
    profile = match?.profile || null;
  }

  slot.profile = profile;
  slot.extraction = profile ? extractProfileFields(slot.result.items, profile, slot.result.image) : null;

  // Die Gültigkeitsprüfung eines Produktprofils ist konfigurationsgetrieben.
  // Welche Felder/Anker zwingend sein müssen, legt profile.validation fest.
  if (key === "product" && !isVerifiedConfiguredLabel(slot)) {
    const configuredMessage = slot.profile?.validation?.errorMessage;
    const message = !configuredMessage || configuredMessage === "Kein gültiges Produktlabel erkannt. Bitte das Produktlabel vollständig und gut lesbar fotografieren."
      ? t("scan.invalidProduct")
      : configuredMessage;
    slot.profile = null;
    slot.extraction = null;
    slot.error = message;
    slot.state = "error";
  } else if (key === "product") {
    slot.error = "";
    slot.state = "done";
  }

  // Wichtig: automatisch erkanntes Profil NICHT in den Select schreiben.
  el(`${key}Profile`).value = slot.selectedProfileId || "";
  comparison = slots.product.extraction && slots.vda.extraction
    ? compareExtractions(slots.product.extraction, slots.vda.extraction)
    : null;
}

function isVerifiedConfiguredLabel(slot) {
  const profile = slot?.profile;
  const extraction = slot?.extraction;
  if (!profile || !extraction || String(extraction.warning || "").trim()) return false;

  const validation = profile.validation || {};
  if (profile.source?.type !== "qr") {
    const minAnchorScore = Math.max(0, Math.min(1, Number(validation.minAnchorScore ?? 0.55)));
    const anchorScore = Number(extraction?.anchorMatch?.matchScore || 0);
    if (anchorScore < minAnchorScore) return false;
  }

  const requiredKeys = Array.isArray(validation.requiredValidFields)
    ? validation.requiredValidFields
    : [];
  return requiredKeys.every((key) => {
    const field = extraction?.fields?.[key];
    // Eine Erkennung unter 80 % darf im Eingabefeld bewusst leer bleiben,
    // kann aber trotzdem belegen, dass das erwartete Feld auf dem richtigen
    // Label erkannt wurde. Für die Bedienung muss der Wert anschließend
    // manuell eingetragen werden.
    return Boolean(field && ((field.value && field.valid) || field.autoDetectedValid || field.requiresManualInput));
  });
}

async function selectProfile(key, id) {
  const slot = slots[key];
  slot.selectedProfileId = id || "";
  slot.profile = id ? profiles.find((profile) => profile.id === id) || null : null;
  currentSaved = false;
  resetOperatorReview();

  if (!slot.prepared) {
    renderAll();
    return;
  }

  // QR-Profile werden auch bei manueller Auswahl wieder über detectQrProfile
  // geprüft und fallen nicht in die normale OCR-/Textanker-Extraktion zurück.
  if (slot.selectedProfileId && slot.profile?.source?.type === "qr") {
    const qrStartedAt = performance.now();
    const qrMatch = detectQrProfile(slot.prepared.canvas, [slot.profile], key);
    if (qrMatch) {
      slot.wallMs = performance.now() - qrStartedAt;
      slot.result = qrResult(slot, qrMatch);
      slot.extraction = extractQrProfileFields(slot.profile, qrMatch);
      slot.state = "done";
    } else {
      slot.extraction = warningExtraction(slot.profile, t("scan.qrMissing"));
      slot.state = "done";
    }
    refreshComparison();
    renderAll();
    return;
  }

  if (!slot.selectedProfileId) {
    const qrStartedAt = performance.now();
    const qrMatch = detectQrProfile(slot.prepared.canvas, profiles, key);
    if (qrMatch) {
      slot.wallMs = performance.now() - qrStartedAt;
      slot.profile = qrMatch.profile;
      slot.result = qrResult(slot, qrMatch);
      slot.extraction = extractQrProfileFields(qrMatch.profile, qrMatch);
      slot.state = "done";
      refreshComparison();
      renderAll();
      return;
    }
  }

  // Wurde das Bild zuvor nur per QR gelesen, existieren keine OCR-Textzeilen.
  // Beim Wechsel auf ein Textprofil wird deshalb einmal PaddleOCR ausgeführt.
  if (!slot.result?.items?.length && slot.result?.qr) {
    await analyzeSlot(key);
    return;
  }

  if (slot.result) {
    if (slot.selectedProfileId) {
      slot.extraction = slot.profile ? extractProfileFields(slot.result.items, slot.profile, slot.result.image) : null;
      if (key === "product" && !isVerifiedConfiguredLabel(slot)) {
        const configuredMessage = slot.profile?.validation?.errorMessage;
        const message = !configuredMessage || configuredMessage === "Kein gültiges Produktlabel erkannt. Bitte das Produktlabel vollständig und gut lesbar fotografieren."
          ? t("scan.invalidProduct")
          : configuredMessage;
        slot.profile = null;
        slot.extraction = null;
        slot.error = message;
        slot.state = "error";
      } else {
        slot.error = "";
        slot.state = "done";
      }
      refreshComparison();
    } else {
      resolveProfile(key);
    }
  }
  renderAll();
}

function editField(key, field, value) {
  const slot = slots[key];
  const applied = applyManualValue(slot.extraction, field, value);
  if (applied?.ok === false) {
    if (applied.reason === "weight-too-long") {
      alert(t("alert.weight"));
    } else if (applied.reason === "duplicate") {
      alert(t("alert.duplicate", { field: applied.duplicateLabel }));
    }
    renderAll();
    return;
  }
  slot.manual = true;
  currentSaved = false;
  resetOperatorReview();
  refreshComparison();
  renderAll();
  queueNextInteractionScroll();
}

function resetOperatorReview() {
  reviewConfirmed = false;
  reviewConfirmedAt = "";
}

function confirmOperatorReview() {
  if (comparison?.status !== "review") return;
  reviewConfirmed = true;
  reviewConfirmedAt = new Date().toISOString();
  currentSaved = false;
  renderAll();
  queueNextInteractionScroll();
}

function displayedComparison() {
  if (comparison?.status !== "review" || !reviewConfirmed) return comparison;

  const batchRow = comparison.rows?.find((row) => row.key === "batch");

  // Erst die ausdrückliche Bedienerbestätigung macht aus einem Prüffall ein
  // endgültiges Ergebnis. Das gilt insbesondere nach manuellen Eingaben:
  // vorher bleibt der Banner gelb „ÜBERPRÜFEN“, danach entscheidet die Batch.
  if (comparison.batchMismatch || batchRow?.status === "mismatch") {
    return {
      ...comparison,
      released: false,
      status: "rejected",
      message: t("analysis.resultRejected")
    };
  }

  if (batchRow?.status === "match") {
    return {
      ...comparison,
      released: true,
      status: "released",
      message: t("analysis.resultReleased")
    };
  }

  return {
    ...comparison,
    released: false,
    message: t("analysis.resultReview")
  };
}

function renderAll() {
  renderSlot("product");
  renderSlot("vda");
  const visibleComparison = displayedComparison();
  const comparisonContainer = el("comparison");
  renderComparison(comparisonContainer, visibleComparison);
  if (!visibleComparison && guidedCapture.processing && comparisonContainer) {
    const processing = document.createElement("div");
    processing.className = "analysis-processing";
    processing.textContent = t("analysis.processing");
    comparisonContainer.append(processing);
  }
  renderLog();
  renderGuidedCapture();
  updatePhotoActions();

  const resultCard = el("resultCard");
  const resultVisible = Boolean(guidedCapture.processing || visibleComparison);
  if (resultCard) {
    resultCard.hidden = !resultVisible;
    resultCard.classList.remove("result-released", "result-rejected", "result-review");
    if (visibleComparison?.status) resultCard.classList.add(`result-${visibleComparison.status}`);
  }
  const analysisStatusText = el("analysisStatusText");
  if (analysisStatusText) {
    analysisStatusText.textContent = guidedCapture.processing && !visibleComparison
      ? t("analysis.processing")
      : t("analysis.placeholder");
  }

  const saveButton = el("saveButton");
  const reviewButton = el("reviewButton");
  const reviewRequired = comparison?.status === "review";
  const manualInputRequired = Number(comparison?.manualInputRequiredFields?.length || 0) > 0;
  if (reviewButton) {
    reviewButton.hidden = guidedCapture.processing || !reviewRequired;
    reviewButton.disabled = !reviewRequired || manualInputRequired || reviewConfirmed;
    reviewButton.textContent = reviewConfirmed
      ? t("analysis.reviewed")
      : manualInputRequired ? t("analysis.fillOrange") : t("analysis.reviewButton");
  }
  saveButton.disabled = !comparison || manualInputRequired || (reviewRequired && !reviewConfirmed) || currentSaved || saveInProgress;
  saveButton.hidden = guidedCapture.processing || Boolean(guidedCapture.autoSavePending && visibleComparison?.status === "released");
  saveButton.textContent = saveInProgress
    ? t("analysis.saving")
    : currentSaved
      ? t("analysis.saved")
      : visibleComparison?.status === "rejected"
        ? t("analysis.saveRejected")
        : t("analysis.save");
  saveButton.classList.toggle("rejected-save-action", visibleComparison?.status === "rejected" && !currentSaved);
  const unsentCount = records.filter((record) => !record.exportedAt).length;
  const sentCount = records.length - unsentCount;
  const pendingRows = getPendingRows();
  const pendingConfirmRows = getPendingConfirmationRows();
  const newCsvButton = el("newCsvButton");
  const allCsvButton = el("allCsvButton");
  const clearSentButton = el("clearSentButton");

  // Während eine CSV noch auf die Bestätigung wartet, werden dieselben zwei
  // Exportbuttons kontextbezogen weiterverwendet. So entstehen keine
  // zusätzlichen Exportaktionen und Begriffe wie "Stapel" sind nicht nötig.
  if (pendingConfirmRows.length) {
    if (newCsvButton) {
      newCsvButton.disabled = false;
      newCsvButton.textContent = t("log.savedOneDrive", { count: pendingConfirmRows.length });
    }
    if (allCsvButton) {
      allCsvButton.disabled = !pendingRows.length;
      allCsvButton.textContent = t("log.resend", { count: pendingRows.length });
    }
  } else {
    if (newCsvButton) {
      newCsvButton.disabled = !unsentCount;
      newCsvButton.textContent = unsentCount ? t("log.newCount", { count: unsentCount }) : t("log.noneNew");
    }
    if (allCsvButton) {
      allCsvButton.disabled = !records.length;
      allCsvButton.textContent = records.length ? t("log.allCount", { count: records.length }) : t("log.all");
    }
  }

  if (clearSentButton) {
    clearSentButton.disabled = !sentCount;
    clearSentButton.textContent = sentCount ? t("log.clearCount", { count: sentCount }) : t("log.clear");
  }

  const exportStatus = el("excelExportStatus");
  if (exportStatus) {
    exportStatus.textContent = pendingConfirmRows.length
      ? t("log.pending", { count: pendingConfirmRows.length })
      : "";
  }
}

function renderSlot(key) {
  const slot = slots[key];
  const policy = getRuntimePolicy();
  renderPreview(el(`${key}Preview`), slot.prepared, slot.extraction?.overlays || [], policy.previewMaxSide);
  const status = el(`${key}Status`);
  if (slot.state === "analyzing") {
    status.textContent = t("scan.analyzing");
    status.className = "slot-status wait";
  } else if (slot.state === "orientation") {
    status.textContent = t("scan.orientationPrefix", { message: slot.error });
    status.className = "slot-status warn";
  } else if (slot.state === "error") {
    status.textContent = t("scan.errorPrefix", { message: slot.error });
    status.className = "slot-status bad";
  } else if (slot.state === "done") {
    const sourceInfo = slot.extraction?.qr
      ? "QR-Code"
      : t("scan.textLines", { count: slot.result?.items?.length || 0 });
    const quality = slot.prepared?.quality?.rating;
    const qualityHint = quality && quality.level !== "ok" ? ` · ${t("scan.qualityHint", { quality: quality.text })}` : "";
    status.textContent = `${formatMilliseconds(slot.wallMs)} · ${sourceInfo} · ${slot.profile?.name || t("scan.profileUnknown")}${slot.extraction?.warning ? ` · ${slot.extraction.warning}` : ""}${qualityHint}`;
    status.className = `slot-status ${slot.extraction?.warning || !slot.profile ? "warn" : "ok"}`;
  } else {
    status.textContent = slot.prepared ? t("scan.prepared") : t("scan.none");
    status.className = "slot-status";
  }
  renderFieldEditor(el(`${key}Fields`), slot.extraction, (field, value) => editField(key, field, value));
}

function resetScanCycleAfterSave({ showSuccess = true, automatic = false } = {}) {
  for (const key of ["product", "vda"]) {
    const slot = slots[key];
    releasePreparedImage(slot.prepared);
    Object.assign(slot, createSlot(key));
    const profileSelect = el(`${key}Profile`);
    if (profileSelect) profileSelect.value = "";
    const galleryInput = el(`${key}Input`);
    const cameraInput = el(`${key}CameraInput`);
    if (galleryInput) galleryInput.value = "";
    if (cameraInput) cameraInput.value = "";
  }
  comparison = null;
  currentSaved = false;
  resetOperatorReview();
  guidedCapture = {
    active: false,
    complete: false,
    processing: false,
    success: Boolean(showSuccess),
    successAutomatic: Boolean(showSuccess && automatic),
    autoSavePending: false,
    step: "",
    productFile: null,
    vdaFile: null,
    productAnalysisPromise: null
  };
  renderGuidedCapture();
}

async function storeCurrent(options = {}) {
  const automatic = options?.automatic === true;
  if (!comparison || (comparison.status === "review" && !reviewConfirmed) || currentSaved || saveInProgress) return;

  const finalBeforeSave = displayedComparison();
  const batchRow = finalBeforeSave?.rows?.find((row) => row.key === "batch");
  if (finalBeforeSave?.status === "rejected" || batchRow?.status === "mismatch") {
    const productBatch = batchRow?.product || "–";
    const vdaBatch = batchRow?.vda || "–";
    const confirmed = globalThis.confirm(
      t("confirm.rejected", { product: productBatch, vda: vdaBatch })
    );
    if (!confirmed) return;
  }

  saveInProgress = true;
  renderAll();
  const corrections = [
    ...manualCorrections(slots.product.extraction, "Produkt"),
    ...manualCorrections(slots.vda.extraction, "VDA")
  ];
  const finalComparison = displayedComparison();
  const record = {
    timestamp: new Date().toISOString(),
    status: finalComparison?.status || comparison.status,
    result: finalComparison?.message || comparison.message,
    reviewRequired: comparison.status === "review",
    reviewedAt: comparison.status === "review" ? reviewConfirmedAt : "",
    productProfile: slots.product.profile?.name || "",
    vdaProfile: slots.vda.profile?.name || "",
    product: values(slots.product.extraction),
    vda: values(slots.vda.extraction),
    manual: corrections.length > 0,
    manualCorrections: corrections
  };
  let saveSucceeded = false;
  try {
    records = await saveRecord(record);
    saveSucceeded = true;
    resetScanCycleAfterSave({ showSuccess: true, automatic });
  } catch (error) {
    currentSaved = false;
    guidedCapture.autoSavePending = false;
    alert(t("alert.saveError", { error: safeError(error) }));
  } finally {
    saveInProgress = false;
    renderAll();
    if (saveSucceeded && guidedCapture.success) queueScrollTo(el("guidedCaptureButton"));
    else queueNextInteractionScroll();
  }
}

function values(extraction) {
  const output = {};
  for (const [key, value] of Object.entries(extraction?.fields || {})) output[key] = value.value || "";
  return output;
}

function manualCorrections(extraction, sideLabel) {
  const labels = {
    batch: "Batch",
    idh: "IDH",
    weight: "Gewicht",
    delivery_note: "Lieferscheinnummer",
    drum_number: "Fassnummer"
  };
  return Object.entries(extraction?.fields || {})
    .filter(([, field]) => field?.source === "manual")
    .map(([key]) => `${labels[key] || key} ${sideLabel}`);
}

async function loadStoredRecords() {
  try {
    records = await loadRecords();
    pendingExport = loadPendingExport();
    normalizePendingExport();
  } catch (error) {
    console.warn("Scanprotokoll konnte nicht geladen werden:", error);
    records = [];
    pendingExport = null;
  }
  renderAll();
}

function getPendingRows() {
  const ids = new Set(pendingExport?.recordIds || []);
  if (!ids.size) return [];
  return records.filter((record) => ids.has(record.id));
}

function getPendingConfirmationRows() {
  const ids = new Set(pendingExport?.confirmRecordIds || pendingExport?.recordIds || []);
  if (!ids.size) return [];
  return records.filter((record) => !record.exportedAt && ids.has(record.id));
}

function getWaitingNewRows() {
  const pendingIds = new Set(getPendingConfirmationRows().map((record) => record.id));
  return records.filter((record) => !record.exportedAt && !pendingIds.has(record.id));
}

function normalizePendingExport() {
  if (!pendingExport?.recordIds?.length) {
    pendingExport = null;
    return;
  }

  const availableIds = new Set(records.map((record) => record.id).filter(Boolean));
  const recordIds = pendingExport.recordIds.filter((id) => availableIds.has(id));
  const confirmRecordIds = (pendingExport.confirmRecordIds || pendingExport.recordIds)
    .filter((id) => availableIds.has(id));

  // Ist nichts mehr zu bestätigen, ist der Export erledigt. Das gilt auch
  // nach einem Browser-Neustart oder einem bereits erfolgreich gespeicherten
  // alten 0.16.17-Export.
  const stillUnsent = new Set(records.filter((record) => !record.exportedAt).map((record) => record.id));
  const openConfirmIds = confirmRecordIds.filter((id) => stillUnsent.has(id));
  if (!recordIds.length || !openConfirmIds.length) {
    pendingExport = clearPendingExport();
    return;
  }

  if (
    recordIds.join("|") !== pendingExport.recordIds.join("|")
    || openConfirmIds.join("|") !== (pendingExport.confirmRecordIds || pendingExport.recordIds).join("|")
  ) {
    pendingExport = savePendingExport({ ...pendingExport, recordIds, confirmRecordIds: openConfirmIds });
  }
}

function refreshComparison() {
  comparison = slots.product.extraction && slots.vda.extraction
    ? compareExtractions(slots.product.extraction, slots.vda.extraction)
    : null;
  if (comparison?.status !== "review") resetOperatorReview();
}

function qrResult(slot, qrMatch) {
  return {
    items: [],
    image: { width: slot.prepared.width, height: slot.prepared.height },
    metrics: { qrMs: slot.wallMs },
    qr: { raw: qrMatch.raw, parser: qrMatch.parsed.parser }
  };
}

function warningExtraction(profile, warning) {
  return { profile, anchorMatch: null, transform: null, fields: {}, overlays: [], warning };
}

function localizedRecordResult(record) {
  const status = String(record?.status || "").toLowerCase();
  if (status === "released") return t("analysis.resultReleased");
  if (status === "rejected") return t("analysis.resultRejected");
  if (status === "review") return t("analysis.resultReview");
  return record?.result || "–";
}

function localizedManualCorrection(record) {
  const value = manualCorrectionLabel(record);
  if (!value) return "–";
  if (value === "Ja") return getLanguage() === "fr" ? "Oui" : getLanguage() === "en" ? "Yes" : "Ja";
  return value;
}

function renderLog() {
  const unsentCount = records.filter((record) => !record.exportedAt).length;
  const sentCount = records.length - unsentCount;
  el("logCount").textContent = t("log.count", { total: records.length, newCount: unsentCount, sent: sentCount });
  const body = el("logBody");
  body.replaceChildren();
  records.slice(0, 30).forEach((record) => {
    const row = document.createElement("tr");
    if (record.exportedAt) row.classList.add("log-row-sent");
    const drumNumber = record.product?.drum_number || record.vda?.drum_number || "–";
    const cells = [
      new Date(record.timestamp).toLocaleString(getLanguage() === "fr" ? "fr-FR" : getLanguage() === "en" ? "en-GB" : "de-DE"),
      localizedRecordResult(record),
      localizedManualCorrection(record),
      record.vda?.delivery_note || "–",
      drumNumber,
      record.product?.batch || "–",
      record.vda?.batch || "–",
      record.product?.idh || "–",
      record.vda?.idh || "–",
      record.product?.weight || "–",
      record.vda?.weight || "–",
      record.vdaProfile || "–"
    ];
    cells.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    });
    body.append(row);
  });
}

async function shareProtocolExport(mode = "new") {
  const exportDate = new Date();
  const exportRows = mode === "all"
    ? [...records]
    : records.filter((record) => !record.exportedAt);

  if (!exportRows.length) return;

  const confirmRecordIds = exportRows
    .filter((record) => !record.exportedAt)
    .map((record) => record.id)
    .filter(Boolean);

  // Der aktuelle Export wird VOR dem Öffnen des nativen Share-Sheets
  // dauerhaft gespeichert. Android kann die Webseite während "Senden an"
  // pausieren; dadurch bleibt der Bestätigungszustand beim Zurückkehren
  // trotzdem zuverlässig erhalten.
  if (confirmRecordIds.length) {
    pendingExport = savePendingExport({
      recordIds: exportRows.map((record) => record.id).filter(Boolean),
      confirmRecordIds,
      createdAt: exportDate.toISOString(),
      mode,
      awaitingConfirmation: true
    });
    renderAll();
  }

  const result = await exportRecords(exportRows, navigator, { date: exportDate });

  // Nur ein ausdrücklich abgebrochener Share-Vorgang wird verworfen. Wenn
  // Android die Seite beim Teilen pausiert und der Promise nicht sauber
  // weiterläuft, bleibt der zuvor gespeicherte Zustand absichtlich bestehen.
  if (result?.method === "cancelled" && pendingExport) {
    pendingExport = clearPendingExport();
  }

  renderExportStatus(result);
  renderAll();
}

async function resendPendingExport() {
  const exportRows = getPendingRows();
  if (!pendingExport || !exportRows.length) {
    pendingExport = clearPendingExport();
    renderAll();
    return;
  }

  const exportDate = new Date(pendingExport.createdAt || Date.now());
  const result = await exportRecords(exportRows, navigator, { date: exportDate });
  renderExportStatus(result);

  if (result?.method === "cancelled") {
    const status = el("excelExportStatus");
    if (status) status.textContent = t("export.cancelledPending");
  }
  renderAll();
}

async function confirmPendingExport() {
  const confirmRows = getPendingConfirmationRows();
  if (!pendingExport || !confirmRows.length) {
    pendingExport = clearPendingExport();
    renderAll();
    return;
  }

  // Diese Bestätigung wird direkt durch den Button-Klick ausgelöst und ist
  // damit auch in mobilen Browsern zuverlässig. Sie hängt nicht mehr hinter
  // einem asynchronen navigator.share()-Aufruf.
  const confirmed = confirm(t("export.confirmSaved", { count: confirmRows.length }));
  if (!confirmed) return;

  const ids = confirmRows.map((record) => record.id).filter(Boolean);
  try {
    await markRecordsExported(ids, new Date().toISOString());
    pendingExport = clearPendingExport();
    records = await loadRecords();
    normalizePendingExport();
    renderAll();

    const status = el("excelExportStatus");
    const remaining = records.filter((record) => !record.exportedAt).length;
    if (status) {
      status.textContent = remaining
        ? t("export.confirmedRemaining", { count: ids.length, remaining })
        : t("export.confirmedDone", { count: ids.length });
    }
  } catch (error) {
    alert(t("export.statusSaveError", { error: safeError(error) }));
  }
}


async function clearSentProtocolRows() {
  const sentCount = records.filter((record) => record.exportedAt).length;
  if (!sentCount) return;
  const confirmed = confirm(t("export.clearConfirm", { count: sentCount }));
  if (!confirmed) return;
  try {
    records = await clearExportedRecords();
    normalizePendingExport();
    renderAll();
    const status = el("excelExportStatus");
    if (status) status.textContent = t("export.clearDone", { count: sentCount });
  } catch (error) {
    alert(t("export.clearError", { error: safeError(error) }));
  }
}


function renderExportStatus(result) {
  const status = el("excelExportStatus");
  if (!status || !result) return;
  if (result.method === "share-csv") {
    status.textContent = t("export.shared", { filename: result.filename });
  } else if (result.method === "download-csv") {
    status.textContent = t("export.downloaded", { filename: result.filename });
  } else if (result.method === "cancelled") {
    status.textContent = t("export.cancelled");
  }
}


function exportDebug() {
  const payload = {
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    runtimePolicy: getRuntimePolicy(),
    crashRecovery,
    product: debugSlot(slots.product),
    vda: debugSlot(slots.vda),
    comparison
  };
  download(JSON.stringify(payload, null, 2), `labelcheck-debug-${Date.now()}.json`, "application/json");
}

function debugSlot(slot) {
  return {
    profileMode: slot.selectedProfileId ? "manual" : "automatic",
    profile: slot.profile,
    extraction: slot.extraction,
    result: serializableResult(slot.result),
    wallMs: slot.wallMs
  };
}

function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setEngineStatus(text, className) {
  const ready = className === "ok";
  const loading = className === "wait" || className === "warn";
  el("engineBadge").textContent = ready ? t("engine.ready") : loading ? t("engine.loading") : t("engine.notReady");
  el("engineBadge").className = `engine-badge ${className}`;
  const symbol = document.querySelector(".version-status-row .status-symbol");
  if (symbol) {
    symbol.textContent = ready ? "✓" : loading ? "…" : "×";
    symbol.classList.toggle("ok", ready);
    symbol.classList.toggle("wait", loading);
    symbol.classList.toggle("bad", !ready && !loading);
  }
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
