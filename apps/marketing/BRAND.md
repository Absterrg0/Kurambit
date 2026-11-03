# Kurambit brand

How Kurambit speaks and looks outside the app: the site, social profiles, link cards and anything
written for launch. The app's own theme is in [Web UI](../../docs/internals/web-ui.md); the icon
pipeline is in [assets](../../assets/README.md).

## What we say

**Headline:** Nobody made the game you want. So make it.

**One line:** Describe a game in plain words. Kurambit has the coding agent you already use build
it, plays every build, judges it blind against the last one, and keeps only what got better.

The headline speaks to everyone who has carried a game around in their head; the harness is how it
gets made, so the story under it is what Kurambit does around the model:

1. **It plays every build.** A separate tester session plays each build before you see it.
2. **It judges blind.** Each build is compared with the one before it, blind and in both orders,
   so a worse build never lands.
3. **It keeps going.** A run keeps building, playing and judging until its budget ends.

Underneath: it runs on the agent you already pay for (Claude Code, Codex, Cursor, OpenCode or any
ACP agent), the game is a real Godot project with its Blender sources in a git repository you own,
and Kurambit is open source under MIT. Those are facts for the FAQ, `llms.txt` and structured data;
headlines and posts leave the engines out.

Supporting lines, one per post or section:

| Line                                       | Says                                |
| ------------------------------------------ | ----------------------------------- |
| Nobody made the game you want. So make it. | The promise                         |
| Describe it like you'd tell a friend.      | No engine or code to learn          |
| It plays every build before you do.        | The tester                          |
| A worse build never lands.                 | The blind judge                     |
| Runs on the agent you already pay for.     | No new model or subscription        |
| Join the waitlist.                         | The one call to action until launch |

Lines kept for replies and one-off posts: "Player two: your coding agent.", "Choose your fighter."
(over the agent logos), "A save point on every build." and "Your group chat has heard this idea
enough."

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
- **The lockup** ([brand/logo](brand/logo)): the fox head beside "Kurambit" in Redaction, and the
  pixel wordmark with its vermilion full stop, in ink and in a light version for dark grounds.
- **Pixel art:** the fox, the wordmark and the shelf dithered into square ink cells on an 8×8 Bayer
  grid. It is the site's signature; use it large and keep the cells at least 4px where it will be
  seen.
- **The shelf:** game cartridges in crisp pixel art with one empty slot, dashed in vermilion,
  where the fox stands: the game nobody made yet. It is the headline's picture. Headers and banners
  are a wall of it, edge to edge, so any crop still reads; posts show a single shelf.

Print the fox only in ink, paper or vermilion. No outlines, gradients, drop shadows or photographs
behind it. The ground is washi paper; for dark grounds it is ink (`#161411`) with the fox in
`#efe7d6`.

## Brand kit

Everything in [brand](brand) is rendered from the HTML templates in [brand/src](brand/src), which
share the site's fonts, paper and dither. The card template lays itself out for any size: copy
beside the picture on landscape cards, the picture over the copy on portrait posts and stories. The
shelf template draws the headers and banners, and og.html the link card.

| Folder                       | Files                                          | Size                 |
| ---------------------------- | ---------------------------------------------- | -------------------- |
| [logo](brand/logo)           | Lockup and pixel wordmark, ink and light, PNG  | 1600×440, 2200×560   |
| [avatar](brand/avatar)       | Seal, paper, dark                              | 1024×1024            |
| [x](brand/x)                 | Header (paper, dark, with headline), six posts | 1500×500, 1600×900   |
| [instagram](brand/instagram) | Six posts as a carousel, two stories           | 1080×1350, 1080×1920 |
| [linkedin](brand/linkedin)   | Profile and company banners                    | 1584×396, 1128×191   |
| [youtube](brand/youtube)     | Channel banner                                 | 2560×1440            |
| [github](brand/github)       | Repository social preview                      | 1280×640             |
| [web](brand/web)             | The link card                                  | 1200×630             |

The link card is the fox's face, drawn in brush ink and cropped large over a vermilion sun, beside
the headline, signed with a small vermilion seal the way a woodblock print is.

Use the **seal** avatar everywhere a picture is cropped round: vermilion is the one colour that
stands out in a feed. Pair it with the paper X header. The posts run in order: make, tell, played,
better, agents, join.

Profile pictures cover the bottom-left corner of X and LinkedIn banners, so the empty slot sits
right of centre. Instagram's own buttons cover the top 250 and bottom 340 pixels of a story, so the
templates keep copy out of those areas. YouTube shows the whole banner only on televisions; the
empty slot stays inside the 1546×423 box that every device shows. In avatars the fox head sits in
the middle of the circle.

Change a line or a picture in a template, then run `apps/marketing/brand/src/render.sh` (it needs
Chrome, and Python 3 with Pillow; set `CHROME` to use another binary). The site serves its own link
card from [site/og.png](site/og.png); when that changes, bump its `?v=` in
[site/index.html](site/index.html) so link previews fetch the new one.

## Handles

Use one handle everywhere: **@kurambit_gg**, as on X, for Instagram, Threads, YouTube and TikTok.
Plain `@kurambit` is reserved on X and cannot be registered. On GitHub the `kurambit` organisation name was
free in November 2026; claim it for the repository.

## Profile copy

**X bio (143 of 160):** Nobody made the game you want. So make it. Kurambit runs on the coding
agent you already use, plays every build and keeps only what got better.

**Instagram bio (114 of 150):** Nobody made the game you want. So make it. Describe it in plain
words; your coding agent builds it. Waitlist open.

**LinkedIn tagline:** Nobody made the game you want. So make it, with the coding agent you already
use.

**GitHub About:** Nobody made the game you want. So make it. Kurambit runs on the coding agent you
already use, plays every build and keeps only what got better.

**GitHub topics:** `gamedev`, `godot`, `blender`, `coding-agents`, `ai-agents`, `claude-code`,
`codex`, `acp`, `game-development`.

**Website:** kurambit.com

## Post captions

1. **Make:** You've played it in your head for years. Describe it, and your coding agent builds it
   while Kurambit plays every build. Waitlist at kurambit.com.
2. **Tell:** No engine to learn, no code to write. "A fox who can only jump when it rains" is enough
   to start.
3. **Played:** A separate tester plays every build before you do, so a broken jump never reaches
   you.
4. **Better:** Each build is judged blind against the last one. The worse one is thrown away
   before you see it.
5. **Agents:** No new model to pay for. Kurambit runs on Claude Code, Codex, Cursor, OpenCode or any
   agent that speaks ACP, and one signed-in agent is enough for the whole loop.
6. **Join:** We are letting people in a few at a time, so everyone's first game gets made properly.
   kurambit.com
