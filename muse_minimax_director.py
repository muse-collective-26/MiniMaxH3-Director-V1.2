"""
Muse Minimax Director — an all-in-one timeline-driven Director node for MiniMax H3,
matching MuseDirectorSamplerV10Final's own philosophy: take the real models as inputs
(so they stay fully swappable upstream — this node never loads a checkpoint itself),
run the whole pipeline internally, hand back ready-to-use frames + audio. Outputs raw
IMAGE + AUDIO (not the newer VIDEO type) so it wires straight into a standard Video
Combine node, same as the rest of this project's other Director workflows.

Internally this chains exactly the nodes the official H3 reference template uses,
verified against the real source (comfy_extras/nodes_minimax_h3.py) rather than
guessed: conditioning via MiniMaxH3ReferenceToVideo or MiniMaxH3ImageToVideo depending
on mode, MiniMaxH3SigmaShift on the model, RandomNoise -> BasicGuider -> KSamplerSelect
-> BasicScheduler -> SamplerCustomAdvanced -> VAEDecode + VAEDecodeAudio.

Two real, confirmed facts worth being explicit about:
  - There is no negative/CFG conditioning anywhere in H3's own reference pipeline — it
    uses BasicGuider, which only ever takes one conditioning input. That's not a gap
    in this node, it's how the model is actually set up to run.
  - Both conditioning nodes build a joint audio+video latent internally regardless of
    mode, so audio_vae is required for final decode in both Reference and First/Last
    Frame mode, even though First/Last Frame mode never encodes reference audio.

Resolution matches the real ResolutionSelector node exactly (aspect_ratio x megapixels,
rounded to `multiple`) rather than a fixed table, since H3 documents six real supported
aspect ratios, not just 16:9.

CHUNKING: H3 is only trained/reliable up to ~15s per call (its own node source flags
longer as untested). Same situation the LTX Director's own chunking system existed to
solve — that was never native to LTX either, it was Muse's own orchestration on top.
Ported here the same way: split the requested total duration into chunk_duration_seconds
pieces (the final chunk absorbs whatever's left over, so it may be shorter — chunks are
NOT evenly redistributed, so a 10s chunk size actually gives 10s chunks, not some other
number), run one real H3 call per chunk, and carry continuity from chunk to chunk.

In Reference mode, continuity is two-pronged, both confirmed against the real
MiniMaxH3ReferenceToVideo node source rather than assumed:
  - Video: `ref_videos` accepts up to 3 reference *clips*, not just a still frame, so
    continuation chunks feed the previous chunk's own output back in as a reference
    video (slot 0, reserved) alongside any character/background images.
  - Audio: the previous chunk's own decoded audio (last ~4s) is fed back in too, via
    `ref_audios` slot 0 — otherwise each chunk invents its own score/ambience from
    scratch with zero awareness of what the previous chunk sounded like, producing an
    audible hard reset between chunks (observed directly in an early test render).
Both carried-over references get an explicit instruction appended to the prompt telling
the model to continue seamlessly (no cut, no new piece of music) rather than treating
the carry-over clips as just more generic reference material — a bare reference without
that instruction doesn't reliably read as "keep going from here" on its own.

First/Last Frame mode doesn't have a reference-clip mechanism at all, so its
continuation falls back to the previous chunk's last decoded frame as the next chunk's
first_frame, same idea as LTX's carry-frame (no equivalent audio carry-over exists for
this mode either — that model variant never encodes reference audio at all).

CUT blocks in the timeline are a prompt-authoring convenience (H3 has no chunk concept
in its own single-call architecture) — but they now double as the chunk-bucketing input:
each CUT's proportional position along the total duration decides which real chunk call
it gets compiled into, based on its own start time crossing a chunk boundary.
"""

import base64
import io as _io
import json
import logging
import math
import gc
import os
import re
import tempfile

import av
import comfy.utils
import folder_paths
import numpy as np
import torch
from PIL import Image
from aiohttp import web
from server import PromptServer

from comfy_extras.nodes_minimax_h3 import (
    MiniMaxH3ReferenceToVideo, MiniMaxH3ImageToVideo, MiniMaxH3SigmaShift, align_frame_count,
    CANVAS_MULTIPLE,
)
from comfy_extras.nodes_resolution import AspectRatio, ASPECT_RATIOS
from comfy_execution.graph import ExecutionBlocker

log = logging.getLogger(__name__)


# ── Character-analysis backend route ────────────────────────────────────────
# Self-contained (no dependency on any other Muse package) so Analyze works for
# anyone who installs just this repo. Tuned specifically for MiniMax H3's
# <Subject N> sentence format: a short identity noun phrase, a comma, then a
# detail clause of distinguishing features — matching the official guide's own
# "<Subject N> is the young woman in <Picture N>, with long dark hair..." style
# directly, rather than a generic caption that then has to be reshaped.

_MUSE_MINIMAX_PROVIDER_DEFAULTS = {
    "ollama": {"url": "http://127.0.0.1:11434", "model": "huihui_ai/qwen3.5-abliterated:2b"},
    "lmstudio": {"url": "http://127.0.0.1:1234", "model": ""},
    "custom": {"url": "", "model": ""},
    "gemini": {"url": "https://generativelanguage.googleapis.com/v1beta/openai", "model": "gemini-2.5-flash"},
}

_MUSE_MINIMAX_ANALYZE_PROMPT = (
    "Look at the image and write exactly one sentence describing it, in the form: a short "
    "identity noun phrase, then a comma, then a detail clause of distinguishing features.\n\n"
    "If the image shows the same subject repeated across a grid or multiple panels — a "
    "character turnaround/reference sheet with several poses, angles, or close-ups of one "
    "person — describe that ONE subject as a single coherent person, based on what's "
    "consistent across every panel.\n\n"
    "Describe only the subject itself — never the background, backdrop, studio setting, "
    "location, or how they are posed or positioned in the photo. This applies to every image, "
    "not just grids: a plain white backdrop, a bedroom, a street, a specific pose or camera "
    "angle are all part of how this particular reference photo happens to be taken, not part of "
    "the subject's own appearance, and must never appear in the description — regardless of "
    "whether the subject is clothed or nude.\n\n"
    "If the main subject is a person/character, the identity phrase should be something like "
    "'the young woman' or 'the man with the beard', and the detail clause should cover, "
    "concisely: hair (color, length, style), skin tone if distinctive, build, and — if clothed "
    "— everything they're wearing from head to toe: top, bottom, footwear, and any accessories "
    "such as jewelry, hats, bags, or glasses. If the subject is nude, say so plainly as part of "
    "the detail clause instead of describing clothing. Only include what's actually visible; "
    "skip any category that isn't shown (e.g. no visible footwear) rather than guessing or "
    "inventing one. If the main subject IS a place or setting — the image itself is a "
    "background/location reference, not a person or object photographed in front of one — the "
    "identity phrase should be something like 'the coffee-shop environment' or 'the rooftop at "
    "night', and the detail clause should cover the distinctive fixtures, colors, and lighting. "
    "If it's an object, the identity phrase should name it, and the detail clause should cover "
    "its shape, color, material, and distinctive details. Do not start with 'a photo of' or "
    "similar. Do not state which category you chose. Output only the single sentence, nothing "
    "else."
)


def _muse_minimax_resolve_provider(data):
    provider = (data.get("provider") or "ollama").lower()
    defs = _MUSE_MINIMAX_PROVIDER_DEFAULTS.get(provider, _MUSE_MINIMAX_PROVIDER_DEFAULTS["ollama"])
    base_url = (data.get("base_url") or defs["url"]).rstrip("/")
    model = data.get("model") or defs["model"]
    return provider, base_url, model


# Shared by the per-image Analyze route and the Prompt Gen (generate_scene_prompt)
# route below — one HTTP-calling implementation per provider, not two copies that
# could quietly drift apart.
async def _muse_minimax_call_vlm(provider, base_url, model_name, system_prompt, image_b64_list):
    """Returns (ok: bool, text_or_error: str)."""
    import aiohttp

    cleaned_b64_list = []
    for b64 in (image_b64_list or []):
        if "," in b64:
            b64 = b64.split(",", 1)[1]
        cleaned_b64_list.append(b64)

    if provider in ("lmstudio", "custom") and not model_name:
        return False, f"No model name set for {provider}. Enter your loaded model's name."

    try:
        async with aiohttp.ClientSession() as session:
            if provider == "ollama":
                payload = {
                    "model": model_name, "prompt": system_prompt,
                    "images": cleaned_b64_list, "stream": False, "keep_alive": 0,
                }
                async with session.post(f"{base_url}/api/generate", json=payload, timeout=120) as response:
                    if response.status != 200:
                        err_txt = await response.text()
                        return False, f"Ollama HTTP {response.status}: {err_txt}"
                    resp_json = await response.json()
                    generated_text = (resp_json.get("response") or "").strip()
            elif provider == "gemini":
                api_key = os.environ.get("GEMINI_API_KEY")
                if not api_key:
                    return False, "GEMINI_API_KEY environment variable is not set. Set it and restart ComfyUI."
                content = [{"type": "text", "text": system_prompt}]
                for b64 in cleaned_b64_list:
                    content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
                payload = {
                    "model": model_name,
                    "messages": [{"role": "user", "content": content}],
                    # Gemini 2.5 models "think" by default, and in this OpenAI-compatible
                    # endpoint those thinking tokens count against max_tokens along with the
                    # visible output — reasoning_effort: none turns that off (this is a
                    # structured format-following task, not one that benefits from chain of
                    # thought), and a bigger budget than before leaves real headroom either way.
                    "max_tokens": 4096, "stream": False, "reasoning_effort": "none",
                }
                headers = {"Authorization": f"Bearer {api_key}"}
                async with session.post(f"{base_url}/chat/completions", json=payload, headers=headers, timeout=120) as response:
                    if response.status != 200:
                        err_txt = await response.text()
                        return False, f"Gemini HTTP {response.status}: {err_txt}"
                    resp_json = await response.json()
                    try:
                        msg = resp_json["choices"][0]["message"]
                        generated_text = (msg.get("content") or "").strip()
                    except (KeyError, IndexError, TypeError):
                        return False, "Unexpected response shape from Gemini."
            else:
                content = [{"type": "text", "text": system_prompt}]
                for b64 in cleaned_b64_list:
                    content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
                payload = {
                    "model": model_name,
                    "messages": [{"role": "user", "content": content}],
                    "max_tokens": 4096, "stream": False,
                }
                async with session.post(f"{base_url}/v1/chat/completions", json=payload, timeout=120) as response:
                    if response.status != 200:
                        err_txt = await response.text()
                        return False, f"{provider} HTTP {response.status}: {err_txt}"
                    resp_json = await response.json()
                    try:
                        msg = resp_json["choices"][0]["message"]
                        generated_text = (msg.get("content") or "").strip()
                        if not generated_text:
                            generated_text = (msg.get("reasoning_content") or "").strip()
                    except (KeyError, IndexError, TypeError):
                        return False, f"Unexpected response shape from {provider}."
    except aiohttp.ClientConnectorError:
        return False, f"Could not connect to {provider} at {base_url}. Make sure the server is running and reachable."

    if "<think>" in generated_text:
        generated_text = generated_text.split("</think>")[-1].strip()
    return True, generated_text


@PromptServer.instance.routes.post("/muse_minimax_director_v1_2/analyze_character")
async def muse_minimax_analyze_character_endpoint(request):
    try:
        data = await request.json()
        image_b64 = data.get("image_b64", "")
        char_index = int(data.get("char_index", 0))
        provider, base_url, model_name = _muse_minimax_resolve_provider(data)

        if provider == "off":
            return web.json_response({"status": "error", "message": "Analyze is set to Off / Manual."})
        if not image_b64:
            return web.json_response({"status": "error", "message": "No image provided for analysis."})

        b64_list = image_b64 if isinstance(image_b64, list) else [image_b64]

        log.info("[MuseMinimaxDirector] Analyzing reference %d via %s (%s, model '%s')...",
                 char_index + 1, provider, base_url, model_name)

        ok, result = await _muse_minimax_call_vlm(provider, base_url, model_name, _MUSE_MINIMAX_ANALYZE_PROMPT, b64_list)
        if not ok:
            return web.json_response({"status": "error", "message": result})

        log.info("[MuseMinimaxDirector] Reference analysis complete: %s", result)
        return web.json_response({"status": "success", "description": result})

    except Exception as e:
        log.error("[MuseMinimaxDirector] Failed to analyze reference: %s", e)
        return web.json_response({"status": "error", "message": str(e)}, status=500)

MODE_REFERENCE = "Reference (Omni) — up to 9 images, 3 videos, 3 audio"
MODE_FIRST_LAST = "First/Last Frame — zero, one, or two frame images"

# Chunk-to-chunk continuity only — see the assignment site for why. The stock
# MiniMaxH3ReferenceToVideo node silently truncates an oversized ref_video down
# to its FIRST frame_count frames (comfy_extras/nodes_minimax_h3.py), not the
# last — confirmed directly from its source. Feeding it a full previous chunk
# (which can easily run longer than the next chunk's own target length) meant
# the actual ending of that chunk — the one moment that matters for continuity —
# was getting silently discarded in favor of its beginning. 48 frames (2s) stays
# comfortably inside the node's own documented 2-15s valid range for a
# ref_video, and comfortably under the shortest possible chunk (3s/72 frames),
# so this trim is always what actually gets used — nothing is left to the
# node's own truncation behavior. Same "concentrate on the recent transition"
# principle already proven out as carry_frames in the LTX Director family,
# ported onto the reference-video mechanism H3 actually has.
_CHUNK_CONTINUITY_REF_FRAMES = 48

# H3's own video_latent_t() (comfy_extras/nodes_minimax_h3.py) processes video in a
# special first 5-frame block, then 17-frame blocks after that — and the module's own
# docstring confirms the injected keyframe/reference latent is "re-injected every step
# (never denoised)" over that structure. A continuation chunk's first 5+17=22 frames are
# still substantially shaped by that raw injection rather than the model's own
# free-running generation, producing a visible transient discontinuity right after the
# anchor — confirmed directly: a chunk boundary's true last frame and the new chunk's
# frame ~22 match again, while every frame in between visibly doesn't.
_KEYFRAME_INJECTION_FRAMES = 22

MAX_CHARACTER_SLOTS = 9
ASPECT_RATIO_OPTIONS = [a.value for a in AspectRatio]
# Spacing between Seed Hunt's 4 candidate passes' base seeds — large enough to never
# collide with the small per-chunk `+chunk_idx` offset already applied inside a pass.
SEED_HUNT_SEED_STRIDE = 1_000_003


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


def _resolve_resolution(aspect_ratio: str, megapixels: float, multiple: int):
    """Exact port of the stock ResolutionSelector node's own formula."""
    w_ratio, h_ratio = ASPECT_RATIOS[AspectRatio(aspect_ratio)]
    total_pixels = megapixels * 1024 * 1024
    scale = math.sqrt(total_pixels / (w_ratio * h_ratio))
    width = round(w_ratio * scale / multiple) * multiple
    height = round(h_ratio * scale / multiple) * multiple
    return width, height


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
      - stretch: resize straight to the target dimensions, ignoring aspect ratio —
        matches H3's own old implicit behavior, now done deterministically by us
    Used for character/background reference images and First/Last Frame's locked
    frame images — not reference videos, which H3 handles with its own separate
    ref_image_size resolution logic."""
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


def _load_image_source(b64_or_url: str, filename: str = "") -> torch.Tensor:
    if not b64_or_url:
        return None
    try:
        b64_str = b64_or_url
        if "," in b64_str:
            b64_str = b64_str.split(",", 1)[1]
        img_bytes = base64.b64decode(b64_str)
        img = Image.open(_io.BytesIO(img_bytes)).convert("RGB")
        arr = np.array(img, dtype=np.float32) / 255.0
        return torch.from_numpy(arr).unsqueeze(0)
    except Exception as e:
        log.warning("[MuseMinimaxDirector] Could not decode reference image %s: %s", filename, e)
        return None


def _load_character_image(entry: dict):
    """Character/background reference images upload through the same mechanism as
    ref_video/ref_audio (a small file-path string in timeline_data), not embedded
    base64 — embedding full images inline blew past the browser's per-entry workflow
    draft-autosave budget (~750KB in the wild), silently losing unsaved edits every
    time the workflow was left and returned to. Falls back to legacy inline base64
    for character cards saved before this change."""
    if entry.get("file"):
        file_path = _resolve_path(entry["file"])
        if not file_path or not os.path.exists(file_path):
            log.warning("[MuseMinimaxDirector] Reference image not found: %s", entry.get("name", entry.get("file", "")))
            return None
        try:
            img = Image.open(file_path).convert("RGB")
            arr = np.array(img, dtype=np.float32) / 255.0
            return torch.from_numpy(arr).unsqueeze(0)
        except Exception as e:
            log.warning("[MuseMinimaxDirector] Could not load reference image %s: %s", entry.get("name", ""), e)
            return None
    if entry.get("image_b64"):
        return _load_image_source(entry["image_b64"], entry.get("name", ""))
    return None


def _parse_timeline(timeline_data: str) -> dict:
    try:
        data = json.loads(timeline_data) if timeline_data and timeline_data.strip() else {}
    except Exception as e:
        log.warning("[MuseMinimaxDirector] Could not parse timeline_data: %s", e)
        data = {}
    data.setdefault("characters", [])
    data.setdefault("chunks", [])
    data.setdefault("background", None)
    data.setdefault("refVideos", [])
    data.setdefault("refAudios", [])
    return data


def _resolve_path(rel: str) -> str:
    """Reference video/audio clips are uploaded through ComfyUI's own /upload/image
    endpoint (works for any file type despite the name) into the input dir, same
    mechanism LTX Director's audio/video tracks already use — so the same multi-base
    fallback lookup applies here."""
    if not rel:
        return ""
    input_dir = folder_paths.get_input_directory()
    for base in (input_dir, os.path.join(input_dir, "musedirector"), os.path.join(input_dir, "muse")):
        p = os.path.join(base, os.path.basename(rel))
        if os.path.exists(p):
            return p
    p = os.path.join(input_dir, rel)
    return p if os.path.exists(p) else ""


def _load_ref_video_tensor(entry: dict, max_frames: int = 200):
    """Decodes the [trimStartSec, trimEndSec) window of an uploaded reference video
    clip into an IMAGE tensor of frames, for H3's ref_videos input."""
    file_path = _resolve_path(entry.get("file", ""))
    if not file_path or not os.path.exists(file_path):
        log.warning("[MuseMinimaxDirector] Reference video not found: %s", entry.get("fileName", entry.get("file", "")))
        return None
    start_sec = float(entry.get("trimStartSec", 0) or 0)
    end_sec = entry.get("trimEndSec")
    frames = []
    try:
        with av.open(file_path) as container:
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            if stream.time_base:
                seek_pts = int(max(0, start_sec - 0.5) / float(stream.time_base))
            else:
                seek_pts = int(max(0, start_sec - 0.5) * av.time_base)
            container.seek(seek_pts, stream=stream, backward=True)
            for frame in container.decode(stream):
                frame_time = frame.time
                if frame_time is None and frame.pts is not None and stream.time_base:
                    frame_time = float(frame.pts * stream.time_base)
                if frame_time is None:
                    frame_time = 0.0
                if frame_time < start_sec - 0.01:
                    continue
                if end_sec is not None and frame_time > float(end_sec):
                    break
                frames.append(frame.to_ndarray(format="rgb24"))
                if len(frames) >= max_frames:
                    break
    except Exception as exc:
        log.warning("[MuseMinimaxDirector] Reference video decode error (%s): %s", entry.get("fileName", ""), exc)
        return None
    if not frames:
        return None
    frames_np = np.array(frames, dtype=np.float32) / 255.0
    return torch.from_numpy(frames_np)


