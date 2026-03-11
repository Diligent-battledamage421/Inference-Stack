"""
Image generation pipeline — SD Turbo for text → image (PNG).

Takes text prompt, returns PNG bytes as MediaOutput.
Model: stabilityai/sd-turbo
"""

import io
import time
import logging
from typing import Generator

import torch

from .base import BasePipeline, InferenceResult

logger = logging.getLogger(__name__)


class ImageGenPipeline(BasePipeline):
    """Text-to-image: prompt → PNG."""

    def __init__(self, model_id: str, device: str, quantization: str = "fp16"):
        super().__init__(model_id, device, quantization)
        self.pipe = None

    def load(self, model_path: str = "") -> dict:
        from diffusers import AutoPipelineForText2Image

        repo = model_path if model_path else self.model_id

        logger.info(f"[ImageGen] Loading {self.model_id} from {repo}")

        vram_before = torch.cuda.memory_allocated() if torch.cuda.is_available() else 0

        dtype = torch.float16 if self.quantization == "fp16" else torch.float32
        self.pipe = AutoPipelineForText2Image.from_pretrained(
            repo, torch_dtype=dtype, variant="fp16" if self.quantization == "fp16" else None
        ).to(self.device)

        vram_after = torch.cuda.memory_allocated() if torch.cuda.is_available() else 0
        self.vram_used_bytes = vram_after - vram_before

        logger.info(f"[ImageGen] {self.model_id} loaded. VRAM: {self.vram_used_bytes / 1e6:.1f}MB")

        return self.get_capabilities()

    def infer(self, request: dict) -> Generator[InferenceResult, None, None]:
        prompt = request.get("prompt", "")
        if not prompt:
            yield InferenceResult(is_complete=True, finish_reason="ERROR")
            return

        params = request.get("params", {}) or {}
        # SD Turbo works best with 1 step
        num_steps = params.get("num_inference_steps", 1)

        start_time = time.time()

        try:
            # Generate image
            result = self.pipe(
                prompt=prompt,
                num_inference_steps=num_steps,
                guidance_scale=0.0,  # SD Turbo doesn't use guidance
            )
            image = result.images[0]

            # Convert to PNG bytes
            png_buffer = io.BytesIO()
            image.save(png_buffer, format="PNG")
            png_bytes = png_buffer.getvalue()

            total_time_ms = (time.time() - start_time) * 1000

            # Yield media output
            yield InferenceResult(
                media_data=png_bytes,
                media_mime_type="image/png",
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
            logger.error(f"[ImageGen] OOM during generation")
            yield InferenceResult(is_complete=True, finish_reason="ERROR")

        except Exception as e:
            logger.error(f"[ImageGen] Inference error: {e}")
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
            "model_type": "image_gen",
            "supports_image_input": False,
            "supports_image_output": True,
            "supports_audio_output": False,
            "supports_video_output": False,
        }
