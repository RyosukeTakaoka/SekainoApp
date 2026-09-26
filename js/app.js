/* ポテカウ: カメラや写真からポテト(フライドポテト)の本数をざっくり判定するだけのネタアプリ。
   すべてブラウザ内の画像処理で完結し、サーバーには何も送信しない。 */

const screens = {
  capture: document.getElementById("screen-capture"),
  loading: document.getElementById("screen-loading"),
  result: document.getElementById("screen-result"),
};

const video = document.getElementById("video");
const cameraPlaceholder = document.getElementById("camera-placeholder");
const btnStartCamera = document.getElementById("btn-start-camera");
const btnShutter = document.getElementById("btn-shutter");
const fileInput = document.getElementById("file-input");
const loadingText = document.getElementById("loading-text");
const resultCanvas = document.getElementById("result-card");
const btnShareX = document.getElementById("btn-share-x");
const btnShareNative = document.getElementById("btn-share-native");
const btnSave = document.getElementById("btn-save");
const btnRetry = document.getElementById("btn-retry");
const workCanvas = document.getElementById("work-canvas");

let mediaStream = null;
let lastCardBlob = null;

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle("active", key === name);
  });
}

/* ---------------- カメラ制御 ---------------- */

async function startCamera() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    video.srcObject = mediaStream;
    video.classList.add("on");
    cameraPlaceholder.classList.add("hidden");
    btnStartCamera.hidden = true;
    btnShutter.hidden = false;
  } catch (err) {
    alert("カメラを起動できませんでした。「写真を選ぶ」から画像を選択してください。");
  }
}

function stopCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  video.classList.remove("on");
  cameraPlaceholder.classList.remove("hidden");
  btnStartCamera.hidden = false;
  btnShutter.hidden = true;
}

function captureFromVideo() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;
  const scale = Math.min(1, 900 / Math.max(w, h));
  workCanvas.width = Math.round(w * scale);
  workCanvas.height = Math.round(h * scale);
  const ctx = workCanvas.getContext("2d");
  ctx.drawImage(video, 0, 0, workCanvas.width, workCanvas.height);
  stopCamera();
  runPipeline(workCanvas);
}

async function handleFileSelected(file) {
  if (!file) return;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    bitmap = await loadImageFallback(file);
  }
  const scale = Math.min(1, 900 / Math.max(bitmap.width, bitmap.height));
  workCanvas.width = Math.round(bitmap.width * scale);
  workCanvas.height = Math.round(bitmap.height * scale);
  const ctx = workCanvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, workCanvas.width, workCanvas.height);
  runPipeline(workCanvas);
}

function loadImageFallback(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = reject;
    img.src = url;
  });
}

/* ---------------- 画像解析(ポテトのざっくりカウント) ---------------- */

const LOADING_LINES = [
  "ポテト検査官が本数を数えています…",
  "1本、2本…油で指を滑らせながら数え中…",
  "本部にポテト成分を照会しています…",
  "塩加減も同時にチェックしています…",
];

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return [h, s, v];
}

function buildPotatoMask(imageData) {
  const { data, width, height } = imageData;
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const [h, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
    const isPotatoColor = h >= 22 && h <= 55 && s >= 0.22 && s <= 0.95 && v >= 0.32 && v <= 0.97;
    mask[p] = isPotatoColor ? 1 : 0;
  }
  return { mask, width, height };
}

function denoiseMask(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[ny * width + nx]) {
            neighbors++;
          }
        }
      }
      if (mask[idx]) {
        out[idx] = neighbors >= 2 ? 1 : 0;
      } else {
        out[idx] = neighbors >= 6 ? 1 : 0;
      }
    }
  }
  return out;
}

function findComponents(mask, width, height) {
  const labels = new Int32Array(mask.length).fill(-1);
  const components = [];
  const stack = new Int32Array(mask.length);

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] !== -1) continue;

    let sp = 0;
    stack[sp++] = start;
    labels[start] = components.length;

    let area = 0;
    let minX = width, maxX = 0, minY = height, maxY = 0;

    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % width;
      const y = (idx - x) / width;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const neighbors = [
        [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
      ];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (mask[nIdx] && labels[nIdx] === -1) {
          labels[nIdx] = components.length;
          stack[sp++] = nIdx;
        }
      }
    }

    components.push({
      area,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    });
  }
  return components;
}

/* フライドポテトは細長い塊になりやすいが、複数本がくっついて
   ひとつの塊(コンポーネント)として検出されることが多い。
   そのため「1本あたりの標準的な面積」を推定し、面積を割って本数を見積もる。 */
