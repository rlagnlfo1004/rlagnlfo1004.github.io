// 본문에 심은 <pre class="mermaid-src"> 를 mermaid 다이어그램으로 그린다.
//
// 왜 클라이언트에서 그리나
//  - 소스가 mermaid 라 '코드 복사' 로 그대로 퍼갈 수 있고, 그린 그림은 '이미지 복사'
//    로 PNG 를 클립보드에 담는다. 둘 다 런타임이 있어야 한다.
//  - mermaid 는 무거우므로 .mermaid-figure 가 있는 글에서만 지연 로드한다.
//    (import('mermaid') 는 Astro 가 별도 청크로 쪼개 그런 글에서만 내려받는다.)
//
// 색을 어떻게 맞추나
//  - 색은 전부 :root 의 CSS 토큰에서 실시간으로 읽는다. 손으로 짠 인라인 SVG 들이
//    var(--clay) 를 상속받는 것과 같은 결을 지키려는 것이다.
//  - mermaid 는 색을 SVG 에 구워버리므로 CSS 로는 테마가 안 바뀐다. data-theme 이
//    바뀌면 토큰을 다시 읽어 통째로 다시 그린다.
//
// 왜 htmlLabels:false 인가
//  - 라벨을 foreignObject(HTML) 대신 SVG <text> 로 그린다. foreignObject 가 있으면
//    '이미지 복사' 가 canvas 로 래스터될 때 캔버스가 오염돼 toBlob 이 막힌다.

type Item = { fig: HTMLElement; source: string };
type Palette = ReturnType<typeof palette>;

const figures = Array.from(
  document.querySelectorAll<HTMLElement>(".mermaid-figure"),
);

if (figures.length) void boot(figures);

async function boot(figs: HTMLElement[]) {
  const { default: mermaid } = await import("mermaid");

  const items: Item[] = figs.map((fig) => {
    const src = fig.querySelector<HTMLElement>(".mermaid-src");
    const source = (src?.textContent ?? "")
      .replace(/^\n+/, "")
      .replace(/\s+$/, "");
    // 원본 소스는 '코드 복사' 와 테마 재렌더에 다시 쓰므로 보관한다.
    fig.dataset.src = source;
    return { fig, source };
  });

  await drawAll(mermaid, items);
  items.forEach(({ fig }) => {
    mountTools(fig);
    enableZoom(fig);
  });

  // 테마 토글 → 색을 다시 읽어 다시 그린다. 연타를 대비해 살짝 뭉친다.
  let t: ReturnType<typeof setTimeout>;
  new MutationObserver(() => {
    clearTimeout(t);
    t = setTimeout(() => void drawAll(mermaid, items), 60);
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

// mermaid.render 는 호출마다 유일한 id 를 요구한다. 재렌더까지 세어 겹치지 않게 한다.
let seq = 0;

async function drawAll(mermaid: typeof import("mermaid").default, items: Item[]) {
  const p = palette();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose", // 소스는 전부 필자가 쓴 것이라 신뢰한다. <br/> 도 살아야 한다.
    theme: "base",
    fontFamily: "var(--font-sans)",
    // 라벨을 foreignObject(HTML) 대신 SVG <text> 로 그려야 '이미지 복사' 가 canvas 로
    // 온전히 래스터된다. 이 스위치는 반드시 top-level 에 있어야 먹는다.
    // flowchart.htmlLabels 만으로는 foreignObject 가 그대로 남는다(mermaid v11 확인).
    htmlLabels: false,
    themeVariables: themeVars(p),
    flowchart: {
      htmlLabels: false,
      curve: "basis",
      padding: 16,
      nodeSpacing: 46,
      rankSpacing: 54,
      // 긴 라벨이 잘게 접혀 상자가 좁고 길어지는 걸 막는다. 줄바꿈은 소스의 <br/> 로만.
      wrappingWidth: 420,
    },
    sequence: {
      useMaxWidth: true,
      mirrorActors: false,
      actorMargin: 64,
      noteMargin: 12,
      messageFontFamily: "var(--font-sans)",
    },
  });

  for (const { fig, source } of items) {
    let svg = "";
    try {
      const out = await mermaid.render(`mmd-${seq++}`, withClassDefs(source, p));
      svg = out.svg;
    } catch (e) {
      console.error("[mermaid] 렌더 실패", e);
      continue;
    }

    let canvas = fig.querySelector<HTMLElement>(".mermaid-canvas");
    if (!canvas) {
      canvas = document.createElement("div");
      canvas.className = "mermaid-canvas";
      fig.prepend(canvas);
      fig.querySelector(".mermaid-src")?.remove();
    }
    canvas.innerHTML = svg;
    // mermaid 는 style="max-width:{자연폭}px" width="100%" 로 내보낸다. 손대지 않는다.
    // 좁은 화면에서는 줄고, 넓은 화면에서는 자연 크기에서 멈춘다(작은 그림의 과확대 방지).
    // 자연폭을 넘는 그림은 .mermaid-canvas 의 overflow-x 가 받는다.
    fig.dataset.rendered = "";
  }
}

function palette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  const dark = document.documentElement.dataset.theme === "dark";
  return {
    dark,
    bg: v("--bg") || (dark ? "#0E1013" : "#FFFFFF"),
    surface: v("--surface"),
    sunk: v("--sunk"),
    ink: v("--ink"),
    ink2: v("--ink-2"),
    ink3: v("--ink-3"),
    clay: v("--clay"),
    clayText: v("--clay-text"),
    claySoft: v("--clay-soft"),
    // 경고(락·undo 누적·데드락)만 쓰는 절제된 로즈. 토큰엔 없어 여기서 라이트/다크를 짝짓는다.
    warn: dark ? "#F1787B" : "#D93D42",
    warnSoft: dark ? "#2A1719" : "#FBECEC",
    warnText: dark ? "#F59A9C" : "#C5282D",
  };
}

