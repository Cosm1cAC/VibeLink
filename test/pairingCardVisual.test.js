import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

const projectRoot = path.resolve(process.env.VIBELINK_VISUAL_ROOT || path.join(import.meta.dirname, ".."));
const outputDir = path.resolve(process.env.VIBELINK_VISUAL_OUTPUT || path.join(projectRoot, ".tmp", "pairing-card-visual"));

test("pairing card separates its heading and status at desktop and mobile sizes", { timeout: 30_000 }, async () => {
  const source = fs.readFileSync(path.join(projectRoot, "apps", "web", "src", "main.jsx"), "utf8");
  const styles = fs.readFileSync(path.join(projectRoot, "public", "styles.css"), "utf8");
  assert.match(source, /<div className="pairing-card-head">\s*<strong>/, "LoginView must bind the pairing header layout class");

  const browser = await chromium.launch({ headless: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const cases = [
    { name: "desktop", viewport: { width: 1280, height: 720 } },
    { name: "mobile", viewport: { width: 390, height: 844 } }
  ];
  const states = [
    { name: "creating", description: "Create a short-lived pairing session, then approve it from an existing device.", error: "" },
    { name: "error", description: "Create a short-lived pairing session, then approve it from an existing device.", error: "Pairing service unavailable." },
    { name: "expired", description: "Status: expired", error: "" }
  ];

  try {
    for (const { name, viewport } of cases) {
      for (const state of states) {
        const page = await browser.newPage({ viewport });
        await page.setContent(`<!doctype html>
          <html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head>
          <body><section class="login-screen"><form class="panel">
            <div class="pairing-card">
              <div class="pairing-card-head">
                <strong>QR pairing</strong>
                <small>${state.description}</small>
              </div>
              <code class="pairing-code">123456</code>
              <button class="secondary-button" type="button">Claim after approval</button>
            </div>
            <p class="form-error" role="alert">${state.error}</p>
          </form></section></body></html>`);
        const header = page.locator(".pairing-card-head");
        await header.waitFor();
        const layout = await header.evaluate((element) => {
          const heading = element.querySelector("strong").getBoundingClientRect();
          const description = element.querySelector("small").getBoundingClientRect();
          const style = getComputedStyle(element);
          const card = element.closest(".pairing-card");
          return {
            display: style.display,
            gap: style.rowGap,
            headingBottom: heading.bottom,
            descriptionTop: description.top,
            headerOverflow: element.scrollWidth > element.clientWidth,
            cardOverflow: card.scrollWidth > card.clientWidth,
            documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
          };
        });
        assert.equal(layout.display, "grid", `${name}/${state.name}: header must use grid layout`);
        assert.equal(layout.gap, "4px", `${name}/${state.name}: header gap`);
        assert.ok(layout.descriptionTop - layout.headingBottom >= 3.5, `${name}/${state.name}: title and description are not visually separated`);
        assert.equal(layout.headerOverflow, false, `${name}/${state.name}: header overflows`);
        assert.equal(layout.cardOverflow, false, `${name}/${state.name}: card overflows`);
        assert.equal(layout.documentOverflow, false, `${name}/${state.name}: page overflows`);
        await page.screenshot({ path: path.join(outputDir, `${name}-${state.name}.png`), fullPage: true });
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});
