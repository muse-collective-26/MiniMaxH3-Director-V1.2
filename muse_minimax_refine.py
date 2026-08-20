"""
Muse Minimax Refine — a standalone second-pass "hi-res fix" node for MiniMax H3.

Companion to MuseMinimaxDirector V1.2, not a replacement or a modification of it —
this package has no dependency on it. It consumes a real Stage-1 AV LATENT (the
output of MuseMinimaxDirector V1.2's Latent-Only Scouting, candidate_N_latent),
lets you pick one of up to four candidates via the button selector, and continues
its sigma schedule straight from where Stage 1 left off — the same two-stage
sampler sequence (upscale, priming pass, recombine, final DisableNoise pass) the
Director itself runs, just starting from a candidate someone picked instead of
running inline. No VAE round-trip, no img2img-style partial denoise — this is a
genuine schedule continuation, not a from-pixels re-sample.

A picked candidate is either:
  - A single H3-call-length latent (one MuseMinimaxDirector chunk) — refined
    directly, exactly as this node has always worked.
  - A multi-chunk scouting bundle — MuseMinimaxDirector V1.2 saves every chunk's
    own Stage-1 latent to a small scratch folder as it scouts (rather than only
    the last one), and candidate_N_latent carries a marker pointing at it instead
    of a single raw tensor. This node then refines each chunk in turn, re-anchoring
    continuity from the previous chunk's own freshly-refined output the same way
    the Director re-anchors between its own chunks (see _refine_one_chunk), and
    stitches the results into one full-length output before handing anything
    downstream. Falls back to the single-clip path automatically whenever the
    marker isn't present, so nothing about existing single-chunk workflows changes.
"""

import logging
import math
import os
import shutil

import comfy.utils
import torch

from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo, CANVAS_MULTIPLE, align_frame_count
from comfy_execution.graph import ExecutionBlocker

log = logging.getLogger(__name__)


