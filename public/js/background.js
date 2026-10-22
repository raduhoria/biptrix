// Virtual backgrounds for the camera in calls: the person is cut out with
// MediaPipe's selfie segmentation (public/vendor/mediapipe, loaded only
// when a background is picked) and drawn over a blurred copy of the frame
// or over a picture. The result is a canvas track that replaces the camera
// track; the camera itself keeps running underneath.
//
// Frames are driven by a worker's timer: the page's own timers slow to
// once a second in a background tab (while presenting another tab, say),
// a worker's do not.

const BASE = '/vendor/mediapipe';
const FPS = 24;
const FILTER = 'filter' in CanvasRenderingContext2D.prototype;

// The choices: none, two blurs, the bundled pictures, the user's own.
export const BACKGROUNDS = [
  { id: 'none' },
  { id: 'blur-light', blur: 8 },
  { id: 'blur', blur: 20 },
  ...['office', 'home', 'studio', 'city', 'mountains', 'beach', 'aurora', 'abstract'].map((id) => ({ id, src: `/img/backgrounds/${id}.jpg`, thumb: `/img/backgrounds/${id}-thumb.jpg` })),
  { id: 'custom' },
];

const CUSTOM_KEY = 'meet.bgCustom';
export const customBackground = () => localStorage.getItem(CUSTOM_KEY) || '';

// The user's own picture: cropped to 16:9, 1280×720 JPEG, kept on this
// device only (localStorage).
export async function saveCustomBackground(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  cover(canvas.getContext('2d'), bitmap, 1280, 720);
  bitmap.close?.();
  const url = canvas.toDataURL('image/jpeg', 0.82);
  localStorage.setItem(CUSTOM_KEY, url);
  return url;
}

export const backgroundSupported = () => typeof WebAssembly === 'object' && typeof HTMLCanvasElement.prototype.captureStream === 'function';

let segmenterLoad = null;
function segmenter() {
  segmenterLoad ||= (async () => {
    const { FilesetResolver, ImageSegmenter } = await import(`${BASE}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
    const make = (delegate) =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${BASE}/selfie_segmenter.tflite`, delegate },
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
    // The GPU where WebGL allows it, else the CPU (slower, still real time
    // at this model's 256×256).
    try {
      return await make('GPU');
    } catch {
      return make('CPU');
    }
  })();
  segmenterLoad.catch(() => (segmenterLoad = null));
  return segmenterLoad;
}

// Draws `img` to fill w×h, cropping what does not fit (CSS object-fit: cover).
function cover(ctx, img, w, h) {
  const iw = img.videoWidth || img.width;
  const ih = img.videoHeight || img.height;
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, w, h);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// processCamera(track, id) → { track, set(id), stop() }. `track` is what
// goes out; set() changes the background without changing the track (no
// renegotiation). Throws if segmentation cannot load.
export async function processCamera(raw, id) {
  const seg = await segmenter();
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([raw]);
  await video.play();

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  // The mask at the model's size; scaled up with smoothing, its edge is soft.
  const maskCanvas = document.createElement('canvas');
  const maskCtx = maskCanvas.getContext('2d');
  let maskData = null;
  // Blur: the canvas filter, or where there is none (Safari) the frame
  // drawn small and stretched back up.
  const small = document.createElement('canvas');
  const smallCtx = small.getContext('2d');

  let current = null; // { blur } | { image }
  let pending = 0;
  async function set(next) {
    const choice = BACKGROUNDS.find((b) => b.id === next) || BACKGROUNDS[1];
    const ticket = ++pending;
    let value;
    if (choice.blur) value = { blur: choice.blur };
    else {
      const src = choice.id === 'custom' ? customBackground() : choice.src;
      value = src ? { image: await loadImage(src).catch(() => null) } : null;
      if (!value?.image) value = { blur: 20 };
    }
    if (ticket === pending) current = value;
  }
  await set(id);

  // Each tick draws a frame (cheap: the video stays fluid); the mask is
  // recomputed when there is time for it. On a slow device (no GPU) the
  // cut-out follows a little later, rather than the page freezing: after
  // a segmentation that took d ms the next waits at least another d, so it
  // never takes more than half of the page's time.
  let last = -1;
  let freeAt = 0;
  function segment() {
    // segmentForVideo needs strictly increasing timestamps.
    const now = Math.max(performance.now(), last + 1);
    last = now;
    const result = seg.segmentForVideo(video, now);
    const mask = result.confidenceMasks?.[0];
    if (mask) {
      const conf = mask.getAsFloat32Array();
      if (maskCanvas.width !== mask.width || maskCanvas.height !== mask.height || !maskData) {
        maskCanvas.width = mask.width;
        maskCanvas.height = mask.height;
        maskData = maskCtx.createImageData(mask.width, mask.height);
      }
      const px = maskData.data;
      // Confidence → opacity, steepened so the edge neither halos nor eats hair.
      for (let i = 0; i < conf.length; i++) {
        const a = (conf[i] - 0.25) / 0.5;
        px[i * 4 + 3] = a <= 0 ? 0 : a >= 1 ? 255 : a * 255;
      }
      maskCtx.putImageData(maskData, 0, 0);
    }
    result.close?.();
  }

  function frame() {
    if (video.readyState < 2 || !video.videoWidth) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const start = performance.now();
    if (start >= freeAt || !maskData) {
      segment();
      freeAt = start + 2 * (performance.now() - start);
    }
    if (!maskData) return;

    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(video, 0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(maskCanvas, 0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-over';
    if (current?.image) cover(ctx, current.image, w, h);
    else {
      const f = current?.blur || 20;
      if (FILTER) {
        // Drawn a little larger: a blur fades out at the image's edges.
        ctx.filter = `blur(${f}px)`;
        ctx.drawImage(video, -2 * f, -2 * f, w + 4 * f, h + 4 * f);
        ctx.filter = 'none';
      } else {
        small.width = Math.max(8, Math.round(w / f));
        small.height = Math.max(8, Math.round(h / f));
        smallCtx.drawImage(video, 0, 0, small.width, small.height);
        ctx.drawImage(small, 0, 0, w, h);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  const ticker = new Worker('/js/ticker-worker.js');
  ticker.onmessage = () => {
    try {
      frame();
    } catch (err) {
      console.warn('background', err);
    }
  };
  ticker.postMessage(Math.round(1000 / FPS));
  frame();

  const track = canvas.captureStream(FPS).getVideoTracks()[0];
  // Same id as the camera's, so the device lists still show the camera.
  const settings = raw.getSettings();
  const getSettings = track.getSettings.bind(track);
  track.getSettings = () => ({ ...getSettings(), deviceId: settings.deviceId });

  return {
    track,
    set,
    stop() {
      ticker.terminate();
      track.stop();
      video.srcObject = null;
    },
  };
}
