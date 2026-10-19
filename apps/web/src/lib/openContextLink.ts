import type { ScopedThreadRef } from "@t3tools/contracts";
import { useOpenLink } from "../browser/useOpenLink";

export function useOpenContextLink(threadRef?: ScopedThreadRef) {
  const openLink = useOpenLink(threadRef);
  return (
    event: {
      readonly button?: number;
      readonly metaKey: boolean;
      readonly ctrlKey: boolean;
      preventDefault: () => void;
      stopPropagation: () => void;
    },
    url: string,
  ) => {
    if ((event.button ?? 0) > 1) return false;
    event.preventDefault();
    event.stopPropagation();
    void openLink(url, { event }).catch(console.error);
    return true;
  };
}
