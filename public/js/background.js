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

// The segmenter, loaded once. On the GPU it runs in a WebGL2 context of
// its own canvas, where the compositing shader (gpuCompositor) also draws:
// the mask never leaves the GPU. Without WebGL2 it runs on the CPU and a
// 2D canvas composites.
let segmenterLoad = null;
function segmenter() {
  segmenterLoad ||= (async () => {
    const { FilesetResolver, ImageSegmenter } = await import(`${BASE}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
    const make = (delegate, canvas) =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${BASE}/selfie_segmenter.tflite`, delegate },
        canvas,
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
    if (hardwareGl()) {
      try {
        const canvas = document.createElement('canvas');
        const seg = await make('GPU', canvas);
        const gl = canvas.getContext('webgl2');
        if (gl) return { seg, canvas, gpu: gpuCompositor(gl) };
        seg.close();
      } catch (err) {
        console.warn('background: no GPU', err);
      }
    }
    return { seg: await make('CPU') };
  })();
  segmenterLoad.catch(() => (segmenterLoad = null));
  return segmenterLoad;
}

// WebGL2 on a real GPU. A software one (SwiftShader, llvmpipe: no GPU, or
// a GPU the browser blocks) is slower than the CPU path.
function hardwareGl() {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return false;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
}

// Person over background in one pass: the camera frame, the confidence
// mask (bilinear by hand: float textures need not be filterable) and
// either a picture (cover-fit) or the frame's own mipmaps, sampled 5×5 at
// a coarse level, as the blur.
const VERTEX = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p, 0., 1.); }`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform sampler2D frame, mask, picture;
uniform bool blurred;
uniform float lod;
uniform vec2 cover;
float maskAt(vec2 t) {
  ivec2 size = textureSize(mask, 0);
  vec2 c = t * vec2(size) - .5;
  vec2 f = fract(c);
  ivec2 i = ivec2(floor(c));
  ivec2 hi = size - 1;
  float a = texelFetch(mask, clamp(i, ivec2(0), hi), 0).r;
  float b = texelFetch(mask, clamp(i + ivec2(1, 0), ivec2(0), hi), 0).r;
  float c2 = texelFetch(mask, clamp(i + ivec2(0, 1), ivec2(0), hi), 0).r;
  float d = texelFetch(mask, clamp(i + ivec2(1, 1), ivec2(0), hi), 0).r;
  return mix(mix(a, b, f.x), mix(c2, d, f.x), f.y);
}
void main() {
  vec3 person = texture(frame, uv).rgb;
  // Steepened so the edge neither halos nor eats hair.
  float m = smoothstep(.25, .75, maskAt(uv));
  vec3 back = vec3(0.);
  if (blurred) {
    vec2 step = exp2(lod) / vec2(textureSize(frame, 0));
    for (int x = -2; x <= 2; x++)
      for (int y = -2; y <= 2; y++) back += textureLod(frame, uv + vec2(x, y) * step, lod).rgb;
    back /= 25.;
  } else back = texture(picture, (uv - .5) * cover + .5).rgb;
  color = vec4(mix(back, person, m), 1.);
}`;

