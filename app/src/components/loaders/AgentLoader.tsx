"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/utils";

export type LoaderType =
  | "braille"
  | "orbit"
  | "breathe"
  | "snake"
  | "fill-sweep"
  | "fill"
  | "pulse"
  | "columns"
  | "checkerboard"
  | "scan"
  | "rain"
  | "cascade"
  | "sparkle"
  | "wave-rows"
  | "helix"
  | "diagonal-swipe"
  | "idle"
  | "error";

interface AgentLoaderProps {
  className?: string;
  dotClassName?: string;
  type?: LoaderType;
}

const getOpacities = (type: LoaderType, i: number): number | number[] => {
  const OFF = 0.15;
  const ON = 1;
  const row = Math.floor(i / 3);
  const col = i % 3;

  switch (type) {
    case "orbit": {
      const path = [0, 1, 2, 5, 8, 7, 6, 3];
      if (i === 4) {
        return [OFF, OFF];
      }
      const idx = path.indexOf(i);
      const frames = Array.from({ length: 8 }, (_, f) => {
        const dist = (f - idx + 8) % 8;
        if (dist === 0) {
          return ON;
        }
        if (dist === 1) {
          return 0.5;
        }
        return OFF;
      });
      return [...frames, frames[0]];
    }
    case "braille": {
      const path = [0, 1, 3, 5, 7, 6, 4, 2];
      const idx = path.indexOf(i);
      const frames = Array.from({ length: 8 }, (_, f) => {
        const dist = (f - idx + 8) % 8;
        if (dist === 0) {
          return ON;
        }
        if (dist === 1) {
          return 0.5;
        }
        return OFF;
      });
      return [...frames, frames[0]];
    }
    case "snake": {
      const path = [0, 1, 2, 5, 4, 3, 6, 7, 8, 7, 6, 3, 4, 5, 2, 1];
      const frames = Array.from({ length: 16 }, (_, f) => {
        if (path[f] === i) {
          return ON;
        }
        if (path[(f - 1 + 16) % 16] === i) {
          return 0.5;
        }
        return OFF;
      });
      return [...frames, frames[0]];
    }
    case "fill-sweep": {
      const frames = Array.from({ length: 6 }, (_, s) =>
        s >= col && s <= col + 2 ? ON : OFF
      );
      return [...frames, frames[0]];
    }
    // The "Writing" loader from the /loaders gallery: every square holds
    // dim until its turn, then fills to full — the grid reads as one
    // progress sweep over the whole cycle.
    case "fill": {
      return [OFF, OFF, ON, ON];
    }
    case "diagonal-swipe": {
      const dist = row + col;
      const frames = Array.from({ length: 10 }, (_, s) =>
        s >= dist && s <= dist + 4 ? ON : OFF
      );
      return [...frames, frames[0]];
    }
    case "pulse": {
      const isCenter = i === 4;
      return [isCenter ? ON : OFF, isCenter ? OFF : ON, isCenter ? ON : OFF];
    }
    case "columns": {
      return [
        col === 0 ? ON : OFF,
        col === 1 ? ON : OFF,
        col === 2 ? ON : OFF,
        col === 0 ? ON : OFF,
      ];
    }
    case "wave-rows": {
      return [
        row === 0 ? ON : OFF,
        row === 1 ? ON : OFF,
        row === 2 ? ON : OFF,
        row === 0 ? ON : OFF,
      ];
    }
    case "checkerboard": {
      const isEven = i % 2 === 0;
      return [isEven ? ON : OFF, isEven ? OFF : ON, isEven ? ON : OFF];
    }
    case "scan": {
      return [
        row === 0 ? ON : OFF,
        row === 1 ? ON : OFF,
        row === 2 ? ON : OFF,
        row === 1 ? ON : OFF,
        row === 0 ? ON : OFF,
      ];
    }
    case "helix": {
      const path = [0, 1, 2, 5, 8, 7, 6, 3];
      if (i === 4) {
        return [OFF, OFF];
      }
      const idx = path.indexOf(i);
      const frames = Array.from({ length: 8 }, (_, f) => {
        if (f === idx || (f + 4) % 8 === idx) {
          return ON;
        }
        return OFF;
      });
      return [...frames, frames[0]];
    }
    case "rain":
      return [OFF, ON, OFF, OFF, OFF];
    // idle.html / error.html are STATIC marks — a plain value (not a
    // keyframe array) so motion runs no animation at all. Idle is dim,
    // like the gallery's #666 grid.
    case "idle":
      return 0.45;
    case "error":
      return 1;
    case "breathe":
    case "cascade":
    case "sparkle":
    default:
      return [OFF, ON, OFF];
  }
};

