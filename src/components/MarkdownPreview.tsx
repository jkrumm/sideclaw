import { useCallback, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { ShikiHighlighter, isInlineCode, rehypeInlineCodeProperty } from "react-shiki/web";
import { Button, Classes, Code, H1, H2, H3, H4, H5, H6 } from "@blueprintjs/core";
import GithubSlugger from "github-slugger";
import { blueprintDarkTheme, LIGHT_THEME } from "../lib/shiki-theme";
import { MermaidDiagram } from "./MermaidDiagram";

interface Props {
  content: string;
}

interface TocItem {
  depth: number;
  text: string;
  id: string;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const INLINE_MARK_RE = /[*_`~]/g;

// Build a table of contents from the raw markdown. A fresh GithubSlugger walks
// every heading in document order, so the generated ids match rehype-slug's
// output exactly (rehype-slug uses the same slugger). Only h1–h3 are displayed.
function buildToc(content: string): TocItem[] {
  const slugger = new GithubSlugger();
  const items: TocItem[] = [];
  let inFence = false;

  for (const line of content.split("\n")) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = HEADING_RE.exec(line);
    if (!match) continue;

    const depth = match[1].length;
    const text = match[2].replace(INLINE_MARK_RE, "").trim();
    const id = slugger.slug(text); // advance counter for every heading
    if (depth <= 3) items.push({ depth, text, id });
  }

  return items;
}

function isExternalHref(href?: string): boolean {
  return !!href && /^https?:\/\//.test(href);
}

function CodeBlock({ code, lang, isDark }: { code: string; lang?: string; isDark: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);

  return (
    <div className="md-codeblock">
      <ShikiHighlighter
        language={lang ?? "text"}
        theme={isDark ? blueprintDarkTheme : LIGHT_THEME}
        showLanguage={false}
        addDefaultStyles
      >
        {code}
      </ShikiHighlighter>
      <Button
        className="md-copy-btn"
        variant="minimal"
        size="small"
        icon={copied ? "tick" : "duplicate"}
        onClick={copy}
        aria-label="Copy code"
      />
    </div>
  );
}

export default function MarkdownPreview({ content }: Props) {
  // Resolved once per mount — preview re-mounts on every Edit→Preview switch,
  // so it always reflects the current theme (same detection as MarkdownEditor).
  const isDark = typeof document !== "undefined" && document.body.classList.contains("bp6-dark");

  const toc = useMemo(() => buildToc(content), [content]);

  const components = useMemo<Components>(
    () => ({
      h1: ({ children, ...p }) => <H1 {...p}>{children}</H1>,
      h2: ({ children, ...p }) => <H2 {...p}>{children}</H2>,
      h3: ({ children, ...p }) => <H3 {...p}>{children}</H3>,
      h4: ({ children, ...p }) => <H4 {...p}>{children}</H4>,
      h5: ({ children, ...p }) => <H5 {...p}>{children}</H5>,
      h6: ({ children, ...p }) => <H6 {...p}>{children}</H6>,
      a: ({ children, href, ...p }) => (
        <a
          href={href}
          {...(isExternalHref(href) ? { target: "_blank", rel: "noreferrer" } : {})}
          {...p}
        >
          {children}
        </a>
      ),
      // react-shiki renders its own <pre>; collapse react-markdown's wrapper.
      pre: ({ children }) => <>{children}</>,
      code: ({ node, className, children }) => {
        const inline = node ? isInlineCode(node) : !String(children).includes("\n");
        if (inline) return <Code>{children}</Code>;

        const lang = /language-(\w+)/.exec(className ?? "")?.[1];
        const code = String(children).replace(/\n$/, "");
        if (lang === "mermaid") return <MermaidDiagram chart={code} isDark={isDark} />;
        return <CodeBlock code={code} lang={lang} isDark={isDark} />;
      },
    }),
    [isDark],
  );

  if (!content.trim()) {
    return <div className="md-preview-empty">Nothing to preview.</div>;
  }

  return (
    <div className="md-preview">
      {toc.length >= 3 && (
        <nav className="md-toc">
          <div className="md-toc-title">Contents</div>
          <ul>
            {toc.map((item, i) => (
              <li key={`${item.id}-${i}`} style={{ paddingLeft: (item.depth - 1) * 12 }}>
                <a href={`#${item.id}`}>{item.text}</a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <div className={`md-preview-content ${Classes.RUNNING_TEXT}`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSlug, rehypeInlineCodeProperty]}
          components={components}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
