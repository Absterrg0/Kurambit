import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { PaletteIcon, WalletIcon } from "lucide-react";
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
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { StatusDot } from "../ui/status-dot";
import { SettingsKeyRow } from "./SettingsKeyRow";
import { InlineButton } from "../ui/button";
import { Text } from "../ui/text";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  scrollToSettingsTarget,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

// The Kurambit plan is one more provider once it exists; until then it is not offered.
const SHOWN_PROVIDERS = (
  Object.keys(GAME_ART_PROVIDERS) as ReadonlyArray<GameArtProviderId>
).filter((provider) => provider !== "kurambit");

const LANE_LIST = new Intl.ListFormat("en", { type: "conjunction" });
// What a provider makes, as things in a sentence: "Makes images and textures."
const GAME_ART_LANE_PLURALS = {
  image: "images",
  character: "characters",
  creature: "creatures",
  model: "models",
  texture: "textures",
  sfx: "sound effects",
  music: "music",
  voice: "voices",
  motion: "motion",
} as const satisfies Record<GameArtLane, string>;
const lanesLine = (provider: GameArtProviderId) =>
  `Makes ${LANE_LIST.format(
    GAME_ART_PROVIDERS[provider].lanes.map((lane) => GAME_ART_LANE_PLURALS[lane]),
  )}.`;

// The lane picker is narrow; "Codex (ChatGPT plan)" inside it truncated.
const shortProviderLabel = (provider: GameArtProviderId) =>
  provider === "codex" ? "Codex" : providerLabel(provider);

const providerAnchor = (provider: GameArtProviderId) => `art-provider-${provider}`;

const USD: Intl.NumberFormatOptions = { style: "currency", currency: "USD" };

/** Settings → Art providers, for the one computer the settings are scoped to. */
export function GameArtSettingsPanel() {
  const { environment, scope } = useSettingsScope();
  const environmentId =
    scope.environmentIds.length === 1 ? (environment?.environmentId ?? null) : null;
  return (
    <SettingsPageContainer description="Who makes each kind of asset your agent asks for. Auto takes the first ready provider; the agent never switches it for you.">
      {environmentId === null ? (
        <Text variant="body" tone="muted" render={<p className="px-3 sm:px-4" />}>
          {scope.environmentIds.length <= 1
            ? "Connecting…"
            : "Art providers belong to one computer. Choose it above."}
        </Text>
      ) : (
        <GameArtSettings key={environmentId} environmentId={environmentId} />
      )}
    </SettingsPageContainer>
  );
}

/**
 * Readiness by kind of asset first, since that is what a game asks for; then the
 * providers that kind waits on, each with its own terms; then the daily spend limit
 * every paid generation counts against.
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
  // The providers a waiting lane could use, each a link to its row below.
  const providerLinks = (options: ReadonlyArray<GameArtProviderId>) =>
    options.map((provider, index) => (
      <span key={provider}>
        {index === 0 ? null : index === options.length - 1 ? " or " : ", "}
        <InlineButton
          tone="link"
          className="inline align-baseline"
          aria-label={`Set up ${providerLabel(provider)}`}
          onClick={() => scrollToSettingsTarget(providerAnchor(provider))}
        >
          {shortProviderLabel(provider)}
        </InlineButton>
      </span>
    ));
  return (
    <>
      <SettingsSection id="art-lanes" title="Each kind of asset">
        {GAME_ART_LANES.map((lane) => {
          const choice = settings.gameArtLanes[lane] ?? "auto";
          const auto = providers.data?.lanes[lane];
          const options = SHOWN_PROVIDERS.filter((provider) =>
            GAME_ART_PROVIDERS[provider].lanes.includes(lane),
          );
          const waiting = options.filter((provider) => statusOf(provider)?.ready !== true);
          const description =
            choice !== "auto" ? (
              statusOf(choice)?.ready === true ? (
                `Always ${shortProviderLabel(choice)}.`
              ) : (
                <>Always {providerLinks([choice])}, which is not ready yet.</>
              )
            ) : auto === undefined ? (
              "Checking…"
            ) : auto === null ? (
              <>Needs a key from {providerLinks(waiting)}.</>
            ) : (
              `${shortProviderLabel(auto)} makes it.`
            );
          const ready = choice === "auto" ? auto != null : statusOf(choice)?.ready === true;
          return (
            <SettingsRow
              key={lane}
              inlineControl
              title={GAME_ART_LANE_LABELS[lane]}
              description={
                <span className="flex items-center gap-1.5">
                  <StatusDot framed tone={ready ? "success" : "neutral"} />
                  <span className="min-w-0">{description}</span>
                </span>
              }
              control={
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
                    className="w-36"
                    aria-label={`Provider for ${GAME_ART_LANE_LABELS[lane]}`}
                  >
                    <SelectValue>
                      {choice === "auto" ? "Auto" : shortProviderLabel(choice)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="auto">
                      Auto
                    </SelectItem>
                    {options.map((provider) => (
                      <SelectItem hideIndicator key={provider} value={provider}>
                        {providerLabel(provider)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          );
        })}
      </SettingsSection>
      <SettingsSection id="art-providers" title="Providers">
        <Text variant="meta" tone="muted" render={<p className="px-4 py-3 text-pretty" />}>
          What a provider makes is yours on its paid plan; free plans do not allow commercial use.
          Keys stay in this computer&apos;s secret store.
        </Text>
        {error ? (
          <Text
            variant="body"
            tone="destructive"
            render={<p role="alert" className="px-4 whitespace-pre-wrap" />}
          >
            {error}
          </Text>
        ) : null}
        {SHOWN_PROVIDERS.map((provider) => {
          const info = GAME_ART_PROVIDERS[provider];
          const status = statusOf(provider);
          const keySetting = info.keySetting;
          const configured = keySetting === null ? null : settings[keySetting].length > 0;
          // A missing key is the ordinary state, not a fault: a grey dot, and the server's
          // "No key saved." is left out because the label already says it.
          const state =
            status === null
              ? { tone: "neutral" as const, label: "Checking…" }
              : status.ready
                ? { tone: "success" as const, label: "Ready" }
                : configured === false
                  ? { tone: "neutral" as const, label: "No key" }
                  : { tone: "warning" as const, label: "Not ready" };
          return (
            <SettingsKeyRow
              key={provider}
              id={providerAnchor(provider)}
              icon={<PaletteIcon />}
              title={info.label}
              description={
                keySetting === null
                  ? `${lanesLine(provider)} Uses your ChatGPT plan through Codex; no key needed.`
                  : info.note === undefined
                    ? lanesLine(provider)
                    : `${lanesLine(provider)} ${info.note}`
              }
              link={{ href: info.site, label: keySetting === null ? "About Codex" : "Get a key" }}
              status={state}
              message={
                status !== null && !status.ready && configured !== false ? status.message : null
              }
              configured={configured}
              canWrite={canWrite}
              onSave={(next) => {
                if (keySetting !== null) void save({ [keySetting]: next });
              }}
              onClear={() => {
                if (keySetting !== null) void save({ [keySetting]: "" });
              }}
            />
          );
        })}
      </SettingsSection>
      <SettingsSection id="art-spending" title="Spending">
        <SettingsRow
          id="art-daily-limit"
          icon={<WalletIcon />}
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
    </>
  );
}