// classDef 는 색을 리터럴로 요구하므로, 토큰에서 읽은 색을 소스 끝에 붙인다.
// 본문 소스는 :::accent 같은 클래스 이름만 쓰고 색은 모른다 → 테마가 여기서 갈린다.
function withClassDefs(source: string, p: Palette) {
  if (!/^\s*(flowchart|graph)\b/.test(source)) return source; // 시퀀스 등은 themeVariables 로만
  const defs = [
    `classDef accent fill:${p.claySoft},stroke:${p.clay},stroke-width:1.2px,color:${p.clayText};`,
    `classDef soft fill:${p.surface},stroke:${p.clay},stroke-width:1px,color:${p.clayText};`,
    `classDef neutral fill:${p.sunk},stroke:${p.ink3},stroke-width:1px,color:${p.ink};`,
    `classDef mute fill:${p.bg},stroke:${p.ink3},stroke-width:1px,color:${p.ink2};`,
    `classDef warn fill:${p.warnSoft},stroke:${p.warn},stroke-width:1.2px,color:${p.warnText};`,
  ].join("\n");
  return `${source}\n${defs}`;
}

function themeVars(p: Palette) {
  return {
    background: "transparent",
    fontFamily: "var(--font-sans)",
    fontSize: "14px",
    primaryColor: p.claySoft,
    primaryBorderColor: p.clay,
    primaryTextColor: p.clayText,
    secondaryColor: p.sunk,
    secondaryBorderColor: p.ink3,
    secondaryTextColor: p.ink,
    tertiaryColor: p.surface,
    tertiaryBorderColor: p.ink3,
    tertiaryTextColor: p.ink2,
    mainBkg: p.claySoft,
    lineColor: p.ink3,
    textColor: p.ink2,
    titleColor: p.ink,
    edgeLabelBackground: p.bg,
    nodeBorder: p.clay,
    clusterBkg: p.surface,
    clusterBorder: p.ink3,
    // sequence
    actorBkg: p.claySoft,
    actorBorder: p.clay,
    actorTextColor: p.clayText,
    actorLineColor: p.ink3,
    signalColor: p.ink2,
    signalTextColor: p.ink2,
    labelBoxBkgColor: p.sunk,
    labelBoxBorderColor: p.ink3,
    labelTextColor: p.ink,
    loopTextColor: p.ink2,
    noteBkgColor: p.sunk,
    noteBorderColor: p.ink3,
    noteTextColor: p.ink,
    activationBkgColor: p.claySoft,
    activationBorderColor: p.clay,
  };
}

