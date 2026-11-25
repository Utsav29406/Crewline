import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

// Run detection back-to-back: a blink lasts only 100–250 ms, so every frame counts.
const FRAME_INTERVAL_MS = 0;
const SAMPLE_GAP_MS = 700;
const CHALLENGE_MS = 20_000; // the gestures have to be done within this
const LOST_MS = 800; // the face may drop out of detection this long (a turned head can) before the scan restarts
const MAX_JUMP = 0.35; // a face box moving more than this share of its width between frames was swapped

/**
 * Opens the camera and waits for exactly one centred face. It takes a first scan, asks for two random gestures
 * (blink, turn left, turn right) that a photo or a pre-recorded video can't follow, then takes the remaining scans
 * facing the camera. The same face has to stay in view the whole time: losing it, a second face, or a sudden jump
 * (a photo swapped in) starts again with new gestures. Returns `samples` descriptors.
 */
export default function FaceCapture({ samples = 3, onCapture, onCancel, actionLabel = 'Verify' }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [phase, setPhase] = useState('loading'); // loading | searching | challenge | capturing | done | error
  const [message, setMessage] = useState('Loading face models…');
  const [faceOk, setFaceOk] = useState(false);
  const [captured, setCaptured] = useState(0);
  const [eyeOpenness, setEyeOpenness] = useState(1);
  const [stepInfo, setStepInfo] = useState(null); // { index, total, step }
  const onCaptureRef = useRef(onCapture);
  onCaptureRef.current = onCapture;

  useEffect(() => {
    let stream;
    let stopped = false;
    let timer;
    let face; // face.js (and TensorFlow) is loaded lazily to keep the main bundle small
    let steps = [];
    let challenge = null;
    let started = 0; // when the current attempt began (0 = waiting for a face)
    let passed = false;
    let lastSeen = 0;
    let lastBox = null;
    let descriptors = [];
    let lastSample = 0;
    let note = '';
    let pausedUntil = 0; // after a restart, show why for a moment before scanning again

    const restart = (why) => {
      started = 0;
      passed = false;
      lastBox = null;
      descriptors = [];
      steps = face.pickChallenge();
      challenge = face.createChallenge(steps);
      note = why || '';
      pausedUntil = why ? Date.now() + 1800 : 0;
      if (why) setMessage(why);
      setCaptured(0);
      setStepInfo(null);
      setPhase('searching');
    };

    const drawBox = (box) => {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!box) return;
      ctx.strokeStyle = passed ? '#3ccf7f' : '#a5b4fc';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.width, box.height, 16);
      ctx.stroke();
    };

    const take = async (video) => {
      const d = await face.describeFace(video);
      if (stopped || !d) return false;
      descriptors.push(d);
      lastSample = Date.now();
      if (!face.samePerson(descriptors)) {
        restart('A different face appeared. Starting again.');
        return false;
      }
      setCaptured(descriptors.length);
      return true;
    };

    const tick = async () => {
      if (stopped) return;
      const video = videoRef.current;
      try {
        const faces = await face.detectFaces(video, !passed);
        if (stopped) return;
        const now = Date.now();
        if (faces.length > 1) {
          drawBox(null);
          setFaceOk(false);
          if (started) restart('Another face came into view. Starting again.');
          setMessage('Multiple faces detected — only you should be in frame');
        } else if (!faces.length) {
          drawBox(null);
          setFaceOk(false);
          if (started && now - lastSeen > LOST_MS) restart('Lost your face. Starting again with new gestures.');
          if (!started) setMessage(now < pausedUntil ? note : 'Position your face inside the circle');
        } else {
          const { detection, landmarks } = faces[0];
          const box = detection.box;
          const cx = (box.x + box.width / 2) / video.videoWidth;
          const sizeRatio = box.width / video.videoWidth;
          const jumped = lastBox && (
            Math.hypot(box.x + box.width / 2 - (lastBox.x + lastBox.width / 2), box.y + box.height / 2 - (lastBox.y + lastBox.height / 2)) > MAX_JUMP * lastBox.width
            || Math.abs(box.width / lastBox.width - 1) > MAX_JUMP);
          lastBox = box;
          lastSeen = now;
          drawBox(box);
          if (started && jumped) {
            restart('The picture changed suddenly. Starting again.');
          } else if (!started && now < pausedUntil) {
            setFaceOk(false);
            setMessage(note);
          } else if (sizeRatio < 0.22) {
            setFaceOk(false);
            setMessage('Move a little closer');
          } else if (!started && (cx < 0.3 || cx > 0.7)) {
            setFaceOk(false);
            setMessage('Centre your face in the circle');
          } else {
            setFaceOk(true);
            const signals = face.livenessSignals(landmarks);
            if (!started) {
              // The first scan comes before the gestures, so the face that does them is the one that was scanned.
              started = now;
              setPhase('capturing');
              setMessage('Hold still…');
              if (!(await take(video))) { if (!stopped && started) restart(); }
              else setPhase('challenge');
            } else if (!passed) {
              const live = challenge(signals);
              setEyeOpenness(live.eyeOpenness);
              setStepInfo({ index: live.index, total: steps.length, step: live.step });
              if (live.failed) restart('Wrong way. Starting again with new gestures.');
              else if (now - started > CHALLENGE_MS) restart('Took too long. Starting again with new gestures.');
              else if (live.done) {
                passed = true;
                setStepInfo(null);
                setMessage('Gestures done');
              } else {
                setMessage(live.ready ? face.GESTURES[live.step] : 'Look straight at the camera');
              }
            } else if (!challenge(signals).facing) {
              setMessage('Look straight at the camera');
            } else if (now - lastSample > SAMPLE_GAP_MS) {
              setPhase('capturing');
              setMessage('Hold still…');
              if (await take(video) && descriptors.length >= samples) {
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
          }),
        ]);
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        const video = videoRef.current;
        video.srcObject = s;
        await video.play();
        restart();
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
            <Icon name={phase === 'error' ? 'alert' : phase === 'done' ? 'check' : stepInfo?.step === 'blink' ? 'eye' : 'face'} />
          )}
          <span style={{ flex: 1 }}>
            {stepInfo && <b>Step {stepInfo.index + 1} of {stepInfo.total}: </b>}{message}
          </span>
          {phase === 'challenge' && stepInfo?.step === 'blink' && (
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
        <span>Only a numeric face signature is sent — no photo is stored. {actionLabel} asks for two random gestures; follow them on screen.</span>
      </div>
      {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
    </div>
  );
}
