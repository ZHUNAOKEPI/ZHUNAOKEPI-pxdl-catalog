import * as pdfjsLib from "./vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "./vendor/pdf.worker.min.mjs";

const params = new URLSearchParams(window.location.search);
const pdfUrl = params.get("pdf") || "pxdl.pdf";
const fileName = decodeURIComponent(pdfUrl.split("/").pop() || "pxdl.pdf");
const splitSpreads = params.get("mode") !== "single";
const displayName = fileName === "pxdl.pdf" ? "璞信电力画册" : fileName.replace(/\.pdf$/i, "");
const turnDuration = 980;

const viewerShell = document.querySelector(".viewer-shell");
const stage = document.querySelector("#stage");
const bookWrap = document.querySelector("#bookWrap");
const flipbook = document.querySelector("#flipbook");
const loadingPanel = document.querySelector("#loadingPanel");
const errorPanel = document.querySelector("#errorPanel");
const pageCount = document.querySelector("#pageCount");
const prevBtn = document.querySelector("#prevBtn");
const nextBtn = document.querySelector("#nextBtn");
const fullscreenBtn = document.querySelector("#fullscreenBtn");
const themeBtn = document.querySelector("#themeBtn");
const downloadBtn = document.querySelector("#downloadBtn");
const catalogTitle = document.querySelector("#catalogTitle");
const themeColorMeta = document.querySelector('meta[name="theme-color"]');

let pageFlip = null;
let totalPages = 0;
let isReady = false;
let turningTimer = null;
let wheelTimer = null;
let wheelLock = false;
let fullscreenResizeGuard = false;

catalogTitle.textContent = displayName || "画册预览";
downloadBtn.href = pdfUrl;
downloadBtn.setAttribute("download", fileName);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const nextFrame = () => new Promise((resolve) => window.requestAnimationFrame(resolve));

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    window.clearTimeout(timer);
  });
}

function applyTheme(theme) {
  const nextTheme = theme === "light" ? "light" : "dark";
  document.body.dataset.theme = nextTheme;
  localStorage.setItem("catalog-theme", nextTheme);
  themeColorMeta?.setAttribute("content", nextTheme === "light" ? "#f8f5ed" : "#171717");
  themeBtn?.setAttribute("aria-label", nextTheme === "light" ? "切换深色背景" : "切换浅色背景");
  themeBtn?.setAttribute("title", nextTheme === "light" ? "切换深色背景" : "切换浅色背景");
}

applyTheme(localStorage.getItem("catalog-theme") || "dark");

function setTurning(isTurning, delay = 0) {
  window.clearTimeout(turningTimer);

  if (isTurning) {
    flipbook.dataset.turning = "true";
    return;
  }

  turningTimer = window.setTimeout(() => {
    flipbook.dataset.turning = "false";
  }, delay);
}

function getFlipState(event) {
  const data = event?.data;
  if (typeof data === "string") return data;
  return data?.state || data?.data || "";
}

function flipByDirection(direction) {
  if (!pageFlip || wheelLock) return;

  const current = pageFlip.getCurrentPageIndex() + 1;
  if (direction < 0 && current <= 1) return;
  if (direction > 0 && current >= totalPages) return;

  wheelLock = true;
  setTurning(true);

  if (direction > 0) {
    pageFlip.flipNext();
  } else {
    pageFlip.flipPrev();
  }

  setTurning(false, turnDuration + 160);
  window.clearTimeout(wheelTimer);
  wheelTimer = window.setTimeout(() => {
    wheelLock = false;
  }, turnDuration + 220);
}

function getBookSize(firstPage) {
  const stageRect = stage.getBoundingClientRect();
  const singlePageWidth = splitSpreads ? firstPage.width / 2 : firstPage.width;
  const sourceRatio = singlePageWidth / firstPage.height;
  const isMobile = window.matchMedia("(max-width: 760px)").matches;
  const spreadRatio = isMobile ? sourceRatio : sourceRatio * 2;
  const maxWidth = stageRect.width - (isMobile ? 18 : 76);
  const maxHeight = stageRect.height - (isMobile ? 18 : 76);

  let width = maxWidth;
  let height = width / spreadRatio;

  if (height > maxHeight) {
    height = maxHeight;
    width = height * spreadRatio;
  }

  const pageWidth = isMobile ? width : width / 2;
  return {
    pageWidth: Math.floor(clamp(pageWidth, 240, 720)),
    pageHeight: Math.floor(clamp(height, 320, 980)),
    usePortrait: isMobile,
  };
}

