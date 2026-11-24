import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

// Run detection back-to-back: a blink lasts only 100–250 ms, so every frame counts.
const FRAME_INTERVAL_MS = 0;
const SAMPLE_GAP_MS = 700;

/**
 * Opens the camera, waits for exactly one centred face, requires a liveness gesture
 * (a blink or a left-right head turn, against printed photos), then returns `samples` descriptors.
 */
export default function FaceCapture({ samples = 1, onCapture, onCancel, actionLabel = 'Verify' }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [phase, setPhase] = useState('loading'); // loading | searching | blink | capturing | done | error
  const [message, setMessage] = useState('Loading face models…');
  const [faceOk, setFaceOk] = useState(false);
  const [captured, setCaptured] = useState(0);
  const [eyeOpenness, setEyeOpenness] = useState(1);
  const onCaptureRef = useRef(onCapture);
  onCaptureRef.current = onCapture;

  useEffect(() => {
    let stream;
    let stopped = false;
    let timer;
    let face; // face.js (and TensorFlow) is loaded lazily to keep the main bundle small
    let checkLiveness;
    let blinked = false;
    let livenessStarted = 0;
    const descriptors = [];
    let lastSample = 0;

    const drawBox = (box) => {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!box) return;
      ctx.strokeStyle = blinked ? '#3ccf7f' : '#a5b4fc';
      ctx.lineWidth = 3;
      const r = 16;
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.width, box.height, r);
      ctx.stroke();
    };

    const tick = async () => {
      if (stopped) return;
      const video = videoRef.current;
      try {
        const faces = await face.detectFaces(video, !blinked);
        if (stopped) return;
        if (faces.length !== 1) {
          drawBox(null);
          setFaceOk(false);
          setMessage(faces.length ? 'Multiple faces detected — only you should be in frame' : 'Position your face inside the circle');
        } else {
          const { detection, landmarks } = faces[0];
          const box = detection.box;
          const cx = (box.x + box.width / 2) / video.videoWidth;
          const sizeRatio = box.width / video.videoWidth;
          drawBox(box);
          if (sizeRatio < 0.22) {
            setFaceOk(false);
            setMessage('Move a little closer');
          } else if (cx < 0.3 || cx > 0.7) {
            setFaceOk(false);
            setMessage('Centre your face in the circle');
          } else {
            setFaceOk(true);
            if (!blinked) {
              livenessStarted ||= Date.now();
              setPhase('blink');
              const live = checkLiveness(face.livenessSignals(landmarks));
              setEyeOpenness(live.eyeOpenness);
              if (live.passed) {
                blinked = true;
                setMessage(live.method === 'blink' ? 'Blink detected' : 'Head turn detected');
              } else {
                setMessage(Date.now() - livenessStarted > 5000
                  ? 'Blink once, or slowly turn your head left and right'
                  : 'Liveness check: please blink');
              }
            } else if (Date.now() - lastSample > SAMPLE_GAP_MS) {
              setPhase('capturing');
              setMessage(samples > 1 ? 'Hold still — slowly turn your head a little' : 'Hold still…');
              const d = await face.describeFace(video);
              if (stopped) return;
              if (d) {
                descriptors.push(d);
                lastSample = Date.now();
                setCaptured(descriptors.length);
                if (descriptors.length >= samples) {
                  setPhase('done');
                  setMessage('Face captured');
                  stopped = true;
                  stream?.getTracks().forEach((t) => t.stop());
                  onCaptureRef.current(descriptors);
                  return;
                }
              }
            }
          }
        }
      } catch (err) {
        console.error(err);
      }
      timer = setTimeout(tick, FRAME_INTERVAL_MS);
    };

    let failed = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera requires HTTPS or localhost');
        // Keep the camera stream as soon as it opens, so it is stopped even if loading the face models fails.
        const camera = navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
          .then((opened) => { stream = opened; if (stopped || failed) opened.getTracks().forEach((t) => t.stop()); return opened; });
        const [s] = await Promise.all([
          camera,
          import('../face.js').then(async (mod) => {
            await mod.loadModels();
            face = mod;
            checkLiveness = mod.createLivenessDetector();
          }),
        ]);
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        const video = videoRef.current;
        video.srcObject = s;
        await video.play();
        setPhase('searching');
        setMessage('Position your face inside the circle');
        tick();
      } catch (err) {
        // The models may fail before the camera opens: the flag makes the camera close as soon as it does.
        failed = true;
        stream?.getTracks().forEach((t) => t.stop());
        setPhase('error');
        setMessage(err.name === 'NotAllowedError' ? 'Camera permission denied' : err.message || 'Could not start camera');
      }
    })();

    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [samples]);

  return (
    <div className="stack">
      <div className="camera">
        <video ref={videoRef} playsInline muted />
        <canvas ref={canvasRef} />
        <div className={`camera-ring ${faceOk ? 'ok' : ''}`} />
        <div className="camera-status">
          {phase === 'loading' || phase === 'capturing' ? <span className="spin" /> : (
            <Icon name={phase === 'error' ? 'alert' : phase === 'done' ? 'check' : phase === 'blink' ? 'eye' : 'face'} />
          )}
          <span style={{ flex: 1 }}>{message}</span>
          {phase === 'blink' && (
            <span className="eye-meter" title="Eye openness — dips when you blink">
              <span style={{ height: `${Math.round(eyeOpenness * 100)}%` }} />
            </span>
          )}
        </div>
      </div>
      {samples > 1 && (
        <div>
          <div className="row small muted" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <span>Samples captured</span>
            <span className="tnum">{captured} / {samples}</span>
          </div>
          <div className="progress"><span style={{ width: `${(captured / samples) * 100}%` }} /></div>
        </div>
      )}
      <div className="row small muted">
        <Icon name="shield" size={16} />
        <span>Only a numeric face signature is sent — no photo is stored. {actionLabel} needs a blink or a head turn.</span>
      </div>
      {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
    </div>
  );
}
