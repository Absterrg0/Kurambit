import type { ScopedThreadRef } from "@t3tools/contracts";
import type { MouseEvent } from "react";
import { useOpenLink } from "../browser/useOpenLink";

export function useOpenContextLink(threadRef?: ScopedThreadRef) {
  const openLink = useOpenLink(threadRef);
  return (event: MouseEvent<HTMLElement>, url: string) => {
    if (event.button > 1) return false;
    event.preventDefault();
    event.stopPropagation();
    void openLink(url, { event }).catch(console.error);
    return false;
  };
}
