import { GitBranchIcon } from "lucide-react";
import type { SourceControlProviderInfo } from "@t3tools/contracts";

export function getSourceControlPresentation(_provider?: SourceControlProviderInfo | null) {
  return {
    providerName: "Git",
    terminology: { shortLabel: "PR", singular: "pull request" },
    Icon: GitBranchIcon,
  };
}