function estimatePotatoCount(components, totalPixels) {
  const minArea = Math.max(10, totalPixels * 0.00025);
  const maxArea = totalPixels * 0.6;

  const valid = components.filter((c) => c.area >= minArea && c.area <= maxArea);

  if (valid.length === 0) {
    return { count: null, blobs: 0 };
  }

  const elongated = valid.filter((c) => {
    const long = Math.max(c.width, c.height);
    const short = Math.max(1, Math.min(c.width, c.height));
    return long / short >= 1.8;
  });

  const referenceSet = elongated.length > 0 ? elongated : valid;
  const sortedAreas = referenceSet.map((c) => c.area).sort((a, b) => a - b);
  const unitArea = sortedAreas[Math.floor(sortedAreas.length / 2)];

  let total = 0;
  for (const c of valid) {
    total += Math.max(1, Math.round(c.area / unitArea));
  }

  return { count: total, blobs: valid.length };
}

function analyzePotatoCount(canvas) {
  const ctx = canvas.getContext("2d");
  const analysisWidth = Math.min(canvas.width, 360);
  const scale = analysisWidth / canvas.width;
  const analysisHeight = Math.round(canvas.height * scale);

  const small = document.createElement("canvas");
  small.width = analysisWidth;
  small.height = analysisHeight;
  small.getContext("2d").drawImage(canvas, 0, 0, analysisWidth, analysisHeight);

  const imageData = small.getContext("2d").getImageData(0, 0, analysisWidth, analysisHeight);
  const { mask, width, height } = buildPotatoMask(imageData);
  const cleanMask = denoiseMask(mask, width, height);
  const components = findComponents(cleanMask, width, height);
  const result = estimatePotatoCount(components, width * height);

  if (result.count === null) {
    return Math.floor(Math.random() * 12) + 3;
  }
  return result.count;
}

/* ---------------- 称号判定 ---------------- */

const RANKS = [
  { max: 0, title: "空っぽ検定", lines: [
    "ポテトが1本も見つかりませんでした。まずは買ってきてください。",
    "お皿しか写っていないようです。ポテト、どこ?",
  ]},
  { max: 5, title: "ポテト見習い", lines: [
    "とりあえずお腹には入りそうな本数です。",
    "様子見の量。追加注文はまだ間に合います。",
  ]},
  { max: 15, title: "標準的ポテター", lines: [
    "至って普通のポテト摂取量です。健全。",
    "特に事件性のない、平和なポテトライフ。",
  ]},
  { max: 25, title: "ポテトマイスター", lines: [
    "なかなかの本数。指がベタベタになる頃合いです。",
    "ポテトへの本気度が伝わってきます。",
  ]},
  { max: 40, title: "ポテト長者", lines: [
    "気づいたらМサイズを2箱開けていたタイプ。",
    "その本数、もはや主食では?",
  ]},
  { max: 60, title: "ポテト王", lines: [
    "国が獲れる本数。塩分にはお気をつけて。",
    "ポテトの民から尊敬される領域に到達。",
  ]},
  { max: Infinity, title: "伝説のポテトフレンズ", lines: [
    "画面に写り切っていないポテトがまだある可能性大。",
    "明日は野菜を食べましょう。約束です。",
  ]},
];

function getRank(count) {
  const rank = RANKS.find((r) => count <= r.max);
  const comment = rank.lines[Math.floor(Math.random() * rank.lines.length)];
  return { title: rank.title, comment };
}

/* ---------------- 結果カード描画 ---------------- */

function wrapJaText(ctx, text, x, y, maxWidth, lineHeight) {
  let line = "";
  let cy = y;
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line !== "") {
      ctx.fillText(line, x, cy);
      line = ch;
      cy += lineHeight;
    } else {
      line = test;
    }
  }
  ctx.fillText(line, x, cy);
  return cy;
}

