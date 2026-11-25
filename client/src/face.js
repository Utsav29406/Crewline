import * as faceapi from '@vladmandic/face-api';

const MODEL_URL = '/models';
let modelsPromise;

export function loadModels() {
  modelsPromise ||= Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ]).catch((err) => {
    modelsPromise = null;
    throw err;
  });
  return modelsPromise;
}

const detectorOptions = (inputSize = 320) => new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.5 });

/** All faces with landmarks. `fast` trades a little detection range for frame rate during the liveness check. */
export const detectFaces = (video, fast = false) =>
  faceapi.detectAllFaces(video, detectorOptions(fast ? 224 : 320)).withFaceLandmarks();

/** Single face with its 128-d descriptor, or undefined. */
export async function describeFace(video) {
  const result = await faceapi.detectSingleFace(video, detectorOptions()).withFaceLandmarks().withFaceDescriptor();
  return result ? Array.from(result.descriptor) : undefined;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Eye aspect ratio (Soukupová & Čech): drops when the eye closes. */
function eyeAspectRatio(eye) {
  return (dist(eye[1], eye[5]) + dist(eye[2], eye[4])) / (2 * dist(eye[0], eye[3]));
}

/**
 * Per-frame liveness signals from 68-point landmarks:
 *  - ear: average eye aspect ratio
 *  - yaw: where the nose tip sits between the outer eye corners (≈0.5 facing the camera).
 *    A flat photo keeps this ratio constant however it is tilted, so a change means a real 3-D head.
 */
export function livenessSignals(landmarks) {
  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();
  const noseTip = landmarks.getNose()[3];
  const span = rightEye[3].x - leftEye[0].x;
  return {
    ear: (eyeAspectRatio(leftEye) + eyeAspectRatio(rightEye)) / 2,
    yaw: span ? (noseTip.x - leftEye[0].x) / span : 0.5,
  };
}

const WINDOW_MS = 3000;
const BLINK_DROP = 0.2; // eyes count as closed at 20% below the open level
const BLINK_RECOVER = 0.1; // and open again within 10% of it
const BLINK_MAX_MS = 700; // longer than this is a squint or looking down, not a blink
const FRONT = 0.06; // nose within this of its straight-ahead position counts as facing the camera
const TURN = 0.1; // a turn has to move the nose this far across the eye span

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

/** Blink detection. "Open" is a rolling 75th percentile, so a blink cannot drag its own reference down. */
function blinkDetector() {
  let history = [];
  let closedAt = null;
  return (ear, now) => {
    history.push({ t: now, ear });
    history = history.filter((h) => now - h.t <= WINDOW_MS);
    const open = history.length >= 3 ? percentile(history.map((h) => h.ear), 0.75) : ear;
    const openness = Math.max(0, Math.min(1, ear / open));
    let blinked = false;
    if (history.length < 3) return { blinked, openness };
    if (closedAt === null && ear <= open * (1 - BLINK_DROP)) closedAt = now;
    else if (closedAt !== null && ear >= open * (1 - BLINK_RECOVER)) {
      blinked = now - closedAt <= BLINK_MAX_MS;
      closedAt = null;
    } else if (closedAt !== null && now - closedAt > BLINK_MAX_MS) closedAt = null;
    return { blinked, openness };
  };
}

/** What each gesture asks. Arrows point the way the (mirrored) preview moves. */
export const GESTURES = {
  blink: 'Blink once',
  left: '← Turn your head to your left',
  right: 'Turn your head to your right →',
};

/** Two different gestures in a random order, so a recorded video can't know what it will be asked. */
export function pickChallenge() {
  const all = Object.keys(GESTURES);
  const r = crypto.getRandomValues(new Uint32Array(all.length));
  return all.map((g, i) => [r[i], g]).sort((a, b) => a[0] - b[0]).slice(0, 2).map(([, g]) => g);
}

/**
 * Feed it livenessSignals() once per frame; it walks through `steps` in order.
 * Each gesture has to start from facing the camera. Turning the wrong way fails the challenge,
 * so a video that just shakes its head can't pass. In the raw camera image, turning to your own
 * left moves the nose towards the image's right, which raises `yaw`.
 */
export function createChallenge(steps) {
  const blink = blinkDetector();
  const firstYaws = [];
  let front = null;
  let index = 0;
  let armed = false;
  return ({ ear, yaw }, now = performance.now()) => {
    const { blinked, openness } = blink(ear, now);
    if (front === null) {
      firstYaws.push(yaw);
      if (firstYaws.length >= 5) front = percentile(firstYaws, 0.5);
      return { ready: false, index, step: steps[index], done: false, failed: false, facing: false, eyeOpenness: openness };
    }
    const off = yaw - front;
    const facing = Math.abs(off) < FRONT;
    let failed = false;
    if (index < steps.length) {
      const step = steps[index];
      if (!armed) armed = facing;
      else if (step === 'blink') {
        if (blinked && facing) { index += 1; armed = false; }
      } else {
        const toward = step === 'left' ? off : -off;
        if (toward >= TURN) { index += 1; armed = false; }
        else if (-toward >= TURN) failed = true;
      }
    }
    return { ready: true, index, step: steps[index], done: index >= steps.length, failed, facing, eyeOpenness: openness };
  };
}

const SAME_PERSON = 0.5;
const euclid = (a, b) => Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0));
/** True when every scan looks like the same person (the server checks this too). */
export const samePerson = (list) => list.every((a, i) => list.every((b, j) => j <= i || euclid(a, b) <= SAME_PERSON));