function createPageShell(pageNumber, density = "soft") {
  const page = document.createElement("div");
  const canvas = document.createElement("canvas");

  page.className = density === "hard" ? "page page-cover" : "page";
  page.dataset.pageNumber = String(pageNumber);
  page.dataset.density = density;
  canvas.setAttribute("aria-label", `第 ${pageNumber} 页`);
  page.appendChild(canvas);

  return { page, canvas };
}

function createPlaceholderPages(pdfPageCount) {
  const pages = [];
  const targets = new Map();
  let bookPageNumber = 1;

  for (let pdfPageNumber = 1; pdfPageNumber <= pdfPageCount; pdfPageNumber += 1) {
    if (splitSpreads && pdfPageNumber === 1) {
      const cover = createPageShell(bookPageNumber, "hard");
      const backCover = createPageShell(pdfPageCount * 2, "hard");

      pages.push(cover.page);
      bookPageNumber += 1;
      targets.set(pdfPageNumber, [
        { canvas: cover.canvas, side: "right" },
        { canvas: backCover.canvas, side: "left" },
      ]);

      pages.push(backCover.page);
      continue;
    }

    const left = createPageShell(bookPageNumber);
    pages.push(left.page);
    bookPageNumber += 1;

    if (splitSpreads) {
      const right = createPageShell(bookPageNumber);
      pages.push(right.page);
      bookPageNumber += 1;
      targets.set(pdfPageNumber, [
        { canvas: left.canvas, side: "left" },
        { canvas: right.canvas, side: "right" },
      ]);
    } else {
      targets.set(pdfPageNumber, [{ canvas: left.canvas, side: "full" }]);
    }
  }

  if (splitSpreads && pdfPageCount > 0) {
    const backCover = pages.splice(1, 1)[0];
    pages.push(backCover);
  }

  return { pages, targets };
}

function paintLoadingPage(canvas, size) {
  const ratio = Math.min(window.devicePixelRatio || 1, 1.25);
  canvas.width = Math.floor(size.pageWidth * ratio);
  canvas.height = Math.floor(size.pageHeight * ratio);

  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#f5f1e8";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#d8d0c2";
  context.fillRect(canvas.width * 0.16, canvas.height * 0.22, canvas.width * 0.68, 2);
  context.fillRect(canvas.width * 0.16, canvas.height * 0.32, canvas.width * 0.58, 2);
  context.fillRect(canvas.width * 0.16, canvas.height * 0.42, canvas.width * 0.64, 2);
}

async function renderPdfPageToTargets(pdfPage, size, targetCanvases) {
  const viewport = pdfPage.getViewport({ scale: 1 });
  const targetWidth = splitSpreads ? size.pageWidth * 2 : size.pageWidth;
  const renderQuality = Math.min(Math.max(window.devicePixelRatio || 1, 1.75), 2);
  const renderScale = Math.min(targetWidth / viewport.width, size.pageHeight / viewport.height) * renderQuality;
  const renderViewport = pdfPage.getViewport({ scale: renderScale });
  const sourceCanvas = document.createElement("canvas");
  const sourceContext = sourceCanvas.getContext("2d", { alpha: false });

  sourceCanvas.width = Math.floor(renderViewport.width);
  sourceCanvas.height = Math.floor(renderViewport.height);

  await pdfPage.render({
    canvasContext: sourceContext,
    viewport: renderViewport,
  }).promise;

  if (!splitSpreads) {
    const [{ canvas }] = targetCanvases;
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    canvas.getContext("2d", { alpha: false }).drawImage(sourceCanvas, 0, 0);
    return;
  }

  const halfWidth = Math.floor(sourceCanvas.width / 2);
  targetCanvases.forEach(({ canvas, side }) => {
    canvas.width = halfWidth;
    canvas.height = sourceCanvas.height;
    canvas.getContext("2d", { alpha: false }).drawImage(
      sourceCanvas,
      side === "left" ? 0 : halfWidth,
      0,
      halfWidth,
      sourceCanvas.height,
      0,
      0,
      halfWidth,
      sourceCanvas.height,
    );
  });
}

async function renderRemainingPages(pdf, size, targets, startPage) {
  for (let pageNumber = startPage; pageNumber <= pdf.numPages; pageNumber += 1) {
    await nextFrame();
    const pdfPage = await pdf.getPage(pageNumber);
    await renderPdfPageToTargets(pdfPage, size, targets.get(pageNumber));
  }
}

