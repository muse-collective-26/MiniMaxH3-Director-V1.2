const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

// ComfyUI renders DOM widgets above the LiteGraph canvas. A wheel event whose
// pointer is over that DOM layer never reaches the canvas, so the graph cannot
// zoom even though the cursor is visibly over the node. Forward a faithful
// copy to the real canvas while keeping click/drag/input handling local here.
function forwardWheelToComfyCanvas(element) {
  element.addEventListener("wheel", (event) => {
    const canvas = app?.canvas?.canvas;
    if (!canvas || event.__museCanvasForwarded) return;

    event.preventDefault();
    event.stopPropagation();

    const forwarded = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: event.detail,
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: event.clientX,
      clientY: event.clientY,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      button: event.button,
      buttons: event.buttons,
      relatedTarget: event.relatedTarget,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaZ: event.deltaZ,
      deltaMode: event.deltaMode,
    });
    Object.defineProperty(forwarded, "__museCanvasForwarded", { value: true });
    canvas.dispatchEvent(forwarded);
  }, { passive: false });
}
// Muse Minimax Director — timeline UI.
//
// H3 has no chunk/segment concept in its own architecture — the whole clip comes from
// one prompt in one sampling pass. So the ruler/track below is a real duration-proportioned
// visual (drag block edges to change how much of the total clip each CUT gets, drag whole
// blocks to reorder) but it only ever compiles down to prose + a soft "(~Xs)" pacing hint
// per CUT — there's no actual per-segment sampling behind it, unlike the LTX timeline this
// is visually modeled on.
//
// mode/clip/vae/duration_seconds/resolution_preset/ref_image_size are real native widgets
// declared in the Python node — this file re-skins them into boxed sections rather than
// managing separate state for them. Character/background reference images, and reference
// video/audio clips, are all real uploaded files (via ComfyUI's own /upload/image endpoint,
// same as LTX Director's audio/video tracks) with scrub + Set In/Set Out trim controls where
// relevant — file path + trim window live in timeline_data; Python resolves/decodes them
// (with PyAV for video/audio) at execute time. There are no graph sockets for any of this —
// First/Last Frame and Hybrid modes have their own independent First Frame / Last Frame
// upload slots (firstFrameImage/lastFrameImage), separate from the Ref 1..N character slots
// and the Location slot(s) — the underlying H3 nodes already keep first_frame/last_frame on
// a completely separate conditioning channel from ref_images, so there was never a real need
// to double them up; that was only ever an earlier UI shortcut.

// V1.4 exposes eight subject/object reference slots. MiniMax has nine image-reference slots total;
// the active Location and each timed Guide also consume that same pool, so the backend
// validates the actual per-chunk combination before generation. Keep this in sync with Python.
const MAX_CHARACTER_SLOTS = 8;
const MAX_LOCATION_SLOTS = 7; // 1 primary (always chunk 1) + up to 6 more
const MAX_GUIDE_SLOTS = 4;
const REF_AV_SLOTS = 3;
// Floor for a single CUT's typed-in duration. Deliberately small — this only
// bounds one CUT's own length, not how much room redistributing it needs
// elsewhere (see _buildCutBlock's duration input, which pulls/gives that
// difference across every other CUT in the chunk at once).
const MIN_CUT_SECONDS = 0.3;
// Taken out of the UI for now — not deleted, just hidden until it's wanted again.
const SHOW_PROMPT_GEN = false;
const HIDDEN_WIDGET_NAMES = ["timeline_data"];
const BOXED_WIDGET_NAMES = [
  "mode", "duration_seconds", "chunk_duration_seconds",
  "aspect_ratio", "megapixels", "multiple", "resize_method",
  "steps", "sampler_name", "scheduler", "seed", "seed_hunt", "use_prompt_override", "control_after_generate", "shift_video", "shift_audio",
  "two_stage_sampling", "two_stage_first_pass_steps", "two_stage_latent_upscale_model", "two_stage_target_megapixels",
  "two_stage_seed_hunt_latent_only", "enable_seed_hunt", "candidate_count",
  "ref_image_size", "hybrid_continuation", "seam_interpolation_frames",
  "vae_reencode_carry_test", "vae_reencode_carry_length", "vae_reencode_carry_video_only_test",
  "long_form_enabled", "long_form_project_id", "render_chunk_start", "render_chunk_end",
  "two_stage_enable_temporal_chunking", "raw_latent_carry_test",
];
// seed_hunt stays in this list (so it's still found, hidden, and serialized) but is
// never given a row of its own below — it's legacy-only now, kept purely so an old
// saved workflow that had it on keeps running all 3 extra passes. candidate_count is
// the real replacement: a single count (1-4), always running candidates 1..N in
// sequence. An earlier version used three independent per-candidate booleans, which
// let you tick e.g. only Candidate 4 and skip 2/3 — meaningless, since candidates are
// just different random seeds, and it read backwards ("Candidate 4" looked like
// "give me 4" but meant "just slot 4 alone"). Confirmed directly: a real run with
// only "Candidate 4" ticked produced candidates 1 and 4 while candidates 2/3 silently
// never ran.
// "seed" uses a text input below (see _seedRow), not the generic number row — avoids
// <input type="number">'s tendency to mangle very large integers into scientific
// notation on display/edit. It's still ultimately a plain JS Number under the hood,
// same as ComfyUI's own native seed widget — this doesn't add or remove precision
// versus what the native widget already has, just a cleaner text-based editor for it.
const MODE_REFERENCE_PREFIX = "Reference (Omni)";
const MODE_FIRST_LAST_PREFIX = "First/Last Frame";
const MODE_HYBRID_PREFIX = "Hybrid";

// Fixed-vocabulary retention markers from MiniMax's own reference-mode prompt
// guide (retention_analysis section) — visual markers apply to Subject/Picture/
// Video, audio markers apply to Audio. Values are the literal English tokens the
// guide requires; labels are just the friendlier on-screen text.
const VISUAL_RETENTION_OPTIONS = [
  { value: "fully_preserved", label: "fully preserved" },
  { value: "partially_preserved", label: "partially preserved" },
  { value: "attribute_transfer", label: "attribute transfer" },
  { value: "weak_reference", label: "weak reference" },
];
const REFERENCE_FIT_OPTIONS = [
  { value: "original", label: "Original" },
  { value: "crop", label: "Crop" },
  { value: "pad", label: "Pad" },
  { value: "stretch", label: "Stretch" },
];

// Labels describe intent in plain terms ("what do you want this audio to do"),
// not H3's own internal vocabulary — the underlying `value` is still the exact
// literal token H3's retention_analysis section requires, unchanged. Prompt Gen
// (see _muse_minimax_promptgen_audio_instruction in the Python backend) reads
// this same value to pick the right instruction wording per option.
const AUDIO_RETENTION_OPTIONS = [
  { value: "reference", label: "Voice Reference — new dialogue, same voice" },
  { value: "fully_copy", label: "Lip Sync — drive dialogue from this exact recording" },
  { value: "partially_copy", label: "Partial Voice Match — some traits carried over" },
  { value: "weak_reference", label: "Weak Reference — loose vibe only, not their real voice" },
];
// Same underlying H3 retention tokens as VISUAL_RETENTION_OPTIONS, but with one
// extra entry aimed specifically at the "duplicate this video, replace the
// character" editing workflow — weak_reference explicitly means "no visible
// content is reused," which contradicts what Editing source role is supposed to
// do (keep the same scene/action, swap only the person), so that combination was
// a real, confirmed trap. This gives it its own clearly-labeled preset (mapping
// to partially_preserved, the correct marker for "scene stays, person changes")
// rather than expecting users to reverse-engineer the right abstract term.
// CORRECTED 2026-09-04: this used to have TWO entries sharing the identical
// value "partially_preserved" — this clear one, and a plain generic
// "partially preserved" duplicate lower down. Same value means identical
// compiled behavior either way, but a <select> with two options at the same
// value doesn't reliably keep the intended one visually selected after a
// reload — confirmed directly: after a ComfyUI restart, this flipped to
// showing the plain generic label instead of the clear one it was set to,
// even though the actual retention token sent to H3 was unaffected. Removed
// the duplicate entirely rather than patching the selection logic — there's
// no reason to offer the same value twice under two different labels.
const VIDEO_RETENTION_OPTIONS = [
  { value: "partially_preserved", label: "duplicate video, replace character (recommended for editing)" },
  { value: "fully_preserved", label: "fully preserved" },
  { value: "attribute_transfer", label: "attribute transfer" },
  { value: "weak_reference", label: "weak reference (motion/camera only, scene not reused)" },
];
const VIDEO_ROLE_OPTIONS = [
  { value: "reference", label: "Reference (motion/style/camera)" },
  { value: "editing_source", label: "Editing source (replace something in it)" },
  { value: "continuation_source", label: "Continuation source (extend from it)" },
];
// Same four official H3 audio tokens as AUDIO_RETENTION_OPTIONS, but that array's
// labels are written for a Ref Audio slot's own job — voice-cloning a character's
// dialogue ("new dialogue, same voice"). A reference VIDEO's own embedded
// soundtrack is usually music/beat/ambience, not a voice at all, so those labels
// would be actively misleading here (2026-09-04: this control didn't exist before
// today — the backend hardcoded this track to "reference" unconditionally, with no
// way to select fully_copy and no wording that made sense for a non-voice track).
// Deliberately scoped to ONLY the video block's own paired-audio row (added below,
// gated on entry.includeAudio) — never touches the standalone Ref Audio slots
// above, which keep AUDIO_RETENTION_OPTIONS and their own existing behavior
// completely unchanged.
const VIDEO_AUDIO_RETENTION_OPTIONS = [
  { value: "reference", label: "Reference — guides tone/rhythm, not copied into the final mix" },
  { value: "fully_copy", label: "Reuse exactly — becomes the final audio, drives timing/beat" },
  { value: "partially_copy", label: "Partial reuse — some layers/traits carried over" },
  { value: "weak_reference", label: "Weak reference — loose vibe only" },
];

const CUT_COLORS = [
  { bar: "#4F8EF7", glow: "rgba(79,142,247,0.35)" },
  { bar: "#33C481", glow: "rgba(51,196,129,0.35)" },
  { bar: "#F0665B", glow: "rgba(240,102,91,0.35)" },
  { bar: "#B26BF7", glow: "rgba(178,107,247,0.35)" },
  { bar: "#F7B94F", glow: "rgba(247,185,79,0.35)" },
  { bar: "#4FD1F7", glow: "rgba(79,209,247,0.35)" },
];

const ICON_UPLOAD = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
const ICON_TRASH = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
const ICON_DRAG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="6" r="1.6"/><circle cx="16" cy="6" r="1.6"/><circle cx="8" cy="12" r="1.6"/><circle cx="16" cy="12" r="1.6"/><circle cx="8" cy="18" r="1.6"/><circle cx="16" cy="18" r="1.6"/></svg>`;
const ICON_PLUS = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
const ICON_CHEV = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const ICON_PLAY = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 21 12 6 21 6 3"/></svg>`;
const ICON_PAUSE = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;

const MMD_DEFAULT_WIDTH = 3000;
const MMD_LOADING_HEIGHT = 120;

function injectStyles() {
  // Beta owns the shared Director stylesheet so load order cannot leave stale/smaller CSS active.
  document.getElementById("mmd-v12b-styles")?.remove();
  const style = document.createElement("style");
  style.id = "mmd-v12b-styles";
  style.textContent = `
  .mmd-root {
    display: flex; flex-direction: column; gap: 14px;
    background: linear-gradient(180deg, #14141a 0%, #0d0d11 100%);
    border: 1px solid #3a3a48; border-radius: 12px;
    padding: 14px; box-sizing: border-box; width: 100%;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #e4e4ea;
  }
  .mmd-section-title {
    font-size: 17px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;
    color: #7a7a8c; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;
  }
  .mmd-section-title .mmd-badge {
    background: #ff4d4d22; color: #ff6b6b; border-radius: 4px; padding: 1px 6px;
    font-size: 13px; letter-spacing: 0.04em;
  }
  .mmd-gear-btn {
    background: none; border: none; color: #FF8800; cursor: pointer; font-size: 24px;
    line-height: 1; padding: 2px 6px; border-radius: 4px; margin-left: auto;
  }
  .mmd-gear-btn:hover { color: #ffa733; background: #ffffff14; }
  .mmd-gear-panel {
    position: relative; background: #1a1a22; border: 1px solid #3a3a48; border-radius: 8px;
    padding: 10px; margin: 4px 0 10px 0; display: flex; flex-direction: column; gap: 6px;
  }
  .mmd-gear-panel .mmd-box-row label { color: #9a9aae; font-size: 16px; }
  .mmd-gear-hint { color: #6a6a7c; font-size: 13px; line-height: 1.5; }

  /* Boxed settings panel */
  .mmd-boxes-row { display: flex; gap: 14px; flex-wrap: wrap; }
  .mmd-box {
    flex: 1; min-width: 190px; background: #1e1e26; border: 1px solid #3a3a48;
    border-top: 3px solid #3a3a48; border-radius: 12px; padding: 16px 18px; box-sizing: border-box;
  }
  .mmd-box-generation { border-top-color: #4F8EF7; }
  .mmd-box-resolution { border-top-color: #33C481; }
  .mmd-box-sampling { border-top-color: #F0665B; }
  .mmd-box-reference { border-top-color: #B26BF7; }
  /* Per-chunk section cards — same design language as the settings boxes above,
     own accent colors so Style/Soundscape/Music/Timeline read as distinct,
     clearly-bounded zones instead of blending into the chunk's background
     (the exact complaint that prompted this: "the style box, you can't even
     tell it's there"). */
  .mmd-box-style { border-top-color: #2DD4BF; }
  .mmd-box-soundscape { border-top-color: #E8A33D; }
  .mmd-box-timeline { border-top-color: #4FC3F7; }
  /* Prompt Gen gets a full solid-colored border (not just the usual top accent
     strip) plus a tinted background, so it reads as a clearly separate zone
     rather than another same-looking settings box. */
  .mmd-box-promptgen {
    border: 2px solid #FF4FA3; border-top: 2px solid #FF4FA3; background: #24181f;
  }
  .mmd-box-promptgen .mmd-box-title { color: #FF4FA3; }
  /* Generate/Regenerate/Commit — deliberately much bigger and bolder than the
     other small utility buttons in this UI (Andy: "no one's gonna see" the
     default size), solid pink fill so it can't blend into the dark background. */
  .mmd-promptgen-btn {
    width: 100%; background: #8F3765; border: none; color: #ffffff;
    border-radius: 8px; padding: 12px 0; font-size: 16px; font-weight: 700;
    cursor: pointer; transition: all 0.15s ease;
  }
  .mmd-promptgen-btn:hover { background: #A54578; }
  .mmd-promptgen-btn.mmd-loading { opacity: 0.6; pointer-events: none; }
  .mmd-box-title {
    font-size: 17px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: #8a8a9c; margin-bottom: 12px;
  }
  .mmd-box-subtitle {
    font-size: 14px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
    color: #5a5a68; margin-top: 10px; padding-top: 8px; border-top: 1px solid #22222b;
  }
  .mmd-box-row {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 10px 0; border-top: 1px solid #22222b; min-height: 38px; box-sizing: border-box;
  }
  .mmd-box-row:first-of-type { border-top: none; }
  .mmd-box-row label { font-size: 16px; color: #9a9aa8; white-space: normal; line-height: 1.3; }
  .mmd-box-select, .mmd-box-number {
    background: #101015; border: 1px solid #2e2e3a; border-radius: 6px; color: #e4e4ea;
    font-size: 16px; padding: 7px 10px; max-width: 62%; min-height: 34px; box-sizing: border-box;
  }
  .mmd-box-select option { background: #1a1a22; color: #e4e4ea; font-size: 16px; }
  .mmd-box-checkbox { width: 19px; height: 19px; accent-color: #4F8EF7; cursor: pointer; }
  .mmd-box-select:focus, .mmd-box-number:focus { outline: none; border-color: #4F8EF7; }
  .mmd-number-control { display: grid; grid-template-columns: minmax(0, 1fr) 38px 38px; gap: 5px; width: 100%; min-width: 0; }
  .mmd-number-control .mmd-box-number { width: 100%; max-width: none; -moz-appearance: textfield; }
  .mmd-number-control .mmd-box-number::-webkit-inner-spin-button,
  .mmd-number-control .mmd-box-number::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  .mmd-number-step { background: #181820; border: 1px solid #343441; border-radius: 6px; color: #d4d4dc; cursor: pointer; font-size: 18px; }
  .mmd-number-step:hover { border-color: #4F8EF7; color: #fff; }

  /* Real sliders (Duration/Chunk Size/Steps) — the mockup's own look, which the
     first pass at this redesign skipped entirely and just left as plain number
     boxes. Fill-to-thumb coloring is a JS-driven gradient (updateFill in
     _sliderRow), not achievable in pure CSS for a range input. */
  .mmd-slider-row { padding: 12px 0; border-top: 1px solid #22222b; }
  .mmd-slider-row:first-of-type { border-top: none; }
  .mmd-slider-label { display: block; font-size: 16px; color: #9a9aa8; margin-bottom: 9px; }
  .mmd-slider-track-row { display: flex; align-items: center; gap: 10px; }
  .mmd-slider {
    flex: 1; -webkit-appearance: none; appearance: none; height: 4px; border-radius: 4px;
    background: #33333f; outline: none; cursor: pointer;
  }
  .mmd-slider::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none; width: 17px; height: 17px; border-radius: 50%;
    background: #ffffff; border: 3px solid var(--mmd-accent, #4F8EF7); cursor: pointer;
    box-shadow: 0 1px 3px rgba(0,0,0,0.5);
  }
  .mmd-slider::-moz-range-thumb {
    width: 17px; height: 17px; border-radius: 50%; background: #ffffff; box-sizing: border-box;
    border: 3px solid var(--mmd-accent, #4F8EF7); cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.5);
  }
  .mmd-slider::-moz-range-track { height: 4px; border-radius: 4px; background: #33333f; }
  .mmd-slider-number {
    width: 58px; flex-shrink: 0; background: #101015; border: 1px solid #2e2e3a; border-radius: 6px;
    color: #e4e4ea; font-size: 16px; padding: 7px 8px; min-height: 34px; box-sizing: border-box; text-align: center;
  }
  .mmd-slider-number:focus { outline: none; border-color: var(--mmd-accent, #4F8EF7); }
  .mmd-mode-pill {
    display: inline-block; font-size: 13px; font-weight: 700; letter-spacing: 0.03em;
    padding: 2px 7px; border-radius: 20px; margin-bottom: 8px;
  }
  .mmd-mode-pill.ref { background: #4F8EF722; color: #4F8EF7; }
  .mmd-mode-pill.fl { background: #F7B94F22; color: #F7B94F; }

  .mmd-style-input {
    width: 100%; box-sizing: border-box; background: #1a1a22; border: 1px solid #2e2e3a;
    border-radius: 8px; color: #e4e4ea; padding: 12px 14px; font-size: 16px; resize: vertical;
    min-height: 46px; line-height: 1.4; font-family: inherit;
  }
  .mmd-style-input:focus { outline: none; border-color: #4F8EF7; }

  /* Timeline / ruler */
  .mmd-chunks-wrap { display: flex; flex-direction: column; gap: 24px; }
  /* Deliberately a stronger, more visible border+background than the inner
     boxes (Style/Soundscape/Music/Timeline all nest inside this) — this is
     the "everything about Chunk N in one clearly bounded unit" container, so
     it needs to read at a glance as one card, not blend in with the canvas
     the way a thin 1px border did before. */
  .mmd-chunk-section {
    border: 4px solid #ffffff; border-radius: 18px; padding: 24px; margin: 0 0 34px;
    background: #171720; box-shadow: 0 8px 24px rgba(0,0,0,0.38), inset 0 0 0 1px rgba(255,255,255,0.035);
  }
  .mmd-chunk-heading {
    font-size: 17px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: #c8c8dc; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid #2e2e3a;
    display: flex; align-items: center; gap: 14px; background: #222230; border-radius: 10px; padding: 14px 16px;
  }
  .mmd-chunk-mode-select { margin-left: 2px; min-width: 210px; background: #20202a; border: 1px solid #55556b; border-radius: 7px; color: #efeff6; padding: 6px 10px; font-size: 14px; text-transform: none; letter-spacing: normal; }
  .mmd-chunk-inputs { margin: 0 0 16px; padding: 14px; border: 1px solid #3d3d50; border-radius: 10px; background: #181820; }
  .mmd-chunk-inputs-title { color: #c8c8dc; font-size: 30px; font-weight: 800; margin-bottom: 10px; }
  .mmd-chunk-frame-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 12px; }
  .mmd-chunk-frame-grid .mmd-char-preview { height: auto; aspect-ratio: 16 / 9; min-height: 150px; }
  .mmd-chunk-frame-grid .mmd-char-preview img { object-fit: contain; }
  .mmd-shared-picks { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 12px; }
  .mmd-shared-pick { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border: 1px solid #49495d; border-radius: 7px; background: #20202a; color: #d6d6e2; font-size: 26px; }
  .mmd-shared-pick input { width: 24px; height: 24px; }
  .mmd-chunk-location-row { display: flex; align-items: center; gap: 12px; margin: 8px 0 12px; color: #c8c8dc; font-size: 26px; }
  .mmd-chunk-location-row select { min-width: 300px; font-size: 26px; padding: 6px 10px; }
  .mmd-chunk-stale-banner {
    display: flex; align-items: center; font-size: 14px; color: #1a0f05;
    background: #F7B94F; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px;
  }
  .mmd-chunk-style-wrap { margin-bottom: 10px; }
  .mmd-chunk-style-title-row { display: flex; align-items: center; gap: 6px; }
  .mmd-copy-prev-btn { width: auto; padding: 3px 9px; font-size: 13px; opacity: 0.75; }
  .mmd-copy-prev-btn:hover { opacity: 1; }
  .mmd-ruler-wrap { position: relative; }
  .mmd-ruler {
    position: relative; height: 24px; margin-bottom: 5px; border-bottom: 1px solid #3a3a48;
  }
  .mmd-ruler-tick {
    position: absolute; top: 0; bottom: 0; width: 1px; background: #3a3a48;
  }
  .mmd-ruler-tick-label {
    position: absolute; top: 0; font-size: 12px; color: #66667a; transform: translateX(2px);
  }
  .mmd-track {
    display: flex; height: 142px; border-radius: 10px; overflow: hidden; border: 1px solid #3a3a48;
    background: #18181f;
  }
  .mmd-cut-block {
    position: relative; display: flex; flex-direction: column; min-width: 40px;
    border-right: 1px solid #0d0d11; cursor: grab; box-sizing: border-box;
  }
  .mmd-cut-block.mmd-dragging { opacity: 0.35; }
  .mmd-cut-block.mmd-drag-over { box-shadow: inset 3px 0 0 #fff; }
  .mmd-cut-bar { height: 4px; width: 100%; flex-shrink: 0; }
  .mmd-cut-head {
    display: flex; align-items: center; justify-content: space-between; padding: 5px 7px 3px 7px;
    flex-shrink: 0;
  }
  .mmd-cut-label { font-size: 14px; font-weight: 700; letter-spacing: 0.02em; white-space: nowrap; display: flex; align-items: center; gap: 3px; }
  .mmd-cut-duration-input {
    width: 44px; background: #14141a; border: 1px solid #2a2a35; border-radius: 3px;
    color: #d4d4dc; font-size: 13px; font-weight: 700; font-family: inherit;
    padding: 2px 3px; text-align: right; -moz-appearance: textfield;
  }
  .mmd-cut-duration-input::-webkit-outer-spin-button,
  .mmd-cut-duration-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .mmd-cut-duration-input:focus { outline: none; border-color: #4F8EF7; }
  .mmd-cut-duration-unit { color: #7a7a8c; font-weight: 400; }
  .mmd-cut-actions { display: flex; align-items: center; gap: 5px; color: #5a5a6a; flex-shrink: 0; }
  .mmd-cut-actions svg { display: block; }
  .mmd-cut-del { cursor: pointer; }
  .mmd-cut-del:hover { color: #ff6b6b; }
  .mmd-cut-text {
    width: 100%; flex: 1; box-sizing: border-box; background: transparent; border: none; color: #d4d4dc;
    font-size: 16px; line-height: 1.45; padding: 2px 8px 9px 8px; resize: none; font-family: inherit;
  }
  .mmd-cut-text:focus { outline: none; }
  .mmd-cut-resize {
    position: absolute; top: 0; right: -4px; bottom: 0; width: 8px; cursor: ew-resize; z-index: 4;
  }
  .mmd-cut-resize:hover, .mmd-cut-resize.mmd-active { background: rgba(255,255,255,0.08); }
  .mmd-add-cut {
    width: 44px; flex-shrink: 0; border-left: 1.5px dashed #33333f;
    background: #131318; display: flex; align-items: center; justify-content: center;
    cursor: pointer; color: #5a5a6a; transition: all 0.15s ease;
  }
  .mmd-add-cut:hover { color: #4F8EF7; background: #1e1e26; }
  .mmd-add-cut-bar {
    width: 100%; box-sizing: border-box; margin-top: 6px; padding: 7px;
    border: 2px solid #33C481; border-radius: 8px; background: #249a64;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    cursor: pointer; color: #fff; font-size: 14px; font-weight: 800; transition: all 0.15s ease;
  }
  .mmd-add-cut-bar:hover { color: #fff; background: #2fbd7d; border-color: #6ce7b3; }
  .mmd-add-cut-bar svg { display: block; }
  .mmd-add-chunk-bar {
    width: 100%; box-sizing: border-box; margin-top: 6px; padding: 7px;
    border: 2px solid #4F8EF7; border-radius: 8px; background: #356fca;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    cursor: pointer; color: #fff; font-size: 14px; font-weight: 800; transition: all 0.15s ease;
  }
  .mmd-add-chunk-bar:hover { color: #fff; background: #477fd5; border-color: #8eb8ff; }
  .mmd-add-chunk-bar svg { display: block; }
  .mmd-delete-chunk-bar {
    width: 100%; box-sizing: border-box; margin-top: 6px; padding: 7px;
    border: 2px solid #d33; border-radius: 8px; background: #a93640;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    cursor: pointer; color: #fff; font-size: 14px; font-weight: 800; transition: all 0.15s ease;
  }
  .mmd-delete-chunk-bar:hover { color: #fff; background: #c44853; border-color: #ff9199; }
  .mmd-chunk-actions {
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;
    width: 100%; margin-top: 10px;
  }
  .mmd-chunk-actions .mmd-add-cut-bar,
  .mmd-chunk-actions .mmd-add-chunk-bar,
  .mmd-chunk-actions .mmd-delete-chunk-bar { width: 100%; margin-top: 0; }
  .mmd-track-hint { font-size: 13px; color: #626273; margin-top: 6px; line-height: 1.4; }
  .mmd-long-form-section { font-size: 16px; }
  .mmd-long-form-section .mmd-box-title { font-size: 17px; margin-bottom: 8px; }
  .mmd-long-form-section .mmd-box-row label,
  .mmd-long-form-section .mmd-box-label { font-size: 15px !important; }
  .mmd-long-form-section > input,
  .mmd-long-form-section > select,
  .mmd-long-form-section button { min-height: 34px; padding: 7px 10px; font-size: 15px !important; line-height: 1.2; }
  .mmd-long-form-section > input,
  .mmd-long-form-section > select { color: #eeeeF3; background: #101218; border: 1px solid #46506a; border-radius: 5px; }
  .mmd-long-form-section .mmd-track-hint { font-size: 14px !important; color: #9a9aaa; line-height: 1.45; margin: 8px 0; }
  .mmd-long-form-section .mmd-number-control { grid-template-columns: minmax(0, 1fr) 34px 34px; }
  .mmd-long-form-section .mmd-box-number { min-height: 32px; font-size: 15px !important; }

  /* References row — grid, not flex-wrap. auto-fit (not auto-fill) is the part that
     matters: auto-fill would reserve invisible empty column tracks when the width
     doesn't divide evenly, leaving a gap instead of the row actually reaching the
     edge; auto-fit collapses those empty tracks so the real columns stretch via 1fr
     to consume 100% of the width, always equal size to each other, at any node size. */
  .mmd-char-row {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr)); gap: 10px;
  }
  .mmd-char-slot {
    background: #1e1e26; border: 2px solid #D1A6FA; border-radius: 10px;
    display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
    padding: 5px; cursor: pointer; position: relative; transition: all 0.15s ease; box-sizing: border-box;
  }
  .mmd-char-slot:hover { border-color: #4F8EF7; background: #1a1c24; }
  .mmd-char-slot.mmd-filled {
    border-color: #B26BF7;
    box-shadow: 0 0 0 1px rgba(178,107,247,0.2);
  }
  .mmd-char-slot.mmd-bg-slot { border-color: #F7B94F99; }
  .mmd-char-slot.mmd-bg-slot:hover { border-color: #F7B94F; }
  .mmd-shared-asset-toggle {
    width: 100%; box-sizing: border-box; display: flex; align-items: center; gap: 9px;
    margin-top: 8px; padding: 8px; border-radius: 7px; background: #10261d;
    border: 1px solid #55C99788; color: #bfead7; font-size: 15px; cursor: pointer;
  }
  .mmd-shared-asset-toggle input { flex: 0 0 auto; }
  .mmd-chunk-asset-section { margin-top: 18px; padding: 12px; border: 1px solid #3a3a48; border-radius: 10px; background: #14141a; }
  .mmd-chunk-asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 230px)); gap: 12px; justify-content: start; align-items: stretch; }
  .mmd-chunk-asset-card { width: 230px; min-height: 255px; }
  .mmd-chunk-asset-card .mmd-char-preview { height: 145px; }
  .mmd-chunk-frame-section .mmd-chunk-asset-grid { grid-template-columns: repeat(auto-fill, minmax(360px, 360px)); }
  .mmd-chunk-frame-section .mmd-fl-slot { width: 360px; min-height: 255px; }
  .mmd-chunk-guide-section .mmd-char-slot { border-color: #55C997; }
  .mmd-chunk-location-section .mmd-char-slot { border-color: #F7B94F; }
  .mmd-chunk-av-card { width: 360px; min-width: 360px; max-width: 360px; }
  .mmd-chunk-av-section .mmd-chunk-asset-grid { grid-template-columns: repeat(auto-fill, minmax(360px, 360px)); }
  /* Hybrid per-chunk layout: one full-width image line, then one full-width
     audio/video line. Equal fractions retain the canvas width; taller cards and
     contain-fit previews preserve far more of every uploaded image. */
  .mmd-chunk-image-line .mmd-chunk-asset-grid { grid-template-columns: repeat(13, minmax(0, 1fr)); }
  .mmd-chunk-frame-line .mmd-chunk-asset-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .mmd-chunk-media-line .mmd-chunk-asset-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .mmd-chunk-image-line .mmd-chunk-asset-card,
  .mmd-chunk-frame-line .mmd-chunk-asset-card,
  .mmd-chunk-frame-line .mmd-fl-slot { width: 100%; min-width: 0; min-height: 430px; }
  .mmd-chunk-image-line .mmd-char-preview,
  .mmd-chunk-frame-line .mmd-char-preview,
  .mmd-chunk-frame-line .mmd-fl-slot .mmd-char-preview { width: 100%; height: 250px; min-height: 250px; aspect-ratio: auto; }
  .mmd-chunk-image-line .mmd-char-preview img,
  .mmd-chunk-frame-line .mmd-char-preview img { object-fit: contain; }
  .mmd-chunk-media-line .mmd-chunk-av-card { width: 100%; min-width: 0; max-width: none; }
  .mmd-shared-slot-locked { filter: grayscale(0.8); opacity: 0.42 !important; cursor: not-allowed !important; }
  .mmd-shared-lock-note { width: 100%; box-sizing: border-box; margin-top: 8px; padding: 8px; text-align: center; color: #fff; background: #30303a; border-radius: 6px; font-weight: 800; }  .mmd-char-slot.mmd-char-slot-disabled {
    opacity: 0.35; cursor: not-allowed; pointer-events: none;
  }
  .mmd-char-slot.mmd-char-slot-disabled:hover { border-color: rgba(255,255,255,0.22); background: #1e1e26; }
  .mmd-char-label {
    position: absolute; top: 4px; left: 5px; font-size: 13px; font-weight: 700;
    color: #fff; background: rgba(0,0,0,0.55); border-radius: 4px; padding: 1px 4px;
    z-index: 2; pointer-events: none;
  }
  .mmd-char-placeholder { color: #626273; font-size: 13px; text-align: center; margin-top: 20px; line-height: 1.4; }
  .mmd-char-preview { width: 100%; height: 60px; border-radius: 6px; overflow: hidden; background: #0a0a0d; margin-top: 15px; }
  .mmd-char-preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .mmd-char-del {
    position: absolute; top: 3px; right: 3px; width: 16px; height: 16px; border-radius: 50%;
    background: rgba(0,0,0,0.6); color: #fff; border: none; display: flex; align-items: center;
    justify-content: center; cursor: pointer; z-index: 3; font-size: 12.5px; line-height: 1;
  }
  .mmd-char-del:hover { background: #d33; }
  .mmd-analyze-btn {
    margin-top: 4px; width: 100%; background: #232330; border: 1px solid #3a3a48; color: #b8b8c8;
    border-radius: 6px; padding: 7px 0; font-size: 13px; cursor: pointer; transition: all 0.15s ease;
  }
  .mmd-analyze-btn:hover { background: #2a2a38; color: #fff; border-color: #4F8EF7; }
  .mmd-analyze-btn.mmd-loading { opacity: 0.6; pointer-events: none; }
  .mmd-desc-input {
    margin-top: 4px; width: 100%; box-sizing: border-box; background: #101015; border: 1px solid #26262f;
    border-radius: 5px; color: #c8c8d4; font-size: 14px; padding: 5px 6px; resize: vertical;
    min-height: 38px; font-family: inherit; line-height: 1.4;
  }
  .mmd-fl-note {
    font-size: 14px; color: #9a9aaa; background: #1e1e26; border: 1px solid #3a3a48;
    border-radius: 8px; padding: 10px 12px; line-height: 1.5;
  }
  /* Cut Timing readout — same #D1A6FA purple accent as the character/image
     reference slots (.mmd-char-slot), so it reads as "belongs to this panel"
     at a glance. */
  .mmd-cut-timing-box {
    background: #1e1e26; border: 1px solid #D1A6FA66; border-radius: 8px; padding: 8px 10px;
  }
  .mmd-cut-timing-header {
    font-size: 13px; color: #D1A6FA; font-weight: 600; margin-bottom: 6px;
  }
  .mmd-cut-timing-text {
    width: 100%; box-sizing: border-box; background: #101015; border: 1px solid #26262f;
    border-radius: 5px; color: #c8c8d4; font-size: 12px; padding: 6px 8px; resize: vertical;
    font-family: "Consolas", "Menlo", monospace; line-height: 1.5; white-space: pre;
  }

  /* Every image input is the same kind of visual reference, so First/Last,
     Ref 1-7 and Location share one equal-card responsive grid. Cards wrap
     instead of being squeezed when the node is narrowed. */
  .mmd-ref-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    grid-auto-rows: 1fr; gap: 12px; align-items: stretch;
  }
  .mmd-ref-grid .mmd-char-slot {
    width: 100%; min-width: 0; min-height: 255px; height: 100%;
  }
  .mmd-ref-grid .mmd-char-preview { height: 150px; }
  .mmd-ref-grid .mmd-char-preview img { object-fit: contain; }
  /* First/Last Frame images are timeline composition anchors, not small
     identity thumbnails. Give each one a responsive video-shaped viewport and
     show the complete frame instead of cropping it into a shallow strip. */
  .mmd-ref-grid .mmd-fl-slot { min-height: 0; }
  .mmd-ref-grid .mmd-fl-slot .mmd-char-preview {
    height: auto; aspect-ratio: 16 / 9; min-height: 220px;
  }
  .mmd-ref-grid .mmd-fl-slot .mmd-char-preview img { object-fit: contain; }
  .mmd-ref-grid-notes { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
  .mmd-ref-section { margin-top: 12px; padding: 10px; border: 1px solid #30303b; border-radius: 10px; background: #17171d; }
  .mmd-ref-section:first-of-type { margin-top: 0; }
  .mmd-ref-section.mmd-location-section .mmd-ref-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mmd-ref-section.mmd-location-section .mmd-char-preview {
    height: auto; aspect-ratio: 16 / 9; min-height: 180px; max-height: 320px;
  }
  .mmd-ref-section-title { margin: 0 0 8px; color: #bdbdca; font-size: 14px; font-weight: 800; letter-spacing: 0.06em; }
  .mmd-section-add { display: inline-block; min-width: 240px; margin-top: 8px; padding: 9px 14px; text-align: left; }
  .mmd-char-slot.mmd-fl-slot { border-color: #52B8D999; }
  .mmd-char-slot.mmd-fl-slot:hover, .mmd-char-slot.mmd-fl-slot.mmd-filled { border-color: #52C7EA; box-shadow: 0 0 0 1px rgba(82,199,234,0.18); }
  .mmd-char-slot.mmd-guide-slot { border-color: #55C99799; }
  .mmd-char-slot.mmd-guide-slot:hover, .mmd-char-slot.mmd-guide-slot.mmd-filled { border-color: #55C997; box-shadow: 0 0 0 1px rgba(85,201,151,0.18); }
  .mmd-hybrid-aux-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; }
  .mmd-hybrid-aux-grid .mmd-ref-section { margin-top: 12px; min-width: 0; }
  .mmd-hybrid-aux-grid .mmd-ref-grid { grid-template-columns: 1fr; }
  .mmd-hybrid-aux-grid .mmd-ref-section.mmd-location-section .mmd-ref-grid { grid-template-columns: 1fr; }
  .mmd-hybrid-aux-grid .mmd-bg-slot .mmd-char-preview,
  .mmd-hybrid-aux-grid .mmd-guide-slot .mmd-char-preview {
    height: auto; aspect-ratio: 16 / 9; min-height: 180px;
  }
  .mmd-hybrid-aux-grid .mmd-bg-slot .mmd-char-preview img,
  .mmd-hybrid-aux-grid .mmd-guide-slot .mmd-char-preview img { object-fit: contain; }
  .mmd-loc-chunk-row {
    display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: 13px; color: #9a9aae;
  }
  .mmd-loc-chunk-input {
    width: 46px; background: #101015; border: 1px solid #2e2e3a; border-radius: 5px; color: #e4e4ea;
    font-size: 13px; padding: 4px 5px; box-sizing: border-box;
  }
  .mmd-add-location-btn {
    background: #1a1a22; border: 1px dashed #F7B94F99; color: #F7B94F; border-radius: 8px;
    padding: 10px; font-size: 14px; cursor: pointer; text-align: center; transition: all 0.15s ease;
  }
  .mmd-add-location-btn:hover { background: #24201a; border-color: #F7B94F; }

  /* Reference video / audio slots */
  .mmd-av-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
  .mmd-av-slot {
    flex: 1; min-width: 220px; background: #1e1e26; border-radius: 10px;
    padding: 8px 10px; box-sizing: border-box; position: relative; transition: border-color 0.15s ease;
  }
  /* Video refs = blue, audio refs = orange — kept visually distinct from the
     purple image-reference slots above, per Andy's request to segment reference
     types by color rather than everything sharing one purple. */
  .mmd-av-slot-video { border: 2px solid #4F8EF799; }
  .mmd-av-slot-video:hover { border-color: #4F8EF7; }
  .mmd-av-slot-video.mmd-filled { border-color: #4F8EF7; box-shadow: 0 0 0 1px rgba(79,142,247,0.25); }
  .mmd-av-slot-audio { border: 2px solid #FF8800; }
  .mmd-av-slot-audio:hover { border-color: #ffa733; }
  .mmd-av-slot-audio.mmd-filled { border-color: #ffa733; box-shadow: 0 0 0 1px rgba(255,136,0,0.3); }
  .mmd-av-slot-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .mmd-av-slot-label { font-size: 14px; font-weight: 700; letter-spacing: 0.04em; color: #7a7a8c; text-transform: uppercase; }
  .mmd-av-slot-del {
    width: 16px; height: 16px; border-radius: 50%; background: #232330; color: #fff; border: none;
    display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 12.5px; line-height: 1;
  }
  .mmd-av-slot-del:hover { background: #d33; }
  .mmd-av-placeholder {
    color: #626273; font-size: 13px; text-align: center; padding: 16px 0; cursor: pointer;
    display: flex; flex-direction: column; align-items: center; gap: 4px;
  }
  .mmd-av-placeholder:hover { color: #4F8EF7; }
  .mmd-av-media video { width: 100%; max-height: 500px; border-radius: 6px; background: #000; display: block; }
  .mmd-av-canvas { width: 100%; height: 40px; display: block; border-radius: 6px; background: #0a0a0d; }
  .mmd-av-scrub-row { display: flex; align-items: center; gap: 6px; margin: 6px 0 4px 0; }
  .mmd-av-play-btn {
    width: 22px; height: 22px; border-radius: 50%; background: #232330; border: 1px solid #3a3a48;
    color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer;
    flex-shrink: 0; padding: 0;
  }
  .mmd-av-play-btn:hover { background: #2a2a38; border-color: #4F8EF7; }
  .mmd-av-scrub {
    flex: 1; margin: 0; accent-color: #4F8EF7; cursor: pointer;
  }
  .mmd-av-trim-row { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
  .mmd-av-trim-btn {
    flex: 1; background: #232330; border: 1px solid #3a3a48; color: #b8b8c8; border-radius: 6px;
    padding: 5px 0; font-size: 13px; cursor: pointer;
  }
  .mmd-av-trim-btn:hover { background: #2a2a38; color: #fff; border-color: #4F8EF7; }
  .mmd-av-trim-input {
    flex: 1; width: 0; min-width: 0; background: #101015; border: 1px solid #2e2e3a; border-radius: 6px;
    color: #d8d8e0; font-size: 14px; padding: 6px 8px; text-align: center; box-sizing: border-box;
  }
  .mmd-av-trim-input:focus { outline: none; border-color: #4F8EF7; }
  .mmd-av-trim-readout { font-size: 12px; color: #707080; text-align: center; margin-top: 3px; }
  .mmd-av-filename { font-size: 12px; color: #707080; margin-top: 3px; word-break: break-all; }
  .mmd-av-audio-toggle {
    display: flex; align-items: center; gap: 6px; margin-top: 6px; cursor: pointer;
    font-size: 13px; color: #9a9aa8;
  }
  .mmd-audio-pair-note { font-size: 13px; color: #6a9a7a; margin-bottom: 4px; line-height: 1.4; }
  .mmd-lipsync-box {
    margin-top: 8px; padding: 8px; border-radius: 8px;
    background: #1a1420; border: 1px solid #FF4FA355;
  }

  /* Small secondary selectors (retention markers, video role, CUT speaker) — kept
     visually secondary via color/weight, NOT via tiny type — legibility comes
     first. Options list styled explicitly too, since browsers otherwise render
     a plain white system popup regardless of the select's own dark styling. */
  .mmd-mini-row {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    margin-top: 6px;
  }
  .mmd-mini-row label { font-size: 15px; color: #8a8a98; }
  .mmd-mini-select {
    background: #101015; border: 1px solid #2e2e3a; border-radius: 5px; color: #d4d4dc;
    font-size: 15px; padding: 6px 8px; max-width: 62%; min-height: 32px; box-sizing: border-box;
  }
  .mmd-mini-select option { background: #1a1a22; color: #e4e4ea; font-size: 15px; }

  .mmd-cut-speaker-row {
    display: flex; align-items: center; gap: 6px; padding: 0 7px 8px 7px; flex-wrap: wrap;
  }
  .mmd-cut-speaker-row label { font-size: 14px; color: #8a8a98; white-space: nowrap; }
  .mmd-dialogue-speakers { padding-top: 5px; }
  .mmd-dialogue-speaker-row { display: flex; align-items: center; gap: 6px; padding: 4px 7px; flex-wrap: wrap; border-top: 1px solid #24242d; }
  .mmd-dialogue-line { color: #c8c8d2; font-size: 14px; min-width: 180px; max-width: 58%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mmd-dialogue-speaker-label { font-size: 14px; color: #8a8a98; white-space: nowrap; }
  .mmd-speaker-chip {
    background: #101015; border: 1px solid #2e2e3a; border-radius: 20px; color: #8a8a98;
    font-size: 14px; padding: 4px 11px; cursor: pointer; transition: all 0.15s ease;
  }
  .mmd-speaker-chip:hover { border-color: #4F8EF7; color: #d4d4dc; }
  .mmd-speaker-chip-active {
    background: #4F8EF722; border-color: #4F8EF7; color: #cfe0ff;
  }

  .mmd-lang-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 0; border-top: 1px solid #22222b; }
  .mmd-lang-row label { font-size: 15px; color: #9a9aa8; white-space: nowrap; }
  .mmd-lang-input {
    background: #101015; border: 1px solid #2e2e3a; border-radius: 6px; color: #e4e4ea;
    font-size: 15px; padding: 6px 8px; max-width: 62%; min-height: 32px; box-sizing: border-box;
  }

  /* Overview readability scale. DOM widgets shrink with the ComfyUI canvas,
     unlike the browser-native open select menu, so the source typography must
     be deliberately larger to remain readable at normal workflow overview zoom. */
  .mmd-section-title, .mmd-box-title, .mmd-chunk-heading { font-size: 40px !important; line-height: 1.25; }
  .mmd-chunk-mode-select { font-size: 40px !important; line-height: 1.25; min-height: 64px; min-width: 430px; padding: 8px 16px; }
  .mmd-section-title .mmd-badge, .mmd-mode-pill { font-size: 25px !important; padding: 4px 9px; }
  .mmd-box-subtitle, .mmd-ref-col-title { font-size: 34px !important; line-height: 1.35; }
  .mmd-box-row { display: grid; grid-template-columns: minmax(0, 42%) minmax(160px, 58%); min-height: 72px; padding: 15px 0; column-gap: 18px; align-items: center; }
  .mmd-box-row label, .mmd-slider-label, .mmd-gear-panel .mmd-box-row label,
  .mmd-lang-row label, .mmd-mini-row label { font-size: 34px !important; line-height: 1.3; }
  .mmd-box-select, .mmd-box-number, .mmd-slider-number, .mmd-lang-input,
  .mmd-mini-select { font-size: 34px !important; min-height: 60px; padding: 11px 14px; }
  /* Native select popups are rendered outside ComfyUI's canvas transform. Keep their source size normal while the closed control remains enlarged for readability after the node itself is zoomed down. */
  .mmd-box-select option, .mmd-mini-select option { font-size: 18px !important; }
  .mmd-slider-row { padding: 19px 0; }
  .mmd-slider-label { margin-bottom: 13px; }
  .mmd-style-input, .mmd-cut-text { font-size: 34px !important; line-height: 1.5; }
  /* Give each cut enough vertical editing room for multi-line action and
     dialogue without forcing the textarea to scroll after only a few lines. */
  .mmd-track { height: 420px; }
  .mmd-cut-label, .mmd-cut-speaker-row label { font-size: 34px !important; }
  /* [2026-09-05] The drag/delete icons on each CUT block never got included in
     this readability-scale pass — they stayed at their original fixed 14px
     while the CUT label text next to them grew to 34px, so at normal overview
     zoom they were nearly invisible next to their own label. Match them to
     the same scale as .mmd-cut-label above. */
  .mmd-cut-actions { gap: 16px !important; }
  .mmd-cut-actions svg { width: 32px !important; height: 32px !important; }
  .mmd-cut-duration-input, .mmd-speaker-chip { font-size: 28px !important; }
  .mmd-add-cut-bar, .mmd-add-chunk-bar, .mmd-delete-chunk-bar,
  .mmd-promptgen-btn, .mmd-analyze-btn, .mmd-add-location-btn { font-size: 34px !important; }
  /* The three chunk actions form one compact footer, not three headline bars. */
  .mmd-chunk-actions .mmd-add-cut-bar,
  .mmd-chunk-actions .mmd-add-chunk-bar,
  .mmd-chunk-actions .mmd-delete-chunk-bar {
    font-size: 25px !important; padding: 6px 8px;
  }
  .mmd-gear-hint, .mmd-track-hint, .mmd-fl-note, .mmd-audio-pair-note,
  .mmd-av-audio-toggle { font-size: 28px !important; line-height: 1.5; }
  .mmd-char-label, .mmd-av-slot-label, .mmd-ref-col-title { font-size: 34px !important; }
  .mmd-char-placeholder, .mmd-av-placeholder { font-size: 28px !important; line-height: 1.45; }
  .mmd-desc-input { font-size: 34px !important; min-height: 68px; line-height: 1.45; }
  .mmd-av-trim-btn, .mmd-av-trim-input { font-size: 34px !important; min-height: 54px; }
  .mmd-av-trim-readout, .mmd-av-filename { font-size: 23px !important; line-height: 1.4; }
  .mmd-loc-chunk-row, .mmd-loc-chunk-input { font-size: 28px !important; }
  .mmd-box { padding: 22px 24px; }
  .mmd-box-row > label { min-width: 0; justify-self: start; }
  .mmd-box-row > .mmd-box-select, .mmd-box-row > .mmd-box-number,
  .mmd-box-row > .mmd-lang-input, .mmd-box-row > .mmd-mini-select {
    width: 100%; min-width: 0; max-width: 100%; justify-self: end;
  }
  .mmd-box-select, .mmd-box-number, .mmd-slider-number, .mmd-lang-input, .mmd-mini-select {
    text-align: right; text-align-last: right;
  }
  .mmd-box-row > .mmd-box-checkbox { justify-self: end; }
  .mmd-slider-number { width: 92px; min-width: 92px; flex: 0 0 92px; margin-left: auto; padding-left: 8px; padding-right: 8px; }
  .mmd-slider-track-row { gap: 16px; }
  .mmd-chunk-section { padding: 24px; }
  .mmd-box-style, .mmd-box-soundscape, .mmd-box-promptgen { padding: 20px 22px; }
  .mmd-box-checkbox { width: 28px; height: 28px; }
  `;
  document.head.appendChild(style);
}

