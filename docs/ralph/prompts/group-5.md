# Group 5: Queue UI — Cards, Drag & Drop, Add & Delete

## What You're Doing

Implement the full queue panel: `QueuePanel` (container with add-task input) and `QueueCard` (individual task card with drag handle, icon, preview, expand/edit, and delete). Drag-to-reorder via `@dnd-kit/sortable`. Task expansion shows a plain `<textarea>` (EasyMDE comes in Group 6 with notes). After this group the queue is fully interactive.

---

## Research & Exploration First

1. Read `sideclaw/src/pages/RepoDashboard.tsx` from Group 4 — understand where QueuePanel plugs in
2. Read `sideclaw/docs/ralph/RALPH_NOTES.md` for any Group 4 deviations
3. Research `@dnd-kit/sortable` via Context7 — `SortableContext`, `useSortable`, `DndContext`, `arrayMove`
4. Research BlueprintJS v6 `Card`, `Button`, `Icon`, `InputGroup` APIs via Context7
5. Check @dnd-kit accessibility requirements for keyboard drag-and-drop

---

## What to Implement

### 1. `src/components/QueuePanel.tsx`

```typescript
interface Props {
  tasks: QueueTask[];
  repoPath: string;
  onTasksChange: (tasks: QueueTask[]) => void;
}
```

- `DndContext` + `SortableContext` wrapping the task list
- `arrayMove` on drag end → call `PUT /api/queue` with reordered tasks → `onTasksChange`
- Optimistic update: update local state immediately, then sync to server
- "Add task" `InputGroup` at the bottom — Enter key appends new task
  - Detect slash command by `/` prefix → set `kind: "slash"`, else `kind: "task"`
- "PAUSE" button (Blueprint `Button`, intent WARNING) — appends a PAUSE sentinel
- Section header: "QUEUE" label + collapse toggle (`Button` with chevron icon)

### 2. `src/components/QueueCard.tsx`

```typescript
interface Props {
  task: QueueTask;
  onDelete: () => void;
  onUpdate: (content: string) => void;
}
```

Use `useSortable` for drag handle. Card layout:
- Left: drag handle icon (`DragHandleVertical`)
- Left: kind icon — ⚡ `Flash` (Intent.PRIMARY) | ◆ `Symbol` or `Circle` (no intent) | ⏸ `Pause` (Intent.WARNING)
- Center: `preview` text in `font-family: var(--font-mono)` for slash commands, sans-serif for tasks
- Right: expand button (chevron) + delete button (cross icon)

Expanded state (click expand or card body):
- Shows a `<textarea>` with `content`, styled to fill the card
- Auto-resize textarea height to content
- Save on blur or Ctrl+S → `onUpdate(newContent)` → parent re-serializes + PUTs to server
- PAUSE cards: not expandable (nothing to edit)

### 3. Wire into `src/pages/RepoDashboard.tsx`

- Maintain `tasks: QueueTask[]` state
- Pass to `<QueuePanel tasks={tasks} repoPath={path} onTasksChange={setTasks} />`
- On SSE "change" event for queue file: re-fetch and update tasks (unless user is actively editing — check a `isEditing` ref)

---

## Validation

```bash
bun run typecheck   # must pass
bun run build       # must produce dist/
```

---

## Commit

```
feat(sideclaw): add queue panel with drag-and-drop, add/delete/edit task cards
```

---

## Done

Append learning notes to `docs/ralph/RALPH_NOTES.md`, then:
```
RALPH_TASK_COMPLETE: Group 5
```
