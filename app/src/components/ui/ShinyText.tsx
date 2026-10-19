import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";

import "./ShinyText.css";

/** React Bits <ShinyText /> (JS variant) — a band of light sweeping across
 * text, drawn as a background gradient clipped to the glyphs. */

const EASINGS: Record<string, (t: number) => number> = {
  linear: (t) => t,
  smooth: (t) => 0.5 - Math.cos(Math.PI * t) / 2,
  snappy: (t) => (t < 0.5 ? 16 * Math.pow(t, 5) : 1 - Math.pow(-2 * t + 2, 5) / 2),
};
const TRIGGERS = ["loop", "hover", "view"];
const FALLOFF = [0, 0.2, 0.4, 0.6, 0.8, 1];

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

type RGB = [number, number, number, number];

let paint: CanvasRenderingContext2D | null = null;

const parseColor = (value: string): RGB | null => {
  if (typeof document === "undefined") return null;
  if (!paint) paint = document.createElement("canvas").getContext("2d");
  if (!paint) return null;
  paint.fillStyle = "#000000";
  paint.fillStyle = value;
  const resolved = String(paint.fillStyle);
  if (resolved.startsWith("#")) {
    return [1, 3, 5]
      .map((i) => parseInt(resolved.slice(i, i + 2), 16))
      .concat(1) as RGB;
  }
  const parts = resolved.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return null;
  return [
    Number(parts[0]),
    Number(parts[1]),
    Number(parts[2]),
    parts.length > 3 ? Number(parts[3]) : 1,
  ];
};

