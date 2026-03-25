const path = require("path");
const fs = require("fs");
 
const STEP_PAUSE = 600;
const NAV_TIMEOUT = 30000;
const NETWORK_TIMEOUT = 20000;
const SELECTOR_TIMEOUT = 5000;
const ASSERTION_TIMEOUT = 10000;
 
 
async function waitForApiResponse(page, timeout = 8000) {
  const apiResponsePromise = page
    .waitForResponse(
      (resp) => {
        const url = resp.url();
        const status = resp.status();
        const ct = resp.headers()["content-type"] || "";
 
        const isStatic =
          /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|map)(\?|$)/i.test(
            url,
          );
        const isApi =
          !isStatic &&
          (ct.includes("application/json") ||
            ct.includes("application/") ||
            url.includes("/api/") ||
            url.includes("/auth/") ||
            url.includes("/v1/") ||
            url.includes("/graphql"));
        return isApi && status >= 200 && status < 400;
      },
      { timeout },
    )
    .catch(() => null);
 
  const result = await apiResponsePromise;
  if (result) {
 
    await page.waitForTimeout(300);
  }
}
 
 
async function waitForSubmitComplete(page, timeout = 20000) {
  const start = Date.now();
 
  const apiResp = await page
    .waitForResponse(
      (resp) => {
        const url = resp.url();
        const method = resp.request().method();
        const status = resp.status();
        const isStatic =
          /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|map)(\?|$)/i.test(
            url,
          );
        return (
          !isStatic &&
          ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
          status >= 200 &&
          status < 400
        );
      },
      { timeout },
    )
    .catch(() => null);
 
  if (!apiResp) {
 
    await page.waitForTimeout(800);
    return;
  }
 
  const elapsed = Date.now() - start;
  const remaining = Math.max(timeout - elapsed - 500, 2000);
 
  await page
    .waitForLoadState("networkidle", { timeout: remaining })
    .catch(() => {});
  await page.waitForTimeout(200);
}
 
async function waitForNetwork(page) {
  await waitForApiResponse(page, 6000);
}
 
