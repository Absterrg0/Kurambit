import type { ScopedThreadRef } from "@kurambit/contracts";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { CopyIcon, ExternalLinkIcon, GlobeIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useOpenLink } from "../../browser/useOpenLink";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { toastManager } from "../ui/toast";

/**
 * Publishing the Web export to <game>.kurambit.com, where anyone can play it in a browser. Connect
 * signs in with GitHub once, in the browser; Publish puts up what Play serves, again as Update;
 * Unpublish takes it down, and Disconnect forgets this Kurambit's key.
 */
export function GamePublishCard({
  threadRef,
  hasWebExport,
  busy,
}: {
  threadRef: ScopedThreadRef;
  /** A Web export exists: publishing sends that, never a fresh one. */
  hasWebExport: boolean;
  /** Another operation of the game is running. */
  busy: boolean;
}) {
  const target = {
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  };
  const query = useEnvironmentQuery(gameEnvironment.publishStatus(target));
  const status = query.data;
  const connect = useAtomCommand(gameEnvironment.publishConnect, { reportFailure: false });
  const disconnect = useAtomCommand(gameEnvironment.publishDisconnect, { reportFailure: false });
  const publish = useAtomCommand(gameEnvironment.publish, { reportFailure: false });
  const unpublish = useAtomCommand(gameEnvironment.unpublish, { reportFailure: false });
  const canAct = useAtomValue(gameEnvironment.publish.permissionAtom(threadRef.environmentId));
  const openLink = useOpenLink(threadRef);
  const [working, setWorking] = useState<"publish" | "unpublish" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = query.refresh;

  // The server polls kurambit.com while the person approves the code there; this rereads its status.
  const signingIn = status?.signingIn ?? null;
  const waiting = signingIn !== null;
  const acting = working !== null;
  useEffect(() => {
    if (!waiting) return;
    const reread = () => refresh();
    window.addEventListener("focus", reread);
    const timer = window.setInterval(reread, 3000);
    return () => {
      window.removeEventListener("focus", reread);
      window.clearInterval(timer);
    };
  }, [waiting, refresh]);

  const run = async (kind: "publish" | "unpublish", command: typeof publish | typeof unpublish) => {
    setWorking(kind);
    setError(null);
    const result = await command(target);
    setWorking(null);
    refresh();
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else if (kind === "publish" && result.value.published !== null)
      toastManager.add({
        type: "success",
        title: "Published",
        description: `Anyone can play it at ${result.value.published.url}`,
      });
  };

  const startConnect = async () => {
    setError(null);
    const result = await connect({ environmentId: threadRef.environmentId, input: {} });
    if (result._tag === "Failure") return setError(String(squashAtomCommandFailure(result)));
    refresh();
    await openLink(result.value.url).catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  };

  const published = status?.published ?? null;
  return (
    <section
      data-game-publish=""
      className="flex flex-wrap items-start gap-4 rounded-xl bg-card p-4"
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        <GlobeIcon className="size-4.5" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <Text variant="label" render={<h3 />}>
          Publish on kurambit.com
        </Text>
        <Text variant="meta" tone="muted" render={<p />}>
          {published !== null
            ? "Anyone with the link can play it in their browser."
            : "Put the Web export at its own address, playable by anyone in a browser."}
        </Text>
        {published !== null ? (
          <Text variant="meta" truncate render={<p />}>
            {published.url}
          </Text>
        ) : null}
        {status?.connected === true && status.login !== null ? (
          <Text variant="caption" tone="muted" render={<p />}>
            Publishing as @{status.login}
          </Text>
        ) : null}
        {!hasWebExport && status?.connected === true ? (
          <Text variant="caption" tone="muted" render={<p />}>
            Export for web first: that is what goes up.
          </Text>
        ) : null}
        {signingIn !== null ? (
          <Text variant="meta" tone="muted" render={<p />}>
            Sign in with GitHub in the page that opened and approve the code{" "}
            <Text variant="meta" render={<strong />}>
              {signingIn.userCode}
            </Text>
            . This updates on its own.
          </Text>
        ) : null}
        {error !== null ? (
          <Text variant="meta" tone="destructive" render={<p role="alert" />}>
            {error}
          </Text>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5 pt-2">
          {status?.connected !== true ? (
            signingIn !== null ? (
              <Button size="sm" variant="outline" onClick={() => void openLink(signingIn.url)}>
                <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                Open the sign-in page again
              </Button>
            ) : (
              // The dialog's one accent is Export for web: signing in is the step after it.
              <Button
                size="sm"
                variant="outline"
                disabled={!canAct}
                onClick={() => void startConnect()}
              >
                Sign in with GitHub to publish
              </Button>
            )
          ) : published === null ? (
            <Button
              size="sm"
              disabled={!canAct || !hasWebExport || busy || acting}
              aria-busy={working === "publish"}
              onClick={() => void run("publish", publish)}
            >
              <GlobeIcon className="size-3.5" aria-hidden="true" />
              {working === "publish" ? "Publishing…" : "Publish"}
            </Button>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => void openLink(published.url)}>
                <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                Open
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void navigator.clipboard.writeText(published.url)}
              >
                <CopyIcon className="size-3.5" aria-hidden="true" />
                Copy link
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!canAct || !hasWebExport || busy || acting}
                aria-busy={working === "publish"}
                onClick={() => void run("publish", publish)}
              >
                {working === "publish" ? "Updating…" : "Update"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!canAct || acting}
                onClick={() => void run("unpublish", unpublish)}
              >
                {working === "unpublish" ? "Unpublishing…" : "Unpublish"}
              </Button>
            </>
          )}
          {status?.connected === true && published === null ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={acting}
              onClick={() =>
                void disconnect({ environmentId: threadRef.environmentId, input: {} }).then(refresh)
              }
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
