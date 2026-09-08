import type { RepoInfo } from "../server/lib/repo-scanner";

export type { RepoInfo };

export interface RepoData {
  repo: RepoInfo;
  notes: string;
  notesModifiedAt: number;
}
