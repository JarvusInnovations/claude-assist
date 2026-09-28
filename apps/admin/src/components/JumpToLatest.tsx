import { useEffect, useState, type RefObject } from "react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Floating "Jump to latest · <when>" button (specs/behaviors/session-detail-page.md).
 * Visible while `target` (a sentinel after the transcript's end) is out of
 * view; clicking scrolls it into view.
 */
export function JumpToLatest({
  target,
  latestAt,
}: {
  target: RefObject<HTMLElement | null>;
  latestAt: string | null;
}) {
  const [endVisible, setEndVisible] = useState(true);
  const [, setTick] = useState(0);

  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setEndVisible(entry?.isIntersecting ?? true));
    observer.observe(el);
    return () => observer.disconnect();
  }, [target]);

  // Keep the relative time current while the page stays open.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (endVisible) return null;

  const latest = latestAt ? new Date(latestAt) : null;
  return (
    <Button
      className="fixed bottom-6 right-6 z-50 rounded-full shadow-lg"
      title={latest ? format(latest, "PPpp") : undefined}
      onClick={() => target.current?.scrollIntoView({ behavior: "smooth", block: "end" })}
    >
      <ArrowDown className="mr-2 h-4 w-4" />
      Jump to latest
      {latest && ` · ${formatDistanceToNowStrict(latest, { addSuffix: true })}`}
    </Button>
  );
}
