import React, { useEffect, useRef, useState } from "react";
import {
  Button,
  Callout,
  Drawer,
  DrawerSize,
  Icon,
  Intent,
  Spinner,
  SpinnerSize,
} from "@blueprintjs/core";

interface Props {
  jobId: string | null;
  skill: string;
  onClose: () => void;
}

type JobStatus = "running" | "pass" | "fail";

const SKILL_LABELS: Record<string, string> = {
  "/check": "Validate",
  "/review": "Review",
  "/git-cleanup": "Git Cleanup",
  "/pr create": "Create PR",
  "/pr merge": "Merge PR",
};

function skillLabel(skill: string): string {
  return SKILL_LABELS[skill] ?? skill.replace(/^\//, "");
}

export function ChainDrawer({ jobId, skill, onClose }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<JobStatus>("running");
  const [elapsed, setElapsed] = useState(0);
  const outputRef = useRef<HTMLPreElement>(null);
  const startRef = useRef(Date.now());
  const esRef = useRef<EventSource | null>(null);

  // Elapsed timer while running
  useEffect(() => {
    if (status !== "running") return;
    startRef.current = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.round((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [status]);

  // SSE stream
  useEffect(() => {
    if (!jobId) return;
    setLines([]);
    setStatus("running");
    setElapsed(0);

    const es = new EventSource(`/api/actions/chain/${jobId}/stream`);
    esRef.current = es;

    es.addEventListener("output", (e: MessageEvent<string>) => {
      try {
        const line = JSON.parse(e.data) as string;
        setLines((prev) => [...prev, line]);
      } catch {
        setLines((prev) => [...prev, e.data]);
      }
    });

    es.addEventListener("status", (e: MessageEvent<string>) => {
      try {
        const { status: s } = JSON.parse(e.data) as { status: JobStatus };
        setStatus(s);
      } catch {
        // ignore
      }
      es.close();
    });

    es.onerror = () => {
      // Stream ended (job done or connection error)
      es.close();
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [jobId]);

  // Auto-scroll on new output
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const title = skillLabel(skill);
  const isOpen = !!jobId;

  const statusCallout = status !== "running" ? (
    <Callout
      intent={status === "pass" ? Intent.SUCCESS : Intent.DANGER}
      icon={status === "pass" ? "tick-circle" : "error"}
      style={{ marginBottom: 12, flexShrink: 0 }}
    >
      {status === "pass" ? `${title} completed successfully` : `${title} failed — review output above`}
    </Callout>
  ) : null;

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      size={DrawerSize.LARGE}
      title={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {status === "running" ? (
            <Spinner size={SpinnerSize.SMALL} />
          ) : (
            <Icon
              icon={status === "pass" ? "tick-circle" : "error"}
              intent={status === "pass" ? Intent.SUCCESS : Intent.DANGER}
            />
          )}
          <span>{title}</span>
          {status === "running" && (
            <span style={{ fontSize: 12, opacity: 0.55 }}>{elapsed}s</span>
          )}
        </div>
      }
      hasBackdrop={false}
      canOutsideClickClose={false}
      style={{ fontFamily: "var(--bp-typography-family-mono)" }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          padding: "12px 16px",
          overflow: "hidden",
        }}
      >
        {statusCallout}

        <pre
          ref={outputRef}
          style={{
            flex: 1,
            margin: 0,
            padding: "8px 10px",
            overflow: "auto",
            fontSize: 12,
            lineHeight: 1.55,
            background: "var(--bp5-dark-gray5, #1c2127)",
            color: "var(--bp5-light-gray5, #f6f7f9)",
            borderRadius: 4,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {lines.length === 0 && status === "running" ? (
            <span style={{ opacity: 0.4 }}>Starting {title}…</span>
          ) : (
            lines.join("\n")
          )}
        </pre>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10, flexShrink: 0 }}>
          <Button onClick={onClose} variant="minimal">
            {status === "running" ? "Hide" : "Close"}
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