// 24 그리드 · currentColor 스트로크. 도크 아이콘과 같은 결.
const svg = (paths: string) =>
  `<svg class="mermaid-btn__ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON = {
  image: svg(
    `<rect x="3" y="4.5" width="18" height="15" rx="2.2"/><circle cx="8.6" cy="10" r="1.7"/><path d="M4 17.5l4.5-4.2 3 2.6 3.4-3.8 5.1 5"/>`,
  ),
  code: svg(`<path d="M8.5 8 4.5 12l4 4"/><path d="M15.5 8l4 4-4 4"/><path d="M13.5 6.5l-3 11"/>`),
  check: svg(`<path d="M5 12.5l4.2 4.2L19 7.2"/>`),
  warn: svg(`<path d="M12 8.5v4.5"/><path d="M12 16.2v.2"/><circle cx="12" cy="12" r="8.5"/>`),
} as const;

// 아이콘만 그림 위에 띄운다. 라벨은 title/aria-label 로만 남긴다.
function mountTools(fig: HTMLElement) {
  if (fig.querySelector(".mermaid-tools")) return;

  const tools = document.createElement("div");
  tools.className = "mermaid-tools";

  const imgBtn = mkBtn(ICON.image, "이미지 복사");
  imgBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void run(imgBtn, () => copyImage(fig));
  });
  const codeBtn = mkBtn(ICON.code, "mermaid 코드 복사");
  codeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void run(codeBtn, () => copyCode(fig));
  });

  tools.append(imgBtn, codeBtn);
  fig.append(tools);
}

function mkBtn(icon: string, label: string) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mermaid-btn";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.dataset.icon = icon;
  b.innerHTML = icon;
  return b;
}

async function run(btn: HTMLButtonElement, fn: () => Promise<void>) {
  if (btn.dataset.busy !== undefined) return;
  btn.dataset.busy = "";
  try {
    await fn();
    flash(btn, ICON.check, true);
  } catch (e) {
    console.error("[mermaid] 복사 실패", e);
    flash(btn, ICON.warn, false);
  } finally {
    delete btn.dataset.busy;
  }
}

function flash(btn: HTMLButtonElement, icon: string, ok: boolean) {
  btn.dataset.copied = ok ? "" : "err";
  btn.innerHTML = icon;
  setTimeout(() => {
    delete btn.dataset.copied;
    btn.innerHTML = btn.dataset.icon ?? "";
  }, 1600);
}

// 그림을 누르면 화면 가득 확대한다. 아무 데나 다시 누르거나 Esc 로 닫는다.
function enableZoom(fig: HTMLElement) {
  const canvas = fig.querySelector<HTMLElement>(".mermaid-canvas");
  if (!canvas) return;
  canvas.classList.add("is-zoomable");
  // 테마 토글 때 drawAll 이 canvas 안의 svg 를 새로 갈아끼운다. 참조를 잡아 두면
  // 낡은(토글 전) 그림이 뜨므로, 누를 때마다 현재 svg 를 다시 찾는다.
  canvas.addEventListener("click", () => {
    const svgEl = canvas.querySelector("svg");
    if (svgEl) openLightbox(svgEl as SVGSVGElement);
  });
}

function openLightbox(svgEl: SVGSVGElement) {
  const vb = svgEl.viewBox.baseVal;
  const rect = svgEl.getBoundingClientRect();
  const natW = vb && vb.width ? vb.width : rect.width;
  const natH = vb && vb.height ? vb.height : rect.height;

  const box = document.createElement("div");
  box.className = "mermaid-lightbox";

  // 다크 모드에선 그림 배경이 투명이라 스크림에 묻힌다. surface 패널 위에 올린다.
  const panel = document.createElement("div");
  panel.className = "mermaid-lightbox__panel";

  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  // 뷰포트(패널 여백 제외)에 맞춰 키운다. 비율은 유지하고, 지나친 확대는 4배에서 멈춘다.
  const pad = 40;
  const fit = Math.min(
    (innerWidth * 0.9 - pad) / natW,
    (innerHeight * 0.88 - pad) / natH,
    4,
  );
  clone.removeAttribute("style");
  clone.setAttribute("width", String(Math.round(natW * fit)));
  clone.setAttribute("height", String(Math.round(natH * fit)));
  panel.appendChild(clone);
  box.appendChild(panel);

  const close = () => {
    box.remove();
    document.removeEventListener("keydown", onKey);
    document.documentElement.style.overflow = "";
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  box.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.documentElement.style.overflow = "hidden";
  document.body.appendChild(box);
}

async function copyCode(fig: HTMLElement) {
  await navigator.clipboard.writeText(fig.dataset.src ?? "");
}

// SVG → PNG → 클립보드. htmlLabels:false 라 foreignObject 가 없어 캔버스가 안 막힌다.
async function copyImage(fig: HTMLElement) {
  const svgEl = fig.querySelector<SVGSVGElement>(".mermaid-canvas svg");
  if (!svgEl) throw new Error("그린 SVG 가 없다");

  const vb = svgEl.viewBox.baseVal;
  const rect = svgEl.getBoundingClientRect();
  const w = Math.ceil(vb && vb.width ? vb.width : rect.width);
  const h = Math.ceil(vb && vb.height ? vb.height : rect.height);
  const scale = 2; // 레티나에서도 또렷하게

  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  const xml = new XMLSerializer().serializeToString(clone);
  const url =
    "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));

  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("SVG 이미지 로드 실패"));
    img.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d 컨텍스트 없음");
  // 투명 PNG 로 나가면 붙였을 때 배경이 비니, 현재 테마 바탕을 깐다.
  const bg = getComputedStyle(document.documentElement)
    .getPropertyValue("--bg")
    .trim();
  ctx.fillStyle = bg || "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob: Blob = await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob 실패"))), "image/png"),
  );
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": blob }),
  ]);
}
