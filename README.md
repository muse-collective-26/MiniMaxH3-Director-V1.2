# Muse Minimax Director V1.4

**Timeline-based director node for MiniMax H3 in ComfyUI, with Seed Hunt scouting, two-stage sampling, and hard-frozen chunk-boundary continuity**

Built by [Muse Collective](https://musecollective.co.uk) — write a single flowing script broken into CUTs, drop in reference character images/video/audio, and let the node handle chunking, prompt-per-chunk splitting, and reference-tag numbering for you.

This is a fork of [Muse Minimax Director](https://github.com/muse-collective-26/MiniMaxH3-Director) that adds independent per-candidate **Seed Hunt** toggles — scout up to 4 candidate seeds in one run at low resolution, then pick the best one and continue it at full resolution with the bundled [Muse Minimax Refine](#muse-minimax-refine-bundled) node — plus two-stage sampling and a VAE re-encode continuity mode that eliminates the visible jump at chunk boundaries on multi-chunk renders (see [Changelog](#changelog) and [Chunk continuity, in detail](#chunk-continuity-in-detail)). The original repo stays as the simpler, single-generation version; this one is for anyone who wants the scouting workflow, longer multi-chunk renders, or both.

This repository bundles **two** ComfyUI nodes — Muse Minimax Director V1.4 and its companion Muse Minimax Refine V2 (Beta-matched) — installed together as one package. See [Muse Minimax Refine (bundled)](#muse-minimax-refine-bundled) below for what it does and how to wire it up.

![ComfyUI Custom Node](https://img.shields.io/badge/ComfyUI-Custom%20Node-orange?style=flat-square)
![MiniMax H3](https://img.shields.io/badge/MiniMax-H3-blue?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

---

## Changelog

### v3.2.0 — 2026-09-06
- **Fixed: Refine V2 could continue a Seed Hunt candidate against the wrong sigma schedule, producing garbled audio right at the Stage-2 continuation seam.** Refine V2 rebuilt its Stage-2 sigma schedule from its own `steps` widget rather than the total step count the picked candidate was actually generated with — it only ever restored the *split point*, not the total. If those two numbers didn't happen to match, the "remaining schedule" Refine continued the Stage-1 latent against was a genuinely different set of sigma values than what that latent's real noise level corresponded to. Confirmed reproducible: Director `steps=10`, Refine `steps=8` produced garbled audio twice on the same seed; manually matching both to 10 fixed it immediately, which is how the mismatch itself was found. The Director now also embeds the real total step count on the candidate latent (`_muse_steps_used`, same pattern as the seed and first-pass-step values it already embeds), and Refine V2 always uses that instead of its own widget.
- **UI: Refine V2's `steps` widget is now hidden**, the same way its `seed` and first-pass-step widgets already are — it's fully automatic now, so leaving it visible and editable would only invite the exact same mismatch again for no benefit.
- **UI: the Director's Timeline settings (Save/Load, Analyze Backend provider) are no longer hidden behind a small gear icon.** Real user feedback confirmed the gear icon was easy to miss entirely. It's now its own permanently visible "⚙️ Settings" section, placed above References — so References is immediately followed by its own reference-picture grid, nothing in between.

### v3.1.0 — 2026-09-05
- **Reinstated Muse Minimax Refine V2 (Beta-matched) as this repository's one supported Refine node, reversing v3.0.0's retirement of it.** V2 is the node that actually matches this Director's own Two-Stage/Seed Hunt scouting mechanism — Refine V14 was shipped in v3.0.0 only because V2 had been lost to an accidental deletion at the time, not because it was the better fit. V2 has since been fully recovered (verified byte-for-byte against its own last compiled bytecode) and is the node going forward; V14, plain Refine, and Muse Model Route are no longer part of this package.
- **Fixed: `raw_latent_carry_test` on Refine V2 was silently ignored — the widget's real value never reached the actual carry logic.** `execute()` always passed a hardcoded `False` into the continuity code regardless of what the checkbox showed, so every multi-chunk refine silently fell back to the weaker pixel-VAE-reencoded carry no matter how it was set. This is very likely the real cause of an audible quality drop (garbled dialogue) right at a chunk seam on refined output. Also corrected the widget's own default (was `False`, contradicting the node's own module docstring, which already said it defaults on) to `True`, matching the Director's own default for the same setting.
- **Fixed a real VRAM stall on Low VRAM profile, Seed Hunt with 2+ candidates.** The shared memory-reservation system (H3AutoReserve, in the separate `ComfyUI-H3-Multishot` dependency) only ever ran its leftover-VRAM cleanup sweep on a given render shape's first pass in a session — every repeat candidate at the same resolution (which Seed Hunt always produces) skipped that sweep entirely, inheriting whatever was left resident from the previous candidate instead of a clean pool. Under real memory pressure (Low VRAM + GGUF) this reproduced as a full lock-up at 100% GPU with no progress, not just a slowdown. Fixed at the point that's actually re-entered per candidate — the Director's own Seed Hunt loop now resets that reservation system's memory before every extra candidate pass, confirmed by a full clean 4-candidate run with no stall (also holds steady, no accumulation, on Maximum Quality).
- **UI:** the drag/delete icons on each CUT block were stuck at their original small fixed size while the CUT label text next to them was already scaled up for overview readability — now sized to match. Also fixed the Generation card's Total Duration display going stale after Add Chunk / Delete Chunk (and the auto-insert-chunks-for-video shortcut) — those already correctly updated the underlying value, the on-screen slider/number next to it just never got told to refresh; it now does.
- **Updated example workflow** (`workflows/muse_minimax_h3_director_V1.4.json`, replacing the old one) — now demonstrates the current full stack: Muse MiniMax H3 Unified Loader → Director (Two-Stage Sampling, Seed Hunt with Latent-Only Scouting) → Refine V2, with Muse Run Stats dropped on the canvas. No longer wires through `MuseModelRoute` or Sol-Attn — neither is part of this stack anymore.

### v3.0.0
- **Fixed: reference videos were silently capped at 200 frames total, regardless of how long a trim window was actually requested.** A 30fps clip trimmed to 10 seconds needs 300 frames to cover that window; the old flat cap stopped decoding at 200 (~6.67s), so the back third of every reference video's motion was never loaded into the tensor H3 actually received — no error, no warning, just an incomplete reference. This was the real root cause of a reference video's motion appearing to be "followed for a few seconds, then abandoned," regardless of any prompt wording changed around it.
- **Fixed: reference video frames were also handed to H3 at the source's native frame rate, not resampled to H3's actual expected 24fps.** The stock H3 node treats every frame it receives as spaced 1/24th of a second apart; a 30fps (or any non-24fps) source was therefore played back at the wrong effective speed even within whatever portion did make it through the old cap. Reference videos are now resampled onto a genuine 24fps grid using each frame's real timestamp, correct regardless of the source's declared frame rate.
- **New: "Continue across chunks"** — an opt-in per-video-slot toggle (Reference mode only) that lets one long reference video (e.g. a 45-second performance) drive motion across an entire multi-chunk render. Set In/Out becomes the full performance's window; each chunk automatically carves its own correctly-timed slice out of it, using the same chunk boundaries the rest of the compiled prompt already uses. Includes a companion **"Insert Chunks to Cover This"** control that adds however many chunks are needed to cover a video's Set In/Out window automatically (and can trigger straight from editing Set Out, not just its own button), rather than requiring the total duration to be worked out and set by hand.
- **New: "Embed this clip's real audio over the final output"** — an opt-in per-video-slot toggle that literally overlays the source video's own real audio onto the finished output after generation, bypassing whatever H3 itself would have generated for that channel. Distinct from Audio State's `fully_copy`, which still asks H3 to *generate* matching audio (only ever as faithful as the model's own compliance) — this is a literal, guaranteed copy instead, trimmed to match however long the actual rendered output turns out to be. Not intended for Lip Sync (no word-level timing).
- **New: "Analyze First Frame"** — a per-video-slot button (Reference mode) that captures the frame at that video's current Set In point and generates a scene-anchor description — environment, key objects and their relative positions, colors, lighting — distinct from the existing per-character Analyze route, which only describes one main subject and would skip the surrounding scene entirely. Feeds automatically into the compiled prompt (prepended ahead of every CUT) once set, matching MiniMax's own documented guidance to establish scene anchors before describing new content — genuinely useful specifically when adding a new character into an existing scene, where getting a spatial detail wrong (e.g. which side an existing empty seat is actually on) produces a wrong result even with everything else correct.
- **Corrected several `retention_analysis` wordings that were being applied unconditionally regardless of the actual retention level selected**, in some cases directly contradicting it:
  - A reference video's retention line used to say "no visible scene, environment, or on-screen content from this video is reused" for every retention option, including `partially_preserved` ("duplicate video, replace character") — whose own official definition is the opposite of that sentence. Now branches per the actual selected level.
  - A standalone reference audio clip's retention line used to say "guides dialogue delivery without copying the original signal" for `partially_copy` too, whose own official definition is "part of the timeline... **is** copied" — a direct, confirmed-real contradiction that was affecting voice-clone accent accuracy on generated dialogue lines. Now branches per the official audio-marker definitions instead of one sentence for all three non-`fully_copy` levels.
- **Fixed a display bug** where a video's Retention dropdown could show the wrong label after a reload (a generic "partially preserved" instead of the clearer "duplicate video, replace character (recommended for editing)") despite the underlying value being identical either way — removed the duplicate option entirely rather than patch the selection logic.
- **Retired the old plain Refine, Refine V1.3, Refine V2, and Muse Model Route bundle.** Each was a companion to an earlier Director variant this release replaces outright — plain Refine paired with the original V1.2, V1.3 added its own First/Last Frame + Hybrid work, V2 was built for the separate TwoStage-Beta package's own scouting/continuity mechanism. Muse Minimax Refine V1.4 is this release's own matched companion. None of the retired nodes are gone — they're simply not part of this package going forward; anyone who needs one of them specifically can still get it from where it already lived.
- **Dependency note:** no new custom node package is required for any of the above. The only change is that `<Audio N>` bound to a reference video's own audio can now also read `partially_copy`/`weak_reference` correctly, and one new internal call (`MiniMaxH3SongMaskedAVContext`) is used — both already live inside **[ComfyUI-H3-Motion-Context-MultiRef](https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef)**, the same package already required for VAE Re-encode Carry. If you installed that a while ago, make sure your copy is up to date rather than installing anything new.

### v2.5.2
- **New diagnostic-only toggle: `vae_reencode_carry_video_only_test`.** Investigating a real, timed symptom (audio muddiness starting right around a chunk boundary and never recovering for the rest of the video). Isolates whether the carry mechanism's audio half is the cause by reproducing only the proven video-prefix/video-mask math directly (not calling `MiniMaxH3GeneratedAVMaskedContext`, which requires both streams present and always overwrites both) and leaving chunk 2's own audio latent + noise mask genuinely untouched — same `carry_n`/alignment/post-generation trim as the existing mechanism throughout. Only active when `vae_reencode_carry_test` is also on; existing behavior is completely unaffected when this stays off. Not a fix — a comparison tool to confirm where the real fix needs to go.

### v2.5.1
- **Refine V1.3: fixed a real crash in the keyframe rebuild added by v2.5.0** — it was building keyframe conditioning at the candidate's source resolution instead of the refine pass's own upscaled target resolution (computed later in the same function), causing the identical shape-mismatch crash the original two-stage sampling fix was for. Rebuild now happens after the upscale target is known, matching Director's own working order.
- **Refine V1.3: added reference audio (voice lock) support** — V1.2 never had a `ref_audios` input at all, so a candidate that used voice cloning always lost that lock on Stage 2 refine, whether or not this got noticed. New `ref_audio_1`/`ref_audio_2`/`ref_audio_3` optional inputs, plus three matching new outputs on MuseMinimaxDirector (`ref_audio_1_used`/`2_used`/`3_used`) so the exact same clips that fed the original generation can be wired straight into Refine. Retention mode doesn't matter — Voice Reference, Lip Sync, Partial Voice Match, and Weak Reference are all carried through identically; retention only ever changes the compiled prompt's own wording, never whether a clip is used.

### v2.5.0
- **New node: Muse Minimax Refine V1.3 (First/Last Frame + Hybrid Support)** — additive alongside V1.2, not a replacement for it. V1.2 has no concept of first_frame/last_frame keyframes at all; refining a First/Last Frame or Hybrid mode candidate through it silently dropped the keyframe lock, leaving Stage 2 free to drift. V1.3 rebuilds keyframe conditioning at its own refine resolution the same way MuseMinimaxDirector's own two-stage sampling fix (below) does — re-resizing and re-encoding the original keyframe images fresh, rather than reusing a stale-resolution latent. `model`, `first_frame`, and `last_frame` are all now optional inputs: leave them unconnected and V1.3 automatically picks up whichever checkpoint and keyframe images MuseMinimaxDirector actually used for the chosen candidate (embedded directly on candidate_N_latent) — no new wiring needed for existing Seed Hunt + Latent-Only Scouting workflows. Works with the multi-chunk scout-bundle path too, each chunk's own keyframes intact.

### v2.4.0
- **Fixed: two-stage sampling crashed on First/Last Frame and Hybrid mode** (`shape mismatch: value tensor of shape [...] cannot be broadcast to indexing result of shape [...]`). Stage 2 upscales the video latent to a new resolution but was reusing Stage 1's keyframe conditioning unchanged — first_frame/last_frame get baked into the conditioning as VAE-encoded latents at Stage 1's own resolution, so Stage 2's upscaled video no longer matched. Fixed by re-resizing the original keyframe images to the new resolution and re-encoding them fresh for Stage 2. Covers plain First/Last Frame, the Reference-mode "hybrid_continuation" chunk-lock, and Hybrid mode alike.
- **First Frame / Last Frame now have their own independent upload slots**, instead of First/Last Frame mode borrowing Ref 1 / Ref 2. The underlying H3 nodes already keep first_frame/last_frame on a completely separate conditioning channel from the reference images, so there was no real reason the two had to share storage — that was only ever a UI shortcut, and it meant you couldn't use Ref 1/2 as character references and a first/last frame pin at the same time. Hybrid mode already had its own independent slots for this; First/Last Frame mode now uses the exact same storage.
- **Location is now per-chunk, and coexists with the chunk-to-chunk continuity anchor instead of replacing it.** Previously, a single global background reference image only ever applied to chunk 1 — from chunk 2 onward, the same slot silently switched to holding the previous chunk's own last rendered frame instead, dropping the actual background photo for the rest of the video. Now the last-frame anchor and a Location image are sent together on every continuation chunk, and you can add up to 6 additional Location slots, each set to take over "from chunk #" onward — useful both for a video that stays in one place for a long multi-chunk run (upload the location once, it now genuinely holds for every chunk) and for a story that moves to a new location partway through.
- **Reference image slots reduced from 9 to 7.** The underlying MiniMax reference-image pool only has 9 slots total, shared between character references, the continuity anchor, and Location — with the anchor and Location now deliberately coexisting rather than one replacing the other, a continuation chunk needs `characters + anchor + Location` to fit in 9 slots at once. 7 is the number that always leaves room for both, on every chunk, so nothing silently gets dropped the way a background image used to.
- **Reference UI reorganized into three columns**: First Frame / Last Frame (only shown in First/Last Frame and Hybrid modes, now equal-size boxes instead of thin slits), Ref 1-7 (evenly sized, Analyze button slightly taller so the image itself is visible), and Location (primary slot + addable extras with their own "from chunk #" control). Reference video and reference audio are unchanged.

### v2.3.4
- **Seed Hunt: added an explicit "Enable Seed Hunt" on/off switch.** Previously "Candidates to scout" alone decided whether Seed Hunt ran — set it above 1 and Seed Hunt silently switched on, blocking the main `images`/`audio` outputs and rerouting real output to `candidate_1..4` instead, with nothing in the UI showing that state change. That's a real trap for a workflow other people will use without knowing the internals: with the switch off, `candidate_count` is ignored entirely — always exactly one normal run, straight to `images`/`audio`. With it on, `candidate_count` (1-4) picks how many candidates that scouting session covers, and even a count of 1 while explicitly toggled on still counts as a real Seed Hunt session (blocked main output, candidate_1 only) — not a silent fallback to plain single-pass behavior. "Candidates to scout" is now visually greyed out whenever the switch is off, so it's obvious it's inert rather than silently unused.

### v2.3.3
- **Muse Minimax Refine: hid the "control after generate" seed control.** It always needs to stay on `fixed` — Refine reuses the candidate's exact original seed to continue its noise schedule (see the seed widget's own tooltip), never a fresh roll — but ComfyUI's frontend auto-attaches this control to any widget named "seed" regardless of that. Left visible, it's a real trap: a viewer reported Refine silently restarting from scratch after this defaulted to "randomize" on load, and worked around it by hand. Now locked to `fixed` and hidden, on load and on node creation, so that failure mode isn't possible anymore.

### v2.3.2
- **Fixed: Refine wouldn't run at all — for any candidate — unless all 4 Seed Hunt candidates had been scouted.** Root cause: `MuseMinimaxDirectorV14`'s `candidate_N_latent` outputs used `ExecutionBlocker` to mark a candidate that never ran, but ComfyUI's own executor skips a node's function entirely if *any* of its inputs is an `ExecutionBlocker` — not just the input actually being used. Since Muse Minimax Refine V1.4 (Beta-matched) has all four `candidate_N_latent` sockets wired at once regardless of which one is picked, scouting fewer than 4 candidates meant 1-3 of those sockets always carried a blocker, silently preventing Refine from ever running — even when picking a candidate that *did* generate successfully. Unfilled candidate latents now use a plain marker dict instead, which Refine checks for itself and blocks on cleanly only when that specific slot is the one actually picked.

### v2.3.1
- **Seed Hunt: replaced the three independent Candidate 2/3/4 toggles with a single "Candidates to scout" count (1-4).** The old toggles let you tick e.g. only Candidate 4 and skip 2/3 — meaningless, since candidates are just different random seeds, and it read backwards ("Candidate 4" looked like "run 4" but actually meant "just slot 4, alone, skipping the rest"). The count always runs candidates 1..N in sequence, matching how everyone actually reads that control.
- **Fixed a stale-preview bug on unused Seed Hunt candidates.** A candidate that didn't run used to output a technically-valid but zero-length image/audio tensor instead of a clean block — a downstream Save/Preview node would silently accept the empty data and keep showing whatever it last displayed from an *earlier* run, easily mistaken for real output from the current one. Unused candidates now block the same way the latent outputs already did.

### v2.3.0
- **Type an exact CUT duration.** Each CUT's timeline label now shows an editable box instead of static "~1.5s" text — type any value to 2 decimal places (e.g. `1.54`) instead of being limited to the drag handle's coarser steps. Editing one CUT redistributes the difference proportionally across every other CUT in the chunk at once (not just its immediate neighbour), so a CUT near the end of a long chunk can still free up real room even if its one adjacent neighbour doesn't have much to give. Floor is 0.3s per CUT. A chunk with only one CUT has nothing to trade with, so it stays read-only.

### v2.2.1
- **Muse Model Route** is now bundled here too — a tiny utility node used by the example workflow to route the Reference or First/Last-Frame model into the Director's single `model` input depending on mode. It previously wasn't published anywhere, so anyone downloading the example workflow couldn't actually get it — that's fixed now.

### v2.2.0
- **Muse Minimax Refine V1.4 (Beta-matched) is now bundled in this same repository** instead of living separately — one install gets you both nodes. See [Muse Minimax Refine (bundled)](#muse-minimax-refine-bundled) for what it does.
- Refine's own module docstring was out of date (still described an older img2img-style pixel re-sample) — corrected to describe what the node actually does: a genuine latent-continuation Stage 2, picking up the candidate's own sigma schedule exactly where Stage 1 left off.

### v2.1.0
- **Seed Hunt: independent per-candidate toggles.** Replaces the old all-or-nothing Seed Hunt checkbox with three separate toggles — Candidate 2, Candidate 3, Candidate 4 (Sampling box) — so you can run exactly as many extra scouting passes as you actually want (1 through 4 total) instead of always paying for all 4. Candidate 1 always runs. Fully independent of Latent-Only Scouting — combine them however you like.
- **Latent-Only Scouting now works correctly on multi-chunk timelines.** Previously, a multi-chunk Seed Hunt + Latent-Only pass only ever kept the *last* chunk's Stage-1 latent, so Refine could only hi-res-fix the final chunk instead of the whole stitched video. Every chunk's own Stage-1 latent is now saved to a small scratch folder as it's generated; `candidate_N_latent` carries a reference to the whole set instead of a single tensor. Falls back to identical single-tensor behavior for a single-chunk timeline, so nothing changes there. (v2.2.0, above, is what actually lets Refine take advantage of this — the bundled Refine node is the version that knows how to read it.)

### v2.0.0
- **Two-stage sampling** (Sampling box, "Enable Two-Stage Sampling"). Runs the first few steps at a lower resolution, upscales the video latent directly (no VAE round-trip), then finishes the remaining steps at full resolution on the same continuous noise schedule. Optional — off keeps the original single-pass behavior exactly as before.
- **Chunk continuity — VAE re-encode carry** (Resolution box, "Enable VAE Re-encode Carry"). On a multi-chunk render, the previous chunk's actual final frames + audio are freshly VAE re-encoded (real ground-truth pixels, not a reused raw latent estimate) and hard-frozen as the next chunk's opening prefix, then trimmed after decode. Works with two-stage sampling on or off — see [Chunk continuity, in detail](#chunk-continuity-in-detail) for exactly how and why, including real before/after measurements. **Requires the [ComfyUI-H3-Motion-Context-MultiRef](https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef) custom node pack** — see [Requirements](#requirements).
- **Add Chunk / Delete Chunk** buttons on every chunk section, so you can add or remove a chunk directly instead of only via the Total Duration slider. Delete confirms first if the chunk still has CUT text in it.
- **Seed Hunt: Latent-Only Scouting** (Sampling box, two-stage sampling only) — stops each Seed Hunt pass after Stage 1 instead of also paying for the expensive Stage 2 upscale on all 4 candidates; wire `candidate_1..4_latent` into a compatible Refine node to only pay the Stage 2 cost on the one you actually pick.
- Reference Settings folded into the Resolution box (was its own box with only two rows in it).
- Shrinking Total Duration or Chunk Size now actually removes the trailing chunk(s) instead of leaving them stuck and invisible (confirms first if a chunk about to be dropped still has real CUT text).
- The node's own panel now grows/shrinks with its content reliably — fixed a real bug where it could grow unbounded on some workflows.
- **Updated example workflow** (`workflows/muse_minimax_h3_director_V1.4.json`, replacing the old Seed Hunt scouting one) — demonstrates Two-Stage Sampling and VAE Re-encode Carry instead.

### v1.1.0
- **Fixed a crash on old saved workflows.** If you'd saved a workflow before this update and it failed to load with an error mentioning `Cannot create property 'characters'`, that's fixed — the node now resets its timeline gracefully instead of blocking the whole workflow from loading. If you hit this, the safest fix is to delete the Muse Minimax Director node from your old workflow and add a fresh one in its place, then re-enter your references/CUTs.
- **Analyze button improvements:** it no longer leaks background/pose/setting details into character descriptions, and it now has its own settings (gear icon) so you can pick which vision provider/model it uses instead of being locked to a hidden default.
- **Reference video:** added a "duplicate video, replace character" retention option for people who want to reuse a reference video's motion/scene but swap in a different character.
- **Updated example workflow** (`workflows/muse_minimax_h3_director_scout_v1.json`) — now wired with **Patch Sol-Attn** as the active speed optimization. Based on direct same-seed testing, Sol-Attn was the only speed node that gave a real, consistent speed-up without any visible quality loss on hands/hair. The other speed nodes (Sage Attention variants, EasyCache, Spectrum) are left in the workflow but bypassed, so you can switch them on to compare for yourself — in our tests they either made no measurable difference or came with a quality cost.

---

## Powered by MiniMax H3

This node is a control layer built entirely on top of **MiniMax H3**, an open-weights omni-modal video generation model published by [MiniMax](https://www.minimax.io/). MiniMax H3 is the actual model doing every bit of the generation work here — this repository contains none of the model's weights, training code, or inference architecture. All of that lives in MiniMax H3 itself and in ComfyUI core's own stock support for it (`comfy_extras/nodes_minimax_h3.py`). What this node adds on top is a visual timeline/scripting layer, automatic chunking for videos longer than a single H3 generation, and correct handling of H3's reference-tag numbering — nothing more.

- **Model page:** [huggingface.co/MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3)
- **License (MiniMax H3 Community License Agreement):** [huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE)
- **Official prompt-writing guide:** [VIDEO_PROMPT_WRITING_GUIDE_ref_en.md](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)

You must download MiniMax H3's weights yourself, directly from the official source above, and you are bound by MiniMax's own license terms for using them — this node does not change, replace, or grant any rights over that license. See [Credits & Licensing](#credits--licensing) below for the full detail, and see [NOTICE](NOTICE) and [LICENSE](LICENSE) in this repository.

**If you build something with this node, please credit MiniMax H3 in your own output/description — "Powered by MiniMax H3" — the same courtesy this README extends to them.**

---

## What it does

MiniMax H3 is a strong omni-modal model, but its native inputs are low-level: numbered `<Picture N>` / `<Video N>` / `<Audio N>` reference tags that have to line up exactly with the order references are actually passed in, and a hard ceiling of roughly 15 seconds per single generation call. `MuseMinimaxDirector` sits on top of the real, stock ComfyUI MiniMax H3 nodes (`MiniMaxH3ReferenceToVideo`, `MiniMaxH3ImageToVideo`, `MiniMaxH3SigmaShift`) and handles all of that bookkeeping for you, so you can write a script instead of hand-managing tag numbers and generation-length limits.

### Key features

- **Visual timeline editor** — a script made of CUTs (segments) laid out along a single timeline, each with its own prompt text. Add Chunk / Delete Chunk buttons on every chunk section let you resize the timeline directly
- **Automatic chunking** — write one script of any total length; the node splits it into H3-sized chunks itself. Every CUT's text is included in every chunk it actually overlaps in time, regardless of how many CUTs you use or how their weights divide up the total duration
- **Two-stage sampling** (Sampling box) — first few steps at lower resolution, upscaled, then finished at full resolution on the same noise schedule. Optional, off by default
- **VAE Re-encode Carry** (Resolution box) — hard-freezes a real re-encoded window of the previous chunk's actual output across the chunk boundary, eliminating the visible jump multi-chunk renders otherwise have. See [Chunk continuity, in detail](#chunk-continuity-in-detail)
- **Two generation modes**, switched with a single toggle in the node's Reference Settings box:
  - **Reference mode** — up to 9 character reference images, plus reference video and reference audio, all combined via H3's soft reference conditioning
  - **First/Last Frame mode** — Ref 1 and Ref 2 become a hard-locked first frame and last frame instead. This is a genuine positional lock (frame 0 and the final frame), not conditioning — the other reference slots grey out in this mode because H3's First/Last Frame checkpoint has no reference-tag system to feed them into
- **Hybrid Continuation** (Reference mode only) — an optional toggle that hard-locks chunk-to-chunk transitions by routing the boundary frame through the First/Last Frame checkpoint instead of relying purely on Reference mode's softer carry-over conditioning. Needs a First/Last Frame model wired into the node's `model_fl2va` input
- **Reference video** — motion/style reference, or full "video editing" style person-swap-in-scene, per H3's own documented task types
- **Reference video audio** — a per-clip toggle to also pull that reference video's own embedded audio out and use it as a separate voice/timbre reference — useful for lipsync-style "reperformance," where the same spoken words come out in a different, reference-specified voice
- **Reference audio** — standalone voice cloning / timbre reference, independent of any video, for direct dialogue-in-a-cloned-voice generation
- **Correct `<Picture N>` / `<Video N>` / `<Audio N>` tag numbering** — built to match MiniMax H3's actual assignment rule, which is iteration order over the reference dictionary's values, **not** the numeric suffix of the input slot's own key. Reference items always land in the compiled prompt with the same tag numbers H3 itself will actually assign them
- **MiniMax's full six-section reference-mode prompt format** — `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, `non_diegetic_music`, `<Subject N>` abstraction layer, fixed-vocabulary retention markers, `[Shot N] At MM:SS.mmm` shot timestamps, and `(Sx)` speaker tags — built automatically from the timeline UI, per MiniMax's own official prompt-writing guide
- **Multi-speaker CUTs** — pick one or more speaking characters per CUT via chips in the timeline UI; quoted dialogue gets auto-attributed and `(Sx)`-tagged against the right `<Subject N>`, with positional Ref Audio ↔ Ref character voice pairing
- **Seed Hunt** — an optional toggle that runs the whole timeline 4 times at identical settings, seed only, and outputs all 4 as separate candidate image/audio pairs (see [Seed Hunt, in detail](#seed-hunt-in-detail) below)
- **`ref_images_used` output** — the exact reference photos used for `<Picture N>` tagging on this run, ready to wire into [Muse Minimax Refine](#muse-minimax-refine-bundled)'s own `ref_images` input for identity-locked second-pass refining
- **Sigma shift controls** exposed directly on the node, applied via the real `MiniMaxH3SigmaShift` node
- **Image + audio output**, not a bundled video file — wire straight into a standard Video Combine node alongside the rest of your pipeline
- **`compiled_prompt` output** — the exact, fully-resolved prompt text sent to H3 for every chunk, so you can see precisely what tags and continuity language the node generated

---

## Nodes included

| Node | Display name | Description |
|------|---------------|-------------|
| `MuseMinimaxDirectorV14` | Muse Minimax Director V1.4 (Two-Stage) | Timeline-based director for MiniMax H3 — chunking, prompt compilation, Seed Hunt scouting, continuity |
| `MuseMinimaxRefineV2` | Muse Minimax Refine V2 (Beta-matched) | Companion second-pass node — continues a picked Seed Hunt candidate's own sigma schedule at a higher resolution (see [Muse Minimax Refine (bundled)](#muse-minimax-refine-bundled)) |

Plain Refine, Refine V1.3, Refine V14, and Muse Model Route (a tiny MODEL-routing utility used by an older example workflow) are not part of this package — see the [Changelog](#changelog) for why V2 is the one shipped here. None are gone from existence, just no longer bundled here.

---

## Requirements

- A recent ComfyUI install with the stock `MiniMaxH3ReferenceToVideo` / `MiniMaxH3ImageToVideo` / `MiniMaxH3SigmaShift` nodes available (these ship with ComfyUI core — no separate node pack needed for the model support itself, only for this timeline layer). If this node fails to load with `ModuleNotFoundError: No module named 'comfy_extras.nodes_minimax_h3'` in the console, your ComfyUI core build predates native MiniMax H3 support — update ComfyUI core itself (not this node) and restart.
- MiniMax H3 model weights, downloaded separately by you — see [Model setup](#model-setup)
- **[ComfyUI-H3-Motion-Context-MultiRef](https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef)** — required if you turn on **Enable VAE Re-encode Carry** (Director chunk continuity), used by the bundled Refine node when it re-stitches a multi-chunk Latent-Only Scouting candidate, and (as of v3.0.0) also used for Lip Sync's master-song masked context. If you already installed this a while ago for VAE Re-encode Carry, make sure it's up to date — the Lip Sync usage relies on a node class this package added after some earlier installs would have pulled it. Install via ComfyUI Manager or:
  ```bash
  cd ComfyUI/custom_nodes
  git clone https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef
  ```
  Leave the toggle off if you don't want this dependency — every other feature in this node works without it.
- **[ComfyUI-Frame-Interpolation](https://github.com/Fannovel16/ComfyUI-Frame-Interpolation)** — optional, only used if `seam_interpolation_frames` is set above 0 (RIFE-based seam smoothing between chunks). Without it, that setting silently has no effect and chunk boundaries are a hard cut instead.

### Python packages

```bash
pip install av
```

`av` is used to decode and trim uploaded reference video/audio clips.

---

## Installation

### Via ComfyUI Manager
Search for **Muse Minimax Director** and click Install.

### Manual
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/muse-collective-26/MiniMaxH3-Director-V1.2
```

Restart ComfyUI after installing.

---

## Model setup

MiniMax H3 weights are **not** included in this repository and must be downloaded separately, directly from the official publisher:

**https://huggingface.co/MiniMaxAI/MiniMax-H3**

Depending on which mode(s) you plan to use, you need:

- The **Reference-to-Video** checkpoint — wired into this node's `model` input. Required for Reference mode.
- The **Image-to-Video (First/Last Frame)** checkpoint — wired into this node's `model_fl2va` input. Required for First/Last Frame mode, and also required if you want to use the Hybrid Continuation toggle while in Reference mode.

These are two separate weight files for two separate H3 checkpoints — they are not interchangeable, and each needs its own `MiniMaxH3SigmaShift` pass, which this node handles internally per-checkpoint.

You will also need a matching CLIP text encoder, a video VAE, and an audio VAE — wired the same way as any other ComfyUI MiniMax H3 workflow. Follow the official Hugging Face repo's own instructions for exact filenames and folder placement, and check ComfyUI's built-in MiniMax H3 example workflow/template (if your ComfyUI version ships one) for the current expected layout — deliberately not hardcoded here, since filenames and folder conventions can and do change between model/ComfyUI releases.

---

## Quick start

1. Add a **Muse Minimax Director** node to your graph.
2. Wire `model` (Reference-to-Video checkpoint), `clip`, `vae`, and `audio_vae`. Optionally wire `model_fl2va` (First/Last-Frame checkpoint) if you plan to use First/Last Frame mode or Hybrid Continuation.
3. On the node's timeline UI, drop a character reference image into **Ref 1**, and optionally a **Location** background image.
4. Add one or more **CUT** segments along the timeline and write a prompt for each.
5. Set `duration_seconds` for your total target length, and `chunk_duration_seconds` for how long each individual H3 generation call should be (stay under H3's own per-call ceiling — roughly 15 seconds).
6. Run. Wire the node's `images` and `audio` outputs into a standard Video Combine node to get a playable file.
7. Check the `compiled_prompt` output text if anything looks off — it shows exactly what was sent to H3, including every resolved `<Picture N>` / `<Video N>` / `<Audio N>` tag.

---

## Example workflow

A ready-to-load workflow is included at [`workflows/muse_minimax_h3_director_V1.4.json`](workflows/muse_minimax_h3_director_V1.4.json) (updated 2026-09-05) — demonstrates the full current stack: **Muse MiniMax H3 Unified Loader** feeding the Director's `model`/`clip`/`vae`/`audio_vae`/`model_fl2va` inputs, **Two-Stage Sampling**, **Seed Hunt** (up to 4 candidates) with **Latent-Only Scouting**, and **Muse Minimax Refine V2** wired up to continue a picked candidate at full resolution. Reference slots are left empty on purpose so you drop in your own characters and location rather than inheriting someone else's.

**Cross-repo dependency:** this example uses the **Muse MiniMax H3 Unified Loader** node, which lives in its own separate repository — [muse-collective-26/Muse-MiniMax-H3-Unified-Loader](https://github.com/muse-collective-26/Muse-MiniMax-H3-Unified-Loader). Install that alongside this one for the example to load without a missing-node warning; the Director itself doesn't require it — you can wire any MiniMax H3 model/CLIP/VAE loader directly instead.

It also uses a few extra nodes purely for convenience/performance, on top of what's required above — search ComfyUI Manager for these if they show as missing when you load it:

- **[Muse Run Stats](https://github.com/muse-collective-26/Muse-Run-Stats)** — the live elapsed-time/GPU/VRAM/RAM overlay dropped on the canvas; entirely optional, doesn't need to be wired to anything, safe to delete
- **KJNodes** (`GetNode`/`SetNode`, `ModelPreviewOverrideKJ`) — used throughout for wiring organization and a model-preview wrapper; the Get/Set nodes are purely a tidiness convenience, safe to trace through and rewire directly if you don't have KJNodes. Also required by the Unified Loader itself for its SageAttention/low-VRAM attention/chunked feed-forward patches
- **ComfyUI-LayerStyle** (`LayerUtility: PurgeVRAM`) — clears VRAM between preview steps, not required for generation to work
- **ComfyUI-VideoHelperSuite** (`VHS_VideoCombine`, `VHS_BatchManager`, `VHS_FILENAMES`) — combines the Director's `images`/`audio` outputs into a playable video file
- **ComfyUI-Easy-Use** (`easy showAnything`) — small status-display boxes showing what the Unified Loader actually selected on the last run
- **ComfyUI-iTools** (`iToolsPreviewText`) — a text-preview node; swap for any other STRING preview node (e.g. "Show Text" from ComfyUI-Custom-Scripts) if you don't have this one
- **[ComfyUI-H3-Motion-Context-MultiRef](https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef)** — required for Seed Hunt's raw-latent carry continuity between chunks; see [Requirements](#requirements)

None of these are needed for `MuseMinimaxDirector` itself to work — only for this specific example graph exactly as saved. Sol-Attn is **not** used anywhere in this workflow or in the Unified Loader — it was removed after testing confirmed it could stall a render under real memory pressure; see the [Unified Loader's own changelog](https://github.com/muse-collective-26/Muse-MiniMax-H3-Unified-Loader#changelog) for detail.

---

## Full node reference

### Inputs

| Input | Type | Description |
|-------|------|--------------|
| `mode` | Combo | `Reference` or `First/Last Frame` — switches which H3 checkpoint and reference system is used |
| `model` | MODEL | MiniMax H3 Reference-to-Video checkpoint |
| `model_fl2va` | MODEL (optional) | MiniMax H3 First/Last-Frame checkpoint — required for First/Last Frame mode, or to enable Hybrid Continuation while in Reference mode |
| `clip` | CLIP | MiniMax H3 text encoder |
| `vae` | VAE | MiniMax H3 video VAE |
| `audio_vae` | VAE | MiniMax H3 audio VAE — required in both modes, since H3's latent is always a joint audio+video structure internally |
| `aspect_ratio` | Combo | Output aspect ratio |
| `megapixels` | FLOAT | Output resolution budget |
| `multiple` | INT | Resolution rounding constraint |
| `resize_method` | Combo | How every character/background reference image and First/Last Frame image gets fit to the output resolution when its own aspect ratio doesn't match. `crop` scales up and center-crops the excess (no distortion, may crop the edges). `pad` scales down to fit and adds black bars (nothing cropped, but the bars become visible reference content). `stretch` resizes directly, distorting proportions — this is what H3 does internally on its own if you don't fit the image yourself, so it's here for parity, not as the recommended choice |
| `duration_seconds` | FLOAT | Total output length. If this is longer than one H3 generation can produce in a single call, the node automatically splits the render into multiple chunks |
| `chunk_duration_seconds` | FLOAT | Target length per chunk when chunking is needed |
| `ref_image_size` | Combo | Resolution reference images are resized to before being sent to H3 |
| `hybrid_continuation` | BOOLEAN | Reference mode only. When on (and `model_fl2va` is connected), chunk boundaries are hard-locked via the First/Last Frame checkpoint instead of soft carry-over conditioning |
| `seed` | INT | Sampler seed for the main run (also the base seed for Seed Hunt's 4 candidates) |
| `seed_hunt` | BOOLEAN | When on, runs the whole timeline 4 times — identical settings, only the seed differs — and fills `candidate_1..4_images/audio`. Takes ~4x as long as a single run; see [Seed Hunt, in detail](#seed-hunt-in-detail) |
| `steps` | INT | Sampler steps |
| `sampler_name` | Combo | Sampler algorithm |
| `scheduler` | Combo | Noise scheduler |
| `shift_video` | FLOAT | Sigma shift value applied to the video branch via `MiniMaxH3SigmaShift` |
| `shift_audio` | FLOAT | Sigma shift value applied to the audio branch via `MiniMaxH3SigmaShift` |
| `timeline_data` | Hidden | Populated automatically by the visual timeline editor UI — not meant to be edited by hand |

### Outputs

| Output | Type | Description |
|--------|------|--------------|
| `images` | IMAGE | Generated video frames for the main run. **Blocked (not populated) when `seed_hunt` is on** — Seed Hunt is a scouting run, not a final one, so this only ever means "the one real generation" with Seed Hunt off. Use `candidate_1..4` instead when scouting |
| `audio` | AUDIO | Generated/mixed audio track, same blocking behavior as `images` |
| `compiled_prompt` | STRING | The exact per-chunk prompt(s) actually sent to H3, including every resolved section, tag, and continuity language. The single best debugging tool for this node — if a render doesn't look right, check this first. Populated regardless of `seed_hunt` |
| `ref_images_used` | IMAGE | The static `<Picture N>` reference image set actually used on this run's first chunk (character/product photos + background, in H3's own tag order). Reference mode only — empty in First/Last Frame mode. Wire into [Muse Minimax Refine](#muse-minimax-refine-bundled)'s `ref_images` input for identity-locked refining. Populated regardless of `seed_hunt` |
| `candidate_1_images` / `candidate_1_audio` | IMAGE / AUDIO | Always mirrors `images`/`audio` (the main run), at zero extra cost — populated whether or not `seed_hunt` is on |
| `candidate_2..4_images` / `candidate_2..4_audio` | IMAGE / AUDIO | The 3 additional scouting passes (seed + N×1,000,003). Only populated when `seed_hunt` is on — empty otherwise |

`images`/`audio` being blocked with `seed_hunt` on, and `candidate_2..4` being empty with it off, both use ComfyUI's `ExecutionBlocker` — anything wired to an unpopulated output stops silently (a console warning, no red error, no interruption to the rest of the queue) rather than running on the wrong data.

---

## Using the timeline UI

The timeline editor has three parts:

- **Characters** — up to 9 character reference image slots (Ref 1 through Ref 9). Only filled slots get sent to H3, and they are packed densely in fill order — so if you only fill Ref 1 and Ref 3, they still become `<Picture 1>` and `<Picture 2>` in the compiled prompt with no gap, matching exactly how H3 itself will number them. Each slot has its own free-text description field, used to build the compiled prompt's `<Picture N> = ...` label line.
- **Location** — a single background/setting reference image slot, sent as the final `<Picture N>` after all filled character slots.
- **CUTs** — your script, written as a sequence of timed segments along the timeline. Each CUT has its own prompt text and a weight that controls how much of the total duration it covers. CUTs are mapped into chunks by actual time overlap, not by a fixed split — a CUT that spans a chunk boundary is correctly included in both chunks it touches, whatever your segment count or weighting looks like.

Switching `mode` to **First/Last Frame** repurposes the first two character slots as **First Frame** and **Last Frame**, and greys out every other reference slot plus the reference video/audio row, since H3's First/Last Frame checkpoint has no reference-tag system for them to feed.

---

## Reference mode, in detail

Reference mode uses H3's `MiniMaxH3ReferenceToVideo` checkpoint and MiniMax's own full **six-section prompt format** (`subject_definitions` / `summary` / `retention_analysis` / `detailed_description` / `overall_soundscape` / `non_diegetic_music`), per their official prompt-writing guide. This is the mode for character-consistent generation across a full script, and for anything that needs more than one reference source at once — the node assembles all six sections for you from the timeline UI.

**Example** (Ref 1 filled with a photo of a woman with a ponytail, Location filled with a boardwalk photo):

```
subject_definitions:
<Subject 1> is a woman with a dark ponytail, wearing a cream trench coat (from `<Picture 1>`).
<Subject 2> is the setting, a wooden boardwalk beside the sea at golden hour (from `<Picture 2>`).

summary:
[reference generation] <Subject 1> walks along the boardwalk in <Subject 2>.

retention_analysis:
<Subject 1> (present throughout): fully_preserved - matches `<Picture 1>`.
<Subject 2> (present throughout): fully_preserved - matches `<Picture 2>`.

detailed_description:
[Shot 1] <Subject 1> walks slowly along the boardwalk in <Subject 2>, wind moving through her coat, warm low sun behind her.

overall_soundscape:
Gentle waves, distant gulls, a light breeze.

non_diegetic_music:
Soft, warm acoustic guitar, understated.
```

This scaffolding is built automatically from your Characters, Location, and CUT text — you only need to write the CUT prompt itself, plus optional per-slot descriptions/retention and the two global Soundscape/Music fields in Reference Settings.

---

## First/Last Frame mode, in detail

First/Last Frame mode uses H3's `MiniMaxH3ImageToVideo` checkpoint. Unlike Reference mode's soft conditioning, this is a genuine hard positional lock: your Ref 1 image is locked to frame 0, and your Ref 2 image (if present) is locked to the final frame. Either can be left empty to skip that lock.

This mode has no reference-tag system at all — write your CUT prompts as plain descriptive text describing the motion that should happen between the locked first and last frames. It's the right tool when you have a specific start pose and end pose you need the generation to hit exactly, rather than a general character-consistency need across an open-ended script.

---

## Reference video, in detail

Reference video (Reference mode only) lets you hand H3 an actual video clip as a reference, tagged `<Video N>` in the compiled prompt. Per H3's own documented task types, a reference video can be used for:

- **Video editing** — replace a person or element in the reference video while keeping the same scene, camera motion, and action. Pair a character reference image with a reference video of someone else performing the action you want, and describe the swap in your CUT text.
- **Video continuation** — extend the reference video's motion and camera movement onward, rather than starting fresh.
- **Structural / camera-move reference** — carry over the reference video's camera language (a push-in, a pan, a specific framing) into a new scene.

**Example — replacing a person while keeping the scene**, with a character reference image in Ref 1 and a reference video of someone else walking down a corridor dropped into the reference video slot:

```
`<Picture 1>` = a woman with a dark ponytail, wearing a cream trench coat
`<Video 1>` = the corridor scene and camera motion to keep, with the person to be replaced

CUT 1: `<Picture 1>` walks down the corridor from `<Video 1>`, matching the same pace, camera movement, and framing as the original — everything about the scene and camera stays the same, only the person changes.
```

---

## Reference video audio, in detail

Each reference video slot has its own **"Include this clip's audio (as its own reference)"** toggle. Off by default. When switched on, the node pulls that clip's own embedded audio track out and passes it to H3 as a separate, paired `<Audio N>` reference alongside that clip's `<Video N>` tag — this maps directly onto H3's real `ref_video_audios` input, which the stock ComfyUI node exposes but which isn't used unless you explicitly opt in per clip.

This is the mechanism behind a **"reperformance"**: the same spoken words, delivered in a different voice. To do it, combine a reference video (with its audio toggle on) for the words/timing/performance, with a separate standalone reference audio clip (see below) for the target voice, and describe the swap explicitly in your CUT text — H3 needs to be told which `<Audio N>` is the words source and which is the target voice.

Leave the toggle off if you only want the reference video's motion, and don't want its audio influencing the result at all — for example, if you're doing a silent motion/style transfer and don't want any spoken content or ambient sound bleeding through.

---

## Reference audio, in detail

Standalone reference audio clips (Reference mode only, independent of any reference video) are tagged `<Audio N>` and used for voice timbre, style, rhythm, and content reference — most commonly, voice cloning for dialogue.

**Example — simple voice-cloned dialogue**, with a character reference image in Ref 1 and a short clean voice sample dropped into a reference audio slot:

```
`<Picture 1>` = a woman with a dark ponytail
`<Audio 1>` = the voice to use for her dialogue

CUT 1: `<Picture 1>` looks directly at camera and says, in the voice from `<Audio 1>`, "I didn't think you'd actually come."
```

---

## Chunking and long-form scripts, in detail

MiniMax H3 tops out at roughly 15 seconds per single generation call. Set `duration_seconds` above `chunk_duration_seconds` and the node automatically:

1. Splits the total duration into chunks sized to `chunk_duration_seconds`, with the remainder folded into the final chunk rather than producing an oddly short trailing chunk.
2. Maps every CUT you've written into every chunk it overlaps in time, based on actual elapsed-time overlap — not a fixed per-chunk split — so a CUT that straddles a chunk boundary appears, correctly, in both chunks.
3. Carries a short tail of the previous chunk's own audio forward into the next chunk's reference audio, with an automatically-added continuity instruction, so score/ambience doesn't hard-reset at every chunk boundary.
4. In Reference mode, also carries the previous chunk's final frame forward as a continuity-anchor reference image (labelled accordingly in the compiled prompt), with a continuity instruction telling H3 to continue the same action and framing rather than cutting to a new take.

This is soft conditioning by default — H3 has no true hard pixel-lock across separate generation calls in Reference mode, so some visible seam at chunk boundaries is possible even with all of the above. **Hybrid Continuation** (below) is the harder-lock alternative for when that seam matters more than perfect reference-image fidelity on the affected chunk.

---

## Hybrid Continuation, in detail

Available only in Reference mode, and only with a First/Last-Frame checkpoint wired into `model_fl2va`. When switched on, every chunk after the first is generated using the First/Last-Frame checkpoint instead of the Reference-to-Video checkpoint, with the previous chunk's exact final frame locked in as that chunk's first frame — a genuine positional lock, not conditioning.

This trades away some of Reference mode's character-reference reinforcement on the affected chunks (since the First/Last-Frame checkpoint has no `<Picture N>` tag system to keep reinforcing identity from your original reference images) in exchange for eliminating the visible hard-cut seam at chunk boundaries. In practice this trade is often worth it, since the locked anchor frame itself already carries the correct identity forward from whichever chunk was generated in full Reference mode.

The first chunk of a render is always generated in full Reference mode regardless of this toggle, since there is no previous chunk to continue from yet.

---

## Chunk continuity, in detail

On a multi-chunk render, every continuity mechanism above (the default anchor, Hybrid Continuation) is still a genuinely *independent* generation call for each chunk — nothing forces chunk 2's opening latent to actually match chunk 1's real ending, only the prompt/reference conditioning nudges it that way. In practice this shows up as a visible jump right at the cut: a pose, camera distance, or piece of clothing that changes in a single frame.

**Enable VAE Re-encode Carry** (Resolution box) fixes this directly instead of nudging around it. The previous chunk's actual final frames and audio — real decoded pixels, not the sampler's own raw latent estimate — get freshly VAE re-encoded and hard-frozen (noise-masked, not just conditioned) as the next chunk's own opening latent prefix, so the new chunk's sampling genuinely continues from the old chunk's real ending rather than starting fresh next to it. The generation window is extended to cover this protected prefix, then trimmed back off after decode, so it doesn't cost you any authored duration. With two-stage sampling on, this happens twice — once before Stage 1 (so the early, composition-deciding steps are actually anchored) and again after the Stage-2 upscale (refreshing the frozen region with a true high-resolution re-encode right before the pass that matters most for output quality).

**Measured, not just claimed** — frame-to-frame grayscale difference across the chunk boundary, before and after, on real renders:

| Configuration | Baseline (elsewhere in the clip) | Boundary diff |
|---|---|---|
| Plain anchor (this toggle off) | ~4–16 | ~44–48 |
| VAE Re-encode Carry, single-pass | ~0.45–6.33 | 3.21 |
| VAE Re-encode Carry, two-stage | ~0.67–10.51 | 4.61 |

With the toggle on, the boundary consistently lands *inside* the clip's own normal frame-to-frame variation — not just reduced, but no longer measurable as a discontinuity at all.

Requires [ComfyUI-H3-Motion-Context-MultiRef](https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef) — see [Requirements](#requirements). Leave the toggle off if you don't want the dependency; every other feature in this node works without it.

---

## Multi-speaker CUTs, in detail

Each CUT can have one or more speaking characters selected via chips in the timeline UI. Quoted dialogue in a CUT's text gets `(Sx)` speaker tags auto-attached to the right `<Subject N>` occurrences, with `(Sx)` numbers assigned in order of first appearance within the chunk. Standalone reference audio clips pair positionally with character slots (Ref Audio N ↔ Ref N) for voice-timbre reference, cited against the correct `(Sx)` automatically. With exactly one speaker selected on a CUT, untagged dialogue is auto-attributed to them; with two or more selected, tag the `<Subject N>` you mean directly in the CUT text — there's no safe way to guess which speaker owns an untagged line once more than one is selected.

---

## Seed Hunt, in detail

MiniMax H3 generation is expensive enough that finding out a render didn't follow the prompt, after paying full price for it, is a real cost. Seed Hunt runs the timeline **up to 4 times** — identical prompt, identical settings, only the seed differs (`seed`, `seed + 1,000,003`, `seed + 2,000,006`, `seed + 3,000,009`) — and outputs each as a separate `candidate_N_images`/`candidate_N_audio` pair (plus `candidate_N_latent` — see below), so you can generate cheaply (low `megapixels`), compare them, and only spend real compute refining the one that actually worked.

**Candidate 1 always runs, for free** — it's the main run at your chosen seed regardless of the count below. How many total run is controlled by one dropdown, "Candidates to scout" (Sampling box, "Seed Hunt" section), 1 through 4 — always candidates 1..N in sequence, never a gap:
- **1** (default) — just the main seed, no extra passes.
- **2** — adds one extra pass at `seed + 1,000,003`.
- **3** — adds `seed + 1,000,003` and `seed + 2,000,006`.
- **4** — adds `seed + 1,000,003`, `seed + 2,000,006`, and `seed + 3,000,009`.

An earlier version used three independent per-candidate toggles instead of a count, so you could tick e.g. only Candidate 4 and skip 2/3 — that's gone now; candidates are just different random seeds, there's no reason to want #4 specifically without #2/#3, and it read backwards (ticking "Candidate 4" looked like "run 4 total" but actually meant "just slot 4, alone"). The count fixes both problems at once. The moment it's above 1:
- The main `images`/`audio` outputs are **intentionally blocked** — they don't mean "a picked result" during scouting, only during a normal single run with nothing extra on, so nothing downstream can mistake an unpicked scout for a finished video.
- Every candidate that ran gets its own populated `candidate_N_images`/`candidate_N_audio` pair; candidates beyond the chosen count stay cleanly blocked (not just left empty — an earlier version silently returned a zero-length tensor for those, which could leave a downstream Save/Preview node showing a stale thumbnail from an unrelated earlier run instead of clearly indicating nothing was generated).

**Latent-Only Scouting** (`two_stage_seed_hunt_latent_only`, two-stage sampling only) is a separate, independent toggle — it decides what each pass that runs actually *does* (stop after the cheap Stage 1 instead of also paying for the Stage 2 upscale), not how many passes run. Combine it with any candidate count freely; neither reads the other.

**Recommended workflow**: set `megapixels` low and turn on however many candidates you want to compare, wire the resulting `candidate_N_latent` outputs (or `candidate_N_images`/`audio`, if Latent-Only Scouting is off) and `ref_images_used` into [Muse Minimax Refine (bundled)](#muse-minimax-refine-bundled), pick the candidate that actually matches the prompt via its button selector, and let Refine do the expensive, high-resolution second pass on just that one.

---

## Muse Minimax Refine (bundled)

`MuseMinimaxRefineV2` is the companion second-pass node bundled in this same repository (see [Nodes included](#nodes-included)) — a standalone continuation node, not a modification of the Director. It picks up a chosen Seed Hunt candidate's own sigma schedule exactly where Stage 1 left off and finishes it at a higher resolution — a genuine latent continuation, not a from-pixels img2img re-sample, so nothing about the candidate's own content changes, only its resolution.

**Inputs**, beyond `model`/`clip`/`vae`/`audio_vae`:
- `prompt` — wire the Director's `compiled_prompt` output. Reused as-is for a single-chunk candidate; ignored for a multi-chunk one (each chunk already carries its own saved prompt — see below).
- `candidate` — which of the four candidate slots to continue, set by the button selector in the node's own UI. Refuses to run at 0 (none picked) rather than silently defaulting to candidate 1.
- `candidate_1_latent` … `candidate_4_latent` — wire from the Director's matching outputs. Only meaningful when Latent-Only Scouting was on for that run.
- `seed` / `steps` / `two_stage_first_pass_steps` — must match what the chosen candidate's own Stage 1 was actually generated with, so the sigma schedule reconstructs correctly and this picks up exactly where Stage 1 left off, not somewhere else on the curve.
- `ref_images` — the same character/product reference photos that anchored identity in the original candidate (wire the Director's `ref_images_used`). Without this, only the text prompt constrains the pass, and any detail the prompt doesn't spell out is free to drift.

**Multi-chunk candidates**: if the chosen candidate came from a multi-chunk timeline with Latent-Only Scouting on, `candidate_N_latent` carries every chunk, not just one. Refine detects this automatically, refines each chunk in turn — re-anchoring continuity from the previous chunk's own freshly-refined output the same way the Director re-anchors between its own chunks, so the seam stays intact — and hands out one full-length, full-resolution stitched result. A plain single-chunk candidate runs through the same code path with no carry, exactly as it always has.

---

## Credits & Licensing

**This project would not exist without MiniMax H3.** Every frame, every second of audio, and every reference-following behaviour this node relies on comes from MiniMax's own model — this repository is a thin, original scripting/timeline layer on top of it, nothing more. If you use this node, please extend MiniMax the same credit this README gives them: **Powered by MiniMax H3.**

- **Model:** MiniMax H3, developed and published by MiniMax — [huggingface.co/MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3)
- **License:** MiniMax H3 Community License Agreement — [full text here](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE). This is MiniMax's own license for their model and is separate from, and takes precedence over, anything in this repository regarding the model itself. Read it yourself before using the model — summarised here only for orientation, not as a substitute:
  - Displaying a "Powered by MiniMax H3" credit and adding an AI-generation identifier to output files are both described in the license as **encouraged**, not mandatory.
  - Distributing a NOTICE file alongside any redistribution of software built on MiniMax H3 **is** described as required — see [NOTICE](NOTICE) in this repo.
  - The license sets a revenue threshold above which separate written authorization from MiniMax is required for commercial use, and above which prominent "MiniMax H3" branding on a commercial product's UI becomes mandatory rather than encouraged.
  - The license also contains territory-specific language that may affect redistribution in certain jurisdictions. **Read this section yourself** in the official text linked above before redistributing — it was not something this project's own author verified in full before publishing this node, and it is exactly the kind of clause a summary can get wrong.
- **Official prompt-writing guide** (the source for the reference-tag conventions and task types documented above): [VIDEO_PROMPT_WRITING_GUIDE_ref_en.md](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)

**This repository's own original code** (the timeline UI, the chunking logic, the tag-numbering fix, the hybrid continuation feature — everything in this repo outside of calling MiniMax H3's own stock ComfyUI nodes) is licensed under the **MIT License** — see [LICENSE](LICENSE). The MIT license covers only that original code; it grants no rights whatsoever over the MiniMax H3 model itself, which remains governed entirely by MiniMax's own Community License Agreement linked above.

See [NOTICE](NOTICE) for the required third-party attribution notice.
