import { parse } from "parse5";

const identifier = String.raw`[A-Za-z_$][\w$]*`;

const signerWrapperPattern = new RegExp(
  `async function (${identifier})\\((${identifier}),(${identifier})\\)\\{` +
    `(${identifier})=\\4\\|\\|new Promise\\((${identifier})=>\\{` +
    `(${identifier})\\.A\\((\\d+)\\)\\.then\\((${identifier})=>` +
    `\\5\\(\\8\\.default\\(\\)\\)\\)\\}\\);` +
    `let (${identifier})=await \\4;return await \\9\\(\\2,\\3\\)\\}`,
);

const cachedFactorySignerPattern = new RegExp(
  `let (${identifier})=\\((${identifier})=async\\(\\)=>\\(await (${identifier})\\.A\\((\\d+)\\)\\)\\.default\\(\\),` +
    `async function\\((${identifier}),(${identifier})\\)\\{` +
    `(${identifier})\\?\\?=\\2\\(\\)\\.catch\\((${identifier})=>\\{throw \\7=void 0,\\8\\}\\);` +
    `let (${identifier})=await \\7;return await \\9\\(\\5,\\6\\)\\}\\),` +
    `(${identifier})=`,
);

export function patchStatsigChunk(source) {
  if (
    typeof source !== "string" ||
    !source.includes("x-statsig-id") ||
    source.includes("__grok2apiStatsigSign")
  ) {
    return { patched: false, source };
  }

  const legacyMatch = signerWrapperPattern.exec(source);
  if (legacyMatch) {
    const replacement = `${legacyMatch[0]}globalThis.__grok2apiStatsigSign=${legacyMatch[1]};`;
    return {
      patched: true,
      source:
        source.slice(0, legacyMatch.index) +
        replacement +
        source.slice(legacyMatch.index + legacyMatch[0].length),
      functionName: legacyMatch[1],
      loaderModuleID: legacyMatch[7],
    };
  }

  const factoryMatch = cachedFactorySignerPattern.exec(source);
  if (!factoryMatch) {
    return { patched: false, source };
  }

  const nextVariable = factoryMatch[10];
  const declaration = factoryMatch[0].slice(0, -(`,${nextVariable}=`.length));
  const replacement = `${declaration};globalThis.__grok2apiStatsigSign=${factoryMatch[1]};let ${nextVariable}=`;
  return {
    patched: true,
    source:
      source.slice(0, factoryMatch.index) +
      replacement +
      source.slice(factoryMatch.index + factoryMatch[0].length),
    functionName: factoryMatch[1],
    loaderModuleID: factoryMatch[4],
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
