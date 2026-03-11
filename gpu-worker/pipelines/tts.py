"""
TTS pipeline — Kokoro-82M for text → audio (WAV).

Takes text prompt, returns WAV bytes as MediaOutput.
Model: hexgrad/Kokoro-82M
"""

import io
import time
import logging
from typing import Generator

import torch

from .base import BasePipeline, InferenceResult

logger = logging.getLogger(__name__)


class TTSPipeline(BasePipeline):
    """Text-to-speech: text → WAV audio."""

    def __init__(self, model_id: str, device: str, quantization: str = "fp16"):
        super().__init__(model_id, device, quantization)
        self.pipeline = None
        self.sample_rate = 24000

    def load(self, model_path: str = "") -> dict:
        from kokoro import KPipeline

        logger.info(f"[TTS] Loading {self.model_id}")

        vram_before = torch.cuda.memory_allocated() if torch.cuda.is_available() else 0

        # Kokoro uses lang_code for voice selection
        self.pipeline = KPipeline(lang_code='a')  # 'a' = American English

        vram_after = torch.cuda.memory_allocated() if torch.cuda.is_available() else 0
        self.vram_used_bytes = vram_after - vram_before

        logger.info(f"[TTS] {self.model_id} loaded. VRAM: {self.vram_used_bytes / 1e6:.1f}MB")

        return self.get_capabilities()

    def infer(self, request: dict) -> Generator[InferenceResult, None, None]:
        prompt = request.get("prompt", "")
        if not prompt:
            yield InferenceResult(is_complete=True, finish_reason="ERROR")
            return

        start_time = time.time()

        try:
            import soundfile as sf

            # Generate audio
            generator = self.pipeline(prompt, voice='af_heart')

            all_audio = []
            for i, (gs, ps, audio) in enumerate(generator):
                if audio is not None:
                    all_audio.append(audio)

            if not all_audio:
                yield InferenceResult(is_complete=True, finish_reason="ERROR")
                return

            # Concatenate audio segments
            import numpy as np
            combined = np.concatenate(all_audio)

            # Convert to WAV bytes
            wav_buffer = io.BytesIO()
            sf.write(wav_buffer, combined, self.sample_rate, format='WAV')
            wav_bytes = wav_buffer.getvalue()

            total_time_ms = (time.time() - start_time) * 1000

            # Yield media output
            yield InferenceResult(
                media_data=wav_bytes,
                media_mime_type="audio/wav",
                is_media_final=True,
            )

            # Yield completion
            yield InferenceResult(
                is_complete=True,
                finish_reason="STOP",
                prompt_tokens=len(prompt.split()),  # Approximate
                completion_tokens=0,
                total_time_ms=total_time_ms,
            )

        except Exception as e:
            logger.error(f"[TTS] Inference error: {e}")
            yield InferenceResult(is_complete=True, finish_reason="ERROR")

    def unload(self):
        if self.pipeline is not None:
            del self.pipeline
            self.pipeline = None
        super().unload()

    def get_capabilities(self) -> dict:
        return {
            "max_context_length": 0,
            "vocab_size": 0,
            "supports_logprobs": False,
            "supports_json_mode": False,
            "supports_grammar": False,
            "model_type": "tts",
            "supports_image_input": False,
            "supports_image_output": False,
            "supports_audio_output": True,
            "supports_video_output": False,
        }
