import fs from 'node:fs/promises';
import process from 'node:process';
import { chromium } from 'playwright';

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Provide ${name}.`);
  return value;
}

const cloudcliUrl = requiredEnvironment('CLOUDCLI_E2E_BASE_URL');
const publicDocsUrl = requiredEnvironment('DOCS_E2E_PUBLIC_URL');
const credentialsFile = requiredEnvironment('DOCS_E2E_CREDENTIALS_FILE');
const cloudcliToken = process.env.CLOUDCLI_E2E_TOKEN;
const passwordFile = process.env.CLOUDCLI_E2E_PASSWORD_FILE;
const username = process.env.CLOUDCLI_E2E_USERNAME?.trim();
const artifactDirectory = new URL('./artifacts/docs-ui-live/', import.meta.url);
const expectedRoutes = ['Overview', 'Libraries', 'Jobs & Queue', 'Search Playground', 'Settings'];

const credentials = await fs.readFile(credentialsFile, 'utf8');
const httpCredentials = {
  username: credentials.match(/^Username:\s*(.+)$/mi)?.[1]?.trim(),
  password: credentials.match(/^Password:\s*(.+)$/mi)?.[1]?.trim(),
};
if (!httpCredentials.username || !httpCredentials.password) throw new Error('Docs Basic credentials are unavailable.');
await fs.mkdir(artifactDirectory, { recursive: true });

function sanitizeUrl(rawUrl) {
  const url = new URL(rawUrl);
  const revision = url.searchParams.get('cloudcli-rev');
  return `${url.protocol}//${url.host}${url.pathname}${revision ? `?cloudcli-rev=${revision}` : ''}`;
}

