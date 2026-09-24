# Claude Changes Log — Muse Minimax Director V1.4 / Refine V2

## 2026-09-24 — Fixed: Director dropdowns hid a missing saved value; example workflow pointed at a moved upscaler file

**Reproduction:** on a fresh RunPod install, the example workflow still referenced
`minimax_h3_latent_upscaler_3d_fp16.safetensors`. The upscaler's author moved/renamed it on
Hugging Face (2026-09-17, "Organize checkpoints into versioned release folder") to
`minimax_h3_latent_upscaler_3d_conv_v1/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors`
— byte-identical file (SHA-256 043e5a48…55c2), so the old link 404'd. With only the new file
installed, the Director's Upscale Model box *displayed* the new file but the node still held
the old name, so ComfyUI kept flagging a missing model, and re-picking the only option did
nothing.

**Root cause:** `_selectRow` (js/muse_minimax_director.js) only marks an option selected when
it equals `widget.value`. A saved value not in the list leaves no option selected, the browser
shows the first one, and choosing that same option never fires `change`.

**Fix:**
- `_selectRow` now adds a "⚠ missing: <name>" option, selected, when the saved value isn't in
  the list — so the box shows the truth, and picking a real file is a real change that saves.
- Example workflow: Director + Refine upscaler widgets and the Model Links note updated to the
  new filename/URL (bf16/fp32 links too); removed the optional crt-nodes `SaveTextWithPath`
  node so the example loads without a missing-node-pack error.

## 2026-09-08 00:39 BST — Fixed: sentence-level speaker controls weakly attached voice references after dialogue

**Reproduction:** two visible female character references, two distinct Voice Reference
audio clips, and one sentence assigned to each character compiled correct Audio-to-Subject
definitions, but the rendered voices crossed or ignored the supplied timbre. Replacing one
clip with an unmistakable male voice produced two female voices, ruling out a simple audio
tensor swap and showing that H3 was falling back to visual voice priors.

**Root cause:** the newer per-sentence `dialogueSpeakers` path compiled dialogue as
`<d>[Language] ...</d> (Sx)`. The official Ref2VA structure binds the visible subject and
global speaker before the vocal event: `<Subject N> (Sx) ... <d>...</d>`. The older
whole-CUT speaker path already did this; only the sentence-level path was malformed.

**Fix:** `_wrap_dialogue` now optionally accepts corresponding Subject IDs. In
Reference/Hybrid sentence-level compilation it emits
`<Subject N> (Sx): <d>[Language] ...</d>` for every assigned quoted sentence. First/Last
Frame mode has no Subject abstraction and retains its existing event-order `(Sx)` form.
Audio loading, dictionary order, retention modes, and Audio-to-Subject definitions were
not changed; inspection confirmed those were already ordered correctly.

**Verification:** Python syntax compilation plus focused dialogue-wrapper checks cover two
separate subjects, per-sentence attribution, and the unchanged no-Subject fallback. A full
render should be repeated with the same two-character/two-voice test after restarting
ComfyUI so the updated module is loaded.

## 2026-09-06 — Fixed: Refine V2 could continue a Seed Hunt candidate against the wrong sigma schedule, producing garbled audio at the Stage-2 seam

**Root cause, confirmed via a real reproducible test, not a guess:** `MuseMinimaxRefineV2`
rebuilds the full sigma schedule for its own Stage-2 continuation pass from its **own**
`steps` widget (`BasicScheduler(..., steps=steps)`), while only restoring the *split
point* (`_muse_first_pass_steps_used`) from the picked candidate's own embedded metadata.
If the Refine node's `steps` widget doesn't happen to match the total step count the
Director actually generated that candidate with, the "remaining schedule" Refine
computes is a genuinely different set of sigma values than what the Stage-1 latent's
real noise level corresponds to — a real numerical mismatch, not a quality-only issue.

**How this was actually diagnosed:** confirmed reproducible twice on the same seed
(Director `steps=10`, Refine `steps=8` — mismatched) as garbled audio right around the
Stage-2 continuation point; confirmed clean on the Director's own single-pass path
(no Refine involved, so no mismatch possible); confirmed clean on a separate
Combo V2 test purely because its own Director and Refine widgets both happened to be
set to the same value (8 and 8). Andy caught the actual mismatch by directly comparing
widget values side by side between two saved workflows — manually setting Refine's
`steps` to match the Director's (10) immediately fixed the same failing test. Several
earlier theories this session (temporal chunking, ref_audio wiring, V1.4-vs-Combo-V2
code differences) were investigated and ruled out along the way; none of them were it.

