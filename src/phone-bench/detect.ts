// Labels the device from what the browser already exposes: the user agent, User-Agent Client Hints where
// available, and screen size and pixel ratio. Nothing else is read. Every value is a guess the user can edit.

export const DEVICE_CLASSES = ['phone', 'tablet', 'laptop/desktop', 'unknown'] as const;
export type DeviceClass = typeof DEVICE_CLASSES[number];

export interface Detected {
  os: string; osVersion: string | null; browser: string; browserVersion: string | null;
  device: string; deviceClass: DeviceClass; arch: string | null; deviceCandidates: string[]; jitGuess: 'on' | 'off-lockdown' | 'unknown'; jitReason: string;
}

/** iPadOS asks for desktop sites by default and then reports a Mac user agent; only touch points tell them apart. */
export function parseUserAgent(ua: string, maxTouchPoints = 0): Pick<Detected, 'os' | 'osVersion' | 'browser' | 'browserVersion' | 'device' | 'deviceClass' | 'arch'> {
  const m = (re: RegExp) => re.exec(ua)?.[1] ?? null;
  let os = 'unknown', osVersion: string | null = null, device = 'unknown', deviceClass: DeviceClass = 'unknown';
  if (/iPhone/.test(ua)) { os = 'iOS'; osVersion = m(/OS (\d+[_\d]*)/)?.replaceAll('_', '.') ?? null; device = 'iPhone'; deviceClass = 'phone'; }
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) { os = 'iPadOS'; osVersion = m(/OS (\d+[_\d]*)/)?.replaceAll('_', '.') ?? null; device = 'iPad'; deviceClass = 'tablet'; }
  else if (/Android/.test(ua)) { os = 'Android'; osVersion = m(/Android ([\d.]+)/); device = m(/Android [\d.]+; ([^;)]+?)(?: Build|\))/)?.trim() || 'Android device'; deviceClass = /Mobile/.test(ua) ? 'phone' : 'tablet'; }
  else if (/Mac OS X/.test(ua)) { os = 'macOS'; osVersion = m(/Mac OS X (\d+[_.\d]*)/)?.replaceAll('_', '.') ?? null; device = 'Mac'; deviceClass = 'laptop/desktop'; }
  else if (/Windows NT/.test(ua)) { os = 'Windows'; osVersion = m(/Windows NT ([\d.]+)/); device = 'Windows PC'; deviceClass = 'laptop/desktop'; }
  else if (/CrOS/.test(ua)) { os = 'ChromeOS'; device = 'Chromebook'; deviceClass = 'laptop/desktop'; }
  else if (/Linux/.test(ua)) { os = 'Linux'; device = 'Linux PC'; deviceClass = 'laptop/desktop'; }
  // Chromium freezes the platform to "Linux x86_64" or "Win64; x64" and Macs say "Intel" on Apple silicon;
  // only non-Chromium Linux browsers report the real CPU. Client Hints cover Chromium (fromHints).
  const arch = os !== 'Linux' || /Chrome\//.test(ua) ? null
    : /aarch64|arm64/i.test(ua) ? 'arm64' : /x86_64|amd64/i.test(ua) ? 'x86-64' : /armv\d/i.test(ua) ? 'arm' : /i[3-6]86/.test(ua) ? 'x86' : null;
  let browser = 'unknown', browserVersion: string | null = null;
  const pick = (name: string, re: RegExp) => { browser = name; browserVersion = m(re); };
  if (/Ddg\//.test(ua)) pick('DuckDuckGo', /Ddg\/([\d.]+)/);
  else if (/EdgA?\//.test(ua)) pick('Edge', /EdgA?\/([\d.]+)/);
  else if (/SamsungBrowser\//.test(ua)) pick('Samsung Internet', /SamsungBrowser\/([\d.]+)/);
  else if (/CriOS\//.test(ua)) pick('Chrome (iOS)', /CriOS\/([\d.]+)/);
  else if (/FxiOS\//.test(ua)) pick('Firefox (iOS)', /FxiOS\/([\d.]+)/);
  else if (/Firefox\//.test(ua)) pick('Firefox', /Firefox\/([\d.]+)/);
  else if (/Chrome\//.test(ua)) pick('Chrome', /Chrome\/([\d.]+)/);
  else if (/Version\/[\d.]+.*Safari\//.test(ua)) pick('Safari', /Version\/([\d.]+)/);
  else if (/AppleWebKit\//.test(ua)) pick('WebKit', /AppleWebKit\/([\d.]+)/);
  return { os, osVersion, browser, browserVersion, device, deviceClass, arch };
}

/** User-Agent Client Hints (Chromium only): CPU architecture, and the real OS version the frozen user agent hides. */
export function fromHints(os: string, h: { architecture?: string; bitness?: string; platformVersion?: string }): { arch: string | null; osVersion: string | null } {
  const arch = h.architecture === 'arm' ? (h.bitness === '32' ? 'arm' : 'arm64') : h.architecture === 'x86' ? (h.bitness === '32' ? 'x86' : 'x86-64') : null;
  const major = Number(h.platformVersion?.split('.')[0]);
  const osVersion = !h.platformVersion ? null : os === 'Windows' ? (major >= 13 ? '11' : major > 0 ? '10' : null) : os === 'macOS' ? h.platformVersion.replace(/\.0$/, '') : null;
  return { arch, osVersion };
}

/** The device field's starting text: a model where one is known, otherwise the kind of machine and its CPU. */
export const deviceLabel = (device: string, arch: string | null) => arch ? `${device} (${arch})` : device;

// iPhone logical screen size (points, portrait) and pixel ratio. Several models share one size.
const IPHONES: [w: number, h: number, dpr: number, models: string][] = [
  [320, 568, 2, 'iPhone SE (1st gen), 5s'],
  [375, 667, 2, 'iPhone SE (2nd/3rd gen), 8, 7, 6s'],
  [414, 736, 3, 'iPhone 8 Plus, 7 Plus'],
  [375, 812, 3, 'iPhone 13 mini, 12 mini, 11 Pro, XS, X'],
  [414, 896, 2, 'iPhone 11, XR'],
  [414, 896, 3, 'iPhone 11 Pro Max, XS Max'],
  [390, 844, 3, 'iPhone 14, 13, 13 Pro, 12, 12 Pro, 16e'],
  [428, 926, 3, 'iPhone 14 Plus, 13 Pro Max, 12 Pro Max'],
  [393, 852, 3, 'iPhone 16, 15, 15 Pro, 14 Pro'],
  [430, 932, 3, 'iPhone 16 Plus, 15 Plus, 15 Pro Max, 14 Pro Max'],
  [402, 874, 3, 'iPhone 17, 17 Pro, 16 Pro'],
  [420, 912, 3, 'iPhone Air'],
  [440, 956, 3, 'iPhone 17 Pro Max, 16 Pro Max'],
];
export function iphoneCandidates(width: number, height: number, dpr: number): string[] {
  const w = Math.min(width, height), h = Math.max(width, height);
  return IPHONES.filter(([a, b, d]) => a === w && b === h && d === Math.round(dpr)).map(([, , , models]) => models);
}

/** Lockdown Mode turns off the JIT and also WebAssembly, which is observable; nothing exposes the JIT itself. */
export function jitGuess(os: string, hasWasm: boolean): Pick<Detected, 'jitGuess' | 'jitReason'> {
  if ((os === 'iOS' || os === 'iPadOS') && !hasWasm) return { jitGuess: 'off-lockdown', jitReason: 'WebAssembly is unavailable, as in Lockdown Mode' };
  if (hasWasm) return { jitGuess: 'on', jitReason: 'WebAssembly is available; JIT assumed on' };
  return { jitGuess: 'unknown', jitReason: 'No reliable signal' };
}

/** In-app and privacy browsers that wallet users run, from user-agent markers (Brave from navigator.brave). */
export function detectApp(ua: string, brave: boolean): string | null {
  const v = (re: RegExp) => re.exec(ua)?.[1];
  const markers: [RegExp, string, RegExp?][] = [
    [/Ddg\//, 'DuckDuckGo', /Ddg\/([\d.]+)/], [/DuckDuckGo\//, 'DuckDuckGo', /DuckDuckGo\/([\d.]+)/],
    [/Focus\//, 'Firefox Focus', /Focus\/([\d.]+)/], [/MetaMaskMobile/, 'MetaMask (in-app)'], [/CoinbaseWallet/, 'Coinbase Wallet (in-app)'],
    [/Trust\//, 'Trust Wallet (in-app)'], [/Rainbow/, 'Rainbow (in-app)'], [/Instagram/, 'Instagram (in-app)'], [/FBAN|FBAV/, 'Facebook (in-app)'],
    [/Twitter|TwitterAndroid/, 'X (in-app)'], [/Telegram/, 'Telegram (in-app)'], [/ Line\//, 'LINE (in-app)'],
  ];
  for (const [test, name, version] of markers) if (test.test(ua)) return version && v(version) ? `${name} ${v(version)}` : name;
  if (brave) return 'Brave';
  // iOS WebKit without the "Safari/" token is an app's WebView, not Safari.
  if (/iPhone|iPad/.test(ua) && /AppleWebKit/.test(ua) && !/Safari\//.test(ua)) return 'In-app browser (iOS WebView)';
  return null;
}