// Proven-safe widget hider, copied exactly from LTXInfiniteDirector's own
// muse_director_v2.js — an earlier, simpler version of this (just setting
// options.hidden + a bare computeSize override, no vueNodesMode guard, no draw
// override) caused a white-screen crash / "failed to save workflow draft" on
// this ComfyUI frontend. This guarded version is what actually works.
function hideWidget(w) {
  if (!w) return;
  w.hidden = true;
  if (!w.options) w.options = {};
  w.options.hidden = true;

  if (!window.LiteGraph || !window.LiteGraph.vueNodesMode) {
    w.computeSize = () => [0, -4]; // -4 cancels ComfyUI's hardcoded 4px widget padding
    if (!w._hiddenDrawHooked) {
      w._origDraw = w.hasOwnProperty("draw") ? w.draw : undefined;
      w._hiddenDrawHooked = true;
    }
    w.draw = () => {};
  }

  if (w.element) w.element.style.display = "none";
  if (w.callback) w.callback(w.value);
}

// Reference video/audio clips are real uploaded files (not base64, unlike the small
// character portraits) — same ComfyUI /upload/image endpoint LTX Director's own
// audio/video tracks use (it accepts any file type despite the name).
async function uploadRefFile(file) {
  const body = new FormData();
  body.append("image", file);
  body.append("subfolder", "musedirector");
  const resp = await api.fetchApi("/upload/image", { method: "POST", body });
  if (resp.status !== 200) throw new Error("Upload failed: " + resp.status);
  const data = await resp.json();
  const subfolder = data.subfolder || "";
  return { file: subfolder ? subfolder + "/" + data.name : data.name, fileName: file.name };
}

