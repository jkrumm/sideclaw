import { useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Card, Icon, Intent } from "@blueprintjs/core";
import type { QueueTask } from "../types";

interface Props {
  task: QueueTask;
  onDelete: () => void;
  onUpdate: (content: string) => void;
}

function kindIcon(kind: QueueTask["kind"]): React.ReactElement {
  if (kind === "slash") {
    return <Icon icon="lightning" intent={Intent.PRIMARY} size={14} />;
  }
  if (kind === "stop") {
    return <Icon icon="stop" intent={Intent.DANGER} size={14} />;
  }
  return <Icon icon="circle" size={14} />;
}

export function QueueCard({ task, onDelete, onUpdate }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [editContent, setEditContent] = useState(task.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.index });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    marginBottom: 6,
  };

  const handleExpand = () => {
    if (task.kind === "stop") return;
    setExpanded((prev) => {
      if (!prev) {
        setEditContent(task.content);
      }
      return !prev;
    });
  };

  const handleBlur = () => {
    if (editContent !== task.content) {
      onUpdate(editContent);
    }
    setExpanded(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (editContent !== task.content) {
        onUpdate(editContent);
      }
      setExpanded(false);
    }
    if (e.key === "Escape") {
      setEditContent(task.content);
      setExpanded(false);
    }
  };

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditContent(e.target.value);
    autoResize(e.target);
  };

  const handleTextareaRef = (el: HTMLTextAreaElement | null) => {
    (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current =
      el;
    if (el) {
      autoResize(el);
      el.focus();
    }
  };

  return (
    <div ref={setNodeRef} style={style}>
      <Card
        style={{
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {/* Drag handle */}
          <span
            {...attributes}
            {...listeners}
            style={{
              cursor: "grab",
              color: "var(--bp-typography-color-muted)",
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
            }}
          >
            <Icon icon="drag-handle-vertical" size={14} />
          </span>

          {/* Kind icon */}
          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
            {kindIcon(task.kind)}
          </span>

          {/* Preview text */}
          <span
            style={{
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily:
                task.kind === "slash" ? "var(--bp-typography-family-mono)" : undefined,
              fontSize: 13,
            }}
          >
            {task.preview}
          </span>

          {/* Actions */}
          <span style={{ display: "flex", gap: 2, flexShrink: 0 }}>
            {task.kind !== "stop" && (
              <Button
                variant="minimal"
                icon={expanded ? "chevron-up" : "chevron-down"}
                small
                onClick={handleExpand}
              />
            )}
            <Button
              variant="minimal"
              icon="cross"
              small
              intent={Intent.DANGER}
              onClick={onDelete}
            />
          </span>
        </div>

        {/* Expanded editor */}
        {expanded && (
          <textarea
            ref={handleTextareaRef}
            value={editContent}
            onChange={handleTextareaChange}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            style={{
              width: "100%",
              resize: "none",
              fontFamily: "var(--bp-typography-family-mono)",
              fontSize: 12,
              lineHeight: 1.5,
              padding: "6px 8px",
              border: "1px solid var(--bp-surface-border-color-default)",
              borderRadius: 3,
              background: "transparent",
              color: "inherit",
              boxSizing: "border-box",
              overflow: "hidden",
              minHeight: 60,
            }}
            spellCheck={false}
          />
        )}
      </Card>
    </div>
  );
}
