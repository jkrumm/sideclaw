import React, { use, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import {
  Button,
  Collapse,
  Icon,
  InputGroup,
  Intent,
  Spinner,
} from "@blueprintjs/core";
import { api } from "../lib/api";
import { QueueCard } from "./QueueCard";
import type { CompletedTask, QueueTask, RepoData } from "../types";

function timeAgo(timestamp: number, now: number): string {
  const seconds = Math.floor((now - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

const subLabelStyle: React.CSSProperties = {
  fontFamily: "var(--bp-typography-family-mono)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--bp-typography-color-muted)",
  opacity: 0.6,
  margin: "10px 0 4px 0",
};

export interface QueuePanelHandle {
  refresh: () => void;
}

interface Props {
  repoPath: string;
  initialPromise: Promise<RepoData>;
  ref?: React.Ref<QueuePanelHandle>;
}

function reindex(tasks: QueueTask[]): QueueTask[] {
  return tasks.map((t, i) => ({ ...t, index: i }));
}

async function syncToServer(
  path: string,
  tasks: QueueTask[],
): Promise<void> {
  await api.api.queue.put({ tasks }, { query: { path } });
}

function CompletedTaskRow({
  task,
  now,
  isRunning,
  isExpanded,
  onToggle,
}: {
  task: CompletedTask;
  now: number;
  isRunning: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const isMultiLine = task.content.split("\n").length > 1;

  return (
    <div
      style={{
        padding: "4px 8px",
        opacity: isRunning ? 1 : 0.6,
        borderLeft: isRunning
          ? "2px solid var(--bp-intent-primary-color)"
          : "2px solid transparent",
        marginBottom: 2,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: isMultiLine ? "pointer" : "default",
        }}
        onClick={isMultiLine ? onToggle : undefined}
      >
        {isRunning ? (
          <Spinner size={12} />
        ) : (
          <Icon
            icon={task.kind === "slash" ? "flash" : "circle"}
            size={12}
            intent={task.kind === "slash" ? "warning" : "none"}
          />
        )}
        <span
          style={{
            flex: 1,
            fontFamily: "var(--bp-typography-family-mono)",
            fontSize: 12,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {task.preview}
        </span>
        <span
          style={{
            fontSize: 11,
            opacity: 0.5,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {timeAgo(task.completed_at, now)}
        </span>
        {isMultiLine && (
          <Icon
            icon={isExpanded ? "chevron-up" : "chevron-down"}
            size={12}
            style={{ opacity: 0.4 }}
          />
        )}
      </div>
      {isMultiLine && (
        <Collapse isOpen={isExpanded}>
          <pre
            style={{
              fontFamily: "var(--bp-typography-family-mono)",
              fontSize: 11,
              margin: "4px 0 0 20px",
              whiteSpace: "pre-wrap",
              opacity: 0.7,
            }}
          >
            {task.content}
          </pre>
        </Collapse>
      )}
    </div>
  );
}

export function QueuePanel({ repoPath, initialPromise, ref }: Props) {
  const initial = use(initialPromise);
  const [tasks, setTasks] = useState<QueueTask[]>(initial.queue);
  const [completedTasks, setCompletedTasks] = useState<CompletedTask[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [addValue, setAddValue] = useState("");
  const addInputRef = useRef<HTMLInputElement>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  // Refresh "Xm ago" display every 10 seconds
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(interval);
  }, []);

  const doFetchQueue = useCallback(async () => {
    const res = await fetch(`/api/queue?path=${encodeURIComponent(repoPath)}`);
    const json = (await res.json()) as { ok: boolean; data: QueueTask[] };
    if (json.ok) setTasks(json.data);
  }, [repoPath]);

  const doFetchCompleted = useCallback(async () => {
    const res = await fetch(`/api/completed-tasks?path=${encodeURIComponent(repoPath)}`);
    const json = (await res.json()) as { ok: boolean; data: CompletedTask[] };
    if (json.ok) setCompletedTasks(json.data);
  }, [repoPath]);

  const refresh = useCallback(() => {
    void doFetchQueue();
    void doFetchCompleted();
  }, [doFetchQueue, doFetchCompleted]);

  useImperativeHandle(ref, () => ({ refresh }), [refresh]);

  // Initial completed tasks load
  useEffect(() => { void doFetchCompleted(); }, [doFetchCompleted]);

  // 2s polling
  useEffect(() => {
    const id = setInterval(refresh, 2_000);
    return () => clearInterval(id);
  }, [refresh]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = tasks.findIndex((t) => t.index === active.id);
    const newIndex = tasks.findIndex((t) => t.index === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = reindex(arrayMove(tasks, oldIndex, newIndex));
    setTasks(reordered);
    void syncToServer(repoPath, reordered);
  };

  const handleDelete = (index: number) => {
    const updated = reindex(tasks.filter((t) => t.index !== index));
    setTasks(updated);
    void syncToServer(repoPath, updated);
  };

  const handleUpdate = (index: number, content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;

    const firstLine = trimmed.split("\n")[0];
    let kind: QueueTask["kind"];
    if (firstLine.toUpperCase() === "STOP") {
      kind = "stop";
    } else if (firstLine.startsWith("/")) {
      kind = "slash";
    } else {
      kind = "task";
    }

    const updated = reindex(
      tasks.map((t) =>
        t.index === index
          ? {
              ...t,
              content: trimmed,
              preview: firstLine,
              kind,
              lineCount: trimmed.split("\n").length,
            }
          : t,
      ),
    );
    setTasks(updated);
    void syncToServer(repoPath, updated);
  };

  const handleAddKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    const raw = addValue.trim();
    if (!raw) return;

    const kind: QueueTask["kind"] = raw.startsWith("/") ? "slash" : "task";
    const newTask: QueueTask = {
      index: tasks.length,
      kind,
      content: raw,
      preview: raw.split("\n")[0],
      lineCount: raw.split("\n").length,
    };

    const updated = reindex([...tasks, newTask]);
    setTasks(updated);
    void syncToServer(repoPath, updated);
    setAddValue("");
  };

  const handleAddStop = () => {
    const newTask: QueueTask = {
      index: tasks.length,
      kind: "stop",
      content: "STOP",
      preview: "STOP",
      lineCount: 1,
    };
    const updated = reindex([...tasks, newTask]);
    setTasks(updated);
    void syncToServer(repoPath, updated);
  };

  const toggleExpand = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Split completed tasks into running vs done (oldest first for done)
  const runningTask = completedTasks.find((t) => t.is_running === 1) ?? null;
  const doneTasks = completedTasks
    .filter((t) => t.is_running === 0)
    .reverse(); // oldest first (API returns newest first)

  const hasCompletedSection = doneTasks.length > 0 || runningTask;
  const sortableIds = tasks.map((t) => t.index);

  return (
    <div>
      {/* Section header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
        }}
      >
        <p className="section-label">Queue ({tasks.length})</p>
        <Button
          variant="minimal"
          icon={collapsed ? "chevron-right" : "chevron-down"}
          small
          onClick={() => setCollapsed((p) => !p)}
        />
      </div>

      {!collapsed && (
        <>
          {/* Done tasks */}
          {doneTasks.length > 0 && (
            <>
              <p style={subLabelStyle}>Done</p>
              {doneTasks.map((ct) => (
                <CompletedTaskRow
                  key={ct.id}
                  task={ct}
                  now={now}
                  isRunning={false}
                  isExpanded={expandedIds.has(ct.id)}
                  onToggle={() => toggleExpand(ct.id)}
                />
              ))}
            </>
          )}

          {/* Running task */}
          {runningTask && (
            <>
              <p style={subLabelStyle}>Running</p>
              <CompletedTaskRow
                task={runningTask}
                now={now}
                isRunning
                isExpanded={expandedIds.has(runningTask.id)}
                onToggle={() => toggleExpand(runningTask.id)}
              />
            </>
          )}

          {/* Queued tasks */}
          {hasCompletedSection && tasks.length > 0 && (
            <p style={subLabelStyle}>Queued</p>
          )}

          {tasks.length === 0 && !hasCompletedSection && (
            <p
              style={{
                fontSize: 12,
                opacity: 0.45,
                fontStyle: "italic",
                marginBottom: 10,
              }}
            >
              No tasks queued.
            </p>
          )}

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={sortableIds}
              strategy={verticalListSortingStrategy}
            >
              {tasks.map((task) => (
                <QueueCard
                  key={task.index}
                  task={task}
                  onDelete={() => handleDelete(task.index)}
                  onUpdate={(content) => handleUpdate(task.index, content)}
                />
              ))}
            </SortableContext>
          </DndContext>

          {/* Add task row */}
          <div
            style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}
          >
            <div style={{ flex: 1 }}>
              <InputGroup
                inputRef={addInputRef}
                value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
                onKeyDown={handleAddKeyDown}
                placeholder="Add task or /slash-command… (Enter)"
                leftIcon="plus"
                style={{ fontFamily: "var(--bp-typography-family-mono)" }}
              />
            </div>
            <Button
              intent={Intent.DANGER}
              icon="stop"
              onClick={handleAddStop}
            >
              Stop
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
