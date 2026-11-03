# Kurambit brand

How Kurambit speaks and looks outside the app: the site, social profiles, link cards and anything
written for launch. The app's own theme is in [Web UI](../../docs/internals/web-ui.md); the icon
pipeline is in [assets](../../assets/README.md).

## What we say

**Descriptor:** The game harness for coding agents.

**Headline:** Your coding agent, now a game studio.

**One line:** Describe a game. Your agent builds it in Godot and Blender; Kurambit plays every
build, judges it blind against the last one, and keeps only what makes the game better.

The harness is the product, so the story is what it does around the model:

1. **It plays every build.** A separate tester session plays each build before you see it.
2. **It judges blind.** Each build is compared with the one before it, blind and in both orders,
   so a worse build never lands.
3. **It keeps going.** A run keeps building, playing and judging until its budget ends. Brief it
   tonight; wake up to a better game.

Underneath: it runs on the agent you already pay for (Codex, Claude Code, Cursor, OpenCode or any
ACP agent), the game is a real Godot project with its Blender sources in a git repository you own,
and Kurambit is open source under MIT.

Reuse the lines the site already carries before writing new ones:

| Where        | Line                                        |
| ------------ | ------------------------------------------- |
| Hero         | Your coding agent, now a game studio.       |
| Agents       | Runs on the agent you already pay for.      |
| How it works | Every build is played before you see it.    |
| You direct   | You direct. It does the rounds.             |
| Overnight    | Brief it tonight. Wake up to a better game. |
| Waitlist     | Join the waitlist.                          |

## Voice

- Plain verbs for what happens: builds, plays, judges, keeps, throws away. No "AI-powered",
  "revolutionary", "magic" or "10x".
- Sentence case. Headlines end in a full stop.
- No caps-tracked eyebrows, no single accented word in a headline, no arrows or emoji in buttons,
  no pills.
- Talk to the person making the game: you direct, your agent, your game.
- Only claim what ships. Until launch the call to action is the waitlist.
- The name is always "Kurambit": never all caps, never letterspaced.

## Type

| Face             | Use                                             | Setting                             |
| ---------------- | ----------------------------------------------- | ----------------------------------- |
| Redaction        | Headlines and brand moments                     | 400, tracking −0.02em, leading 0.98 |
| Redaction Italic | Subheads and any line that speaks to the reader | 400, leading about 1.3              |
| Geist            | Interface and body copy                         | 400–600, 17px on 1.6                |
| Geist Mono       | Small facts: URLs, build ids, times             | 400, never as a caps eyebrow        |

Headlines take a short brush stroke under them (ink on the hero, vermilion on section heads). The
font files and their OFL licences are in [site/fonts](site/fonts). They are subset to Latin and
common punctuation, and browsers cache them for 30 days, so a changed font needs a new file name.

## Colour

The site is washi paper with ink and one vermilion. Vermilion marks one thing per view: the call to
action, the fox's tail or a seal.

| Token          | Hex       | Use                                      |
| -------------- | --------- | ---------------------------------------- |
| Paper          | `#ede6d7` | The sheet; always under the washi grain  |
| Desk           | `#ddd3bf` | The surface beyond the sheet's edges     |
| Sheet          | `#f9f5ec` | Raised paper: the nav, fields            |
| Ink            | `#171511` | Text and brush; pixel art uses `#141412` |
| Ink 2          | `#36322b` | Subheads                                 |
| Pencil         | `#6c665b` | Quiet detail                             |
| Vermilion      | `#e2582a` | The one accent                           |
| Vermilion deep | `#c9461b` | Vermilion on hover and in small text     |

The app's Sumi theme shares the ink and vermilion but uses its own neutrals; see
[its stylesheet](../web/src/index.css).

## Marks

- **The ink fox** ([kurambit-mark.png](../../assets/brand/kurambit-mark.png)): half solid ink, half
  outline, vermilion tail. The full figure, for large moments.
- **The fox head** ([kurambit-head.png](../../assets/brand/kurambit-head.png), `-light` for dark
  grounds): avatars, favicons, the nav.
- **The app icon** ([assets/prod](../../assets/prod)): the head on paper with a vermilion crescent
  seal.
- **Pixel art:** the fox and the "Kurambit" wordmark (with a vermilion square for its full stop)
  dithered into square ink cells on an 8×8 Bayer grid. It is the site's signature; use it large and
  keep the cells at least 4px where it will be seen.

Print the fox only in ink, paper or vermilion. No outlines, gradients, drop shadows or photographs
behind it.

## Social kit

| File                                                         | Size     | Where it goes                              |
| ------------------------------------------------------------ | -------- | ------------------------------------------ |
| [social/avatar.png](social/avatar.png)                       | 800×800  | X, GitHub, Discord: anywhere cropped round |
| [social/avatar-paper.png](social/avatar-paper.png)           | 800×800  | The same on paper, matching the app icon   |
| [social/x-header.png](social/x-header.png)                   | 1500×500 | X header                                   |
| [social/x-header-wordmark.png](social/x-header-wordmark.png) | 1500×500 | Alternative X header                       |
| [social/github-social.png](social/github-social.png)         | 1280×640 | Repository Settings → Social preview       |
| [site/og.png](site/og.png)                                   | 1200×630 | kurambit.com's link card                   |

X lays the avatar over the header's bottom-left corner (about 400×170 at full size) and phones trim
the top and bottom edges, so header copy stays in the upper band and away from that corner.

The images are rendered from the HTML templates in [social](social), which share the site's fonts,
paper and dither. Edit a template, then run `apps/marketing/social/render.sh` (it needs Chrome;
set `CHROME` to use another binary). When `og.png` changes, bump its `?v=` in
[site/index.html](site/index.html) so link previews fetch the new one.

## Profile copy

**X bio (154 of 160):** The game harness for coding agents. Your agent builds the game in Godot and
Blender; Kurambit plays every build and keeps only what's better. Open source.

**GitHub About:** The game harness for coding agents. Codex, Claude Code or any ACP agent builds
your game in Godot and Blender; Kurambit plays every build and keeps only what makes it better.

**GitHub topics:** `gamedev`, `godot`, `blender`, `coding-agents`, `ai-agents`, `claude-code`,
`codex`, `acp`, `game-development`.

**Website:** kurambit.com