const getTransition = (type: LoaderType, i: number): any => {
  const linear = { ease: "linear", repeat: Number.POSITIVE_INFINITY };
  const row = Math.floor(i / 3);
  const col = i % 3;

  switch (type) {
    case "breathe": {
      const dist = i === 4 ? 0 : i % 2 === 1 ? 1 : 2;
      return {
        duration: 2,
        repeat: Number.POSITIVE_INFINITY,
        delay: dist * 0.2,
        ease: "easeInOut",
      };
    }
    case "rain": {
      const colDelay = [0, 0.4, 0.2][col];
      return {
        duration: 1.2,
        repeat: Number.POSITIVE_INFINITY,
        delay: row * 0.2 + colDelay,
        ease: "linear",
      };
    }
    case "cascade": {
      const dist = row + col;
      return {
        duration: 1.5,
        repeat: Number.POSITIVE_INFINITY,
        delay: dist * 0.2,
        ease: "easeInOut",
      };
    }
    case "sparkle": {
      const delay = (i * 7) % 2;
      const duration = 0.8 + (i % 3) * 0.2;
      return {
        duration,
        repeat: Number.POSITIVE_INFINITY,
        delay,
        ease: "easeInOut",
      };
    }
    case "pulse":
      return {
        duration: 1.5,
        repeat: Number.POSITIVE_INFINITY,
        ease: "easeInOut",
      };
    case "snake":
      return { duration: 2, ...linear };
    case "orbit":
    case "helix":
      return { duration: 1.2, ...linear };
    case "fill-sweep":
      return { duration: 1.2, ...linear };
    case "fill":
      // One square at a time across a 2.4 s cycle — mirrors the gallery's
      // writing.html keyframes exactly (hold dim, ramp to full, hold).
      return {
        duration: 2.4,
        times: [0, i / 9, (i + 1) / 9, 1],
        ...linear,
      };
    case "diagonal-swipe":
      return { duration: 1.5, ...linear };
    case "columns":
    case "wave-rows":
      return { duration: 1.2, ...linear };
    case "checkerboard":
      return { duration: 1.5, ...linear };
    case "scan":
      return { duration: 1.5, ...linear };
    case "braille":
      return { duration: 1.2, ...linear };
    // Static marks: nothing repeats, nothing moves.
    case "idle":
    case "error":
      return { duration: 0 };
    default:
      return { duration: 1, ...linear };
  }
};

export function AgentLoader({
  type = "orbit",
  className,
  dotClassName,
}: AgentLoaderProps) {
  const isBraille = type === "braille";
  const dotsCount = isBraille ? 8 : 9;
  const cols = isBraille ? 2 : 3;

  return (
    <div
      // REMOUNT on pattern change: patterns with identical keyframes but
      // different timing (cascade vs sparkle) would otherwise keep the old
      // animation's rhythm — motion never restarts unchanged keyframes.
      key={type}
      className={cn("grid gap-[2px]", className)}
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
    >
      {Array.from({ length: dotsCount }).map((_, i) => {
        const opacities = getOpacities(type, i);
        const transition = getTransition(type, i);

        return (
          <motion.div
            animate={{ opacity: opacities }}
            className={cn(
              "h-1 w-1 bg-current",
              // error.html: a red X from the even cells, dim gray fills.
              type === "error" &&
                (i % 2 === 0
                  ? "bg-[#f04444] shadow-[0_0_5px_rgba(240,68,68,0.45)]"
                  : "bg-[#3b3b3b]"),
              dotClassName,
            )}
            key={i}
            transition={transition}
          />
        );
      })}
    </div>
  );
}