def _two_stage_snap_upscale_target(cur_h_latent: int, cur_w_latent: int, scale_by: float):
    """Target latent H/W for the upscale, snapped to H3's own canvas grid — identical
    logic to the TwoStage Director's own helper of the same name (ported directly from
    the reference "dual sampling" workflow's own upscale node, not re-derived), kept
    here too since this package must work standalone."""
    latent_alignment = max(1, CANVAS_MULTIPLE // 16)

    def floor_aligned(value):
        return max(latent_alignment, (int(value) // latent_alignment) * latent_alignment)

    if cur_w_latent >= cur_h_latent:
        long_in, short_in, long_is_width = cur_w_latent, cur_h_latent, True
    else:
        long_in, short_in, long_is_width = cur_h_latent, cur_w_latent, False

    short_out = floor_aligned(short_in * scale_by)
    short_effective_scale = short_out / short_in if short_in else scale_by
    ideal_long = long_in * short_effective_scale
    long_cap = floor_aligned(long_in * scale_by)

    lower = floor_aligned(ideal_long)
    upper = lower + latent_alignment
    candidates = {c for c in (lower, upper, long_cap) if latent_alignment <= c <= long_cap}
    if not candidates:
        candidates = {max(latent_alignment, long_cap)}
    long_out = min(candidates, key=lambda c: (abs(c - ideal_long), c))

    tgt_w_latent, tgt_h_latent = (long_out, short_out) if long_is_width else (short_out, long_out)
    eff_scale_x = tgt_w_latent / cur_w_latent if cur_w_latent else scale_by
    eff_scale_y = tgt_h_latent / cur_h_latent if cur_h_latent else scale_by
    return tgt_h_latent, tgt_w_latent, eff_scale_x, eff_scale_y


# ── Shared helpers ───────────────────────────────────────────────────────────
# Deliberately duplicated here rather than imported from MuseMinimaxDirector —
# this package has to work standalone for anyone who installs just this node via
# the Registry, without also needing MuseMinimaxDirector installed. Same lesson
# already learned once this project: MuseMinimaxDirector's Analyze route used to
# hard-depend on a sibling package for exactly this reason, and broke for anyone
# who installed it alone.

def _execute_comfy_node(node_class, **kwargs):
    """Invoke a ComfyUI node's main entrypoint, whether it is a comfy_api io.ComfyNode
    (classmethod 'execute') or a legacy node (instance method named by FUNCTION)."""
    if hasattr(node_class, "execute"):
        return node_class.execute(**kwargs)
    fn_name = getattr(node_class, "FUNCTION", None)
    instance = node_class()
    if fn_name and hasattr(instance, fn_name):
        return getattr(instance, fn_name)(**kwargs)
    raise RuntimeError(f"Could not determine how to execute node {node_class!r}")


def _unpack_node_result(out):
    """Normalise a node return (io.NodeOutput, tuple, list or dict) into a tuple of outputs."""
    if out is None:
        return ()
    for attr in ("result", "args", "values", "outputs"):
        if hasattr(out, attr):
            val = getattr(out, attr)
            if callable(val):
                try:
                    val = val()
                except Exception:
                    continue
            if isinstance(val, (tuple, list)):
                return tuple(val)
    if isinstance(out, (tuple, list)):
        return tuple(out)
    if isinstance(out, dict) and isinstance(out.get("result"), (tuple, list)):
        return tuple(out["result"])
    return (out,)


def _fit_image_to_target(tensor: torch.Tensor, target_w: int, target_h: int, method: str) -> torch.Tensor:
    """Resizes an [N,H,W,C] IMAGE tensor to exactly (target_h, target_w) ourselves,
    using one of three standard fit strategies, rather than leaving an aspect-ratio
    mismatch to whatever H3's own internal preprocessing happens to do (observed
    directly: it silently stretches/distorts rather than cropping).
      - crop: scale up to fully cover the target, then center-crop the excess — no
        distortion, no bars, but can crop off the edges of a person/scene on a big
        aspect-ratio swing
      - pad: scale down to fully fit within the target, then pad with black bars —
        never crops anything, but the bars themselves become visible reference content
      - stretch: resize straight to the target dimensions, ignoring aspect ratio"""
    if tensor is None:
        return None
    n, h, w, c = tensor.shape
    if h == target_h and w == target_w:
        return tensor
    chw = tensor.permute(0, 3, 1, 2)
    if method == "stretch":
        resized = torch.nn.functional.interpolate(chw, size=(target_h, target_w), mode="bilinear", align_corners=False)
        return resized.permute(0, 2, 3, 1).clamp(0, 1)
    scale = max(target_w / w, target_h / h) if method == "crop" else min(target_w / w, target_h / h)
    new_w = max(1, round(w * scale))
    new_h = max(1, round(h * scale))
    resized = torch.nn.functional.interpolate(chw, size=(new_h, new_w), mode="bilinear", align_corners=False)
    resized = resized.permute(0, 2, 3, 1).clamp(0, 1)
    if method == "crop":
        top = max(0, (new_h - target_h) // 2)
        left = max(0, (new_w - target_w) // 2)
        return resized[:, top:top + target_h, left:left + target_w, :]
    canvas = torch.zeros((n, target_h, target_w, c), dtype=resized.dtype)
    top = max(0, (target_h - new_h) // 2)
    left = max(0, (target_w - new_w) // 2)
    canvas[:, top:top + new_h, left:left + new_w, :] = resized
    return canvas


def _trim_to_grid(n: int) -> int:
    """H3's video latent only supports frame counts on the 17k+5 grid. A candidate
    that came out of a real single H3 call should already satisfy this, but trim
    defensively the same way MiniMaxH3ReferenceToVideo trims its own ref_videos
    input, rather than erroring on an off-by-a-few count."""
    while n > 5 and n % 17 != 5:
        n -= 1
    return max(5, n)


def _encode_av_latent(vae, audio_vae, frames, audio):
    """Encode real pixels + real waveform into H3's joint NestedTensor AV latent —
    the img2img counterpart to nodes_minimax_h3._empty_av_latent. The audio side
    mirrors MiniMaxH3ReferenceToVideo._encode_ref_audio's own resample-then-encode
    exactly, since that's the only place in H3's own source that encodes real
    (non-empty) audio."""
    import comfy.nested_tensor
    import torchaudio

    n = _trim_to_grid(frames.shape[0])
    video_latent = vae.encode(frames[:n])

    waveform = audio["waveform"]
    sr = audio["sample_rate"]
    vae_sr = getattr(audio_vae, "audio_sample_rate", 32000)
    if sr != vae_sr:
        waveform = torchaudio.functional.resample(waveform, sr, vae_sr)
    audio_latent = audio_vae.encode(waveform[:1].movedim(1, -1))

    return {"samples": comfy.nested_tensor.NestedTensor((video_latent, audio_latent))}, n


def _load_scout_chunk(path):
    # These files are created locally by MuseMinimaxDirector's own Latent-Only
    # Scouting, not accepted from uploads.
    try:
        return torch.load(path, map_location="cpu", weights_only=False)
    except TypeError:  # Compatibility with older PyTorch builds.
        return torch.load(path, map_location="cpu")


def _refine_one_chunk(
    model, clip, vae, audio_vae, chunk_prompt, chunk_latent,
    ref_image_size, seed, steps, two_stage_first_pass_steps,
    sampler_name, scheduler, two_stage_upscale_factor, two_stage_upscale_method,
    ref_images_dict, carry_images, carry_audio, carry_length, log_label,
):
    """Runs exactly the single-chunk Stage 2 pipeline this node has always run
    (upscale, priming pass, recombine, final DisableNoise pass, decode) — the
    only addition is an optional continuity re-anchor right before the final
    pass, when carry_images/carry_audio (the PREVIOUS chunk's own already-
    refined decoded output) are given. This mirrors MuseMinimaxDirector's own
    vae_reencode_carry mechanism exactly (same VAE re-encode + masked-context
    injection, same post-decode trim of the duplicated overlap) rather than a
    simplified version — a multi-chunk stitch built any other way risks
    reintroducing the exact seam that mechanism exists to remove. Called once
    per chunk, in order; with carry_images=None (a single, non-bundled
    candidate) this is byte-for-byte what this node has always done."""
    from nodes import NODE_CLASS_MAPPINGS
    CLIPTextEncode = NODE_CLASS_MAPPINGS["CLIPTextEncode"]
    BasicGuider = NODE_CLASS_MAPPINGS["BasicGuider"]
    KSamplerSelect = NODE_CLASS_MAPPINGS["KSamplerSelect"]
    BasicScheduler = NODE_CLASS_MAPPINGS["BasicScheduler"]
    SamplerCustomAdvanced = NODE_CLASS_MAPPINGS["SamplerCustomAdvanced"]
    SplitSigmas = NODE_CLASS_MAPPINGS["SplitSigmas"]
    DisableNoise = NODE_CLASS_MAPPINGS["DisableNoise"]
    LTXVSeparateAVLatent = NODE_CLASS_MAPPINGS["LTXVSeparateAVLatent"]
    LTXVConcatAVLatent = NODE_CLASS_MAPPINGS["LTXVConcatAVLatent"]
    VAEDecode = NODE_CLASS_MAPPINGS["VAEDecode"]
    VAEDecodeAudio = NODE_CLASS_MAPPINGS["VAEDecodeAudio"]
    VAEEncode = NODE_CLASS_MAPPINGS["VAEEncode"]
    VAEEncodeAudio = NODE_CLASS_MAPPINGS["VAEEncodeAudio"]
    MiniMaxH3GeneratedAVMaskedContext = NODE_CLASS_MAPPINGS.get("MiniMaxH3GeneratedAVMaskedContext")

    video_for_upscale, audio_carry = _unpack_node_result(_execute_comfy_node(
        LTXVSeparateAVLatent, av_latent=chunk_latent,
    ))[:2]

    # The Director's own Stage 2 always sources audio from pass1_raw, not
    # pass1_denoised — but the saved chunk latent only ever carries
    # pass1_denoised (that's what gets decoded for the scouting preview). The
    # Director stashes pass1_raw's audio half under this key on that same
    # dict so this uses the correct source instead of re-deriving audio from
    # the denoised latent above, which was confirmed (real render, missing/
    # wrong dialogue) to be the wrong intermediate representation for it.
    if isinstance(chunk_latent, dict) and "_muse_two_stage_raw_audio" in chunk_latent:
        audio_carry = chunk_latent["_muse_two_stage_raw_audio"]

    video_samples = video_for_upscale["samples"]
    cur_h_latent, cur_w_latent = video_samples.shape[-2], video_samples.shape[-1]
    width, height = cur_w_latent * 16, cur_h_latent * 16

    log.info("[MuseMinimaxRefineV1_2] %s: source %dx%d, seed=%d, steps=%d (first-pass=%d)",
              log_label, width, height, seed, steps, two_stage_first_pass_steps)

    sampler = _unpack_node_result(_execute_comfy_node(KSamplerSelect, sampler_name=sampler_name))[0]

    if ref_images_dict:
        positive = _unpack_node_result(_execute_comfy_node(
            MiniMaxH3ReferenceToVideo, clip=clip, vae=vae, audio_vae=audio_vae, prompt=chunk_prompt,
            width=width, height=height, length=video_samples.shape[2], ref_image_size=ref_image_size,
            ref_images=ref_images_dict,
        ))[0]
    else:
        positive = _unpack_node_result(_execute_comfy_node(CLIPTextEncode, clip=clip, text=chunk_prompt))[0]

    guider = _unpack_node_result(_execute_comfy_node(BasicGuider, model=model, conditioning=positive))[0]
    full_sigmas = _unpack_node_result(_execute_comfy_node(
        BasicScheduler, model=model, scheduler=scheduler, steps=steps, denoise=1.0,
    ))[0]
    split_step = max(1, min(int(two_stage_first_pass_steps), steps - 1))
    _high_sigmas, low_sigmas = _unpack_node_result(_execute_comfy_node(
        SplitSigmas, sigmas=full_sigmas, step=split_step,
    ))[:2]

    tgt_h, tgt_w, eff_x, eff_y = _two_stage_snap_upscale_target(
        cur_h_latent, cur_w_latent, float(two_stage_upscale_factor)
    )
    upscaled_samples = comfy.utils.common_upscale(
        video_samples, tgt_w, tgt_h, two_stage_upscale_method, "disabled",
    )
    upscaled_video = dict(video_for_upscale)
    upscaled_video["samples"] = upscaled_samples
    upscaled_video["noise_mask"] = torch.ones_like(upscaled_samples)
    log.info(
        "[MuseMinimaxRefineV1_2] %s upscale: latent %dx%d -> %dx%d (requested %.2fx, effective %.3fx/%.3fx)",
        log_label, cur_w_latent, cur_h_latent, tgt_w, tgt_h, float(two_stage_upscale_factor), eff_x, eff_y,
    )

    noise1 = _unpack_node_result(_execute_comfy_node(
        NODE_CLASS_MAPPINGS["RandomNoise"], noise_seed=seed,
    ))[0]
    tiny_sigmas = _unpack_node_result(_execute_comfy_node(
        SplitSigmas, sigmas=low_sigmas, step=0,
    ))[0]
    video_primed = _unpack_node_result(_execute_comfy_node(
        SamplerCustomAdvanced, noise=noise1, guider=guider, sampler=sampler,
        sigmas=tiny_sigmas, latent_image=upscaled_video,
    ))[0]

    recombined = _unpack_node_result(_execute_comfy_node(
        LTXVConcatAVLatent, video_latent=video_primed, audio_latent=audio_carry,
    ))[0]

    # Continuity re-anchor — only when this isn't the first chunk of a bundle
    # (carry_images is None for a plain single-chunk candidate, or the first
    # chunk of any bundle). Same VAE re-encode + masked-context injection the
    # Director itself uses between its own chunks, just fed this refine
    # pass's own freshly-upscaled previous chunk instead of a low-res one.
    carry_trim_frames = 0
    if carry_images is not None and carry_images.shape[0] > 0 and MiniMaxH3GeneratedAVMaskedContext is not None:
        carry_n = align_frame_count(min(int(carry_length), int(carry_images.shape[0])))
        tail_pixels = carry_images[-carry_n:]
        tail_video_latent = _unpack_node_result(_execute_comfy_node(
            VAEEncode, pixels=tail_pixels, vae=vae,
        ))[0]
        source_latent = {"samples": tail_video_latent["samples"]}
        if carry_audio is not None and carry_audio["waveform"].shape[-1] > 0:
            carry_sr = carry_audio["sample_rate"]
            carry_samples = min(
                int(round(carry_n / 24.0 * carry_sr)), carry_audio["waveform"].shape[-1],
            )
            tail_waveform = carry_audio["waveform"][..., -carry_samples:]
            tail_audio_latent = _unpack_node_result(_execute_comfy_node(
                VAEEncodeAudio, audio={"waveform": tail_waveform, "sample_rate": carry_sr}, vae=audio_vae,
            ))[0]
            source_latent = {"samples": (tail_video_latent["samples"], tail_audio_latent["samples"])}
        recombined, carry_trim_frames_out = _unpack_node_result(_execute_comfy_node(
            MiniMaxH3GeneratedAVMaskedContext,
            latent=recombined, source_latent=source_latent,
            context_length=carry_n, audio_feather_ticks=8,
        ))[:2]
        carry_trim_frames = int(carry_trim_frames_out)
        log.info("[MuseMinimaxRefineV1_2] %s carry: %d frames re-encoded from the previous refined chunk, "
                  "trim=%d frames", log_label, carry_n, carry_trim_frames)
    elif carry_images is not None and MiniMaxH3GeneratedAVMaskedContext is None:
        log.warning("[MuseMinimaxRefineV1_2] %s: no continuity carry applied — the 'H3 Generated AV Masked "
                    "Context' custom node (ComfyUI-H3-Motion-Context-MultiRef) isn't installed. This chunk's "
                    "seam may not match the rest of the video.", log_label)

    noise2 = _unpack_node_result(_execute_comfy_node(DisableNoise))[0]
    sampled = _unpack_node_result(_execute_comfy_node(
        SamplerCustomAdvanced, noise=noise2, guider=guider, sampler=sampler,
        sigmas=low_sigmas, latent_image=recombined,
    ))[0]

    refined_images = _unpack_node_result(_execute_comfy_node(VAEDecode, samples=sampled, vae=vae))[0]
    refined_audio = _unpack_node_result(_execute_comfy_node(VAEDecodeAudio, samples=sampled, vae=audio_vae))[0]

    if carry_trim_frames > 0 and refined_images.shape[0] > carry_trim_frames:
        refined_images = refined_images[carry_trim_frames:]
        waveform = refined_audio["waveform"]
        audio_trim_samples = round(carry_trim_frames / 24.0 * refined_audio["sample_rate"])
        audio_trim_samples = min(audio_trim_samples, waveform.shape[-1] - 1)
        if audio_trim_samples > 0:
            waveform = waveform[..., audio_trim_samples:]
        refined_audio = {"waveform": waveform, "sample_rate": refined_audio["sample_rate"]}

    return refined_images, refined_audio


class MuseMinimaxRefine:
    """V1.2: consumes a real Stage-1 AV LATENT (not decoded pixels) and runs only
    the two-stage sampler's Stage 2 — upscale, priming pass, final DisableNoise
    pass — directly on it. No VAE round-trip, no img2img-style partial denoise;
    same continuous-latent-schedule continuation as the TwoStage Director itself,
    just starting from a candidate someone picked instead of running inline."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "audio_vae": ("VAE",),
                "prompt": ("STRING", {"default": "", "multiline": True,
                    "tooltip": "Wire this from your director-style node's compiled_prompt output — the "
                               "refine pass reuses the exact prompt the candidate was generated from. Ignored "
                               "for a multi-chunk scouting candidate (MuseMinimaxDirector V1.2's Latent-Only "
                               "Scouting) — each chunk already carries its own saved prompt, used instead."}),
                "candidate": ("INT", {"default": 0, "min": 0, "max": 4,
                    "tooltip": "Which of the four candidate slots to continue. Set by the button selector in "
                               "the node's UI. Defaults to 0 (none picked yet) — the node deliberately refuses "
                               "to run at 0, rather than silently falling back to candidate 1, so a graph "
                               "can't get queued before you've actually chosen one."}),
                "ref_image_size": (["match", "max"], {"default": "match", "tooltip":
                    "Only used when ref_images is connected. 'match' scales references down to the output's "
                    "pixel area (faster). 'max' keeps up to a 2048px short edge for stronger identity "
                    "fidelity, but reference tokens ride every sampling step so it's several times slower."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "tooltip":
                    "Must match the seed the chosen candidate was actually generated with — this continues "
                    "that exact same noise/schedule, not a fresh roll. No randomize control on purpose."}),
                "steps": ("INT", {"default": 8, "min": 1, "max": 100, "tooltip":
                    "Must match the TOTAL steps the candidate's own Stage 1 was generated with — needed to "
                    "reconstruct the same sigma schedule so this picks up exactly where Stage 1 left off."}),
                "two_stage_first_pass_steps": ("INT", {"default": 2, "min": 1, "max": 6, "tooltip":
                    "Must match the First-Pass Steps the candidate's own Stage 1 used — this is where the "
                    "sigma schedule was actually split; getting it wrong means continuing from the wrong point."}),
                "sampler_name": (["res_multistep", "euler", "euler_ancestral", "dpmpp_2m"], {"default": "euler"}),
                "scheduler": (["simple", "normal", "beta", "sgm_uniform"], {"default": "beta"}),
                "two_stage_upscale_factor": ("FLOAT", {"default": 1.5, "min": 1.0, "max": 2.0, "step": 0.05, "tooltip":
                    "How much larger the output renders vs. the candidate's own resolution. The reference "
                    "workflow's own working note calls 1.3-1.5x the stable range."}),
                "two_stage_upscale_method": (["nearest-exact", "bilinear", "area", "bicubic", "bislerp"], {"default": "nearest-exact"}),
            },
            "optional": {
                "candidate_1_latent": ("LATENT",),
                "candidate_2_latent": ("LATENT",),
                "candidate_3_latent": ("LATENT",),
                "candidate_4_latent": ("LATENT",),
                "ref_images": ("IMAGE", {"tooltip":
                    "The same character/product reference photos that anchored identity and fine detail "
                    "(exact prop shape, skin, likeness) in the original candidate — e.g. wired from "
                    "MuseMinimaxDirector's ref_images_used output. Without this, the continuation pass only "
                    "has the text prompt to go on, and any detail the prompt doesn't spell out explicitly is "
                    "free to drift — this is what locks it back down."}),
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO")
    RETURN_NAMES = ("images", "audio")
    FUNCTION = "execute"
    CATEGORY = "Muse Collective"

    def execute(self, model, clip, vae, audio_vae, prompt, candidate,
                ref_image_size, seed, steps, two_stage_first_pass_steps,
                sampler_name, scheduler, two_stage_upscale_factor, two_stage_upscale_method,
                candidate_1_latent=None, candidate_2_latent=None,
                candidate_3_latent=None, candidate_4_latent=None,
                ref_images=None):
        candidates = {
            1: candidate_1_latent, 2: candidate_2_latent,
            3: candidate_3_latent, 4: candidate_4_latent,
        }
        # Not-ready-yet states (no candidate picked, or the picked slot isn't wired)
        # block downstream execution via ExecutionBlocker rather than raising. Passing
        # a message to ExecutionBlocker still fires ComfyUI's own "execution_error"
        # event (a visible red error toast) — confirmed directly from execution.py's
        # execution_block_cb. ExecutionBlocker(None) blocks silently in the UI instead;
        # the log.warning below is the only visible trace, in the console, not a popup.
        if candidate == 0:
            log.warning("[MuseMinimaxRefineV1_2] No candidate selected (candidate=0) — click one of the four "
                        "buttons in the node's UI to pick which candidate to continue. Blocking, not running.")
            blocker = ExecutionBlocker(None)
            return (blocker, blocker)
        chosen_latent = candidates.get(candidate)
        if chosen_latent is None:
            log.warning("[MuseMinimaxRefineV1_2] Candidate slot %d has no latent connected — wire "
                        "candidate_%d_latent, or pick a filled slot. Blocking, not running.",
                        candidate, candidate)
            blocker = ExecutionBlocker(None)
            return (blocker, blocker)

        # Same identity/prop-detail lock the candidate was originally generated with —
        # without this, only the text prompt constrains what this pass can change, and
        # anything the prompt doesn't spell out (exact prop shape, skin detail,
        # likeness) is free to drift toward the model's own generic defaults. Shared by
        # every chunk of a multi-chunk bundle below, same as the original scouting pass
        # used the same reference images for every chunk of the whole timeline.
        ref_images_dict = None
        if ref_images is not None and ref_images.shape[0] > 0:
            ref_images_dict = {f"ref_image_{i}": ref_images[i:i + 1] for i in range(ref_images.shape[0])}
        else:
            log.warning("[MuseMinimaxRefineV1_2] No ref_images connected — continuing from text only. Fine "
                        "detail that was only ever anchored by the original reference photos (exact props, "
                        "skin, likeness) may drift. Wire in the same reference photos the candidate used.")

        # Latent-Only Scouting on a multi-chunk timeline: the candidate isn't a single
        # H3-call-length latent, it's a marker pointing at every chunk MuseMinimaxDirector
        # saved to a scratch folder as it scouted. Refine each chunk in turn, re-anchoring
        # continuity from the PREVIOUS chunk's own already-refined output (see
        # _refine_one_chunk), then stitch the results into one full-length output — same
        # per-chunk continuity mechanism the Director itself uses, just applied here
        # instead of at original generation time.
        bundle = chosen_latent.get("_muse_scout_bundle") if isinstance(chosen_latent, dict) else None
        if bundle:
            bundle_dir = bundle.get("dir")
            chunk_count = int(bundle.get("chunk_count") or 0)
            carry_length = int(bundle.get("carry_length") or 39)
            if not bundle_dir or not os.path.isdir(bundle_dir) or chunk_count < 1:
                log.warning("[MuseMinimaxRefineV1_2] Candidate %d's saved chunk bundle is missing or empty "
                            "(%s) — it may already have been cleaned up by an earlier Refine run on this "
                            "candidate, or ComfyUI's own temp folder was cleared. Re-run Seed Hunt scouting "
                            "to generate a fresh one. Blocking, not running.", candidate, bundle_dir)
                blocker = ExecutionBlocker(None)
                return (blocker, blocker)

            all_images = []
            all_waveform = []
            audio_sample_rate = None
            carry_images = None
            carry_audio = None
            for chunk_idx in range(chunk_count):
                chunk_path = os.path.join(bundle_dir, f"chunk_{chunk_idx + 1:04d}.pt")
                if not os.path.isfile(chunk_path):
                    log.warning("[MuseMinimaxRefineV1_2] Chunk %d/%d is missing from candidate %d's saved "
                                "bundle (%s) — stopping here rather than silently returning a partial video.",
                                chunk_idx + 1, chunk_count, candidate, chunk_path)
                    blocker = ExecutionBlocker(None)
                    return (blocker, blocker)
                saved = _load_scout_chunk(chunk_path)
                chunk_images, chunk_audio = _refine_one_chunk(
                    model, clip, vae, audio_vae, saved["prompt"], saved["latent"],
                    ref_image_size, seed, steps, two_stage_first_pass_steps,
                    sampler_name, scheduler, two_stage_upscale_factor, two_stage_upscale_method,
                    ref_images_dict, carry_images, carry_audio, carry_length,
                    log_label=f"candidate={candidate} chunk={chunk_idx + 1}/{chunk_count}",
                )
                all_images.append(chunk_images)
                all_waveform.append(chunk_audio["waveform"])
                audio_sample_rate = chunk_audio["sample_rate"]
                carry_images = chunk_images
                carry_audio = chunk_audio

            shutil.rmtree(bundle_dir, ignore_errors=True)

            refined_images = torch.cat(all_images, dim=0) if len(all_images) > 1 else all_images[0]
            refined_audio = {
                "waveform": torch.cat(all_waveform, dim=-1) if len(all_waveform) > 1 else all_waveform[0],
                "sample_rate": audio_sample_rate,
            }
            log.info("[MuseMinimaxRefineV1_2] candidate=%d: %d chunk(s) refined and stitched into one "
                      "%d-frame output.", candidate, chunk_count, refined_images.shape[0])
            return (refined_images, refined_audio)

        # Plain single-chunk candidate — exactly what this node has always done,
        # just routed through the same per-chunk function the bundle path above uses.
        refined_images, refined_audio = _refine_one_chunk(
            model, clip, vae, audio_vae, prompt, chosen_latent,
            ref_image_size, seed, steps, two_stage_first_pass_steps,
            sampler_name, scheduler, two_stage_upscale_factor, two_stage_upscale_method,
            ref_images_dict, None, None, 0,
            log_label=f"candidate={candidate}",
        )
        return (refined_images, refined_audio)


NODE_CLASS_MAPPINGS = {
    "MuseMinimaxRefineV1_2": MuseMinimaxRefine,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MuseMinimaxRefineV1_2": "Muse Minimax Refine V1.2 (Latent, Two-Stage)",
}
