const { chromium } = require("playwright");
const { executeStep, loadPlan } = require("./executor");
const axios = require("axios");
 
// CONFIG
const BROWSER_URL = "http://browser-box:9223/json";
const MAX_RETRIES = 30;
const RETRY_DELAY = 2000;
 
// Wait for browser CDP to be ready
async function waitForBrowser() {
  console.log("⏳ Waiting for browser container (CDP)...");
 
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const res = await axios.get(BROWSER_URL);
 
      if (res.status === 200 && res.data.length > 0) {
        console.log("✅ Browser is READY");
        return;
      }
    } catch (err) {
      console.log(` Retry ${i + 1}/${MAX_RETRIES}...`);
    }
 
    await new Promise((r) => setTimeout(r, RETRY_DELAY));
  }
 
  throw new Error(" Browser not ready after retries");
}
 
(async () => {
  console.log("Runner started...");
 
  try {
    // WAIT until chromium is actually ready
    await waitForBrowser();
 
    // Connect to browser via CDP
    const browser = await chromium.connectOverCDP(
      "http://browser-box:9223"
    );
 
    console.log("Connected to browser");
 
    const context =
      browser.contexts()[0] || (await browser.newContext());
 
    const page = await context.newPage();
 
    //  Important for noVNC visibility
    await page.setViewportSize({ width: 1280, height: 720 });
 
    //  Load test plan
    const plan = loadPlan("./test-plan.json");
    const steps = plan.steps;
 
    console.log(`📋 Loaded ${steps.length} steps`);
 
    //  Execute steps
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
 
      try {
        await executeStep(page, step, {
          index: i + 1,
          _allSteps: steps,
          _stepIndex: i,
          _prevStep: steps[i - 1],
          verbose: true,
          screenshotDir: null,
        });
      } catch (err) {
        console.error(`❌ Step ${i + 1} failed:`, err.message);
        break;
      }
    }
 
    console.log(" Execution completed");
 
  } catch (err) {
    console.error(" Runner failed:", err.message);
 
    // ❗ Prevent container exit (for debugging)
    setInterval(() => {}, 1000);
  }
})();