import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const render = fs.readFileSync(new URL("../src/render.js", import.meta.url), "utf8");
const i18n = fs.readFileSync(new URL("../src/i18n.js", import.meta.url), "utf8");

test("Analysebereich ist automatisch und ohne Analyse-starten-Button", () => {
  assert.match(html, /Das Ergebnis des Labelchecks ist hier direkt nach beiden Fotos sichtbar\./);
  assert.doesNotMatch(html, /Analyse starten/);
  assert.doesNotMatch(html, /analyzeAllButton/);
});

test("Felder zeigen Erkennungsquote statt OCR-Prozent", () => {
  assert.match(render, /field\.recognition/);
  assert.match(i18n, /Erkennungsquote:/);
  assert.doesNotMatch(render, /`OCR \$/);
});


test("Status unter dem Bild nennt keine OCR-Engine", () => {
  const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(main, /t\("scan\.analyzing"\)/);
  assert.match(i18n, /Bild wird analysiert …/);
  assert.doesNotMatch(main, /status\.textContent = `PaddleOCR analysiert/);
});


test("Unsichere und fehlende Felder werden orange markiert", () => {
  assert.match(render, /manual-required/);
  assert.match(render, /field\.manualPlaceholder/);
  assert.match(i18n, /bitte manuell eintragen/i);
});
