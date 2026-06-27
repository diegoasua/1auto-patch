export function resolveAdapter(item) {
  const url = parseUrl(item.website);
  if (!url) {
    return {
      id: "unknown",
      label: "Unknown",
      repairable: false,
      note: "Invalid website URL",
    };
  }

  if (isDemoTargetUrl(url)) {
    return {
      id: "demo-local",
      label: "Demo Target",
      repairable: true,
      note: "Controlled demo adapter",
    };
  }

  if (url.hostname === "app.agihouse.org") {
    return {
      id: "agihouse-passwordless",
      label: "AGI House",
      repairable: false,
      note: "Passwordless login: magic link or Google sign-in, no site password to rotate",
    };
  }

  return {
    id: "generic-browser",
    label: "Generic Browser",
    repairable: process.env.ENABLE_GENERIC_REPAIR === "true",
    note:
      process.env.ENABLE_GENERIC_REPAIR === "true"
        ? "Generic browser agent enabled"
        : "Generic repair disabled; set ENABLE_GENERIC_REPAIR=true",
  };
}

export function isDemoTarget(value) {
  const url = parseUrl(value);
  return Boolean(url && isDemoTargetUrl(url));
}

export function normalizeDemoTarget(item, port) {
  if (!isDemoTarget(item.website)) return item;
  const rewrite = (value) => {
    const url = new URL(value);
    url.protocol = "http:";
    url.hostname = "localhost";
    url.port = String(port);
    return url.toString();
  };
  return {
    ...item,
    website: rewrite(item.website),
    changePasswordUrl: item.changePasswordUrl ? rewrite(item.changePasswordUrl) : `http://localhost:${port}/target/settings`,
  };
}

function isDemoTargetUrl(url) {
  return ["localhost", "127.0.0.1"].includes(url.hostname) && url.pathname.startsWith("/target");
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