def _load_ref_audio_clip(entry: dict, target_sr: int = 44100):
    """Decodes the [trimStartSec, trimEndSec) window of an uploaded reference audio
    clip into an AUDIO dict, for H3's ref_audios input."""
    file_path = _resolve_path(entry.get("file", ""))
    if not file_path or not os.path.exists(file_path):
        log.warning("[MuseMinimaxDirector] Reference audio not found: %s", entry.get("fileName", entry.get("file", "")))
        return None
    start_sec = float(entry.get("trimStartSec", 0) or 0)
    end_sec = entry.get("trimEndSec")
    try:
        clip_frames = []
        with av.open(file_path) as container:
            if not container.streams.audio:
                return None
            stream = container.streams.audio[0]
            resampler = av.AudioResampler(format="fltp", layout="stereo", rate=target_sr)
            for frame in container.decode(stream):
                for rf in resampler.resample(frame):
                    clip_frames.append(torch.from_numpy(rf.to_ndarray()))
            for rf in resampler.resample(None):
                clip_frames.append(torch.from_numpy(rf.to_ndarray()))
        if not clip_frames:
            return None
        waveform = torch.cat(clip_frames, dim=1)  # [2, samples]
        start_sample = max(0, min(int(start_sec * target_sr), waveform.shape[1]))
        end_sample = waveform.shape[1] if end_sec is None else max(start_sample, min(int(float(end_sec) * target_sr), waveform.shape[1]))
        trimmed = waveform[:, start_sample:end_sample]
        if trimmed.shape[1] == 0:
            return None
        return {"waveform": trimmed.unsqueeze(0), "sample_rate": target_sr}
    except Exception as exc:
        log.warning("[MuseMinimaxDirector] Reference audio decode error (%s): %s", entry.get("fileName", ""), exc)
        return None


def _build_character_subjects(tdata: dict, target_w: int, target_h: int, resize_method: str):
    """Character reference images become both H3's ref_images (dense fill-order
    Picture tags, same rule as before — MiniMaxH3ReferenceToVideo assigns <Picture N>
    purely by iteration order over ref_images.values(), confirmed from its own
    source) AND <Subject N> definitions citing them. Per MiniMax's own reference-mode
    prompt guide, an image used only to define a character's appearance should NOT
    get its own standalone <Picture N> entry in the prompt — it belongs inside a
    <Subject N> definition instead ("cite the image source inside the corresponding
    <Subject N> definition"). Background is handled separately per-chunk in execute()
    (its slot gets replaced by a continuity-anchor Picture on continuation chunks),
    so it isn't part of this function.

    Returns (ref_images, subject_lines, retention_meta, subject_number_by_char_index).
    subject_number_by_char_index maps a raw characters[] index -> its assigned
    <Subject N> number, used to resolve which subject a CUT's speakerCharIdx refers
    to for (Sx) speaker tagging. retention_meta is (subject_n, picture_n, retention)
    tuples rather than pre-formatted text — the per-chunk loop fills in an accurate
    "(present throughout)" vs "(appears in [Shot N], ...)" presence clause once it
    knows which shots each subject's tag actually appears in for that chunk (a
    character introduced only from Shot 2 onward must not be asserted as present
    throughout the whole chunk). target_w/target_h/resize_method fit every loaded
    image to the output resolution ourselves via _fit_image_to_target, rather than
    leaving aspect-mismatched references to whatever H3 does with them internally."""
    characters = tdata.get("characters", [])[:MAX_CHARACTER_SLOTS]

    ref_images = {}
    subject_lines = []
    retention_meta = []
    subject_number_by_char_index = {}

    for idx, ch in enumerate(characters):
        if not ch or not (ch.get("file") or ch.get("image_b64")):
            continue
        tensor = _load_character_image(ch)
        if tensor is None:
            continue
        tensor = _fit_image_to_target(tensor, target_w, target_h, resize_method)
        slot = len(ref_images)
        ref_images[f"ref_image_{slot}"] = tensor
        picture_n = slot + 1
        subject_n = len(subject_lines) + 1
        subject_number_by_char_index[idx] = subject_n
        desc = (ch.get("description") or "").strip()
        if desc:
            subject_lines.append(f"<Subject {subject_n}> is {desc} (from `<Picture {picture_n}>`).")
        else:
            subject_lines.append(f"<Subject {subject_n}> is the subject shown in `<Picture {picture_n}>`.")
        retention = ch.get("retention") or "fully_preserved"
        retention_meta.append((subject_n, picture_n, retention))

    return ref_images, subject_lines, retention_meta, subject_number_by_char_index


def _build_keyframe_alignment_line(has_first: bool, has_last: bool, last_shot_num: int, chunk_duration: float) -> str:
    """Per MiniMax's own base-mode (T2VA/I2VA/FL2VA/L2VA) prompt guide: an opening
    sentence describing how the <Picture N> keyframe(s) actually align with the
    target video, exact phrasing per mode. T2VA (neither keyframe present) has no
    such line at all — the guide says it "begins directly with core fields."
    <Picture N> numbering here always follows the same order the real
    MiniMaxH3ImageToVideo node appends images in (first_frame, then last_frame),
    so this must be called with has_first/has_last reflecting that exact pairing,
    not a fixed slot assumption — matches the same "dense fill order, not fixed
    index" rule already used for every other tag-numbering path in this file."""
    end_ts = _format_timestamp(chunk_duration)
    if has_first and has_last:
        return (
            f"How the reference pictures align with the target video — `<Picture 1>` "
            f"(from [Shot 1]) aligns with the 0.00-second mark; `<Picture 2>` "
            f"(from [Shot {last_shot_num}]) aligns with the {end_ts} mark."
        )
    if has_first:
        return (
            f"For the target video, at 0.00 seconds into the target video, `<Picture 1>` "
            f"(from [Shot 1]) is fully referenced."
        )
    if has_last:
        return (
            f"How the reference pictures align with the target video — `<Picture 1>` "
            f"(from [Shot {last_shot_num}]) aligns with the {end_ts} mark."
        )
    return ""


def _build_base_mode_shot_lines(chunk_segments: list, chunk_start_sec: float, dialogue_language: str) -> tuple:
    """Shot lines for base mode's integrated_multimodal_description section. Base
    mode has no <Subject N> abstraction at all (no reference-image/character
    system — only the two keyframe images), so unlike Reference mode there's no
    tag to attach a (Sx) speaker id to. Per the guide's own "assigned by vocal
    event order" rule, (Sx) is instead numbered by first appearance among CUTs
    with exactly one speaker selected, and appended directly after that CUT's own
    wrapped dialogue. Returns (shot_lines, last_shot_num)."""
    shot_lines = []
    shot_idx = 0
    speaker_assign = {}
    for seg in chunk_segments:
        text = (seg.get("prompt") or "").strip()
        if not text:
            continue
        shot_idx += 1
        speaker_idxs = _seg_speaker_indices(seg)
        s_n = None
        if len(speaker_idxs) == 1:
            char_idx = speaker_idxs[0]
            s_n = speaker_assign.setdefault(char_idx, len(speaker_assign) + 1)
        text = _wrap_dialogue(text, dialogue_language)
        if s_n and "<d>" in text:
            text = text.rstrip() + f" (S{s_n})"
        if shot_idx == 1:
            shot_lines.append(f"[Shot 1] {text}")
        else:
            start_in_chunk = max(0.0, seg.get("_abs_start", 0.0) - chunk_start_sec)
            shot_lines.append(f"[Shot {shot_idx}] At {_format_timestamp(start_in_chunk)}, {text}")
    return shot_lines, shot_idx


def _assemble_base_mode_prompt(keyframe_line: str, style_line: str, shot_lines: list,
                                soundscape_text: str, music_text: str) -> str:
    """Assembles MiniMax's own three required sections for a single H3 base-mode
    (T2VA/I2VA/FL2VA/L2VA) generation call: integrated_multimodal_description,
    overall_soundscape, non_diegetic_music. keyframe_line is the guide's own
    per-mode Picture-alignment opening sentence — empty for T2VA, which "begins
    directly with core fields" per the guide, so no placeholder line is emitted."""
    desc_lines = ([keyframe_line] if keyframe_line else []) + ([style_line] if style_line else []) + shot_lines
    parts = []
    if desc_lines:
        parts.append("integrated_multimodal_description:\n" + "\n".join(desc_lines))
    parts.append("overall_soundscape:\n" + (soundscape_text.strip() if soundscape_text else "N/A"))
    parts.append("non_diegetic_music:\n" + (music_text.strip() if music_text else "N/A"))
    return "\n\n".join(parts)


_DIALOGUE_RE = re.compile(r'"([^"]*)"')
_REPEATED_PUNCT_RE = re.compile(r'([.!?,])\1+')
_DECORATIVE_RE = re.compile(r'[~]{2,}|[*_#]+')


def _collapse_repeated_punct(m: "re.Match") -> str:
    """A run of 3 literal periods is a real ellipsis ("...got it.") — a
    meaningful pause, not decorative repeated punctuation like "!!!" or "??".
    Collapsing it to a single "." (the old behavior) silently ate the pause
    out of real dialogue (confirmed directly: "...got it." compiled as
    ".got it." in a real render). Keep exactly "..." for any run of 3+
    periods; still collapse everything else (!!!, ??, ,,, .. ) to one char,
    same as before."""
    ch = m.group(1)
    if ch == '.' and len(m.group(0)) >= 3:
        return '...'
    return ch


