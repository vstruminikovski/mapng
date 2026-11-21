// Steering wheel (drag with mouse or finger), keyboard, and on-screen pedals.
// Keys: W/↑ gas, S/↓ brake (hold at standstill → reverse), A/D or ←/→ steer,
// Space handbrake, R reset to start, C camera.

import type { DriveInput } from '../physics/vehicle';

type Act = 'gas' | 'brake' | 'hand' | 'reset' | 'cam';

const WHEEL_MAX = (135 * Math.PI) / 180; // lock-to-lock 270°, ±135° from centre
const KEY_RATE = 2.5; // wheel travel per second while a steer key is held (1 = full lock)
const RETURN_RATE = 3; // wheel springs back to centre per second

export class Controls {
  private keys = new Set<string>();
  private held = new Set<Act>();
  /** wheel position, −1 (full left) … +1 (full right) */
  private wheel = 0;
  private dragging = false;
  private wheelEl: HTMLElement;
  reverse = false;
  onReset?: () => void;
  onCamera?: () => void;

  constructor(root: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyR') this.onReset?.();
      if (e.code === 'KeyC') this.onCamera?.();
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.wheelEl = this.buildWheel(root);
    this.buildPedals(root);
  }

  private buildWheel(root: HTMLElement): HTMLElement {
    const el = document.createElement('div');
    el.className = 'mg-wheel';
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', 'Steering wheel');
    el.innerHTML = `<svg viewBox="-50 -50 100 100" aria-hidden="true">
      <circle r="42" fill="none" stroke="currentColor" stroke-width="5"/>
      <path d="M-42 0 H-14 M14 0 H42 M0 -6 V42" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/>
      <circle r="9" fill="currentColor"/>
      <path d="M0 -42 V-28" stroke="#0071e3" stroke-width="5" stroke-linecap="round"/>
    </svg>`;
    root.appendChild(el);
    const centre = () => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    let last = 0;
    const angleOf = (e: PointerEvent) => {
      const c = centre();
      return Math.atan2(e.clientY - c.y, e.clientX - c.x);
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* no active pointer to capture (synthetic events) */
      }
      this.dragging = true;
      last = angleOf(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const a = angleOf(e);
      let d = a - last;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      last = a;
      this.wheel = Math.max(-1, Math.min(1, this.wheel + d / WHEEL_MAX));
    });
    const end = () => (this.dragging = false);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    return el;
  }

  private buildPedals(root: HTMLElement) {
    const pad = document.createElement('div');
    pad.className = 'mg-touch';
    pad.innerHTML = `
      <div class="mg-col mg-tl"><button data-act="reset" aria-label="Reset">↺</button><button data-act="cam" aria-label="Camera">◎</button></div>
      <div class="mg-col mg-br"><button data-act="hand" aria-label="Handbrake">P</button><button data-act="brake" aria-label="Brake or reverse">■</button><button data-act="gas" aria-label="Gas">▲</button></div>`;
    root.appendChild(pad);
    for (const b of pad.querySelectorAll<HTMLButtonElement>('button')) {
      const act = b.dataset.act as Act;
      const down = (e: PointerEvent) => {
        e.preventDefault();
        try {
          b.setPointerCapture(e.pointerId); // keep the press even if the finger leaves the button
        } catch {
          /* no active pointer to capture: the press still counts */
        }
        if (act === 'reset') this.onReset?.();
        else if (act === 'cam') this.onCamera?.();
        else this.held.add(act);
      };
      const up = () => this.held.delete(act);
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('lostpointercapture', up);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  read(dt: number, speed: number): DriveInput {
    const k = (...c: string[]) => c.some((x) => this.keys.has(x));
    const h = (a: Act) => this.held.has(a);
    const thr = k('KeyW', 'ArrowUp') || h('gas') ? 1 : 0;
    const brk = k('KeyS', 'ArrowDown') || h('brake') ? 1 : 0;

    // keys turn the wheel; with no input it springs back to centre
    const dir = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0);
    if (dir !== 0) this.wheel += Math.max(-KEY_RATE * dt, Math.min(KEY_RATE * dt, dir - this.wheel));
    else if (!this.dragging) this.wheel += Math.max(-RETURN_RATE * dt, Math.min(RETURN_RATE * dt, -this.wheel));
    this.wheelEl.style.transform = `rotate(${(this.wheel * 135).toFixed(1)}deg)`;

    // S at standstill selects reverse; W at standstill selects drive
    if (Math.abs(speed) < 0.4) {
      if (brk && !thr) this.reverse = true;
      if (thr && !brk) this.reverse = false;
    }
    const throttle = this.reverse ? brk : thr;
    const brake = this.reverse ? thr : brk;
    return { throttle, brake, steer: this.wheel, handbrake: k('Space') || h('hand'), reverse: this.reverse };
  }
}
