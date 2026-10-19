import type { StreamSegment } from "@/types";
import { ShinyText } from "@/components/ui/ShinyText";
import { AgentLoader } from "./AgentLoader";
import {
  currentPhase,
  labelFor,
  phaseVerb,
  verbLoader,
  type LoaderBrain,
} from "./phases";
import { cn } from "@/lib/utils";

interface StreamStatusProps {
  /** The live stream of the displayed conversation — null means nothing
   * is happening, which shows Idle. */
  stream: { thinking: string; segments: StreamSegment[] } | null;
  /** Where the reply comes from — a server model shows Connecting... while
   * the request is in flight; defaults to a CLI brain. */
  brain?: LoaderBrain;
  className?: string;
  dotClassName?: string;
}

/** The status line pinned above the composer (issue #23): a small
 * dot-matrix loader plus a fixed label that follows what the model is
 * doing right now — Connecting, Thinking, Reading, Searching, Writing,
 * Generating… — with Discombobulating everywhere else and Idle when
 * nothing is going on. The label only changes when the phase changes.
 * Issue #24: the label is a ShinyText — a band of light sweeps the
 * glyphs while work is happening; Idle stays plain. */
export function StreamStatus({
  stream,
  brain = "cli",
  className,
  dotClassName,
}: StreamStatusProps) {
  const phase = stream === null ? { kind: "idle" as const } : currentPhase(stream, brain);
  const verb = phaseVerb(phase);
  const label = labelFor(verb);
  const working = phase.kind !== "idle";

  return (
    <div
      className={cn("flex items-center gap-2 text-muted-foreground", className)}
      role="status"
    >
      <AgentLoader type={verbLoader(verb)} dotClassName={dotClassName} />
      {/* The key remounts the label on change — the fade-in IS the crossfade. */}
      <ShinyText
        key={label}
        text={label}
        color="#5d5d5d"
        shineColor="#ffffff"
        speed={1.5}
        shineWidth={60}
        softness={0.8}
        trigger="loop"
        delay={2}
        angle={90}
        direction="right"
        // Idle stays plain — the shine belongs to work in progress.
        disabled={!working}
        className="text-xs italic"
      />
    </div>
  );
}