def _format_timestamp(seconds: float) -> str:
    """MM:SS.mmm, per MiniMax's own shot-marker format ('[Shot N] At MM:SS.mmm, ...')."""
    seconds = max(0.0, seconds)
    minutes = int(seconds // 60)
    remainder = seconds - minutes * 60
    return f"{minutes:02d}:{remainder:06.3f}"


def _normalize_dialogue_text(text: str) -> str:
    """Per the guide's own §5.4 rules: standardize punctuation to basic marks,
    strip decorative/repeated punctuation, end complete statements with ./?/!."""
    text = text.strip()
    text = _DECORATIVE_RE.sub('', text)
    text = _REPEATED_PUNCT_RE.sub(_collapse_repeated_punct, text)
    # A quote captured mid-sentence often ends in a comma by normal grammar
    # (he says, "this must be it," and continues...) — that comma isn't the
    # dialogue's own terminal punctuation, so strip it before deciding whether
    # to add one; otherwise it became "...it,." instead of "...it.".
    text = text.rstrip(',').strip()
    if text and text[-1] not in '.!?':
        text += '.'
    return text


def _wrap_dialogue(text: str, language: str) -> str:
    """Wraps every "..."-quoted span in a CUT's text as <d>[Language] ...</d>,
    the guide's required dialogue/lyric tag — leaves everything outside quotes
    (including any <Subject N>/<Picture N>/<Video N>/<Audio N> tags) untouched."""
    def _sub(m):
        inner = _normalize_dialogue_text(m.group(1))
        return f"<d>[{language}] {inner}</d>"
    return _DIALOGUE_RE.sub(_sub, text)


_SUBJECT_TAG_RE = re.compile(r'<Subject (\d+)>')


def _find_subject_shot_appearances(chunk_segments: list) -> dict:
    """Scans each non-empty CUT's own text for every literal <Subject N> tag the
    user typed, recording which [Shot k] (1-indexed, matching detailed_description's
    own numbering) each subject actually appears in for this chunk."""
    appearances = {}
    shot_num = 0
    for seg in chunk_segments:
        text = (seg.get("prompt") or "").strip()
        if not text:
            continue
        shot_num += 1
        for m in _SUBJECT_TAG_RE.finditer(text):
            n = int(m.group(1))
            shots = appearances.setdefault(n, [])
            if shot_num not in shots:
                shots.append(shot_num)
    return appearances


def _presence_phrase(subject_n: int, appearances: dict, total_shots: int) -> str:
    """"(present throughout)" only when a subject's tag genuinely appears in every
    shot of the chunk — otherwise the guide's own "(appears in [Shot N], ...)" format,
    so a character introduced partway through (e.g. entering in Shot 2) isn't
    misrepresented as present from the start."""
    shots = appearances.get(subject_n, [])
    if not shots:
        return "(referenced in this shot)"
    if total_shots > 0 and len(shots) >= total_shots:
        return "(present throughout)"
    return "(appears in " + ", ".join(f"[Shot {s}]" for s in shots) + ")"


def _seg_speaker_indices(seg: dict) -> list:
    """A CUT's speaking characters — the current multi-select field, with a
    fallback to the older single-speaker field for timelines saved before the
    multi-speaker redesign."""
    idxs = seg.get("speakerCharIdxs")
    if isinstance(idxs, list) and idxs:
        return idxs
    legacy = seg.get("speakerCharIdx")
    return [legacy] if legacy is not None else []


def _build_summary_sentence(subject_tags: list, video_continuity_tag: str, carry_audio_tag: str) -> str:
    """One plain-English sentence naming the chunk's subjects — sits after the
    bracketed task-type prefix in the summary section. Deliberately simple
    connective prose; the structural elements (tags, section, task-type bracket)
    are what the model was actually trained against, not exact phrasing."""
    if not subject_tags:
        base = "The target video follows the shot description below."
    elif len(subject_tags) == 1:
        base = f"The target video shows {subject_tags[0]}."
    else:
        base = f"The target video shows {', '.join(subject_tags[:-1])} and {subject_tags[-1]}."
    extras = []
    if video_continuity_tag:
        extras.append(f"continuing directly from {video_continuity_tag}")
    if carry_audio_tag:
        extras.append(f"carrying {carry_audio_tag} forward")
    if extras:
        base = base.rstrip(".") + ", " + ", ".join(extras) + "."
    return base


def _assemble_six_section_prompt(subject_lines: list, summary_line: str, retention_lines: list,
                                  style_line: str, shot_lines: list,
                                  soundscape_text: str, music_text: str) -> str:
    """Assembles MiniMax's own six required sections, in their required order, for
    a single H3 Reference (Omni) mode generation call: subject_definitions, summary,
    retention_analysis, detailed_description, overall_soundscape, non_diegetic_music."""
    parts = []
    if subject_lines:
        parts.append("subject_definitions:\n" + "\n".join(subject_lines))
    if summary_line:
        parts.append("summary:\n" + summary_line)
    if retention_lines:
        parts.append("retention_analysis:\n" + "\n".join(retention_lines))
    desc_lines = ([style_line] if style_line else []) + shot_lines
    if desc_lines:
        parts.append("detailed_description:\n" + "\n".join(desc_lines))
    parts.append("overall_soundscape:\n" + (soundscape_text.strip() if soundscape_text else "N/A"))
    parts.append("non_diegetic_music:\n" + (music_text.strip() if music_text else "N/A"))
    return "\n\n".join(parts)


def _bucket_segments_into_chunks(tdata: dict, duration_seconds: float, chunk_duration_seconds: float):
    """Each chunk owns its own independent CUT list now (tdata["chunks"][i]["segments"],
    built by the JS timeline UI's per-chunk sections) — no more auto-splitting one flat
    CUT list by time-overlap. That auto-split used to duplicate a CUT spanning a chunk
    boundary verbatim into every chunk it touched, so chunk 2+ read as a repeat of
    chunk 1 rather than a continuation; giving each chunk its own real, independently
    authored CUTs fixes that at the source instead of patching the symptom.

    Chunk *boundaries* (bounds/lengths) are computed the same as originally:
    chunks run chunk_duration_seconds each, in order, with the final chunk
    absorbing whatever remains, and an under-H3's-~4s-minimum trailing
    remainder folds into the previous chunk. This MUST stay identical to the
    JS UI's own _chunkBoundsSeconds, since the chunk sections shown there are
    meant to be exactly what renders as separate H3 calls.

    Returns (buckets, chunk_lengths, bounds) — chunk_lengths is a list of per-chunk
    durations in seconds and bounds a list of [start, end] second pairs, both same
    length as buckets. Each segment gets seg["_abs_start"] stashed on it: its own
    weight-based position within its chunk, offset by that chunk's own start — an
    absolute position in the overall timeline, same as a caller computing
    [Shot N] At MM:SS.mmm would need (seg["_abs_start"] - chunk_start_sec)."""
    chunk_size = max(0.5, chunk_duration_seconds)
    num_chunks = max(1, math.ceil(duration_seconds / chunk_size))

    bounds = []
    cursor = 0.0
    for i in range(num_chunks):
        end = duration_seconds if i == num_chunks - 1 else min(duration_seconds, cursor + chunk_size)
        bounds.append([cursor, end])
        cursor = end

    min_chunk_seconds = 4.0
    while len(bounds) > 1 and (bounds[-1][1] - bounds[-1][0]) < min_chunk_seconds:
        bounds[-2][1] = bounds[-1][1]
        bounds.pop()

    saved_chunks = tdata.get("chunks") or []
    buckets = []
    for i, (b_start, b_end) in enumerate(bounds):
        chunk_segments = list((saved_chunks[i].get("segments") if i < len(saved_chunks) else None) or [])
        chunk_dur = b_end - b_start
        total_weight = sum(float(s.get("weight", 1) or 1) for s in chunk_segments) or 1.0
        seg_cursor = b_start
        for seg in chunk_segments:
            seg["_abs_start"] = seg_cursor
            seg_cursor += (float(seg.get("weight", 1) or 1) / total_weight) * chunk_dur
        buckets.append(chunk_segments)

    chunk_lengths = [end - start for start, end in bounds]
    return buckets, chunk_lengths, bounds


def _two_stage_snap_upscale_target(cur_h_latent: int, cur_w_latent: int, scale_by: float):
    """Target latent H/W for the mid-sampling video-latent upscale, snapped to
    H3's own canvas grid (CANVAS_MULTIPLE=32 px, i.e. 2 latent units — 16x VAE
    spatial downscale x 2x2 DiT patch — since the video latent downsamples
    pixels by 16 per _empty_av_latent in comfy_extras/nodes_minimax_h3.py).

    Ported directly from the reference "dual sampling" workflow's own upscale
    node (H3LatentUpscaleByJingchen573 / github.com/wjc573/
    ComfyUI-H3LatentUpscale-jingchen573's _calculate_aligned_size) — floors
    the SHORT axis to the grid (guaranteeing it never exceeds the requested
    scale), then derives the LONG axis's target from the short axis's own
    *actual* achieved scale, so aspect ratio is preserved by construction,
    while still capping the long axis so it never exceeds what the requested
    scale would give it either. Returns (target_h_latent, target_w_latent,
    effective_scale_x, effective_scale_y).
    """
    latent_alignment = max(1, CANVAS_MULTIPLE // 16)  # 2 latent units = 32px

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


class MuseMinimaxDirector:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": ([MODE_REFERENCE, MODE_FIRST_LAST], {"default": MODE_REFERENCE}),
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "audio_vae": ("VAE", {"tooltip": "Needed for final audio decode in both modes — H3 always builds a joint audio+video latent internally, even in First/Last Frame mode."}),
                "aspect_ratio": (ASPECT_RATIO_OPTIONS, {"default": AspectRatio.WIDESCREEN_H.value}),
                "megapixels": ("FLOAT", {"default": 0.98, "min": 0.1, "max": 4.0, "step": 0.02}),
                "multiple": ("INT", {"default": 32, "min": 8, "max": 128, "step": 4, "advanced": True}),
                "resize_method": (["crop", "pad", "stretch"], {"default": "crop", "tooltip":
                    "How every character/background reference image and First/Last Frame image gets fit to "
                    "the output resolution when its own aspect ratio doesn't match. 'crop' scales up and "
                    "center-crops the excess (no distortion, may crop the edges of a person/scene). 'pad' "
                    "scales down to fit entirely within the frame and adds black bars (nothing cropped, but "
                    "the bars become visible reference content). 'stretch' resizes directly, distorting "
                    "proportions."}),
                "duration_seconds": ("FLOAT", {"default": 10.0, "min": 1.0, "max": 120.0, "step": 0.5,
                    "tooltip": "Total length of the finished video. Automatically split into multiple H3 "
                               "generation calls if longer than chunk_duration_seconds, stitched together."}),
                "chunk_duration_seconds": ("FLOAT", {"default": 10.0, "min": 3.0, "max": 15.0, "step": 0.5,
                    "tooltip": "Length of each individual H3 call. H3's own trained range tops out around "
                               "15s per call — longer totals get split into chunks this long (the final "
                               "chunk absorbs whatever's left over, so it may be shorter). Reference mode: "
                               "each continuation chunk is fed the previous chunk's own last few frames "
                               "and last few seconds of audio as reference video/audio, plus an explicit "
                               "instruction to continue seamlessly rather than cut. First/Last Frame mode: "
                               "continuation falls back to the previous chunk's last frame only."}),
                "ref_image_size": (["match", "max"], {
                    "default": "match",
                    "tooltip": "'match' scales references down to the generation's pixel area (faster). "
                               "'max' keeps up to a 2048px short edge for stronger identity fidelity, but "
                               "reference tokens ride every sampling step so it's several times slower. "
                               "Reference (Omni) mode only.",
                }),
                "hybrid_continuation": ("BOOLEAN", {"default": False, "tooltip":
                    "Reference (Omni) mode only, needs model_fl2va connected. Reference mode's own "
                    "carry-over (ref_video/ref_audio) is a soft reference, not a hard lock — H3 can still "
                    "cut to a new composition at a chunk boundary despite it. When this is on, continuation "
                    "chunks (2nd onward) switch to a hard-locked first-frame anchor instead: the exact last "
                    "frame of the previous chunk, via the separate First/Last-Frame checkpoint's real "
                    "keyframe-lock mechanism. The first chunk always runs Reference (Omni) normally, so "
                    "character/background images still establish identity — continuation chunks just don't "
                    "get fresh reference-image reinforcement after that (the anchor frame itself already "
                    "carries the correct likeness forward, since it's real output from the reference-anchored "
                    "first chunk, not a blank start)."}),
                "seam_interpolation_frames": ("INT", {"default": 2, "min": 0, "max": 8, "step": 1, "tooltip":
                    "Reference (Omni) mode only, 2+ chunks. Two chunks are independent generation calls, so "
                    "even with a working continuation anchor, the camera position can drift a few pixels "
                    "right at the seam. Replaces the next chunk's first N real frames with N real "
                    "in-between frames computed via RIFE optical-flow interpolation (requires "
                    "ComfyUI-Frame-Interpolation) from the two actual boundary frames, rather than a naive "
                    "cross-dissolve — a plain alpha blend doesn't know the camera moved and ghosts instead "
                    "of smoothing. Replaces rather than inserts so total output length never changes and "
                    "audio can never drift out of sync with it. 0 disables it (hard cut)."}),
                "vae_reencode_carry_test": ("BOOLEAN", {"default": False, "tooltip":
                    "TEST. Any mode, 2+ chunks (same scope as the plain anchor mechanism it replaces). "
                    "Replaces the plain first-frame-anchor continuity (_KEYFRAME_INJECTION_FRAMES discard) "
                    "with LTX Director's own mechanism: the "
                    "previous chunk's actual final vae_reencode_carry_length frames of decoded output "
                    "(+ matching audio) are freshly VAE re-encoded (not the sampler's own raw latent tail) "
                    "and hard-frozen (noise-masked) as this chunk's own opening latent prefix, via "
                    "MiniMaxH3GeneratedAVMaskedContext (ComfyUI-H3-Motion-Context-MultiRef) — the same "
                    "extend-then-trim shape as the plain anchor path, just a different, ground-truth-pixel "
                    "source for the carried prefix. Works with two_stage_sampling on or off: with it off, "
                    "injects once, before the single sampling pass; with it on, injects TWICE — once before "
                    "Stage 1 (so the early, composition-deciding steps are actually anchored) and again after "
                    "the Stage-2 upscale, right before the real final pass (since the upscale's own priming "
                    "step forces the mask back to unprotected regardless of the first injection). Confirmed "
                    "the Stage-1 injection alone isn't optional: skipping it let a real two-stage render "
                    "invent an entirely different shot at the cut. When off, behaves exactly as before."}),
                "vae_reencode_carry_length": ("INT", {"default": 39, "min": 22, "max": 90, "step": 1, "tooltip":
                    "Only used when vae_reencode_carry_test is on. Requested carry window in pixel frames — "
                    "snapped internally to H3's own valid video-VAE / audio-clock grid (39 is both a valid "
                    "H3 run and the shared audio boundary, matching MiniMaxH3GeneratedAVMaskedContext's own "
                    "default)."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "seed_hunt": ("BOOLEAN", {"default": False, "tooltip":
                    "When on, runs 4 full passes total — identical settings, only the seed differs — and "
                    "fills the candidate_1..4 outputs (candidate_1 is always the main seed; 2-4 use seed + "
                    "N*1,000,003). Wire candidate_1..4_images/audio into MuseMinimaxRefine to pick one and "
                    "refine it at higher resolution. Takes ~4x as long as a single run — set megapixels low "
                    "here for cheap scouting, then refine at full resolution downstream."}),
                "use_prompt_override": ("BOOLEAN", {"default": False, "tooltip":
                    "When on, every chunk's prompt is replaced with whatever's wired into prompt_override, "
                    "exactly as typed — the timeline's characters/CUTs/soundscape are ignored for prompt "
                    "purposes (reference images, sampling, and chunking still work normally). For someone "
                    "who already has a fully-formatted H3 prompt and wants to skip the Director's own "
                    "compiler entirely, same as typing directly into the stock node's prompt box."}),
                "steps": ("INT", {"default": 20, "min": 1, "max": 100}),
                "sampler_name": (["res_multistep", "euler", "euler_ancestral", "dpmpp_2m"], {"default": "res_multistep"}),
                "scheduler": (["simple", "normal", "beta", "sgm_uniform"], {"default": "simple"}),
                "two_stage_sampling": ("BOOLEAN", {"default": False, "tooltip":
                    "Experimental. Runs the first few steps at a lower resolution, upscales the "
                    "video latent directly (no VAE round-trip), then finishes the remaining steps "
                    "at full resolution on the same continuous noise schedule. Off keeps today's "
                    "single-pass behavior exactly as-is."}),
                "two_stage_first_pass_steps": ("INT", {"default": 2, "min": 1, "max": 6, "tooltip":
                    "How many of the total steps run at the lower resolution before the upscale. "
                    "2 is the reference workflow's own saved default (2-3 is the tested range); "
                    "more than 3 risks the low-res pass locking in a broken composition before "
                    "the upscale can recover it."}),
                "two_stage_upscale_factor": ("FLOAT", {"default": 1.5, "min": 1.0, "max": 2.0, "step": 0.05, "tooltip":
                    "How much larger the second pass renders vs the first. The reference workflow's own "
                    "working note calls 1.3-1.5x the stable range — above that it warns of visible line/"
                    "texture artifacts needing careful tuning, even though up to 2.0x is technically allowed. "
                    "Actual applied value is snapped to H3's own valid resolution grid, so the true scale may "
                    "differ slightly from this number — check the log for the exact value used."}),
                "two_stage_upscale_method": (["nearest-exact", "bilinear", "area", "bicubic", "bislerp"], {"default": "nearest-exact"}),
                "two_stage_seed_hunt_latent_only": ("BOOLEAN", {"default": False, "tooltip":
                    "For scouting with Seed Hunt: stops each pass after Stage 1 instead of also running "
                    "the expensive Stage 2 upscale for all 4 candidates. images/audio become a cheap "
                    "low-res preview of Stage 1 only; the real, continuable Stage 1 latent is exposed on "
                    "the candidate_N_latent outputs — wire those into Muse Minimax Refine V1.2, pick your "
                    "favorite there, and only that one pays the Stage 2 cost."}),
                "shift_video": ("FLOAT", {"default": 12.0, "min": 0.01, "max": 100.0, "step": 0.01, "advanced": True}),
                "shift_audio": ("FLOAT", {"default": 3.0, "min": 0.01, "max": 100.0, "step": 0.01, "advanced": True}),
                "timeline_data": ("STRING", {"default": "{}", "multiline": False}),
                # Appended after timeline_data (the last pre-existing required widget)
                # deliberately — ComfyUI restores a saved workflow's widgets_values by
                # position, not by name, so any new required widget must go at the very
                # end or every widget after it silently misaligns on old saved workflows.
                # Replaces the old all-or-nothing seed_hunt toggle with independent
                # per-candidate control (ported from the proven MuseMinimaxDirector-
                # SeedHuntToggle-Test node); seed_hunt itself stays put, untouched
                # position, hidden from the panel, purely so an old workflow that had it
                # on keeps running all 3 extra passes exactly as before. Orthogonal to
                # two_stage_seed_hunt_latent_only — that decides what each pass that
                # runs actually does (stop after Stage 1 or not); these decide which
                # passes run at all. Neither reads the other.
                "candidate_2": ("BOOLEAN", {"default": False, "tooltip":
                    "Runs one extra full pass (identical settings, seed + 1,000,003) and fills the "
                    "candidate_2 output. Independent of Candidate 3/4 — turn on only the ones you want "
                    "to pay for."}),
                "candidate_3": ("BOOLEAN", {"default": False, "tooltip":
                    "Runs one extra full pass (identical settings, seed + 2,000,006) and fills the "
                    "candidate_3 output. Independent of Candidate 2/4."}),
                "candidate_4": ("BOOLEAN", {"default": False, "tooltip":
                    "Runs one extra full pass (identical settings, seed + 3,000,009) and fills the "
                    "candidate_4 output. Independent of Candidate 2/3."}),
            },
            "optional": {
                "model_fl2va": ("MODEL", {"tooltip": "The separate First/Last-Frame checkpoint (not the same "
                    "weights as the main Reference/Omni model input) — load it via its own loader. Used whenever "
                    "a First/Last-Frame-style generation actually happens: First/Last Frame mode itself, and "
                    "Hybrid Continuation's chunk-to-chunk lock while in Reference mode. If left unconnected, "
                    "First/Last Frame mode falls back to the main model input instead — which should normally "
                    "hold the Reference/ref2va checkpoint, not this one, so results may be degraded."}),
                "prompt_override": ("STRING", {"forceInput": True, "tooltip":
                    "Wire in any plain text node (e.g. a Text Multiline node) with an already-formatted H3 "
                    "prompt. Only takes effect when use_prompt_override is on."}),
                # Reference (Omni) mode only. Up to 3 reference videos and 3 reference audio
                # clips, uploaded and scrub-trimmed directly in the timeline UI (timeline_data's
                # refVideos/refAudios) rather than as graph sockets — same convention as the
                # character/background reference images.
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "STRING", "IMAGE",
                     "IMAGE", "AUDIO", "IMAGE", "AUDIO", "IMAGE", "AUDIO", "IMAGE", "AUDIO",
                     "LATENT", "LATENT", "LATENT", "LATENT")
    RETURN_NAMES = ("images", "audio", "compiled_prompt", "ref_images_used",
                     "candidate_1_images", "candidate_1_audio", "candidate_2_images", "candidate_2_audio",
                     "candidate_3_images", "candidate_3_audio", "candidate_4_images", "candidate_4_audio",
                     "candidate_1_latent", "candidate_2_latent", "candidate_3_latent", "candidate_4_latent")
    FUNCTION = "execute"
    CATEGORY = "Muse Collective"

    def execute(self, mode, model, clip, vae, audio_vae, aspect_ratio, megapixels, multiple, resize_method,
                duration_seconds, chunk_duration_seconds, ref_image_size, hybrid_continuation, seam_interpolation_frames,
                vae_reencode_carry_test, vae_reencode_carry_length,
                seed, seed_hunt, use_prompt_override, steps, sampler_name, scheduler,
                two_stage_sampling, two_stage_first_pass_steps, two_stage_upscale_factor,
                two_stage_upscale_method, two_stage_seed_hunt_latent_only, shift_video, shift_audio,
                timeline_data, candidate_2=False, candidate_3=False, candidate_4=False,
                model_fl2va=None, prompt_override=None):
        tdata = _parse_timeline(timeline_data)
        # Resolved before any reference image is loaded — every character/background/
        # First-Last-Frame image gets fit to this exact resolution via resize_method,
        # rather than leaving an aspect-ratio mismatch to whatever H3 does internally.
        width, height = _resolve_resolution(aspect_ratio, megapixels, multiple)
        char_ref_images, subject_lines, subject_retention_meta, subject_number_by_char_index = _build_character_subjects(
            tdata, width, height, resize_method)
        subject_count = len(subject_lines)
        dialogue_language = (tdata.get("dialogue_language") or "English").strip() or "English"
        background = tdata.get("background")
        # First/Last Frame mode has no sockets of its own — Ref 1 / Ref 2 (the same
        # upload UI every other reference uses) double as first_frame/last_frame. Read
        # these directly from the raw characters list by literal slot position, NOT via
        # char_ref_images — that dict is now densely fill-order-packed (see its own
        # docstring), so "ref_image_0" there means "whichever slot was filled first",
        # not "literally Ref 1". First/Last Frame mode has no <Picture N> tagging at all
        # (ImageToVideo takes first_frame/last_frame directly), so there's no tag-order
        # concern here — Ref 1 must always mean Ref 1.
        characters_raw = tdata.get("characters", [])
        first_frame = _load_character_image(characters_raw[0]) if len(characters_raw) > 0 and characters_raw[0] else None
        first_frame = _fit_image_to_target(first_frame, width, height, resize_method)
        last_frame = _load_character_image(characters_raw[1]) if len(characters_raw) > 1 and characters_raw[1] else None
        last_frame = _fit_image_to_target(last_frame, width, height, resize_method)
        # Background/continuity-anchor slot: the next free dense position after however
        # many character images actually made it into char_ref_images — NOT a fixed index
        # — same reasoning as _build_character_subjects: H3 tags by iteration order, so
        # this must land wherever the character images actually stopped, not at a fixed
        # slot number that only happens to be correct when all 9 character slots are full.
        bg_index = len(char_ref_images)

        # Static reference-image set actually used for <Picture N> tagging on this run's
        # first chunk (character/product photos + background, same dense fill order
        # MiniMaxH3ReferenceToVideo assigns Picture numbers by) — exposed as a real output
        # so MuseMinimaxRefine can reuse the exact same reference photos for identity/prop
        # lock during its own refine pass, instead of the user re-uploading them via
        # separate LoadImage nodes. Only meaningful in Reference (Omni) mode — First/Last
        # Frame mode has no <Picture N> tagging at all. Matches chunk 1's own composition
        # specifically (see the `elif background and (...)` branch below) since Refine only
        # ever operates on a single H3-call-length candidate, never a later continuation chunk.
        ref_images_used_list = []
        if mode == MODE_REFERENCE:
            ref_images_used_list.extend(char_ref_images.values())
            if background and (background.get("file") or background.get("image_b64")):
                bg_tensor = _load_character_image(background)
                if bg_tensor is not None:
                    bg_tensor = _fit_image_to_target(bg_tensor, width, height, resize_method)
                    ref_images_used_list.append(bg_tensor)
        ref_images_used = torch.cat(ref_images_used_list, dim=0) if ref_images_used_list else torch.zeros((0, height, width, 3))

        buckets, chunk_lengths, chunk_bounds = _bucket_segments_into_chunks(tdata, duration_seconds, chunk_duration_seconds)
        num_chunks = len(buckets)

        log.info(
            "[MuseMinimaxDirector] mode=%s, %dx%d, seed=%d, candidates=%d, %d chunk(s): %s (total %.1fs)",
            mode, width, height, seed, 1 + sum([candidate_2, candidate_3, candidate_4]), num_chunks,
            ", ".join(f"~{c:.1f}s" for c in chunk_lengths), sum(chunk_lengths),
        )

        from nodes import NODE_CLASS_MAPPINGS
        RandomNoise = NODE_CLASS_MAPPINGS["RandomNoise"]
        BasicGuider = NODE_CLASS_MAPPINGS["BasicGuider"]
        KSamplerSelect = NODE_CLASS_MAPPINGS["KSamplerSelect"]
        BasicScheduler = NODE_CLASS_MAPPINGS["BasicScheduler"]
        SamplerCustomAdvanced = NODE_CLASS_MAPPINGS["SamplerCustomAdvanced"]
        VAEDecode = NODE_CLASS_MAPPINGS["VAEDecode"]
        VAEDecodeAudio = NODE_CLASS_MAPPINGS["VAEDecodeAudio"]
        # Two-stage sampling only — all four are stock ComfyUI core nodes.
        SplitSigmas = NODE_CLASS_MAPPINGS["SplitSigmas"] if two_stage_sampling else None
        DisableNoise = NODE_CLASS_MAPPINGS["DisableNoise"] if two_stage_sampling else None
        LTXVSeparateAVLatent = NODE_CLASS_MAPPINGS["LTXVSeparateAVLatent"] if two_stage_sampling else None
        LTXVConcatAVLatent = NODE_CLASS_MAPPINGS["LTXVConcatAVLatent"] if two_stage_sampling else None
        # Optional — only used for seam_interpolation_frames. Unlike the nodes above,
        # this comes from a third-party pack (ComfyUI-Frame-Interpolation), so it may
        # not be installed; looked up with .get() rather than [...] and handled at the
        # call site with a warning + hard-cut fallback rather than crashing the run.
        RIFE_VFI = NODE_CLASS_MAPPINGS.get("RIFE VFI")
        # vae_reencode_carry_test only — VAEEncode is stock core, always safe to grab.
        # VAEEncodeAudio is also stock core but only needed for this test, and
        # MiniMaxH3GeneratedAVMaskedContext comes from the separately-cloned
        # ComfyUI-H3-Motion-Context-MultiRef pack, so both fail loudly (not silently
        # via .get()) if the toggle is on but either turns out to be missing.
        VAEEncode = NODE_CLASS_MAPPINGS["VAEEncode"]
        VAEEncodeAudio = None
        MiniMaxH3GeneratedAVMaskedContext = None
        if vae_reencode_carry_test:
            VAEEncodeAudio = NODE_CLASS_MAPPINGS.get("VAEEncodeAudio")
            if VAEEncodeAudio is None:
                raise RuntimeError("vae_reencode_carry_test is on but the stock 'VAEEncodeAudio' node "
                                    "isn't registered — check this ComfyUI install is up to date.")
            MiniMaxH3GeneratedAVMaskedContext = NODE_CLASS_MAPPINGS.get("MiniMaxH3GeneratedAVMaskedContext")
            if MiniMaxH3GeneratedAVMaskedContext is None:
                raise RuntimeError("vae_reencode_carry_test is on but 'MiniMaxH3GeneratedAVMaskedContext' "
                                    "isn't registered — install ComfyUI-H3-Motion-Context-MultiRef into "
                                    "custom_nodes.")

        # Sigma shift only depends on the model + the two shift values — same for every
        # chunk, so it only needs to run once rather than inside the loop.
        shifted_model = _unpack_node_result(_execute_comfy_node(
            MiniMaxH3SigmaShift, model=model, shift_video=shift_video, shift_audio=shift_audio,
        ))[0]
        # Computed once whenever model_fl2va is connected, not just for Hybrid
        # Continuation — First/Last Frame mode needs the exact same shifted fl2va
        # checkpoint for its own MiniMaxH3ImageToVideo calls, since that node
        # expects fl2va weights specifically, not the Reference/ref2va checkpoint
        # sitting in the main model input.
        shifted_model_fl2va = None
        if model_fl2va is not None:
            shifted_model_fl2va = _unpack_node_result(_execute_comfy_node(
                MiniMaxH3SigmaShift, model=model_fl2va, shift_video=shift_video, shift_audio=shift_audio,
            ))[0]
        use_hybrid = mode == MODE_REFERENCE and hybrid_continuation and model_fl2va is not None
        if mode == MODE_REFERENCE and hybrid_continuation and model_fl2va is None:
            log.warning("[MuseMinimaxDirector] hybrid_continuation is on but model_fl2va isn't connected — "
                        "falling back to normal Reference (Omni) continuity for every chunk.")
        elif mode == MODE_FIRST_LAST and model_fl2va is None:
            log.warning("[MuseMinimaxDirector] First/Last Frame mode has no model_fl2va connected — falling "
                        "back to the main model input, which should normally hold the Reference/ref2va "
                        "checkpoint, not the First/Last-Frame one. Results may be degraded; wire the fl2va "
                        "checkpoint into model_fl2va for correct output.")
        sampler = _unpack_node_result(_execute_comfy_node(KSamplerSelect, sampler_name=sampler_name))[0]

        # User-provided reference videos/audio — uploaded and scrub-trimmed in the timeline
        # UI, decoded here from disk. Unchanging across chunks; both share slots with the
        # chunking carry-over below (reserved slot 0 on continuation chunks), so both are
        # merged per-chunk inside the loop rather than built once here.
        user_ref_videos = []  # list of (frames_tensor, paired_audio_dict_or_None, entry_dict)
        for entry in (tdata.get("refVideos") or [])[:3]:
            if not entry or not entry.get("file"):
                continue
            tensor = _load_ref_video_tensor(entry)
            if tensor is None:
                continue
            # Opt-in per slot: reuses _load_ref_audio_clip directly on the video file's own
            # embedded audio track (PyAV doesn't care whether the container is "video" or
            # "audio", it just reads whichever stream exists) — no separate decode path needed.
            paired_audio = _load_ref_audio_clip(entry) if entry.get("includeAudio") else None
            user_ref_videos.append((tensor, paired_audio, entry))

        # list of (AUDIO dict, entry_dict, original_ui_index) — the original index
        # (not the filtered position here) is what Ref Audio N <-> Ref N positional
        # voice-pairing checks against, e.g. Ref Audio 3 only pairs with Ref 3 even
        # if Ref Audio 1/2 were left empty and this ends up first in the list.
        user_ref_audios = []
        for ui_idx, entry in enumerate((tdata.get("refAudios") or [])[:3]):
            if not entry or not entry.get("file"):
                continue
            clip_audio = _load_ref_audio_clip(entry)
            if clip_audio is not None:
                user_ref_audios.append((clip_audio, entry, ui_idx))

        # Latent-Only Scouting used to only ever keep the LAST chunk's Stage-1 latent
        # (candidate_N_latent silently dropped every earlier chunk) — fine for a
        # single-chunk timeline, but on a multi-chunk one it meant Refine could only
        # ever hi-res-fix the final chunk, never the full stitched video (confirmed
        # directly: a real 2-chunk refine only produced the last ~15s). Fixed by
        # saving every chunk's own Stage-1 latent to a small scratch folder on disk
        # as it's generated, one candidate index at a time — Refine then loads them
        # back, refines each chunk in order (re-anchoring continuity between them the
        # same way this node does between its own chunks), and stitches the results
        # itself. Scoped to a fresh OS temp dir per node execution so it never
        # collides with another run; Refine deletes it once it's done with it. Only
        # created when Latent-Only Scouting is actually on — every other path is
        # unaffected and never touches disk for this.
        run_scout_dir = tempfile.mkdtemp(prefix="muse_v1_2_scout_") if two_stage_seed_hunt_latent_only else None

        # The entire per-chunk build + sample + decode pipeline below only ever
        # depends on `seed` in one place (RandomNoise's noise_seed) — everything
        # else (prompts, reference assembly, conditioning) is identical regardless
        # of seed. Wrapped as a nested function so Seed Hunt can call it multiple
        # times with different seeds, and the single-pass (non-hunt) path is just
        # calling it once — same code, no duplicated logic between the two.
        def _run_pass(pass_seed, candidate_idx=0):
            all_images = []
            all_waveform = None
            audio_sample_rate = None
            compiled_prompts = []
            prev_chunk_images = None
            prev_chunk_audio = None
            last_chunk_stage1_latent = None

            for chunk_idx, chunk_segments in enumerate(buckets):
                chunk_len_seconds = chunk_lengths[chunk_idx]
                visible_chunk_length = align_frame_count(max(5, round(chunk_len_seconds * 24)))
                # A continuation chunk's own first _KEYFRAME_INJECTION_FRAMES frames
                # are real, newly-generated output — not copied from the previous
                # chunk — that get discarded below because H3's own keyframe-
                # injection artifact leaves them visibly transient (see that
                # constant's own comment). Without extending the budget here, that
                # discard silently eats into the authored CUT-timeline's own frame
                # count: whatever the compiled prompt was going to show at the start
                # of this chunk partially plays out during those doomed-to-be-cut
                # frames and gets thrown away with them, not "not enough was
                # generated" but "real authored content got generated then
                # discarded." Extending first (then trimming the same amount off
                # the decoded output, already handled below) keeps the full
                # authored budget intact for content that actually survives.
                # Snapped through align_frame_count rather than added raw, since
                # two individually-valid H3 frame counts don't necessarily sum to
                # another valid one on its 17k+5 grid.
                continuation_extension = 0
                if chunk_idx > 0 and prev_chunk_images is not None:
                    # vae_reencode_carry_test uses its own requested carry length here
                    # instead of _KEYFRAME_INJECTION_FRAMES — the real amount actually
                    # protected (chunk_carry_trim_frames, set below once the masked-
                    # context node runs) is what the post-decode trim uses; this is
                    # only a pre-generation budget estimate, snapped the same way.
                    carry_estimate = int(vae_reencode_carry_length) if vae_reencode_carry_test else _KEYFRAME_INJECTION_FRAMES
                    continuation_extension = (
                        align_frame_count(visible_chunk_length + carry_estimate)
                        - visible_chunk_length
                    )
                chunk_length = visible_chunk_length + continuation_extension
                is_last_chunk = chunk_idx == num_chunks - 1
                chunk_start_sec = chunk_bounds[chunk_idx][0]

                # Per-chunk now — style_line/overall_soundscape/non_diegetic_music used
                # to be single fields shared across the whole timeline, which couldn't
                # follow the story past chunk 1 (confirmed directly: a real 60s test kept
                # describing "corridor" for chunks whose story had already moved to a
                # different room). Same dict already used for Prompt Gen's own per-chunk
                # state below, just looked up earlier here so the plain-compile path can
                # use it too.
                saved_chunks_for_pg = tdata.get("chunks") or []
                this_chunk_data = saved_chunks_for_pg[chunk_idx] if chunk_idx < len(saved_chunks_for_pg) else {}
                style_line = (this_chunk_data.get("style_line") or "").strip()

                chunk_ref_videos = None
                chunk_ref_audios = None
                chunk_ref_images = {}
                chunk_carry_trim_frames = None
                # Only actually hybrid-switches once there's a predecessor chunk to lock
                # onto — the first chunk always runs normal Reference (Omni), hybrid or not.
                use_hybrid_chunk = use_hybrid and prev_chunk_images is not None

                # Keyframe images for this chunk (base-mode dispatch only — mode !=
                # MODE_REFERENCE or use_hybrid_chunk), in the exact order
                # MiniMaxH3ImageToVideo itself appends them to its own images list
                # (first_frame, then last_frame) — <Picture N> numbering in the
                # base-mode prompt below must follow this same order to line up with
                # what the node actually tokenizes.
                base_continuity_extra = ""
                base_soundscape_note = ""
                if use_hybrid_chunk:
                    chunk_first, chunk_last = prev_chunk_images[-1:], None
                    base_continuity_extra = (
                        " Continue the ongoing action naturally from this pose and framing — "
                        "no restart, no new take."
                    )
                    # Hybrid chunks have no reference audio at all (MiniMaxH3ImageToVideo takes none),
                    # so without any audio grounding H3 tends to hallucinate unprompted vocalization/
                    # speech (confirmed via spectrogram on a real test render). Only suppress that when
                    # this chunk's own CUT text doesn't actually call for dialogue — quoted text is the
                    # existing convention for spoken lines, so a quote mark means the user wants speech
                    # here and this note must not fight that.
                    has_dialogue = any('"' in (seg.get("prompt") or "") for seg in chunk_segments)
                    if not has_dialogue:
                        # No hardcoded example sounds here (an earlier version listed "footsteps" as an
                        # example and H3 took that literally even in a standing-still shot with no
                        # walking at all) — defer entirely to whatever the shot description below
                        # actually says, rather than suggesting specific sounds that may not apply.
                        base_soundscape_note = (
                            "No reference audio grounds this chunk — keep the soundscape ambient and "
                            "grounded only in whatever is actually happening in the shot description, "
                            "consistent with the previous shot's environment. No invented sound effects "
                            "or actions beyond what's described, and no dialogue or vocalization unless "
                            "the shot description explicitly includes spoken lines."
                        )
                elif mode != MODE_REFERENCE:
                    chunk_first = prev_chunk_images[-1:] if prev_chunk_images is not None else first_frame
                    chunk_last = last_frame if is_last_chunk else None
                    if prev_chunk_images is not None:
                        base_continuity_extra = (
                            " Continue the ongoing action naturally from this pose and framing — "
                            "no restart, no new take."
                        )
                else:
                    chunk_first = chunk_last = None

                if mode == MODE_REFERENCE and not use_hybrid_chunk:
                    # Non-hybrid Reference (Omni) chunks are the only case that gets
                    # MiniMax's own six-section reference-mode prompt format — hybrid
                    # chunks and First/Last Frame mode route through MiniMaxH3ImageToVideo,
                    # which has no reference-tag system for the format to apply to.
                    chunk_subject_lines = list(subject_lines)
                    chunk_subject_tags = [f"<Subject {i + 1}>" for i in range(subject_count)]

                    # Which shot each <Subject N> tag actually appears in, for this chunk —
                    # used to write an accurate presence clause below instead of always
                    # claiming "(present throughout)" even for a character only introduced
                    # partway through (e.g. entering the scene in Shot 2).
                    subject_shot_appearances = _find_subject_shot_appearances(chunk_segments)
                    total_shots = sum(1 for s in chunk_segments if (s.get("prompt") or "").strip())
                    chunk_retention_lines = [
                        f"<Subject {subject_n}> {_presence_phrase(subject_n, subject_shot_appearances, total_shots)}: "
                        f"{retention} - matches `<Picture {picture_n}>`."
                        for subject_n, picture_n, retention in subject_retention_meta
                    ]
                    # Audio entries are tracked in their own lists and appended after every
                    # visual Subject/Picture/Video line at assembly time — per MiniMax's own
                    # worked example, subject_definitions and retention_analysis always list
                    # every <Subject N> first, then <Audio N> last, regardless of what order
                    # they happened to get built in below.
                    chunk_audio_subject_lines = []
                    chunk_audio_retention_lines = []
                    task_flags = set()

                    # Speaker IDs are assigned in one pre-pass over every CUT in this chunk,
                    # before subject_definitions gets built — a paired ref_audio's own
                    # definition line needs to already know its character's (Sx) number
                    # (per the guide's own pattern: "<Audio 1> is the voice-timbre reference
                    # for <Subject 3> (S1)"), and that requires knowing every speaking
                    # character's assignment up front rather than discovering it only once
                    # detailed_description is built afterwards.
                    speaker_assign = {}
                    for seg in chunk_segments:
                        if not (seg.get("prompt") or "").strip():
                            continue
                        for char_idx in _seg_speaker_indices(seg):
                            if char_idx in subject_number_by_char_index:
                                subj_n = subject_number_by_char_index[char_idx]
                                if subj_n not in speaker_assign:
                                    speaker_assign[subj_n] = len(speaker_assign) + 1

                    # Carry-over continuity always claims slot 0 of both ref_videos and
                    # ref_audios once a chunk has a predecessor — H3 allows 3 of each, so
                    # user-provided references fill whatever slots are left after that.
                    chunk_ref_videos = {}
                    chunk_ref_video_audios = {}
                    video_slot = 0
                    video_continuity_tag = None
                    # <Audio j> numbering: a reference video's own paired soundtrack gets tagged
                    # before any standalone ref_audios (interleaved right before its <Video k> tag)
                    # — confirmed from the real node's own ref_items build order — so this counter
                    # has to run across both loops below, video-paired audio first.
                    audio_tag_counter = 0
                    # TEST: <Video 1> whole-clip continuation reference disabled here on purpose,
                    # isolated from the <Picture N> last-frame-anchor mechanism below (untouched).
                    # Per MiniMax's own base-mode guide (VIDEO_PROMPT_WRITING_GUIDE_base_en.md,
                    # section 3.1), a single first-frame anchor + "develop new action forward" is
                    # the documented I2VA pattern — the picture anchor below already matches that.
                    # The platform docs' own worked example for a <Video N> reference, by contrast,
                    # is "following the motion in reference video 1" — matching/reproducing motion,
                    # which lines up with the repeated-action behavior confirmed in live testing.
                    # Testing whether the picture anchor alone, without a competing motion-reference
                    # signal, lets the model develop genuinely new action instead. Re-enable by
                    # restoring this block if the test doesn't hold up (see git history/backups).
                    if False and prev_chunk_images is not None:
                        chunk_ref_videos[f"ref_video_{video_slot}"] = prev_chunk_images[-_CHUNK_CONTINUITY_REF_FRAMES:]
                        video_continuity_tag = f"<Video {video_slot + 1}>"
                        chunk_retention_lines.append(
                            f"{video_continuity_tag} (continuation source): fully_preserved - continues directly "
                            "from the immediately preceding shot's final moment, same action and camera framing. "
                            "The action shown in this reference has already fully happened and finished — do not "
                            "repeat, re-enact, or continue performing it; begin this shot from its ending state "
                            "and move on to new action only."
                        )
                        task_flags.add("video continuation")
                        video_slot += 1
                    for v, paired_audio, meta in user_ref_videos:
                        if video_slot > 2:
                            log.warning("[MuseMinimaxDirector] ref_video slots full (3 max, one reserved for chunk "
                                        "carry-over) — dropping an extra user-provided reference video.")
                            break
                        tag_n = video_slot + 1
                        chunk_ref_videos[f"ref_video_{video_slot}"] = v
                        role = meta.get("role") or "reference"
                        if role == "editing_source":
                            task_flags.add("video editing")
                        elif role == "continuation_source":
                            task_flags.add("video continuation")
                        v_desc = (meta.get("description") or "").strip()
                        v_retention = meta.get("retention") or ("fully_preserved" if v_desc else "weak_reference")
                        if v_desc:
                            subj_n = len(chunk_subject_tags) + 1
                            chunk_subject_tags.append(f"<Subject {subj_n}>")
                            chunk_subject_lines.append(f"<Subject {subj_n}> is {v_desc} (from `<Video {tag_n}>`).")
                            chunk_retention_lines.append(f"<Subject {subj_n}> (from `<Video {tag_n}>`): {v_retention} - {v_desc}.")
                        else:
                            chunk_retention_lines.append(
                                f"`<Video {tag_n}>` (camera/motion reference): {v_retention} - only structural/camera "
                                "characteristics are retained; no visible content is reused."
                            )
                        if paired_audio is not None:
                            chunk_ref_video_audios[f"ref_video_audio_{video_slot}"] = paired_audio
                            audio_tag_counter += 1
                            chunk_audio_subject_lines.append(f"<Audio {audio_tag_counter}> is the audio of `<Video {tag_n}>`.")
                            chunk_audio_retention_lines.append(
                                f"<Audio {audio_tag_counter}>: reference - guides voice timbre/delivery without "
                                "copying the original signal."
                            )
                            task_flags.add("audio reference")
                        video_slot += 1

                    chunk_ref_audios = {}
                    audio_slot = 0
                    carry_audio_tag = None
                    if prev_chunk_audio is not None:
                        # Tail of the previous chunk's own decoded audio, not the whole thing —
                        # H3 treats every ref_audio as a short (2-15s) reference clip.
                        tail_sr = prev_chunk_audio["sample_rate"]
                        tail_samples = min(prev_chunk_audio["waveform"].shape[-1], int(4.0 * tail_sr))
                        tail_wave = prev_chunk_audio["waveform"][..., -tail_samples:]
                        chunk_ref_audios[f"ref_audio_{audio_slot}"] = {"waveform": tail_wave, "sample_rate": tail_sr}
                        audio_tag_counter += 1
                        carry_audio_tag = f"<Audio {audio_tag_counter}>"
                        chunk_audio_subject_lines.append(f"{carry_audio_tag} is the tail end of the previous shot's own score/ambience.")
                        chunk_audio_retention_lines.append(
                            f"{carry_audio_tag} (previous shot's tail): partially_copy - the tail end of the "
                            "previous shot's own score/ambience continues into this one."
                        )
                        task_flags.add("audio reuse")
                        audio_slot += 1
                    for clip_audio, meta, ui_idx in user_ref_audios:
                        if audio_slot > 2:
                            log.warning("[MuseMinimaxDirector] ref_audio slots full (3 max, one reserved for chunk "
                                        "carry-over once a chunk has a predecessor) — dropping an extra reference audio clip.")
                            break
                        chunk_ref_audios[f"ref_audio_{audio_slot}"] = clip_audio
                        audio_tag_counter += 1
                        a_desc = (meta.get("description") or "").strip()
                        a_retention = meta.get("retention") or "reference"
                        # Positional pairing: Ref Audio N is always Ref (character) N's
                        # voice, by array index — matches the guide's own preferred phrasing
                        # ("<Audio N> is the voice-timbre reference for <Subject M> (Sx)")
                        # instead of a generic, unlinked description.
                        paired_subj_n = subject_number_by_char_index.get(ui_idx)
                        if paired_subj_n is not None:
                            sx = speaker_assign.get(paired_subj_n)
                            sx_suffix = f" (S{sx})" if sx else ""
                            chunk_audio_subject_lines.append(
                                f"<Audio {audio_tag_counter}> is the voice-timbre reference for `<Subject {paired_subj_n}>`{sx_suffix}.")
                        elif a_desc:
                            chunk_audio_subject_lines.append(f"<Audio {audio_tag_counter}> is the voice-timbre reference described as: {a_desc}.")
                        else:
                            chunk_audio_subject_lines.append(f"<Audio {audio_tag_counter}> is a voice-timbre reference.")
                        chunk_audio_retention_lines.append(
                            f"<Audio {audio_tag_counter}>: {a_retention} - "
                            + (a_desc if a_desc else "guides dialogue delivery without copying the original signal.")
                        )
                        task_flags.add("audio reuse" if a_retention in ("fully_copy", "partially_copy") else "audio reference")
                        audio_slot += 1

                    # Reference images: characters are always present; the fixed background
                    # slot holds either the real background image (first chunk / no
                    # predecessor, wrapped as its own <Subject N> the same way characters
                    # are) or, on continuation chunks, the previous chunk's own last frame
                    # as a standalone <Picture N> keyframe anchor — per the guide's own
                    # carve-out, a genuine first/last/keyframe anchor gets a standalone
                    # Picture entry rather than being wrapped as a Subject.
                    chunk_ref_images = dict(char_ref_images)
                    shot1_prefix = ""
                    if prev_chunk_images is not None:
                        last_frame_still = prev_chunk_images[-1:]
                        chunk_ref_images[f"ref_image_{bg_index}"] = last_frame_still
                        anchor_n = bg_index + 1
                        chunk_retention_lines.append(
                            f"`<Picture {anchor_n}>` ([Shot 1] first-frame anchor): fully_preserved - the exact "
                            "framing, pose, and camera angle at the end of the previous shot."
                        )
                        task_flags.add("keyframe completion")
                        # The single-person line below exists because two different fix
                        # attempts at the actual trigger (auto-inserted speaker-tag wording,
                        # then dropping "continues" from it) both failed to stop it —
                        # confirmed directly against three separate real renders, the last
                        # of which had the corrected wording in place and still rendered
                        # three copies of the same Subject. Whatever the real mechanism is,
                        # a blunt, explicit "exactly one person" constraint is the direct
                        # fix for the actual observed symptom rather than another guess at
                        # the indirect cause.
                        shot1_prefix = (
                            f"The shot begins from `<Picture {anchor_n}>`, continuing directly from the previous "
                            "shot's exact framing and pose — the camera must not reposition, zoom, pan, or "
                            "reframe relative to that image; hold the same camera position and lens distance "
                            "before any movement described below begins. There is exactly one instance of this "
                            "Subject in the frame — do not render a second copy, duplicate, double-exposure, or "
                            "any other person; the scene contains this one person only, throughout. "
                        )
                    elif background and (background.get("file") or background.get("image_b64")):
                        tensor = _load_character_image(background)
                        if tensor is not None:
                            tensor = _fit_image_to_target(tensor, width, height, resize_method)
                            chunk_ref_images[f"ref_image_{bg_index}"] = tensor
                            bg_picture_n = bg_index + 1
                            bg_subj_n = len(chunk_subject_tags) + 1
                            chunk_subject_tags.append(f"<Subject {bg_subj_n}>")
                            bg_desc = (background.get("description") or "").strip()
                            if bg_desc:
                                chunk_subject_lines.append(f"<Subject {bg_subj_n}> is {bg_desc} (from `<Picture {bg_picture_n}>`).")
                            else:
                                chunk_subject_lines.append(f"<Subject {bg_subj_n}> is the setting shown in `<Picture {bg_picture_n}>`.")
                            bg_retention = background.get("retention") or "fully_preserved"
                            bg_presence = _presence_phrase(bg_subj_n, subject_shot_appearances, total_shots)
                            chunk_retention_lines.append(
                                f"<Subject {bg_subj_n}> {bg_presence}: {bg_retention} - matches `<Picture {bg_picture_n}>`.")

                    task_bits = ["reference generation"]
                    for t in ("video editing", "video continuation", "keyframe completion", "audio reuse", "audio reference"):
                        if t in task_flags:
                            task_bits.append(t)
                    summary_line = f"[{' + '.join(task_bits)}] " + _build_summary_sentence(
                        chunk_subject_tags, video_continuity_tag, carry_audio_tag)

                    shot_lines = []
                    shot_idx = 0
                    for seg in chunk_segments:
                        text = (seg.get("prompt") or "").strip()
                        if not text:
                            continue
                        shot_idx += 1
                        # speaker_assign was already computed in the pre-pass above — reused
                        # here, not rebuilt, so a paired audio's own subject_definitions line
                        # and this CUT's (Sx) tag always agree on the same speaker number.
                        speaker_idxs = _seg_speaker_indices(seg)
                        tagged_any = False
                        for char_idx in speaker_idxs:
                            subj_n = subject_number_by_char_index.get(char_idx)
                            s_n = speaker_assign.get(subj_n) if subj_n is not None else None
                            if not s_n:
                                continue
                            subj_tag = f"<Subject {subj_n}>"
                            if subj_tag in text:
                                text = text.replace(subj_tag, f"{subj_tag} (S{s_n})")
                                tagged_any = True
                        # Only auto-attribute an untagged line when this CUT has exactly one
                        # speaker selected — with two or more, there's no safe way to guess
                        # which one owns dialogue that doesn't mention either tag, so leave
                        # it for the user to tag explicitly (e.g. type <Subject 2> themselves)
                        # rather than risk attributing someone else's line to the wrong voice.
                        if not tagged_any and len(speaker_idxs) == 1:
                            subj_n = subject_number_by_char_index.get(speaker_idxs[0])
                            s_n = speaker_assign.get(subj_n) if subj_n is not None else None
                            if s_n:
                                # "continues" is wrong specifically when this dialogue is
                                # shot 1's own first content in a continuation chunk — it
                                # lands immediately after shot1_prefix's own "continuing
                                # directly from the previous shot" sentence, so the model
                                # reads two back-to-back continuation/re-establishment cues
                                # for the same Subject right where framing is being locked to
                                # the <Picture N> anchor. Confirmed directly against two real
                                # renders: the one chunk with dialogue in its own CUT 1 (so
                                # this tag landed right next to shot1_prefix) was the only
                                # chunk that rendered duplicate copies of the subject: 2
                                # copies in one render, 3 in a second render of the same
                                # script. Every other chunk (dialogue in CUT 2+, so this tag
                                # never touches shot1_prefix) rendered a single subject
                                # cleanly. Drop "continues" in exactly this collision case —
                                # keep the <Subject N> (Sx) tag itself (still needed for
                                # voice-pairing) since that part isn't what's implicated.
                                if shot_idx == 1 and shot1_prefix:
                                    text = f"<Subject {subj_n}> (S{s_n}): {text}"
                                else:
                                    text = f"<Subject {subj_n}> (S{s_n}) continues: {text}"
                        text = _wrap_dialogue(text, dialogue_language)
                        if shot_idx == 1:
                            shot_lines.append(f"[Shot 1] {shot1_prefix}{text}")
                        else:
                            start_in_chunk = max(0.0, seg.get("_abs_start", 0.0) - chunk_start_sec)
                            shot_lines.append(f"[Shot {shot_idx}] At {_format_timestamp(start_in_chunk)}, {text}")

                    soundscape_text = (this_chunk_data.get("overall_soundscape") or "").strip()
                    music_text = (this_chunk_data.get("non_diegetic_music") or "").strip()
                    if carry_audio_tag:
                        suffix = f"The copied ambience layer from `{carry_audio_tag}` continues throughout."
                        soundscape_text = (soundscape_text + " " + suffix) if soundscape_text else suffix

                    # Audio entries always come after every visual Subject/Picture/Video line —
                    # see the comment where chunk_audio_subject_lines/chunk_audio_retention_lines
                    # are initialized above.
                    chunk_prompt = _assemble_six_section_prompt(
                        chunk_subject_lines + chunk_audio_subject_lines, summary_line,
                        chunk_retention_lines + chunk_audio_retention_lines,
                        style_line, shot_lines, soundscape_text, music_text,
                    )

                if mode != MODE_REFERENCE or use_hybrid_chunk:
                    # Per MiniMax's own base-mode (T2VA/I2VA/FL2VA/L2VA) prompt guide —
                    # no <Subject N> layer here, just the two keyframe images (if any)
                    # tagged <Picture N> and a 3-section format, not the six-section
                    # Reference-mode one above.
                    base_shot_lines, base_last_shot = _build_base_mode_shot_lines(
                        chunk_segments, chunk_start_sec, dialogue_language)
                    keyframe_line = _build_keyframe_alignment_line(
                        chunk_first is not None, chunk_last is not None, base_last_shot, chunk_len_seconds)
                    if keyframe_line:
                        keyframe_line += base_continuity_extra
                    # Pull the user's own Overall Soundscape / Non-Diegetic Music fields
                    # (now shown in the UI for this mode too, not just Reference) and
                    # append the auto-generated hybrid "no reference audio" note as a
                    # suffix when relevant — same pattern Reference mode uses for its
                    # own carry_audio_tag continuity clause.
                    base_soundscape_text = (this_chunk_data.get("overall_soundscape") or "").strip()
                    if base_soundscape_note:
                        base_soundscape_text = (
                            f"{base_soundscape_text} {base_soundscape_note}" if base_soundscape_text
                            else base_soundscape_note
                        )
                    base_music_text = (this_chunk_data.get("non_diegetic_music") or "").strip()
                    chunk_prompt = _assemble_base_mode_prompt(
                        keyframe_line, style_line, base_shot_lines, base_soundscape_text, base_music_text)

                # Integrated Prompt Gen (LLM-generated + explicitly committed in the panel)
                # takes priority over the socket-based override, which takes priority over
                # the normal timeline compile. Only ever applies to genuine Reference-mode,
                # non-hybrid chunks — the LLM is only ever asked to write six-section
                # full-reference text, so it must never overwrite a base-mode/hybrid chunk's
                # differently-shaped 3-section prompt (Prompt Gen's own UI section is already
                # hidden in First/Last Frame mode, but this guards against stale committed
                # text left over from a mode switch after committing).
                # Per-chunk now — each chunk has its own independent Prompt Gen toggle
                # and committed text (see the JS timeline UI's chunk sections), same as
                # its CUTs. this_chunk_data was already looked up near the top of this
                # loop iteration (for style_line/soundscape/music).
                prompt_gen_text = (this_chunk_data.get("prompt_gen_committed_text") or "").strip()
                if mode == MODE_REFERENCE and not use_hybrid_chunk and this_chunk_data.get("prompt_gen_enabled") and prompt_gen_text:
                    chunk_prompt = prompt_gen_text
                elif use_prompt_override and (prompt_override or "").strip():
                    chunk_prompt = prompt_override.strip()
                compiled_prompts.append(f"--- Chunk {chunk_idx + 1}/{num_chunks} (~{chunk_len_seconds:.1f}s) ---\n{chunk_prompt}")

                log.info("[MuseMinimaxDirector] chunk %d/%d, seed=%d, length=%d frames, video_carry=%s, audio_carry=%s, hybrid=%s",
                          chunk_idx + 1, num_chunks, pass_seed, chunk_length, prev_chunk_images is not None,
                          prev_chunk_audio is not None, use_hybrid_chunk)

                if use_hybrid_chunk:
                    out = _execute_comfy_node(
                        MiniMaxH3ImageToVideo,
                        clip=clip, vae=vae, prompt=chunk_prompt,
                        width=width, height=height, length=chunk_length,
                        first_frame=chunk_first, last_frame=chunk_last,
                    )
                    chunk_shifted_model = shifted_model_fl2va
                elif mode == MODE_REFERENCE:
                    out = _execute_comfy_node(
                        MiniMaxH3ReferenceToVideo,
                        clip=clip, vae=vae, audio_vae=audio_vae, prompt=chunk_prompt,
                        width=width, height=height, length=chunk_length, ref_image_size=ref_image_size,
                        ref_images=chunk_ref_images if chunk_ref_images else None,
                        ref_videos=chunk_ref_videos if chunk_ref_videos else None,
                        ref_video_audios=chunk_ref_video_audios if chunk_ref_video_audios else None,
                        ref_audios=chunk_ref_audios if chunk_ref_audios else None,
                    )
                    chunk_shifted_model = shifted_model
                else:
                    out = _execute_comfy_node(
                        MiniMaxH3ImageToVideo,
                        clip=clip, vae=vae, prompt=chunk_prompt,
                        width=width, height=height, length=chunk_length,
                        first_frame=chunk_first, last_frame=chunk_last,
                    )
                    # Prefer the real fl2va checkpoint when connected — MiniMaxH3ImageToVideo
                    # expects fl2va weights specifically. Falls back to the main model input
                    # (already warned about above) only when model_fl2va isn't wired at all.
                    chunk_shifted_model = shifted_model_fl2va if shifted_model_fl2va is not None else shifted_model
                positive, latent = _unpack_node_result(out)[:2]

                # vae_reencode_carry_test: replace the just-built empty/noise latent's
                # own opening prefix with a freshly VAE re-encoded copy of the previous
                # chunk's true final frames (+ matching audio), hard-frozen (noise-mask
                # 0) so those steps never denoise — mirrors LTX Director's own carry-
                # frame mechanism (real VAE encode of decoded pixels, not a reused raw
                # sampled-latent tensor) instead of the plain first-frame image anchor
                # used everywhere else in this node. chunk_length was already extended
                # above to cover this protected prefix; trim_frames (the amount the
                # node actually protected, after its own H3/audio-clock snapping) is
                # what the post-decode trim below uses, not the pre-generation estimate.
                # Runs regardless of two_stage_sampling — tried skipping this for the
                # two-stage path once (reasoning: the Stage-2 upscale+priming pass forces
                # noise_mask back to all-ones on the whole latent, so anything frozen here
                # gets touched again anyway) and it was a real, confirmed regression, not
                # neutral: Stage 1 (high_sigmas) is exactly the EARLY, high-noise steps
                # where a diffusion model decides broad composition — framing, camera
                # distance, pose — and with no anchor present there at all, chunk 2 was
                # free to invent an entirely different shot (confirmed directly: a real
                # two-stage render with only the post-upscale injection produced a full
                # camera-angle/framing change at the cut, worse than the plain first-frame
                # anchor it replaced). This early injection re-constrains those early
                # steps; the second injection below (after the upscale) then refreshes the
                # frozen region with the true high-res re-encode instead of leaving it as
                # whatever the naive latent-space upscale + unprotected priming pass left
                # behind. Both run together for two-stage; only this one for single-pass.
                if vae_reencode_carry_test and chunk_idx > 0 and prev_chunk_images is not None:
                    carry_n = align_frame_count(min(int(vae_reencode_carry_length), int(prev_chunk_images.shape[0])))
                    tail_pixels = prev_chunk_images[-carry_n:]
                    # prev_chunk_images is decoded from whatever resolution the previous
                    # chunk actually finished at — with two_stage_sampling on, that's the
                    # Stage-2 UPSCALED resolution, not the base width x height every fresh
                    # chunk's own target latent starts at (confirmed directly: a real run
                    # crashed here with source latent 44x80 vs target 30x54, the exact
                    # ratio of that chunk's own logged 1.481x/1.467x upscale). Re-fit back
                    # to base resolution first so the re-encoded tail's latent geometry
                    # always matches the fresh target latent it's being injected into,
                    # regardless of whether two-stage ran. "stretch" (not crop/pad) since
                    # this is the same frame just resampled, not a genuine aspect mismatch —
                    # the two-stage upscale's own H3-grid snapping can leave width/height a
                    # fraction of a percent off from perfectly uniform, which stretch just
                    # absorbs instead of cropping or bar-padding for.
                    tail_pixels = _fit_image_to_target(tail_pixels, width, height, "stretch")
                    tail_video_latent = _unpack_node_result(_execute_comfy_node(
                        VAEEncode, pixels=tail_pixels, vae=vae,
                    ))[0]
                    source_latent = {"samples": tail_video_latent["samples"]}
                    if prev_chunk_audio is not None and prev_chunk_audio["waveform"].shape[-1] > 0:
                        carry_sr = prev_chunk_audio["sample_rate"]
                        carry_samples = min(
                            int(round(carry_n / 24.0 * carry_sr)), prev_chunk_audio["waveform"].shape[-1],
                        )
                        tail_waveform = prev_chunk_audio["waveform"][..., -carry_samples:]
                        tail_audio_latent = _unpack_node_result(_execute_comfy_node(
                            VAEEncodeAudio, audio={"waveform": tail_waveform, "sample_rate": carry_sr}, vae=audio_vae,
                        ))[0]
                        source_latent = {"samples": (tail_video_latent["samples"], tail_audio_latent["samples"])}
                    latent, carry_trim_frames = _unpack_node_result(_execute_comfy_node(
                        MiniMaxH3GeneratedAVMaskedContext,
                        latent=latent, source_latent=source_latent,
                        context_length=carry_n, audio_feather_ticks=8,
                    ))[:2]
                    chunk_carry_trim_frames = int(carry_trim_frames)
                    log.info("[MuseMinimaxDirector] chunk %d vae_reencode_carry: %d px re-encoded tail, "
                             "trim=%d frames", chunk_idx + 1, carry_n, chunk_carry_trim_frames)

                # Same seed for every chunk in a pass (not pass_seed + chunk_idx) — chunks
                # already differ by prompt text, anchor image, and length, so a per-chunk
                # seed bump isn't needed for variety and was the direct cause of a visible
                # grain/exposure jump at chunk seams (confirmed via frame-by-frame inspection:
                # identical pose/framing across the cut, but a sudden shift in fine wall-panel
                # noise texture starting exactly on chunk 2's first frame). Reusing one seed
                # across shots is the standard fix for texture/exposure consistency in a
                # stitched multi-shot sequence. Seed Hunt is unaffected — it already varies
                # pass_seed itself per whole pass (see SEED_HUNT_SEED_STRIDE), not per chunk.
                guider = _unpack_node_result(_execute_comfy_node(BasicGuider, model=chunk_shifted_model, conditioning=positive))[0]
                full_sigmas = _unpack_node_result(_execute_comfy_node(
                    BasicScheduler, model=chunk_shifted_model, scheduler=scheduler, steps=steps, denoise=1.0,
                ))[0]

                if not two_stage_sampling:
                    chunk_stage1_latent = None
                    noise = _unpack_node_result(_execute_comfy_node(RandomNoise, noise_seed=pass_seed))[0]
                    sampled = _unpack_node_result(_execute_comfy_node(
                        SamplerCustomAdvanced, noise=noise, guider=guider, sampler=sampler,
                        sigmas=full_sigmas, latent_image=latent,
                    ))[0]
                else:
                    # Reference workflow's exact structure, ported from the TwoStage
                    # Combo node build (verified directly against its own node graph,
                    # not re-derived): a few steps at this chunk's normal resolution,
                    # a direct latent-space upscale of the video half only, one more
                    # near-single-point-sigma pass on the upscaled video alone (reusing
                    # pass 1's noise/seed) before recombining with audio, then the real
                    # final pass — DisableNoise, not reused noise — finishes the
                    # remaining steps on the recombined AV latent.
                    split_step = max(1, min(int(two_stage_first_pass_steps), steps - 1))
                    high_sigmas, low_sigmas = _unpack_node_result(_execute_comfy_node(
                        SplitSigmas, sigmas=full_sigmas, step=split_step,
                    ))[:2]

                    noise1 = _unpack_node_result(_execute_comfy_node(RandomNoise, noise_seed=pass_seed))[0]
                    pass1_raw, pass1_denoised = _unpack_node_result(_execute_comfy_node(
                        SamplerCustomAdvanced, noise=noise1, guider=guider, sampler=sampler,
                        sigmas=high_sigmas, latent_image=latent,
                    ))[:2]

                    if two_stage_seed_hunt_latent_only:
                        # Scouting mode: skip Stage 2 entirely. pass1_denoised is a real,
                        # continuable joint AV latent — exactly what Muse Minimax Refine
                        # V1.2's candidate_N_latent input expects — exposed below via
                        # chunk_stage1_latent. images/audio still get decoded from it so
                        # there's something to actually look at while choosing, but at
                        # Stage 1's low resolution, not the expensive upscaled one.
                        sampled = pass1_denoised
                        # Refine V1.2 only ever gets this one latent — it has no access
                        # to pass1_raw, unlike the Director's own Stage 2 above, which
                        # always sources audio_carry from pass1_raw rather than
                        # pass1_denoised (see that block's own comment for why: raw
                        # preserves the unlocked chunk's natural in-progress denoising
                        # trajectory, which the denoised estimate was never meant to
                        # substitute for). Without this, Refine has to re-derive audio
                        # from the denoised latent instead — confirmed via a real render
                        # to produce wrong/missing dialogue. Stashing raw's audio half
                        # under an extra key on the same dict (rather than a second
                        # output socket) lets Refine use the correct source without any
                        # rewiring on the candidate_N_latent connection.
                        audio_carry_raw = _unpack_node_result(_execute_comfy_node(
                            LTXVSeparateAVLatent, av_latent=pass1_raw,
                        ))[1]
                        chunk_stage1_latent = dict(pass1_denoised)
                        chunk_stage1_latent["_muse_two_stage_raw_audio"] = audio_carry_raw
                    else:
                        chunk_stage1_latent = None

                    if not two_stage_seed_hunt_latent_only:
                        video_for_upscale = _unpack_node_result(_execute_comfy_node(
                            LTXVSeparateAVLatent, av_latent=pass1_denoised,
                        ))[0]
                        audio_carry = _unpack_node_result(_execute_comfy_node(
                            LTXVSeparateAVLatent, av_latent=pass1_raw,
                        ))[1]

                        video_samples = video_for_upscale["samples"]
                        cur_h_latent, cur_w_latent = video_samples.shape[-2], video_samples.shape[-1]
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
                            "[MuseMinimaxDirectorV1_2] chunk %d two-stage upscale: "
                            "latent %dx%d -> %dx%d (requested %.2fx, effective %.3fx/%.3fx)",
                            chunk_idx + 1, cur_w_latent, cur_h_latent, tgt_w, tgt_h,
                            float(two_stage_upscale_factor), eff_x, eff_y,
                        )

                        tiny_sigmas = _unpack_node_result(_execute_comfy_node(
                            SplitSigmas, sigmas=low_sigmas, step=0,
                        ))[0]
                        video_primed = _unpack_node_result(_execute_comfy_node(
                            SamplerCustomAdvanced, noise=noise1, guider=guider, sampler=sampler,
                            sigmas=tiny_sigmas, latent_image=upscaled_video,
                        ))[0]

                        # The chunk-end cleanup below runs too late to help the final
                        # pass's model reload just below this — it happens after that
                        # reload already needed the VRAM. By this point pass1_raw/
                        # pass1_denoised (split into video_for_upscale/audio_carry
                        # already), video_for_upscale/video_samples/upscaled_samples
                        # (upscaled into upscaled_video already, then consumed by
                        # video_primed already), and high_sigmas/tiny_sigmas/noise1/
                        # full_sigmas (all consumed producing what we have) are dead
                        # weight — freeing them here, right before the reload, is what
                        # actually gives the allocator room. Confirmed via a real render
                        # to still hit the same VRAM wall even with the chunk-end
                        # cleanup and the full LoRA/attention stack in place — this was
                        # the missing piece, not those.
                        del pass1_raw, pass1_denoised, video_for_upscale, video_samples
                        del upscaled_samples, upscaled_video, high_sigmas, tiny_sigmas
                        del noise1, full_sigmas
                        gc.collect()
                        if torch.cuda.is_available():
                            torch.cuda.empty_cache()

                        recombined = _unpack_node_result(_execute_comfy_node(
                            LTXVConcatAVLatent, video_latent=video_primed, audio_latent=audio_carry,
                        ))[0]

                        # vae_reencode_carry_test, two-stage path: SECOND injection, on top
                        # of the one already applied before Stage 1 above (see that block's
                        # comment for why both are needed, not just one). That earlier
                        # freeze kept Stage 1 properly anchored, but the region it protected
                        # only survived as a naive latent-space upscale of the true tail,
                        # then went through the upscale-priming pass with noise_mask forced
                        # back to all-ones (unprotected) — this re-freezes it with the real
                        # high-res VAE re-encode right before the pass that matters most. No
                        # resize is needed to get here: prev_chunk_images was decoded from
                        # the PREVIOUS chunk's own two-stage upscale, which used this same
                        # width/height/two_stage_upscale_factor (fixed for the whole run),
                        # so its final resolution already matches this chunk's tgt_h/tgt_w
                        # by construction — the same reasoning the Combo/TwoStage node's own
                        # Test 17 relies on. Only the future (unprotected) region actually
                        # denoises against low_sigmas below; the copied prefix rides through
                        # unchanged.
                        if vae_reencode_carry_test and chunk_idx > 0 and prev_chunk_images is not None:
                            carry_n = align_frame_count(min(int(vae_reencode_carry_length), int(prev_chunk_images.shape[0])))
                            tail_pixels = prev_chunk_images[-carry_n:]
                            tail_video_latent = _unpack_node_result(_execute_comfy_node(
                                VAEEncode, pixels=tail_pixels, vae=vae,
                            ))[0]
                            source_latent = {"samples": tail_video_latent["samples"]}
                            if prev_chunk_audio is not None and prev_chunk_audio["waveform"].shape[-1] > 0:
                                carry_sr = prev_chunk_audio["sample_rate"]
                                carry_samples = min(
                                    int(round(carry_n / 24.0 * carry_sr)), prev_chunk_audio["waveform"].shape[-1],
                                )
                                tail_waveform = prev_chunk_audio["waveform"][..., -carry_samples:]
                                tail_audio_latent = _unpack_node_result(_execute_comfy_node(
                                    VAEEncodeAudio, audio={"waveform": tail_waveform, "sample_rate": carry_sr}, vae=audio_vae,
                                ))[0]
                                source_latent = {"samples": (tail_video_latent["samples"], tail_audio_latent["samples"])}
                            recombined, carry_trim_frames = _unpack_node_result(_execute_comfy_node(
                                MiniMaxH3GeneratedAVMaskedContext,
                                latent=recombined, source_latent=source_latent,
                                context_length=carry_n, audio_feather_ticks=8,
                            ))[:2]
                            chunk_carry_trim_frames = int(carry_trim_frames)
                            log.info("[MuseMinimaxDirector] chunk %d vae_reencode_carry (two-stage): %d px "
                                     "re-encoded tail, trim=%d frames", chunk_idx + 1, carry_n, chunk_carry_trim_frames)

                        noise2 = _unpack_node_result(_execute_comfy_node(DisableNoise))[0]
                        sampled = _unpack_node_result(_execute_comfy_node(
                            SamplerCustomAdvanced, noise=noise2, guider=guider, sampler=sampler,
                            sigmas=low_sigmas, latent_image=recombined,
                        ))[0]

                if chunk_stage1_latent is not None:
                    last_chunk_stage1_latent = chunk_stage1_latent
                    if run_scout_dir is not None:
                        candidate_dir = os.path.join(run_scout_dir, f"candidate_{candidate_idx}")
                        os.makedirs(candidate_dir, exist_ok=True)
                        torch.save(
                            {"latent": chunk_stage1_latent, "prompt": chunk_prompt},
                            os.path.join(candidate_dir, f"chunk_{chunk_idx + 1:04d}.pt"),
                        )

                chunk_images = _unpack_node_result(_execute_comfy_node(VAEDecode, samples=sampled, vae=vae))[0]
                chunk_audio = _unpack_node_result(_execute_comfy_node(VAEDecodeAudio, samples=sampled, vae=audio_vae))[0]

                # Every continuation chunk (chunk_idx > 0) is keyframe-anchored to start
                # from the immediately preceding chunk's own last frame (see the
                # <Picture N> first-frame anchor / hybrid first_frame above) — but its
                # first _KEYFRAME_INJECTION_FRAMES frames are still a transient shaped by
                # the raw keyframe injection rather than clean continuation (see that
                # constant's own comment for why). Drop the whole block, not just the one
                # duplicate first frame.
                trim_n = 0
                if chunk_idx > 0 and chunk_images.shape[0] > 1:
                    # chunk_carry_trim_frames (vae_reencode_carry_test) is the amount
                    # MiniMaxH3GeneratedAVMaskedContext actually protected, after its own
                    # H3/audio-clock snapping — authoritative over the pre-generation
                    # estimate when the test is on; falls back to the plain anchor's
                    # fixed constant otherwise.
                    trim_amount = chunk_carry_trim_frames if chunk_carry_trim_frames is not None else _KEYFRAME_INJECTION_FRAMES
                    trim_n = min(trim_amount, chunk_images.shape[0] - 1)
                    new_frames = chunk_images[trim_n:]
                else:
                    new_frames = chunk_images

                # Two chunks are still independent generation calls even with that
                # duplicate dropped — nothing guarantees pixel-level consistency between
                # them, so the camera position can drift a few pixels right at the seam
                # even when the continuation reference works correctly (confirmed via
                # frame-by-frame pixel-diff on a real render: the seam frame pair measured
                # ~3-4x the normal frame-to-frame delta seen everywhere else in the clip).
                # A naive alpha-blend crossfade was tried first and rejected (visible
                # ghosting, confirmed the same way) — a plain blend has no idea the camera
                # actually moved between the two real frames, it just double-exposes them.
                # RIFE instead computes real optical flow between the two boundary frames
                # and generates genuine in-between frames that account for that motion.
                # IMPORTANT: mid_frames REPLACES new_frames' own first mid_frame_count
                # frames rather than being inserted in addition to them, so this chunk's
                # total video length added is always exactly len(new_frames), whether or
                # not interpolation ran. An earlier version inserted mid_frames as bonus
                # extra frames on top of new_frames, growing video by mid_frame_count
                # with nothing removed — while the audio crossfade below (any version of
                # it) can only ever consume duration from audio, never add it (no audio
                # equivalent to RIFE exists to synthesize new samples). Those two effects
                # point in opposite directions, so the real gap between video and audio
                # duration at each boundary was DOUBLE mid_frame_count, not the "a few
                # tens of milliseconds, doesn't accumulate" it was assumed to be — and it
                # compounds at every continuation chunk. That's what surfaced as lip sync
                # drifting worse deeper into a real multi-chunk render (confirmed
                # directly against real renders, not assumed). Replacing instead of
                # inserting keeps video length fixed, so audio only ever needs the exact
                # same _KEYFRAME_INJECTION_FRAMES trim already applied above — no further
                # length-changing math needed at all, and the two can never drift.
                n_interp = int(seam_interpolation_frames) if seam_interpolation_frames else 0
                mid_frame_count = 0
                if chunk_idx > 0 and n_interp > 0 and new_frames.shape[0] > 1 and prev_chunk_images is not None:
                    if RIFE_VFI is None:
                        log.warning("[MuseMinimaxDirector] seam_interpolation_frames=%d but the RIFE VFI "
                                    "node (ComfyUI-Frame-Interpolation) isn't installed — skipping seam "
                                    "smoothing, chunk boundary will be a hard cut.", n_interp)
                    else:
                        n_interp = min(n_interp, new_frames.shape[0] - 1)
                        frame_pair = torch.cat([prev_chunk_images[-1:], new_frames[n_interp:n_interp + 1]], dim=0)
                        rife_out = _unpack_node_result(_execute_comfy_node(
                            RIFE_VFI, ckpt_name="rife49.pth", frames=frame_pair,
                            clear_cache_after_n_frames=10, multiplier=n_interp + 1,
                            fast_mode=True, ensemble=True, scale_factor=1.0,
                            dtype="float32", torch_compile=False, batch_size=1,
                        ))[0]
                        # RIFE echoes the two input frames back at the ends of its output —
                        # the A-side one already exists as prev_chunk_images[-1], the B-side
                        # one is new_frames[n_interp] which stays below; only the true
                        # in-between frames are new here, and they replace new_frames[:n_interp].
                        mid_frames = rife_out[1:-1]
                        mid_frame_count = mid_frames.shape[0]
                        if mid_frame_count > 0:
                            new_frames = torch.cat(
                                [mid_frames.to(device=new_frames.device, dtype=new_frames.dtype),
                                 new_frames[mid_frame_count:]], dim=0)
                all_images.append(new_frames)
                waveform = chunk_audio["waveform"]
                if trim_n > 0:
                    # Audio must lose the same duration as the _KEYFRAME_INJECTION_FRAMES
                    # trim applied to chunk_images above — otherwise this chunk's audio
                    # keeps ~trim_n frames' worth of dialogue/sound with no matching video
                    # left to show it against (those frames were dropped as a keyframe-
                    # injection transient), and audio silently runs ahead of video by that
                    # amount at every chunk boundary, compounding across chunks.
                    audio_trim_samples = round(trim_n / 24.0 * chunk_audio["sample_rate"])
                    audio_trim_samples = min(audio_trim_samples, waveform.shape[-1] - 1)
                    if audio_trim_samples > 0:
                        waveform = waveform[..., audio_trim_samples:]
                if all_waveform is None:
                    all_waveform = waveform
                    audio_sample_rate = chunk_audio["sample_rate"]
                elif mid_frame_count > 0:
                    # Smooth the seam by ducking (volume-fading) in place — never by
                    # trimming or inserting samples. Both of those change total sample
                    # count, which is exactly what broke sync above; ducking doesn't, so
                    # audio and video duration stay identical at every boundary by
                    # construction, not by careful accounting that can drift.
                    extra_samples = round(mid_frame_count / 24.0 * audio_sample_rate)
                    extra_samples = min(extra_samples, all_waveform.shape[-1], waveform.shape[-1])
                    if extra_samples > 0:
                        fade_out = torch.linspace(1.0, 0.0, extra_samples, device=all_waveform.device)
                        fade_in = torch.linspace(0.0, 1.0, extra_samples, device=waveform.device)
                        all_waveform = all_waveform.clone()
                        all_waveform[..., -extra_samples:] *= fade_out
                        waveform = waveform.clone()
                        waveform[..., :extra_samples] *= fade_in
                    all_waveform = torch.cat([all_waveform, waveform], dim=-1)
                else:
                    all_waveform = torch.cat([all_waveform, waveform], dim=-1)

                prev_chunk_images = chunk_images
                prev_chunk_audio = chunk_audio

                # Ported from the Combo/TwoStage node's own per-chunk cleanup — this
                # node never had it, and without it every two-stage intermediate
                # (upscaled video, primed pass, recombined AV latent, all the sigma
                # splits) just accumulates for the rest of the run instead of being
                # released once its chunk is done with it. Confirmed via a real render
                # to sit at 99% VRAM with Stage 2 thrashing (aimdo "resident page above
                # watermark" warnings, ~3x slower per-step) — this is the same fix that
                # keeps the Combo node's equivalent run stable.
                del out, positive, guider, sampled, latent
                if not two_stage_sampling:
                    del noise, full_sigmas
                elif two_stage_seed_hunt_latent_only:
                    del noise1, full_sigmas, high_sigmas, low_sigmas
                    del pass1_raw, pass1_denoised, audio_carry_raw
                else:
                    # noise1/full_sigmas/high_sigmas/tiny_sigmas/pass1_raw/
                    # pass1_denoised/video_for_upscale/video_samples/upscaled_samples/
                    # upscaled_video were already freed mid-sampling, right before the
                    # final pass's model reload (see the comment there for why that
                    # timing matters) — only what survived to the final pass is left
                    # to release here.
                    del noise2, low_sigmas, audio_carry, video_primed, recombined
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()

            final_images = torch.cat(all_images, dim=0) if len(all_images) > 1 else all_images[0]
            final_audio = {"waveform": all_waveform, "sample_rate": audio_sample_rate}

            # Latent-Only Scouting, multi-chunk timeline: last_chunk_stage1_latent is
            # only ever this pass's LAST chunk on its own — real, but incomplete, since
            # Refine needs every chunk to hi-res-fix the whole thing, not just the
            # tail. Every chunk was already saved to run_scout_dir above as it was
            # generated; attach a small marker pointing Refine at that folder (which
            # chunks, how many, what carry length to re-anchor with) rather than
            # changing what rides in "samples" itself — a plain single-chunk consumer
            # that's never heard of this marker still gets exactly what it got before.
            if run_scout_dir is not None and last_chunk_stage1_latent is not None:
                bundle_latent = dict(last_chunk_stage1_latent)
                bundle_latent["_muse_scout_bundle"] = {
                    "dir": os.path.join(run_scout_dir, f"candidate_{candidate_idx}"),
                    "chunk_count": len(buckets),
                    "carry_length": int(vae_reencode_carry_length),
                }
                last_chunk_stage1_latent = bundle_latent

            return final_images, final_audio, "\n\n".join(compiled_prompts), last_chunk_stage1_latent

        images, audio, compiled_prompt_text, stage1_latent = _run_pass(seed, candidate_idx=0)
        # candidate_1 always mirrors the main single-pass result, at zero extra cost —
        # so "just refine my one result" keeps working with Seed Hunt left off, exactly
        # like it already does today. candidates 2-4 are the extra scouting passes,
        # only computed (3 more full runs, same settings, different seed) when Seed
        # Hunt is actually on.
        candidate_images = [images, None, None, None]
        candidate_audio = [audio, None, None, None]
        candidate_latents = [stage1_latent, None, None, None]

        # seed_hunt is legacy and hidden from the panel. It is intentionally NOT
        # consulted here (even though it's still a real widget, kept only so old saved
        # workflows don't misalign) — if its stored value were ever left on with no
        # visible control to see or undo it, it would silently force every candidate on.
        # candidate_2/3/4 are the only things that decide this now.
        run_candidate = [False, candidate_2, candidate_3, candidate_4]
        any_candidate = any(run_candidate[1:])
        if any_candidate:
            log.warning("[MuseMinimaxDirector] Running %d additional full pass(es) at identical "
                        "settings, different seeds only.", sum(run_candidate[1:]))
            for i in range(1, 4):
                if not run_candidate[i]:
                    continue
                pass_seed = seed + i * SEED_HUNT_SEED_STRIDE
                c_images, c_audio, _, c_latent = _run_pass(pass_seed, candidate_idx=i)
                candidate_images[i] = c_images
                candidate_audio[i] = c_audio
                candidate_latents[i] = c_latent

        empty_images = torch.zeros((0, height, width, 3))
        empty_audio = {"waveform": torch.zeros((1, 1, 0)), "sample_rate": 44100}

        # Seed Hunt is a scouting run, not a final one — main images/audio only ever
        # mean "the one real generation" when no extra candidate ran. With one or more
        # on, leaving them silently equal to candidate_1 invites wiring something
        # downstream straight to what looks like a finished result when it's really
        # just one of several unpicked scouts. Blocked (not populated with candidate_1)
        # instead, so anything wired to them stops cleanly rather than running on the
        # wrong thing. ExecutionBlocker(message) still fires ComfyUI's own
        # "execution_error" event (a visible red error toast, confirmed from
        # execution.py's execution_block_cb) — ExecutionBlocker(None) blocks silently
        # instead; this log line is the only visible trace, in the console, not a popup.
        if any_candidate:
            log.info("[MuseMinimaxDirector] One or more extra candidates ran — main images/audio "
                      "outputs are blocked (not a picked result). Use candidate_1..4 instead.")
            main_images = ExecutionBlocker(None)
            main_audio = ExecutionBlocker(None)
        else:
            main_images, main_audio = images, audio

        # Only meaningful when two_stage_seed_hunt_latent_only is on (that's the only
        # path that ever populates chunk_stage1_latent) — otherwise every candidate's
        # latent is None here. Same silent-block convention as main_images/main_audio
        # above rather than a fake empty LATENT, since a scouting latent that was never
        # actually generated has nothing sensible to hand downstream either way.
        candidate_latents_out = [
            lat if lat is not None else ExecutionBlocker(None) for lat in candidate_latents
        ]

        return (
            main_images, main_audio, compiled_prompt_text, ref_images_used,
            candidate_images[0], candidate_audio[0],
            candidate_images[1] if candidate_images[1] is not None else empty_images,
            candidate_audio[1] if candidate_audio[1] is not None else empty_audio,
            candidate_images[2] if candidate_images[2] is not None else empty_images,
            candidate_audio[2] if candidate_audio[2] is not None else empty_audio,
            candidate_images[3] if candidate_images[3] is not None else empty_images,
            candidate_audio[3] if candidate_audio[3] is not None else empty_audio,
            candidate_latents_out[0], candidate_latents_out[1],
            candidate_latents_out[2], candidate_latents_out[3],
        )


_MUSE_MINIMAX_PROMPTGEN_SYSTEM_PROMPT = (
    "You are an expert prompt engineer for MiniMax H3 Ref2VA (the reference-to-video-audio "
    "model, 768p, 24 fps, 4-15s, 32kHz stereo audio, up to 9 reference images). Your job is to "
    "turn a user's scenario plus reference images into a full-reference-mode H3 prompt. The "
    "prompt drives BOTH video and audio — the audio sections matter as much as the visuals.\n\n"
    "IMPORTANT — this call is fully automated with no follow-up turn available: never ask a "
    "clarifying question and never produce anything other than the six-section format below, "
    "even if the brief is empty or vague. If the brief is empty or thin, infer a simple, "
    "natural single shot from the reference images alone rather than asking for more detail. "
    "Only ever use the full-reference six-section format below — never the shorter frame-anchor "
    "format some H3 guides describe, even if an image looks like it could serve as a keyframe.\n\n"
    "Map each reference image to <Picture N>, numbered in the order the images are given, "
    "starting at 1. Define exactly one <Subject N> per reference image — never split a single "
    "image into two or more Subjects, even if it shows several distinct elements (e.g. a city "
    "skyline with its buildings and streets is ONE Subject covering the whole scene, not a "
    "separate Subject for 'the buildings' and another for 'the environment'). Every Subject "
    "cites the one Picture it came from: `<Subject 1> is the woman in <Picture 1>, with ...`\n\n"
    "Output exactly these six sections, in this order, with these exact lowercase headers each "
    "on their own line followed by a colon, and nothing before, between, or after them except "
    "the section content — no preamble, no explanation, no markdown, no numbered list:\n\n"
    "subject_definitions:\n"
    "One line per Subject: `<Subject N> is ...`, a short identity noun phrase plus a detail "
    "clause of distinguishing features, citing which `<Picture N>` it's from. Base every detail "
    "only on what is actually visible in that image — never invent anything not shown.\n\n"
    "summary:\n"
    "One sentence starting with a bracketed task tag — use `[reference generation]` unless the "
    "brief clearly asks for editing an existing video, in which case use `[video editing]` — "
    "followed by one sentence describing what the target video shows, referencing the Subjects "
    "by their `<Subject N>` tag.\n\n"
    "retention_analysis:\n"
    "One line per Subject: `<Subject N> (present throughout): fully_preserved - matches "
    "<Picture N>.` The `<Picture N>` part must be that exact literal bracketed tag — never "
    "write 'Image N', 'the photo', or any other paraphrase of it. Only ever use one of these "
    "four exact words for the retention level: fully_preserved, partially_preserved, "
    "attribute_transfer, weak_reference. Default to fully_preserved unless the brief implies "
    "the subject should look different from its reference image.\n\n"
    "detailed_description:\n"
    "One or two sentences establishing overall visual style — lighting, palette, camera feel. "
    "Then shot-by-shot description: `[Shot 1]` has no timestamp; every later shot starts `[Shot "
    "N] At MM:SS.mmm, ` with N increasing by exactly one each time, strictly increasing "
    "timestamps. Always literal square brackets `[Shot N]` — never angle brackets, never `<Shot "
    "N>`. In every shot, describe subject appearance, position, action, environment, lighting, "
    "and camera movement (motion type + amplitude + speed, e.g. 'the camera pushes in with "
    "small amplitude at slow speed') — never reduce a shot to a plot summary. Reference "
    "Subjects naturally by their `<Subject N>` tag. Base the number of shots on the brief — a "
    "short or empty brief should produce a single `[Shot 1]` and nothing more. Give speakers "
    "stable IDs `(S1)`, `(S2)` on first mention; dialogue goes `<d>[Language] \"the line\"</d>` "
    "immediately after the Subject who says it, preserving the user's exact words. Aim for "
    "roughly 350-500 words here when the brief supports a fuller scene, but a single simple "
    "shot from a thin brief can be much shorter — never pad with invented detail.\n\n"
    "overall_soundscape:\n"
    "1-4 sentences of ambient and physical sound across the whole video (wind, footsteps, "
    "room tone, impacts) — never dialogue or music. Plain prose only — never repeat the "
    "section header itself or any tag as part of the content. Write N/A only for total "
    "silence.\n\n"
    "non_diegetic_music:\n"
    "1-3 sentences describing background score — instrumentation, tempo, dynamics, no abstract "
    "mood words. Plain prose only — never repeat the section header itself or any tag as part "
    "of the content. Write N/A when no score fits.\n\n"
    "Every bracketed tag you use (<Subject N>, <Picture N>, [Shot N], (S1), <d>...</d>) must be "
    "copied exactly in that literal form — never paraphrased, renamed, or given the wrong "
    "bracket type. Ground every section only in the reference images you were actually shown "
    "and the user's brief — never invent subjects or shots the brief doesn't support.\n\n"
    "## Example (compact reference-generation, follow this shape exactly)\n\n"
    "subject_definitions:\n"
    "<Subject 1> is the coffee-shop environment in <Picture 1>, with an exposed brick wall, an "
    "orange tufted sofa, patterned pillows, and a wooden coffee table.\n"
    "<Subject 2> is the young blonde woman in <Picture 2>, with long blonde hair and a "
    "light-pink button-down shirt with rolled-up sleeves.\n\n"
    "summary:\n"
    "[reference generation] The target video shows <Subject 2> sitting in <Subject 1> and "
    "describing her day to the camera, using <Subject 1> and <Subject 2> as the visual "
    "anchors.\n\n"
    "retention_analysis:\n"
    "<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - the brick wall, orange "
    "sofa, patterned pillows, and wooden table are retained.\n"
    "<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - the blonde woman's "
    "identity, long hair, and pink shirt are retained.\n\n"
    "detailed_description:\n"
    "The target video is in a realistic cinematic style with warm indoor lighting and a "
    "slightly desaturated color palette.\n"
    "[Shot 1] A medium shot establishes <Subject 1>, the coffee shop with its exposed brick "
    "wall, orange tufted sofa, patterned pillows, and wooden coffee table. <Subject 2> (S1), "
    "the young blonde woman in the light-pink shirt, sits on the sofa facing the camera, "
    "holding a cup. The camera pushes in with small amplitude at slow speed as she looks up "
    "and says in a clear, youthful voice, <d>[English] Honestly, today was a good day.</d> She "
    "smiles and takes a sip.\n"
    "[Shot 2] At 00:04.000, the shot cuts to a close-up of <Subject 2> (S1) resting her chin on "
    "her hand, the coffee shop softly blurred behind her. She continues in the same voice with "
    "an amused cadence, <d>[English] I even found my favorite song on the radio.</d> She "
    "laughs quietly and glances down.\n\n"
    "overall_soundscape:\n"
    "Soft coffee-shop room tone with a low ventilation hum continues throughout; a spoon "
    "clinks once against a ceramic cup.\n\n"
    "non_diegetic_music:\n"
    "Sparse acoustic-guitar notes at a slow tempo with gentle low strings, fading out at the "
    "end."
)


# Condensed from MiniMax's own official H3 prompt-example catalog (Notion doc, saved locally
# at C:\\Users\\andyv\\Downloads\\# MiniMax H3 The Next-Gen Open-Weig.txt). Deliberately NOT the
# full ~68KB catalog — dumping that wholesale into every call would compete with the six-section
# format instructions above for the model's attention and inflate every request for no benefit
# (this is exactly the class of problem that caused the earlier Gemini thinking-token truncation
# bug). Instead this is a short, curated set of technique patterns worth reaching for, framed as
# "use if it fits" rather than mandatory boilerplate.
_MUSE_MINIMAX_PROMPTGEN_STYLE_REFERENCE = (
    "## Style & technique reference (optional inspiration, not required)\n\n"
    "Draw on these patterns from MiniMax's own official H3 prompt examples when the brief calls "
    "for them — use only what actually fits the brief, never force one in:\n\n"
    "- Kinetic transitions: for brand films, titles, or motion-graphics briefs, prefer specific "
    "transition language over generic 'cut to' — e.g. cut at peak motion blur, whip-pan with "
    "smear, rack focus, flash-to-white, iris/mask-locked framing that stays fixed while only the "
    "image inside it moves, vinyl-record circular wipes, vertical car-door cuts, long-shadow "
    "wipes, oversized letter masks, tiled frames snapping into place.\n"
    "- Exact on-screen text: if the brief specifies text/wording that must appear verbatim (a "
    "title, slogan, sign), quote it exactly in detailed_description and state plainly that no "
    "other readable text may appear. If text tends to render garbled, describe it as coming from "
    "a reference image rather than being generated as text.\n"
    "- Style guardrails: for genre-specific or period-specific briefs (period drama, horror-"
    "adjacent, sci-fi, otome/anime), add a short explicit 'do not' list to keep the aesthetic "
    "controlled — e.g. no modern elements, no oversmoothed skin, no jump scares, no gore — rather "
    "than relying on the positive description alone to exclude drift.\n"
    "- Camera language: describe moves as motion type + amplitude + speed (push in / pull back / "
    "arc around / whip-pan, small or large amplitude, slow or fast) — never vague adjectives like "
    "'dynamic' or 'cinematic camera work' alone.\n"
    "- Sound design: tie specific foley beats to specific visual beats rather than generic "
    "ambience — e.g. 'ice taps the glass once,' 'a spoon clinks against the cup' — matched to a "
    "moment in detailed_description, not just listed loosely in overall_soundscape.\n"
    "- <Video N> references (when present) are for matching motion, camera movement, or editing "
    "the same clip in place — never write instructions implying a video reference should make the "
    "Subject continue or repeat an action from a previous clip; the last-frame <Picture N> anchor "
    "handles continuation instead.\n"
)


# One entry per H3 audio retention value — matches AUDIO_RETENTION_OPTIONS in the JS
# (Voice Reference / Lip Sync / Partial Voice Match / Weak Reference), which shows
# users those friendly names while still writing this exact literal token into the
# prompt. Each gets its own wording since they mean genuinely different things: a
# Voice Reference means new invented dialogue in a similar voice, Lip Sync means the
# real recording IS the dialogue and should drive the performance verbatim, etc.
_AUDIO_RETENTION_INSTRUCTIONS = {
    "reference": (
        "add one line to subject_definitions: <Audio {a}> is the voice reference for <Subject "
        "S>, used to perform their spoken dialogue. And one line to retention_analysis: "
        "<Audio {a}>: reference - the Subject's dialogue uses this voice. (new invented "
        "dialogue performed in a similar voice, not the literal recording)"
    ),
    "fully_copy": (
        "add one line to subject_definitions: <Audio {a}> is the Subject's spoken dialogue, "
        "reused verbatim from this exact recording. And one line to retention_analysis: "
        "<Audio {a}>: fully_copy - the Subject's performance and lip movements match this "
        "exact recording. This is driving dialogue, not invented speech — write this Subject's "
        "shot around the real recorded performance."
    ),
    "partially_copy": (
        "add one line to subject_definitions: <Audio {a}> is a partial voice reference for "
        "the Subject — some vocal traits carry over from this recording. And one line to "
        "retention_analysis: <Audio {a}>: partially_copy - the Subject's dialogue partially "
        "carries traits from this recording."
    ),
    "weak_reference": (
        "add one line to subject_definitions: <Audio {a}> is a loose vocal style reference near "
        "the Subject — not a claim about their real voice. And one line to retention_analysis: "
        "<Audio {a}>: weak_reference - only a loose style nudge, not the Subject's real "
        "voice."
    ),
}


def _muse_minimax_promptgen_audio_instruction(speaker_audio_map):
    """speaker_audio_map is parallel to image_b64_list: None/falsy = no paired audio
    for that image's Subject, or {"n": <dense Audio number>, "retention": <H3 token>,
    "transcript_segments": [{"start": float, "end": float, "text": str}, ...]} (same
    "Ref Audio N = Ref N's voice" positional convention the normal CUT-based compiler
    already uses). transcript_segments comes from the Whisper "Transcribe" button and
    is only meaningful for Lip Sync (fully_copy) — pacing off real timestamps rather
    than dumping the whole transcript as one undifferentiated block, and rather than
    leaving the model to invent pacing on its own. Returns "" when nothing is paired."""
    parts = []
    for i, entry in enumerate(speaker_audio_map or []):
        if not entry or not entry.get("n"):
            continue
        pic, aud = i + 1, entry["n"]
        retention = entry.get("retention") or "reference"
        tmpl = _AUDIO_RETENTION_INSTRUCTIONS.get(retention, _AUDIO_RETENTION_INSTRUCTIONS["reference"])
        segment_note = ""
        segments = entry.get("transcript_segments") or []
        if retention == "fully_copy" and segments:
            seg_bits = "; ".join(
                f"at {_format_timestamp(s.get('start', 0.0))} she/he says \"{(s.get('text') or '').strip()}\""
                for s in segments if (s.get("text") or "").strip()
            )
            if seg_bits:
                segment_note = (
                    f" This Subject's real recorded dialogue, with its actual timing: {seg_bits}. "
                    "Build this Subject's [Shot N] At MM:SS.mmm shot breaks to match these exact "
                    "moments — do not invent different pacing, and use these exact words verbatim "
                    "inside <d>, not a paraphrase."
                )
        parts.append(
            f"For <Picture {pic}> (whichever <Subject S> number you assigned it), pair it with "
            f"<Audio {aud}>: {tmpl.format(a=aud)}{segment_note}"
        )
    if not parts:
        return ""
    return (
        "\n\nAudio references:\n- " + "\n- ".join(parts)
        + "\n\nAny Subject with no listed audio pairing has no voice reference — invent a "
        "suitable voice for their dialogue instead, and never mention an <Audio N> tag for them."
    )


@PromptServer.instance.routes.post("/muse_minimax_director_v1_2/generate_scene_prompt")
async def muse_minimax_generate_scene_prompt_endpoint(request):
    try:
        data = await request.json()
        brief = (data.get("brief") or "").strip()
        image_b64_list = data.get("image_b64_list") or []
        speaker_audio_map = data.get("speaker_audio_map") or []
        dialogue_language = data.get("dialogue_language") or "English"
        previous_chunk_text = (data.get("previous_chunk_text") or "").strip()
        provider, base_url, model_name = _muse_minimax_resolve_provider(data)

        if provider == "off":
            return web.json_response({"status": "error", "message": "Analyze backend is set to Off / Manual."})
        if not image_b64_list and not brief:
            return web.json_response({"status": "error", "message": "Add a brief or at least one reference image first."})

        full_prompt = _MUSE_MINIMAX_PROMPTGEN_SYSTEM_PROMPT + "\n\n" + _MUSE_MINIMAX_PROMPTGEN_STYLE_REFERENCE
        if not image_b64_list:
            full_prompt += (
                "\n\nNo reference images were provided this time. Write subject_definitions and "
                "retention_analysis as the single line 'None.' and describe any subjects generically "
                "within detailed_description instead of using <Subject N>/<Picture N> tags."
            )
        full_prompt += _muse_minimax_promptgen_audio_instruction(speaker_audio_map)
        # Continuation context for chunk 2+: the previous chunk's own committed prompt,
        # not just the brief in isolation, so the model actually knows what visual
        # style, Subjects, and specific action were already established, and continues
        # from that rather than restarting or repeating it. Deliberately not asked to
        # reproduce the previous chunk's own subject_definitions/retention_analysis —
        # each chunk still writes its own full six sections independently, this is only
        # here to inform detailed_description's continuity.
        if previous_chunk_text:
            # anchor_n must match what execute() actually assigns at render time:
            # bg_index = len(char_ref_images), anchor_n = bg_index + 1 — i.e. one past
            # however many reference images this chunk has, in the same order the base
            # system prompt already numbers <Picture N> tags. image_b64_list here is the
            # same reference-image set the real render will use, so this stays correct.
            # Previously this cited a <Video 1> continuation reference — that mechanism
            # was disabled in favor of the <Picture N> last-frame anchor (see the "TEST:"
            # comment near chunk_ref_videos in execute()); this block was left pointing at
            # the old tag, which no longer has a matching real reference at render time.
            anchor_n = len(image_b64_list) + 1
            full_prompt += (
                "\n\nThis is a continuation of an already-established scene. Here is context "
                "from the immediately preceding chunk — its own committed six-section prompt if "
                "it has one, otherwise a plain summary of its CUTs and style/soundscape/music — "
                "for context only, do not copy its sections verbatim, write this chunk's own "
                "subject_definitions / "
                "summary / retention_analysis / detailed_description / overall_soundscape / "
                "non_diegetic_music fresh, but continue the action naturally from where it left "
                "off, keep the same visual style, and never restart or repeat what already "
                "happened:\n---\n" + previous_chunk_text + "\n---"
                f"\n\nThe exact last frame of that previous chunk is also being fed to the model "
                f"as a real reference image — it will be `<Picture {anchor_n}>` (one past your "
                "other reference images, in the same order/numbering described above). You must "
                f"cite it: add this exact line to retention_analysis — '<Picture {anchor_n}> "
                "([Shot 1] first-frame anchor): fully_preserved - the exact framing, pose, and "
                "camera angle at the end of the previous shot.' And begin detailed_description's "
                f"[Shot 1] with: 'The shot begins from <Picture {anchor_n}>, continuing directly "
                "from the previous shot's exact framing and pose — the camera does not "
                "reposition, zoom, pan, or reframe relative to that image. There is exactly one "
                "instance of this Subject in the frame — do not render a second copy, duplicate, "
                "double-exposure, or any other person; the scene contains this one person only, "
                "throughout.' The action shown in "
                "that reference has already fully happened and finished — do not repeat, "
                "re-enact, or continue performing it; begin this shot from its ending state and "
                "move on to new action only."
            )
        full_prompt += (
            f"\n\nDialogue language (if any): {dialogue_language}"
            f"\n\nUser's brief:\n{brief or '(no brief given — infer a simple, natural single shot from the reference images alone)'}"
        )

        log.info("[MuseMinimaxDirector] Generating scene prompt via %s (%s, model '%s') from %d image(s)...",
                 provider, base_url, model_name, len(image_b64_list))

        ok, result = await _muse_minimax_call_vlm(provider, base_url, model_name, full_prompt, image_b64_list)
        if not ok:
            return web.json_response({"status": "error", "message": result})

        log.info("[MuseMinimaxDirector] Generated scene prompt:\n%s", result)
        return web.json_response({"status": "success", "prompt": result})

    except Exception as e:
        log.error("[MuseMinimaxDirector] Failed to generate scene prompt: %s", e)
        return web.json_response({"status": "error", "message": str(e)}, status=500)


# CPU-only by design (device="cpu"), same proven pattern already used by this repo's
# own paced_voice_clone.py node — zero VRAM cost, safe to run alongside whatever's
# loaded for the actual render. Models are cached per size so repeated clicks don't
# reload weights from disk every time.
_MUSE_MINIMAX_WHISPER_MODEL_CACHE = {}
_MUSE_MINIMAX_WHISPER_MODEL_SIZES = ("tiny", "base", "small", "medium")


def _muse_minimax_get_whisper_model(model_size):
    if model_size not in _MUSE_MINIMAX_WHISPER_MODEL_CACHE:
        from faster_whisper import WhisperModel
        _MUSE_MINIMAX_WHISPER_MODEL_CACHE[model_size] = WhisperModel(model_size, device="cpu", compute_type="float32")
    return _MUSE_MINIMAX_WHISPER_MODEL_CACHE[model_size]


def _muse_minimax_transcribe_sync(audio_path, model_size):
    """Runs on a worker thread (see run_in_executor below) — blocking CPU work,
    must never run directly on the aiohttp event loop. Returns Whisper's own
    sentence/pause-based segments (start/end/text), which is exactly the real
    pacing information used to build accurately-timed [Shot N] At MM:SS.mmm
    breaks or timed CUTs, rather than one flat undifferentiated transcript."""
    model = _muse_minimax_get_whisper_model(model_size)
    segments_gen, _info = model.transcribe(audio_path, word_timestamps=True)
    segments = []
    full_text_parts = []
    for seg in segments_gen:
        text = (seg.text or "").strip()
        if not text:
            continue
        segments.append({"start": float(seg.start), "end": float(seg.end), "text": text})
        full_text_parts.append(text)
    return segments, " ".join(full_text_parts)


@PromptServer.instance.routes.post("/muse_minimax_director_v1_2/transcribe_audio")
async def muse_minimax_transcribe_audio_endpoint(request):
    try:
        import asyncio
        data = await request.json()
        rel_path = data.get("file") or ""
        model_size = data.get("whisper_model") or "small"
        if model_size not in _MUSE_MINIMAX_WHISPER_MODEL_SIZES:
            model_size = "small"

        audio_path = _resolve_path(rel_path)
        if not audio_path:
            return web.json_response({
                "status": "error",
                "message": f"Could not find uploaded audio file '{rel_path}' on disk.",
            })

        log.info("[MuseMinimaxDirector] Transcribing %s with Whisper '%s' (CPU)...", audio_path, model_size)
        loop = asyncio.get_event_loop()
        segments, full_text = await loop.run_in_executor(
            None, _muse_minimax_transcribe_sync, audio_path, model_size)

        if not segments:
            return web.json_response({"status": "error", "message": "No speech detected in this audio."})

        log.info("[MuseMinimaxDirector] Transcription complete: %d segment(s).", len(segments))
        return web.json_response({"status": "success", "segments": segments, "full_text": full_text})

    except ImportError:
        return web.json_response({
            "status": "error",
            "message": "faster_whisper is not installed in this ComfyUI environment.",
        })
    except Exception as e:
        log.error("[MuseMinimaxDirector] Transcription failed: %s", e)
        return web.json_response({"status": "error", "message": str(e)}, status=500)


NODE_CLASS_MAPPINGS = {
    "MuseMinimaxDirectorV1_2": MuseMinimaxDirector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MuseMinimaxDirectorV1_2": "Muse Minimax Director V1.2 (Two-Stage)",
}