function comfyViewUrl(entryFile) {
  const idx = entryFile.lastIndexOf("/");
  const subfolder = idx >= 0 ? entryFile.slice(0, idx) : "";
  const name = idx >= 0 ? entryFile.slice(idx + 1) : entryFile;
  return api.apiURL(`/view?filename=${encodeURIComponent(name)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);
}

async function urlToB64(url) {
  const resp = await fetch(url);
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function extractAudioPeaks(file, numPeaks = 120) {
  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  const channelData = audioBuffer.getChannelData(0);
  const peaks = [];
  const step = Math.max(1, Math.floor(channelData.length / numPeaks));
  for (let i = 0; i < numPeaks; i++) {
    let max = 0;
    for (let j = 0; j < step; j++) {
      const val = Math.abs(channelData[i * step + j] || 0);
      if (val > max) max = val;
    }
    peaks.push(max);
  }
  return { peaks, duration: audioBuffer.duration };
}

class MinimaxTimelineEditor {
  // Concrete worked examples for the Base URL / Model placeholders, per provider —
  // "blank = provider default" alone doesn't show a first-time user what a filled-in
  // value is actually supposed to look like.
  static _promptGenPlaceholders(provider) {
    switch (provider) {
      case "lmstudio":
        return { url: "e.g. http://127.0.0.1:1234 (blank = this default)", model: "required — exact name shown in LM Studio's Local Server tab" };
      case "gemini":
        return { url: "blank = Google's endpoint — leave blank", model: "e.g. gemini-2.5-flash (blank = this default)" };
      case "custom":
        return { url: "required — e.g. https://openrouter.ai/api/v1", model: "required — exact model name your endpoint expects" };
      case "ollama":
      default:
        return { url: "e.g. http://127.0.0.1:11434 (blank = this default)", model: "e.g. huihui_ai/qwen3.5-abliterated:2b (blank = this default)" };
    }
  }

  constructor(node) {
    this.node = node;
    this.timelineDataWidget = node.widgets.find((w) => w.name === "timeline_data");
    this.realWidgets = {};
    for (const name of BOXED_WIDGET_NAMES) {
      const w = node.widgets.find((x) => x.name === name);
      if (w) this.realWidgets[name] = w;
    }
    this.timeline = this._loadState();
    this.container = document.createElement("div");
    this.container.className = "mmd-root";
    forwardWheelToComfyCanvas(this.container);
    injectStyles();
    this.build();
  }

  _loadState() {
    let parsed = {};
    try {
      parsed = JSON.parse(this.timelineDataWidget?.value || "{}");
    } catch (e) {
      parsed = {};
    }
    // A workflow saved before this node gained a new required widget (resize_method,
    // seed_hunt, etc.) has its widgets_values array positionally misaligned when
    // loaded against the current INPUT_TYPES order — ComfyUI restores widget values
    // by position, not by name, so timeline_data's slot can end up holding some
    // other widget's saved value instead of real JSON (e.g. a bare number).
    // JSON.parse("3") succeeds (it's valid JSON), so the try/catch above doesn't
    // catch this — it silently produces a non-object, which used to crash hard a
    // few lines below and abort loading the entire workflow (reported directly by
    // a user: "Cannot create property 'characters' on number '3'"). Guard for it
    // explicitly instead.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn("[MuseMinimaxDirector] timeline_data wasn't a valid object (got:", parsed,
        ") — this usually means an older saved workflow's widget values are misaligned with "
        + "this node's current inputs. Resetting this node to a blank timeline; you'll need to "
        + "re-enter its references/CUTs, but the rest of the workflow will load normally.");
      parsed = {};
    }
    if (!Array.isArray(parsed.characters)) parsed.characters = [];
    // CUTs and Prompt Gen used to be one flat timeline shared across every H3 call —
    // built the day chunking's real weakness became clear: a CUT spanning multiple
    // chunks got duplicated verbatim into each one, so chunk 2+ looked like a repeat
    // of chunk 1 instead of a continuation. Each chunk now owns its own independent
    // CUTs and Prompt Gen state. Nothing had been saved under the old flat format in
    // real use yet, so this is a minimal safety net, not a real migration project —
    // if it's ever hit, the whole old flat CUT list becomes Chunk 1 as-is.
    if (!Array.isArray(parsed.chunks) || parsed.chunks.length === 0) {
      const oldSegments = Array.isArray(parsed.segments) && parsed.segments.length > 0
        ? parsed.segments
        : [{ prompt: "", weight: 1 }];
      parsed.chunks = [{
        segments: oldSegments,
        prompt_gen_enabled: !!parsed.prompt_gen_enabled,
        prompt_gen_brief: parsed.prompt_gen_brief || "",
        prompt_gen_draft_text: parsed.prompt_gen_draft_text || "",
        prompt_gen_committed_text: parsed.prompt_gen_committed_text || "",
      }];
    }
    delete parsed.segments;
    delete parsed.prompt_gen_enabled;
    delete parsed.prompt_gen_brief;
    delete parsed.prompt_gen_draft_text;
    delete parsed.prompt_gen_committed_text;
    // style_line / overall_soundscape / non_diegetic_music used to be one flat
    // set shared across every chunk — same class of problem the CUTs/Prompt Gen
    // migration above already solved: a real 60s multi-chunk test showed the
    // model still being told "corridor" for a chunk whose story had already
    // moved into a completely different room, because the single global style
    // line couldn't follow it. Each chunk now owns its own independent
    // style/soundscape/music. The old global value (if any) becomes chunk 1's
    // starting point only — later chunks deliberately start blank rather than
    // inheriting it, so a stale value can never silently carry into a chunk it
    // no longer describes (see _blankChunk's own comment for why "blank" beats
    // "inherited").
    if (typeof parsed.style_line === "string" && parsed.style_line && !parsed.chunks[0].style_line) {
      parsed.chunks[0].style_line = parsed.style_line;
    }
    if (typeof parsed.overall_soundscape === "string" && parsed.overall_soundscape && !parsed.chunks[0].overall_soundscape) {
      parsed.chunks[0].overall_soundscape = parsed.overall_soundscape;
    }
    if (typeof parsed.non_diegetic_music === "string" && parsed.non_diegetic_music && !parsed.chunks[0].non_diegetic_music) {
      parsed.chunks[0].non_diegetic_music = parsed.non_diegetic_music;
    }
    delete parsed.style_line;
    delete parsed.overall_soundscape;
    delete parsed.non_diegetic_music;
    parsed.chunks.forEach((c) => {
      if (!Array.isArray(c.segments) || c.segments.length === 0) c.segments = [{ prompt: "", weight: 1 }];
      c.segments.forEach((s) => { if (!s.weight) s.weight = 1; });
      if (typeof c.prompt_gen_enabled !== "boolean") c.prompt_gen_enabled = false;
      if (typeof c.prompt_gen_brief !== "string") c.prompt_gen_brief = "";
      if (typeof c.prompt_gen_draft_text !== "string") c.prompt_gen_draft_text = "";
      if (typeof c.prompt_gen_committed_text !== "string") c.prompt_gen_committed_text = "";
      // Six-section MiniMax H3 prompt-format fields, per chunk — see MiniMax's
      // own reference-mode prompt-writing guide. overall_soundscape/
      // non_diegetic_music are their own two required sections in that format
      // (ambience/physical sound vs audience-only score).
      if (typeof c.style_line !== "string") c.style_line = "";
      if (c.generation_mode === "Hybrid") c.generation_mode = "First/Last Frame";
      if (!["Reference", "First/Last Frame"].includes(c.generation_mode)) c.generation_mode = "Reference";
      if (typeof c.firstFrameImage !== "object" || c.firstFrameImage === null) c.firstFrameImage = {};
      if (typeof c.lastFrameImage !== "object" || c.lastFrameImage === null) c.lastFrameImage = {};
      if (!Array.isArray(c.localCharacters)) c.localCharacters = Array(MAX_CHARACTER_SLOTS).fill(null);
      while (c.localCharacters.length < MAX_CHARACTER_SLOTS) c.localCharacters.push(null);
      if (!Array.isArray(c.localLocations)) c.localLocations = [null];
      if (!Array.isArray(c.localGuides)) c.localGuides = [];
      if (!Array.isArray(c.localRefVideos)) c.localRefVideos = Array(REF_AV_SLOTS).fill(null);
      while (c.localRefVideos.length < REF_AV_SLOTS) c.localRefVideos.push(null);
      if (!Array.isArray(c.localRefAudios)) c.localRefAudios = Array(REF_AV_SLOTS).fill(null);
      while (c.localRefAudios.length < REF_AV_SLOTS) c.localRefAudios.push(null);
      delete c.shared_ref_indices;
      delete c.shared_video_indices;
      delete c.shared_audio_indices;
      delete c.shared_location_index;
      if (typeof c.overall_soundscape !== "string") c.overall_soundscape = "";
      if (typeof c.non_diegetic_music !== "string") c.non_diegetic_music = "";
    });
    if (typeof parsed.background !== "object" || parsed.background === null) parsed.background = {};
    // Location redesign: a single global `background` + Hybrid-mode-only
    // hybridFirstFrame/hybridLastFrame became a real per-chunk `locations` list
    // and independent firstFrameImage/lastFrameImage shared by both First/Last
    // Frame and Hybrid modes (Ref 1/Ref 2 no longer double as FFLF pins).
    // Migrate a workflow saved before this change once, on load.
    if (!Array.isArray(parsed.locations)) parsed.locations = [];
    if (parsed.locations.length === 0 && parsed.background && (parsed.background.file || parsed.background.image_b64)) {
      parsed.locations = [{ ...parsed.background, chunk: 1 }];
    }
    if (parsed.locations.length === 0) parsed.locations.push({ chunk: 1 });
    if (typeof parsed.firstFrameImage !== "object" || parsed.firstFrameImage === null) {
      parsed.firstFrameImage = (parsed.hybridFirstFrame && (parsed.hybridFirstFrame.file || parsed.hybridFirstFrame.image_b64))
        ? parsed.hybridFirstFrame : {};
    }
    if (typeof parsed.lastFrameImage !== "object" || parsed.lastFrameImage === null) {
      parsed.lastFrameImage = (parsed.hybridLastFrame && (parsed.hybridLastFrame.file || parsed.hybridLastFrame.image_b64))
        ? parsed.hybridLastFrame : {};
    }
    if (!Array.isArray(parsed.guideImages)) parsed.guideImages = [];
    const hybridFrameChunks = parsed.chunks
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.generation_mode !== "Reference");
    if (hybridFrameChunks.length) {
      const firstLegacy = parsed.firstFrameImage || {};
      const lastLegacy = parsed.lastFrameImage || {};
      if ((firstLegacy.file || firstLegacy.image_b64) && !parsed.chunks.some((c) => c.firstFrameImage?.file || c.firstFrameImage?.image_b64)) {
        hybridFrameChunks[0].c.firstFrameImage = { ...firstLegacy };
      }
      if ((lastLegacy.file || lastLegacy.image_b64) && !parsed.chunks.some((c) => c.lastFrameImage?.file || c.lastFrameImage?.image_b64)) {
        hybridFrameChunks[hybridFrameChunks.length - 1].c.lastFrameImage = { ...lastLegacy };
      }
    }
    if (!Array.isArray(parsed.refVideos)) parsed.refVideos = [];
    while (parsed.refVideos.length < REF_AV_SLOTS) parsed.refVideos.push(null);
    if (!Array.isArray(parsed.refAudios)) parsed.refAudios = [];
    while (parsed.refAudios.length < REF_AV_SLOTS) parsed.refAudios.push(null);
    // Existing bottom-panel assets predate explicit sharing. Preserve their previous
    // global behaviour once; newly uploaded assets start unshared until ticked.
    if (!parsed.shared_assets_v2) {
      for (const list of [parsed.characters, parsed.locations, parsed.refVideos, parsed.refAudios]) {
        for (const entry of (list || [])) if (entry && (entry.file || entry.image_b64)) entry.shared = true;
      }
      parsed.shared_assets_v2 = true;
    }
    // dialogue_language feeds every <d>[Language]...</d> dialogue tag — stays
    // global, unlike style/soundscape/music, since the spoken language doesn't
    // change scene to scene the way setting/ambience does.
    if (typeof parsed.dialogue_language !== "string" || !parsed.dialogue_language) parsed.dialogue_language = "English";
    // Prompt Gen's brief/draft/committed text is per-chunk now (see the chunk
    // migration above) — provider/backend settings stay global, since there's no
    // reason to reconfigure which LLM answers per chunk, only what it's asked.
    // Deliberately separate from analyze_provider/base_url/model (the per-image Analyze
    // button's settings) — writing a full six-section scene prompt is a harder task than
    // a one-sentence caption, so people may want a bigger/slower model here while keeping
    // a small fast one for Analyze.
    if (typeof parsed.prompt_gen_provider !== "string") parsed.prompt_gen_provider = "ollama";
    if (typeof parsed.prompt_gen_base_url !== "string") parsed.prompt_gen_base_url = "";
    if (typeof parsed.prompt_gen_model !== "string") parsed.prompt_gen_model = "";
    return parsed;
  }

  commitChanges() {
    if (this.timelineDataWidget) {
      this.timelineDataWidget.value = JSON.stringify(this.timeline);
    }
    this.node.setDirtyCanvas(true, true);
    this._scheduleLongFormAutosave();
  }

  _scheduleLongFormAutosave() {
    const enabled = !!this.realWidgets?.long_form_enabled?.value;
    const projectId = this.realWidgets?.long_form_project_id?.value;
    if (!enabled || !projectId || this._loadingLongFormProject) return;
    clearTimeout(this._longFormSaveTimer);
    this._longFormSaveTimer = setTimeout(async () => {
      try {
        await api.fetchApi("/muse_minimax_director_v1_4/save_long_form_project", {
          method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({project_id: projectId, name: this.timeline.long_form_project_name || projectId, timeline: this.timeline, widgets: this._longFormWidgetSnapshot()}),
        });
      } catch (error) { console.error("Long-form autosave failed", error); }
    }, 750);
  }

  // ── Save / Load timeline as a standalone JSON file ──────────────────────
  // Purely client-side — this.timeline is already the exact object serialized
  // into timeline_data, so a file round-trip is just stringify/parse, no
  // server route needed the way image/video uploads require one.
  _downloadTimelineJSON(filename) {
    const blob = new Blob([JSON.stringify(this.timeline, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.endsWith(".json") ? filename : filename + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Chromium browsers support a real native "choose folder + filename" save
  // dialog via showSaveFilePicker — plain <a download> can't do this (a
  // webpage silently picking where to write files on disk would be a real
  // security hole), so this is the only way to get an actual location prompt.
  // Falls back to the old download-to-Downloads-folder behavior wherever
  // showSaveFilePicker isn't available (e.g. Firefox).
  async _saveTimelineWithPicker(suggestedName) {
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: "JSON file", accept: { "application/json": [".json"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(JSON.stringify(this.timeline, null, 2));
        await writable.close();
        return;
      } catch (err) {
        if (err.name === "AbortError") return; // user cancelled the dialog, not an error
        console.error("[MuseMinimaxDirector] Save dialog failed, falling back to direct download", err);
      }
    }
    this._downloadTimelineJSON(suggestedName);
  }

  saveTimeline() {
    this._saveTimelineWithPicker("muse_minimax_timeline.json");
  }

  saveTimelineAs() {
    if (window.showSaveFilePicker) {
      this._saveTimelineWithPicker("muse_minimax_timeline.json");
      return;
    }
    const name = prompt("Save timeline as:", "muse_minimax_timeline.json");
    if (name) this._downloadTimelineJSON(name);
  }

  loadTimelineFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("File doesn't contain a valid timeline object.");
        }
        this.timeline = parsed;
        this.commitChanges();
        this.build();
      } catch (err) {
        console.error("[MuseMinimaxDirector] Failed to load timeline file", err);
        alert("Couldn't load that file as a timeline — see console for details.");
      }
    };
    input.click();
  }

  isReferenceMode() {
    const w = this.realWidgets.mode;
    return !w || String(w.value || "").startsWith(MODE_REFERENCE_PREFIX);
  }

  isHybridMode() {
    const w = this.realWidgets.mode;
    return !!w && String(w.value || "").startsWith(MODE_HYBRID_PREFIX);
  }

  isFirstLastMode() {
    const w = this.realWidgets.mode;
    return !!w && String(w.value || "").startsWith(MODE_FIRST_LAST_PREFIX);
  }

  build() {
    this.container.innerHTML = "";
    this.container.appendChild(this._buildSettingsBoxes());

    // Style / Soundscape / Music used to live here as one global set of fields
    // for the whole timeline — moved into each chunk section below (see
    // _buildChunkSection) since a single global value can't follow the story
    // once it moves past chunk 1 (confirmed directly on a real 60s test).

    const cutsTitle = document.createElement("div");
    cutsTitle.className = "mmd-section-title";
    cutsTitle.innerHTML = `Timeline <span class="mmd-badge">drag edges to time, drag blocks to reorder</span>`;
    this.container.appendChild(cutsTitle);

    // One ruler+track+CUTs section per H3 generation call — each chunk's CUTs are
    // independent, so chunk 2 never inherits or repeats chunk 1's content the way
    // a single CUT spanning a chunk boundary used to. Populated by renderTimeline().
    this.chunksWrap = document.createElement("div");
    this.chunksWrap.className = "mmd-chunks-wrap";
    this.container.appendChild(this.chunksWrap);

    const hint = document.createElement("div");
    hint.className = "mmd-track-hint";
    hint.textContent = "Total Duration longer than Chunk Size splits the render into multiple H3 calls, shown as separate chunk sections below — block widths within a chunk are a pacing guide only, compiled into each CUT's own \"(~Xs)\" hint.";
    this.container.appendChild(hint);

    // [2026-09-06] Was a "📷 References" heading with a tiny ⚙ gear button that
    // toggled this same settings content hidden/shown, squeezed in between the
    // heading and the actual reference picture grid — confirmed via real user
    // feedback nobody ever noticed the gear existed. Now its own permanently
    // visible "⚙️ Settings" section, placed above References entirely, so
    // References is immediately followed by its own picture grid with nothing
    // in between, and Settings is impossible to miss.
    this.settingsTitle = document.createElement("div");
    this.settingsTitle.className = "mmd-section-title";
    this.settingsTitle.style.marginTop = "4px";
    const settingsTitleText = document.createElement("span");
    settingsTitleText.textContent = "⚙️ Settings";
    this.settingsTitle.appendChild(settingsTitleText);
    this.container.appendChild(this.settingsTitle);

    this.analyzeGearPanel = this._buildAnalyzeSettingsPanel();
    this.analyzeGearPanel.style.display = "flex";
    this.container.appendChild(this.analyzeGearPanel);

    this.refsTitle = document.createElement("div");
    this.refsTitle.className = "mmd-section-title";
    this.refsTitle.style.marginTop = "4px";
    const refsTitleText = document.createElement("span");
    refsTitleText.textContent = "📷 References";
    this.refsTitle.appendChild(refsTitleText);
    this.container.appendChild(this.refsTitle);

    this.refsBox = document.createElement("div");
    this.refsBox.className = "mmd-box mmd-box-reference";
    this.refsArea = document.createElement("div");
    this.refsBox.appendChild(this.refsArea);
    this.container.appendChild(this.refsBox);

    this.renderTimeline();
    this.renderReferences();
    this._toggleReferenceBox();
  }

  // Ported directly from the Combo/TwoStage node's own working V2 dashboard
  // (already proven there, including having already hit and fixed the exact
  // same "collapses into a tiny extremely tall column" failure this went
  // through) rather than re-deriving node auto-sizing from scratch a fifth
  // time. ResizeObserver — not getBoundingClientRect polling — is the actual
  // fix: it fires on real layout changes to the container itself and isn't
  // subject to whatever async delay ComfyUI's canvas-transform attachment has
  // for getBoundingClientRect. offsetHeight/scrollHeight (not
  // getBoundingClientRect) are layout-box measurements, unaffected by that
  // same attachment timing.
  _attachAutoResize(timelineWidget) {
    this.timelineWidget = timelineWidget;
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => this._scheduleNodeResize());
      this._resizeObserver.observe(this.container);
    }
    this._scheduleNodeResize();
  }

  _beginLayout() {
    // Ignore stale saved heights; measure only the natural-flow inner editor.
    this._contentHeight = MMD_LOADING_HEIGHT;
    this.container.style.visibility = "hidden";
    this.layoutShell.style.maxHeight = `${MMD_LOADING_HEIGHT}px`;
    this.layoutLabel.hidden = false;
    const savedWidth = Number(this.node.size?.[0]);
    const width = Number.isFinite(savedWidth) && savedWidth >= 1200
      ? savedWidth : MMD_DEFAULT_WIDTH;
    this.node.setSize([width, MMD_LOADING_HEIGHT + 70]);
    clearTimeout(this._layoutTimeout);
    // Fail open if this frontend defers attaching an off-screen DOM widget.
    this._layoutTimeout = setTimeout(() => {
      this._revealLayout();
      this._scheduleNodeResize();
    }, 1500);
  }

  _revealLayout() {
    clearTimeout(this._layoutTimeout);
    this.container.style.visibility = "";
    this.layoutShell.style.maxHeight = "";
    this.layoutLabel.hidden = true;
  }

  _disposeLayout() {
    this._layoutDisposed = true;
    clearTimeout(this._layoutTimeout);
    cancelAnimationFrame(this._resizeFrame);
    this._resizeObserver?.disconnect();
  }

  _scheduleNodeResize() {
    if (this._layoutDisposed || !this.timelineWidget || !this.node?.setSize) return;
    if (this._resizeFrame) cancelAnimationFrame(this._resizeFrame);
    this._resizeFrame = requestAnimationFrame(() => {
      // A second frame lets textarea drag-resizes and freshly rebuilt
      // reference media settle before measuring.
      this._resizeFrame = requestAnimationFrame(() => {
        if (!this.container.isConnected || this.container.offsetWidth < 560) return;
        const contentHeight = Math.max(
          this.container.offsetHeight || 0,
          this.container.scrollHeight || 0,
          640,
        );
        // Never derive from this.node.size[1] here — that's exactly the
        // self-referential feedback loop that shipped and grew a real saved
        // node to over 1.5 million pixels tall: computeSize feeding the
        // node's own current height back into itself, compounding on every
        // layout pass. contentHeight above is measured fresh from the DOM
        // every time, never from the node's own prior size.
        const width = Math.max(this.node.size?.[0] || 560, 560);
        const height = Math.ceil(contentHeight + 70);
        this._contentHeight = contentHeight;
        if (!this.node.size || Math.abs(this.node.size[1] - height) > 2 || this.node.size[0] !== width) {
          this.node.setSize([width, height]);
          this.node.setDirtyCanvas?.(true, true);
        }
        this._revealLayout();
      });
    });
  }

  // ── Boxed settings panel (re-skins the real native widgets) ────────────────
  _buildSettingsBoxes() {
    const row = document.createElement("div");
    row.className = "mmd-boxes-row";

    row.appendChild(this._buildGenerationBox());
    row.appendChild(this._buildResolutionBox());
    row.appendChild(this._buildSamplingBox());
    return row;
  }

  _buildGenerationBox() {
    const box = document.createElement("div");
    box.className = "mmd-box mmd-box-generation";

    const title = document.createElement("div");
    title.className = "mmd-box-title";
    title.textContent = "Generation";
    box.appendChild(title);

    const modeW = this.realWidgets.mode;
    if (modeW) {
      const pill = document.createElement("div");
      const updatePill = () => {
        pill.className = "mmd-mode-pill " + (this.isReferenceMode() ? "ref" : this.isHybridMode() ? "hybrid" : "fl");
        pill.textContent = this.isReferenceMode() ? "Reference (Omni)" : this.isHybridMode() ? "Hybrid" : "First / Last Frame";
      };
      updatePill();
      box.appendChild(pill);

      box.appendChild(this._selectRow("Mode", modeW, () => {
        updatePill();
        this.renderTimeline();
        this.renderReferences();
        this._toggleReferenceBox();
        this._updateLongFormVisibility();
      }));
    }
    if (this.realWidgets.duration_seconds) {
      // Back to being the one source of truth for chunk count/length (Total
      // Duration ÷ Chunk Size, uniform chunks, same as originally) — the
      // independent-per-chunk-length model this briefly became was over-
      // correcting for a narrower bug (see _applyDurationChunkSizeChange).
      box.appendChild(this._sliderRow("Total Duration (s)", this.realWidgets.duration_seconds, "#4F8EF7", (previousValue) => {
        this._applyDurationChunkSizeChange(() => { this.realWidgets.duration_seconds.value = previousValue; });
        this.renderTimeline();
        this.renderReferences();
      }));
    }
    if (this.realWidgets.chunk_duration_seconds) {
      box.appendChild(this._sliderRow("Chunk Size (s)", this.realWidgets.chunk_duration_seconds, "#4F8EF7", (previousValue) => {
        this._applyDurationChunkSizeChange(() => { this.realWidgets.chunk_duration_seconds.value = previousValue; });
        this.renderTimeline();
        this.renderReferences();
      }));
    }
    // Always built (not conditionally appended) so it has a stable element to
    // show/hide in place — matches refSubBox's pattern in _buildResolutionBox.
    // Visibility is re-checked live from every place that can change either
    // half of its condition (mode select above, Ref Audio retention dropdown,
    // Ref Audio slot delete), not just once at build time — a stale build-time
    // check let this panel (and its still-true long_form_enabled underneath)
    // survive a mode/retention change invisibly, which is exactly what threw
    // "Long-Form Resume is available only for Reference/Hybrid Lip Sync
    // renders." at Run on 2026-09-03 with no visible checkbox left to explain it.
    this.longFormBox = this._buildLongFormProjectBox();
    box.appendChild(this.longFormBox);
    this._updateLongFormVisibility();
    return box;
  }

  _hasLipSync() {
    const entries = [...(this.timeline.refAudios || [])];
    for (const chunk of (this.timeline.chunks || [])) entries.push(...(chunk.localRefAudios || []));
    return entries.some(entry => entry && entry.file && (entry.retention || "reference") === "fully_copy");
  }

  // Single source of truth for whether "Lip Sync — Long-Form Resume" should be
  // visible at all: Reference/Hybrid mode AND at least one Lip Sync Ref Audio —
  // the exact same condition the Python backend enforces at execute() time.
  // Also forces long_form_enabled off the moment the condition stops holding,
  // so a checkbox ticked under an old mode/retention can never survive hidden
  // and silently fail the run later — hiding the button alone isn't enough.
  _updateLongFormVisibility() {
    if (!this.longFormBox) return;
    const shouldShow = (this.isReferenceMode() || this.isHybridMode()) && this._hasLipSync();
    this.longFormBox.style.display = shouldShow ? "" : "none";
    if (!shouldShow && this.realWidgets.long_form_enabled?.value) {
      this.realWidgets.long_form_enabled.value = false;
      if (this.longFormEnabledCheckbox) this.longFormEnabledCheckbox.checked = false;
      this.commitChanges();
    }
  }

  _longFormWidgetSnapshot() {
    const values = {};
    for (const [name, widget] of Object.entries(this.realWidgets || {})) {
      if (name !== "timeline_data" && widget && ["string", "number", "boolean"].includes(typeof widget.value)) values[name] = widget.value;
    }
    return values;
  }

  async _saveLongFormProject(name, statusEl) {
    const response = await api.fetchApi("/muse_minimax_director_v1_4/save_long_form_project", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({project_id: this.realWidgets.long_form_project_id?.value || "", name, timeline: this.timeline, widgets: this._longFormWidgetSnapshot()}),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "Project save failed");
    this.realWidgets.long_form_project_id.value = data.project.project_id;
    this.timeline.long_form_project_name = data.project.name;
    if (statusEl) statusEl.textContent = `Saved — completed through chunk ${data.project.completed_chunk || 0}`;
    this.commitChanges();
    return data.project;
  }

  async _loadLongFormProjects(select) {
    const response = await api.fetchApi("/muse_minimax_director_v1_4/long_form_projects");
    const data = await response.json();
    select.innerHTML = '<option value="">Choose saved project…</option>';
    for (const project of (data.projects || [])) {
      const option = document.createElement("option"); option.value = project.project_id;
      option.textContent = `${project.name} — chunk ${project.completed_chunk || 0}`; select.appendChild(option);
    }
  }

  async _loadLongFormProject(projectId) {
    const response = await api.fetchApi("/muse_minimax_director_v1_4/load_long_form_project", {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({project_id: projectId}),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "Project load failed");
    const project = data.project;
    this._loadingLongFormProject = true;
    this.timeline = this._parseTimeline(JSON.stringify(project.timeline || {}));
    for (const [name, value] of Object.entries(project.widgets || {})) if (this.realWidgets[name] && name !== "timeline_data") this.realWidgets[name].value = value;
    // Fixed 2026-09-02: this used to force long_form_enabled true unconditionally
    // on every project load — confirmed as a real bug, causing "Long-Form Resume
    // is available only for Reference/Hybrid Lip Sync renders" to fire on runs
    // where the visible "Save resumable project" checkbox looked unticked (the
    // checkbox reflects the real widget, but this line was silently overriding
    // it behind the user's back). Loading a project to inspect/resume it should
    // not unilaterally decide this run saves/continues as that project — leave
    // the checkbox as the single source of truth; only populate the project ID
    // so Load/Save target the right project once the user does tick it.
    this.realWidgets.long_form_project_id.value = project.project_id;
    this.realWidgets.render_chunk_start.value = Math.min((project.completed_chunk || 0) + 1, this.timeline.chunks.length || 1);
    this.realWidgets.render_chunk_end.value = Math.min(this.timeline.chunks.length || 1, (project.completed_chunk || 0) + 4);
    this.timeline.long_form_project_name = project.name;
    this.commitChanges(); this._loadingLongFormProject = false; this.build();
  }

  _buildLongFormProjectBox() {
    const section = document.createElement("div"); section.className = "mmd-long-form-section"; section.style.cssText = "margin-top:12px;padding-top:10px;border-top:1px solid #3d4960;";
    const heading = document.createElement("div"); heading.className = "mmd-box-title"; heading.textContent = "Lip Sync — Long-Form Resume"; section.appendChild(heading);
    const enabledRow = this._boolRow("Save resumable project", this.realWidgets.long_form_enabled);
    this.longFormEnabledCheckbox = enabledRow.querySelector("input");
    section.appendChild(enabledRow);
    const name = document.createElement("input"); name.type = "text"; name.placeholder = "Project name"; name.value = this.timeline.long_form_project_name || ""; name.style.cssText = "width:100%;box-sizing:border-box;margin:5px 0;padding:6px;background:#101218;color:#eee;border:1px solid #46506a;border-radius:4px;"; section.appendChild(name);
    const actions = document.createElement("div"); actions.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:6px;";
    const save = document.createElement("button"); save.textContent = "Create / Save Project";
    const load = document.createElement("button"); load.textContent = "Load Project"; actions.append(save, load); section.appendChild(actions);
    const saved = document.createElement("select"); saved.style.cssText = "width:100%;margin-top:6px;"; section.appendChild(saved);
    const status = document.createElement("div"); status.className = "mmd-track-hint"; status.textContent = "Each completed chunk is saved to disk; only the newest continuation checkpoint is retained."; section.appendChild(status);
    const range = document.createElement("div"); range.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:7px;";
    range.append(this._numberRow("Start chunk", this.realWidgets.render_chunk_start), this._numberRow("End chunk", this.realWidgets.render_chunk_end)); section.appendChild(range);
    save.onclick = async () => { try { if (!name.value.trim()) return alert("Name the project first."); this.realWidgets.long_form_enabled.value = true; await this._saveLongFormProject(name.value.trim(), status); await this._loadLongFormProjects(saved); } catch (error) { alert(error.message); } };
    load.onclick = async () => { try { if (!saved.value) return alert("Choose a saved project first."); await this._loadLongFormProject(saved.value); } catch (error) { alert(error.message); } };
    this._loadLongFormProjects(saved).catch(error => { status.textContent = error.message; });
    return section;
  }

  _buildResolutionBox() {
    const box = document.createElement("div");
    box.className = "mmd-box mmd-box-resolution";

    const title = document.createElement("div");
    title.className = "mmd-box-title";
    title.textContent = "Resolution";
    box.appendChild(title);

    if (this.realWidgets.aspect_ratio) box.appendChild(this._selectRow("Aspect Ratio", this.realWidgets.aspect_ratio));
    if (this.realWidgets.megapixels) box.appendChild(this._numberRow("Megapixels", this.realWidgets.megapixels));
    if (this.realWidgets.multiple) box.appendChild(this._numberRow("Multiple Of", this.realWidgets.multiple));
    if (this.realWidgets.resize_method) box.appendChild(this._selectRow("Resize Method", this.realWidgets.resize_method));

    if (this.realWidgets.vae_reencode_carry_test) {
      const carryDivider = document.createElement("div");
      carryDivider.className = "mmd-box-title";
      carryDivider.style.cssText = "margin-top:12px;font-size:14px;line-height:1.4;opacity:0.8;";
      carryDivider.textContent = "Continuity (VAE Re-encode Carry)";
      box.appendChild(carryDivider);
      box.appendChild(this._boolRow("Enable VAE Re-encode Carry", this.realWidgets.vae_reencode_carry_test));
      if (this.realWidgets.vae_reencode_carry_length) {
        box.appendChild(this._numberRow("Carry Length (frames)", this.realWidgets.vae_reencode_carry_length));
      }
      if (this.realWidgets.raw_latent_carry_test) {
        box.appendChild(this._boolRow("Raw Latent Carry", this.realWidgets.raw_latent_carry_test));
      }
    }

    // Reference Settings folded in here — used to be its own box, but with only
    // Ref Image Size + Dialogue Language in it (and Ref Image Size hidden outside
    // Reference mode besides), it was too thin to justify a fourth box on its own.
    // Only Ref Image Size is genuinely Reference-mode-only; Dialogue Language
    // previously shared its box and inherited the same mode-based hide — kept
    // identical here via refSubBox's own toggle, not the whole Resolution box
    // (which must always stay visible in every mode).
    this.refSubBox = document.createElement("div");
    const refTitle = document.createElement("div");
    refTitle.className = "mmd-box-title";
    refTitle.style.cssText = "margin-top:12px;font-size:14px;line-height:1.4;opacity:0.8;";
    refTitle.textContent = "Reference Settings";
    this.refSubBox.appendChild(refTitle);
    if (this.realWidgets.ref_image_size) {
      this.refSubBox.appendChild(this._selectRow("Ref Image Size", this.realWidgets.ref_image_size));
    }
    this.refSubBox.appendChild(this._dialogueLanguageRow());
    const carryTip = document.createElement("div");
    carryTip.className = "mmd-help";
    carryTip.style.marginTop = "10px";
    carryTip.textContent = "Keep VAE Re-encode Carry and Raw Latent Carry switched on — together they're what makes a multi-chunk render continue smoothly from one chunk into the next instead of resetting. Carry Length just controls how much of the previous chunk it hands off — leave it at the default unless you have a reason to change it.";
    this.refSubBox.appendChild(carryTip);
    box.appendChild(this.refSubBox);
    this._toggleReferenceBox();

    return box;
  }

  _buildSamplingBox() {
    const box = document.createElement("div");
    box.className = "mmd-box mmd-box-sampling";

    const title = document.createElement("div");
    title.className = "mmd-box-title";
    title.textContent = "Sampling";
    box.appendChild(title);

    if (this.realWidgets.sampler_name) box.appendChild(this._selectRow("Sampler", this.realWidgets.sampler_name));
    if (this.realWidgets.scheduler) box.appendChild(this._selectRow("Scheduler", this.realWidgets.scheduler));
    if (this.realWidgets.steps) box.appendChild(this._sliderRow("Steps", this.realWidgets.steps, "#F0665B"));
    if (this.realWidgets.seed) box.appendChild(this._seedRow(this.realWidgets.seed));
    if (this.realWidgets.control_after_generate) box.appendChild(this._selectRow("After Generate", this.realWidgets.control_after_generate));
    // seed_hunt itself is legacy-only now (see BOXED_WIDGET_NAMES comment) — never
    // given a row of its own here. enable_seed_hunt is the real on/off switch —
    // candidate_count only matters once this is on, and is greyed out (not just
    // hidden) below when it's off, so it's visually obvious it's inert rather than
    // silently ignored. Confirmed directly as a real, reported problem: candidate_count
    // alone used to decide whether Seed Hunt ran at all, which meant a plain number
    // silently rerouted which output socket carried real data (main images/audio vs
    // candidate_1..4) with no visible on/off state anywhere in the UI. Orthogonal to
    // Latent-Only Scouting below — that decides what each pass that runs actually
    // does, this decides whether/how many run at all.
    if (this.realWidgets.enable_seed_hunt || this.realWidgets.candidate_count) {
      const label = document.createElement("div");
      label.className = "mmd-box-subtitle";
      label.textContent = "Seed Hunt";
      box.appendChild(label);
      let candidateCountRow = null;
      const applyEnabledState = () => {
        if (!candidateCountRow) return;
        const on = !!this.realWidgets.enable_seed_hunt?.value;
        candidateCountRow.style.opacity = on ? "1" : "0.4";
        candidateCountRow.style.pointerEvents = on ? "" : "none";
        const select = candidateCountRow.querySelector("select");
        if (select) select.disabled = !on;
      };
      if (this.realWidgets.enable_seed_hunt) {
        box.appendChild(this._boolRow("Enable Seed Hunt", this.realWidgets.enable_seed_hunt, applyEnabledState));
      }
      if (this.realWidgets.candidate_count) {
        candidateCountRow = this._selectRow("Candidates to scout", this.realWidgets.candidate_count);
        box.appendChild(candidateCountRow);
        applyEnabledState();
      }
      const hint = document.createElement("div");
      hint.className = "mmd-track-hint";
      hint.textContent = "Off: one normal run, straight to images/audio. On: candidate 1 always runs for free, each extra candidate is one more full pass (same settings, different seed) — 4 candidates takes ~4x as long as 1.";
      box.appendChild(hint);
    }
    if (this.realWidgets.two_stage_seed_hunt_latent_only) {
      box.appendChild(this._boolRow("Seed Hunt: Latent-Only Scouting", this.realWidgets.two_stage_seed_hunt_latent_only));
    }
    if (this.realWidgets.use_prompt_override) box.appendChild(this._boolRow("Prompt Override (from socket)", this.realWidgets.use_prompt_override));
    if (this.realWidgets.shift_video) box.appendChild(this._numberRow("Shift (video)", this.realWidgets.shift_video));
    if (this.realWidgets.shift_audio) box.appendChild(this._numberRow("Shift (audio)", this.realWidgets.shift_audio));

    if (this.realWidgets.two_stage_sampling) {
      const twoStageDivider = document.createElement("div");
      twoStageDivider.className = "mmd-box-title";
      twoStageDivider.style.cssText = "margin-top:12px;font-size:14px;line-height:1.4;opacity:0.8;";
      twoStageDivider.textContent = "Two-Stage Sampling";
      box.appendChild(twoStageDivider);
      box.appendChild(this._boolRow("Enable Two-Stage Sampling", this.realWidgets.two_stage_sampling));
      if (this.realWidgets.two_stage_first_pass_steps) {
        box.appendChild(this._numberRow("First-Pass Steps", this.realWidgets.two_stage_first_pass_steps));
      }
      if (this.realWidgets.two_stage_latent_upscale_model) {
        box.appendChild(this._selectRow("Upscale Model", this.realWidgets.two_stage_latent_upscale_model));
      }
      if (this.realWidgets.two_stage_target_megapixels) {
        box.appendChild(this._numberRow("Target Megapixels", this.realWidgets.two_stage_target_megapixels));
      }
      if (this.realWidgets.two_stage_enable_temporal_chunking) {
        box.appendChild(this._boolRow("Upscale: Temporal Chunking", this.realWidgets.two_stage_enable_temporal_chunking));
      }
    }
    return box;
  }

  // Hybrid Continuation and Seam Interpolation Frames rows are hidden for now
  // (not removed) — their widgets stay registered via BOXED_WIDGET_NAMES so
  // they're still cleanly hidden native widgets rather than leaking as raw
  // unstyled ones, they just don't get a visible row anywhere. Whatever value
  // each already has (e.g. Seam Interpolation Frames' saved 2) keeps applying
  // either way — this only hides the controls, it doesn't reset or disable them.
  _toggleReferenceBox() {
    if (this.refSubBox) this.refSubBox.style.display = (this.isReferenceMode() || this.isHybridMode()) ? "block" : "none";
    // Soundscape/Music used to be Reference-mode-only (H3's First/Last Frame
    // checkpoint never encodes reference audio), but the base-mode prompt format
    // (T2VA/I2VA/FL2VA/L2VA) has its own overall_soundscape/non_diegetic_music
    // sections too, per MiniMax's own guide — so this box now stays visible in
    // both modes.
  }

  _selectRow(labelText, widget, onChange) {
    const rowEl = document.createElement("div");
    rowEl.className = "mmd-box-row";
    const label = document.createElement("label");
    label.textContent = labelText;
    rowEl.appendChild(label);

    const select = document.createElement("select");
    select.className = "mmd-box-select";
    let opts = widget.options?.values;
    if (!Array.isArray(opts)) opts = Array.isArray(widget.options) ? widget.options : [];
    // [2026-09-24] Saved value not in the current list (e.g. a model file that was
    // renamed/removed) — show it as missing instead of letting the browser silently
    // display the first option. Otherwise the box looks fixed while widget.value is
    // still the old name, and picking the only real option never fires "change".
    if (widget.value != null && widget.value !== "" && !(opts || []).includes(widget.value)) {
      const missing = document.createElement("option");
      missing.value = widget.value;
      missing.textContent = `⚠ missing: ${widget.value}`;
      missing.selected = true;
      select.appendChild(missing);
    }
    (opts || []).forEach((v) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = v;
      if (v === widget.value) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener("change", () => {
      widget.value = select.value;
      if (widget.callback) widget.callback(select.value);
      this.node.setDirtyCanvas(true, true);
      if (onChange) onChange();
    });
    rowEl.appendChild(select);
    return rowEl;
  }

  // Real slider + synced number box, matching the reference mockup — used for
  // widgets with a sensible bounded drag range (Duration, Chunk Size, Steps).
  // accentColor should match the box's own border-top-color so the thumb/fill
  // reads as belonging to that category. The fill-to-thumb coloring is a JS
  // gradient recomputed on every input, since a plain <input type=range> can't
  // express "filled up to the current value" in pure CSS.
  _sliderRow(labelText, widget, accentColor, onChange) {
    const rowEl = document.createElement("div");
    rowEl.className = "mmd-slider-row";
    const label = document.createElement("label");
    label.className = "mmd-slider-label";
    label.textContent = labelText;
    rowEl.appendChild(label);

    const trackRow = document.createElement("div");
    trackRow.className = "mmd-slider-track-row";

    const min = widget.options?.min ?? 0;
    const max = widget.options?.max ?? 100;
    const step = widget.options?.step ?? 1;

    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "mmd-slider";
    slider.min = min; slider.max = max; slider.step = step;
    slider.value = widget.value;
    slider.style.setProperty("--mmd-accent", accentColor);

    const number = document.createElement("input");
    number.type = "number";
    number.className = "mmd-slider-number";
    number.min = min; number.max = max; number.step = step;
    number.value = widget.value;

    const updateFill = () => {
      const pct = max > min ? ((parseFloat(slider.value) - min) / (max - min)) * 100 : 0;
      slider.style.background =
        `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${pct}%, #33333f ${pct}%, #33333f 100%)`;
    };
    const commit = (val) => {
      const previousValue = widget.value;
      widget.value = val;
      if (widget.callback) widget.callback(widget.value);
      this.node.setDirtyCanvas(true, true);
      if (onChange) onChange(previousValue);
    };
    slider.addEventListener("input", () => {
      number.value = slider.value;
      updateFill();
    });
    slider.addEventListener("change", () => commit(parseFloat(slider.value)));
    number.addEventListener("change", () => {
      let v = parseFloat(number.value);
      if (isNaN(v)) v = widget.value;
      v = Math.min(max, Math.max(min, v));
      number.value = v;
      slider.value = v;
      updateFill();
      commit(v);
    });
    updateFill();

    // [2026-09-05] Added: this slider/number pair is only synced from the
    // widget's value here, at construction time — nothing re-reads widget.value
    // afterward. Code elsewhere (Add Chunk / Delete Chunk / auto-insert-for-
    // video) sets widget.value directly to grow/shrink Total Duration without
    // going through this row's own slider/number inputs, so the on-screen
    // number went stale — the underlying value was actually correct, the
    // display just never got told to catch up. Stash a sync function on the
    // widget itself so any code that changes widget.value programmatically can
    // call _syncWidgetSliderUI(widget) right after, and this row (and any
    // other _sliderRow built for the same widget) updates immediately.
    widget._mmdSyncUI = (val) => {
      slider.value = val;
      number.value = val;
      updateFill();
    };

    trackRow.appendChild(slider);
    trackRow.appendChild(number);
    rowEl.appendChild(trackRow);
    return rowEl;
  }

  // [2026-09-05] Added — see the _mmdSyncUI comment in _sliderRow above.
  _syncWidgetSliderUI(widget) {
    if (widget && widget._mmdSyncUI) widget._mmdSyncUI(widget.value);
  }

  _numberRow(labelText, widget, onChange) {
    const rowEl = document.createElement("div");
    rowEl.className = "mmd-box-row";
    const label = document.createElement("label");
    label.textContent = labelText;
    rowEl.appendChild(label);

    const input = document.createElement("input");
    input.type = "number";
    input.className = "mmd-box-number";
    input.min = widget.options?.min ?? 1;
    input.max = widget.options?.max ?? 15;
    const guideMegapixels = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98, 1.0, 1.2, 1.5, 1.8, 2.0];
    const allowed = (widget.name === "megapixels" || widget.name === "two_stage_target_megapixels") ? guideMegapixels : null;
    const explicitSteps = { multiple: 8, shift_video: 1, shift_audio: 1, two_stage_first_pass_steps: 1 };
    const step = explicitSteps[widget.name] ?? widget.options?.step ?? 0.5;
    input.step = allowed ? "any" : step;
    input.value = widget.value;
    const commitValue = (raw) => {
      let value = Number(raw);
      if (!Number.isFinite(value)) value = Number(widget.value);
      value = Math.min(Number(input.max), Math.max(Number(input.min), value));
      if (allowed) value = allowed.reduce((best, candidate) => Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best, allowed[0]);
      widget.value = value;
      input.value = value;
      if (widget.callback) widget.callback(widget.value);
      this.node.setDirtyCanvas(true, true);
      if (onChange) onChange();
    };
    input.addEventListener("change", () => commitValue(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      stepBy(e.key === "ArrowUp" ? 1 : -1);
    });
    const stepBy = (direction) => {
      const current = Number(widget.value);
      if (allowed) {
        // Walk the official H3 table by index. Comparing floats by greater/less
        // allowed Comfy's 0.1 normalization to skip 1.0 after the legal 0.98 value.
        let nearestIndex = 0;
        for (let i = 1; i < allowed.length; i++) {
          if (Math.abs(allowed[i] - current) < Math.abs(allowed[nearestIndex] - current)) nearestIndex = i;
        }
        const nextIndex = Math.max(0, Math.min(allowed.length - 1, nearestIndex + direction));
        commitValue(allowed[nextIndex]);
      } else {
        commitValue(current + direction * step);
      }
    };
    const control = document.createElement("div"); control.className = "mmd-number-control";
    const down = document.createElement("button"); down.type = "button"; down.className = "mmd-number-step"; down.textContent = "−"; down.addEventListener("click", () => stepBy(-1));
    const up = document.createElement("button"); up.type = "button"; up.className = "mmd-number-step"; up.textContent = "+"; up.addEventListener("click", () => stepBy(1));
    control.append(input, down, up);
    rowEl.appendChild(control);
    return rowEl;
  }

  _boolRow(labelText, widget, onChange) {
    const rowEl = document.createElement("div");
    rowEl.className = "mmd-box-row";
    const label = document.createElement("label");
    label.textContent = labelText;
    rowEl.appendChild(label);

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "mmd-box-checkbox";
    input.checked = !!widget.value;
    input.addEventListener("change", () => {
      widget.value = input.checked;
      if (widget.callback) widget.callback(widget.value);
      this.node.setDirtyCanvas(true, true);
      if (onChange) onChange();
    });
    rowEl.appendChild(input);
    return rowEl;
  }

  // Small secondary select bound directly to a timeline_data object field (not a
  // real ComfyUI widget) — used for retention markers and video role, which only
  // exist in timeline_data, not as node inputs.
  _miniSelectRow(labelText, currentValue, options, onChange) {
    const rowEl = document.createElement("div");
    rowEl.className = "mmd-mini-row";
    rowEl.addEventListener("click", (e) => e.stopPropagation());
    const label = document.createElement("label");
    label.textContent = labelText;
    rowEl.appendChild(label);

    const select = document.createElement("select");
    select.className = "mmd-mini-select";
    options.forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === currentValue) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener("change", () => {
      onChange(select.value);
      this.commitChanges();
    });
    rowEl.appendChild(select);
    return rowEl;
  }

  // Feeds every <d>[Language]...</d> dialogue tag in the compiled prompt — lives in
  // timeline_data, not a real widget, same as style_line.
  _dialogueLanguageRow() {
    const rowEl = document.createElement("div");
    rowEl.className = "mmd-lang-row";
    const label = document.createElement("label");
    label.textContent = "Dialogue Language";
    rowEl.appendChild(label);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "mmd-lang-input";
    input.value = this.timeline.dialogue_language || "English";
    input.addEventListener("input", () => {
      this.timeline.dialogue_language = input.value || "English";
      this.commitChanges();
    });
    rowEl.appendChild(input);
    return rowEl;
  }

  _seedRow(widget) {
    const rowEl = document.createElement("div");
    rowEl.className = "mmd-box-row";
    const label = document.createElement("label");
    label.textContent = "Seed";
    rowEl.appendChild(label);

    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.pattern = "[0-9]*";
    input.className = "mmd-box-number";
    input.value = String(widget.value);
    input.addEventListener("change", () => {
      const digits = input.value.replace(/[^0-9]/g, "");
      input.value = digits || "0";
      widget.value = Number(digits || "0");
      if (widget.callback) widget.callback(widget.value);
      this.node.setDirtyCanvas(true, true);
    });
    rowEl.appendChild(input);

    // ComfyUI's native "control_after_generate" (fixed/increment/decrement/randomize)
    // mutates widget.value directly right after each queued prompt, to preview the
    // next run's seed — it does NOT go through widget.callback. Since this row only
    // read widget.value once at build time, that mutation was invisible here and the
    // displayed number went stale after the first randomize. Re-defining the property
    // with our own accessor catches every future write, from any source, and mirrors
    // it into the input live.
    let currentValue = widget.value;
    Object.defineProperty(widget, "value", {
      configurable: true,
      get: () => currentValue,
      set: (v) => {
        currentValue = v;
        if (document.activeElement !== input) input.value = String(v);
      },
    });

    return rowEl;
  }

  // ── Timeline / ruler ─────────────────────────────────────────────────────
  get durationSeconds() {
    return this.realWidgets.duration_seconds ? Number(this.realWidgets.duration_seconds.value) || 10 : 10;
  }

  get chunkSizeSeconds() {
    // Same ceiling as the Python side's own chunk_duration_seconds widget (max 15,
    // H3's own single-call limit) and the same math as _bucket_segments_into_chunks
    // there — this MUST stay identical to the backend's own arithmetic, since the
    // whole point of per-chunk sections is that what you see here is what actually
    // renders as separate H3 calls.
    const v = this.realWidgets.chunk_duration_seconds ? Number(this.realWidgets.chunk_duration_seconds.value) : 10;
    return Math.min(15, v || 10);
  }

  // Back to being derived from Total Duration / Chunk Size (ceiling division) —
  // the one source of truth for chunk count, same as originally. Add Chunk /
  // Delete Chunk (see below) are shortcuts that move Total Duration by exactly
  // one Chunk Size rather than an independent way to set chunk count.
  _numChunks() {
    return Math.max(1, Math.ceil(this.durationSeconds / this.chunkSizeSeconds));
  }

  // Deliberately blank style_line/overall_soundscape/non_diegetic_music on a
  // new chunk rather than inheriting the previous chunk's — an inherited value
  // is just as capable of going stale and unnoticed as the old single global
  // field was (confirmed directly: a real 60s test had every chunk describing
  // "corridor" long after the story had moved to a different room). Blank is
  // visibly "you haven't set this yet"; the Copy-from-previous button next to
  // each field in _buildChunkSection is the explicit, one-click way to reuse
  // wording that genuinely hasn't changed, without it happening silently.
  _blankChunk() {
    return {
      segments: [{ prompt: "", weight: 1 }],
      prompt_gen_enabled: false,
      prompt_gen_brief: "",
      prompt_gen_draft_text: "",
      prompt_gen_committed_text: "",
      generation_mode: "Reference",
      firstFrameImage: {},
      lastFrameImage: {},
      localCharacters: Array(MAX_CHARACTER_SLOTS).fill(null),
      localLocations: [null],
      localGuides: [],
      localRefVideos: Array(REF_AV_SLOTS).fill(null),
      localRefAudios: Array(REF_AV_SLOTS).fill(null),
      style_line: "",
      overall_soundscape: "",
      non_diegetic_music: "",
    };
  }

  // Safe, general-purpose sync — only ever GROWS timeline.chunks to match the
  // current Total Duration / Chunk Size math, never removes anything. Called
  // from renderTimeline on every render, so it must never pop a confirm()
  // dialog or do anything destructive/interactive; see
  // _applyDurationChunkSizeChange for the explicit, user-triggered version
  // that can actually shrink the array.
  _syncChunkCount() {
    const numChunks = this._numChunks();
    while (this.timeline.chunks.length < numChunks) {
      this.timeline.chunks.push(this._blankChunk());
    }
    this.commitChanges();
  }

  // Total Duration / Chunk Size slider onChange only: actually removes
  // trailing chunk(s) when the new math implies fewer than before — this was
  // the real original bug (shrinking duration used to only ever leave a chunk
  // stuck and invisible-but-still-present, never actually gone). Confirms
  // first if any chunk about to be dropped still has real CUT text; on
  // cancel, onCancelRevert puts the widget back to its previous value so the
  // mismatch can't linger and re-prompt on the next render.
  _applyDurationChunkSizeChange(onCancelRevert) {
    const numChunks = this._numChunks();
    if (this.timeline.chunks.length > numChunks) {
      const dropping = this.timeline.chunks.slice(numChunks);
      const hasContent = dropping.some((c) =>
        (c.segments || []).some((s) => (s.prompt || "").trim()) || (c.prompt_gen_committed_text || "").trim()
      );
      if (hasContent && !confirm(
        `Shrinking removes ${dropping.length} chunk(s) at the end that still have CUT text in them. Continue?`
      )) {
        if (onCancelRevert) onCancelRevert();
        this.commitChanges();
        return;
      }
      this.timeline.chunks.length = numChunks;
    }
    this._syncChunkCount();
  }

  // Display-only — the compiled prompt's own "(~Xs)" pacing hint always stays
  // in seconds regardless of this toggle (H3 itself only understands seconds).
  _formatDuration(seconds) {
    if (this.timeline.display_mode === "frames") {
      return Math.round(seconds * 24) + "f";
    }
    return seconds.toFixed(1) + "s";
  }

  // Mirrors _bucket_segments_into_chunks's own bounds math on the Python side
  // exactly (same ceiling division, same "last chunk absorbs the remainder",
  // same folding of an under-4s trailing remainder into the previous chunk) —
  // this MUST stay identical to the backend, since what's shown here as chunk
  // sections is meant to be exactly what renders as separate H3 calls.
  _chunkBoundsSeconds() {
    const duration = this.durationSeconds;
    const chunkSize = this.chunkSizeSeconds;
    const numChunks = Math.max(1, Math.ceil(duration / chunkSize));
    const bounds = [];
    let cursor = 0;
    for (let i = 0; i < numChunks; i++) {
      const end = i === numChunks - 1 ? duration : Math.min(duration, cursor + chunkSize);
      bounds.push([cursor, end]);
      cursor = end;
    }
    const minChunkSeconds = 4.0;
    while (bounds.length > 1 && (bounds[bounds.length - 1][1] - bounds[bounds.length - 1][0]) < minChunkSeconds) {
      bounds[bounds.length - 2][1] = bounds[bounds.length - 1][1];
      bounds.pop();
    }
    return bounds;
  }

  // Shortcut for "Total Duration += Chunk Size" — appends one more chunk's
  // worth of content at the end and grows Total Duration to match. Chunks are
  // uniform slices of Total Duration again, not independent lengths, so this
  // always adds capacity at the end regardless of which chunk's own button was
  // clicked — there's no "insert in the middle" once every chunk is the same
  // length.
  // 2026-09-04: fires automatically whenever a video ref's Set Out is actually
  // edited (button or typed value — see the two call sites), not just from a
  // manual button someone has to know exists. Confirmed directly this matters
  // for people other than the one person who understands the node's internals:
  // a manual-only trigger is exactly the kind of "you had to already know the
  // trick" behavior that doesn't work for someone else picking this node up.
  // Only ever ADDS chunks (never removes) and only when the new window
  // genuinely needs more than what already exists, so trimming Set Out back
  // down never deletes a chunk someone may have already written CUT text
  // into. Leaves entry._autoChunkNote set so the panel can show what just
  // happened and why — silently changing Duration and adding chunks behind a
  // simple "type a number" action would be its own kind of confusing
  // otherwise.
  _autoInsertChunksForVideo(entry) {
    const start = parseFloat(entry.trimStartSec) || 0;
    const end = parseFloat(entry.trimEndSec);
    if (!(end > start)) return;
    const needed = end - start;
    const chunksNeeded = Math.max(1, Math.ceil(needed / this.chunkSizeSeconds));
    const before = this.timeline.chunks.length;
    if (chunksNeeded <= before) return;
    while (this.timeline.chunks.length < chunksNeeded) {
      this._addChunkAfter(this.timeline.chunks.length - 1);
    }
    const totalWidget = this.realWidgets.duration_seconds;
    if (totalWidget) {
      totalWidget.value = Math.round(needed * 10) / 10;
      this._syncWidgetSliderUI(totalWidget);
    }
    entry.continueAcrossChunks = true;
    const added = chunksNeeded - before;
    entry._autoChunkNote = `Added ${added} chunk${added === 1 ? "" : "s"} and set Duration to `
      + `${(Math.round(needed * 10) / 10).toFixed(1)}s to cover this video's full Set In/Out window. `
      + `"Continue across chunks" was turned on automatically.`;
    this._syncChunkCount();
    this.renderTimeline();
    this.renderReferences();
    this.commitChanges();
  }

  _addChunkAfter(chunkIdx) {
    const totalWidget = this.realWidgets.duration_seconds;
    if (totalWidget) {
      totalWidget.value = Math.round((this.durationSeconds + this.chunkSizeSeconds) * 10) / 10;
      this._syncWidgetSliderUI(totalWidget);
    }
    this.timeline.chunks.push(this._blankChunk());
    this._syncChunkCount();
    this.renderTimeline();
    this.renderReferences();
  }

  // Removes THIS chunk's own content (CUTs/style/soundscape/music) and shifts
  // every later chunk's content up one slot, then shrinks Total Duration by
  // one Chunk Size to match the new (one fewer) chunk count. Confirms first if
  // this chunk still has real CUT text. Always leaves at least one chunk.
  _deleteChunk(chunkIdx) {
    if (this.timeline.chunks.length <= 1) {
      alert("Can't delete the last remaining chunk — clear its CUTs instead if you want it empty.");
      return;
    }
    const chunk = this.timeline.chunks[chunkIdx];
    const hasContent = chunk && (chunk.segments || []).some((s) => (s.prompt || "").trim());
    if (hasContent && !confirm(`Chunk ${chunkIdx + 1} has CUT text in it — delete it anyway?`)) {
      return;
    }
    this.timeline.chunks.splice(chunkIdx, 1);
    const totalWidget = this.realWidgets.duration_seconds;
    if (totalWidget) {
      totalWidget.value = Math.max(
        this.chunkSizeSeconds, Math.round((this.durationSeconds - this.chunkSizeSeconds) * 10) / 10,
      );
      this._syncWidgetSliderUI(totalWidget);
    }
    this._syncChunkCount();
    this.renderTimeline();
    this.renderReferences();
  }

  renderTimeline() {
    this._syncChunkCount();
    this.chunksWrap.innerHTML = "";
    this.tracks = [];
    const bounds = this._chunkBoundsSeconds();
    bounds.forEach((b, chunkIdx) => {
      this.chunksWrap.appendChild(this._buildChunkSection(chunkIdx, b[1] - b[0]));
    });
  }

  _buildChunkSection(chunkIdx, chunkDurSeconds) {
    const chunk = this.timeline.chunks[chunkIdx];
    const wrap = document.createElement("div");
    wrap.className = "mmd-chunk-section";

    const heading = document.createElement("div");
    heading.className = "mmd-chunk-heading";
    const headingText = document.createElement("span");
    headingText.textContent = `CHUNK ${chunkIdx + 1}`;
    heading.appendChild(headingText);
    if (this.isHybridMode()) {
      const modeSelect = document.createElement("select");
      modeSelect.className = "mmd-chunk-mode-select";
      for (const value of ["Reference", "First/Last Frame"]) {
        const option = document.createElement("option");
        option.value = value; option.textContent = value;
        modeSelect.appendChild(option);
      }
      modeSelect.value = chunk.generation_mode || "Reference";
      modeSelect.addEventListener("change", () => {
        chunk.generation_mode = modeSelect.value;
        this.commitChanges();
        this.renderTimeline();
      });
      heading.appendChild(modeSelect);
    }
    wrap.appendChild(heading);

    if (chunk.stale) {
      const banner = document.createElement("div");
      banner.className = "mmd-chunk-stale-banner";
      banner.textContent = "This chunk has older content from before — review it before generating.";
      const dismiss = document.createElement("button");
      dismiss.className = "mmd-analyze-btn";
      dismiss.style.width = "auto";
      dismiss.style.marginLeft = "8px";
      dismiss.textContent = "Reviewed";
      dismiss.addEventListener("click", () => {
        chunk.stale = false;
        this.commitChanges();
        this.renderTimeline();
      });
      banner.appendChild(dismiss);
      wrap.appendChild(banner);
    }

    wrap.appendChild(this._buildChunkStyleSoundBlock(chunkIdx, chunk));

    const timelineBox = document.createElement("div");
    timelineBox.className = "mmd-box mmd-box-timeline";
    const timelineTitle = document.createElement("div");
    timelineTitle.className = "mmd-box-title";
    timelineTitle.textContent = "✂ Timeline / CUTs";
    timelineBox.appendChild(timelineTitle);
    wrap.appendChild(timelineBox);

    const rulerWrap = document.createElement("div");
    rulerWrap.className = "mmd-ruler-wrap";
    timelineBox.appendChild(rulerWrap);

    const ruler = document.createElement("div");
    ruler.className = "mmd-ruler";
    const tickCount = Math.min(15, Math.max(4, Math.round(chunkDurSeconds)));
    for (let t = 0; t <= tickCount; t++) {
      const pct = (t / tickCount) * 100;
      const tick = document.createElement("div");
      tick.className = "mmd-ruler-tick";
      tick.style.left = pct + "%";
      ruler.appendChild(tick);
      const lbl = document.createElement("div");
      lbl.className = "mmd-ruler-tick-label";
      lbl.style.left = pct + "%";
      lbl.textContent = this._formatDuration((t / tickCount) * chunkDurSeconds);
      ruler.appendChild(lbl);
    }
    rulerWrap.appendChild(ruler);

    const track = document.createElement("div");
    track.className = "mmd-track";
    this.tracks[chunkIdx] = track;
    rulerWrap.appendChild(track);

    const totalWeight = chunk.segments.reduce((s, seg) => s + (seg.weight || 1), 0) || 1;
    chunk.segments.forEach((seg, i) => {
      track.appendChild(this._buildCutBlock(chunkIdx, seg, i, totalWeight, chunkDurSeconds));
    });

    const addBar = document.createElement("div");
    addBar.className = "mmd-add-cut-bar";
    addBar.innerHTML = ICON_PLUS + "<span>Add an extra cut</span>";
    addBar.title = "Add CUT";
    addBar.addEventListener("click", () => {
      chunk.segments.push({ prompt: "", weight: 1 });
      this.commitChanges();
      this.renderTimeline();
    });
    const actionRow = document.createElement("div");
    actionRow.className = "mmd-chunk-actions";
    actionRow.appendChild(addBar);

    const addChunkBar = document.createElement("div");
    addChunkBar.className = "mmd-add-chunk-bar";
    addChunkBar.innerHTML = ICON_PLUS + "<span>Add Chunk</span>";
    addChunkBar.title = "Add a new chunk right after this one";
    addChunkBar.addEventListener("click", () => this._addChunkAfter(chunkIdx));
    actionRow.appendChild(addChunkBar);

    const deleteChunkBar = document.createElement("div");
    deleteChunkBar.className = "mmd-delete-chunk-bar";
    deleteChunkBar.innerHTML = ICON_TRASH + "<span>Delete Chunk</span>";
    deleteChunkBar.title = "Remove this chunk entirely — Total Duration shrinks to match";
    deleteChunkBar.addEventListener("click", () => this._deleteChunk(chunkIdx));
    actionRow.appendChild(deleteChunkBar);

    if (this.isHybridMode()) wrap.appendChild(this._buildHybridChunkInputs(chunkIdx, chunk));
    // Chunk actions belong at the physical bottom of the card, after any
    // per-chunk image/video/audio reference controls.
    wrap.appendChild(actionRow);

    return wrap;
  }

  // Per-chunk Style / Overall Soundscape / Non-Diegetic Music — see the
  // _blankChunk and _loadState comments for why these start blank on every
  // new chunk instead of inheriting the previous chunk's wording.
  // Same .mmd-box card language as the top settings boxes (_buildSettingsBoxes)
  // and Prompt Gen — Style previously had no box at all (just a bare textarea),
  // which is exactly why it "you can't even tell it's there" next to
  // Soundscape/Music, which already had one. All three now match.
  _buildChunkStyleSoundBlock(chunkIdx, chunk) {
    const wrap = document.createElement("div");
    wrap.className = "mmd-chunk-style-wrap";

    const styleBox = document.createElement("div");
    styleBox.className = "mmd-box mmd-box-style";
    styleBox.style.marginBottom = "14px";
    const styleTitleRow = document.createElement("div");
    styleTitleRow.className = "mmd-chunk-style-title-row";
    const styleLabel = document.createElement("div");
    styleLabel.className = "mmd-box-title";
    styleLabel.textContent = "✨ Style";
    styleTitleRow.appendChild(styleLabel);
    if (chunkIdx > 0) styleTitleRow.appendChild(this._copyFromPrevButton(chunkIdx, "style_line"));
    styleBox.appendChild(styleTitleRow);
    const styleInput = document.createElement("textarea");
    styleInput.className = "mmd-style-input";
    styleInput.style.minHeight = "60px";
    styleInput.placeholder = "e.g. Photorealistic, warm golden-hour light, cinematic shallow depth of field... (lighting/palette/camera feel — not location, that belongs in this chunk's own CUT text)";
    styleInput.value = chunk.style_line || "";
    styleInput.addEventListener("input", () => {
      chunk.style_line = styleInput.value;
      this.commitChanges();
    });
    styleBox.appendChild(styleInput);
    wrap.appendChild(styleBox);

    const soundRow = document.createElement("div");
    soundRow.className = "mmd-boxes-row";

    const soundscapeBox = document.createElement("div");
    soundscapeBox.className = "mmd-box mmd-box-soundscape";
    const soundscapeTitleRow = document.createElement("div");
    soundscapeTitleRow.className = "mmd-chunk-style-title-row";
    const soundscapeTitle = document.createElement("div");
    soundscapeTitle.className = "mmd-box-title";
    soundscapeTitle.textContent = "🔊 Overall Soundscape";
    soundscapeTitleRow.appendChild(soundscapeTitle);
    if (chunkIdx > 0) soundscapeTitleRow.appendChild(this._copyFromPrevButton(chunkIdx, "overall_soundscape"));
    soundscapeBox.appendChild(soundscapeTitleRow);
    const soundscapeInput = document.createElement("textarea");
    soundscapeInput.className = "mmd-style-input";
    soundscapeInput.style.minHeight = "60px";
    soundscapeInput.placeholder = "e.g. Quiet indoor room tone and a low ventilation hum continue throughout.";
    soundscapeInput.value = chunk.overall_soundscape || "";
    soundscapeInput.addEventListener("input", () => {
      chunk.overall_soundscape = soundscapeInput.value;
      this.commitChanges();
    });
    soundscapeBox.appendChild(soundscapeInput);
    soundRow.appendChild(soundscapeBox);

    const musicBox = document.createElement("div");
    musicBox.className = "mmd-box mmd-box-soundscape";
    const musicTitleRow = document.createElement("div");
    musicTitleRow.className = "mmd-chunk-style-title-row";
    const musicTitle = document.createElement("div");
    musicTitle.className = "mmd-box-title";
    musicTitle.textContent = "🎵 Non-Diegetic Music";
    musicTitleRow.appendChild(musicTitle);
    if (chunkIdx > 0) musicTitleRow.appendChild(this._copyFromPrevButton(chunkIdx, "non_diegetic_music"));
    musicBox.appendChild(musicTitleRow);
    const musicInput = document.createElement("textarea");
    musicInput.className = "mmd-style-input";
    musicInput.style.minHeight = "60px";
    musicInput.placeholder = "e.g. A restrained solo-piano score at a slow tempo. Leave blank or type N/A for no music.";
    musicInput.value = chunk.non_diegetic_music || "";
    musicInput.addEventListener("input", () => {
      chunk.non_diegetic_music = musicInput.value;
      this.commitChanges();
    });
    musicBox.appendChild(musicInput);
    soundRow.appendChild(musicBox);

    wrap.appendChild(soundRow);
    return wrap;
  }

  // Explicit, one-click copy of the previous chunk's value into this chunk —
  // deliberately not automatic. Saves retyping when the wording genuinely
  // hasn't changed, but you see it land in the field and can still edit it,
  // rather than it silently pre-filling and potentially going unnoticed.
  _copyFromPrevButton(chunkIdx, field) {
    const btn = document.createElement("button");
    btn.className = "mmd-analyze-btn mmd-copy-prev-btn";
    btn.type = "button";
    btn.title = "Copy from previous chunk";
    btn.textContent = "copy prev";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const prev = this.timeline.chunks[chunkIdx - 1];
      if (!prev) return;
      this.timeline.chunks[chunkIdx][field] = prev[field] || "";
      this.commitChanges();
      this.renderTimeline();
    });
    return btn;
  }

  // Multi-select, not single — a CUT is one shot, but a shot can have more than
  // one person talking in it (a whole 5s clip is often one continuous shot with
  // two or three characters in it, not one cut per line of dialogue). Whichever
  // Ref chips are ticked here each get their own (Sx) tag wherever their own
  // <Subject N> appears in this CUT's text, and each keeps their own paired
  // voice (Ref Audio N <-> Ref N by position) automatically.
  _effectiveChunkCharacters(chunkIdx) {
    if (!this.isHybridMode()) return this.timeline.characters || [];
    const chunk = this.timeline.chunks[chunkIdx];
    if (!chunk || chunk.generation_mode !== "Reference") return [];
    const local = chunk.localCharacters || [];
    return Array.from({ length: MAX_CHARACTER_SLOTS }, (_, i) => {
      const shared = this.timeline.characters?.[i];
      return shared && shared.shared && (shared.file || shared.image_b64) ? shared : local[i];
    });
  }

  _quotedDialogue(text) {
    return Array.from(String(text || "").matchAll(/"([^"]*)"/g)).map((m) => m[1].trim());
  }

  _speakerSlotsForChunk(chunkIdx) {
    const chunk = this.timeline.chunks[chunkIdx];
    const isFirstLast = this.isFirstLastMode() || (this.isHybridMode() && chunk?.generation_mode === "First/Last Frame");
    if (isFirstLast) return Array.from({ length: REF_AV_SLOTS }, (_, i) => i);
    const characters = this._effectiveChunkCharacters(chunkIdx);
    return Array.from({ length: MAX_CHARACTER_SLOTS }, (_, i) => i).filter((i) => characters[i] && (characters[i].file || characters[i].image_b64));
  }

  _syncDialogueSpeakers(seg) {
    const quotes = this._quotedDialogue(seg.prompt);
    const old = Array.isArray(seg.dialogueSpeakers) ? seg.dialogueSpeakers : [];
    const queues = new Map();
    old.forEach((entry) => { if (entry && typeof entry.text === "string") { if (!queues.has(entry.text)) queues.set(entry.text, []); queues.get(entry.text).push(entry.speakerCharIdx ?? null); } });
    const legacy = Array.isArray(seg.speakerCharIdxs) && seg.speakerCharIdxs.length === 1 ? seg.speakerCharIdxs[0] : (Number.isInteger(seg.speakerCharIdx) ? seg.speakerCharIdx : null);
    seg.dialogueSpeakers = quotes.map((quote, index) => {
      const queue = queues.get(quote);
      const preserved = queue?.length ? queue.shift() : old[index]?.speakerCharIdx;
      return { text: quote, speakerCharIdx: Number.isInteger(preserved) ? preserved : legacy };
    });
    return seg.dialogueSpeakers;
  }

  _buildDialogueSpeakerRows(chunkIdx, seg) {
    const wrap = document.createElement("div"); wrap.className = "mmd-dialogue-speakers";
    const assignments = this._syncDialogueSpeakers(seg); const slots = this._speakerSlotsForChunk(chunkIdx);
    assignments.forEach((assignment) => {
      const row = document.createElement("div"); row.className = "mmd-dialogue-speaker-row";
      const line = document.createElement("div"); line.className = "mmd-dialogue-line"; line.textContent = `“${assignment.text}”`; line.title = assignment.text; row.appendChild(line);
      const label = document.createElement("span"); label.className = "mmd-dialogue-speaker-label"; label.textContent = "Who's speaking:"; row.appendChild(label);
      slots.forEach((slotIdx) => {
        const chip = document.createElement("button"); chip.type = "button"; chip.className = "mmd-speaker-chip" + (assignment.speakerCharIdx === slotIdx ? " mmd-speaker-chip-active" : ""); chip.textContent = `Ref ${slotIdx + 1}`;
        chip.addEventListener("click", (e) => { e.stopPropagation(); assignment.speakerCharIdx = assignment.speakerCharIdx === slotIdx ? null : slotIdx; this.commitChanges(); this.renderTimeline(); }); row.appendChild(chip);
      });
      wrap.appendChild(row);
    });
    return wrap;
  }
  _buildCutBlock(chunkIdx, seg, i, totalWeight, chunkDurSeconds) {
    const chunk = this.timeline.chunks[chunkIdx];
    const color = CUT_COLORS[i % CUT_COLORS.length];
    const seconds = ((seg.weight || 1) / totalWeight) * chunkDurSeconds;
    seg.duration_hint = seconds.toFixed(1);

    const block = document.createElement("div");
    block.className = "mmd-cut-block";
    block.draggable = true;
    block.style.flex = `${seg.weight || 1} 0 0`;

    const bar = document.createElement("div");
    bar.className = "mmd-cut-bar";
    bar.style.background = color.bar;
    block.appendChild(bar);

    const head = document.createElement("div");
    head.className = "mmd-cut-head";
    const label = document.createElement("div");
    label.className = "mmd-cut-label";
    label.style.color = color.bar;
    label.append(`CUT ${i + 1} · `);
    const otherSegs = chunk.segments.filter((sg, idx) => idx !== i);
    if (!otherSegs.length) {
      // Only CUT in the chunk — nothing to trade duration with, so there's no
      // meaningful "type an exact value" action; show the plain read-only
      // figure instead of a box that can't actually do anything.
      label.append(`~${this._formatDuration(seconds)}`);
    } else {
      const durationInput = document.createElement("input");
      durationInput.type = "number";
      durationInput.className = "mmd-cut-duration-input";
      durationInput.step = "0.01";
      durationInput.min = String(MIN_CUT_SECONDS);
      durationInput.title = "Type this CUT's exact duration in seconds — the difference is redistributed " +
        "proportionally across every other CUT in this chunk, so the chunk's total length never changes.";
      durationInput.value = seconds.toFixed(2);
      durationInput.addEventListener("click", (e) => e.stopPropagation());
      durationInput.addEventListener("change", () => {
        const segA = chunk.segments[i];
        const others = chunk.segments.filter((sg, idx) => idx !== i);
        if (!segA || !others.length) return;
        const liveTotalWeight = chunk.segments.reduce((s, sg) => s + (sg.weight || 1), 0);
        const minWeight = (MIN_CUT_SECONDS / chunkDurSeconds) * liveTotalWeight;
        const othersTotalWeight = others.reduce((s, sg) => s + (sg.weight || 1), 0);
        // Worst case for how big segA can grow: every other CUT shrinks all the
        // way down to its own floor. Used to cap the typed value up front so the
        // proportional redistribution below never has to fight an impossible ask.
        const maxSegAWeight = liveTotalWeight - others.length * minWeight;
        const maxSegASeconds = (maxSegAWeight / liveTotalWeight) * chunkDurSeconds;

        let wanted = parseFloat(durationInput.value);
        if (!Number.isFinite(wanted)) wanted = seconds;
        wanted = Math.max(MIN_CUT_SECONDS, Math.min(Math.max(MIN_CUT_SECONDS, maxSegASeconds), wanted));

        const wantedWeight = (wanted / chunkDurSeconds) * liveTotalWeight;
        const deltaWeight = wantedWeight - (segA.weight || 1);
        // Positive delta: segA grew, so every other CUT gives up its own
        // proportional share of that. Negative delta (segA shrank): every
        // other CUT instead gains its share — this is what lets shrinking one
        // CUT hand its freed time to the whole rest of the chunk at once,
        // instead of only its one immediate neighbour.
        if (othersTotalWeight > 0) {
          for (const other of others) {
            const share = (other.weight || 1) / othersTotalWeight;
            other.weight = Math.max(minWeight, (other.weight || 1) - deltaWeight * share);
          }
        }
        segA.weight = wantedWeight;
        this.commitChanges();
        this.renderTimeline();
      });
      label.appendChild(durationInput);
      const unit = document.createElement("span");
      unit.className = "mmd-cut-duration-unit";
      unit.textContent = "s";
      label.appendChild(unit);
    }
    head.appendChild(label);

    const actions = document.createElement("div");
    actions.className = "mmd-cut-actions";
    const dragHandle = document.createElement("span");
    dragHandle.innerHTML = ICON_DRAG;
    actions.appendChild(dragHandle);
    if (chunk.segments.length > 1) {
      const del = document.createElement("span");
      del.className = "mmd-cut-del";
      del.innerHTML = ICON_TRASH;
      del.title = "Delete CUT";
      del.addEventListener("click", () => {
        chunk.segments.splice(i, 1);
        this.commitChanges();
        this.renderTimeline();
      });
      actions.appendChild(del);
    }
    head.appendChild(actions);
    block.appendChild(head);

    const text = document.createElement("textarea");
    text.className = "mmd-cut-text";
    text.placeholder = "What happens in this shot — action, dialogue, camera move...";
    text.value = seg.prompt || "";
    block.appendChild(text);

    // Speaker tagging only matters in Reference mode (it drives the (Sx) tag next
    // to that character's <Subject N> mentions) and only once this CUT actually
    // has quoted dialogue to attribute — appears/disappears live as you type
    // rather than needing a full re-render, so it never steals textarea focus.
    let speakerRows = this._buildDialogueSpeakerRows(chunkIdx, seg);
    block.appendChild(speakerRows);
    text.addEventListener("input", () => {
      seg.prompt = text.value;
      // Editing real content in a chunk that just resurfaced from being hidden
      // is exactly the "conscious review" the stale banner exists to prompt —
      // clear it here too, not just via the explicit Reviewed button.
      if (chunk.stale) chunk.stale = false;
      this.commitChanges();
      const replacement = this._buildDialogueSpeakerRows(chunkIdx, seg);
      speakerRows.replaceWith(replacement);
      speakerRows = replacement;
      this.commitChanges();
    });

    // Resize handle (adjusts this block's weight vs. its right neighbor's)
    if (i < chunk.segments.length - 1) {
      const handle = document.createElement("div");
      handle.className = "mmd-cut-resize";
      handle.addEventListener("mousedown", (e) => this._startResize(e, chunkIdx, i));
      block.appendChild(handle);
    }

    // Drag-to-reorder (whole block)
    block.addEventListener("dragstart", (e) => {
      block.classList.add("mmd-dragging");
      e.dataTransfer.setData("text/plain", String(i));
      e.dataTransfer.effectAllowed = "move";
    });
    block.addEventListener("dragend", () => block.classList.remove("mmd-dragging"));
    block.addEventListener("dragover", (e) => { e.preventDefault(); block.classList.add("mmd-drag-over"); });
    block.addEventListener("dragleave", () => block.classList.remove("mmd-drag-over"));
    block.addEventListener("drop", (e) => {
      e.preventDefault();
      block.classList.remove("mmd-drag-over");
      const fromIdx = parseInt(e.dataTransfer.getData("text/plain"), 10);
      if (Number.isNaN(fromIdx) || fromIdx === i) return;
      const [moved] = chunk.segments.splice(fromIdx, 1);
      chunk.segments.splice(i, 0, moved);
      this.commitChanges();
      this.renderTimeline();
    });

    return block;
  }

  _startResize(e, chunkIdx, i) {
    e.preventDefault();
    e.stopPropagation();
    const chunk = this.timeline.chunks[chunkIdx];
    const trackRect = this.tracks[chunkIdx].getBoundingClientRect();
    const segA = chunk.segments[i];
    const segB = chunk.segments[i + 1];
    const totalWeight = chunk.segments.reduce((s, seg) => s + (seg.weight || 1), 0);
    const pairWeight = (segA.weight || 1) + (segB.weight || 1);
    const startX = e.clientX;
    const startAWeight = segA.weight || 1;

    const onMove = (ev) => {
      const deltaPx = ev.clientX - startX;
      const deltaWeight = (deltaPx / trackRect.width) * totalWeight;
      let newA = startAWeight + deltaWeight;
      newA = Math.max(0.15, Math.min(pairWeight - 0.15, newA));
      segA.weight = newA;
      segB.weight = pairWeight - newA;
      this.renderTimeline();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      this.commitChanges();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // ── Character / First-Last-Frame / Location reference slots ────────────────
  // Three columns: 1) First Frame / Last Frame (FFLF + Hybrid modes only —
  // independent storage, no longer borrows Ref 1/Ref 2), 2) Ref 1..N character
  // images (Reference + Hybrid modes), 3) Location — one primary slot plus up
  // to 6 more, each swapped in for a specific chunk onward (see
  // _resolve_location_for_chunk on the Python side). Columns 2/3 are hidden in
  // plain First/Last Frame mode the same way reference video/audio already is —
  // neither is used by that mode's own MiniMaxH3ImageToVideo call.
  _buildHybridChunkInputs(chunkIdx, chunk) {
    const panel = document.createElement("div"); panel.className = "mmd-chunk-inputs";
    const title = document.createElement("div"); title.className = "mmd-chunk-inputs-title"; title.textContent = "REFERENCES FOR THIS CHUNK"; panel.appendChild(title);
    const section = (name, cards, cls = "") => { const wrap = document.createElement("div"); wrap.className = `mmd-chunk-asset-section ${cls}`; const h = document.createElement("div"); h.className = "mmd-ref-section-title"; h.textContent = name; wrap.appendChild(h); const grid = document.createElement("div"); grid.className = "mmd-chunk-asset-grid"; cards.forEach((card) => grid.appendChild(card)); wrap.appendChild(grid); panel.appendChild(wrap); };
    const guides = Array.from({length: 4}, (_, i) => this._buildChunkImageAssetSlot(chunkIdx, "localGuides", i, `Guide ${i + 1}`, "mmd-guide-slot", true));
    if ((chunk.generation_mode || "Reference") === "First/Last Frame") {
      section("FRAME ANCHORS & TIMED GUIDES", [this._buildChunkFrameSlot(chunkIdx, "first"), this._buildChunkFrameSlot(chunkIdx, "last"), ...guides], "mmd-chunk-frame-line");
    } else {
      const images = Array.from({length: MAX_CHARACTER_SLOTS}, (_, i) => this._buildChunkImageAssetSlot(chunkIdx, "localCharacters", i, `Ref ${i + 1}`));
      images.push(this._buildChunkImageAssetSlot(chunkIdx, "localLocations", 0, "Location", "mmd-bg-slot"), ...guides);
      section("IMAGE REFERENCES, LOCATION & TIMED GUIDES", images, "mmd-chunk-image-line");
      const media = [
        ...Array.from({length: REF_AV_SLOTS}, (_, i) => this._buildChunkAvSlot(chunkIdx, "audio", i)),
        ...Array.from({length: REF_AV_SLOTS}, (_, i) => this._buildChunkAvSlot(chunkIdx, "video", i)),
      ];
      section("REFERENCE AUDIO & VIDEO", media, "mmd-chunk-media-line");
    }
    return panel;
  }
  _buildChunkImageAssetSlot(chunkIdx, listKey, idx, labelText, extraClass = "", isGuide = false) {
    const chunk = this.timeline.chunks[chunkIdx]; const list = chunk[listKey] || (chunk[listKey] = []); while (list.length <= idx) list.push(null); const data = list[idx]; const filled = data && (data.file || data.image_b64);
    const sharedData = listKey === "localCharacters" ? this.timeline.characters?.[idx] : null; const sharedLocked = !!(sharedData && sharedData.shared && (sharedData.file || sharedData.image_b64));
    const slot = document.createElement("div"); slot.className = `mmd-char-slot mmd-chunk-asset-card ${extraClass}${filled ? " mmd-filled" : ""}`; const label = document.createElement("div"); label.className = "mmd-char-label"; label.textContent = labelText; slot.appendChild(label);
    if (sharedLocked) { slot.classList.add("mmd-char-slot-disabled", "mmd-shared-slot-locked"); const preview = document.createElement("div"); preview.className = "mmd-char-preview"; const img = document.createElement("img"); img.src = sharedData.file ? comfyViewUrl(sharedData.file) : (sharedData._blobUrl || sharedData.image_b64); preview.appendChild(img); slot.appendChild(preview); const note = document.createElement("div"); note.className = "mmd-shared-lock-note"; note.textContent = `Shared ${labelText} active`; slot.appendChild(note); return slot; }
    if (filled) {
      const del = document.createElement("button"); del.className = "mmd-char-del"; del.innerHTML = "&times;"; del.addEventListener("click", (e) => { e.stopPropagation(); list[idx] = null; this.commitChanges(); this.renderTimeline(); }); slot.appendChild(del);
      const preview = document.createElement("div"); preview.className = "mmd-char-preview"; const img = document.createElement("img"); img.src = data.file ? comfyViewUrl(data.file) : (data._blobUrl || data.image_b64); preview.appendChild(img); slot.appendChild(preview);
      const analyze = document.createElement("button"); analyze.className = "mmd-analyze-btn"; analyze.textContent = data.description ? "Re-Analyze" : "Analyze"; const desc = document.createElement("textarea"); desc.className = "mmd-desc-input"; desc.placeholder = isGuide ? "Describe what must happen at this guide..." : "description..."; desc.value = data.description || ""; analyze.addEventListener("click", async (e) => { e.stopPropagation(); await this.runAnalysis(data, 1000 + chunkIdx * 100 + idx, analyze, desc); }); slot.append(analyze, desc); desc.addEventListener("click", (e) => e.stopPropagation()); desc.addEventListener("input", () => { data.description = desc.value; this.commitChanges(); });
      if (!isGuide) { slot.appendChild(this._miniSelectRow("Fit", data.fit || "original", REFERENCE_FIT_OPTIONS, (v) => { data.fit = v; })); slot.appendChild(this._miniSelectRow("Retention", data.retention || "fully_preserved", VISUAL_RETENTION_OPTIONS, (v) => { data.retention = v; })); }
    } else { const ph = document.createElement("div"); ph.className = "mmd-char-placeholder"; ph.innerHTML = `${ICON_UPLOAD}<br>Drop image`; slot.appendChild(ph); slot.addEventListener("click", () => this._promptChunkAssetFilePick(chunkIdx, listKey, idx, isGuide)); }
    if (isGuide) { const row = document.createElement("div"); row.className = "mmd-loc-chunk-row"; const lab = document.createElement("span"); lab.textContent = "Time (s)"; const input = document.createElement("input"); input.type = "number"; input.min = "0.1"; input.step = "0.1"; input.className = "mmd-loc-chunk-input"; input.value = data?.time ?? 5; input.addEventListener("click", (e) => e.stopPropagation()); input.addEventListener("change", () => { const target = list[idx] || (list[idx] = {time: 5}); target.time = Math.max(.1, parseFloat(input.value) || .1); this.commitChanges(); }); row.append(lab, input); slot.appendChild(row); }
    slot.addEventListener("dragover", (e) => e.preventDefault()); slot.addEventListener("drop", async (e) => { e.preventDefault(); e.stopPropagation(); const file = e.dataTransfer.files?.[0]; if (file) await this._setChunkAssetImage(chunkIdx, listKey, idx, file, isGuide); }); return slot;
  }

  _promptChunkAssetFilePick(chunkIdx, listKey, idx, isGuide) { const input = document.createElement("input"); input.type = "file"; input.accept = "image/*"; input.onchange = async () => { if (input.files?.[0]) await this._setChunkAssetImage(chunkIdx, listKey, idx, input.files[0], isGuide); }; input.click(); }
  async _setChunkAssetImage(chunkIdx, listKey, idx, file, isGuide) { try { const uploaded = await uploadRefFile(file); const list = this.timeline.chunks[chunkIdx][listKey] || (this.timeline.chunks[chunkIdx][listKey] = []); const old = list[idx] || {}; list[idx] = {...old, ...uploaded, description: old.description || "", fit: old.fit || "original", retention: old.retention || "fully_preserved", time: isGuide ? (old.time ?? 5) : undefined, _blobUrl: URL.createObjectURL(file)}; this.commitChanges(); this.renderTimeline(); } catch (err) { console.error(err); alert("Image upload failed — see console."); } }

  _buildChunkAvSlot(chunkIdx, kind, idx) {
    const chunk = this.timeline.chunks[chunkIdx]; const key = kind === "video" ? "localRefVideos" : "localRefAudios"; const list = chunk[key] || (chunk[key] = Array(REF_AV_SLOTS).fill(null)); const entry = list[idx]; const video = kind === "video"; const sharedEntry = (video ? this.timeline.refVideos : this.timeline.refAudios)?.[idx]; const sharedLocked = !!(sharedEntry && sharedEntry.shared && sharedEntry.file); const slot = document.createElement("div"); slot.className = `mmd-av-slot mmd-chunk-av-card ${video ? "mmd-av-slot-video" : "mmd-av-slot-audio"}${entry ? " mmd-filled" : ""}`; const head = document.createElement("div"); head.className = "mmd-av-slot-head"; const label = document.createElement("div"); label.className = "mmd-av-slot-label"; label.textContent = `${video ? "Ref Video" : "Ref Audio"} ${idx + 1}`; head.appendChild(label); if (entry) { const del = document.createElement("button"); del.className = "mmd-av-slot-del"; del.innerHTML = "&times;"; del.onclick = () => { list[idx] = null; this.commitChanges(); this.renderTimeline(); }; head.appendChild(del); } slot.appendChild(head);
    if (sharedLocked) { slot.classList.add("mmd-char-slot-disabled", "mmd-shared-slot-locked"); const note = document.createElement("div"); note.className = "mmd-av-placeholder mmd-shared-lock-note"; note.textContent = `Shared ${video ? "Video" : "Audio"} ${idx + 1} active`; slot.appendChild(note); return slot; }
    if (entry) slot.appendChild(this._buildAvMedia(kind, idx, entry, this._effectiveChunkCharacters(chunkIdx))); else { const ph = document.createElement("div"); ph.className = "mmd-av-placeholder"; ph.innerHTML = `${ICON_UPLOAD}<span>Drop or click to upload ${kind}</span>`; ph.onclick = () => this._promptChunkAvFilePick(chunkIdx, kind, idx); slot.appendChild(ph); } slot.addEventListener("dragover", (e) => e.preventDefault()); slot.addEventListener("drop", async (e) => { e.preventDefault(); const file = e.dataTransfer.files?.[0]; if (file) await this._setChunkAvSlot(chunkIdx, kind, idx, file); }); return slot;
  }
  _promptChunkAvFilePick(chunkIdx, kind, idx) { const input = document.createElement("input"); input.type = "file"; input.accept = kind === "video" ? "video/*" : "audio/*"; input.onchange = async () => { if (input.files?.[0]) await this._setChunkAvSlot(chunkIdx, kind, idx, input.files[0]); }; input.click(); }
  async _setChunkAvSlot(chunkIdx, kind, idx, file) { try { const uploaded = await uploadRefFile(file); const entry = {...uploaded, trimStartSec: 0, trimEndSec: null, sourceDurationSec: null, includeAudio: false, _blobUrl: URL.createObjectURL(file)}; if (kind === "audio") { try { const a = await extractAudioPeaks(file); entry.waveformPeaks = a.peaks; entry.sourceDurationSec = a.duration; entry.trimEndSec = a.duration; } catch {} } const key = kind === "video" ? "localRefVideos" : "localRefAudios"; this.timeline.chunks[chunkIdx][key][idx] = entry; this.commitChanges(); this.renderTimeline(); } catch (err) { console.error(err); alert("Upload failed — see console."); } }
  _buildChunkFrameSlot(chunkIdx, which) {
    const chunk = this.timeline.chunks[chunkIdx]; const key = which === "first" ? "firstFrameImage" : "lastFrameImage"; const data = chunk[key] || (chunk[key] = {});
    const filled = data && (data.file || data.image_b64); const slot = document.createElement("div"); slot.className = "mmd-char-slot mmd-fl-slot" + (filled ? " mmd-filled" : "");
    const label = document.createElement("div"); label.className = "mmd-char-label"; label.textContent = which === "first" ? "First Frame" : "Last Frame"; slot.appendChild(label);
    if (filled) {
      const del = document.createElement("button"); del.className = "mmd-char-del"; del.innerHTML = "&times;"; del.addEventListener("click", (e) => { e.stopPropagation(); chunk[key] = {}; this.commitChanges(); this.renderTimeline(); }); slot.appendChild(del);
      const preview = document.createElement("div"); preview.className = "mmd-char-preview"; const img = document.createElement("img"); img.src = data.file ? comfyViewUrl(data.file) : (data._blobUrl || data.image_b64); preview.appendChild(img); slot.appendChild(preview);
    } else {
      const placeholder = document.createElement("div"); placeholder.className = "mmd-char-placeholder"; placeholder.innerHTML = ICON_UPLOAD + "<br>Drop image"; slot.appendChild(placeholder); slot.addEventListener("click", () => this._promptChunkFrameFilePick(chunkIdx, key));
    }
    slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.style.borderColor = "#4F8EF7"; }); slot.addEventListener("dragleave", () => { slot.style.borderColor = ""; });
    slot.addEventListener("drop", async (e) => { e.preventDefault(); slot.style.borderColor = ""; const file = e.dataTransfer.files?.[0]; if (file) await this._setChunkFrameImage(chunkIdx, key, file); }); return slot;
  }

  _promptChunkFrameFilePick(chunkIdx, key) {
    const input = document.createElement("input"); input.type = "file"; input.accept = "image/*"; input.onchange = async () => { if (input.files?.[0]) await this._setChunkFrameImage(chunkIdx, key, input.files[0]); }; input.click();
  }

  async _setChunkFrameImage(chunkIdx, key, file) {
    try { const uploaded = await uploadRefFile(file); this.timeline.chunks[chunkIdx][key] = { ...uploaded, _blobUrl: URL.createObjectURL(file) }; this.commitChanges(); this.renderTimeline(); }
    catch (err) { console.error("[MuseMinimaxDirector] Chunk frame upload failed", err); alert("Couldn't upload " + file.name + ": " + (err.message || err)); }
  }
  renderReferences() {
    // Defensive/idempotent — Prompt Gen's per-chunk sections below need
    // timeline.chunks correctly sized before they render, regardless of
    // whether renderTimeline() (which also calls this) already ran this tick.
    this._syncChunkCount();
    this.refsArea.innerHTML = "";
    this.refsTitle.style.display = "flex";

    const isFL = this.isFirstLastMode();
    const isHybrid = this.isHybridMode();
    const refsHeading = this.refsTitle.querySelector("span");
    if (refsHeading) refsHeading.textContent = isHybrid ? "📷 Shared Asset Library" : "📷 References";
    const showFrameCol = isFL || isHybrid;
    const showRefCols = !isFL; // Reference (Omni) or Hybrid

    const appendSection = (titleText, cards, addButton = null, hintText = "", parent = this.refsArea) => {
      const section = document.createElement("div");
      section.className = "mmd-ref-section";
      if (titleText === "LOCATIONS") section.classList.add("mmd-location-section");
      const title = document.createElement("div");
      title.className = "mmd-ref-section-title";
      title.textContent = titleText;
      section.appendChild(title);
      const sectionGrid = document.createElement("div");
      sectionGrid.className = "mmd-ref-grid";
      for (const card of cards) sectionGrid.appendChild(card);
      section.appendChild(sectionGrid);
      if (addButton) { addButton.classList.add("mmd-section-add"); section.appendChild(addButton); }
      if (hintText) {
        const hint = document.createElement("div");
        hint.className = "mmd-fl-note";
        hint.style.marginTop = "8px";
        hint.textContent = hintText;
        section.appendChild(hint);
      }
      parent.appendChild(section);
    };

    const hybridAuxGrid = isHybrid ? document.createElement("div") : null;
    if (hybridAuxGrid) hybridAuxGrid.className = "mmd-hybrid-aux-grid";

    if (showFrameCol && !isHybrid) {
      appendSection(
        "TIMELINE FRAME ANCHORS",
        [this._buildFrameSlot("first"), this._buildFrameSlot("last")],
        null,
        isHybrid
          ? "First and Last Frame control the endpoints. They are separate from the purple reference-image pool."
          : "Leave either frame empty to skip it. Other reference types do not apply in First/Last Frame mode."
      );
    }

    if (showRefCols) {
      const refCards = [];
      for (let i = 0; i < MAX_CHARACTER_SLOTS; i++) refCards.push(this._buildCharSlot(i));
      appendSection(
        "SUBJECT / OBJECT REFERENCES",
        refCards,
        null,
        "MiniMax permits nine image references in total. Ref images, active Location and Hybrid Guide images share that pool."
      );

      if (!Array.isArray(this.timeline.locations) || this.timeline.locations.length === 0) {
        this.timeline.locations = [{ chunk: 1 }];
      }
      const locationCards = this.timeline.locations.map((_, i) => this._buildLocationSlot(i));
      let addLocation = null;
      if (this.timeline.locations.length < MAX_LOCATION_SLOTS) {
        addLocation = document.createElement("div");
        addLocation.className = "mmd-add-location-btn";
        addLocation.textContent = `+ Add Location (${this.timeline.locations.length}/${MAX_LOCATION_SLOTS} used)`;
        addLocation.addEventListener("click", () => {
          this.timeline.locations.push({ chunk: this.timeline.locations.length + 1 });
          this.commitChanges(); this.renderReferences();
        });
      }
      appendSection(
        "LOCATIONS",
        locationCards,
        addLocation,
        isHybrid ? "Tick Use in all applicable chunks on any occupied Location you want globally available. A Location uploaded inside a chunk overrides the shared Location for that chunk only." : "Location 1 applies to every chunk by default. Additional Location cards take over from their selected chunk onward.",
        isHybrid ? hybridAuxGrid : this.refsArea
      );
    }

    if (isHybrid && false) {
      if (!Array.isArray(this.timeline.guideImages)) this.timeline.guideImages = [];
      if (this.timeline.guideImages.length === 0) this.timeline.guideImages.push({ chunk: 1, time: 5.0, description: "" });
      const guideCards = this.timeline.guideImages.map((_, i) => this._buildGuideSlot(i));
      let addGuide = null;
      if (this.timeline.guideImages.length < MAX_GUIDE_SLOTS) {
        addGuide = document.createElement("div");
        addGuide.className = "mmd-add-location-btn";
        addGuide.textContent = `+ Add Guide Image (${this.timeline.guideImages.length}/${MAX_GUIDE_SLOTS} slots)`;
        addGuide.addEventListener("click", () => {
          this.timeline.guideImages.push({ chunk: 1, time: 5.0, description: "" });
          this.commitChanges(); this.renderReferences();
        });
      }
      appendSection(
        "HYBRID TIMED GUIDES",
        guideCards,
        addGuide,
        "Choose a chunk and visible time. V1.4 converts it to the native frame, names that frame in the prompt and supplies the same image as a reference. Empty guide cards are ignored.",
        hybridAuxGrid
      );
    }

    if (hybridAuxGrid) this.refsArea.appendChild(hybridAuxGrid);

    if (isFL) return; // no reference video/audio in First/Last Frame mode

    const avHint = document.createElement("div");
    avHint.className = "mmd-track-hint";
    avHint.style.marginTop = "10px";
    avHint.textContent = "Reference video / audio — upload a clip, skim it with the scrub bar, then Set In / Set Out to pick the exact window that gets sent as a reference. Video slot 1 is reserved internally for chunk-to-chunk continuity once a chunk has a predecessor. A video's own audio is off by default (motion only) — tick \"Include this clip's audio\" to also send it as a paired reference (e.g. for reperforming its dialogue in a different voice). Leave a video's \"Subject description\" blank for a pure motion/camera reference, or fill it in if the video shows a person/element you want reused. Ref Audio N automatically becomes Ref N's voice (Ref Audio 1 = Ref 1's voice, Ref Audio 2 = Ref 2's, etc.) — no need to describe whose voice it is, and no need to mention it in your CUT text. Just tick which characters are speaking on each CUT below and their paired voice is used automatically.";
    this.refsArea.appendChild(avHint);

    const videoRow = document.createElement("div");
    videoRow.className = "mmd-av-row";
    for (let i = 0; i < REF_AV_SLOTS; i++) videoRow.appendChild(this._buildRefAvSlot("video", i));
    this.refsArea.appendChild(videoRow);

    const audioRow = document.createElement("div");
    audioRow.className = "mmd-av-row";
    for (let i = 0; i < REF_AV_SLOTS; i++) audioRow.appendChild(this._buildRefAvSlot("audio", i));
    this.refsArea.appendChild(audioRow);

    // One Prompt Gen section per chunk — mirrors the CUT track's own per-chunk
    // sections below, same numbering, same visibility rule (only chunks the
    // current Total Duration / Chunk Size math actually implies are shown).
    // Hidden for now (SHOW_PROMPT_GEN) — every chunk's prompt_gen_enabled just
    // stays at its existing/default false either way, so hiding this doesn't
    // change what execute() does; it only removes the UI for turning it on.
    if (SHOW_PROMPT_GEN) {
      const numChunksForPromptGen = this._numChunks();
      for (let c = 0; c < numChunksForPromptGen; c++) {
        this.refsArea.appendChild(this._buildPromptGenSection(c));
      }
    }
  }

  // First/Last Frame — independent storage shared by First/Last Frame mode AND
  // Hybrid mode (both dispatch to a node with its own dedicated first_frame/
  // last_frame inputs, completely separate from ref_images on the H3 side —
  // see muse_minimax_director.py's own comment on this). Equal-size rectangular
  // boxes (.mmd-fl-slot), not the old thin Ref-1/Ref-2-shaped slits.
  _buildFrameSlot(which) {
    const key = which === "first" ? "firstFrameImage" : "lastFrameImage";
    const data = this.timeline[key] || (this.timeline[key] = {});
    const filled = data && (data.file || data.image_b64);
    const slot = document.createElement("div");
    slot.className = "mmd-char-slot mmd-fl-slot" + (filled ? " mmd-filled" : "");
    const label = document.createElement("div");
    label.className = "mmd-char-label";
    label.textContent = which === "first" ? "First Frame" : "Last Frame";
    slot.appendChild(label);
    if (filled) {
      const del = document.createElement("button");
      del.className = "mmd-char-del";
      del.innerHTML = "&times;";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.timeline[key] = {};
        this.commitChanges();
        this.renderReferences();
      });
      slot.appendChild(del);
      const preview = document.createElement("div");
      preview.className = "mmd-char-preview";
      const img = document.createElement("img");
      img.src = data.file ? comfyViewUrl(data.file) : (data._blobUrl || data.image_b64);
      preview.appendChild(img);
      slot.appendChild(preview);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "mmd-char-placeholder";
      placeholder.innerHTML = `${ICON_UPLOAD}<br>Drop image`;
      slot.appendChild(placeholder);
      slot.addEventListener("click", () => this._promptFrameFilePick(key));
    }
    slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.style.borderColor = "#4F8EF7"; });
    slot.addEventListener("dragleave", () => { slot.style.borderColor = ""; });
    slot.addEventListener("drop", async (e) => {
      e.preventDefault();
      slot.style.borderColor = "";
      const file = e.dataTransfer.files?.[0];
      if (file) await this._setFrameImage(key, file);
    });
    return slot;
  }

  _promptFrameFilePick(key) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      if (input.files?.[0]) await this._setFrameImage(key, input.files[0]);
    };
    input.click();
  }

  async _setFrameImage(key, file) {
    try {
      const uploaded = await uploadRefFile(file);
      this.timeline[key] = { ...uploaded, _blobUrl: URL.createObjectURL(file) };
      this.commitChanges();
      this.renderReferences();
      this.renderTimeline();
    } catch (err) {
      console.error("[MuseMinimaxDirector] First/Last Frame upload failed", err);
      alert(`Couldn't upload ${file.name}: ${err.message || err}`);
    }
  }

  // Location — index 0 is the always-present primary slot (implicitly chunk 1,
  // no visible chunk switch — matches every other reference default). Slots
  // 1+ are addable/removable, each with its own "from chunk #" switch; at
  // render time the chunk matching (or most recently before) the current
  // chunk wins, carrying forward until a later Location takes over (see
  // _resolve_location_for_chunk on the Python side).
  _buildLocationSlot(idx) {
    const loc = this.timeline.locations[idx] || (this.timeline.locations[idx] = { chunk: idx + 1 });
    const isPrimary = idx === 0;
    const filled = loc && (loc.file || loc.image_b64);

    const slot = document.createElement("div");
    slot.className = "mmd-char-slot mmd-bg-slot" + (filled ? " mmd-filled" : "") + (isPrimary ? "" : " mmd-loc-extra-slot");

    const label = document.createElement("div");
    label.className = "mmd-char-label";
    label.textContent = isPrimary ? "Location" : `Location ${idx + 1}`;
    slot.appendChild(label);

    if (!isPrimary) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "mmd-char-del";
      removeBtn.innerHTML = "&times;";
      removeBtn.title = "Remove this Location slot";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.timeline.locations.splice(idx, 1);
        this.commitChanges();
        this.renderReferences();
      });
      slot.appendChild(removeBtn);
    }

    if (filled) {
      if (isPrimary) {
        const clr = document.createElement("button");
        clr.className = "mmd-char-del";
        clr.innerHTML = "&times;";
        clr.addEventListener("click", (e) => {
          e.stopPropagation();
          this.timeline.locations[idx] = { chunk: 1 };
          this.commitChanges();
          this.renderReferences();
        });
        slot.appendChild(clr);
      }
      const preview = document.createElement("div");
      preview.className = "mmd-char-preview";
      const img = document.createElement("img");
      img.src = loc.file ? comfyViewUrl(loc.file) : (loc._blobUrl || loc.image_b64);
      preview.appendChild(img);
      slot.appendChild(preview);

      const analyzeBtn = document.createElement("button");
      analyzeBtn.className = "mmd-analyze-btn";
      analyzeBtn.textContent = loc.description ? "Re-Analyze" : "Analyze";
      analyzeBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.runAnalysis(loc, MAX_CHARACTER_SLOTS + idx, analyzeBtn, descInput);
      });
      slot.appendChild(analyzeBtn);

      var descInput = document.createElement("textarea");
      descInput.className = "mmd-desc-input";
      descInput.placeholder = "description...";
      descInput.value = loc.description || "";
      descInput.addEventListener("click", (e) => e.stopPropagation());
      descInput.addEventListener("input", () => { loc.description = descInput.value; this.commitChanges(); });
      slot.appendChild(descInput);

      slot.appendChild(this._miniSelectRow(
        "Fit", loc.fit || "original", REFERENCE_FIT_OPTIONS,
        (v) => { loc.fit = v; },
      ));

      if (this.isReferenceMode() || this.isHybridMode()) {
        slot.appendChild(this._miniSelectRow(
          "Retention", loc.retention || "fully_preserved", VISUAL_RETENTION_OPTIONS,
          (v) => { loc.retention = v; },
        ));
      }
      if (this.isHybridMode()) slot.appendChild(this._buildSharedAssetToggle(loc));
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "mmd-char-placeholder";
      placeholder.innerHTML = `${ICON_UPLOAD}<br>Drop image`;
      slot.appendChild(placeholder);
      slot.addEventListener("click", () => this._promptLocationFilePick(idx));
    }

    if (!isPrimary) {
      const chunkRow = document.createElement("div");
      chunkRow.className = "mmd-loc-chunk-row";
      const chunkLabel = document.createElement("span");
      chunkLabel.textContent = "From chunk #";
      const chunkInput = document.createElement("input");
      chunkInput.type = "number";
      chunkInput.min = "1";
      chunkInput.className = "mmd-loc-chunk-input";
      chunkInput.value = loc.chunk || (idx + 1);
      chunkInput.addEventListener("click", (e) => e.stopPropagation());
      chunkInput.addEventListener("change", () => {
        loc.chunk = Math.max(1, parseInt(chunkInput.value, 10) || (idx + 1));
        this.commitChanges();
      });
      chunkRow.appendChild(chunkLabel);
      chunkRow.appendChild(chunkInput);
      slot.appendChild(chunkRow);
    }

    slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.style.borderColor = "#4F8EF7"; });
    slot.addEventListener("dragleave", () => { slot.style.borderColor = ""; });
    slot.addEventListener("drop", async (e) => {
      e.preventDefault();
      slot.style.borderColor = "";
      const file = e.dataTransfer.files?.[0];
      if (file) await this._setLocationImage(idx, file);
    });

    return slot;
  }

  _buildGuideSlot(idx) {
    const guide = this.timeline.guideImages[idx];
    const filled = guide && (guide.file || guide.image_b64);
    const slot = document.createElement("div");
    slot.className = "mmd-char-slot mmd-guide-slot" + (filled ? " mmd-filled" : "");
    const label = document.createElement("div");
    label.className = "mmd-char-label";
    label.textContent = `Guide ${idx + 1}`;
    slot.appendChild(label);
    const del = document.createElement("button");
    del.className = "mmd-char-del";
    del.innerHTML = "&times;";
    del.title = "Remove this guide";
    del.addEventListener("click", (e) => { e.stopPropagation(); this.timeline.guideImages.splice(idx, 1); this.commitChanges(); this.renderReferences(); this.renderTimeline(); });
    slot.appendChild(del);
    if (filled) {
      const preview = document.createElement("div");
      preview.className = "mmd-char-preview";
      const img = document.createElement("img");
      img.src = guide.file ? comfyViewUrl(guide.file) : (guide._blobUrl || guide.image_b64);
      preview.appendChild(img);
      preview.addEventListener("click", (e) => { e.stopPropagation(); this._promptGuideFilePick(idx); });
      slot.appendChild(preview);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "mmd-char-placeholder";
      placeholder.innerHTML = `${ICON_UPLOAD}<br>Drop image`;
      placeholder.addEventListener("click", (e) => { e.stopPropagation(); this._promptGuideFilePick(idx); });
      slot.appendChild(placeholder);
    }
    const row = document.createElement("div");
    row.className = "mmd-loc-chunk-row";
    const chunkLabel = document.createElement("span"); chunkLabel.textContent = "Chunk";
    const chunkInput = document.createElement("input"); chunkInput.type = "number"; chunkInput.min = "1"; chunkInput.max = String(this.timeline.chunks.length || 1); chunkInput.className = "mmd-loc-chunk-input"; chunkInput.value = guide.chunk || 1;
    const timeLabel = document.createElement("span"); timeLabel.textContent = "Time (s)";
    const timeInput = document.createElement("input"); timeInput.type = "number"; timeInput.min = "0.1"; timeInput.step = "0.1"; timeInput.className = "mmd-loc-chunk-input"; timeInput.value = guide.time ?? 5.0;
    for (const el of [chunkInput, timeInput]) el.addEventListener("click", (e) => e.stopPropagation());
    chunkInput.addEventListener("change", () => { guide.chunk = Math.max(1, Math.min(this.timeline.chunks.length || 1, parseInt(chunkInput.value, 10) || 1)); this.commitChanges(); });
    timeInput.addEventListener("change", () => { guide.time = Math.max(0.1, parseFloat(timeInput.value) || 0.1); this.commitChanges(); });
    row.append(chunkLabel, chunkInput, timeLabel, timeInput); slot.appendChild(row);
    const desc = document.createElement("textarea");
    desc.className = "mmd-desc-input"; desc.placeholder = "Describe exactly what should happen at this guide frame..."; desc.value = guide.description || "";
    desc.addEventListener("click", (e) => e.stopPropagation()); desc.addEventListener("input", () => { guide.description = desc.value; this.commitChanges(); }); slot.appendChild(desc);
    slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.style.borderColor = "#4F8EF7"; });
    slot.addEventListener("dragleave", () => { slot.style.borderColor = ""; });
    slot.addEventListener("drop", async (e) => { e.preventDefault(); slot.style.borderColor = ""; const file = e.dataTransfer.files?.[0]; if (file) await this._setGuideImage(idx, file); });
    return slot;
  }

  _promptGuideFilePick(idx) {
    const input = document.createElement("input"); input.type = "file"; input.accept = "image/*";
    input.onchange = async () => { if (input.files?.[0]) await this._setGuideImage(idx, input.files[0]); };
    input.click();
  }

  async _setGuideImage(idx, file) {
    try {
      const uploaded = await uploadRefFile(file);
      const existing = this.timeline.guideImages[idx] || { chunk: 1, time: 5.0 };
      this.timeline.guideImages[idx] = { ...existing, ...uploaded, _blobUrl: URL.createObjectURL(file) };
      this.commitChanges(); this.renderReferences(); this.renderTimeline();
    } catch (err) {
      console.error("[MuseMinimaxDirectorV1.4] Guide image upload failed", err);
      alert("Guide image upload failed — see console for details.");
    }
  }
  _promptLocationFilePick(idx) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      if (input.files?.[0]) await this._setLocationImage(idx, input.files[0]);
    };
    input.click();
  }

  async _setLocationImage(idx, file) {
    try {
      const uploaded = await uploadRefFile(file);
      const existing = this.timeline.locations[idx] || {};
      this.timeline.locations[idx] = {
        ...uploaded, description: existing.description || "", retention: existing.retention,
        fit: existing.fit || "original", shared: existing.shared || false,
        chunk: existing.chunk || (idx + 1), _blobUrl: URL.createObjectURL(file),
      };
      this.commitChanges();
      this.renderReferences();
      this.renderTimeline();
    } catch (err) {
      console.error("[MuseMinimaxDirector] Location image upload failed", err);
      alert("Image upload failed — see console for details.");
    }
  }

  // Continuation context for chunk N+1's Prompt Gen call. Prefers the previous
  // chunk's own committed Prompt Gen text when it has one (already a full
  // six-section prompt, including whatever style/soundscape/music it used) —
  // but falls back to a plain-text summary built from that chunk's own CUTs
  // plus its style_line/overall_soundscape/non_diegetic_music fields when it
  // used the plain compiler instead. Without this fallback, a chunk following
  // a plain-compiler chunk had zero context to continue from and Prompt Gen
  // was outright blocked for it — there's no reason switching from manual CUTs
  // to Prompt Gen partway through a video should lose continuity.
  _prevChunkContextText(chunkIdx) {
    if (chunkIdx <= 0) return "";
    const prev = this.timeline.chunks[chunkIdx - 1];
    if (!prev) return "";
    const committed = (prev.prompt_gen_committed_text || "").trim();
    if (committed) return committed;
    const cuts = (prev.segments || [])
      .map((s) => (s.prompt || "").trim())
      .filter(Boolean)
      .join(" ");
    const parts = [];
    if (prev.style_line) parts.push(`Style: ${prev.style_line}`);
    if (cuts) parts.push(`Action: ${cuts}`);
    if (prev.overall_soundscape) parts.push(`Soundscape: ${prev.overall_soundscape}`);
    if (prev.non_diegetic_music) parts.push(`Music: ${prev.non_diegetic_music}`);
    return parts.join("\n");
  }

  // ── Integrated Prompt Gen (LLM-assisted six-section prompt writer) ─────────
  // Uses the same reference images already dropped into the character/background
  // slots above, plus a short brief, to draft a full H3 prompt. Nothing the LLM
  // writes takes effect until Commit is clicked — Generate/Regenerate only ever
  // touch this chunk's prompt_gen_draft_text, execute() only ever reads its
  // prompt_gen_committed_text. One of these per chunk (see renderReferences) —
  // chunk 2+ requires the previous chunk to already have some content, since its
  // Generate call uses that as continuation context (see _prevChunkContextText),
  // and chunk 2+'s own images/backend settings still come from the shared
  // globals above.
  _buildPromptGenSection(chunkIdx) {
    const chunk = this.timeline.chunks[chunkIdx];
    const prevContext = this._prevChunkContextText(chunkIdx);
    const blockedOnPrev = chunkIdx > 0 && !prevContext;

    const wrap = document.createElement("div");
    wrap.className = "mmd-box mmd-box-promptgen";
    wrap.style.marginTop = "10px";

    const head = document.createElement("div");
    head.style.display = "flex";
    head.style.alignItems = "center";
    head.style.justifyContent = "space-between";
    const title = document.createElement("div");
    title.className = "mmd-box-title";
    title.textContent = `🧊 PROMPT GEN — CHUNK ${chunkIdx + 1} (LLM)`;
    head.appendChild(title);

    const toggleLabel = document.createElement("label");
    toggleLabel.style.display = "flex";
    toggleLabel.style.alignItems = "center";
    toggleLabel.style.gap = "6px";
    toggleLabel.style.fontSize = "11px";
    toggleLabel.style.color = "#9a9aae";
    toggleLabel.textContent = "On";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "mmd-box-checkbox";
    toggle.checked = !!chunk.prompt_gen_enabled;
    toggle.disabled = blockedOnPrev;
    toggle.addEventListener("change", () => {
      chunk.prompt_gen_enabled = toggle.checked;
      this.commitChanges();
      this.renderReferences();
    });
    toggleLabel.prepend(toggle);
    head.appendChild(toggleLabel);
    wrap.appendChild(head);

    if (blockedOnPrev) {
      const hint = document.createElement("div");
      hint.className = "mmd-gear-hint";
      hint.textContent = `Chunk ${chunkIdx} needs some content first — this chunk's Prompt Gen continues from Chunk ${chunkIdx}'s committed Prompt Gen text if it has any, otherwise its CUTs/style/soundscape, so there's nothing to continue from yet.`;
      wrap.appendChild(hint);
      return wrap;
    }

    if (!chunk.prompt_gen_enabled) {
      const hint = document.createElement("div");
      hint.className = "mmd-gear-hint";
      hint.textContent = "Off — type CUTs into this chunk's timeline below as normal.";
      wrap.appendChild(hint);
      return wrap;
    }

    const hint = document.createElement("div");
    hint.className = "mmd-gear-hint";
    hint.textContent = chunkIdx === 0
      ? "Generates a full six-section prompt from the reference images above plus your brief. Has its own backend below, independent of the per-image Analyze settings in the gear menu — writing a whole scene is a harder task than a one-sentence caption, so a bigger/slower model here often helps even if Analyze stays on something small and fast. Nothing is used until you click Commit — this chunk's own CUTs are ignored while a prompt is committed."
      : `Continues from Chunk ${chunkIdx}'s committed prompt — the model sees what was already established (style, Subjects, what happened) and is told to continue from it, not repeat or restart it. Nothing is used until you click Commit.`;
    wrap.appendChild(hint);

    const providerOptions = [
      { value: "ollama", label: "Ollama (local)" },
      { value: "lmstudio", label: "LM Studio (local)" },
      { value: "gemini", label: "Gemini / Google" },
      { value: "custom", label: "Custom (OpenAI-compatible)" },
    ];
    const providerRow = document.createElement("div");
    providerRow.className = "mmd-box-row";
    const providerLabel = document.createElement("label");
    providerLabel.textContent = "Provider";
    providerRow.appendChild(providerLabel);
    const providerSelect = document.createElement("select");
    providerSelect.className = "mmd-box-select";
    for (const opt of providerOptions) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      providerSelect.appendChild(o);
    }
    providerSelect.value = this.timeline.prompt_gen_provider || "ollama";
    providerSelect.addEventListener("change", () => {
      this.timeline.prompt_gen_provider = providerSelect.value;
      this.commitChanges();
      const ph = MinimaxTimelineEditor._promptGenPlaceholders(providerSelect.value);
      urlInput.placeholder = ph.url;
      modelInput.placeholder = ph.model;
    });
    providerRow.appendChild(providerSelect);
    wrap.appendChild(providerRow);

    const urlRow = document.createElement("div");
    urlRow.className = "mmd-box-row";
    const urlLabel = document.createElement("label");
    urlLabel.textContent = "Base URL";
    urlRow.appendChild(urlLabel);
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "mmd-box-number";
    urlInput.style.width = "100%";
    urlInput.value = this.timeline.prompt_gen_base_url || "";
    urlInput.addEventListener("change", () => {
      this.timeline.prompt_gen_base_url = urlInput.value.trim();
      this.commitChanges();
    });
    urlRow.appendChild(urlInput);
    wrap.appendChild(urlRow);

    const modelRow = document.createElement("div");
    modelRow.className = "mmd-box-row";
    const modelLabel = document.createElement("label");
    modelLabel.textContent = "Model";
    modelRow.appendChild(modelLabel);
    const modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.className = "mmd-box-number";
    modelInput.style.width = "100%";
    modelInput.value = this.timeline.prompt_gen_model || "";
    modelInput.addEventListener("change", () => {
      this.timeline.prompt_gen_model = modelInput.value.trim();
      this.commitChanges();
    });
    modelRow.appendChild(modelInput);
    wrap.appendChild(modelRow);

    // Placeholder text shows a concrete worked example rather than the vague
    // "blank = provider default", since that alone doesn't tell a first-time
    // user what a filled-in value actually looks like.
    const initialPh = MinimaxTimelineEditor._promptGenPlaceholders(providerSelect.value);
    urlInput.placeholder = initialPh.url;
    modelInput.placeholder = initialPh.model;

    const briefInput = document.createElement("textarea");
    briefInput.className = "mmd-desc-input";
    briefInput.rows = 3;
    briefInput.placeholder = chunkIdx === 0
      ? "Describe the scene/action you want (e.g. \"she walks into frame and waves at the camera\")..."
      : "Describe what happens in THIS chunk (e.g. \"continuing the flight, circling the spire, heading toward the moon\")...";
    briefInput.value = chunk.prompt_gen_brief || "";
    briefInput.addEventListener("change", () => {
      chunk.prompt_gen_brief = briefInput.value;
      this.commitChanges();
    });
    wrap.appendChild(briefInput);

    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "6px";
    btnRow.style.marginTop = "6px";
    const genBtn = document.createElement("button");
    genBtn.className = "mmd-promptgen-btn";
    genBtn.style.flex = "1";
    genBtn.textContent = chunk.prompt_gen_draft_text ? "Regenerate Prompt" : "Generate Prompt";
    btnRow.appendChild(genBtn);
    wrap.appendChild(btnRow);

    const draftInput = document.createElement("textarea");
    draftInput.className = "mmd-desc-input";
    draftInput.rows = 8;
    draftInput.placeholder = "(generated prompt will appear here — review and edit freely before committing)";
    draftInput.value = chunk.prompt_gen_draft_text || "";
    draftInput.style.display = chunk.prompt_gen_draft_text ? "" : "none";
    draftInput.addEventListener("input", () => {
      chunk.prompt_gen_draft_text = draftInput.value;
      this.commitChanges();
      updateStatus();
    });
    wrap.appendChild(draftInput);

    const commitRow = document.createElement("div");
    commitRow.style.display = "flex";
    commitRow.style.alignItems = "center";
    commitRow.style.gap = "8px";
    commitRow.style.marginTop = "6px";
    const commitBtn = document.createElement("button");
    commitBtn.className = "mmd-promptgen-btn";
    commitBtn.style.flex = "1";
    commitBtn.textContent = "Commit";
    commitBtn.style.display = chunk.prompt_gen_draft_text ? "" : "none";
    commitBtn.addEventListener("click", () => {
      chunk.prompt_gen_committed_text = chunk.prompt_gen_draft_text;
      this.commitChanges();
      updateStatus();
      // A later chunk may have been blocked waiting on this one's commit —
      // re-render so it unlocks immediately rather than needing another click.
      this.renderReferences();
    });
    commitRow.appendChild(commitBtn);
    const statusEl = document.createElement("div");
    statusEl.style.fontSize = "11px";
    commitRow.appendChild(statusEl);
    wrap.appendChild(commitRow);

    const updateStatus = () => {
      const committed = chunk.prompt_gen_committed_text || "";
      const draft = chunk.prompt_gen_draft_text || "";
      commitBtn.style.display = draft ? "" : "none";
      draftInput.style.display = draft ? "" : "none";
      if (!committed) {
        statusEl.textContent = "Not committed — Generate will not affect the render until you click Commit.";
        statusEl.style.color = "#9a9aae";
      } else if (committed === draft) {
        statusEl.textContent = "Committed — this is the active prompt.";
        statusEl.style.color = "#33C481";
      } else {
        statusEl.textContent = "Draft edited since last Commit — click Commit to apply the changes.";
        statusEl.style.color = "#E0A030";
      }
    };
    updateStatus();

    genBtn.addEventListener("click", async () => {
      if (genBtn.classList.contains("mmd-loading")) return;
      genBtn.classList.add("mmd-loading");
      genBtn.textContent = "Generating...";
      try {
        const { imageB64List, speakerAudioMap } = await this._gatherPromptGenReferences();
        const resp = await api.fetchApi("/muse_minimax_director_v1_4/generate_scene_prompt", {
          method: "POST",
          body: JSON.stringify({
            brief: chunk.prompt_gen_brief || "",
            image_b64_list: imageB64List,
            speaker_audio_map: speakerAudioMap,
            dialogue_language: this.timeline.dialogue_language || "English",
            provider: this.timeline.prompt_gen_provider || "ollama",
            base_url: this.timeline.prompt_gen_base_url || "",
            model: this.timeline.prompt_gen_model || "",
            previous_chunk_text: prevContext || "",
          }),
        });
        const result = await resp.json();
        if (result.status === "success") {
          chunk.prompt_gen_draft_text = result.prompt;
          this.commitChanges();
          this.renderReferences();
        } else {
          alert("Prompt Gen error: " + result.message);
          genBtn.classList.remove("mmd-loading");
          genBtn.textContent = chunk.prompt_gen_draft_text ? "Regenerate Prompt" : "Generate Prompt";
        }
      } catch (err) {
        console.error("[MuseMinimaxDirector] prompt gen request failed", err);
        alert("Prompt Gen request failed — is ComfyUI running, and is your chosen provider reachable?");
        genBtn.classList.remove("mmd-loading");
        genBtn.textContent = chunk.prompt_gen_draft_text ? "Regenerate Prompt" : "Generate Prompt";
      }
    });

    return wrap;
  }

  // Same "Ref Audio N = Ref N's voice" positional convention already used by the
  // normal CUT-based compiler — Ref Audio slot i pairs with character slot i (only
  // the first REF_AV_SLOTS character slots can have a paired voice at all). Returns
  // speakerAudioMap parallel to imageB64List: null = no voice reference for that
  // Subject (model should invent one), or {n, retention} to cite <Audio n> with the
  // wording appropriate to that slot's own retention dropdown (Voice Reference / Lip
  // Sync / Partial Voice Match / Weak Reference — see AUDIO_RETENTION_OPTIONS). The
  // background image (if any) is always appended last with no audio pairing.
  async _gatherPromptGenReferences() {
    const b64List = [];
    const speakerAudioMap = [];
    let audioCounter = 0;
    for (let i = 0; i < MAX_CHARACTER_SLOTS; i++) {
      const entry = this.timeline.characters[i];
      if (!entry) continue;
      b64List.push(await this._resolveImageB64(entry));
      const audioEntry = i < REF_AV_SLOTS ? this.timeline.refAudios[i] : null;
      if (audioEntry) {
        audioCounter++;
        speakerAudioMap.push({
          n: audioCounter,
          retention: audioEntry.retention || "reference",
          transcript_segments: audioEntry.retention === "fully_copy" ? (audioEntry.transcript_segments || []) : [],
        });
      } else {
        speakerAudioMap.push(null);
      }
    }
    // Chunk 1's own Location only — this feeds the (currently hidden) Prompt
    // Gen drafting helper's continuation-context estimate, which only ever
    // matches chunk 1's composition; see _resolve_location_for_chunk on the
    // Python side for the real per-chunk resolution used at render time.
    const loc0 = this.timeline.locations && this.timeline.locations[0];
    if (loc0 && (loc0.file || loc0._blobUrl || loc0.image_b64)) {
      b64List.push(await this._resolveImageB64(loc0));
      speakerAudioMap.push(null);
    }
    return { imageB64List: b64List, speakerAudioMap };
  }

  // ── Reference video / audio slots (upload + scrub + trim) ──────────────────
  _buildRefAvSlot(kind, idx) {
    const isVideo = kind === "video";
    const listKey = isVideo ? "refVideos" : "refAudios";
    const entry = this.timeline[listKey][idx];

    const slot = document.createElement("div");
    slot.className = "mmd-av-slot " + (isVideo ? "mmd-av-slot-video" : "mmd-av-slot-audio") + (entry ? " mmd-filled" : "");

    const head = document.createElement("div");
    head.className = "mmd-av-slot-head";
    const label = document.createElement("div");
    label.className = "mmd-av-slot-label";
    label.textContent = `${isVideo ? "Ref Video" : "Ref Audio"} ${idx + 1}`;
    head.appendChild(label);
    if (entry) {
      const del = document.createElement("button");
      del.className = "mmd-av-slot-del";
      del.innerHTML = "&times;";
      del.title = "Remove";
      del.addEventListener("click", () => {
        this.timeline[listKey][idx] = null;
        this.commitChanges();
        this.renderReferences();
        this.renderTimeline();
        this._updateLongFormVisibility();
      });
      head.appendChild(del);
    }
    slot.appendChild(head);

    if (!entry) {
      const placeholder = document.createElement("div");
      placeholder.className = "mmd-av-placeholder";
      placeholder.innerHTML = `${ICON_UPLOAD}<span>Drop or click to upload ${isVideo ? "video" : "audio"}</span>`;
      placeholder.addEventListener("click", () => this._promptAvFilePick(kind, idx));
      slot.appendChild(placeholder);
    } else {
      slot.appendChild(this._buildAvMedia(kind, idx, entry));
      if (this.isHybridMode()) slot.appendChild(this._buildSharedAssetToggle(entry));
    }

    const dragColor = isVideo ? "#4F8EF7" : "#FF8800";
    slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.style.borderColor = dragColor; });
    slot.addEventListener("dragleave", () => { slot.style.borderColor = ""; });
    slot.addEventListener("drop", async (e) => {
      e.preventDefault();
      slot.style.borderColor = "";
      const file = e.dataTransfer.files?.[0];
      if (file) await this._setAvSlot(kind, idx, file);
    });

    return slot;
  }

  _promptAvFilePick(kind, idx) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = kind === "video" ? "video/*" : "audio/*";
    input.onchange = async () => {
      if (input.files?.[0]) await this._setAvSlot(kind, idx, input.files[0]);
    };
    input.click();
  }

  async _setAvSlot(kind, idx, file) {
    const listKey = kind === "video" ? "refVideos" : "refAudios";
    try {
      const uploaded = await uploadRefFile(file);
      const entry = { ...uploaded, trimStartSec: 0, trimEndSec: null, sourceDurationSec: null, shared: false };
      if (kind === "video") {
        entry.includeAudio = false;
      }
      if (kind === "audio") {
        try {
          const { peaks, duration } = await extractAudioPeaks(file);
          entry.waveformPeaks = peaks;
          entry.sourceDurationSec = duration;
          entry.trimEndSec = duration;
        } catch (err) {
          console.warn("[MuseMinimaxDirector] waveform peak extraction failed", err);
        }
      }
      entry._blobUrl = URL.createObjectURL(file);
      this.timeline[listKey][idx] = entry;
      this.commitChanges();
      this.renderReferences();
      this.renderTimeline();
    } catch (err) {
      console.error("[MuseMinimaxDirector] reference upload failed", err);
      alert("Upload failed — see console for details.");
    }
  }

  _buildAvMedia(kind, idx, entry, pairedCharacters = this.timeline.characters) {
    const listKey = kind === "video" ? "refVideos" : "refAudios";
    const wrap = document.createElement("div");
    wrap.className = "mmd-av-media";

    // _blobUrl only lives for the page session that created it via
    // URL.createObjectURL — it goes dead after any reload, but the string itself
    // gets saved into timeline_data and reloaded right along with it. entry.file
    // (the real uploaded server path) is always durable, so it must win once it
    // exists; _blobUrl is only a same-session fast path for brand new uploads.
    const src = entry.file ? comfyViewUrl(entry.file) : entry._blobUrl;
    let mediaEl;
    if (kind === "video") {
      mediaEl = document.createElement("video");
      mediaEl.src = src;
      mediaEl.playsInline = true;
      mediaEl.controls = false;
      wrap.appendChild(mediaEl);
    } else {
      mediaEl = document.createElement("audio");
      mediaEl.src = src;
      mediaEl.style.display = "none";
      wrap.appendChild(mediaEl);

      const canvas = document.createElement("canvas");
      canvas.className = "mmd-av-canvas";
      canvas.width = 260;
      canvas.height = 40;
      wrap.appendChild(canvas);
      requestAnimationFrame(() => this._drawWaveform(canvas, entry));
    }

    // The <audio>/<video> element's own duration (surfaced via loadedmetadata) is the
    // authoritative one for playback/scrubbing purposes — some containers (e.g. certain
    // FLAC files) report a misleadingly short duration from decodeAudioData, which is
    // only used above for waveform peaks. Always sync to the media element once it's
    // known, but don't clobber a trim point the user already set deliberately.
    const finalizeDuration = () => {
      if (!mediaEl.duration || !isFinite(mediaEl.duration)) return;
      const trimWasAtOldEnd = entry.trimEndSec === null || entry.trimEndSec === entry.sourceDurationSec;
      entry.sourceDurationSec = mediaEl.duration;
      if (trimWasAtOldEnd) entry.trimEndSec = mediaEl.duration;
      scrub.max = String(mediaEl.duration);
      this.commitChanges();
      this._updateAvReadout(readout, entry);
      this._updateLipSyncWindowReadouts();
    };
    mediaEl.addEventListener("loadedmetadata", finalizeDuration);

    const scrubRow = document.createElement("div");
    scrubRow.className = "mmd-av-scrub-row";

    const playBtn = document.createElement("button");
    playBtn.className = "mmd-av-play-btn";
    playBtn.innerHTML = ICON_PLAY;
    playBtn.title = "Play/Pause";
    playBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (mediaEl.paused) mediaEl.play(); else mediaEl.pause();
    });
    mediaEl.addEventListener("play", () => { playBtn.innerHTML = ICON_PAUSE; });
    mediaEl.addEventListener("pause", () => { playBtn.innerHTML = ICON_PLAY; });
    mediaEl.addEventListener("ended", () => { playBtn.innerHTML = ICON_PLAY; });
    scrubRow.appendChild(playBtn);

    const scrub = document.createElement("input");
    scrub.type = "range";
    scrub.className = "mmd-av-scrub";
    scrub.min = "0";
    scrub.max = String(entry.sourceDurationSec || 100);
    scrub.step = "0.05";
    scrub.value = "0";
    scrub.addEventListener("input", () => {
      mediaEl.currentTime = parseFloat(scrub.value);
    });
    mediaEl.addEventListener("timeupdate", () => {
      scrub.value = String(mediaEl.currentTime);
    });
    scrubRow.appendChild(scrub);
    wrap.appendChild(scrubRow);

    const trimRow = document.createElement("div");
    trimRow.className = "mmd-av-trim-row";
    const setInBtn = document.createElement("button");
    setInBtn.className = "mmd-av-trim-btn";
    setInBtn.textContent = "Set In";
    setInBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      entry.trimStartSec = Math.min(mediaEl.currentTime, (entry.trimEndSec ?? mediaEl.duration ?? mediaEl.currentTime + 1) - 0.05);
      entry.trimStartSec = Math.max(0, entry.trimStartSec);
      this.commitChanges();
      this._updateAvReadout(readout, entry);
      this._updateLipSyncWindowReadouts();
    });
    const setOutBtn = document.createElement("button");
    setOutBtn.className = "mmd-av-trim-btn";
    setOutBtn.textContent = "Set Out";
    setOutBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      entry.trimEndSec = Math.max(mediaEl.currentTime, entry.trimStartSec + 0.05);
      this.commitChanges();
      this._updateAvReadout(readout, entry);
      if (kind === "video") this._autoInsertChunksForVideo(entry);
    });
    trimRow.appendChild(setInBtn);
    trimRow.appendChild(setOutBtn);
    wrap.appendChild(trimRow);

    const readout = document.createElement("div");
    readout.className = "mmd-av-trim-readout";

    // Exact manual trim entry, ported from the Combo node. These edit the same
    // persisted trimStartSec/trimEndSec values used by Set In/Set Out.
    const manualRow = document.createElement("div");
    manualRow.className = "mmd-av-trim-row mmd-av-trim-manual-row";
    const inInput = document.createElement("input");
    inInput.type = "number";
    inInput.className = "mmd-av-trim-input";
    inInput.step = "0.05";
    inInput.min = "0";
    inInput.placeholder = "In (seconds)";
    inInput.title = "Type the exact In point in seconds";
    inInput.value = (entry.trimStartSec || 0).toFixed(2);
    inInput.addEventListener("click", (e) => e.stopPropagation());
    inInput.addEventListener("change", () => {
      const previous = entry.trimStartSec || 0;
      let value = parseFloat(inInput.value);
      if (!Number.isFinite(value)) value = previous;
      const maxIn = (entry.trimEndSec ?? entry.sourceDurationSec ?? Infinity) - 0.05;
      value = Math.max(0, Math.min(value, maxIn));
      entry.trimStartSec = value;
      this.commitChanges();
      inInput.value = value.toFixed(2);
      this._updateAvReadout(readout, entry);
      this._updateLipSyncWindowReadouts();
    });
    manualRow.appendChild(inInput);

    const outInput = document.createElement("input");
    outInput.type = "number";
    outInput.className = "mmd-av-trim-input";
    outInput.step = "0.05";
    outInput.min = "0";
    outInput.placeholder = "Out (seconds)";
    outInput.title = "Type the exact Out point in seconds; leave blank for the clip end";
    outInput.value = entry.trimEndSec !== null && entry.trimEndSec !== undefined ? entry.trimEndSec.toFixed(2) : "";
    outInput.addEventListener("click", (e) => e.stopPropagation());
    outInput.addEventListener("change", () => {
      const previous = entry.trimEndSec;
      const raw = outInput.value.trim();
      let value = raw === "" ? null : parseFloat(raw);
      if (value !== null && !Number.isFinite(value)) value = previous ?? null;
      if (value !== null) {
        const minOut = (entry.trimStartSec || 0) + 0.05;
        const maxOut = entry.sourceDurationSec ?? Infinity;
        value = Math.max(minOut, Math.min(value, maxOut));
      }
      entry.trimEndSec = value;
      this.commitChanges();
      outInput.value = value !== null ? value.toFixed(2) : "";
      this._updateAvReadout(readout, entry);
      this._updateLipSyncWindowReadouts();
      if (kind === "video") this._autoInsertChunksForVideo(entry);
    });
    manualRow.appendChild(outInput);
    wrap.appendChild(manualRow);

    wrap.appendChild(readout);
    this._updateAvReadout(readout, entry);

    const filename = document.createElement("div");
    filename.className = "mmd-av-filename";
    filename.textContent = entry.fileName || "";
    filename.style.display = this.timeline.show_filenames === false ? "none" : "";
    wrap.appendChild(filename);

    if (kind === "audio") {
      // Ref Audio N auto-pairs with Ref (character) N by position — Ref Audio 1 is
      // always Ref 1's voice, Ref Audio 2 is always Ref 2's, etc. No need to
      // describe whose voice it is when that's already known from the pairing;
      // the description field below only matters as a fallback when there's no
      // character in the matching Ref slot (e.g. an off-screen voice).
      const pairedChar = pairedCharacters[idx];
      const pairedFilled = pairedChar && (pairedChar.file || pairedChar.image_b64);
      const pairNote = document.createElement("div");
      pairNote.className = "mmd-audio-pair-note";
      pairNote.textContent = pairedFilled
        ? `Paired with Ref ${idx + 1} — this is automatically her/his voice reference.`
        : `No character in Ref ${idx + 1} — describe the voice below, or leave blank for an unattributed reference.`;
      wrap.appendChild(pairNote);

      const descInput = document.createElement("textarea");
      descInput.className = "mmd-desc-input";
      descInput.placeholder = "optional — only used when there's no matching character, e.g. \"Sarah — warm, mid-range\"";
      descInput.value = entry.description || "";
      descInput.addEventListener("click", (e) => e.stopPropagation());
      descInput.addEventListener("input", () => {
        entry.description = descInput.value;
        this.commitChanges();
      });
      wrap.appendChild(descInput);

      wrap.appendChild(this._miniSelectRow(
        "Retention", entry.retention || "reference", AUDIO_RETENTION_OPTIONS,
        (v) => { entry.retention = v; this.renderReferences(); this._updateLongFormVisibility(); },
      ));

      if (entry.retention === "fully_copy") {
        wrap.appendChild(this._buildLipSyncBox(entry, idx));
      }
    }

    if (kind === "video") {
      const audioToggleRow = document.createElement("label");
      audioToggleRow.className = "mmd-av-audio-toggle";
      audioToggleRow.addEventListener("click", (e) => e.stopPropagation());

      const audioToggle = document.createElement("input");
      audioToggle.type = "checkbox";
      audioToggle.className = "mmd-box-checkbox";
      audioToggle.checked = !!entry.includeAudio;
      audioToggle.addEventListener("change", () => {
        // CORRECTED 2026-09-04: this used to only commitChanges() — fine while
        // nothing on screen depended on entry.includeAudio, but the Audio State
        // dropdown added tonight is conditional on it (`if (entry.includeAudio)`
        // below), so ticking the box silently changed the data without ever
        // re-rendering the panel to actually show the now-relevant dropdown —
        // confirmed directly: it only appeared after an unrelated refresh forced
        // a redraw. Re-rendering here is what actually makes it show up
        // immediately, same as every other control on this panel already does.
        entry.includeAudio = audioToggle.checked;
        this.commitChanges();
        this.renderReferences();
      });
      audioToggleRow.appendChild(audioToggle);

      const audioToggleLabel = document.createElement("span");
      audioToggleLabel.textContent = "Include this clip's audio (as its own reference)";
      audioToggleRow.appendChild(audioToggleLabel);

      wrap.appendChild(audioToggleRow);

      const subjectDescInput = document.createElement("textarea");
      subjectDescInput.className = "mmd-desc-input";
      subjectDescInput.placeholder = "if this video shows a person/element to reuse, describe them here (creates a Subject) — leave blank for a pure motion/camera reference";
      subjectDescInput.value = entry.description || "";
      subjectDescInput.addEventListener("click", (e) => e.stopPropagation());
      subjectDescInput.addEventListener("input", () => {
        entry.description = subjectDescInput.value;
        this.commitChanges();
      });
      wrap.appendChild(subjectDescInput);

      wrap.appendChild(this._miniSelectRow(
        "Role", entry.role || "reference", VIDEO_ROLE_OPTIONS,
        (v) => { entry.role = v; },
      ));
      // Default keys off role, not just description: a blank description on plain
      // "Reference" role genuinely means weak_reference (pure motion/camera, no
      // scene) — but the same blank description on "Editing source" means the
      // opposite, since editing is supposed to keep the scene and only swap the
      // person. Defaulting both to weak_reference was the exact trap that caused
      // a real, confirmed bad render.
      const videoRetentionDefault = entry.retention || (
        entry.description ? "fully_preserved" : (entry.role === "editing_source" ? "partially_preserved" : "weak_reference")
      );
      wrap.appendChild(this._miniSelectRow(
        "Retention", videoRetentionDefault, VIDEO_RETENTION_OPTIONS,
        (v) => { entry.retention = v; },
      ));

      // Only meaningful when this clip's audio is actually being sent — hidden
      // otherwise so it can't imply a control over audio that isn't included at
      // all. Separate field (entry.audioRetention) from the visual entry.retention
      // above on purpose: a video can be "duplicate video, replace character"
      // visually while its beat is still just a loose reference, or vice versa —
      // these are two independent questions, not one shared setting.
      if (entry.includeAudio) {
        wrap.appendChild(this._miniSelectRow(
          "Audio State", entry.audioRetention || "reference", VIDEO_AUDIO_RETENTION_OPTIONS,
          (v) => { entry.audioRetention = v; },
        ));
      }

      // 2026-09-04: lets one long source clip (e.g. a 45s dance) drive motion
      // across a whole multi-chunk render instead of every chunk reusing the
      // exact same Set In/Out window. Off by default — an existing workflow's
      // single-window behavior is unchanged unless this is switched on. Set
      // In/Out above should span the FULL performance when this is on (e.g.
      // 0.00-45.00), not one chunk's worth — the backend carves each chunk's
      // own slice out of that full window automatically, the same "walk
      // forward through the source material one chunk at a time" idea Lip
      // Sync's Whisper segments already use, just driven by chunk length
      // instead of transcript timestamps.
      const continueRow = document.createElement("label");
      continueRow.className = "mmd-av-audio-toggle";
      continueRow.addEventListener("click", (e) => e.stopPropagation());
      const continueToggle = document.createElement("input");
      continueToggle.type = "checkbox";
      continueToggle.className = "mmd-box-checkbox";
      continueToggle.checked = !!entry.continueAcrossChunks;
      continueToggle.addEventListener("change", () => {
        entry.continueAcrossChunks = continueToggle.checked;
        this.commitChanges();
      });
      continueRow.appendChild(continueToggle);
      const continueLabel = document.createElement("span");
      continueLabel.textContent = "Continue across chunks (Set In/Out = the full performance, not one chunk)";
      continueRow.appendChild(continueLabel);
      wrap.appendChild(continueRow);

      // 2026-09-04: separate from Audio State's "Reuse exactly" — that still
      // asks H3 to GENERATE audio matching this reference, which is only ever
      // as faithful as the model's own compliance (confirmed inconsistent
      // tonight, especially across a stitched multi-chunk render). This instead
      // literally overlays the real source audio onto the finished output after
      // generation — a true copy, not a generated approximation. Off by
      // default, and explicitly not for Lip Sync (no word-level timing here) —
      // for cases where the real soundtrack matters more than perfect mouth
      // sync. Scoped to video refs only, same as everything else in this block.
      const overlayRow = document.createElement("label");
      overlayRow.className = "mmd-av-audio-toggle";
      overlayRow.addEventListener("click", (e) => e.stopPropagation());
      const overlayToggle = document.createElement("input");
      overlayToggle.type = "checkbox";
      overlayToggle.className = "mmd-box-checkbox";
      overlayToggle.checked = !!entry.overlayOriginalAudio;
      overlayToggle.addEventListener("change", () => {
        entry.overlayOriginalAudio = overlayToggle.checked;
        this.commitChanges();
      });
      overlayRow.appendChild(overlayToggle);
      const overlayLabel = document.createElement("span");
      overlayLabel.textContent = "Embed this clip's real audio over the final output (bypasses generated "
        + "audio entirely — not for Lip Sync)";
      overlayRow.appendChild(overlayLabel);
      wrap.appendChild(overlayRow);

      // 2026-09-04: "Analyze First Frame" — captures the frame at THIS video's
      // own current Set In point (not frame 0 of the raw file) and describes
      // the existing scene for placement grounding, per the confirmed-real
      // guidance (both MiniMax's own prompting docs and general video-
      // composition research) that establishing scene anchors before
      // describing new content helps place that content correctly — a
      // placement/reasoning task, distinct from tonight's separate finding
      // that describing motion H3 can already see doesn't add much. Reuses
      // the exact same mediaEl the Set In/Out buttons already scrub — seek to
      // trimStartSec, wait for the real "seeked" event (not just setting
      // currentTime, which is async), draw to a canvas, and send it through
      // the same data-URL format _resolveImageB64 already produces
      // elsewhere, so the backend sees identical input shape to the existing
      // per-image Analyze route. Result is editable (same pattern as every
      // other description field), not auto-applied silently — see the
      // style_line prepend in execute() for how it reaches the compiled
      // prompt.
      const analyzeSceneBtn = document.createElement("button");
      analyzeSceneBtn.className = "mmd-analyze-btn";
      analyzeSceneBtn.style.marginTop = "6px";
      analyzeSceneBtn.textContent = entry.sceneAnchor ? "Re-Analyze First Frame" : "Analyze First Frame";
      analyzeSceneBtn.title = "Captures the frame at the current Set In point and describes the "
        + "existing scene — environment, key objects, colors, layout — so new content can be "
        + "placed correctly within it. Feeds into the compiled prompt automatically.";
      analyzeSceneBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (analyzeSceneBtn.classList.contains("mmd-loading")) return;
        analyzeSceneBtn.classList.add("mmd-loading");
        analyzeSceneBtn.textContent = "Analyzing...";
        try {
          const targetTime = parseFloat(entry.trimStartSec) || 0;
          await new Promise((resolve) => {
            const onSeeked = () => { mediaEl.removeEventListener("seeked", onSeeked); resolve(); };
            mediaEl.addEventListener("seeked", onSeeked);
            mediaEl.currentTime = targetTime;
            setTimeout(() => { mediaEl.removeEventListener("seeked", onSeeked); resolve(); }, 4000);
          });
          const canvas = document.createElement("canvas");
          canvas.width = mediaEl.videoWidth;
          canvas.height = mediaEl.videoHeight;
          canvas.getContext("2d").drawImage(mediaEl, 0, 0, canvas.width, canvas.height);
          const frameB64 = canvas.toDataURL("image/jpeg", 0.92);
          const resp = await api.fetchApi("/muse_minimax_director_v1_4/analyze_scene_anchor", {
            method: "POST",
            body: JSON.stringify({
              image_b64: [frameB64],
              provider: this.timeline.analyze_provider || "ollama",
              base_url: this.timeline.analyze_base_url || "",
              model: this.timeline.analyze_model || "",
            }),
          });
          const result = await resp.json();
          if (result.status === "success") {
            entry.sceneAnchor = result.description;
            sceneAnchorInput.value = result.description;
            analyzeSceneBtn.textContent = "Success!";
            this.commitChanges();
            setTimeout(() => {
              analyzeSceneBtn.classList.remove("mmd-loading");
              analyzeSceneBtn.textContent = "Re-Analyze First Frame";
            }, 1200);
          } else {
            alert("Scene analysis error: " + result.message);
            analyzeSceneBtn.classList.remove("mmd-loading");
            analyzeSceneBtn.textContent = "Analyze First Frame";
          }
        } catch (err) {
          console.error("[MuseMinimaxDirector] scene anchor analysis failed", err);
          alert("Analyze First Frame failed — is ComfyUI running, and is Ollama (or your chosen "
            + "provider) reachable?");
          analyzeSceneBtn.classList.remove("mmd-loading");
          analyzeSceneBtn.textContent = "Analyze First Frame";
        }
      });
      wrap.appendChild(analyzeSceneBtn);

      var sceneAnchorInput = document.createElement("textarea");
      sceneAnchorInput.className = "mmd-desc-input";
      sceneAnchorInput.placeholder = "scene anchor (environment, objects, layout, colors) — from "
        + "Analyze First Frame, or type your own";
      sceneAnchorInput.value = entry.sceneAnchor || "";
      sceneAnchorInput.addEventListener("click", (e) => e.stopPropagation());
      sceneAnchorInput.addEventListener("input", () => {
        entry.sceneAnchor = sceneAnchorInput.value;
        this.commitChanges();
      });
      wrap.appendChild(sceneAnchorInput);

      // CORRECTED 2026-09-04: the toggle above only makes the video FOLLOW
      // however many chunks already exist — it doesn't create them. Confirmed
      // directly this was the wrong half of the ask: the actual request was
      // "Set Out past one chunk's length should be able to insert the chunks
      // needed to cover it," the same job "Insert as Timed CUTs" does for a
      // Whisper transcript, just driven by Set Out instead of segment count.
      // Reuses _addChunkAfter (the same primitive the manual "+ Add Chunk" bar
      // calls) in a loop rather than duplicating its duration_seconds/
      // timeline.chunks bookkeeping, then does one final precise
      // duration_seconds set so the last chunk absorbs the real remainder
      // instead of overshooting to a round multiple of chunk size.
      // Manual fallback for re-triggering without re-touching Set Out (e.g. Set
      // Out was already correct before this feature existed) — same shared
      // helper as the automatic Set Out hooks above, not a second copy of the
      // insertion logic.
      const insertChunksBtn = document.createElement("button");
      insertChunksBtn.className = "mmd-analyze-btn";
      insertChunksBtn.style.marginTop = "6px";
      insertChunksBtn.textContent = "Insert Chunks to Cover This";
      insertChunksBtn.title = "Adds however many chunks are needed so the whole Set In/Out window fits, "
        + "and turns on Continue across chunks automatically. Happens automatically when you edit Set Out "
        + "too — this is only here for re-running it without changing Set Out again.";
      insertChunksBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!(parseFloat(entry.trimEndSec) > (parseFloat(entry.trimStartSec) || 0))) {
          alert("Set Out needs to be set (and after Set In) before chunks can be inserted for it.");
          return;
        }
        this._autoInsertChunksForVideo(entry);
      });
      wrap.appendChild(insertChunksBtn);

      if (entry._autoChunkNote) {
        const note = document.createElement("div");
        note.className = "mmd-gear-hint";
        note.style.cssText = "background:#233b25;color:#b9e6b9;border:1px solid #3d6b3f;border-radius:6px;"
          + "padding:6px 8px;margin-top:6px;display:flex;justify-content:space-between;align-items:center;gap:8px;";
        const noteText = document.createElement("span");
        noteText.textContent = entry._autoChunkNote;
        note.appendChild(noteText);
        const noteDismiss = document.createElement("button");
        noteDismiss.className = "mmd-analyze-btn";
        noteDismiss.style.cssText = "width:auto;flex-shrink:0;padding:2px 8px;";
        noteDismiss.textContent = "OK";
        noteDismiss.addEventListener("click", (e) => {
          e.stopPropagation();
          entry._autoChunkNote = null;
          this.commitChanges();
          this.renderReferences();
        });
        note.appendChild(noteDismiss);
        wrap.appendChild(note);
      }
    }

    return wrap;
  }

  // ── Lip Sync transcription (Whisper, CPU-only) ──────────────────────────────
  // Only shown when this slot's Retention is "fully_copy" (Lip Sync) — a Voice
  // Reference doesn't need real words, only Lip Sync does. transcript_segments is
  // the source of truth for both Prompt Gen (see _gatherPromptGenReferences) and
  // Insert as Timed CUTs below — each segment keeps Whisper's own real start/end
  // time, which is what makes pacing accurate instead of one undifferentiated block.
  _buildLipSyncBox(entry, idx) {
    const box = document.createElement("div");
    box.className = "mmd-lipsync-box";
    box.addEventListener("click", (e) => e.stopPropagation());

    const hint = document.createElement("div");
    hint.className = "mmd-gear-hint";
    hint.textContent = "Lip Sync needs the real spoken words, timed to the audio. Transcribe below (runs on CPU, no VRAM cost), then correct any mistakes by hand — accuracy drops on fast or sung lyrics.";
    box.appendChild(hint);

    // Optional clean vocals/dialogue stem used by Whisper only. The main Ref
    // Audio entry remains the exact full mix sent to H3; the backend deliberately
    // ignores these transcription_* fields when assembling generation inputs.
    const transcriptionSource = document.createElement("div");
    transcriptionSource.className = "mmd-lipsync-transcription-source";
    transcriptionSource.style.marginTop = "6px";
    const transcriptionLabel = document.createElement("div");
    transcriptionLabel.style.fontSize = "12px";
    transcriptionLabel.style.color = "#aaaabd";
    transcriptionLabel.textContent = "Whisper transcription source (optional vocals-only track)";
    transcriptionSource.appendChild(transcriptionLabel);

    if (entry.transcription_file) {
      const vocalsMedia = document.createElement("div");
      vocalsMedia.className = "mmd-av-media";
      vocalsMedia.style.marginTop = "4px";
      const vocalsAudio = document.createElement("audio");
      vocalsAudio.src = comfyViewUrl(entry.transcription_file);
      vocalsAudio.style.display = "none";
      vocalsMedia.appendChild(vocalsAudio);

      const vocalsCanvas = document.createElement("canvas");
      vocalsCanvas.className = "mmd-av-canvas";
      vocalsCanvas.width = 260;
      vocalsCanvas.height = 40;
      vocalsMedia.appendChild(vocalsCanvas);
      const drawVocals = () => this._drawWaveform(vocalsCanvas, {
        waveformPeaks: entry.transcription_waveform_peaks || [],
      });
      requestAnimationFrame(drawVocals);

      // Older workflows may already contain a transcription-only upload from
      // before waveform metadata was stored. Recover it lazily from the durable
      // server file so the user does not have to upload the stem again.
      if (!entry.transcription_waveform_peaks?.length) {
        fetch(comfyViewUrl(entry.transcription_file))
          .then((r) => r.blob())
          .then((blob) => extractAudioPeaks(new File([blob], entry.transcription_file_name || "vocals")))
          .then(({ peaks, duration }) => {
            entry.transcription_waveform_peaks = peaks;
            entry.transcription_duration_sec = duration;
            this.commitChanges();
            drawVocals();
          })
          .catch((err) => console.warn("[MuseMinimaxDirectorV1.4] vocals waveform decode failed", err));
      }

      const vocalsScrubRow = document.createElement("div");
      vocalsScrubRow.className = "mmd-av-scrub-row";
      const vocalsPlay = document.createElement("button");
      vocalsPlay.className = "mmd-av-play-btn";
      vocalsPlay.innerHTML = ICON_PLAY;
      vocalsPlay.title = "Play/Pause vocals-only transcription source";
      const vocalsScrub = document.createElement("input");
      vocalsScrub.type = "range";
      vocalsScrub.className = "mmd-av-scrub";
      vocalsScrub.min = "0";
      vocalsScrub.max = String(entry.transcription_duration_sec || entry.sourceDurationSec || 100);
      vocalsScrub.step = "0.05";
      vocalsScrub.value = String(entry.trimStartSec || 0);
      vocalsPlay.addEventListener("click", () => {
        const start = entry.trimStartSec || 0;
        const end = entry.trimEndSec ?? vocalsAudio.duration;
        if (vocalsAudio.currentTime < start || vocalsAudio.currentTime >= end) vocalsAudio.currentTime = start;
        if (vocalsAudio.paused) vocalsAudio.play(); else vocalsAudio.pause();
      });
      vocalsAudio.addEventListener("play", () => { vocalsPlay.innerHTML = ICON_PAUSE; });
      vocalsAudio.addEventListener("pause", () => { vocalsPlay.innerHTML = ICON_PLAY; });
      vocalsAudio.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(vocalsAudio.duration)) {
          entry.transcription_duration_sec = vocalsAudio.duration;
          vocalsScrub.max = String(vocalsAudio.duration);
          this.commitChanges();
        }
      });
      vocalsAudio.addEventListener("timeupdate", () => {
        vocalsScrub.value = String(vocalsAudio.currentTime);
        const end = entry.trimEndSec ?? vocalsAudio.duration;
        if (!vocalsAudio.paused && vocalsAudio.currentTime >= end) vocalsAudio.pause();
      });
      vocalsScrub.addEventListener("input", () => { vocalsAudio.currentTime = parseFloat(vocalsScrub.value); });
      vocalsScrubRow.append(vocalsPlay, vocalsScrub);
      vocalsMedia.appendChild(vocalsScrubRow);

      const vocalsWindow = document.createElement("div");
      vocalsWindow.className = "mmd-av-trim-readout";
      vocalsWindow.classList.add("mmd-lipsync-window-readout");
      vocalsWindow.dataset.refAudioIndex = String(idx);
      const refreshWindow = () => {
        const start = Number(entry.trimStartSec || 0).toFixed(2);
        const end = entry.trimEndSec !== null && entry.trimEndSec !== undefined
          ? Number(entry.trimEndSec).toFixed(2) : "end";
        vocalsWindow.textContent = `Uses Ref Audio window: In ${start}s — Out ${end}s`;
      };
      refreshWindow();
      vocalsMedia.appendChild(vocalsWindow);

      const vocalsFilename = document.createElement("div");
      vocalsFilename.className = "mmd-av-filename";
      vocalsFilename.textContent = entry.transcription_file_name || "";
      vocalsMedia.appendChild(vocalsFilename);
      transcriptionSource.appendChild(vocalsMedia);
    }

    const transcriptionControls = document.createElement("div");
    transcriptionControls.style.display = "flex";
    transcriptionControls.style.gap = "6px";
    transcriptionControls.style.alignItems = "center";
    transcriptionControls.style.marginTop = "4px";
    const sourceName = document.createElement("div");
    sourceName.style.flex = "1";
    sourceName.style.minWidth = "0";
    sourceName.style.overflow = "hidden";
    sourceName.style.textOverflow = "ellipsis";
    sourceName.style.whiteSpace = "nowrap";
    sourceName.style.fontSize = "12px";
    sourceName.textContent = entry.transcription_file ? "Vocals-only source loaded" : "Using the main Ref Audio track";
    transcriptionControls.appendChild(sourceName);

    const chooseSource = document.createElement("button");
    chooseSource.className = "mmd-analyze-btn";
    chooseSource.textContent = entry.transcription_file ? "Replace vocals track" : "Upload vocals track";
    chooseSource.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "audio/*";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const uploaded = await uploadRefFile(file);
          entry.transcription_file = uploaded.file;
          entry.transcription_file_name = uploaded.fileName;
          try {
            const { peaks, duration } = await extractAudioPeaks(file);
            entry.transcription_waveform_peaks = peaks;
            entry.transcription_duration_sec = duration;
          } catch (err) {
            console.warn("[MuseMinimaxDirectorV1.4] vocals waveform extraction failed", err);
          }
          this.commitChanges();
          this.renderReferences();
        } catch (err) {
          console.error("[MuseMinimaxDirectorV1.4] transcription-source upload failed", err);
          alert("Vocals-track upload failed — see console for details.");
        }
      };
      input.click();
    });
    transcriptionControls.appendChild(chooseSource);

    if (entry.transcription_file) {
      const clearSource = document.createElement("button");
      clearSource.className = "mmd-analyze-btn";
      clearSource.textContent = "Use main track";
      clearSource.addEventListener("click", () => {
        delete entry.transcription_file;
        delete entry.transcription_file_name;
        delete entry.transcription_waveform_peaks;
        delete entry.transcription_duration_sec;
        this.commitChanges();
        this.renderReferences();
      });
      transcriptionControls.appendChild(clearSource);
    }
    transcriptionSource.appendChild(transcriptionControls);
    box.appendChild(transcriptionSource);

    const modelRow = document.createElement("div");
    modelRow.className = "mmd-box-row";
    const modelLabel = document.createElement("label");
    modelLabel.textContent = "Whisper Model";
    modelRow.appendChild(modelLabel);
    const modelSelect = document.createElement("select");
    modelSelect.className = "mmd-box-select";
    for (const size of ["tiny", "base", "small", "medium"]) {
      const o = document.createElement("option");
      o.value = size;
      o.textContent = size;
      if ((entry.whisper_model || "small") === size) o.selected = true;
      modelSelect.appendChild(o);
    }
    modelSelect.addEventListener("change", () => {
      entry.whisper_model = modelSelect.value;
      this.commitChanges();
    });
    modelRow.appendChild(modelSelect);
    box.appendChild(modelRow);

    const hasSegments = entry.transcript_segments && entry.transcript_segments.length;

    const transcribeBtn = document.createElement("button");
    transcribeBtn.className = "mmd-analyze-btn";
    transcribeBtn.style.width = "100%";
    transcribeBtn.style.marginTop = "6px";
    transcribeBtn.textContent = hasSegments ? "Re-Transcribe" : "Transcribe";
    transcribeBtn.addEventListener("click", async () => {
      if (transcribeBtn.classList.contains("mmd-loading")) return;
      if (!entry.file) {
        alert("Upload finishes saving to the server a moment after you drop the file — wait a second and try again, or re-drop the clip if this persists.");
        return;
      }
      transcribeBtn.classList.add("mmd-loading");
      transcribeBtn.textContent = "Transcribing...";
      try {
        const resp = await api.fetchApi("/muse_minimax_director_v1_4/transcribe_audio", {
          method: "POST",
          body: JSON.stringify({
            file: entry.transcription_file || entry.file,
            whisper_model: entry.whisper_model || "small",
            trim_start_sec: entry.trimStartSec || 0,
            trim_end_sec: entry.trimEndSec,
          }),
        });
        const result = await resp.json();
        if (result.status === "success") {
          entry.transcript_segments = result.segments;
          this.commitChanges();
          this.renderReferences();
        } else {
          alert("Transcription error: " + result.message);
          transcribeBtn.classList.remove("mmd-loading");
          transcribeBtn.textContent = hasSegments ? "Re-Transcribe" : "Transcribe";
        }
      } catch (err) {
        console.error("[MuseMinimaxDirector] transcription request failed", err);
        alert("Transcription request failed — see console for details.");
        transcribeBtn.classList.remove("mmd-loading");
        transcribeBtn.textContent = hasSegments ? "Re-Transcribe" : "Transcribe";
      }
    });
    box.appendChild(transcribeBtn);

    if (hasSegments) {
      const segList = document.createElement("div");
      segList.style.marginTop = "6px";
      entry.transcript_segments.forEach((seg, segIdx) => {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.gap = "6px";
        row.style.alignItems = "center";
        row.style.marginTop = "3px";
        const ts = document.createElement("div");
        ts.style.fontSize = "12px";
        ts.style.color = "#7a7a8c";
        ts.style.flexShrink = "0";
        ts.style.width = "50px";
        const m = Math.floor(seg.start / 60), s = (seg.start % 60).toFixed(1);
        ts.textContent = `${m}:${s.padStart(4, "0")}`;
        row.appendChild(ts);
        const textInput = document.createElement("input");
        textInput.type = "text";
        textInput.className = "mmd-box-number";
        textInput.style.flex = "1";
        textInput.value = seg.text;
        textInput.addEventListener("input", () => {
          entry.transcript_segments[segIdx].text = textInput.value;
          this.commitChanges();
        });
        row.appendChild(textInput);
        segList.appendChild(row);
      });
      box.appendChild(segList);

      const insertBtn = document.createElement("button");
      insertBtn.className = "mmd-analyze-btn";
      insertBtn.style.width = "100%";
      insertBtn.style.marginTop = "6px";
      insertBtn.textContent = "Insert as Timed CUTs";
      insertBtn.title = `Appends one CUT per line above, each timed to the real audio and speaker-tagged to Ref ${idx + 1}. Total Duration is extended to match the transcript's real length if needed, and each line lands in whichever chunk its own timestamp falls into — Lip Sync only, everything else in this node leaves Total Duration alone.`;
      insertBtn.addEventListener("click", () => this._insertTranscriptAsCuts(entry, idx));
      box.appendChild(insertBtn);

      // Added 2026-09-02: a visible, always-current readout of every CUT's real
      // start/end time per chunk, exactly as currently laid out on the timeline
      // (post-Insert, or after any hand edits since) — meant to be copy-pasted
      // into a prompt-writing conversation elsewhere (a different thread/tool)
      // so it can write CUT content matched to the real boundaries instead of
      // guessing them from screenshots. Built fresh every time this panel
      // renders (reads this.timeline.chunks directly, not transcript_segments),
      // so it reflects manual edits too, not just a fresh transcribe+insert.
      const timingBox = document.createElement("div");
      timingBox.className = "mmd-cut-timing-box";
      timingBox.style.marginTop = "8px";
      const timingHeader = document.createElement("div");
      timingHeader.className = "mmd-cut-timing-header";
      timingHeader.textContent = "Copy and paste this to your LLM to help with prompting";
      timingBox.appendChild(timingHeader);
      const timingText = document.createElement("textarea");
      timingText.className = "mmd-cut-timing-text";
      timingText.readOnly = true;
      timingText.value = this._exportCutTimingText();
      timingText.rows = Math.min(20, Math.max(6, timingText.value.split("\n").length));
      timingText.addEventListener("focus", () => timingText.select());
      timingBox.appendChild(timingText);
      const copyTimingBtn = document.createElement("button");
      copyTimingBtn.className = "mmd-analyze-btn";
      copyTimingBtn.style.width = "100%";
      copyTimingBtn.style.marginTop = "6px";
      copyTimingBtn.textContent = "Copy";
      copyTimingBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(timingText.value);
          copyTimingBtn.textContent = "Copied!";
        } catch (err) {
          console.error("[MuseMinimaxDirectorV1.4] clipboard write failed", err);
          timingText.select();
        }
        setTimeout(() => { copyTimingBtn.textContent = "Copy"; }, 1500);
      });
      timingBox.appendChild(copyTimingBtn);
      box.appendChild(timingBox);
    }

    return box;
  }

  // See copyTimingBtn above for why this exists. weight is each segment's own
  // duration in seconds (not a start/end pair) — segments lay out sequentially
  // within a chunk, so running cumulative sum of weight gives real boundaries,
  // same math the backend itself uses to place each chunk's own cuts.
  _exportCutTimingText() {
    const lines = [];
    (this.timeline.chunks || []).forEach((chunk, chunkIdx) => {
      const segments = chunk.segments || [];
      const chunkLen = segments.reduce((sum, s) => sum + (Number(s.weight) || 0), 0);
      lines.push(`CHUNK ${chunkIdx + 1} (${chunkLen.toFixed(1)}s)`);
      let cursor = 0;
      segments.forEach((seg, segIdx) => {
        const dur = Number(seg.weight) || 0;
        const start = cursor;
        const end = cursor + dur;
        cursor = end;
        const text = (seg.prompt || "").trim();
        const label = text ? text : "(empty — no dialogue, instrumental/pause)";
        lines.push(`  ${start.toFixed(1)}s - ${end.toFixed(1)}s  CUT ${segIdx + 1}: ${label}`);
      });
      lines.push("");
    });
    return lines.join("\n").trim() + "\n";
  }

  // Lip Sync-only: unlike every other path in this node, chunk count here is
  // driven by the real recording's own length, not set by hand — a 60s transcript
  // should produce 4 chunks, a 10s one should produce 1, matching whatever Chunk
  // Size implies. Each line is routed into whichever chunk its own real timestamp
  // falls into (same boundary math as the backend's own chunking), so a 22s line
  // lands correctly in chunk 2 instead of being dropped or squeezed into chunk 1.
  _insertTranscriptAsCuts(entry, charIdx) {
    const segments = entry.transcript_segments || [];
    if (!segments.length) return;

    const transcriptEnd = Math.max(...segments.map((s) => s.end || 0));
    const selectedWindowLength = entry.trimEndSec !== null && entry.trimEndSec !== undefined
      ? Math.max(0.1, Number(entry.trimEndSec) - Number(entry.trimStartSec || 0))
      : null;
    // The selected audio window, not the last detected word, defines the video
    // duration. Instrumental intros/outros often contain no Whisper segments but
    // still need real timeline space and generation chunks.
    const realEnd = selectedWindowLength || entry.transcription_duration_sec || transcriptEnd;
    const durWidget = this.realWidgets.duration_seconds;
    if (durWidget) {
      durWidget.value = Math.ceil(realEnd * 10) / 10;
      if (durWidget.callback) durWidget.callback(durWidget.value);
    }

    this._syncChunkCount();
    const bounds = this._chunkBoundsSeconds();

    // Whisper segments are often whole sung phrases and can straddle a 15s H3
    // boundary. Expand them into per-chunk lyric fragments using Whisper's real
    // word timestamps; otherwise a phrase beginning at 27.8s was clipped to 2.2s
    // at the end of Chunk 2 and its remaining words vanished from Chunk 3.
    const expandedSegments = [];
    for (const seg of segments) {
      const segStart = Number(seg.start || 0);
      const segEnd = Math.max(segStart + 0.05, Number(seg.end || segStart + 0.05));
      const crossedBounds = bounds.filter((b) => segStart < b[1] && segEnd > b[0]);
      if (crossedBounds.length <= 1) {
        expandedSegments.push(seg);
        continue;
      }

      let timedWords = Array.isArray(seg.words) ? seg.words.filter((w) => (w.text || "").trim()) : [];
      if (!timedWords.length) {
        // Backward-compatible fallback for transcripts made before word timings
        // were stored. Re-Transcribe replaces this estimate with exact timings.
        const rawWords = (seg.text || "").trim().split(/\s+/).filter(Boolean);
        const wordDur = (segEnd - segStart) / Math.max(1, rawWords.length);
        timedWords = rawWords.map((text, i) => ({
          text: (i ? " " : "") + text,
          start: segStart + i * wordDur,
          end: segStart + (i + 1) * wordDur,
        }));
      }

      for (const [chunkStart, chunkEnd] of crossedBounds) {
        const wordsHere = timedWords.filter((w) => {
          const wordStart = Number(w.start ?? segStart);
          return wordStart >= chunkStart && wordStart < chunkEnd;
        });
        if (!wordsHere.length) continue;
        const fragmentText = wordsHere.map((w) => w.text || "").join("").trim();
        if (!fragmentText) continue;
        expandedSegments.push({
          start: Math.max(chunkStart, Number(wordsHere[0].start ?? segStart)),
          end: Math.min(chunkEnd, Number(wordsHere[wordsHere.length - 1].end ?? segEnd)),
          text: fragmentText,
          _split_from_transcript: true,
        });
      }
    }

    // Insertion is a rebuild operation, not an append operation. This makes the
    // button safe to press again after correcting a transcription and prevents
    // duplicate lyric CUTs from accumulating.
    for (let chunkIdx = 0; chunkIdx < bounds.length; chunkIdx++) {
      const chunk = this.timeline.chunks[chunkIdx];
      const [chunkStart, chunkEnd] = bounds[chunkIdx];
      const timed = expandedSegments
        .filter((seg) => Number(seg.start || 0) >= chunkStart && Number(seg.start || 0) < chunkEnd)
        .sort((a, b) => Number(a.start || 0) - Number(b.start || 0));
      const rebuilt = [];
      let cursor = chunkStart;

      for (const seg of timed) {
        const text = (seg.text || "").trim();
        if (!text) continue;
        const segStart = Math.max(chunkStart, Number(seg.start || 0));
        const segEnd = Math.min(chunkEnd, Math.max(segStart + 0.05, Number(seg.end || segStart + 0.05)));
        if (segStart > cursor + 0.005) {
          rebuilt.push({ prompt: "", weight: segStart - cursor, _timing_spacer: true });
        }
        rebuilt.push({
          prompt: `"${text}"`,
          weight: Math.max(0.05, segEnd - segStart),
          speakerCharIdxs: [charIdx],
          _transcript_cut: true,
        });
        cursor = Math.max(cursor, segEnd);
      }
      if (cursor < chunkEnd - 0.005) {
        rebuilt.push({ prompt: "", weight: chunkEnd - cursor, _timing_spacer: true });
      }
      // A completely lyric-free chunk still needs one timing spacer so its full
      // duration remains represented while Style alone directs the visuals.
      chunk.segments = rebuilt.length
        ? rebuilt
        : [{ prompt: "", weight: chunkEnd - chunkStart, _timing_spacer: true }];
    }

    let insertedCount = 0;
    for (const seg of segments) {
      const text = (seg.text || "").trim();
      if (!text) continue;
      insertedCount++;
    }

    this.commitChanges();
    this.renderTimeline();
    this.renderReferences();
    if (insertedCount > 0) {
      alert(`Inserted ${insertedCount} line(s) across ${bounds.length} chunk(s), matching the real audio's timing.`);
    }
  }

  _updateAvReadout(readoutEl, entry) {
    const inSec = (entry.trimStartSec || 0).toFixed(2);
    const outSec = entry.trimEndSec !== null && entry.trimEndSec !== undefined ? entry.trimEndSec.toFixed(2) : "end";
    readoutEl.textContent = `In ${inSec}s — Out ${outSec}s`;
  }

  _updateLipSyncWindowReadouts() {
    if (!this.refsArea) return;
    this.refsArea.querySelectorAll(".mmd-lipsync-window-readout").forEach((el) => {
      const idx = Number(el.dataset.refAudioIndex);
      const entry = this.timeline.refAudios?.[idx];
      if (!entry) return;
      const start = Number(entry.trimStartSec || 0).toFixed(2);
      const end = entry.trimEndSec !== null && entry.trimEndSec !== undefined
        ? Number(entry.trimEndSec).toFixed(2) : "end";
      el.textContent = `Uses Ref Audio window: In ${start}s — Out ${end}s`;
    });
  }

  _drawWaveform(canvas, entry) {
    const peaks = entry.waveformPeaks;
    if (!peaks || !peaks.length) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#4F8EF7";
    const barW = w / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const amp = Math.max(1, peaks[i] * h * 0.9);
      ctx.fillRect(i * barW, (h - amp) / 2, Math.max(1, barW - 1), amp);
    }
  }

  _buildSharedAssetToggle(entry) {
    const row = document.createElement("label"); row.className = "mmd-shared-asset-toggle"; row.addEventListener("click", (e) => e.stopPropagation());
    const box = document.createElement("input"); box.type = "checkbox"; box.className = "mmd-box-checkbox"; box.checked = !!entry.shared;
    box.addEventListener("change", () => { entry.shared = box.checked; this.commitChanges(); this.renderTimeline(); });
    const text = document.createElement("span"); text.textContent = "Use in all applicable chunks"; row.append(box, text); return row;
  }
  _buildCharSlot(idx) {
    const data = this.timeline.characters[idx];
    const filled = data && (data.file || data.image_b64);

    const slot = document.createElement("div");
    slot.className = "mmd-char-slot" + (filled ? " mmd-filled" : "");

    const label = document.createElement("div");
    label.className = "mmd-char-label";
    label.textContent = `Ref ${idx + 1}`;
    slot.appendChild(label);

    if (filled) {
      const del = document.createElement("button");
      del.className = "mmd-char-del";
      del.innerHTML = "&times;";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.timeline.characters[idx] = null;
        this.commitChanges();
        this.renderReferences();
        this.renderTimeline();
      });
      slot.appendChild(del);

      const preview = document.createElement("div");
      preview.className = "mmd-char-preview";
      const img = document.createElement("img");
      // See the same comment on the ref video/audio media src above — a dead
      // _blobUrl from a previous page session must never win over the durable
      // uploaded file path once one exists.
      img.src = data.file ? comfyViewUrl(data.file) : (data._blobUrl || data.image_b64);
      preview.appendChild(img);
      slot.appendChild(preview);

      const analyzeBtn = document.createElement("button");
      analyzeBtn.className = "mmd-analyze-btn";
      analyzeBtn.textContent = data.description ? "Re-Analyze" : "Analyze";
      analyzeBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.runAnalysis(data, idx, analyzeBtn, descInput);
      });
      slot.appendChild(analyzeBtn);

      var descInput = document.createElement("textarea");
      descInput.className = "mmd-desc-input";
      descInput.placeholder = "description...";
      descInput.value = data.description || "";
      descInput.addEventListener("click", (e) => e.stopPropagation());
      descInput.addEventListener("input", () => {
        data.description = descInput.value;
        this.commitChanges();
      });
      slot.appendChild(descInput);

      slot.appendChild(this._miniSelectRow(
        "Fit", data.fit || "original", REFERENCE_FIT_OPTIONS,
        (v) => { data.fit = v; },
      ));

      if (this.isReferenceMode() || this.isHybridMode()) {
        slot.appendChild(this._miniSelectRow(
          "Retention", data.retention || "fully_preserved", VISUAL_RETENTION_OPTIONS,
          (v) => { data.retention = v; },
        ));
      }
      if (this.isHybridMode()) slot.appendChild(this._buildSharedAssetToggle(data));
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "mmd-char-placeholder";
      placeholder.innerHTML = `${ICON_UPLOAD}<br>Drop image`;
      slot.appendChild(placeholder);
      slot.addEventListener("click", () => this._promptFilePick(idx));
    }

    slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.style.borderColor = "#4F8EF7"; });
    slot.addEventListener("dragleave", () => { slot.style.borderColor = ""; });
    slot.addEventListener("drop", async (e) => {
      e.preventDefault();
      slot.style.borderColor = "";
      const file = e.dataTransfer.files?.[0];
      if (file) await this._setSlotImage(idx, file);
    });

    return slot;
  }

  _promptFilePick(idx) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      if (input.files?.[0]) await this._setSlotImage(idx, input.files[0]);
    };
    input.click();
  }

  async _setSlotImage(idx, file) {
    // Uploaded (like ref_video/ref_audio), not base64-embedded — a base64 image
    // inline in timeline_data can push a single workflow draft past the browser's
    // localStorage per-entry autosave budget (~750KB), which silently evicts the
    // draft and loses any unsaved edits every time you leave and return to the
    // workflow. A tiny file-path string avoids that entirely.
    try {
      const uploaded = await uploadRefFile(file);
      const existing = this.timeline.characters[idx] || {};
      this.timeline.characters[idx] = {
        ...uploaded, description: "", fit: existing.fit || "original", shared: existing.shared || false, _blobUrl: URL.createObjectURL(file),
      };
      this.commitChanges();
      this.renderReferences();
      this.renderTimeline();
    } catch (err) {
      console.error("[MuseMinimaxDirector] reference image upload failed", err);
      alert("Image upload failed — see console for details.");
    }
  }

  async _resolveImageB64(data) {
    if (data.image_b64) return data.image_b64;
    const src = data.file ? comfyViewUrl(data.file) : data._blobUrl;
    if (!src) throw new Error("No image source available for this reference.");
    return await urlToB64(src);
  }

  _buildAnalyzeSettingsPanel() {
    // [2026-09-06] Always visible now (see the constructor's own "Settings"
    // heading, above References) — no longer toggled by a gear button, so this
    // no longer starts hidden. display gets set to "flex" by the caller.
    const panel = document.createElement("div");
    panel.className = "mmd-gear-panel";
    panel.addEventListener("click", (e) => e.stopPropagation());

    const timelineHeading = document.createElement("div");
    timelineHeading.className = "mmd-gear-hint";
    timelineHeading.style.fontWeight = "700";
    timelineHeading.style.color = "#9a9aae";
    timelineHeading.textContent = "TIMELINE";
    panel.appendChild(timelineHeading);

    const fileBtnRow1 = document.createElement("div");
    fileBtnRow1.style.display = "flex";
    fileBtnRow1.style.gap = "6px";
    const saveBtn = document.createElement("button");
    saveBtn.className = "mmd-analyze-btn";
    saveBtn.style.width = "auto";
    saveBtn.style.flex = "1";
    saveBtn.textContent = "Save Timeline";
    saveBtn.addEventListener("click", () => this.saveTimeline());
    const saveAsBtn = document.createElement("button");
    saveAsBtn.className = "mmd-analyze-btn";
    saveAsBtn.style.width = "auto";
    saveAsBtn.style.flex = "1";
    saveAsBtn.textContent = "Save Timeline As";
    saveAsBtn.addEventListener("click", () => this.saveTimelineAs());
    const loadBtn = document.createElement("button");
    loadBtn.className = "mmd-analyze-btn";
    loadBtn.style.width = "auto";
    loadBtn.style.flex = "1";
    loadBtn.textContent = "Load Timeline";
    loadBtn.addEventListener("click", () => this.loadTimelineFile());
    fileBtnRow1.appendChild(saveBtn);
    fileBtnRow1.appendChild(saveAsBtn);
    fileBtnRow1.appendChild(loadBtn);
    panel.appendChild(fileBtnRow1);

    panel.appendChild(this._miniSelectRow(
      "Display Mode",
      this.timeline.display_mode || "seconds",
      [{ value: "seconds", label: "Seconds" }, { value: "frames", label: "Frames" }],
      (v) => { this.timeline.display_mode = v; this.renderTimeline(); },
    ));

    const filenamesRow = document.createElement("div");
    filenamesRow.className = "mmd-box-row";
    const filenamesLabel = document.createElement("label");
    filenamesLabel.textContent = "Show Filenames";
    filenamesRow.appendChild(filenamesLabel);
    const filenamesCheckbox = document.createElement("input");
    filenamesCheckbox.type = "checkbox";
    filenamesCheckbox.className = "mmd-box-checkbox";
    filenamesCheckbox.checked = this.timeline.show_filenames !== false;
    filenamesCheckbox.addEventListener("change", () => {
      this.timeline.show_filenames = filenamesCheckbox.checked;
      this.commitChanges();
      this.renderReferences();
    });
    filenamesRow.appendChild(filenamesCheckbox);
    panel.appendChild(filenamesRow);

    const analyzeHeading = document.createElement("div");
    analyzeHeading.className = "mmd-gear-hint";
    analyzeHeading.style.fontWeight = "700";
    analyzeHeading.style.color = "#9a9aae";
    analyzeHeading.style.marginTop = "4px";
    analyzeHeading.textContent = "ANALYZE BACKEND";
    panel.appendChild(analyzeHeading);

    const providerOptions = [
      { value: "ollama", label: "Ollama (local)" },
      { value: "lmstudio", label: "LM Studio (local)" },
      { value: "gemini", label: "Gemini / Google" },
      { value: "custom", label: "Custom (OpenAI-compatible)" },
      { value: "off", label: "Off / Manual only" },
    ];

    const providerRow = document.createElement("div");
    providerRow.className = "mmd-box-row";
    const providerLabel = document.createElement("label");
    providerLabel.textContent = "Provider";
    providerRow.appendChild(providerLabel);
    const providerSelect = document.createElement("select");
    providerSelect.className = "mmd-box-select";
    for (const opt of providerOptions) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      providerSelect.appendChild(o);
    }
    providerSelect.value = this.timeline.analyze_provider || "ollama";
    providerSelect.addEventListener("change", () => {
      this.timeline.analyze_provider = providerSelect.value;
      this.commitChanges();
    });
    providerRow.appendChild(providerSelect);
    panel.appendChild(providerRow);

    const urlRow = document.createElement("div");
    urlRow.className = "mmd-box-row";
    const urlLabel = document.createElement("label");
    urlLabel.textContent = "Base URL";
    urlRow.appendChild(urlLabel);
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "mmd-box-number";
    urlInput.style.width = "100%";
    urlInput.placeholder = "blank = provider default";
    urlInput.value = this.timeline.analyze_base_url || "";
    urlInput.addEventListener("change", () => {
      this.timeline.analyze_base_url = urlInput.value.trim();
      this.commitChanges();
    });
    urlRow.appendChild(urlInput);
    panel.appendChild(urlRow);

    const modelRow = document.createElement("div");
    modelRow.className = "mmd-box-row";
    const modelLabel = document.createElement("label");
    modelLabel.textContent = "Model";
    modelRow.appendChild(modelLabel);
    const modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.className = "mmd-box-number";
    modelInput.style.width = "100%";
    modelInput.placeholder = "blank = provider default";
    modelInput.value = this.timeline.analyze_model || "";
    modelInput.addEventListener("change", () => {
      this.timeline.analyze_model = modelInput.value.trim();
      this.commitChanges();
    });
    modelRow.appendChild(modelInput);
    panel.appendChild(modelRow);

    const hint = document.createElement("div");
    hint.className = "mmd-gear-hint";
    hint.textContent = "Controls the Analyze button on every reference slot. Ollama/LM Studio run locally, no API key needed — but small local models follow detailed instructions less reliably than larger hosted ones. Gemini needs GEMINI_API_KEY set as an environment variable before starting ComfyUI. Custom expects an OpenAI-compatible /chat/completions endpoint.";
    panel.appendChild(hint);

    return panel;
  }

  // `data` is the reference entry itself (character or Location), not an index —
  // both callers already have it in hand. `labelIndex` is only cosmetic (feeds
  // the backend's "Analyzing reference N" log line).
  async runAnalysis(data, labelIndex, btn, descInput) {
    if (btn.classList.contains("mmd-loading")) return;
    btn.classList.add("mmd-loading");
    btn.textContent = "Analyzing...";
    try {
      const imageB64 = await this._resolveImageB64(data);
      // Self-contained route owned by this package (no dependency on any other
      // Muse package) — tuned to produce <Subject N>-style sentences directly.
      const resp = await api.fetchApi("/muse_minimax_director_v1_4/analyze_character", {
        method: "POST",
        body: JSON.stringify({
          image_b64: [imageB64],
          char_index: labelIndex,
          provider: this.timeline.analyze_provider || "ollama",
          base_url: this.timeline.analyze_base_url || "",
          model: this.timeline.analyze_model || "",
        }),
      });
      const result = await resp.json();
      if (result.status === "success") {
        data.description = result.description;
        descInput.value = result.description;
        btn.textContent = "Success!";
        this.commitChanges();
        setTimeout(() => { btn.classList.remove("mmd-loading"); btn.textContent = "Re-Analyze"; }, 1200);
      } else {
        alert("Analysis error: " + result.message);
        btn.classList.remove("mmd-loading");
        btn.textContent = "Analyze";
      }
    } catch (err) {
      console.error("[MuseMinimaxDirector] analysis request failed", err);
      alert("Analyze request failed — is ComfyUI running, and is Ollama (or your chosen provider) reachable?");
      btn.classList.remove("mmd-loading");
      btn.textContent = "Analyze";
    }
  }
}

