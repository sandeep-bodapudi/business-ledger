"use client";

import { useLayoutEffect } from "react";

// Shows every screen in the person's language. Pages are written in English; this swaps each piece of text for its
// translation from a phrase list (src/lib/lex). Text it has no translation for, such as names and amounts, is left alone.
// It only ever changes the value of an existing text node, so React keeps working normally.

type Lex = Record<string, string>;
type Pack = { default: Lex; frag: [string, string][] };
const LOADERS: Record<string, () => Promise<Pack>> = {
  hi: () => import("@/lib/lex/hi"),
  te: () => import("@/lib/lex/te"),
  ta: () => import("@/lib/lex/ta"),
  kn: () => import("@/lib/lex/kn"),
};
const ATTRS = ["placeholder", "title", "aria-label", "alt"] as const;
const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE", "PRE", "NOSCRIPT"]);
const NUM = /₹?\d[\d,]*(?:\.\d+)?/g;

const INDIC = /[ऀ-෿]/;
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Names = { re: RegExp; map: Map<string, string> } | null;
/** Month and weekday names in the person's language, taken from the browser's own calendar data. */
function dateNames(lang: string): Names {
  try {
    const map = new Map<string, string>();
    const loc = `${lang}-IN`;
    for (let m = 0; m < 12; m++) {
      const d = new Date(Date.UTC(2026, m, 15));
      for (const style of ["long", "short"] as const) {
        map.set(new Intl.DateTimeFormat("en-IN", { month: style, timeZone: "UTC" }).format(d), new Intl.DateTimeFormat(loc, { month: style, timeZone: "UTC" }).format(d));
      }
    }
    for (let w = 0; w < 7; w++) {
      const d = new Date(Date.UTC(2026, 9, 11 + w));
      for (const style of ["long", "short"] as const) {
        map.set(new Intl.DateTimeFormat("en-IN", { weekday: style, timeZone: "UTC" }).format(d), new Intl.DateTimeFormat(loc, { weekday: style, timeZone: "UTC" }).format(d));
      }
    }
    map.delete("May"); // also an ordinary word, so it is left as it is
    const re = new RegExp(`(?<![A-Za-z])(?:${[...map.keys()].map(escapeRe).join("|")})(?![A-Za-z])`, "g");
    return { re, map };
  } catch {
    return null;
  }
}

function lookup(lex: Lex, raw: string, frag: [string, string][], names: Names, whole = false): string | null {
  const key = raw.replace(/\s+/g, " ").trim();
  if (!key || !/[A-Za-z]/.test(key)) return null;
  const hit = lex[key];
  if (hit !== undefined) return hit;
  // "12 bills" -> "{n} bills": the same sentence with the numbers filled back in.
  const nums = key.match(NUM);
  if (nums) {
    let i = 0;
    const pattern = lex[key.replace(NUM, "{n}")];
    if (pattern !== undefined) return pattern.replace(/\{n\}/g, () => nums[i++] ?? "");
  }
  if (whole) return null; // labels read by screen readers are translated only as whole phrases
  // Mixed text such as "Next number: INV-4" or "pay by 14 Oct 2026": translate the known pieces and dates inside it.
  let out = key;
  if (names) out = out.replace(names.re, (w) => names.map.get(w) ?? w);
  if (!INDIC.test(key)) {
    for (const [from, to] of frag) {
      if (!out.includes(from)) continue;
      const lead = /^\w/.test(from) ? "\\b" : "";
      const tail = /\w$/.test(from) ? "\\b" : "";
      out = out.replace(new RegExp(lead + escapeRe(from) + tail, "g"), to);
    }
  }
  return out === key ? null : out;
}

function wrap(raw: string, translated: string) {
  return (/^\s*/.exec(raw)?.[0] ?? "") + translated + (/\s*$/.exec(raw)?.[0] ?? "");
}

export function AutoTranslate({ lang }: { lang: string }) {
  useLayoutEffect(() => {
    const texts = new WeakMap<Text, { en: string; out: string }>();
    const attrs = new WeakMap<Element, Map<string, { en: string; out: string }>>();
    let lex: Lex | null = null;
    let frag: [string, string][] = [];
    let names: Names = null;
    let observer: MutationObserver | null = null;
    let cancelled = false;

    const doText = (n: Text) => {
      const parent = n.parentElement;
      if (!parent || SKIP.has(parent.tagName) || parent.closest("[translate=no]")) return;
      const cur = n.nodeValue ?? "";
      const rec = texts.get(n);
      if (rec && rec.out === cur) return;
      const tr = lex ? lookup(lex, cur, frag, names) : null;
      const out = tr === null ? cur : wrap(cur, tr);
      texts.set(n, { en: cur, out });
      if (out !== cur) n.nodeValue = out;
    };
    const doAttrs = (el: Element) => {
      for (const a of ATTRS) {
        const cur = el.getAttribute(a);
        if (cur === null) continue;
        const m = attrs.get(el) ?? new Map();
        const rec = m.get(a);
        if (rec && rec.out === cur) continue;
        const tr = lex ? lookup(lex, cur, frag, names, true) : null;
        const out = tr === null ? cur : tr;
        m.set(a, { en: cur, out });
        attrs.set(el, m);
        if (out !== cur) el.setAttribute(a, out);
      }
    };
    const doTitle = () => {
      const cur = document.title;
      const m = /^(.*?)( · .*)?$/.exec(cur);
      const tr = lex && m?.[1] ? lookup(lex, m[1], frag, names) : null;
      if (tr) document.title = tr + (m?.[2] ?? "");
    };
    const walk = (root: Node) => {
      if (root.nodeType === Node.TEXT_NODE) return doText(root as Text);
      if (root.nodeType !== Node.ELEMENT_NODE) return;
      const el = root as Element;
      if (SKIP.has(el.tagName)) return;
      doAttrs(el);
      const w = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (n.nodeType === Node.TEXT_NODE) doText(n as Text);
        else if (!SKIP.has((n as Element).tagName)) doAttrs(n as Element);
      }
    };
    const restore = () => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (n.nodeType === Node.TEXT_NODE) {
          const r = texts.get(n as Text);
          if (r && r.out !== r.en && n.nodeValue === r.out) n.nodeValue = r.en;
        } else {
          const m = attrs.get(n as Element);
          if (m) for (const [a, r] of m) if (r.out !== r.en && (n as Element).getAttribute(a) === r.out) (n as Element).setAttribute(a, r.en);
        }
      }
    };

    const start = async () => {
      if (lang === "en" || !LOADERS[lang]) return;
      const pack = await LOADERS[lang]();
      lex = pack.default;
      frag = pack.frag;
      names = dateNames(lang);
      if (cancelled) return;
      walk(document.body);
      doTitle();
      observer = new MutationObserver((list) => {
        observer?.disconnect();
        for (const m of list) {
          if (m.type === "characterData") walk(m.target);
          else if (m.type === "attributes") doAttrs(m.target as Element);
          else m.addedNodes.forEach(walk);
        }
        doTitle();
        observer?.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
    };
    void start();
    return () => {
      cancelled = true;
      observer?.disconnect();
      restore();
    };
  }, [lang]);
  return null;
}
