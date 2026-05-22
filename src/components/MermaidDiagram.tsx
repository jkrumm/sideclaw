import { useEffect, useId, useState } from "react";

const COLON_RE = /:/g;

interface MermaidDiagramProps {
  chart: string;
  isDark: boolean;
}

// mermaid is ~500KB+ — dynamically imported so it only loads when a diagram
// is actually rendered (i.e. the Preview tab shows a ```mermaid block).
export function MermaidDiagram({ chart, isDark }: MermaidDiagramProps) {
  const id = useId().replace(COLON_RE, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);

    import("mermaid")
      .then(({ default: mermaid }) => {
        mermaid.initialize(
          isDark
            ? {
                startOnLoad: false,
                theme: "dark",
                themeVariables: {
                  background: "#252a31", // dark-gray-2 (Mermaid requires raw hex)
                  primaryColor: "#2d72d2", // intent-primary
                  primaryTextColor: "#c5cbd3", // gray-5
                  lineColor: "#5f6b7c", // gray-1
                },
              }
            : {
                startOnLoad: false,
                theme: "default",
                themeVariables: {
                  background: "#ffffff",
                  primaryColor: "#2d72d2",
                  primaryTextColor: "#1c2127",
                  lineColor: "#8f99a8",
                },
              },
        );
        return mermaid.render(`mermaid-${id}`, chart);
      })
      .then(({ svg: rendered }) => {
        if (!cancelled) setSvg(rendered);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [chart, id, isDark]);

  if (error) {
    return <div className="mdx-diagram-stub">Mermaid render error: {error}</div>;
  }

  if (!svg) {
    return <div className="mdx-diagram-stub">Rendering diagram…</div>;
  }

  // svg is produced by mermaid from local content — safe to inject.
  return <div className="mdx-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
