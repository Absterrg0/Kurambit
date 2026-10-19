import type { ScopedThreadRef } from "@t3tools/contracts";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";

export function GamePanelButton({ threadRef }: { threadRef: ScopedThreadRef }) {
  const query = useEnvironmentQuery(
    gameEnvironment.status({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  if (!query.data) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => useRightPanelStore.getState().open(threadRef, "game")}
    >
      Game
    </Button>
  );
}
