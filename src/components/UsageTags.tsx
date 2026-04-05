import { useEffect, useState } from "react";
import { NavbarDivider, Tag } from "@blueprintjs/core";
import { api } from "../lib/api";

interface UsageData {
  five_hour_pct: number;
  five_hour_mins_left: number | null;
  seven_day_pct: number | null;
  updated_at: number;
}

function fiveHourIntent(pct: number): "success" | "warning" | "danger" {
  if (pct < 50) return "success";
  if (pct < 75) return "warning";
  return "danger";
}

const STALE_MS = 15 * 60 * 1000; // 15 minutes

export function UsageTags() {
  const [usage, setUsage] = useState<UsageData | null>(null);

  const fetchUsage = async () => {
    try {
      const res = await api.api.usage.get();
      if (res.data?.ok && res.data.data) {
        setUsage(res.data.data as UsageData);
      }
    } catch {
      // sideclaw might be the only app — ignore network errors
    }
  };

  useEffect(() => {
    void fetchUsage();
    const interval = setInterval(() => void fetchUsage(), 60_000);
    return () => clearInterval(interval);
  }, []);

  if (!usage) return null;
  if (Date.now() - usage.updated_at > STALE_MS) return null;

  const fiveHourLabel =
    usage.five_hour_mins_left != null
      ? `${usage.five_hour_pct}%/5h ↺${usage.five_hour_mins_left}m`
      : `${usage.five_hour_pct}%/5h`;

  return (
    <>
      <NavbarDivider />
      <Tag
        intent={fiveHourIntent(usage.five_hour_pct)}
        minimal
        style={{ marginRight: usage.seven_day_pct != null ? 4 : 0 }}
      >
        {fiveHourLabel}
      </Tag>
      {usage.seven_day_pct != null && <Tag minimal>{usage.seven_day_pct}%/wk</Tag>}
    </>
  );
}
