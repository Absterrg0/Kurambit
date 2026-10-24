## The game's run state, autoloaded as `GameState` so every scene and the
## StudioProbe read one object instead of walking a scene tree.
##
## The Blank starter ships no gameplay, so this starts with no values. Add the
## public primitive variables the game needs; `StudioProbe` reports them, and a
## leading underscore keeps a helper out of that snapshot.
extends Node
