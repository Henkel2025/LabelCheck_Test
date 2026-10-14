import { boundsFromPoly, clamp, normalizePoly } from "./utils.js";
import { t } from "./i18n.js";

export function renderPreview(container, prepared, overlays = [], maxPreviewSide = 1100) {
  container.replaceChildren();
  if (!prepared?.canvas) {
    const placeholder = document.createElement("div");
    placeholder.className = "placeholder";
    placeholder.textContent = t("scan.none");
    container.append(placeholder);
    return;
  }

  // Die Vorschau muss auf einem Smartphone nicht dieselben 1400–2100 Pixel wie
  // das OCR-Canvas besitzen. Eine kleinere Display-Kopie spart besonders unter
  // iOS mehrere große RGBA-Puffer, ohne die OCR oder Profilgeometrie zu ändern.
  const source = prepared.canvas;
  const scale = Math.min(1, Number(maxPreviewSide || 1100) / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext("2d");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  context.lineWidth = Math.max(2, Math.round(canvas.width / 600));
  context.font = `700 ${Math.max(14, Math.round(canvas.width / 45))}px system-ui`;
  context.textBaseline = "bottom";

  overlays.forEach((overlay) => {
    const points = normalizePoly(overlay.poly).map(([x, y]) => [x * scale, y * scale]);
    if (points.length < 3) return;
    const color = overlay.key === "anchor" ? "#37dc91" : "#4cc9f0";
    context.strokeStyle = color;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(...points[0]);
    points.slice(1).forEach((point) => context.lineTo(...point));
    context.closePath();
    context.stroke();
    const bounds = boundsFromPoly(points);
    const label = overlay.label || overlay.key;
    const metrics = context.measureText(label);
    const labelHeight = Math.max(20, Math.round(canvas.width / 60));
    const x = clamp(bounds.x, 0, canvas.width - metrics.width - 12);
    const y = clamp(bounds.y, labelHeight, canvas.height);
    context.fillRect(x, y - labelHeight, metrics.width + 12, labelHeight);
    context.fillStyle = "#061423";
    context.fillText(label, x + 6, y - 4);
  });

  container.append(canvas);
}

function fieldLabel(key) {
  return t(`field.${key}`);
}

function sideLabel(side) {
  return side === "Produkt" || side === "Product" || side === "Produit"
    ? t("analysis.headerProduct")
    : t("analysis.headerVda");
}

function translatedFieldReference(field) {
  return `${fieldLabel(field?.key)} ${sideLabel(field?.side)}`.trim();
}

export function renderFieldEditor(container, extraction, onChange) {
  container.replaceChildren();
  const keys = ["batch", "idh", "weight", "delivery_note", "drum_number"];

  for (const key of keys) {
    const field = extraction?.fields?.[key];
    if (!field) continue;

    const card = document.createElement("label");
    const requiresInput = Boolean(field.requiresManualInput);
    card.className = `field-card ${requiresInput ? "manual-required" : field.valid ? "valid" : "invalid"}`;
    card.innerHTML = `<span></span><input type="text"><small></small>`;
    card.querySelector("span").textContent = fieldLabel(key);

    const input = card.querySelector("input");
    input.value = field.value || "";
    if (requiresInput) input.placeholder = t("field.manualPlaceholder");

    const confidence = Number(field.confidence);
    const percent = Number.isFinite(confidence) ? (confidence * 100).toFixed(1) : "0.0";
    let statusText = "";
    if (field.source === "manual") {
      statusText = field.valid ? t("field.manualCorrected") : t("field.manualInvalid");
    } else if (requiresInput && Number.isFinite(confidence) && confidence > 0 && String(field.raw || field.recognizedValue || "").trim()) {
      statusText = t("field.recognitionManual", { percent });
    } else if (requiresInput) {
      statusText = t("field.notRecognizedManual", { reason: field.rejectedReason || t("field.notRecognized") });
    } else if (field.source === "batch-suffix") {
      statusText = t("field.fromBatch", { percent });
    } else if (field.source === "qr") {
      statusText = "QR-Code";
    } else if (String(field.source || "").startsWith("ocr")) {
      statusText = t("field.recognition", { percent });
    } else {
      statusText = t("field.notRecognized");
    }
    card.querySelector("small").textContent = statusText;
    input.addEventListener("change", () => onChange(key, input.value));
    container.append(card);
  }

  if (!container.children.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = t("field.noFields");
    container.append(p);
  }
}

function reviewDetail(comparison) {
  const manual = comparison?.manualInputRequiredFields || [];
  if (manual.length) {
    return t("analysis.reviewManual", { fields: manual.map(translatedFieldReference).join(", ") });
  }
  const lowConfidence = comparison?.lowConfidenceFields || [];
  if (lowConfidence.length) {
    const fields = lowConfidence.map((field) => `${translatedFieldReference(field)} (${(Number(field.confidence || 0) * 100).toFixed(0)} %)`);
    return t("analysis.reviewConfidence", { fields: fields.join(", ") });
  }
  return t("analysis.reviewGeneric");
}

export function renderComparison(container, comparison) {
  container.replaceChildren();
  if (!comparison) { container.innerHTML = ""; return; }

  const banner = document.createElement("div");
  banner.className = `result-banner ${comparison.status}`;
  if (comparison.status === "released") {
    const icon = document.createElement("span");
    icon.className = "result-status-icon result-status-icon-ok";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "✓";
    const copy = document.createElement("div");
    copy.className = "result-banner-copy";
    const title = document.createElement("strong");
    title.textContent = t("analysis.released");
    const detail = document.createElement("span");
    detail.textContent = t("analysis.releasedDetail");
    copy.append(title, detail);
    banner.append(icon, copy);
  } else if (comparison.status === "rejected") {
    const icon = document.createElement("span");
    icon.className = "result-status-icon result-status-icon-bad";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "✕";
    const copy = document.createElement("div");
    copy.className = "result-banner-copy";
    const title = document.createElement("strong");
    title.textContent = t("analysis.rejected");
    const detail = document.createElement("span");
    detail.textContent = t("analysis.rejectedDetail");
    copy.append(title, detail);
    banner.append(icon, copy);
  } else {
    const title = document.createElement("strong");
    title.textContent = t("analysis.review");
    const detail = document.createElement("span");
    detail.textContent = reviewDetail(comparison);
    banner.append(title, detail);
  }
  container.append(banner);

  const table = document.createElement("table");
  table.className = "compare-table";
  table.innerHTML = '<thead><tr><th></th><th></th><th></th><th></th></tr></thead><tbody></tbody>';
  const headers = table.querySelectorAll("th");
  headers[0].textContent = t("analysis.headerField");
  headers[1].textContent = t("analysis.headerProduct");
  headers[2].textContent = t("analysis.headerVda");
  headers[3].textContent = t("analysis.headerResult");
  const tbody = table.querySelector("tbody");
  for (const row of comparison.rows) {
    const tr = document.createElement("tr");
    tr.className = `compare-row compare-row-${row.status}`;
    const field = document.createElement("td");
    field.textContent = row.key ? fieldLabel(row.key) : row.label;
    const product = document.createElement("td");
    product.textContent = row.product || "–";
    const vda = document.createElement("td");
    vda.textContent = row.vda || "–";
    const result = document.createElement("td");
    result.className = `status-${row.status}`;
    result.textContent = statusText(row.status);
    tr.append(field, product, vda, result);
    tbody.append(tr);
  }
  container.append(table);
}

function statusText(status) {
  return {
    match: t("analysis.match"),
    mismatch: t("analysis.mismatch"),
    missing: t("analysis.missing"),
    invalid: t("analysis.invalid")
  }[status] || status;
}