function gpuCompositor(gl) {
  const shader = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const at = (name) => gl.getUniformLocation(prog, name);
  const u = { blurred: at('blurred'), lod: at('lod'), cover: at('cover') };
  gl.useProgram(prog);
  gl.uniform1i(at('frame'), 0);
  gl.uniform1i(at('mask'), 1);
  gl.uniform1i(at('picture'), 2);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.useProgram(null);

  const texture = () => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  };
  const frameTex = texture();
  const pictureTex = texture();
  let picture = null;
  let pictureSize = [1, 1];

  // The segmenter uses the same context: every piece of state this pass
  // needs is set here, and the bindings are put back afterwards.
  return function draw(video, maskTex, back) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (gl.canvas.width !== w || gl.canvas.height !== h) {
      gl.canvas.width = w;
      gl.canvas.height = h;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    for (const cap of [gl.BLEND, gl.DEPTH_TEST, gl.SCISSOR_TEST, gl.CULL_FACE, gl.STENCIL_TEST]) gl.disable(cap);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, frameTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    // Mipmaps only for the blur (without them a mipmapped filter reads black).
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, back.blur ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    if (back.blur) gl.generateMipmap(gl.TEXTURE_2D);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, pictureTex);
    if (back.image && back.image !== picture) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, back.image);
      picture = back.image;
      pictureSize = [back.image.naturalWidth || back.image.width, back.image.naturalHeight || back.image.height];
    }
    gl.uniform1i(u.blurred, back.blur ? 1 : 0);
    gl.uniform1f(u.lod, back.blur > 10 ? 4.5 : 3);
    // Cover-fit: the picture's middle part with the frame's aspect.
    const frameAspect = w / h;
    const picAspect = pictureSize[0] / pictureSize[1];
    gl.uniform2f(u.cover, picAspect > frameAspect ? frameAspect / picAspect : 1, picAspect > frameAspect ? 1 : picAspect / frameAspect);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.useProgram(null);
    for (const unit of [gl.TEXTURE2, gl.TEXTURE1, gl.TEXTURE0]) {
      gl.activeTexture(unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  };
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
  const { seg, canvas: glCanvas, gpu } = await segmenter();
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([raw]);
  await video.play();

  // GPU: the segmenter's canvas is the output; CPU: a 2D canvas.
  const canvas = gpu ? glCanvas : document.createElement('canvas');
  const ctx = gpu ? null : canvas.getContext('2d');
  // The mask at the model's size; scaled up with smoothing, its edge is soft.
  const maskCanvas = document.createElement('canvas');
  const maskCtx = maskCanvas.getContext('2d');
  let maskData = null;
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

  // CPU: each tick draws a frame (cheap: the video stays fluid); the mask
  // is recomputed when there is time for it. On a slow device (no GPU) the
  // cut-out follows a little later, rather than the page freezing: after
  // a segmentation that took d ms the next waits at least another d, so it
  // never takes more than half of the page's time.
  let last = -1;
  let freeAt = 0;
  let drawFreeAt = 0;
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

  // GPU: segmentation and compositing in one go, the mask used where it
  // is (valid only inside the callback). A frame that took d ms makes the
  // next tick wait another d, so a slow GPU lowers the frame rate rather
  // than freezing the page.
  function gpuFrame() {
    if (video.readyState < 2 || !video.videoWidth || !current) return;
    const start = performance.now();
    if (start < freeAt) return;
    const now = Math.max(start, last + 1);
    last = now;
    seg.segmentForVideo(video, now, (result) => {
      const mask = result.confidenceMasks?.[0];
      if (mask) gpu(video, mask.getAsWebGLTexture(), current);
    });
    freeAt = start + 2 * (performance.now() - start);
  }

  function frame() {
    if (gpu) return gpuFrame();
    if (video.readyState < 2 || !video.videoWidth) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const start = performance.now();
    if (start < drawFreeAt) return;
    if (start >= freeAt || !maskData) {
      segment();
      freeAt = start + 2 * (performance.now() - start);
    }
    if (!maskData) return;
    const drawStart = performance.now();

    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(video, 0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(maskCanvas, 0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-over';
    if (current?.image) cover(ctx, current.image, w, h);
    else {
      // Without a GPU the canvas filter is far too slow: the frame drawn
      // small and stretched back up instead.
      const f = current?.blur || 20;
      small.width = Math.max(8, Math.round(w / f));
      small.height = Math.max(8, Math.round(h / f));
      smallCtx.drawImage(video, 0, 0, small.width, small.height);
      ctx.drawImage(small, 0, 0, w, h);
    }
    ctx.globalCompositeOperation = 'source-over';
    // The drawing itself (a blur without a GPU canvas is slow) is paced too.
    drawFreeAt = drawStart + 2 * (performance.now() - drawStart);
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
