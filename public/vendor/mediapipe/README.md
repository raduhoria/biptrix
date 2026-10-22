MediaPipe Tasks Vision (Google, Apache-2.0, see LICENSE):
@mediapipe/tasks-vision 1.1.1 — vision_bundle.mjs and
wasm/vision_wasm_internal.{js,wasm}. vision_bundle.mjs has two changes:
the source map comment removed, and its usage logging switched off (it
POSTs statistics to odml.pa.googleapis.com every minute; the CSP would
block it anyway): `flush(t,e){` → `flush(t,e){return void t?.();`. The no-SIMD
build is left out: every browser that can join a call has WebAssembly SIMD.
selfie_segmenter.tflite: the MediaPipe selfie segmentation model
(float16, storage.googleapis.com/mediapipe-models/image_segmenter/
selfie_segmenter/float16/latest).

sha256 vision_bundle.mjs              cc02a359ee97e4a1dbb71c65ba9d89faef2973e0e351890d63208942a832a597
sha256 wasm/vision_wasm_internal.js   6522286aa32dd93eff17c3da002b0649516f87abfec7a80b5bfe5c9625caa5f8
sha256 wasm/vision_wasm_internal.wasm 0e101a010e262ef8e78f22e3c95b60a9705fd06962753c9acd6356d9fb56b7bd
sha256 selfie_segmenter.tflite        191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b

Used by public/js/background.js (virtual backgrounds in calls), loaded
only when someone picks a background.