function renderResultCard(photoCanvas, count, rank) {
  const ctx = resultCanvas.getContext("2d");
  const W = resultCanvas.width;
  const H = resultCanvas.height;

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#ffe9c2");
  grad.addColorStop(1, "#ffcf5c");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.font = "64px sans-serif";
  ctx.globalAlpha = 0.18;
  ctx.fillText("🍟", 30, 90);
  ctx.fillText("🍟", W - 110, H - 40);
  ctx.globalAlpha = 1;

  ctx.textAlign = "center";
  ctx.fillStyle = "#8a4b18";
  ctx.font = "bold 40px 'Zen Maru Gothic', sans-serif";
  ctx.fillText("🍟 ポテカウ判定結果", W / 2, 70);

  const photoW = 520;
  const photoH = 400;
  const photoX = (W - photoW) / 2;
  const photoY = 100;
  const radius = 18;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(photoX + radius, photoY);
  ctx.arcTo(photoX + photoW, photoY, photoX + photoW, photoY + photoH, radius);
  ctx.arcTo(photoX + photoW, photoY + photoH, photoX, photoY + photoH, radius);
  ctx.arcTo(photoX, photoY + photoH, photoX, photoY, radius);
  ctx.arcTo(photoX, photoY, photoX + photoW, photoY, radius);
  ctx.closePath();
  ctx.clip();

  const srcRatio = photoCanvas.width / photoCanvas.height;
  const dstRatio = photoW / photoH;
  let sx, sy, sw, sh;
  if (srcRatio > dstRatio) {
    sh = photoCanvas.height;
    sw = sh * dstRatio;
    sx = (photoCanvas.width - sw) / 2;
    sy = 0;
  } else {
    sw = photoCanvas.width;
    sh = sw / dstRatio;
    sx = 0;
    sy = (photoCanvas.height - sh) / 2;
  }
  ctx.drawImage(photoCanvas, sx, sy, sw, sh, photoX, photoY, photoW, photoH);
  ctx.restore();

  ctx.fillStyle = "#5c3a12";
  ctx.font = "bold 26px 'Zen Maru Gothic', sans-serif";
  ctx.fillText("あなたのポテトは…", W / 2, photoY + photoH + 60);

  ctx.fillStyle = "#8a4b18";
  ctx.font = "900 110px 'Zen Maru Gothic', sans-serif";
  ctx.fillText(`${count}`, W / 2 - 10, photoY + photoH + 170);
  ctx.font = "bold 34px 'Zen Maru Gothic', sans-serif";
  ctx.fillText("本", W / 2 + 130, photoY + photoH + 170);

  ctx.fillStyle = "#c1440e";
  ctx.font = "bold 32px 'Zen Maru Gothic', sans-serif";
  ctx.fillText(`称号:${rank.title}`, W / 2, photoY + photoH + 220);

  ctx.fillStyle = "#5c3a12";
  ctx.font = "24px 'Zen Maru Gothic', sans-serif";
  ctx.textAlign = "left";
  wrapJaText(ctx, rank.comment, W / 2 - 260, photoY + photoH + 260, 520, 32);

  ctx.textAlign = "center";
  ctx.fillStyle = "#8a4b18";
  ctx.font = "bold 24px 'Zen Maru Gothic', sans-serif";
  ctx.fillText("#ポテカウ", W / 2, H - 30);
}

/* ---------------- パイプライン ---------------- */

let currentPhotoCanvas = null;

function runPipeline(photoCanvas) {
  showScreen("loading");
  loadingText.textContent = LOADING_LINES[Math.floor(Math.random() * LOADING_LINES.length)];

  const snapshot = document.createElement("canvas");
  snapshot.width = photoCanvas.width;
  snapshot.height = photoCanvas.height;
  snapshot.getContext("2d").drawImage(photoCanvas, 0, 0);
  currentPhotoCanvas = snapshot;

  setTimeout(() => {
    const count = analyzePotatoCount(snapshot);
    const rank = getRank(count);
    renderResultCard(snapshot, count, rank);
    resultCanvas.toBlob((blob) => { lastCardBlob = blob; }, "image/png");
    showScreen("result");
  }, 700);
}

/* ---------------- シェア ---------------- */

function shareToX() {
  const canvas = resultCanvas;
  const text = "ポテトの本数をポテカウで判定してもらいました🍟\n#ポテカウ";
  const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

function saveImage() {
  resultCanvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "potaco-result.png";
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}

async function shareNative() {
  if (!lastCardBlob) return;
  const file = new File([lastCardBlob], "potaco-result.png", { type: "image/png" });
  try {
    await navigator.share({
      files: [file],
      text: "ポテトの本数をポテカウで判定してもらいました🍟 #ポテカウ",
    });
  } catch (e) {
    /* ユーザーによるキャンセルなどは無視 */
  }
}

function resetToCapture() {
  showScreen("capture");
}

/* ---------------- イベント登録 ---------------- */

btnStartCamera.addEventListener("click", startCamera);
btnShutter.addEventListener("click", captureFromVideo);
fileInput.addEventListener("change", (e) => handleFileSelected(e.target.files[0]));
btnShareX.addEventListener("click", shareToX);
btnSave.addEventListener("click", saveImage);
btnRetry.addEventListener("click", resetToCapture);
btnShareNative.addEventListener("click", shareNative);

(function detectNativeShare() {
  try {
    const dummy = new File([new Blob(["x"])], "a.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [dummy] })) {
      btnShareNative.hidden = false;
    }
  } catch (e) {
    /* 非対応環境では表示しない */
  }
})();
