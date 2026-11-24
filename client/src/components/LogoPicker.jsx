import { useRef, useState } from 'react';
import Icon from './Icon.jsx';

const MAX_SIDE = 320;
const MAX_BYTES = 200 * 1024;

/** Reads an image file and shrinks it to fit 320×320, so logos stay small enough to store. */
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That file isn't an image we can read"));
      i.src = url;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth || MAX_SIDE, img.naturalHeight || MAX_SIDE));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((img.naturalWidth || MAX_SIDE) * scale));
    canvas.height = Math.max(1, Math.round((img.naturalHeight || MAX_SIDE) * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const [type, q] of [['image/png'], ['image/webp', 0.92], ['image/webp', 0.75], ['image/jpeg', 0.8]]) {
      const data = canvas.toDataURL(type, q);
      if (data.startsWith(`data:${type}`) && data.length * 0.75 <= MAX_BYTES) return data;
    }
    throw new Error('That image is too detailed to use as a logo. Try a simpler PNG.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Square logo preview with upload / remove. `value` is a data URL or image URL; `onChange` gets a data URL or null. */
export default function LogoPicker({ value, onChange, disabled, busy, onError }) {
  const input = useRef(null);
  const [reading, setReading] = useState(false);
  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setReading(true);
    try {
      onChange(await shrink(file));
    } catch (err) {
      onError?.(err.message);
    } finally {
      setReading(false);
    }
  };
  const working = busy || reading;
  return (
    <div className="logo-picker">
      <div className="logo-preview">{value ? <img src={value} alt="Company logo" /> : <Icon name="image" size={24} />}</div>
      <div className="stack" style={{ gap: 8, minWidth: 0 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          <button type="button" className="btn btn-sm" disabled={disabled || working} onClick={() => input.current?.click()}>
            {working ? <span className="spin" /> : <Icon name="image" size={15} />} {value ? 'Change logo' : 'Upload logo'}
          </button>
          {value && (
            <button type="button" className="btn btn-sm" disabled={disabled || working} onClick={() => onChange(null)}>
              <Icon name="trash" size={15} /> Remove
            </button>
          )}
        </div>
        <div className="small muted">PNG, JPG, WebP or SVG. A square image on a transparent background looks best.</div>
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden onChange={pick} />
    </div>
  );
}
