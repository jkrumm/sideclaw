import { useCallback, useEffect, useMemo, useRef } from "react";
import CodeMirror, { type ViewUpdate } from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { createTheme } from "@uiw/codemirror-themes";
import { tags as t } from "@lezer/highlight";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate as CMViewUpdate,
  keymap,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

interface Props {
  content: string;
  contentKey: string;
  onSave: (content: string) => Promise<unknown>;
  placeholder?: string;
}

/** Blueprint-matched dark theme for CodeMirror 6 */
const darkTheme = createTheme({
  theme: "dark",
  settings: {
    background: "var(--bp-palette-dark-gray-4)",
    foreground: "var(--bp-typography-color-default)",
    caret: "var(--bp-typography-color-default)",
    selection: "rgba(45, 114, 210, 0.4)",
    selectionMatch: "rgba(45, 114, 210, 0.25)",
    lineHighlight: "transparent",
    gutterBackground: "var(--bp-palette-dark-gray-4)",
    gutterForeground: "var(--bp-typography-color-muted)",
    gutterBorder: "transparent",
    fontFamily: "'Geist Sans', system-ui, sans-serif",
  },
  styles: [
    { tag: t.heading1, fontSize: "1.3em", fontWeight: "600" },
    { tag: t.heading2, fontSize: "1.15em", fontWeight: "600" },
    { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "600" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.link, color: "var(--bp-intent-primary-text-color-default)" },
    { tag: t.url, color: "var(--bp-intent-primary-text-color-default)" },
    { tag: t.monospace, fontFamily: "var(--bp-typography-family-mono)" },
    { tag: [t.processingInstruction, t.meta], color: "var(--bp-typography-color-muted)" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.quote, color: "var(--bp-typography-color-muted)", fontStyle: "italic" },
  ],
});

/** Light theme — minimal overrides, CM6 defaults are fine */
const lightTheme = createTheme({
  theme: "light",
  settings: {
    background: "#ffffff",
    foreground: "#1c2127",
    caret: "#1c2127",
    selection: "rgba(45, 114, 210, 0.25)",
    selectionMatch: "rgba(45, 114, 210, 0.15)",
    lineHighlight: "transparent",
    gutterBackground: "#ffffff",
    gutterForeground: "#8a919966",
    gutterBorder: "transparent",
    fontFamily: "'Geist Sans', system-ui, sans-serif",
  },
  styles: [
    { tag: t.heading1, fontSize: "1.3em", fontWeight: "600" },
    { tag: t.heading2, fontSize: "1.15em", fontWeight: "600" },
    { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "600" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.link, color: "#2d72d2" },
    { tag: t.url, color: "#2d72d2" },
    { tag: t.monospace, fontFamily: "var(--bp-typography-family-mono)" },
    { tag: [t.processingInstruction, t.meta], color: "#5f6b7c" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.quote, color: "#5f6b7c", fontStyle: "italic" },
  ],
});

// ── Horizontal rule decoration ──────────────────────────────────────

function buildHrDecorations(view: EditorView): DecorationSet {
  const decorations: Array<ReturnType<typeof Decoration.line> | ReturnType<typeof Decoration.mark>> = [];
  syntaxTree(view.state).iterate({
    enter(node) {
      if (node.name === "HorizontalRule") {
        decorations.push(Decoration.line({ class: "cm-hr-line" }).range(node.from));
        decorations.push(Decoration.mark({ class: "cm-hr-text" }).range(node.from, node.to));
      }
      // SetextHeading2: text immediately followed by --- (no blank line)
      // The markdown parser treats this as an H2 heading, causing ugly bold text.
      // We reinterpret it: suppress the heading style and treat --- as a separator.
      if (node.name === "SetextHeading2") {
        const text = view.state.sliceDoc(node.from, node.to);
        const lastNewline = text.lastIndexOf("\n");
        if (lastNewline >= 0) {
          const markFrom = node.from + lastNewline + 1;
          // Suppress heading style on the text part
          decorations.push(
            Decoration.mark({ class: "cm-setext-suppress" }).range(node.from, markFrom - 1),
          );
          // Treat the --- line as a normal separator
          decorations.push(Decoration.line({ class: "cm-hr-line" }).range(markFrom));
          decorations.push(
            Decoration.mark({ class: "cm-hr-text" }).range(markFrom, node.to),
          );
        }
      }
    },
  });
  return Decoration.set(decorations, true);
}

const hrPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildHrDecorations(view);
    }
    update(update: CMViewUpdate) {
      if (update.docChanged || update.viewportChanged)
        this.decorations = buildHrDecorations(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// ── Markdown keybindings (Cmd+B / Cmd+I) ───────────────────────────

function wrapSelection(view: EditorView, marker: string): boolean {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);

  // If already wrapped, unwrap
  if (
    selected.startsWith(marker) &&
    selected.endsWith(marker) &&
    selected.length >= marker.length * 2
  ) {
    const inner = selected.slice(marker.length, -marker.length);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
    });
    return true;
  }

  // Check if surrounding text has the markers
  const before = view.state.sliceDoc(from - marker.length, from);
  const after = view.state.sliceDoc(to, to + marker.length);
  if (before === marker && after === marker) {
    view.dispatch({
      changes: [
        { from: from - marker.length, to: from, insert: "" },
        { from: to, to: to + marker.length, insert: "" },
      ],
      selection: { anchor: from - marker.length, head: to - marker.length },
    });
    return true;
  }

  // Wrap
  view.dispatch({
    changes: { from, to, insert: `${marker}${selected}${marker}` },
    selection: {
      anchor: from + marker.length,
      head: to + marker.length,
    },
  });
  return true;
}

const markdownKeymap = keymap.of([
  { key: "Mod-b", run: (view) => wrapSelection(view, "**") },
  { key: "Mod-i", run: (view) => wrapSelection(view, "_") },
]);

// ── Editor chrome ───────────────────────────────────────────────────

const editorTheme = EditorView.theme({
  ".cm-gutters": { display: "none" },
  ".cm-content": { padding: "8px 12px" },
  ".cm-editor": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
  "&.cm-focused": { outline: "none" },
  ".cm-hr-line": {
    position: "relative",
  },
  ".cm-hr-line::after": {
    content: '""',
    position: "absolute",
    top: "calc(50% + 2px)",
    left: "38px",
    right: "0",
    borderTop: "1px solid var(--bp-surface-border-color-default)",
    transform: "translateY(-50%)",
    pointerEvents: "none",
  },
  ".cm-hr-text": {
    color: "var(--bp-typography-color-muted)",
    fontSize: "0.8em",
    opacity: "0.6",
  },
  ".cm-setext-suppress, .cm-setext-suppress *": {
    fontSize: "1em !important",
    fontWeight: "normal !important",
  },
});

// ── Component ───────────────────────────────────────────────────────

export function MarkdownEditor({
  content,
  contentKey,
  onSave,
  placeholder,
}: Props) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const pendingSaveFnRef = useRef<((c: string) => Promise<unknown>) | null>(null);
  const latestValueRef = useRef(content);

  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      editorTheme,
      hrPlugin,
      markdownKeymap,
      EditorView.lineWrapping,
    ],
    [],
  );

  const isDark =
    typeof document !== "undefined" &&
    document.body.classList.contains("bp6-dark");

  const onChange = useCallback((value: string, _viewUpdate: ViewUpdate) => {
    latestValueRef.current = value;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    pendingSaveFnRef.current = onSaveRef.current;
    debounceRef.current = setTimeout(() => {
      pendingSaveFnRef.current?.(value).catch(() => {});
      pendingSaveFnRef.current = null;
      debounceRef.current = null;
    }, 1000);
  }, []);

  // Flush pending save on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current && pendingSaveFnRef.current) {
        clearTimeout(debounceRef.current);
        pendingSaveFnRef.current(latestValueRef.current).catch(() => {});
      }
    };
  }, []);

  // Flush before tab hide/close/reload — fires while fetch still works
  useEffect(() => {
    const handleHide = () => {
      if (document.visibilityState !== "hidden") return;
      if (debounceRef.current && pendingSaveFnRef.current) {
        clearTimeout(debounceRef.current);
        const fn = pendingSaveFnRef.current;
        const content = latestValueRef.current;
        pendingSaveFnRef.current = null;
        debounceRef.current = null;
        fn(content).catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", handleHide);
    return () => document.removeEventListener("visibilitychange", handleHide);
  }, []);

  // Flush pending save on file switch (contentKey change)
  useEffect(() => {
    if (debounceRef.current && pendingSaveFnRef.current) {
      clearTimeout(debounceRef.current);
      pendingSaveFnRef.current(latestValueRef.current).catch(() => {});
      pendingSaveFnRef.current = null;
      debounceRef.current = null;
    }
    latestValueRef.current = content;
  }, [contentKey, content]);

  return (
    <CodeMirror
      value={content}
      key={contentKey}
      theme={isDark ? darkTheme : lightTheme}
      extensions={extensions}
      onChange={onChange}
      placeholder={placeholder ?? "Start writing..."}
      height="100%"
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        indentOnInput: false,
        bracketMatching: false,
        closeBrackets: false,
        autocompletion: false,
        searchKeymap: true,
      }}
    />
  );
}
