// Labels the device from what the browser already exposes: the user agent, User-Agent Client Hints where
// available, and screen size and pixel ratio. Nothing else is read. Every value is a guess the user can edit.

export interface Detected {
  os: string; osVersion: string | null; browser: string; browserVersion: string | null;
  device: string; deviceCandidates: string[]; jitGuess: 'on' | 'off-lockdown' | 'unknown'; jitReason: string;
}

export function parseUserAgent(ua: string): Pick<Detected, 'os' | 'osVersion' | 'browser' | 'browserVersion' | 'device'> {
  const m = (re: RegExp) => re.exec(ua)?.[1] ?? null;
  let os = 'unknown', osVersion: string | null = null, device = 'unknown';
  if (/iPhone/.test(ua)) { os = 'iOS'; osVersion = m(/OS (\d+[_\d]*)/)?.replaceAll('_', '.') ?? null; device = 'iPhone'; }
  else if (/iPad/.test(ua)) { os = 'iPadOS'; osVersion = m(/OS (\d+[_\d]*)/)?.replaceAll('_', '.') ?? null; device = 'iPad'; }
  else if (/Android/.test(ua)) { os = 'Android'; osVersion = m(/Android ([\d.]+)/); device = m(/Android [\d.]+; ([^;)]+?)(?: Build|\))/)?.trim() || 'Android device'; }
  else if (/Mac OS X/.test(ua)) { os = 'macOS'; osVersion = m(/Mac OS X (\d+[_.\d]*)/)?.replaceAll('_', '.') ?? null; device = 'Mac'; }
  else if (/Windows NT/.test(ua)) { os = 'Windows'; osVersion = m(/Windows NT ([\d.]+)/); device = 'PC'; }
  else if (/Linux/.test(ua)) { os = 'Linux'; device = 'PC'; }
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
  return { os, osVersion, browser, browserVersion, device };
}

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