**The fix:** the Director now also embeds the real total step count on the candidate
latent (`_muse_steps_used`), the same pattern already used for `_muse_seed_used` and
`_muse_first_pass_steps_used`. Refine V2 now restores and uses that value
(`resolved_steps`) instead of its own local `steps` widget when rebuilding the
schedule for both the sequential multi-chunk continuation path and the main per-chunk
refine call — so it's correct automatically regardless of what its own widget says.

**Status: confirmed working end-to-end, `steps` widget now hidden.** First
confirmation attempt after a restart still showed the old behavior — turned out a
second, stale, non-git-tracked copy of the Director (`custom_nodes/
MiniMaxH3-Director-V1.4`, last touched 2026-09-03, missing several other fixes too)
was silently winning the `MuseMinimaxDirectorV1_4` class registration over this repo's
own copy — real folder name collision, not a code bug, and it meant every "Director"
run that whole evening was actually going through months-old unpatched code regardless
of what got edited here. Moved that stale folder out of `custom_nodes` (to
`F:\Custom Node Backup`) to remove the collision; after that, a real restart, and a
fresh Seed Hunt candidate, the Refine V2 log line correctly read `steps=10` (matching
the Director, not Refine's own mismatched `steps=8` widget), and the audio came out
clean. `steps` is now hidden on Refine V2's panel the same way `seed` and
`two_stage_first_pass_steps` already are (kept in the schema for saved-workflow
positional compatibility, just no longer user-editable) — same day, once confirmed.

**Also fixed on Combo V2** (`Muse-MiniMax-Director-Combo-V2/muse_minimax_director.py`,
its own changelog has the matching entry) — it embeds candidates via the identical
pattern (ported from V1.4 earlier the same day) and shares the same `MuseMinimaxRefineV2`
node, so it had the exact same latent bug; only reason it didn't show up in testing is
that Combo V2's own Director and Refine widgets happened to already match (8 and 8).

Files touched: `muse_minimax_director.py`, `muse_minimax_refine_v2.py`.

## 2026-09-06 (same day) — UI: Settings section always visible, no longer hidden behind a gear icon

**What changed:** the Director's timeline UI had a "📷 References" heading with a
tiny ⚙ gear button that toggled the Timeline save/load controls and Analyze Backend
settings hidden/shown — squeezed in between the heading and the actual reference
picture grid when open. Real user feedback (a YouTube comment) confirmed nobody
noticed the gear existed. Replaced with a permanently visible "⚙️ Settings" section,
placed *above* References entirely — so References is now immediately followed by
its own picture grid with nothing in between, and Settings can't be missed.

No data/widget changes — this is display-only, so it applies automatically to any
already-saved workflow the moment someone updates and reopens the node, nothing needs
to be rebuilt.

Files touched: `js/muse_minimax_director.js`.


## 2026-09-08 01:26 BST  Aligned the complete Voice Reference prompt chain with MiniMax official Ref2VA guidance

The remaining generated Voice Reference prose was audited against the official Ref2VA
guide. The compiler now uses the official retention meaning: the target speaker follows
each Audio reference's voice timbre and measured delivery without copying the original
signal. It also names every Audio-to-Subject voice relationship in the summary and cites
the matching Audio reference at the actual spoken event, producing an explicit chain from
Subject N to Sx to Audio N to dialogue.

Only standalone Ref Audio with Voice Reference retention receives this voice-timbre chain.
Fully copied lip-sync/song audio, partial and weak audio modes, carry audio, First/Last
Frame fallback behavior, and physical reference-audio ordering remain unchanged.

Verification: Python syntax compilation, git diff validation, and focused source checks
passed. A restarted ComfyUI render is still required for perceptual confirmation because
Ref2VA voice adherence is generative rather than deterministic.


## 2026-09-08 01:36 BST  Removed duplicated speech verb from Voice Reference vocal events

The first official-format pass inserted an automatic says before each dialogue even
though the user's CUT prose commonly already says says, replies, asks, or another speech
verb. This produced repetitive text such as says, Subject 1 ... says:.

The generated binding now ends after the matching Audio reference with a colon:
Subject N (Sx), using the voice timbre and measured delivery from Audio N: dialogue.
The user's own speech verb remains untouched. Subject, speaker, Audio, language, dialogue,
retention, and summary mappings are otherwise unchanged.

Verification: exact single replacement, Python syntax compilation, and git diff check.