function updateControls() {
  if (!isReady || !pageFlip) {
    pageCount.textContent = "-- / --";
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  const current = pageFlip.getCurrentPageIndex() + 1;
  flipbook.dataset.closed = current <= 1 ? "true" : "false";
  pageCount.textContent = `${current} / ${totalPages}`;
  prevBtn.disabled = current <= 1;
  nextBtn.disabled = current >= totalPages;
  setTurning(false, 180);
}

function mountFlipbook(pages, size) {
  flipbook.replaceChildren(...pages);

  pageFlip = new St.PageFlip(flipbook, {
    width: size.pageWidth,
    height: size.pageHeight,
    size: "fixed",
    minWidth: 240,
    maxWidth: 720,
    minHeight: 320,
    maxHeight: 980,
    maxShadowOpacity: 0.58,
    showCover: true,
    mobileScrollSupport: false,
    usePortrait: size.usePortrait,
    flippingTime: turnDuration,
    drawShadow: true,
    startZIndex: 1,
  });

  pageFlip.loadFromHTML(document.querySelectorAll(".page"));
  pageFlip.turnToPage(0);
  pageFlip.on("flip", updateControls);
  pageFlip.on("changeOrientation", updateControls);
  pageFlip.on("changeState", (event) => {
    const state = getFlipState(event);
    setTurning(state !== "read", state === "read" ? 180 : 0);
  });
  isReady = true;
  setTurning(false);
  updateControls();
}

async function loadBook() {
  try {
    const pdf = await withTimeout(
      pdfjsLib.getDocument(pdfUrl).promise,
      12000,
      "PDF 加载超时，请使用 http/https 地址打开画册。",
    );
    const firstPdfPage = await pdf.getPage(1);
    const size = getBookSize(firstPdfPage.getViewport({ scale: 1 }));
    const { pages, targets } = createPlaceholderPages(pdf.numPages);

    totalPages = pages.length;
    targets.forEach((canvases) => canvases.forEach(({ canvas }) => paintLoadingPage(canvas, size)));

    loadingPanel.hidden = true;
    errorPanel.hidden = true;
    bookWrap.hidden = false;
    mountFlipbook(pages, size);

    await nextFrame();
    await renderPdfPageToTargets(firstPdfPage, size, targets.get(1));
    renderRemainingPages(pdf, size, targets, 2).catch((error) => console.error(error));
  } catch (error) {
    console.error(error);
    loadingPanel.hidden = true;
    bookWrap.hidden = true;
    errorPanel.hidden = false;
    updateControls();
  }
}

prevBtn.addEventListener("click", () => {
  flipByDirection(-1);
});

nextBtn.addEventListener("click", () => {
  flipByDirection(1);
});

fullscreenBtn.addEventListener("click", async () => {
  try {
    fullscreenResizeGuard = true;

    if (!document.fullscreenElement) {
      await viewerShell.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }

    window.setTimeout(() => {
      pageFlip?.update?.();
      updateControls();
      fullscreenResizeGuard = false;
    }, 360);
  } catch (error) {
    console.error(error);
    fullscreenResizeGuard = false;
  }
});

themeBtn.addEventListener("click", () => {
  applyTheme(document.body.dataset.theme === "light" ? "dark" : "light");
});

document.addEventListener("keydown", (event) => {
  if (!pageFlip) return;
  if (event.key === "ArrowLeft") flipByDirection(-1);
  if (event.key === "ArrowRight") flipByDirection(1);
});

flipbook.addEventListener("pointerdown", () => setTurning(true));
flipbook.addEventListener("pointerup", () => setTurning(false, turnDuration + 160));
flipbook.addEventListener("pointercancel", () => setTurning(false, 240));
flipbook.addEventListener("mouseleave", () => setTurning(false, turnDuration + 160));

stage.addEventListener(
  "wheel",
  (event) => {
    if (!pageFlip || Math.abs(event.deltaY) < 18) return;

    event.preventDefault();
    flipByDirection(event.deltaY > 0 ? 1 : -1);
  },
  { passive: false },
);

let resizeTimer = null;
window.addEventListener("resize", () => {
  if (!isReady) return;
  if (document.fullscreenElement || fullscreenResizeGuard) {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      pageFlip?.update?.();
      updateControls();
    }, 260);
    return;
  }

  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    window.location.reload();
  }, 280);
});

loadBook();