const blend = (from: RGB, to: RGB, amount: number) => {
  const channel = (a: number, b: number) =>
    Math.round(
      Math.pow(
        Math.pow(a / 255, 2.2) * (1 - amount) + Math.pow(b / 255, 2.2) * amount,
        1 / 2.2,
      ) * 255,
    );
  const alpha = from[3] * (1 - amount) + to[3] * amount;
  if (alpha <= 0) return "rgba(0, 0, 0, 0)";
  const weigh = (a: number, b: number) =>
    (a * from[3] * (1 - amount) + b * to[3] * amount) / alpha;
  const r = from[3] === to[3] ? channel(from[0], to[0]) : Math.round(weigh(from[0], to[0]));
  const g = from[3] === to[3] ? channel(from[1], to[1]) : Math.round(weigh(from[1], to[1]));
  const b = from[3] === to[3] ? channel(from[2], to[2]) : Math.round(weigh(from[2], to[2]));
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`;
};

export interface ShinyTextProps {
  /** The text to shine. Children work too. */
  text?: string;
  children?: React.ReactNode;
  /** Base color of the text. */
  color?: string;
  /** Color of the light passing over it. */
  shineColor?: string;
  /** Seconds for one sweep across the text. */
  speed?: number;
  /** Seconds of rest between sweeps. */
  delay?: number;
  /** Tilt of the band of light in degrees. */
  angle?: number;
  /** How wide the band of light is, as a percentage of the text. */
  shineWidth?: number;
  /** How gently the band fades at its edges, from 0 (crisp) to 1 (soft). */
  softness?: number;
  /** How many bands of light follow each other. */
  bands?: number;
  /** A soft bloom of light that travels with the band, from 0 to 1. */
  glow?: number;
  /** Which way the light travels. */
  direction?: "left" | "right";
  /** Feel of each sweep. */
  easing?: "smooth" | "linear" | "snappy";
  /** When it shines: on a loop, once each time the pointer enters, or once
   * when scrolled into view. */
  trigger?: "loop" | "hover" | "view";
  /** Sweeps back and forth instead of always starting from the same side. */
  yoyo?: boolean;
  /** While hovered, the light glides after the pointer. */
  followPointer?: boolean;
  /** Freezes the sweep while the pointer is over the text. */
  pauseOnHover?: boolean;
  /** Shows plain text with no shine. */
  disabled?: boolean;
  /** Extra class names for the root element. */
  className?: string;
  /** Inline styles for the root element. */
  style?: CSSProperties;
}

export function ShinyText({
  text,
  children,
  color = "#b5b5b5",
  shineColor = "#ffffff",
  speed = 2,
  delay = 0,
  angle = 120,
  shineWidth = 40,
  softness = 0.8,
  bands = 1,
  glow = 0,
  direction = "left",
  easing = "smooth",
  trigger = "loop",
  yoyo = false,
  followPointer = false,
  pauseOnHover = false,
  disabled = false,
  className = "",
  style,
}: ShinyTextProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const glowRef = useRef<HTMLSpanElement>(null);
  const settingsRef = useRef<Record<string, unknown> | null>(null);
  const syncRef = useRef<(() => void) | null>(null);
  const content = children ?? text;

  settingsRef.current = {
    color,
    shineColor,
    speed: Math.max(0.1, speed),
    delay: Math.max(0, delay),
    angle,
    shineWidth: clamp(shineWidth, 2, 200),
    softness: clamp(softness, 0, 1),
    bands: clamp(Math.round(bands), 1, 3),
    glow: clamp(glow, 0, 1),
    sign: direction === "right" ? 1 : -1,
    ease: EASINGS[easing] ?? EASINGS.smooth,
    trigger: TRIGGERS.includes(trigger) ? trigger : "loop",
    yoyo,
    followPointer,
    pauseOnHover,
    disabled,
  };

  useEffect(() => {
    syncRef.current?.();
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const s0 = settingsRef.current!;

    const reduce =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const state = {
      pos: null as number | null,
      vel: 0,
      phase: "idle",
      from: 0,
      to: 0,
      start: 0,
      duration: 1,
      resume: 0,
      flip: false,
      inside: false,
      target: 0,
      visible: true,
      seen: false,
      colors: "",
    };
    let base: RGB | null = null;
    let shine: RGB | null = null;
    let clear: RGB | null = null;
    let raf = 0;
    let timer = 0;
    let last = 0;
    let alive = true;

    const extent = () => {
      const s = settingsRef.current!;
      return (
        (s.shineWidth as number) / 2 +
        ((s.bands as number) - 1) * (s.shineWidth as number) * 1.3 +
        2
      );
    };
    const entry = () => ((s0.sign as number) > 0 ? -extent() : 100 + extent());
    const exit = () => ((s0.sign as number) > 0 ? 100 + extent() : -extent());
    const nearest = () => (state.target < 50 ? -extent() : 100 + extent());

    const gradient = (pos: number, fill: RGB) => {
      const s = settingsRef.current!;
      const half = (s.shineWidth as number) / 2;
      const core = half * (1 - (s.softness as number));
      const fade = half - core;
      const stops: [number, number][] = [];
      for (let band = 0; band < (s.bands as number); band++) {
        const center = pos - (s.sign as number) * band * (s.shineWidth as number) * 1.3;
        const strength = 1 - band * 0.28;
        for (const side of [-1, 1]) {
          for (const f of FALLOFF) {
            const at = center + side * (core + fade * (1 - f));
            const amount = f * f * (3 - 2 * f) * strength;
            stops.push([at, amount]);
          }
        }
      }
      stops.sort((a, b) => a[0] - b[0]);
      const list = stops
        .map(([at, amount]) => `${blend(fill, shine!, amount)} ${at.toFixed(2)}%`)
        .join(", ");
      return `linear-gradient(${s.angle as number}deg, ${blend(fill, shine!, 0)} 0%, ${list}, ${blend(fill, shine!, 0)} 100%)`;
    };

    const draw = () => {
      const s = settingsRef.current!;
      const key = `${s.color}|${s.shineColor}`;
      if (key !== state.colors) {
        state.colors = key;
        base = parseColor(s.color as string);
        shine = parseColor(s.shineColor as string);
        clear = shine ? ([shine[0], shine[1], shine[2], 0] as RGB) : null;
      }
      if (!base || !shine) {
        root.style.backgroundImage = `linear-gradient(${s.color}, ${s.color})`;
        return;
      }
      if (state.pos === null || s.disabled) {
        root.style.backgroundImage = `linear-gradient(${s.color}, ${s.color})`;
        if (glowRef.current) glowRef.current.style.backgroundImage = "none";
        return;
      }
      root.style.backgroundImage = gradient(state.pos, base);
      if (glowRef.current) {
        glowRef.current.style.backgroundImage = gradient(state.pos, clear!);
        glowRef.current.style.opacity = String(s.glow);
      }
    };

    const sweep = (from: number, to: number, now: number) => {
      const s = settingsRef.current!;
      const span = Math.abs(exit() - entry()) || 1;
      state.phase = "sweep";
      state.from = from;
      state.to = to;
      state.start = now;
      state.duration =
        (s.speed as number) * 1000 * Math.max(0.15, Math.abs(to - from) / span);
    };

    const wake = () => {
      if (raf || !alive) return;
      window.clearTimeout(timer);
      timer = 0;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };

    const tick = (now: number) => {
      raf = 0;
      if (!alive) return;
      const s = settingsRef.current!;
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      if (s.disabled) {
        state.pos = null;
        state.phase = "idle";
        draw();
        return;
      }
      const following = s.followPointer && state.inside;
      if (following) {
        if (state.pos === null) state.pos = nearest();
        const stiffness = 220;
        state.vel +=
          ((state.target - state.pos) * stiffness -
            state.vel * 2 * Math.sqrt(stiffness)) *
          dt;
        state.pos += state.vel * dt;
        state.phase = "follow";
        draw();
        raf = requestAnimationFrame(tick);
        return;
      }
      if (state.phase === "follow") {
        state.vel = 0;
        sweep(state.pos ?? nearest(), nearest(), now);
      }
      if (state.phase === "sweep") {
        if (s.pauseOnHover && state.inside) {
          state.start += dt * 1000;
          raf = requestAnimationFrame(tick);
          return;
        }
        const t = clamp((now - state.start) / state.duration, 0, 1);
        state.pos = state.from + (state.to - state.from) * (s.ease as (t: number) => number)(t);
        draw();
        if (t < 1) {
          raf = requestAnimationFrame(tick);
          return;
        }
        if (s.trigger !== "loop" || reduce) {
          state.phase = "idle";
          state.pos = null;
          draw();
          return;
        }
        state.phase = "wait";
        state.resume = now + (s.delay as number) * 1000;
      }
      if (state.phase === "wait") {
        if (!state.visible) return;
        if (now < state.resume) {
          window.clearTimeout(timer);
          timer = window.setTimeout(wake, state.resume - now);
          return;
        }
        if (s.yoyo) {
          state.flip = !state.flip;
          sweep(
            state.flip ? exit() : entry(),
            state.flip ? entry() : exit(),
            now,
          );
        } else {
          sweep(entry(), exit(), now);
        }
        raf = requestAnimationFrame(tick);
        return;
      }
      if (
        state.phase === "idle" &&
        s.trigger === "loop" &&
        !reduce &&
        state.visible
      ) {
        state.flip = false;
        sweep(entry(), exit(), now);
        raf = requestAnimationFrame(tick);
      }
    };

    const locate = (event: PointerEvent) => {
      const s = settingsRef.current!;
      const rect = root.getBoundingClientRect();
      const radians = ((s.angle as number) * Math.PI) / 180;
      const dx = Math.sin(radians);
      const dy = -Math.cos(radians);
      const length = Math.abs(rect.width * dx) + Math.abs(rect.height * dy) || 1;
      const along =
        (event.clientX - rect.left - rect.width / 2) * dx +
        (event.clientY - rect.top - rect.height / 2) * dy;
      return 50 + (along / length) * 100;
    };

    const onEnter = (event: PointerEvent) => {
      const s = settingsRef.current!;
      state.inside = true;
      state.target = locate(event);
      if (s.disabled) return;
      if (s.followPointer) {
        if (state.pos === null) state.pos = nearest();
      } else if (s.trigger === "hover" && state.phase === "idle" && !reduce) {
        sweep(entry(), exit(), performance.now());
      }
      wake();
    };
    const onMove = (event: PointerEvent) => {
      state.target = locate(event);
      if (settingsRef.current!.followPointer) wake();
    };
    const onLeave = () => {
      state.inside = false;
      wake();
    };

    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((item) => item.isIntersecting);
      state.visible = visible;
      const s = settingsRef.current!;
      if (!visible) return;
      if (s.trigger === "view" && !state.seen && !reduce && !s.disabled) {
        state.seen = true;
        sweep(entry(), exit(), performance.now());
      }
      wake();
    });
    observer.observe(root);

    root.addEventListener("pointerenter", onEnter);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);

    syncRef.current = () => {
      const s = settingsRef.current!;
      if (s.disabled) {
        state.pos = null;
        state.phase = "idle";
      } else if (s.trigger !== "loop" && state.phase === "wait") {
        state.phase = "idle";
        state.pos = null;
      }
      draw();
      wake();
    };
    draw();
    wake();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      observer.disconnect();
      root.removeEventListener("pointerenter", onEnter);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      syncRef.current = null;
    };
    // The effect intentionally runs once; prop changes flow through
    // settingsRef via the sync effect above.
  }, []);

  return (
    <span
      ref={rootRef}
      className={`shiny-text${className ? ` ${className}` : ""}`}
      style={{ backgroundImage: `linear-gradient(${color}, ${color})`, ...style }}
    >
      {content}
      {glow > 0 ? (
        <span ref={glowRef} className="shiny-text__glow" aria-hidden="true">
          {content}
        </span>
      ) : null}
    </span>
  );
}

export default ShinyText;
