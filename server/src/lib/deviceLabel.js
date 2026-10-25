'use strict';

// A short, human label for the Signed-in devices list ("Safari on iPhone").
// Only the label is stored, not the full User-Agent string.
const BROWSERS = [
  [/Edg\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS/, 'Firefox'],
  [/CriOS|Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];
const PLATFORMS = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Macintosh|Mac OS X/, 'Mac'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

function deviceLabel(userAgent) {
  const ua = String(userAgent || '');
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1];
  const platform = PLATFORMS.find(([pattern]) => pattern.test(ua))?.[1];
  if (browser && platform) return `${browser} on ${platform}`;
  return browser || platform || 'Unknown device';
}

module.exports = { deviceLabel };
