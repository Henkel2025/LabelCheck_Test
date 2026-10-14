import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const render = fs.readFileSync(new URL("../src/render.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const i18n = fs.readFileSync(new URL("../src/i18n.js", import.meta.url), "utf8");

test("geführter Fotografiervorgang verwendet genau einen zentralen Aktionsbutton", () => {
  assert.match(html, /id="guidedCaptureButton"[^>]*data-i18n="capture\.start"/);
  assert.doesNotMatch(html, /guidedCaptureContinueButton|guidedCaptureCancelButton/);
  assert.match(main, /guidedCaptureButton"\)\.onclick = handleGuidedCaptureButton/);
});

test("geführter Ablauf verwendet weiterhin die nativen capture Inputs", () => {
  assert.match(html, /id="productCameraInput"[^>]*capture="environment"/);
  assert.match(html, /id="vdaCameraInput"[^>]*capture="environment"/);
  assert.match(main, /openGuidedCamera\(guidedCapture\.step\)/);
});

test("nach Produktfoto springt die Oberfläche direkt zur VDA TA Aktion", () => {
  assert.match(main, /guidedCapture\.productFile = file;[\s\S]*guidedCapture\.step = "vda"/);
  assert.match(main, /action\?\.scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/);
  assert.match(main, /title\.textContent = t\("capture\.vdaTitle"\)/);
  assert.match(main, /action\.textContent = t\("capture\.vda"\)/);
  assert.doesNotMatch(main, /nextInput\.click\(\)/);
});


test("Produktanalyse startet bereits nach dem ersten Foto und wird für VDA wiederverwendet", () => {
  assert.match(main, /guidedCapture\.productAnalysisPromise = loadFile\("product", file\)/);
  assert.match(main, /const productAnalysis = guidedCapture\.productAnalysisPromise[\s\S]*\|\| loadFile\("product", productFile\)/);
  assert.match(main, /await productAnalysis;[\s\S]*await loadFile\("vda", vdaFile\)/);
});

test("Einzelaufnahme ist vor Abschluss unsichtbar und erscheint danach als Wiederholungsaktion", () => {
  assert.match(html, /id="productPhotoAction"[^>]*hidden/);
  assert.match(html, /id="vdaPhotoAction"[^>]*hidden/);
  assert.match(main, /const enabled = guidedCapture\.complete && !guidedCapture\.processing/);
  assert.match(main, /action\.hidden = !enabled/);
  assert.match(main, /action\.textContent = t\("capture\.retake"\)/);
  assert.doesNotMatch(html, /id="productPhotoAction"[^>]*capture-locked/);
});

test("So funktionierts ist aufklappbar und enthält eine ausführliche Schrittfolge", () => {
  assert.match(html, /<details class="compact-guide" id="usageGuide">/);
  assert.match(html, /data-i18n="guide\.step1\.text"/);
  assert.match(html, /data-i18n="guide\.step6\.text"/);
  assert.match(css, /details\.compact-guide > summary/);
});

test("Sprachauswahl bietet Deutsch Englisch und Französisch", () => {
  assert.match(html, /id="languageSelect"/);
  assert.match(html, /<option value="de">Deutsch<\/option>/);
  assert.match(html, /<option value="en">English<\/option>/);
  assert.match(html, /<option value="fr">Français<\/option>/);
  assert.match(main, /setLanguage\(select\.value\)/);
  assert.match(i18n, /en:\s*\{/);
  assert.match(i18n, /fr:\s*\{/);
  assert.match(i18n, /Photograph the VDA\/TO label/);
  assert.match(i18n, /VDA \/ TO batch/);
  assert.match(i18n, /Photographier l’étiquette VDA\/OT/);
  assert.match(i18n, /Lot VDA \/ OT/);
});

test("Analysekarte erhält grüne und rote Gesamtzustände mit linksbündigem Status", () => {
  assert.match(html, /id="resultCard" class="result-card"/);
  assert.match(main, /resultCard\.classList\.remove\("result-released", "result-rejected", "result-review"\)/);
  assert.match(css, /#resultCard\.result-released\s*\{[\s\S]*border:\s*5px solid #2f9e44/);
  assert.match(css, /#resultCard\.result-rejected\s*\{[\s\S]*border:\s*7px solid #d71920/);
  assert.match(css, /#resultCard\.result-rejected \.result-banner\.rejected[\s\S]*text-align:\s*left/);
  assert.match(render, /title\.textContent = t\("analysis\.rejected"\)/);
  assert.match(render, /detail\.textContent = t\("analysis\.rejectedDetail"\)/);
});

test("Abweichende Batch verlangt vor Übernahme eine ausdrückliche Bestätigung", () => {
  assert.match(main, /t\("analysis\.saveRejected"\)/);
  assert.match(main, /globalThis\.confirm\(/);
  assert.match(main, /t\("confirm\.rejected"/);
  assert.match(i18n, /Möchtest du den Datensatz wirklich trotzdem übernehmen\?/);
});

test("Pruefstatus bleibt bei nicht erkannten Feldern sichtbar und lesbar", () => {
  assert.match(render, /title\.textContent = t\("analysis\.review"\)/);
  assert.match(render, /detail\.textContent = reviewDetail\(comparison\)/);
  assert.match(css, /#resultCard\.result-review \.result-banner\.review\s*\{[\s\S]*background:\s*#fff3bf/);
  assert.match(css, /#resultCard\.result-review \.result-banner\.review strong\s*\{[\s\S]*color:\s*#3b2f00 !important/);
  assert.match(css, /#resultCard\.result-review \.result-banner\.review span\s*\{[\s\S]*color:\s*#3b2f00 !important/);
});


test("Analyseergebnis zeigt grossen Haken bei Freigabe und X bei Ablehnung", () => {
  assert.match(render, /result-status-icon-ok/);
  assert.match(render, /icon\.textContent = "✓"/);
  assert.match(render, /result-status-icon-bad/);
  assert.match(render, /icon\.textContent = "✕"/);
  assert.match(css, /#resultCard \.result-status-icon/);
  assert.match(html, /id="guidedCaptureSuccessIcon"[^>]*>✓<\/span>/);
  assert.match(main, /successIcon\.hidden = !guidedCapture\.success/);
  assert.match(i18n, /capture\.savedStep": "✓ FREIGEGEBEN"/);
});


test("Analyse erscheint erst nach beiden Fotos direkt beim Fotografiervorgang", () => {
  const captureIndex = html.indexOf('id="guidedCaptureButton"');
  const resultIndex = html.indexOf('id="resultCard"');
  const scanIndex = html.indexOf('class="scan-grid"');
  assert.ok(captureIndex >= 0 && resultIndex > captureIndex && scanIndex > resultIndex);
  assert.match(html, /id="resultCard" class="result-card" hidden/);
  assert.match(main, /const resultVisible = Boolean\(guidedCapture\.processing \|\| visibleComparison\)/);
  assert.match(main, /resultCard\.hidden = !resultVisible/);
});

test("sofort freigegebener gefuehrter Scan wird automatisch gespeichert", () => {
  assert.match(main, /const initialReleased = comparison\?\.status === "released"/);
  assert.match(main, /await storeCurrent\(\{ automatic: true \}\)/);
  assert.match(main, /capture\.savedTitle/);
  assert.match(i18n, /Datensatz erfolgreich übernommen/);
});

test("Review und Ablehnung bleiben bedienerpflichtig und Scrollziel folgt der naechsten Aktion", () => {
  assert.match(main, /comparison\?\.status === "review" && !reviewConfirmed/);
  assert.match(main, /firstRequiredFieldInput\(\)/);
  assert.match(main, /queueScrollTo\(el\("reviewButton"\), true\)/);
  assert.match(main, /visible\?\.status === "rejected" \|\| visible\?\.status === "released"/);
  assert.match(main, /queueScrollTo\(el\("saveButton"\), true\)/);
  assert.match(main, /globalThis\.confirm\(/);
});
