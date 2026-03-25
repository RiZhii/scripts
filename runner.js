const { chromium } = require('playwright');
const { executeStep, loadPlan } = require('./executor');
 
(async () => {
  console.log("Runner started...");
 
  // Connect to browser container
  const browser = await chromium.connectOverCDP(
    'http://browser-box:9222'
  );
 
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
 
  // IMPORTANT for proper rendering
  await page.setViewportSize({ width: 1280, height: 720 });
 
  // Load test plan
  const plan = loadPlan('./test-plan.json');
  const steps = plan.steps;
 
  console.log(`Loaded ${steps.length} steps`);
 
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
 
    try {
      await executeStep(page, step, {
        index: i + 1,
        _allSteps: steps,
        _stepIndex: i,
        _prevStep: steps[i - 1],
        verbose: true,
        screenshotDir: null
      });
 
    } catch (err) {
      console.log(`Step ${i + 1} failed:`, err.message);
      break;
    }
  }
 
  console.log("Execution completed");
})();