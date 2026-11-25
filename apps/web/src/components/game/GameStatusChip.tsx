import type { GamePublishStatus, ScopedThreadRef } from "@kurambit/contracts";
import { ArrowUpRightIcon } from "lucide-react";
import { AsyncResult } from "effect/reactivity";

import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuerySelector } from "../../state/query";
import { Badge } from "../ui/badge";
import { StatusDot } from "../ui/status-dot";

const publishedOf = (result: AsyncResult.AsyncResult<GamePublishStatus, unknown>) =>
  AsyncResult.isSuccess(result) ? result.value.published : null;

/**
 * Where the game stands, beside its name in the top bar: at work while a build is being made,
 * else published on kurambit.com (a link to it), else nothing to say.
 */
export function GameStatusChip({
  threadRef,
  working,
}: {
  threadRef: ScopedThreadRef;
  working: boolean;
}) {
  const published = useEnvironmentQuerySelector(
    gameEnvironment.publishStatus({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
    publishedOf,
  );
  if (working)
    return (
      <Badge variant="outline" className="shrink-0">
        <StatusDot tone="live" />
        Working
      </Badge>
    );
  if (published == null) return null;
  return (
    <Badge
      variant="outline"
      className="shrink-0"
      render={<a href={published.url} target="_blank" rel="noreferrer" />}
    >
      <StatusDot tone="success" />
      Published
      <ArrowUpRightIcon aria-hidden="true" />
    </Badge>
  );
}
