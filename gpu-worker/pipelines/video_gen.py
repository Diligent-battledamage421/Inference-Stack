"""
Video generation pipeline — CogVideoX-2B for text → video (MP4).

Takes text prompt, returns MP4 bytes as MediaOutput.
Model: THUDM/CogVideoX-2b
"""

import io
import time
import logging
from typing import Generator

import torch

from .base import BasePipeline, InferenceResult

logger = logging.getLogger(__name__)


class VideoGenPipeline(BasePipeline):
    """Text-to-video: prompt → MP4."""

    def __init__(self, model_id: str, device: str, quantization: str = "fp16"):
        super().__init__(model_id, device, quantization)
        self.pipe = None

    def load(self, model_path: str = "") -> dict:
        from diffusers import CogVideoXPipeline

        repo = model_path if model_path else self.model_id

        logger.info(f"[VideoGen] Loading {self.model_id} from {repo}")

        vram_before = torch.cuda.memory_allocated() if torch.cuda.is_available() else 0

        dtype = torch.float16 if self.quantization == "fp16" else torch.float32
        self.pipe = CogVideoXPipeline.from_pretrained(
            repo, torch_dtype=dtype
        )

        # Use CPU offload instead of .to(device) — CogVideoX needs ~12GB peak,
        # so model_cpu_offload moves components to GPU on demand and back to CPU after
        gpu_idx = int(self.device.split(":")[-1]) if ":" in self.device else 0
        self.pipe.enable_model_cpu_offload(gpu_id=gpu_idx)

        # Enable memory-efficient attention
        try:
            self.pipe.enable_vae_slicing()
            self.pipe.enable_vae_tiling()
        except Exception:
            pass

        vram_after = torch.cuda.memory_allocated() if torch.cuda.is_available() else 0
        self.vram_used_bytes = vram_after - vram_before

        logger.info(f"[VideoGen] {self.model_id} loaded. VRAM: {self.vram_used_bytes / 1e6:.1f}MB")

        return self.get_capabilities()

    def infer(self, request: dict) -> Generator[InferenceResult, None, None]:
        prompt = request.get("prompt", "")
        if not prompt:
            yield InferenceResult(is_complete=True, finish_reason="ERROR")
            return

        params = request.get("params", {}) or {}
        num_frames = min(params.get("num_frames", 17), 49)  # Default to shorter video for memory

        start_time = time.time()

        try:
            from diffusers.utils import export_to_video

            # Generate video frames
            result = self.pipe(
                prompt=prompt,
                num_frames=num_frames,
                guidance_scale=6.0,
                num_inference_steps=50,
            )
            frames = result.frames[0]  # List of PIL images

            # Export to MP4 bytes
            import tempfile
            import os

            with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
                tmp_path = tmp.name

            export_to_video(frames, tmp_path, fps=8)

            with open(tmp_path, "rb") as f:
                mp4_bytes = f.read()

            os.unlink(tmp_path)

            total_time_ms = (time.time() - start_time) * 1000

            # Yield media output
            yield InferenceResult(
                media_data=mp4_bytes,
                media_mime_type="video/mp4",
                is_media_final=True,
            )

            # Yield completion
            yield InferenceResult(
                is_complete=True,
                finish_reason="STOP",
                prompt_tokens=len(prompt.split()),
                completion_tokens=0,
                total_time_ms=total_time_ms,
            )

        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            logger.error(f"[VideoGen] OOM during generation")
            yield InferenceResult(is_complete=True, finish_reason="ERROR")

        except Exception as e:
            logger.error(f"[VideoGen] Inference error: {e}")
            yield InferenceResult(is_complete=True, finish_reason="ERROR")

    def unload(self):
        if self.pipe is not None:
            del self.pipe
            self.pipe = None
        super().unload()

    def get_capabilities(self) -> dict:
        return {
            "max_context_length": 0,
            "vocab_size": 0,
            "supports_logprobs": False,
            "supports_json_mode": False,
            "supports_grammar": False,
            "model_type": "video_gen",
            "supports_image_input": False,
            "supports_image_output": False,
            "supports_audio_output": False,
            "supports_video_output": True,
        }