app.registerExtension({
  name: "Muse.MinimaxDirectorV1_4",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "MuseMinimaxDirectorV1_4") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

      // Hide the raw JSON widget, and the native copies of the widgets we re-skin
      // into boxed sections — the DOM editor below is the real UI for all of them.
      for (const w of this.widgets || []) {
        if (HIDDEN_WIDGET_NAMES.includes(w.name) || BOXED_WIDGET_NAMES.includes(w.name)) {
          hideWidget(w);
        }
      }

      this._museMinimaxEditor = new MinimaxTimelineEditor(this);
      const editor = this._museMinimaxEditor;
      // ComfyUI owns the shell's allocated height, never the measured content.
      editor.layoutShell = document.createElement("div");
      editor.layoutShell.style.cssText = "position:relative;width:100%;overflow:hidden;";
      editor.layoutLabel = document.createElement("div");
      editor.layoutLabel.textContent = "Loading Director…";
      editor.layoutLabel.style.cssText = "position:absolute;inset:0;padding:20px;color:#bdbdca;background:#14141a;font:24px sans-serif;";
      editor.container.style.setProperty("height", "auto", "important");
      editor.container.style.setProperty("min-height", "0", "important");
      editor.container.style.flex = "none";
      editor.layoutShell.append(editor.container, editor.layoutLabel);
      this.size = [MMD_DEFAULT_WIDTH, MMD_LOADING_HEIGHT + 70];
      const timelineWidget = this.addDOMWidget("mmd_timeline_ui", "mmd_timeline_ui", editor.layoutShell, {
        serialize: false,
        hideOnZoom: false,
      });
      // Ported from the Combo/TwoStage node's own working dashboard — see
      // _attachAutoResize/_scheduleNodeResize for the real, ResizeObserver-
      // based mechanism that actually keeps the node in sync with its
      // content. This computeSize is only LiteGraph's own fallback query;
      // offsetHeight/scrollHeight (not getBoundingClientRect) since those are
      // layout-box measurements, not subject to the async canvas-transform-
      // attachment delay that caused every earlier attempt here to misread
      // collapsed/transient sizes.
      timelineWidget.computeSize = (width) => {
        // Only return a validated measurement, not a transient allocation.
        return [Math.max(this.size?.[0] || width || MMD_DEFAULT_WIDTH, 560),
          this._museMinimaxEditor?._contentHeight || MMD_LOADING_HEIGHT];
      };
      editor._beginLayout();
      this._museMinimaxEditor._attachAutoResize(timelineWidget);

      return r;
    };

    // onNodeCreated fires before ComfyUI applies a loaded workflow's saved
    // widgets_values onto the widgets — so building the DOM editor's in-memory
    // state there (in onNodeCreated) only ever sees timeline_data's default "{}",
    // never the real saved characters/segments/images. Without this hook, the
    // editor would silently keep showing (and re-saving) that empty default even
    // though the actual saved data was intact in the widget/file the whole time.
    // onConfigure fires after the real widgets_values has been applied, so
    // re-syncing here is what actually picks up the loaded data.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      if (this._museMinimaxEditor) {
        this._museMinimaxEditor._beginLayout();
        this._museMinimaxEditor.timeline = this._museMinimaxEditor._loadState();
        this._museMinimaxEditor.build();
        this._museMinimaxEditor._scheduleNodeResize();
      }
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this._museMinimaxEditor?._disposeLayout();
      return onRemoved?.apply(this, arguments);
    };

    // Some ComfyUI builds recompute a node's dimensions after execution —
    // re-run the real measurement afterward so the UI can't collapse when
    // the queue finishes (ported from the same fix in the Combo node).
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function () {
      const r = onExecuted ? onExecuted.apply(this, arguments) : undefined;
      this._museMinimaxEditor?._scheduleNodeResize();
      return r;
    };
  },
});
