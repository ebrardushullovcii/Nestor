/**
 * Presents the embedded browser as the Chrome it is built from.
 *
 * Electron ships Chromium with the "Chromium" brand and an empty `window.chrome`
 * object. Google's sign-in page refuses that combination as an unsupported
 * embedded browser before any credentials are entered, while the same Chromium
 * build presenting as Chrome is accepted. Only identity is adjusted: no
 * automation flags are hidden, nothing about the device is faked, and the
 * user-owned sign-in flow itself is untouched (ADR 0017).
 */
const GOOGLE_CHROME_BRAND = "Google Chrome";

/** Adds the Chrome brand next to Chromium in a `Sec-CH-UA` style header value. */
export function withChromeBrand(headerValue: string, version: string): string {
  if (headerValue.includes(`"${GOOGLE_CHROME_BRAND}"`)) return headerValue;
  const chromiumEntry = /"Chromium";v="[^"]*"/.exec(headerValue);
  const entry = `"${GOOGLE_CHROME_BRAND}";v="${version}"`;
  if (!chromiumEntry) return headerValue ? `${headerValue}, ${entry}` : entry;
  return headerValue.replace(chromiumEntry[0], `${chromiumEntry[0]}, ${entry}`);
}

/** Rewrites client-hint brand headers so they match the in-page identity. */
export function alignClientHintHeaders(
  headers: Record<string, string>,
  chromeVersion: string,
): Record<string, string> {
  // Retry site verification restores the tab's original Electron identity.
  // Its hints must stay original too, rather than contradicting that UA.
  const userAgent = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "user-agent",
  )?.[1];
  if (userAgent?.includes("Electron/")) return { ...headers };
  const major = chromeVersion.split(".")[0] ?? chromeVersion;
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    output[name] =
      key === "sec-ch-ua"
        ? withChromeBrand(value, major)
        : key === "sec-ch-ua-full-version-list"
          ? withChromeBrand(value, chromeVersion)
          : value;
  }
  return output;
}

/**
 * Main-world script run by the page preload before any page script. It only
 * touches the user-agent brand list and the `window.chrome` shape.
 */
export const CHROME_IDENTITY_SCRIPT = `(() => {
  if (navigator.userAgent.includes("Electron/")) return;
  const match = /Chrome\\/(\\d+)(?:\\.(\\d+\\.\\d+\\.\\d+))?/.exec(navigator.userAgent);
  if (!match) return;
  const major = match[1];
  const full = match[2] ? major + "." + match[2] : major + ".0.0.0";
  const brand = "Google Chrome";
  const withBrand = (list, version) => {
    const input = Array.isArray(list) ? list : [];
    if (input.some((item) => item && item.brand === brand)) return input;
    const output = [];
    let inserted = false;
    for (const item of input) {
      output.push({ brand: item.brand, version: item.version });
      if (item.brand === "Chromium") {
        output.push({ brand, version });
        inserted = true;
      }
    }
    if (!inserted) output.push({ brand, version });
    return output;
  };
  const data = navigator.userAgentData;
  if (data) {
    const proto = Object.getPrototypeOf(data);
    const brands = Object.getOwnPropertyDescriptor(proto, "brands");
    if (brands && brands.get) {
      const read = brands.get;
      Object.defineProperty(proto, "brands", {
        configurable: true,
        enumerable: true,
        get() { return withBrand(read.call(this), major); },
      });
    }
    const highEntropy = proto.getHighEntropyValues;
    if (typeof highEntropy === "function") {
      Object.defineProperty(proto, "getHighEntropyValues", {
        configurable: true,
        writable: true,
        value: function getHighEntropyValues(hints) {
          return highEntropy.call(this, hints).then((values) => ({
            ...values,
            brands: withBrand(values.brands, major),
            ...(values.fullVersionList
              ? { fullVersionList: withBrand(values.fullVersionList, full) }
              : {}),
          }));
        },
      });
    }
    const toJSON = proto.toJSON;
    if (typeof toJSON === "function") {
      Object.defineProperty(proto, "toJSON", {
        configurable: true,
        writable: true,
        value: function toJSON() {
          const values = toJSON.call(this);
          return { ...values, brands: withBrand(values.brands, major) };
        },
      });
    }
  }
  const chrome = window.chrome;
  if (!chrome || typeof chrome !== "object") return;
  const now = () => Date.now() / 1000;
  if (!("app" in chrome)) {
    chrome.app = {
      isInstalled: false,
      InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
      RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
      getDetails: function getDetails() { return null; },
      getIsInstalled: function getIsInstalled() { return false; },
      runningState: function runningState() { return "cannot_run"; },
    };
  }
  if (!("csi" in chrome)) {
    chrome.csi = function csi() {
      return { startE: Date.now(), onloadT: Date.now(), pageT: performance.now(), tran: 15 };
    };
  }
  if (!("loadTimes" in chrome)) {
    chrome.loadTimes = function loadTimes() {
      const time = now();
      return {
        requestTime: time, startLoadTime: time, commitLoadTime: time,
        finishDocumentLoadTime: time, finishLoadTime: time, firstPaintTime: time,
        firstPaintAfterLoadTime: 0, navigationType: "Other",
        wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: "h2",
        wasAlternateProtocolAvailable: false, connectionInfo: "h2",
      };
    };
  }
  if (!("runtime" in chrome)) {
    chrome.runtime = {
      OnInstalledReason: { CHROME_UPDATE: "chrome_update", INSTALL: "install", SHARED_MODULE_UPDATE: "shared_module_update", UPDATE: "update" },
      PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
      PlatformOs: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" },
      RequestUpdateCheckStatus: { NO_UPDATE: "no_update", THROTTLED: "throttled", UPDATE_AVAILABLE: "update_available" },
      connect: function connect() {},
      sendMessage: function sendMessage() {},
      id: undefined,
    };
  }
})();`;
