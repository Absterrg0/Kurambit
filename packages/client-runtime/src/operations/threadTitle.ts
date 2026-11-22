export interface ThreadTitleSeedInput {
  readonly text: string;
  readonly attachments: ReadonlyArray<{ readonly name: string }>;
  readonly fallbackLabels?: ReadonlyArray<string | null | undefined>;
}
