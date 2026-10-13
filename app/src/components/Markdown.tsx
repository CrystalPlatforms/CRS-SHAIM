import { useRef, useState } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

import { cn } from "@/lib/utils";

/**
 * Rich message body: GFM markdown (headings, lists, tables, blockquotes,
 * links) with syntax-highlighted fenced code blocks that carry a copy
 * button. The copy reads `textContent`, which is exactly the raw code —
 * highlighting only wraps tokens in spans.
 */
export function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown-body space-y-2 text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_p]:whitespace-pre-wrap [&_pre]:m-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:w-full [&_table]:text-xs [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: CodeBlock,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const text = preRef.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions) — leave the button state alone.
    }
  };

  return (
    <div className="group relative my-2 overflow-hidden rounded-md border border-border bg-card">
      <button
        type="button"
        aria-label="Copy code"
        title="Copy code"
        onClick={copy}
        className="absolute right-1.5 top-1.5 z-10 rounded-md border border-border bg-background/80 p-1.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <pre
        ref={preRef}
        className="overflow-x-auto p-3 text-xs font-mono [&_code]:bg-transparent [&_code]:p-0"
      >
        {children}
      </pre>
    </div>
  );
}

/**
 * "Thinking" content renders collapsed by default, without any box chrome;
 * the toggle is a plain button so it is keyboard- and test-accessible.
 */
export function ThinkingBlock({ thinking }: { thinking: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="my-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          aria-hidden
          className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")}
        />
        Thinking
      </button>
      {open && (
        <div className="py-1 pl-5 text-xs font-mono whitespace-pre-wrap text-muted-foreground">
          {thinking}
        </div>
      )}
    </div>
  );
}