function observe(page, network, errors) {
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.includes('/api/docs-ui') || url.pathname.includes('/api/listLibraries')) {
      network.push({ kind: 'HTTP', url: sanitizeUrl(response.url()), status: response.status() });
    }
  });
  page.on('websocket', (socket) => {
    const url = new URL(socket.url());
    if (url.pathname.includes('/api')) network.push({ kind: 'WS', url: sanitizeUrl(socket.url()), status: 'opened' });
  });
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text().replaceAll(/https?:\/\/\S+/g, '[url]')}`); });
  page.on('pageerror', (error) => errors.push(`page: ${error.message.replaceAll(/https?:\/\/\S+/g, '[url]')}`));
}

async function validateResponsive(frame, page) {
  const menu = frame.getByRole('button', { name: 'Open Docs navigation' });
  await menu.waitFor({ state: 'visible', timeout: 30_000 });
  await menu.click();
  const drawer = frame.getByRole('complementary', { name: 'Docs navigation' });
  await drawer.waitFor({ state: 'visible' });
  const labels = await drawer.getByRole('link').allTextContents();
  await page.keyboard.press('Escape');
  const escapeClosed = await drawer.isHidden();
  await menu.click();
  await frame.getByRole('button', { name: 'Close Docs navigation' }).first().click();
  const scrimClosed = await drawer.isHidden();
  await menu.click();
  await drawer.getByRole('link', { name: 'Libraries', exact: true }).click();
  await page.waitForTimeout(750);
  const selectionClosed = await drawer.isHidden();
  const pathname = await frame.locator('body').evaluate(() => location.pathname);
  return { labels, escapeClosed, scrimClosed, selectionClosed, pathname };
}

async function validatePublic(browser) {
  const network = []; const errors = [];
  const unauthorized = await (await browser.newContext({ ignoreHTTPSErrors: true })).request.get(publicDocsUrl);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 820, height: 820 }, httpCredentials });
  const page = await context.newPage(); observe(page, network, errors);
  await page.goto(publicDocsUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.locator('body').waitFor(); await page.waitForTimeout(4_000);
  const responsive = await validateResponsive(page, page);
  const rendered = (await page.locator('body').innerText()).trim().length > 20;
  await page.setViewportSize({ width: 1200, height: 900 }); await page.waitForTimeout(300);
  const desktop = { menuHidden: await page.getByRole('button', { name: 'Open Docs navigation' }).isHidden(), sidebarVisible: await page.locator('.sidebar').isVisible() };
  await context.close();
  return { unauthorizedStatus: unauthorized.status(), responsive, rendered, desktop, network, errors };
}

async function validateCloudcli(browser) {
  const network = []; const errors = [];
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 820, height: 820 } });
  const page = await context.newPage(); observe(page, network, errors);
  let token = cloudcliToken;
  if (!token && passwordFile) {
    if (!username) throw new Error('Provide CLOUDCLI_E2E_USERNAME when using CLOUDCLI_E2E_PASSWORD_FILE.');
    const password = (await fs.readFile(passwordFile, 'utf8')).trim();
    const response = await context.request.post(`${cloudcliUrl}/api/auth/login`, { data: { username, password } });
    const payload = await response.json();
    if (response.ok() && typeof payload?.token === 'string') token = payload.token;
  }
  if (!token) throw new Error('Provide CLOUDCLI_E2E_TOKEN or CLOUDCLI_E2E_PASSWORD_FILE.');
  await page.addInitScript((value) => localStorage.setItem('auth-token', value), token);
  await page.goto(cloudcliUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  const docsButton = page.getByRole('button', { name: /^Docs$/i });
  if (!await docsButton.isVisible().catch(() => false)) {
    const project = page.getByText('code', { exact: true }).filter({ visible: true });
    if (await project.count()) await project.first().click();
    await docsButton.waitFor({ state: 'visible', timeout: 30_000 });
  }
  await docsButton.click();
  const iframe = page.locator('iframe[title="Docs"]'); await iframe.waitFor({ state: 'visible' });
  const frame = page.frameLocator('iframe[title="Docs"]'); await frame.locator('body').waitFor(); await page.waitForTimeout(4_000);
  const before = await validateResponsive(frame, page);
  await page.getByRole('button', { name: 'Refresh Docs' }).click(); await frame.locator('body').waitFor(); await page.waitForTimeout(4_000);
  const after = await validateResponsive(frame, page);
  const rendered = (await frame.locator('body').innerText()).trim().length > 20;
  await page.setViewportSize({ width: 1200, height: 900 }); await page.waitForTimeout(300);
  const desktop = { menuHidden: await frame.getByRole('button', { name: 'Open Docs navigation' }).isHidden(), sidebarVisible: await frame.locator('.sidebar').isVisible() };
  await context.close();
  return { before, after, rendered, desktop, network, errors };
}

const browser = await chromium.launch({ headless: true });
try {
  const publicResult = await validatePublic(browser);
  const cloudcliResult = await validateCloudcli(browser);
  const assertions = {
    publicProtected: publicResult.unauthorizedStatus === 401,
    publicRoutes: expectedRoutes.every((route) => publicResult.responsive.labels.includes(route)),
    publicInteraction: publicResult.responsive.escapeClosed && publicResult.responsive.scrimClosed && publicResult.responsive.selectionClosed && publicResult.responsive.pathname.endsWith('/libraries'),
    cloudcliRoutes: expectedRoutes.every((route) => cloudcliResult.before.labels.includes(route)) && expectedRoutes.every((route) => cloudcliResult.after.labels.includes(route)),
    cloudcliInteraction: [cloudcliResult.before, cloudcliResult.after].every((state) => state.escapeClosed && state.scrimClosed && state.selectionClosed && state.pathname.endsWith('/libraries')),
    rendered: publicResult.rendered && cloudcliResult.rendered,
    desktop: publicResult.desktop.menuHidden && publicResult.desktop.sidebarVisible && cloudcliResult.desktop.menuHidden && cloudcliResult.desktop.sidebarVisible,
    revisionedJavaScript: cloudcliResult.network.some(({ url, status }) => url.includes('.js?cloudcli-rev=docs-runtime-v2') && status === 200),
    prefixedLibraries: cloudcliResult.network.some(({ url, status }) => url.endsWith('/api/docs-ui/api/listLibraries') && status === 200),
    prefixedWebSocket: cloudcliResult.network.some(({ kind, url }) => kind === 'WS' && url.endsWith('/api/docs-ui/api')),
    noRootRegression: !cloudcliResult.network.some(({ url }) => new URL(url).pathname === '/api/listLibraries' || new URL(url).pathname === '/api'),
    noBrowserErrors: publicResult.errors.length === 0 && cloudcliResult.errors.length === 0,
  };
  const result = { public: publicResult, cloudcli: cloudcliResult, assertions };
  await fs.writeFile(new URL('result.json', artifactDirectory), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (Object.values(assertions).some((passed) => !passed)) process.exitCode = 1;
} finally { await browser.close(); }