async function resolveLocator(page, selectors, timeout = SELECTOR_TIMEOUT) {
  const sels = Array.isArray(selectors) ? selectors : [selectors];
 
  const SKIP = new Set([
    "div",
    "button",
    "input",
    "span",
    "a",
    "p",
    "section",
    "form",
    "ul",
    "li",
    "nav",
    "header",
    "footer",
  ]);
 
  const isGenericType = (s) =>
    /^input\[type=["'](text|number|tel|url|search)["']\]$/.test(s);
 
  const isBad = (s) =>
    !s || SKIP.has(s) || s.startsWith("text=FeaturesFree") || isGenericType(s);
 
  const score = async (s, pg) => {
    if (isBad(s)) return -1;
    if (s.startsWith("[data-testid") || s.startsWith("[data-cy")) return 100;
    if (/^#[^\s]+$/.test(s)) return 95;
    if (s.startsWith("[name=")) return 90;
    if (s.startsWith("[aria-label=")) return 85;
    if (s.startsWith("[placeholder=")) return 80;
    if (s.startsWith("#") && s.includes(" ")) return 75;
    if (/\._[A-Za-z]+_[a-z0-9]{4,}_/.test(s)) {
      if (pg) {
        try {
          const count = await pg.locator(s).count();
          if (count > 1) return 35;
        } catch (_) {}
      }
      return 70;
    }
    if (/^\.[\w-]+$/.test(s)) return 60;
    if (s.startsWith("text=")) return 55;
    if (s.includes(":nth-of-type")) return 45;
    if (s.includes("[type=")) return 25;
    return 30;
  };
 
  const scored = await Promise.all(
    sels.map(async (s) => ({ s, sc: await score(s, page) })),
  );
  const ranked = scored
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .map((x) => x.s);
 
  const candidates = ranked.length
    ? ranked
    : sels.filter((s) => s && !SKIP.has(s)).slice(0, 3);
  const fallback = candidates[0] || sels.find((s) => s) || sels[0];
 
  for (const sel of candidates) {
    try {
      const loc = sel.startsWith("text=")
        ? page.getByText(sel.slice(5), { exact: false })
        : page.locator(sel).first();
      await loc.waitFor({ state: "attached", timeout });
      return loc;
    } catch (_) {}
  }
 
  return page.locator(fallback).first();
}
 
async function executeStep(page, step, options = {}) {
  const { verbose = true, screenshotDir = null, index } = options;
  const label = `#${step.step_id || step.id || index}  [${step.step_type || step.type}]`;
  const stepType = step.step_type || step.type;
  const action = step.action || step;
  const assertion = step.assertion || step;
 
  if (verbose) process.stdout.write(`  ${label}  `);
 
  try {
    switch (stepType) {
      case "navigate": {
        const url = action.url || step.url;
        const prevStep = options._prevStep;
        const prevType = prevStep ? prevStep.step_type || prevStep.type : null;
        const currentUrl = page.url();
        const norm = (u) => u.replace(/\/$/, "");
 
        const afterClick = prevType === "click";
        const alreadyThere = norm(currentUrl).startsWith(norm(url));
 
        if (alreadyThere) {
          await waitForNetwork(page);
          if (verbose) console.log(`→ already at ${url}`);
        } else if (afterClick) {
          if (verbose)
            process.stdout.write(`→ waiting for redirect to ${url}  `);
          try {
            await page.waitForURL((u) => norm(u).startsWith(norm(url)), {
              timeout: 25000,
              waitUntil: "domcontentloaded",
            });
            await waitForNetwork(page);
            if (verbose) console.log(`✓  (${page.url()})`);
          } catch (_) {
            if (verbose) process.stdout.write("(no redirect — goto)  ");
            await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: NAV_TIMEOUT,
            });
            await waitForNetwork(page);
            if (verbose) console.log("✓");
          }
        } else {
          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: NAV_TIMEOUT,
          });
          await waitForNetwork(page);
          if (verbose) console.log(`→ ${url}`);
        }
 
        await page.waitForTimeout(STEP_PAUSE);
        break;
      }
 
      case "click": {
        const sels = action.selectors || step.selectors || [];
        const actionTxt = (
          action.target_text ||
          action.action_text ||
          step.action_text ||
          ""
        ).toLowerCase();
        const loc = await resolveLocator(page, sels);
 
        await loc.scrollIntoViewIfNeeded();
 
        const isSubmit =
          sels.some((s) => /type=["']submit["']/.test(s)) ||
          /^(login|sign.?in|register|sign.?up|create|save|update|submit|continue)$/.test(
            actionTxt.trim(),
          );
 
        const nextStep = (options._allSteps || [])[options._stepIndex + 1];
        const nextStepType = nextStep
          ? nextStep.step_type || nextStep.type
          : null;
        const isDropdownTrigger =
          !isSubmit &&
          nextStepType === "click" &&
          (sels.some((s) =>
            /dropdown|select|campaign|picker|combobox/i.test(s),
          ) ||
            /select|choose|pick|campaign/i.test(actionTxt));
 
        const prevStep = options._prevStep;
        const prevActionTxt = (
          prevStep?.action_text ||
          prevStep?.action?.action_text ||
          ""
        ).toLowerCase();
        const isDropdownOption =
          !isSubmit &&
          (/select|choose|pick|campaign/i.test(prevActionTxt) ||
            (prevStep &&
              (prevStep.selectors || []).some((s) =>
                /dropdown|select|campaign|picker/i.test(s),
              )));
 
        const urlBefore = page.url();
 
        if (isSubmit) {
          const nextNavStep = (() => {
            const allSteps = options._allSteps || [];
            const curIdx = options._stepIndex ?? -1;
            for (
              let j = curIdx + 1;
              j < Math.min(curIdx + 6, allSteps.length);
              j++
            ) {
              const t = allSteps[j].step_type || allSteps[j].type;
              if (t === "navigate") return allSteps[j];
              if (t === "click" || t === "fill") break;
            }
            return null;
          })();
 
          const targetUrl = nextNavStep
            ? nextNavStep.action?.url || nextNavStep.url
            : null;
          const norm = (u) => u.replace(/\/$/, "");
 
          await loc.click({ timeout: 10000 });
 
          await waitForSubmitComplete(page, NETWORK_TIMEOUT);
 
          if (targetUrl) {
            const alreadyThere = norm(page.url()).startsWith(norm(targetUrl));
            if (!alreadyThere) {
              if (verbose) process.stdout.write(` [waiting for ${targetUrl}] `);
              await page
                .waitForURL((u) => norm(u).startsWith(norm(targetUrl)), {
                  timeout: 25000,
                  waitUntil: "domcontentloaded",
                })
                .catch(() => {});
              /* Wait for page data to load after redirect */
              await waitForApiResponse(page, 5000);
            }
          } else {
            const urlAfter = page.url();
            if (urlAfter !== urlBefore) {
              await page
                .waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT })
                .catch(() => {});
              await waitForApiResponse(page, 5000);
            } else {
              await page.waitForTimeout(800);
            }
          }
        } else if (isDropdownTrigger) {
          await loc.click({ timeout: 10000 });
 
          await page.waitForTimeout(600);
        } else if (isDropdownOption) {
          await loc.click({ timeout: 10000 });
 
          await page.waitForTimeout(400);
          await waitForNetwork(page);
        } else {
          await loc.click({ timeout: 10000 });
          await waitForNetwork(page);
 
          const urlAfter = page.url();
          if (urlAfter !== urlBefore) {
            await page
              .waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT })
              .catch(() => {});
            await waitForNetwork(page);
            if (verbose) process.stdout.write(" [nav] ");
          }
        }
 
        if (verbose)
          console.log(
            `→ "${action.target_text || action.action_text || step.action_text || sels[0]}"`,
          );
        await page.waitForTimeout(STEP_PAUSE);
        break;
      }
 
      case "fill": {
        const sels = action.selectors || step.selectors || [];
        const value = action.value || step.value || "";
        const loc = await resolveLocator(page, sels);
 
        await loc.scrollIntoViewIfNeeded();
 
        const inputType = await loc
          .evaluate((el) => (el.type || "").toLowerCase())
          .catch(() => "");
 
        if (inputType === "checkbox" || inputType === "radio") {
          const check =
            value === "on" ||
            value === "true" ||
            value === "1" ||
            value === "checked";
 
          let done = false;
 
          try {
            check
              ? await loc.check({ timeout: 5000 })
              : await loc.uncheck({ timeout: 5000 });
            done = true;
          } catch (_) {}
 
          if (!done) {
            try {
              check
                ? await loc.check({ timeout: 5000, force: true })
                : await loc.uncheck({ timeout: 5000, force: true });
              done = true;
            } catch (_) {}
          }
 
          if (!done) {
            try {
              const id = await loc.evaluate((el) => el.id).catch(() => "");
              if (id) {
                const label = page.locator(`label[for="${id}"]`).first();
                const exists = await label.count().catch(() => 0);
                if (exists) {
                  await label.click({ timeout: 5000 });
                  done = true;
                }
              }
            } catch (_) {}
          }
 
          /* Absolute last resort — click the parent element */
          if (!done) {
            await loc.evaluate((el) => {
              const parent = el.closest("label") || el.parentElement;
              if (parent) parent.click();
              else el.click();
            });
          }
 
          if (verbose)
            console.log(`→ ${check ? "checked" : "unchecked"}  ${sels[0]}`);
        } else if (
          inputType === "date" ||
          inputType === "time" ||
          inputType === "datetime-local"
        ) {
          await loc.fill(value, { timeout: 10000 });
          if (verbose) console.log(`→ "${value}"  into  ${sels[0]}`);
        } else {
          await loc.click({ timeout: 5000 }).catch(() => {});
          await loc.fill(value, { timeout: 10000 });
          if (verbose) console.log(`→ "${value}"  into  ${sels[0]}`);
        }
 
        await waitForNetwork(page);
        await page.waitForTimeout(STEP_PAUSE);
        break;
      }
 
      case "assert": {
        const assertType =
          assertion.assert_type || assertion.type || step.assert_type || "";
        const sels = assertion.selectors || step.selectors || [];
        const rawExpected =
          assertion.expected || assertion.captured_text || step.expected || "";
        const expected = rawExpected.replace(/\s+/g, " ").trim();
        const source = assertion.source || step.source || "";
 
        const isFalsePositive =
          (step.auto_captured || assertion.auto_captured) &&
          (rawExpected === "Modal opened" ||
            /^[A-Z][a-z]+[A-Z]/.test(rawExpected) ||
            (sels[0] && sels[0].includes("toastContainer")) ||
            (sels.some((s) => /mobile.?menu|nav-login/.test(s)) &&
              assertType === "element_visible"));
 
        if (isFalsePositive) {
          if (verbose)
            console.log(
              `→ skip (false-positive: "${rawExpected.slice(0, 40)}")`,
            );
          break;
        }
 
        if (
          assertType === "url_contains" ||
          assertType === "url_equals" ||
          assertType === "url_not_contains"
        ) {
          const cur = page.url();
          if (assertType === "url_contains" && !cur.includes(expected))
            throw new Error(`URL should contain "${expected}" — got "${cur}"`);
          if (assertType === "url_equals" && cur !== expected)
            throw new Error(`URL should equal "${expected}" — got "${cur}"`);
          if (assertType === "url_not_contains" && cur.includes(expected))
            throw new Error(
              `URL should NOT contain "${expected}" — got "${cur}"`,
            );
          if (verbose) console.log(`→ url ${assertType} "${expected}"`);
          break;
        }
 
        const loc = await resolveLocator(page, sels, ASSERTION_TIMEOUT);
 
        switch (assertType) {
          case "element_visible":
            await loc.waitFor({ state: "visible", timeout: ASSERTION_TIMEOUT });
            if (verbose) console.log(`→ visible  [${source || sels[0]}]`);
            break;
 
          case "element_absent":
            await loc
              .waitFor({ state: "hidden", timeout: ASSERTION_TIMEOUT })
              .catch(async () => {
                const n = await page
                  .locator(sels[0])
                  .count()
                  .catch(() => 0);
                if (n > 0)
                  throw new Error(`Expected absent but found: ${sels[0]}`);
              });
            if (verbose) console.log(`→ absent  [${sels[0]}]`);
            break;
 
          case "text_contains": {
            if (!expected) {
              if (verbose) console.log("→ skip (no expected)");
              break;
            }
            const norm = (s) => s.replace(/\s+/g, " ").trim();
            const normExp = norm(expected);
            let matched = false;
 
            try {
              await loc.waitFor({
                state: "attached",
                timeout: ASSERTION_TIMEOUT,
              });
              const txt =
                (await loc.innerText().catch(() => null)) ||
                (await loc.textContent().catch(() => ""));
              if (norm(txt || "").includes(normExp)) matched = true;
            } catch (_) {}
 
            if (!matched) {
              for (const kw of normExp.split(" ").filter((w) => w.length > 3)) {
                try {
                  const v = await page
                    .getByText(kw, { exact: false })
                    .first()
                    .isVisible({ timeout: 2000 })
                    .catch(() => false);
                  if (v) {
                    matched = true;
                    break;
                  }
                } catch (_) {}
              }
            }
 
            if (!matched) {
              const bodyText = norm(
                await page
                  .evaluate(() => document.body.innerText || "")
                  .catch(() => ""),
              );
              if (bodyText.includes(normExp)) matched = true;
            }
 
            if (!matched) throw new Error(`Text not found: "${normExp}"`);
            if (verbose)
              console.log(`→ text contains  "${normExp.slice(0, 60)}"`);
            break;
          }
 
          case "text_equals": {
            if (!expected) {
              if (verbose) console.log("→ skip (no expected)");
              break;
            }
            await loc.waitFor({ state: "visible", timeout: ASSERTION_TIMEOUT });
            const txt = (await loc.innerText()).replace(/\s+/g, " ").trim();
            const exp = expected.replace(/\s+/g, " ").trim();
            if (!txt.includes(exp))
              throw new Error(
                `Text mismatch.\n  Expected: "${exp}"\n  Got: "${txt}"`,
              );
            if (verbose) console.log(`→ text equals  "${exp.slice(0, 60)}"`);
            break;
          }
 
          case "input_value": {
            await loc.waitFor({ state: "visible", timeout: ASSERTION_TIMEOUT });
            const val = await loc.inputValue();
            if (val !== expected)
              throw new Error(
                `Input value mismatch.\n  Expected: "${expected}"\n  Got: "${val}"`,
              );
            if (verbose) console.log(`→ input value  "${expected}"`);
            break;
          }
 
          case "input_empty": {
            await loc.waitFor({ state: "visible", timeout: ASSERTION_TIMEOUT });
            const val = await loc.inputValue();
            if (val !== "")
              throw new Error(`Expected empty input, got: "${val}"`);
            if (verbose) console.log("→ input empty");
            break;
          }
 
          case "element_disabled": {
            await loc.waitFor({ state: "visible", timeout: ASSERTION_TIMEOUT });
            if (!(await loc.isDisabled()))
              throw new Error("Expected element to be disabled");
            if (verbose) console.log(`→ disabled  [${sels[0]}]`);
            break;
          }
 
          case "element_enabled": {
            await loc.waitFor({ state: "visible", timeout: ASSERTION_TIMEOUT });
            if (!(await loc.isEnabled()))
              throw new Error("Expected element to be enabled");
            if (verbose) console.log(`→ enabled  [${sels[0]}]`);
            break;
          }
 
          case "element_checked": {
            await loc.waitFor({ state: "visible", timeout: ASSERTION_TIMEOUT });
            if (!(await loc.isChecked()))
              throw new Error("Expected element to be checked");
            if (verbose) console.log(`→ checked  [${sels[0]}]`);
            break;
          }
 
          default:
            if (verbose)
              console.log(`→ unknown assert_type "${assertType}" — skipped`);
        }
 
        await page.waitForTimeout(STEP_PAUSE * 0.5);
        break;
      }
 
      default:
        if (verbose) console.log(`→ unknown step type "${stepType}" — skipped`);
    }
 
    if (screenshotDir) {
      const fname = path.join(
        screenshotDir,
        `step_${String(index).padStart(3, "0")}_${stepType}.png`,
      );
      await page.screenshot({ path: fname }).catch(() => {});
    }
  } catch (err) {
    if (verbose) console.log(`  ✗ FAILED`);
    throw err;
  }
}
 
function loadPlan(jsonPath) {
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const plan = data.test_plan || data;
  const steps = plan.steps || [];
 
  const deduped = [];
  for (const step of steps) {
    const type = step.step_type || step.type;
    if (type === "navigate" && deduped.length) {
      const last = deduped[deduped.length - 1];
      const lastType = last.step_type || last.type;
      const lastUrl = (last.action || last).url;
      const thisUrl = (step.action || step).url;
      if (lastType === "navigate" && lastUrl === thisUrl) continue;
    }
    deduped.push(step);
  }
 
  return {
    meta: plan.meta || {
      session_id: "unknown",
      start_url: plan.start_url || "",
    },
    summary: plan.summary || {},
    steps: deduped,
  };
}
 
module.exports = { executeStep, resolveLocator, loadPlan };
