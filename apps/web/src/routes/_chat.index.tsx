import { createFileRoute } from "@tanstack/react-router";

// Home lives in the `_chat` layout so Settings can open over it without unmounting it.
export const Route = createFileRoute("/_chat/")({
  component: () => null,
});
