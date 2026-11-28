// Drives the built page in Playwright WebKit (or another engine) and checks the run states, responsiveness
// during a run, Cancel, and the no-Worker fallback. Usage, inside the Playwright image:
//   node webkit-check.mjs /work/index.html [webkit|chromium|firefox] [count]
import { chromium, devices, firefox, webkit } from 'playwright';

const [file, engineName = 'webkit', count = '1000'] = process.argv.slice(2);
const engine = { webkit, chromium, firefox }[engineName];
const browser = await engine.launch();
const report = { engine: engineName, version: browser.version(), checks: [] };
const check = (name, ok, detail = null) => { report.checks.push({ name, ok, detail }); };

// Polls with page.evaluate: waitForFunction evaluates strings, which the page's CSP forbids.
async function waitState(page, states, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const state = await page.evaluate(() => document.body.dataset.state);
    if (states.includes(state)) return state;
    if (Date.now() > end) throw new Error(`state ${state} after ${ms} ms`);
    await new Promise(r => setTimeout(r, 100));
  }
}

async function run(context, label, { cancel = false, engine = 'crypto' } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(file.startsWith("http") ? file : `file://${file}`);
  await waitState(page, ['idle', 'error'], 30000);
  check(`${label}: idle state on load`, await page.textContent('#state') === 'Ready', await page.textContent('#details'));
  check(`${label}: device prefilled`, (await page.inputValue('#device')).length > 0, await page.inputValue('#device'));
  await page.selectOption('#count', count);
  await page.selectOption('#engine', engine);
  await page.click('#run');
  await waitState(page, ['running'], 5000);
  check(`${label}: running state visible`, await page.isVisible('#progress-box') && await page.isDisabled('#run') && await page.isVisible('#cancel'));
  // The page must answer while the scan runs.
  const t = Date.now();
  await page.evaluate(() => document.getElementById('elapsed').textContent);
  check(`${label}: page responsive while running`, Date.now() - t < 500, `${Date.now() - t} ms`);
  if (cancel) {
    await page.click('#cancel');
    check(`${label}: cancel returns to idle`, await page.evaluate(() => document.body.dataset.state) === 'idle');
  } else {
    await waitState(page, ['done', 'error'], 600000);
    const result = await page.evaluate(() => window.phoneBench.result());
    check(`${label}: done and verified`, await page.evaluate(() => document.body.dataset.state) === 'done' && result?.verified === true,
      result ? { msPerAnnouncement: result.msPerAnnouncement, worker: result.worker, device: result.device, browser: result.browser } : await page.textContent('#message'));
    check(`${label}: submit enabled`, !(await page.isDisabled('#submit')));
  }
  check(`${label}: no uncaught errors`, errors.length === 0, errors);
  await page.close();
}

await run(await browser.newContext(), 'worker');
if (engineName === 'webkit') await run(await browser.newContext({ ...devices['iPhone 15'] }), 'emulated iPhone 15');
await run(await browser.newContext(), 'cancel', { cancel: true });
await run(await browser.newContext(), 'wasm engine', { engine: 'wasm' });
const noWorker = await browser.newContext();
await noWorker.addInitScript(() => { delete window.Worker; });
await run(noWorker, 'no-worker fallback');
await browser.close();
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.checks.every(c => c.ok) ? 0 : 1;
