import { Classes } from "@blueprintjs/core";

export function PanelSkeleton({ height = 120 }: { height?: number }) {
  return <div className={Classes.SKELETON} style={{ height, borderRadius: 3 }} />;
}
