import { useMemo } from "react";
import {
  User,
  Bot,
  Terminal,
  CircleHelp,
  CornerDownRight,
  type LucideIcon,
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type TranscriptItemType = "user" | "assistant" | "tool" | "question" | "response";

interface TranscriptItem {
  type: TranscriptItemType;
  content: string;
}

const ITEM_CONFIG: Record<
  TranscriptItemType,
  {
    icon: LucideIcon;
    label: string;
    bgClass: string;
    textClass: string;
    borderClass: string;
  }
> = {
  user: {
    icon: User,
    label: "User Message",
    bgClass: "bg-blue-50 dark:bg-blue-950",
    textClass: "text-blue-700 dark:text-blue-200",
    borderClass: "border-l-blue-400",
  },
  assistant: {
    icon: Bot,
    label: "Assistant Response",
    bgClass: "bg-emerald-50 dark:bg-emerald-950",
    textClass: "text-emerald-700 dark:text-emerald-200",
    borderClass: "border-l-emerald-400",
  },
  tool: {
    icon: Terminal,
    label: "Tool Call",
    bgClass: "bg-amber-50 dark:bg-amber-950",
    textClass: "text-amber-700 dark:text-amber-200",
    borderClass: "border-l-amber-400",
  },
  question: {
    icon: CircleHelp,
    label: "Question Prompt",
    bgClass: "bg-purple-50 dark:bg-purple-950",
    textClass: "text-purple-700 dark:text-purple-200",
    borderClass: "border-l-purple-400",
  },
  response: {
    icon: CornerDownRight,
    label: "User Response",
    bgClass: "bg-indigo-50 dark:bg-indigo-950",
    textClass: "text-indigo-700 dark:text-indigo-200",
    borderClass: "border-l-indigo-400",
  },
};

const MARKER_TO_TYPE: Record<string, TranscriptItemType> = {
  "[U]": "user",
  "[A]": "assistant",
  "[T]": "tool",
  "[?]": "question",
  "[>]": "response",
};

/**
 * Parse transcript text into structured items.
 * Markers are [U], [A], [T], [?], [>] at the start of a line followed by a space.
 * Content runs from one marker to the next (can span multiple lines).
 */
function parseTranscript(transcript: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const markerRegex = /^(\[[UAT?>]\]) /gm;

  // Find all marker positions
  const markers: { index: number; marker: string }[] = [];
  let match;
  while ((match = markerRegex.exec(transcript)) !== null) {
    markers.push({ index: match.index, marker: match[1]! });
  }

  // Extract content between markers
  for (let i = 0; i < markers.length; i++) {
    const current = markers[i]!;
    const next = markers[i + 1];

    // Content starts after the marker and space
    const contentStart = current.index + current.marker.length + 1;
    const contentEnd = next ? next.index : transcript.length;
    const content = transcript.slice(contentStart, contentEnd).trimEnd();

    const type = MARKER_TO_TYPE[current.marker];
    if (type) {
      items.push({ type, content });
    }
  }

  return items;
}

interface TranscriptItemProps {
  item: TranscriptItem;
}

function TranscriptItemComponent({ item }: TranscriptItemProps) {
  const config = ITEM_CONFIG[item.type];
  const Icon = config.icon;

  return (
    <div
      className={cn(
        "flex gap-3 p-3 rounded-md border-l-4",
        config.bgClass,
        config.borderClass
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={cn("shrink-0 mt-0.5 cursor-default", config.textClass)}>
            <Icon className="h-4 w-4" />
          </div>
        </TooltipTrigger>
        <TooltipContent side="left">{config.label}</TooltipContent>
      </Tooltip>

      <p
        className={cn(
          "flex-1 min-w-0 text-sm whitespace-pre-wrap break-words",
          config.textClass
        )}
      >
        {item.content}
      </p>
    </div>
  );
}

interface TranscriptViewerProps {
  transcript: string;
}

export function TranscriptViewer({ transcript }: TranscriptViewerProps) {
  const items = useMemo(() => parseTranscript(transcript), [transcript]);

  if (items.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No transcript items found.</p>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <TranscriptItemComponent key={index} item={item} />
      ))}
    </div>
  );
}
