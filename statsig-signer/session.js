const tierRank = new Map([
  ["basic", 1],
  ["super", 2],
  ["heavy", 3],
]);

export function inferAccountTier(windows) {
  let detected = "unknown";
  for (const window of windows ?? []) {
    const mode = String(window?.mode ?? "").toLowerCase();
    const total = Number(window?.total);
    let candidate = "unknown";
    if (mode === "auto") {
      if (total === 7 || total === 20) candidate = "basic";
      if (total === 50) candidate = "super";
      if (total === 150) candidate = "heavy";
    } else if (mode === "fast") {
      if (total === 30) candidate = "basic";
      if (total === 140) candidate = "super";
      if (total === 400) candidate = "heavy";
    }
    if (
      candidate !== "unknown" &&
      (detected === "unknown" || tierRank.get(candidate) < tierRank.get(detected))
    ) {
      detected = candidate;
    }
  }
  return detected;
}

export function isLoginURL(value, expectedOrigin) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return true;
  }
  if (parsed.origin !== expectedOrigin) {
    return true;
  }
  return /^\/(?:auth|login|sign-?in)(?:\/|$)/i.test(parsed.pathname);
}
