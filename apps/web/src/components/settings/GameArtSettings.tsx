import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { ExternalLinkIcon } from "lucide-react";
import {
  GAME_ART_PROVIDERS,
  type EnvironmentId,
  type GameArtLane,
  type GameArtLaneChoice,
  type GameArtProviderId,
  type ServerSettingsPatch,
} from "@kurambit/contracts";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  GAME_ART_LANES,
  GAME_ART_LANE_LABELS,
  formatUsd,
  providerLabel,
} from "../game/gameGeneration.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";

// The Kurambit plan is one more provider once it exists; until then it is not offered.
const SHOWN_PROVIDERS = (
  Object.keys(GAME_ART_PROVIDERS) as ReadonlyArray<GameArtProviderId>
).filter((provider) => provider !== "kurambit");

const lanesLine = (provider: GameArtProviderId) =>
  `Makes ${GAME_ART_PROVIDERS[provider].lanes
    .map((lane) => GAME_ART_LANE_LABELS[lane].toLowerCase())
    .join(", ")}.`;

const USD: Intl.NumberFormatOptions = { style: "currency", currency: "USD" };

/**
 * Settings → Art providers: the person's own keys per provider (Codex uses the
 * ChatGPT plan and needs none), which provider makes each lane, and the daily
 * spend limit every paid generation counts against.
 */
export function GameArtSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentQuery(gameEnvironment.artProviders({ environmentId, input: {} }));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const [error, setError] = useState<string | null>(null);
  // Every commit is sent: each patch names its own keys, so two saves never clobber each other,
  // and a key pasted while another is still being checked must not be dropped.
  const save = async (patch: ServerSettingsPatch) => {
    setError(null);
    const saved = await update({ environmentId, input: { patch } });
    if (saved._tag === "Failure") setError(String(squashAtomCommandFailure(saved)));
    // A key saved or cleared changes which providers are ready.
    providers.refresh();
  };
  const statusOf = (provider: GameArtProviderId) =>
    providers.data?.providers.find((entry) => entry.provider === provider) ?? null;
  // One lane per patch: the server merges it into the saved map, so a second pick sent before the
  // first one's settings arrive keeps both, and auto is saved as itself (a lane left out of a
  // patch is kept, so leaving it out would never clear a choice).
  const setLane = (lane: GameArtLane, choice: GameArtLaneChoice) => {
    void save({ gameArtLanes: { [lane]: choice } });
  };
  const spent = providers.data?.spentTodayUsd;
  return (
    <SettingsSection id="art-providers" title="Art providers">
      <div className="space-y-1 px-4 py-3 text-xs text-muted-foreground">
        <p>
          Each kind of asset goes to the provider that makes it best, on your own keys or your
          ChatGPT plan through Codex. Keys are kept in this environment&apos;s secret store and are
          never shown.
        </p>
        <p>
          Generated assets are yours on a paid plan; free plans do not allow commercial use.
          ElevenLabs music has a studio-size limit; read its terms before you ship.
        </p>
      </div>
      {error ? (
        <p role="alert" className="px-4 text-sm whitespace-pre-wrap text-destructive">
          {error}
        </p>
      ) : null}
      {SHOWN_PROVIDERS.map((provider) => {
        const info = GAME_ART_PROVIDERS[provider];
        const status = statusOf(provider);
        const keySetting = info.keySetting;
        const configured = keySetting === null ? false : settings[keySetting].length > 0;
        return (
          <SettingsRow
            key={provider}
            title={info.label}
            description={
              keySetting === null
                ? `${lanesLine(provider)} Uses your ChatGPT plan through Codex; no key needed.`
                : info.note === undefined
                  ? lanesLine(provider)
                  : `${lanesLine(provider)} ${info.note}`
            }
            status={
              status === null ? null : (
                <Badge variant={status.ready ? "success" : "outline"} size="sm">
                  {status.ready ? "Ready" : "Not set up"}
                </Badge>
              )
            }
          >
            <div className="flex min-w-0 flex-col gap-1.5 text-sm">
              {keySetting === null ? null : (
                <div className="flex flex-wrap gap-2">
                  <SecretInput
                    aria-label={`${info.label} key`}
                    configured={configured}
                    value=""
                    disabled={!canWrite}
                    placeholder="Paste the key"
                    onCommit={(next) => {
                      if (next !== "") void save({ [keySetting]: next });
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canWrite || !configured}
                    onClick={() => void save({ [keySetting]: "" })}
                  >
                    Clear
                  </Button>
                </div>
              )}
              {status === null || status.message === "" ? null : (
                <p className="text-xs whitespace-pre-wrap text-muted-foreground">
                  {status.message}
                </p>
              )}
              <div>
                <Button
                  size="xs"
                  variant="ghost"
                  render={<a href={info.site} target="_blank" rel="noreferrer" />}
                >
                  {keySetting === null ? "About Codex" : "Get a key"}
                  <ExternalLinkIcon aria-hidden />
                </Button>
              </div>
            </div>
          </SettingsRow>
        );
      })}
      <SettingsRow
        title="Provider per kind of asset"
        description="Auto uses the first ready provider in Kurambit's order. The agent never switches it for you."
      >
        <div className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          {GAME_ART_LANES.map((lane) => {
            const choice = settings.gameArtLanes[lane] ?? "auto";
            const auto = providers.data?.lanes[lane];
            const autoLabel =
              auto === undefined
                ? "Auto"
                : auto === null
                  ? "Auto (none ready)"
                  : `Auto (${providerLabel(auto)})`;
            const options = SHOWN_PROVIDERS.filter((provider) =>
              GAME_ART_PROVIDERS[provider].lanes.includes(lane),
            );
            return (
              <label key={lane} className="flex items-center justify-between gap-2">
                <span>{GAME_ART_LANE_LABELS[lane]}</span>
                <Select
                  value={choice}
                  disabled={!canWrite}
                  onValueChange={(value) => {
                    const picked =
                      value === "auto" ? "auto" : options.find((provider) => provider === value);
                    if (picked !== undefined) setLane(lane, picked);
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-44"
                    aria-label={`Provider for ${GAME_ART_LANE_LABELS[lane]}`}
                  >
                    <SelectValue>
                      {choice === "auto" ? autoLabel : providerLabel(choice)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="auto">
                      {autoLabel}
                    </SelectItem>
                    {options.map((provider) => (
                      <SelectItem hideIndicator key={provider} value={provider}>
                        {providerLabel(provider)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
            );
          })}
        </div>
      </SettingsRow>
      <SettingsRow
        title="Daily limit"
        description={
          spent === undefined
            ? "What generated art may cost per day across every game. A paid generation over it is refused, with the number."
            : `What generated art may cost per day across every game. Spent today: ${formatUsd(spent)}.`
        }
        control={
          <NumberField
            value={settings.gameArtDailyLimitUsd}
            min={0}
            max={1000}
            step={1}
            format={USD}
            size="sm"
            className="w-28"
            disabled={!canWrite}
            onValueCommitted={(value) => {
              if (value !== null && value !== settings.gameArtDailyLimitUsd)
                void save({ gameArtDailyLimitUsd: value });
            }}
          >
            <NumberFieldGroup>
              <NumberFieldInput aria-label="Daily limit in US dollars" />
            </NumberFieldGroup>
          </NumberField>
        }
      />
    </SettingsSection>
  );
}
