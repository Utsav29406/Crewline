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
const TURN_RANGE = 0.22; // nose must sweep this far across the eye span…
const TURN_SIDE = 0.06; // …reaching at least this far past centre on both sides

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

/**
 * Feed it livenessSignals() once per frame. Passes on either a blink or a left-right head turn.
 * "Open" is a rolling 75th percentile, so a blink cannot drag its own reference down.
 */
export function createLivenessDetector() {
  let history = [];
  let closedAt = null;
  return ({ ear, yaw }, now = performance.now()) => {
    history.push({ t: now, ear, yaw });
    history = history.filter((h) => now - h.t <= WINDOW_MS);
    const ready = history.length >= 3;
    const open = ready ? percentile(history.map((h) => h.ear), 0.75) : ear;
    const result = { passed: false, method: null, eyeOpenness: Math.max(0, Math.min(1, ear / open)) };
    if (!ready) return result;

    if (closedAt === null && ear <= open * (1 - BLINK_DROP)) closedAt = now;
    else if (closedAt !== null && ear >= open * (1 - BLINK_RECOVER)) {
      const duration = now - closedAt;
      closedAt = null;
      if (duration <= BLINK_MAX_MS) return { ...result, passed: true, method: 'blink' };
    } else if (closedAt !== null && now - closedAt > BLINK_MAX_MS) closedAt = null;

    const yaws = history.map((h) => h.yaw);
    const centre = percentile(yaws, 0.5);
    const min = Math.min(...yaws), max = Math.max(...yaws);
    if (max - min >= TURN_RANGE && centre - min >= TURN_SIDE && max - centre >= TURN_SIDE) {
      return { ...result, passed: true, method: 'turn' };
    }
    return result;
  };
}
