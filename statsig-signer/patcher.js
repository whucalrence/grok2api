import { parse } from "parse5";

const identifier = String.raw`[A-Za-z_$][\w$]*`;

const signerWrapperPattern = new RegExp(
  `async function (${identifier})\\((${identifier}),(${identifier})\\)\\{` +
    `(${identifier})=\\4\\|\\|new Promise\\((${identifier})=>\\{` +
    `(${identifier})\\.A\\((\\d+)\\)\\.then\\((${identifier})=>` +
    `\\5\\(\\8\\.default\\(\\)\\)\\)\\}\\);` +
    `let (${identifier})=await \\4;return await \\9\\(\\2,\\3\\)\\}`,
);

export function patchStatsigChunk(source) {
  if (
    typeof source !== "string" ||
    !source.includes("x-statsig-id") ||
    source.includes("__grok2apiStatsigSign")
  ) {
    return { patched: false, source };
  }

  const match = signerWrapperPattern.exec(source);
  if (!match) {
    return { patched: false, source };
  }

  const replacement = `${match[0]}globalThis.__grok2apiStatsigSign=${match[1]};`;
  return {
    patched: true,
    source: source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length),
    functionName: match[1],
    loaderModuleID: match[7],
  };
}

export function isValidStatsigID(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return false;
  }
  try {
    return Buffer.from(normalized, "base64").length === 70;
  } catch {
    return false;
  }
}

export function prepareStatsigDocument(source, metaContent = "") {
  if (typeof source !== "string") {
    return { found: false, source, metaContent: "" };
  }

  const document = parse(source, { sourceCodeLocationInfo: true });
  const stack = [document];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node?.tagName === "meta") {
      const attributes = new Map((node.attrs ?? []).map((attribute) => [attribute.name, attribute.value]));
      if (normalizeMetaName(attributes.get("name")) === "grok-site-verification") {
        const currentContent = String(attributes.get("content") ?? "").trim();
        if (!currentContent) {
          return { found: false, source, metaContent: "" };
        }
        if (!metaContent || metaContent === currentContent) {
          return { found: true, source, metaContent: currentContent };
        }
        const location = node.sourceCodeLocation?.attrs?.content;
        if (!location) {
          throw new Error("Grok verification meta has no source location");
        }
        const replacement = `content="${escapeHTMLAttribute(metaContent)}"`;
        return {
          found: true,
          source: source.slice(0, location.startOffset) + replacement + source.slice(location.endOffset),
          metaContent,
        };
      }
    }
    if (Array.isArray(node?.childNodes)) {
      stack.push(...node.childNodes);
    }
  }
  return { found: false, source, metaContent: "" };
}

function normalizeMetaName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[‐‑‒–—―]/g, "-");
}

function escapeHTMLAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
