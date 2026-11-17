import { createFileRoute } from "@tanstack/react-router";

import { LibraryPage } from "../components/library/LibraryPage";

export const Route = createFileRoute("/_chat/library")({
  // Search opens the Library on one item.
  validateSearch: (search: Record<string, unknown>): { item?: string } =>
    typeof search.item === "string" ? { item: search.item } : {},
  component: LibraryPage,
});
