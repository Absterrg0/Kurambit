import { ExternalLinkIcon, KeyRoundIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button, InlineButton } from "../ui/button";
import { StatusLabel, type StatusDotTone } from "../ui/status-dot";
import { Text } from "../ui/text";
import { SecretInput } from "./SecretInput";
import { SettingsRow } from "./settingsLayout";

/**
 * One saved key as one row: what it is for, its state as a dot and a label, and one verb.
 * The field only appears while a key is being added or replaced, so a page of keys nobody
 * has set reads as a short list instead of a stack of empty forms.
 */
export function SettingsKeyRow({
  id,
  icon,
  title,
  description,
  link,
  status,
  message,
  configured,
  canWrite,
  onSave,
  onClear,
}: {
  /** An anchor, so another row can send the reader to this key. */
  id?: string;
  icon?: ReactNode;
  title: string;
  description: string;
  /** Where to get a key (or read about a keyless provider), set in the description. */
  link?: { href: string; label: string } | undefined;
  status: { tone: StatusDotTone; label: string };
  /** Shown only when it says something the status does not, such as why a key was refused. */
  message?: string | null | undefined;
  /** Null for a provider that needs no key: it gets no verb. */
  configured: boolean | null;
  canWrite: boolean;
  onSave: (key: string) => void;
  onClear: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <SettingsRow
      id={id}
      inlineControl
      icon={icon ?? <KeyRoundIcon />}
      title={title}
      description={
        <>
          {description}
          {link === undefined ? null : (
            <>
              {" "}
              <InlineButton
                tone="muted"
                className="inline-flex align-baseline"
                render={<a href={link.href} target="_blank" rel="noreferrer" />}
              >
                {link.label}
                <ExternalLinkIcon aria-hidden className="size-3" />
              </InlineButton>
            </>
          )}
        </>
      }
      control={
        <span className="flex items-center gap-3">
          <StatusLabel tone={status.tone}>{status.label}</StatusLabel>
          {configured === null || editing ? null : configured ? (
            <span className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={!canWrite}
                onClick={() => setEditing(true)}
              >
                Replace…
              </Button>
              <Button size="sm" variant="ghost" disabled={!canWrite} onClick={onClear}>
                Clear
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite}
              onClick={() => setEditing(true)}
            >
              Add key…
            </Button>
          )}
        </span>
      }
    >
      {message || editing ? (
        <div className="flex min-w-0 flex-col gap-2 ps-7 pb-2">
          {message ? (
            <Text variant="meta" tone="muted" render={<p className="whitespace-pre-wrap" />}>
              {message}
            </Text>
          ) : null}
          {editing ? (
            // Blur and Enter commit through the draft input first; the fold closes after.
            <div
              className="flex max-w-md items-center gap-2"
              onBlur={() => setEditing(false)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setEditing(false);
                }
              }}
            >
              <SecretInput
                size="sm"
                autoFocus
                aria-label={`${title} key`}
                configured={configured === true}
                value=""
                placeholder="Paste the key, then press Enter"
                onCommit={(next) => {
                  if (next !== "") onSave(next);
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </SettingsRow>
  );
}
